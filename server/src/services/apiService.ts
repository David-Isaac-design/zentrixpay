import { randomBytes } from "node:crypto";
import { and, desc, eq, ilike, isNotNull, or, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { apiCalls, apis } from "../db/schema.js";
import { config } from "../config.js";
import { encryptSecret } from "../utils/secretBox.js";
import { validateUpstreamUrl } from "../lib/upstreamGuard.js";
import { sendUpstream } from "../lib/upstreamClient.js";
import { createTtlCache } from "../lib/ttlCache.js";

export type ApiRow = typeof apis.$inferSelect;

// Hot proxied APIs are looked up on every call (#34). Every write to an API
// goes through this module and invalidates its entry, so edits apply at once
// in this process; other replicas see them within the TTL.
const apiCache = createTtlCache<ApiRow>({
  defaultTtlMs: config.PROXY_API_CACHE_TTL_MS,
  maxSize: 1_000,
  cacheName: "proxied_api",
});

export function invalidateApiCache(id: string): void {
  apiCache.delete(id);
}

export const OWNERSHIP_FILE_PATH = "/.well-known/zentrixpay.txt";

export class ApiServiceError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** What anyone may see about an API. Never includes the upstream URL or secret. */
export function toPublicApi(api: ApiRow) {
  return {
    id: api.id,
    name: api.name,
    description: api.description,
    price: api.price,
    currency: "USDC",
    walletAddress: api.walletAddress,
    allowedMethods: api.allowedMethods,
    tags: api.tags,
    healthy: api.healthy,
    proxyUrl: `${config.BASE_URL}/api/${api.id}`,
    createdAt: api.createdAt,
  };
}

/** What the owning provider sees. Includes the upstream URL but never the secret value. */
export function toOwnerApi(api: ApiRow) {
  return {
    ...toPublicApi(api),
    upstreamUrl: api.upstreamUrl,
    upstreamHeaderName: api.upstreamHeaderName,
    hasUpstreamSecret: Boolean(api.upstreamHeaderValueEnc),
    timeoutMs: api.timeoutMs,
    maxResponseBytes: api.maxResponseBytes,
    webhookUrl: api.webhookUrl,
    hasWebhookSecret: Boolean(api.webhookSecretEnc),
    healthPath: api.healthPath,
    health: {
      healthy: api.healthy,
      consecutiveFailures: api.healthFailures,
      lastCheckedAt: api.lastHealthCheckAt,
    },
    listed: api.listed,
    ownershipVerified: Boolean(api.ownershipVerifiedAt),
    ownershipVerification: {
      url: ownershipFileUrl(api.upstreamUrl),
      expectedContent: ownershipLine(api.ownershipToken),
    },
  };
}

function ownershipLine(token: string): string {
  return `zentrixpay-verification=${token}`;
}

function ownershipFileUrl(upstreamUrl: string): string {
  return new URL(OWNERSHIP_FILE_PATH, new URL(upstreamUrl).origin).toString();
}

function checkedUpstreamUrl(raw: string): string {
  try {
    return validateUpstreamUrl(raw, {
      allowPrivate: config.PROXY_ALLOW_PRIVATE_UPSTREAMS,
    }).toString();
  } catch (err) {
    throw new ApiServiceError(400, (err as Error).message);
  }
}

function secretKey(): string {
  if (!config.UPSTREAM_SECRET_KEY) {
    throw new ApiServiceError(
      503,
      "This server cannot store upstream secrets (UPSTREAM_SECRET_KEY is not configured)",
    );
  }
  return config.UPSTREAM_SECRET_KEY;
}

function encryptedHeader(header: { name: string; value: string } | null | undefined) {
  if (header === undefined) return {};
  if (header === null) return { upstreamHeaderName: null, upstreamHeaderValueEnc: null };
  return {
    upstreamHeaderName: header.name.toLowerCase(),
    upstreamHeaderValueEnc: encryptSecret(header.value, secretKey()),
  };
}

function encryptedWebhook(webhook: { url: string; secret: string } | null | undefined) {
  if (webhook === undefined) return {};
  if (webhook === null) return { webhookUrl: null, webhookSecretEnc: null };
  let url: string;
  try {
    url = validateUpstreamUrl(webhook.url, {
      allowPrivate: config.PROXY_ALLOW_PRIVATE_UPSTREAMS,
      field: "webhook.url",
    }).toString();
  } catch (err) {
    throw new ApiServiceError(400, (err as Error).message);
  }
  return { webhookUrl: url, webhookSecretEnc: encryptSecret(webhook.secret, secretKey()) };
}

function clampTimeout(timeoutMs: number | undefined | null): number | null | undefined {
  if (timeoutMs === undefined || timeoutMs === null) return timeoutMs;
  return Math.min(timeoutMs, config.PROXY_MAX_TIMEOUT_MS);
}

function checkedMaxResponseBytes(bytes: number | undefined | null): number | null | undefined {
  if (bytes !== undefined && bytes !== null && bytes > config.PROXY_MAX_RESPONSE_BYTES) {
    throw new ApiServiceError(
      400,
      `maxResponseBytes must not exceed the server limit of ${config.PROXY_MAX_RESPONSE_BYTES} bytes`,
    );
  }
  return bytes;
}

/** The response cap applied to a proxied call; the global cap always wins. */
export function effectiveMaxResponseBytes(api: ApiRow): number {
  return Math.min(
    api.maxResponseBytes ?? config.PROXY_MAX_RESPONSE_BYTES,
    config.PROXY_MAX_RESPONSE_BYTES,
  );
}

// A new health target starts out healthy until checks say otherwise.
const RESET_HEALTH = { healthy: true, healthFailures: 0, lastHealthCheckAt: null };

export interface CreateApiInput {
  publisherId: string;
  name: string;
  description?: string;
  upstreamUrl: string;
  price: string;
  walletAddress: string;
  allowedMethods: string[];
  upstreamHeader?: { name: string; value: string };
  timeoutMs?: number;
  maxResponseBytes?: number;
  webhook?: { url: string; secret: string };
  healthPath?: string;
  tags: string[];
}

export async function createApi(input: CreateApiInput): Promise<ApiRow> {
  const [row] = await db
    .insert(apis)
    .values({
      publisherId: input.publisherId,
      name: input.name,
      description: input.description,
      upstreamUrl: checkedUpstreamUrl(input.upstreamUrl),
      price: input.price,
      walletAddress: input.walletAddress,
      allowedMethods: input.allowedMethods,
      timeoutMs: clampTimeout(input.timeoutMs),
      maxResponseBytes: checkedMaxResponseBytes(input.maxResponseBytes),
      healthPath: input.healthPath,
      tags: input.tags,
      ownershipToken: randomBytes(16).toString("hex"),
      ...encryptedHeader(input.upstreamHeader),
      ...encryptedWebhook(input.webhook),
    })
    .returning();
  return row;
}

export async function getApiById(id: string): Promise<ApiRow | null> {
  const rows = await db.select().from(apis).where(eq(apis.id, id));
  return rows[0] ?? null;
}

/** getApiById behind a short TTL cache, for the per-call proxy path (#34). */
export async function getProxiedApi(id: string): Promise<ApiRow | null> {
  const cached = apiCache.get(id);
  if (cached) return cached;
  const api = await getApiById(id);
  if (api) apiCache.set(id, api);
  return api;
}

/** Load an API and require that `publisherId` owns it (404 otherwise, to avoid leaking ids). */
export async function getOwnedApi(id: string, publisherId: string): Promise<ApiRow> {
  const api = await getApiById(id);
  if (!api || api.publisherId !== publisherId) throw new ApiServiceError(404, "API not found");
  return api;
}

export async function listPublicApis(opts: { q?: string; limit: number; offset: number }) {
  // Unhealthy APIs are hidden until a health check succeeds again (#35).
  const conditions = [eq(apis.listed, true), eq(apis.healthy, true)];
  if (opts.q) {
    const pattern = `%${opts.q.replace(/[%_\\]/g, "\\$&")}%`;
    conditions.push(or(ilike(apis.name, pattern), ilike(apis.description, pattern))!);
  }
  const rows = await db
    .select()
    .from(apis)
    .where(and(...conditions))
    .orderBy(desc(apis.createdAt))
    .limit(opts.limit)
    .offset(opts.offset);
  return rows.map(toPublicApi);
}

export async function listPublisherApis(publisherId: string) {
  const rows = await db
    .select()
    .from(apis)
    .where(eq(apis.publisherId, publisherId))
    .orderBy(desc(apis.createdAt));
  return rows.map(toOwnerApi);
}

export interface UpdateApiInput {
  name?: string;
  description?: string | null;
  upstreamUrl?: string;
  price?: string;
  walletAddress?: string;
  allowedMethods?: string[];
  upstreamHeader?: { name: string; value: string } | null;
  timeoutMs?: number | null;
  maxResponseBytes?: number | null;
  webhook?: { url: string; secret: string } | null;
  healthPath?: string | null;
  tags?: string[];
  listed?: boolean;
}

export async function updateApi(api: ApiRow, input: UpdateApiInput): Promise<ApiRow> {
  const changes: Partial<typeof apis.$inferInsert> = {
    name: input.name,
    description: input.description,
    price: input.price,
    walletAddress: input.walletAddress,
    allowedMethods: input.allowedMethods,
    timeoutMs: clampTimeout(input.timeoutMs),
    maxResponseBytes: checkedMaxResponseBytes(input.maxResponseBytes),
    tags: input.tags,
    ...encryptedHeader(input.upstreamHeader),
    ...encryptedWebhook(input.webhook),
  };

  if (input.healthPath !== undefined && input.healthPath !== api.healthPath) {
    Object.assign(changes, { healthPath: input.healthPath }, RESET_HEALTH);
  }

  if (input.upstreamUrl !== undefined) {
    const upstreamUrl = checkedUpstreamUrl(input.upstreamUrl);
    changes.upstreamUrl = upstreamUrl;
    if (upstreamUrl !== api.upstreamUrl) Object.assign(changes, RESET_HEALTH);
    // Ownership was proven for the old origin; a new origin must be proven again.
    if (new URL(upstreamUrl).origin !== new URL(api.upstreamUrl).origin) {
      changes.ownershipVerifiedAt = null;
      changes.listed = false;
    }
  }

  if (input.listed !== undefined) {
    const verified =
      changes.ownershipVerifiedAt === null ? false : Boolean(api.ownershipVerifiedAt);
    if (input.listed && !verified) {
      throw new ApiServiceError(409, "Verify ownership of the upstream before listing this API");
    }
    changes.listed = input.listed;
  }

  for (const key of Object.keys(changes) as Array<keyof typeof changes>) {
    if (changes[key] === undefined) delete changes[key];
  }
  if (Object.keys(changes).length === 0) return api;

  const [row] = await db.update(apis).set(changes).where(eq(apis.id, api.id)).returning();
  invalidateApiCache(api.id);
  return row;
}

/**
 * Prove the provider controls the upstream origin: it must serve
 * `zentrixpay-verification=<token>` at /.well-known/zentrixpay.txt.
 * On success the API is marked verified and listed.
 */
export async function verifyOwnership(api: ApiRow): Promise<ApiRow> {
  let body: string;
  let status: number;
  try {
    const res = await sendUpstream({
      url: new URL(ownershipFileUrl(api.upstreamUrl)),
      method: "GET",
      headers: { accept: "text/plain", "user-agent": "ZentrixPay-Verifier/1" },
      timeoutMs: 5_000,
      maxResponseBytes: 64 * 1024,
      allowPrivate: config.PROXY_ALLOW_PRIVATE_UPSTREAMS,
    });
    status = res.status;
    body = res.body.toString("utf8");
  } catch (err) {
    throw new ApiServiceError(
      422,
      `Could not fetch ${OWNERSHIP_FILE_PATH}: ${(err as Error).message}`,
    );
  }

  const expected = ownershipLine(api.ownershipToken);
  const found = body.split(/\r?\n/).some((line) => line.trim() === expected);
  if (status !== 200 || !found) {
    throw new ApiServiceError(
      422,
      `${OWNERSHIP_FILE_PATH} must return 200 and contain the line "${expected}"`,
    );
  }

  const [row] = await db
    .update(apis)
    .set({ ownershipVerifiedAt: new Date(), listed: true })
    .where(eq(apis.id, api.id))
    .returning();
  invalidateApiCache(api.id);
  return row;
}

export interface RecordCallInput {
  id?: string;
  apiId: string;
  payerAddress: string;
  amount: string;
  charged: boolean;
  method: string;
  path: string;
  responseStatus: number;
  durationMs: number;
}

export async function recordApiCall(input: RecordCallInput): Promise<void> {
  await db.insert(apiCalls).values(input);
}

// ── Health checks (#35) ──────────────────────────────────────────────────────

/** Listed APIs with a health path, healthy or not (unhealthy ones must be able to recover). */
export async function listApisForHealthCheck(): Promise<ApiRow[]> {
  return db
    .select()
    .from(apis)
    .where(and(eq(apis.listed, true), isNotNull(apis.healthPath)));
}

/** Map an API's healthPath onto its upstream, the same way the proxy maps /api/:id<path>. */
export function healthCheckUrl(api: ApiRow): URL {
  const base = new URL(api.upstreamUrl);
  const raw = api.healthPath ?? "/";
  const queryStart = raw.indexOf("?");
  const path = queryStart === -1 ? raw : raw.slice(0, queryStart);
  const query = queryStart === -1 ? "" : raw.slice(queryStart + 1);
  const target = new URL(base.origin);
  target.pathname = `${base.pathname.replace(/\/+$/, "")}${path}`;
  target.search = [base.search.slice(1), query].filter(Boolean).join("&");
  return target;
}

/**
 * Record one health check. A success makes the API healthy at once; it turns
 * unhealthy only after `failureThreshold` consecutive failures.
 */
export async function recordHealthCheck(
  api: ApiRow,
  ok: boolean,
  failureThreshold: number,
): Promise<ApiRow> {
  const now = new Date();
  const [row] = await db
    .update(apis)
    .set(
      ok
        ? { healthy: true, healthFailures: 0, lastHealthCheckAt: now }
        : {
            healthFailures: sql`${apis.healthFailures} + 1`,
            healthy: sql`case when ${apis.healthFailures} + 1 >= ${failureThreshold} then false else ${apis.healthy} end`,
            lastHealthCheckAt: now,
          },
    )
    .where(eq(apis.id, api.id))
    .returning();
  if (row && row.healthy !== api.healthy) invalidateApiCache(api.id);
  return row ?? api;
}

export async function getApiStats(apiId: string) {
  const [totals] = await db
    .select({
      calls: sql<number>`count(*)::int`,
      chargedCalls: sql<number>`count(*) filter (where ${apiCalls.charged})::int`,
      revenue: sql<string>`coalesce(sum(${apiCalls.amount}::numeric) filter (where ${apiCalls.charged}), 0)::text`,
      uniquePayers: sql<number>`count(distinct ${apiCalls.payerAddress}) filter (where ${apiCalls.charged})::int`,
      avgDurationMs: sql<number>`coalesce(avg(${apiCalls.durationMs}), 0)::int`,
    })
    .from(apiCalls)
    .where(eq(apiCalls.apiId, apiId));
  return { ...totals, currency: "USDC" };
}

export async function listRecentCalls(apiId: string, limit: number) {
  return db
    .select()
    .from(apiCalls)
    .where(eq(apiCalls.apiId, apiId))
    .orderBy(desc(apiCalls.createdAt))
    .limit(limit);
}
