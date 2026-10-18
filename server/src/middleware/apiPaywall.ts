import type { Request, Response, NextFunction } from "express";
import { paymentMiddleware } from "@x402/express";
import type { RoutesConfig } from "@x402/core/server";
import { network, sharedX402ResourceServer } from "../lib/x402.js";
import { getApiById, type ApiRow } from "../services/apiService.js";
import { getOnChainPrice, normalizeUsdcPrice } from "../lib/stellarRegistry.js";
import { getLogger } from "../lib/logger.js";

// x402 paywall for the pay-per-call proxy. One payment buys one call; the
// x402 middleware holds the response until settlement and cancels the charge
// when the handler responds with status >= 400, so callers are not charged
// for upstream failures.

const middlewareCache = new Map<
  string,
  { mw: ReturnType<typeof paymentMiddleware>; expiresAt: number }
>();
const CACHE_TTL_MS = 60_000;

/** Load the API behind /api/:id and refuse requests that could never be served. */
export async function loadProxiedApi(req: Request, res: Response, next: NextFunction) {
  const api = await getApiById(req.params.id as string);
  if (!api || !api.listed) {
    res.status(404).json({ error: "API not found" });
    return;
  }
  // Checked before the paywall so a caller is never asked to pay for a method
  // the provider does not accept.
  if (!api.allowedMethods.includes(req.method)) {
    res.setHeader("Allow", api.allowedMethods.join(", "));
    res.status(405).json({ error: `Method ${req.method} not allowed for this API` });
    return;
  }
  res.locals.api = api;
  next();
}

/**
 * Check the API's price and payee against its record in the vault registry.
 * Responds and returns false when the call must be refused: callers are never
 * asked to pay an amount, or an address, the on-chain record does not back.
 */
async function matchesOnChainRecord(api: ApiRow, res: Response): Promise<boolean> {
  if (api.onchainStatus !== "registered") {
    res.status(409).json({
      error: "not_registered_onchain",
      message: "This API's price is not anchored on-chain yet. Please try again later.",
      apiId: api.id,
    });
    return false;
  }

  let onChain;
  try {
    onChain = await getOnChainPrice(api.id);
  } catch (err) {
    getLogger().error(
      { event: "api_paywall_chain_lookup_failed", apiId: api.id, err },
      "on-chain price lookup failed",
    );
    res.status(503).json({
      error: "chain_unavailable",
      message: "Unable to verify this API's price. Please try again later.",
      apiId: api.id,
    });
    return false;
  }

  const priceMatches = normalizeUsdcPrice(api.price) === onChain.price;
  if (!priceMatches || onChain.creator !== api.walletAddress) {
    getLogger().warn(
      {
        event: "api_paywall_onchain_mismatch",
        apiId: api.id,
        dbPrice: api.price,
        chainPrice: onChain.price,
        walletAddress: api.walletAddress,
        onChainCreator: onChain.creator,
      },
      "API price or payee differs from the on-chain registry",
    );
    res.status(409).json({
      error: priceMatches ? "payee_mismatch" : "price_mismatch",
      message:
        "This API's price is temporarily unavailable due to a configuration issue. Please try again later.",
      apiId: api.id,
    });
    return false;
  }
  return true;
}

export async function apiPaywall(req: Request, res: Response, next: NextFunction) {
  const api = res.locals.api as ApiRow;
  if (!(await matchesOnChainRecord(api, res))) return;

  // Price and payee are part of the key so an edit takes effect immediately.
  const cacheKey = `${api.id}:${api.price}:${api.walletAddress}`;
  const cached = middlewareCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.mw(req, res, next);
  }

  const accepts = {
    accepts: {
      scheme: "exact" as const,
      network,
      payTo: api.walletAddress,
      price: api.price,
    },
    description: `${api.name} — one call`,
  };
  const routes: RoutesConfig = {
    [`/api/${api.id}`]: accepts,
    [`/api/${api.id}/*`]: accepts,
  };

  const mw = paymentMiddleware(routes, sharedX402ResourceServer);
  const now = Date.now();
  for (const [key, entry] of middlewareCache)
    if (entry.expiresAt <= now) middlewareCache.delete(key);
  middlewareCache.set(cacheKey, { mw, expiresAt: now + CACHE_TTL_MS });
  return mw(req, res, next);
}
