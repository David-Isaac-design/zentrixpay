import { Address, StrKey, nativeToScVal } from "@stellar/stellar-sdk";
import { and, eq, isNull } from "drizzle-orm";
import { usdcToBaseUnits } from "@zentrixpay/registry-client";
import { db } from "../db/client.js";
import { apiCalls } from "../db/schema.js";
import { config } from "../config.js";
import { getLogger } from "../lib/logger.js";
import {
  SignedTxMismatchError,
  assertSignedInvocation,
  buildInvocationTx,
  type Invocation,
} from "../lib/sorobanTx.js";
import { NETWORK_PASSPHRASE, submitSignedTx } from "./registryClient.js";
import { ApiServiceError, type ApiRow } from "./apiService.js";

// Provider-initiated refunds of charged calls. ZentrixPay never holds funds:
// the refund is a USDC transfer from the provider's wallet back to the payer,
// which the provider signs. The server builds it, checks the signed copy, submits
// it and records the result on the api_calls row so stats show net revenue.

type ApiCallRow = typeof apiCalls.$inferSelect;

function refundInvocation(api: ApiRow, call: ApiCallRow): Invocation {
  return {
    source: api.walletAddress,
    contractId: config.USDC_CONTRACT_ID,
    fn: "transfer",
    args: [
      new Address(api.walletAddress).toScVal(),
      new Address(call.payerAddress).toScVal(),
      nativeToScVal(usdcToBaseUnits(call.amount), { type: "i128" }),
    ],
  };
}

async function refundableCall(api: ApiRow, callId: string): Promise<ApiCallRow> {
  const [call] = await db
    .select()
    .from(apiCalls)
    .where(and(eq(apiCalls.id, callId), eq(apiCalls.apiId, api.id)));
  if (!call) throw new ApiServiceError(404, "Call not found");
  if (!call.charged) throw new ApiServiceError(409, "This call was not charged");
  if (call.refundStatus === "refunded")
    throw new ApiServiceError(409, "This call is already refunded");
  if (call.refundStatus === "pending")
    throw new ApiServiceError(409, "A refund for this call is in progress");
  const payer = call.payerAddress;
  if (!StrKey.isValidEd25519PublicKey(payer) && !StrKey.isValidContract(payer)) {
    throw new ApiServiceError(422, "The payer of this call is unknown, so it cannot be refunded");
  }
  return call;
}

/** Unsigned USDC transfer from the provider's wallet back to the call's payer. */
export async function prepareCallRefund(api: ApiRow, callId: string) {
  const call = await refundableCall(api, callId);
  try {
    return {
      unsignedXdr: await buildInvocationTx(refundInvocation(api, call)),
      networkPassphrase: NETWORK_PASSPHRASE,
      refund: {
        callId: call.id,
        from: api.walletAddress,
        to: call.payerAddress,
        amount: call.amount,
      },
    };
  } catch (err) {
    throw new ApiServiceError(502, `Could not prepare the refund: ${(err as Error).message}`);
  }
}

/** Submit the provider-signed refund transfer and record it against the call. */
export async function confirmCallRefund(api: ApiRow, callId: string, signedXdr: string) {
  const call = await refundableCall(api, callId);
  try {
    assertSignedInvocation(signedXdr, refundInvocation(api, call));
  } catch (err) {
    if (err instanceof SignedTxMismatchError) throw new ApiServiceError(400, err.message);
    throw err;
  }

  // Claim the call first so a double-click cannot send two transfers.
  const claimed = await db
    .update(apiCalls)
    .set({ refundStatus: "pending" })
    .where(and(eq(apiCalls.id, call.id), isNull(apiCalls.refundStatus)))
    .returning({ id: apiCalls.id });
  if (claimed.length === 0) throw new ApiServiceError(409, "A refund for this call is in progress");

  const result = await submitSignedTx(signedXdr);
  getLogger().info(
    {
      event: "api_call_refund",
      apiId: api.id,
      callId: call.id,
      txHash: result.txHash,
      success: result.success,
    },
    "API call refund finished",
  );
  if (!result.success) {
    // Sent but not confirmed in time: the transfer may still land, so keep the
    // call claimed (with the hash for reconciliation) rather than allow a retry.
    if (result.txHash && /timeout/i.test(result.error ?? "")) {
      await db
        .update(apiCalls)
        .set({ refundTxHash: result.txHash })
        .where(eq(apiCalls.id, call.id));
      throw new ApiServiceError(
        504,
        `Refund submitted but not confirmed yet (transaction ${result.txHash})`,
      );
    }
    await db.update(apiCalls).set({ refundStatus: null }).where(eq(apiCalls.id, call.id));
    throw new ApiServiceError(502, `Refund transfer failed: ${result.error ?? "unknown error"}`);
  }

  const [row] = await db
    .update(apiCalls)
    .set({
      refundStatus: "refunded",
      refundAmount: call.amount,
      refundTxHash: result.txHash,
      refundedAt: new Date(),
    })
    .where(eq(apiCalls.id, call.id))
    .returning();
  return row;
}
