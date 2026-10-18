import { Address, nativeToScVal, xdr } from "@stellar/stellar-sdk";
import { and, eq, inArray } from "drizzle-orm";
import { apiListingMetadata, usdcToBaseUnits } from "@zentrixpay/registry-client";
import { db } from "../db/client.js";
import { apis } from "../db/schema.js";
import { getLogger } from "../lib/logger.js";
import { invalidateOnChainPrice } from "../lib/stellarRegistry.js";
import {
  SignedTxMismatchError,
  assertSignedInvocation,
  buildInvocationTx,
  type Invocation,
} from "../lib/sorobanTx.js";
import { NETWORK_PASSPHRASE, registryClient, submitSignedTx } from "./registryClient.js";
import { ApiServiceError, toPublicApi, type ApiRow } from "./apiService.js";

// Anchoring APIs in the vault registry. The provider's wallet is the on-chain
// creator, so every write is a transaction the provider signs: the server
// prepares it, the provider signs it, the server checks and submits it.

const registryContractId = () => registryClient.options.contractId;

function registerInvocation(api: ApiRow): Invocation {
  return {
    source: api.walletAddress,
    contractId: registryContractId(),
    fn: "register",
    args: [
      new Address(api.walletAddress).toScVal(),
      nativeToScVal(api.id, { type: "string" }),
      nativeToScVal(usdcToBaseUnits(api.price), { type: "i128" }),
      nativeToScVal(apiListingMetadata({ name: api.name, proxyUrl: toPublicApi(api).proxyUrl }), {
        type: "string",
      }),
      xdr.ScVal.scvVec([]),
    ],
  };
}

function setPriceInvocation(api: ApiRow, price: string): Invocation {
  return {
    source: api.walletAddress,
    contractId: registryContractId(),
    fn: "set_price",
    args: [
      nativeToScVal(api.id, { type: "string" }),
      nativeToScVal(usdcToBaseUnits(price), { type: "i128" }),
    ],
  };
}

async function prepare(invocation: Invocation) {
  try {
    return {
      unsignedXdr: await buildInvocationTx(invocation),
      networkPassphrase: NETWORK_PASSPHRASE,
    };
  } catch (err) {
    throw new ApiServiceError(502, `Could not prepare the transaction: ${(err as Error).message}`);
  }
}

function checkSigned(signedXdr: string, invocation: Invocation): void {
  try {
    assertSignedInvocation(signedXdr, invocation);
  } catch (err) {
    if (err instanceof SignedTxMismatchError) throw new ApiServiceError(400, err.message);
    throw err;
  }
}

/** Unsigned `register` transaction for the provider's wallet to sign. */
export async function prepareApiRegistration(api: ApiRow) {
  if (api.onchainStatus === "registered" || api.onchainStatus === "pending") {
    throw new ApiServiceError(409, `API registration is already ${api.onchainStatus}`);
  }
  return {
    ...(await prepare(registerInvocation(api))),
    registration: {
      contractId: registryContractId(),
      id: api.id,
      creator: api.walletAddress,
      price: api.price,
    },
  };
}

/**
 * Submit the provider-signed `register` transaction. On success the API is
 * listed when its upstream ownership is already verified.
 */
export async function confirmApiRegistration(api: ApiRow, signedXdr: string): Promise<ApiRow> {
  checkSigned(signedXdr, registerInvocation(api));

  // Claim the registration so two concurrent submits cannot both go out.
  const claimed = await db
    .update(apis)
    .set({ onchainStatus: "pending" })
    .where(and(eq(apis.id, api.id), inArray(apis.onchainStatus, ["none", "failed"])))
    .returning({ id: apis.id });
  if (claimed.length === 0) {
    throw new ApiServiceError(409, "API registration is already pending or complete");
  }

  const result = await submitSignedTx(signedXdr);
  getLogger().info(
    {
      event: "api_onchain_register",
      apiId: api.id,
      txHash: result.txHash,
      success: result.success,
    },
    "API on-chain registration finished",
  );
  if (!result.success) {
    await db.update(apis).set({ onchainStatus: "failed" }).where(eq(apis.id, api.id));
    throw new ApiServiceError(
      502,
      `On-chain registration failed: ${result.error ?? "unknown error"}`,
    );
  }

  invalidateOnChainPrice(api.id);
  const [row] = await db
    .update(apis)
    .set({
      onchainStatus: "registered",
      onchainTxHash: result.txHash,
      listed: Boolean(api.ownershipVerifiedAt),
    })
    .where(eq(apis.id, api.id))
    .returning();
  return row;
}

function requireRegistered(api: ApiRow): void {
  if (api.onchainStatus !== "registered") {
    throw new ApiServiceError(409, "API is not registered on-chain; change its price with PATCH");
  }
}

/** Unsigned `set_price` transaction for a registered API. */
export async function prepareApiPrice(api: ApiRow, price: string) {
  requireRegistered(api);
  return prepare(setPriceInvocation(api, price));
}

/** Submit the provider-signed `set_price` transaction, then sync the DB price. */
export async function confirmApiPrice(
  api: ApiRow,
  price: string,
  signedXdr: string,
): Promise<ApiRow> {
  requireRegistered(api);
  checkSigned(signedXdr, setPriceInvocation(api, price));

  const result = await submitSignedTx(signedXdr);
  getLogger().info(
    {
      event: "api_onchain_set_price",
      apiId: api.id,
      txHash: result.txHash,
      success: result.success,
    },
    "API on-chain price update finished",
  );
  if (!result.success) {
    throw new ApiServiceError(
      502,
      `On-chain price update failed: ${result.error ?? "unknown error"}`,
    );
  }

  invalidateOnChainPrice(api.id);
  const [row] = await db.update(apis).set({ price }).where(eq(apis.id, api.id)).returning();
  return row;
}
