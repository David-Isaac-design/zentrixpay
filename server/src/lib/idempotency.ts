import { config } from "../config.js";
import { createTtlCache, type TtlCache } from "./ttlCache.js";

// Idempotency support for publish (issue #114). When a client sends an
// `Idempotency-Key`, the first completed publish is remembered so retries with
// the same key return the original response instead of creating a duplicate.
//
// An entry is either "in progress" (a publish is currently running for this
// key) or a stored result. The in-progress marker lets concurrent retries fail
// fast with 409 rather than racing to insert duplicates.

export interface IdempotentResult {
  status: number;
  body: unknown;
}

export type IdempotencyRecord =
  { inProgress: true } | { inProgress: false; result: IdempotentResult };

// Keys are scoped per publisher so one publisher's key can't collide with or
// read another's result.
export function idempotencyCacheKey(publisherId: string, key: string): string {
  return `${publisherId}:${key}`;
}

const defaultStore = createTtlCache<IdempotencyRecord>({
  defaultTtlMs: config.IDEMPOTENCY_TTL_MS,
  cacheName: "idempotency",
});

export function getIdempotencyStore(): TtlCache<IdempotencyRecord> {
  return defaultStore;
}

// ── Paid proxy calls (/api/:id/*) ─────────────────────────────────────────────
//
// A caller retrying a paid call after a network error must not pay twice. The
// first charged response is stored per (API, payer wallet, key) and replayed
// to retries without touching the paywall. Storage is bounded by TTL, entry
// count (oldest evicted first) and a per-response body cap.

export interface StoredProxyResponse {
  status: number;
  headers: Record<string, string | string[]>;
  body: Buffer;
}

export type ProxyIdempotencyRecord =
  | { inProgress: true; fingerprint: string }
  | {
      inProgress: false;
      fingerprint: string;
      /** sha256 of the payment header that paid, so an identical resend replays. */
      paymentHash: string;
      /** Null when the response was too large to keep; retries then get 409. */
      response: StoredProxyResponse | null;
      txHash: string | null;
    };

export function proxyIdempotencyCacheKey(apiId: string, payer: string, key: string): string {
  return `${apiId}:${payer}:${key}`;
}

const proxyStore = createTtlCache<ProxyIdempotencyRecord>({
  defaultTtlMs: config.PROXY_IDEMPOTENCY_TTL_MS,
  maxSize: config.PROXY_IDEMPOTENCY_MAX_ENTRIES,
  cacheName: "proxy_idempotency",
});

export function getProxyIdempotencyStore(): TtlCache<ProxyIdempotencyRecord> {
  return proxyStore;
}
