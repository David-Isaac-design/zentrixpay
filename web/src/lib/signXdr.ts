import { checkNetwork } from "../hooks/useNetworkCheck.js";

/**
 * Ask Freighter to sign a transaction the server prepared. Throws a readable
 * error when the wallet is on the wrong network or the user declines.
 */
export async function signWithWallet(
  unsignedXdr: string,
  networkPassphrase: string,
): Promise<string> {
  const warning = await checkNetwork(networkPassphrase);
  if (warning) throw new Error(warning);

  const freighter = await import("@stellar/freighter-api");
  const result = await freighter.signTransaction(unsignedXdr, { networkPassphrase });
  if ("error" in result && result.error) {
    throw new Error(typeof result.error === "string" ? result.error : "Wallet rejected signing");
  }
  const signedXdr =
    "signedTxXdr" in result ? result.signedTxXdr : (result as any).result?.signedTxXdr;
  if (!signedXdr) throw new Error("No signed transaction returned by wallet");
  return signedXdr;
}
