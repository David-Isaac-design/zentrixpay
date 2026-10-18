import type { Request, Response, NextFunction } from "express";
import { paymentMiddleware } from "@x402/express";
import type { RoutesConfig } from "@x402/core/server";
import { network, sharedX402ResourceServer } from "../lib/x402.js";
import { getApiById, type ApiRow } from "../services/apiService.js";
import { paymentHeader, payerFromPayment } from "../lib/payer.js";

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

/** Whether the API's allow/deny lists admit this payer wallet. */
export function isPayerAllowed(api: ApiRow, payer: string): boolean {
  if (api.payerDenylist.includes(payer)) return false;
  return !api.payerAllowlist || api.payerAllowlist.includes(payer);
}

/**
 * Enforce the API's payer allow/deny lists before the paywall, so a refused
 * wallet gets 403 and its payment is never verified or settled. A request
 * without a payment still gets the 402 challenge: the wallet is only known
 * once the caller attaches a payment, and that request is checked here.
 */
export function checkPayerAccess(req: Request, res: Response, next: NextFunction) {
  const api = res.locals.api as ApiRow;
  const header = paymentHeader(req);
  const restricted = api.payerAllowlist !== null || api.payerDenylist.length > 0;
  if (!restricted || !header) return next();

  const payer = payerFromPayment(header).address;
  if (!payer || !isPayerAllowed(api, payer)) {
    res.status(403).json({ error: "This wallet is not allowed to call this API" });
    return;
  }
  next();
}

export function apiPaywall(req: Request, res: Response, next: NextFunction) {
  const api = res.locals.api as ApiRow;

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
