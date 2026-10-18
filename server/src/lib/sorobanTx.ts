import {
  Address,
  BASE_FEE,
  Operation,
  Transaction,
  TransactionBuilder,
  rpc,
  type xdr,
} from "@stellar/stellar-sdk";
import { config } from "../config.js";
import { NETWORK_PASSPHRASE } from "../services/registryClient.js";

// Wallet-signed contract invocations: the server builds and simulates the
// transaction with the provider's wallet as source, the provider signs it in
// their wallet, and the server checks the signed copy still makes exactly the
// call it prepared before submitting it.

export interface Invocation {
  source: string;
  contractId: string;
  fn: string;
  args: xdr.ScVal[];
}

export class SignedTxMismatchError extends Error {}

const rpcServer = () => new rpc.Server(config.SOROBAN_RPC_URL);

/** Build and simulate an unsigned single-call transaction. Returns its XDR. */
export async function buildInvocationTx(invocation: Invocation): Promise<string> {
  const server = rpcServer();
  const account = await server.getAccount(invocation.source);
  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(
      Operation.invokeContractFunction({
        contract: invocation.contractId,
        function: invocation.fn,
        args: invocation.args,
      }),
    )
    .setTimeout(300)
    .build();
  const prepared = await server.prepareTransaction(tx);
  return prepared.toXDR();
}

/**
 * Throw unless `signedXdr` is a plain transaction from `expected.source` with
 * one operation calling `expected.fn` on `expected.contractId` with exactly
 * `expected.args`. Stops a client from swapping in a different call between
 * prepare and submit.
 */
export function assertSignedInvocation(signedXdr: string, expected: Invocation): void {
  let tx;
  try {
    tx = TransactionBuilder.fromXDR(signedXdr, NETWORK_PASSPHRASE);
  } catch {
    throw new SignedTxMismatchError("signedXdr is not a valid transaction for this network");
  }
  if (!(tx instanceof Transaction)) {
    throw new SignedTxMismatchError("fee-bump transactions are not accepted");
  }
  if (tx.source !== expected.source) {
    throw new SignedTxMismatchError(`transaction source must be ${expected.source}`);
  }
  const op = tx.operations[0];
  if (tx.operations.length !== 1 || op.type !== "invokeHostFunction") {
    throw new SignedTxMismatchError("transaction must contain exactly one contract call");
  }
  const fn = op.func;
  if (fn.switch().name !== "hostFunctionTypeInvokeContract") {
    throw new SignedTxMismatchError("transaction must call a contract function");
  }
  const call = fn.invokeContract();
  const contractId = Address.fromScAddress(call.contractAddress()).toString();
  const name = call.functionName().toString();
  const args = call.args();
  const sameArgs =
    args.length === expected.args.length &&
    args.every((arg, i) => arg.toXDR("base64") === expected.args[i].toXDR("base64"));
  if (contractId !== expected.contractId || name !== expected.fn || !sameArgs) {
    throw new SignedTxMismatchError("signed transaction does not match the prepared call");
  }
}
