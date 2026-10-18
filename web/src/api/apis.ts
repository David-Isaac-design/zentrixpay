import { signedPublisherFetch } from "./requestSignature.js";

const API_BASE = import.meta.env.VITE_API_URL ?? "";

export const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];

/** A pay-per-call API as anyone sees it in the catalog. */
export interface PublicApi {
  id: string;
  name: string;
  description: string | null;
  price: string;
  currency: "USDC";
  walletAddress: string;
  allowedMethods: HttpMethod[];
  tags: string[];
  proxyUrl: string;
  /** Present when the provider uploaded an OpenAPI document. */
  openapiUrl: string | null;
  /** The API's record in the vault registry, so callers can check price and payee. */
  onchain: { registered: boolean; contractId: string; txHash: string | null };
  createdAt: string;
}

/** The provider's own view of an API. */
export interface OwnerApi extends PublicApi {
  upstreamUrl: string;
  upstreamHeaderName: string | null;
  hasUpstreamSecret: boolean;
  upstreamQueryParamName: string | null;
  hasUpstreamQuerySecret: boolean;
  timeoutMs: number | null;
  listed: boolean;
  onchainStatus: "none" | "pending" | "registered" | "failed";
  ownershipVerified: boolean;
  ownershipVerification: { url: string; expectedContent: string };
}

export interface ApiCall {
  id: string;
  payerAddress: string;
  amount: string;
  charged: boolean;
  method: string;
  path: string;
  responseStatus: number;
  durationMs: number;
  refundStatus: "pending" | "refunded" | null;
  refundAmount: string | null;
  refundTxHash: string | null;
  refundedAt: string | null;
  createdAt: string;
}

export interface ApiStats {
  apiId: string;
  calls: number;
  chargedCalls: number;
  revenue: string;
  uniquePayers: number;
  avgDurationMs: number;
  refundedCalls: number;
  refunded: string;
  netRevenue: string;
  currency: "USDC";
  recentCalls: ApiCall[];
}

export interface ApiInput {
  name?: string;
  description?: string | null;
  upstreamUrl?: string;
  price?: string;
  walletAddress?: string;
  allowedMethods?: HttpMethod[];
  upstreamHeader?: { name: string; value: string } | null;
  upstreamQueryParam?: { name: string; value: string } | null;
  /** OpenAPI 3 document as JSON/YAML text; null removes it. */
  openapiSpec?: string | null;
  timeoutMs?: number | null;
  tags?: string[];
  listed?: boolean;
}

export interface RegisteredPublisher {
  id: string;
  name: string;
  email: string;
  walletAddress: string;
  apiKey: string;
}

/** Turn a server error body (string or zod format tree) into one readable line. */
function errorText(body: unknown, status: number): string {
  const error = (body as { error?: unknown } | null)?.error;
  if (typeof error === "string") return error;
  if (error && typeof error === "object") {
    const messages: string[] = [];
    const walk = (node: unknown, path: string) => {
      if (!node || typeof node !== "object") return;
      const errs = (node as { _errors?: string[] })._errors;
      if (errs?.length) messages.push(path ? `${path}: ${errs.join(", ")}` : errs.join(", "));
      for (const [k, v] of Object.entries(node))
        if (k !== "_errors") walk(v, path ? `${path}.${k}` : k);
    };
    walk(error, "");
    if (messages.length) return messages.join("; ");
  }
  return `Request failed (HTTP ${status})`;
}

async function readJson<T>(res: Response): Promise<T> {
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(errorText(body, res.status));
  return body as T;
}

export async function fetchApis(q: string, signal?: AbortSignal): Promise<PublicApi[]> {
  const url = new URL(`${API_BASE}/apis`, window.location.origin);
  if (q.trim()) url.searchParams.set("q", q.trim());
  url.searchParams.set("limit", "100");
  return readJson(await fetch(url, { signal }));
}

export async function registerPublisher(input: {
  name: string;
  email: string;
  walletAddress: string;
}): Promise<RegisteredPublisher> {
  return readJson(
    await fetch(`${API_BASE}/publishers`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    }),
  );
}

function absolute(path: string): string {
  return new URL(`${API_BASE}${path}`, window.location.origin).toString();
}

export async function fetchMyApis(apiKey: string): Promise<OwnerApi[]> {
  return readJson(await signedPublisherFetch(absolute("/publishers/me/apis"), apiKey));
}

export async function createApi(apiKey: string, input: ApiInput): Promise<OwnerApi> {
  return readJson(
    await signedPublisherFetch(absolute("/apis"), apiKey, {
      method: "POST",
      body: JSON.stringify(input),
    }),
  );
}

export async function updateApi(apiKey: string, id: string, input: ApiInput): Promise<OwnerApi> {
  return readJson(
    await signedPublisherFetch(absolute(`/apis/${id}`), apiKey, {
      method: "PATCH",
      body: JSON.stringify(input),
    }),
  );
}

export async function verifyApiOwnership(apiKey: string, id: string): Promise<OwnerApi> {
  return readJson(
    await signedPublisherFetch(absolute(`/apis/${id}/verify-ownership`), apiKey, {
      method: "POST",
    }),
  );
}

export async function fetchApiStats(apiKey: string, id: string): Promise<ApiStats> {
  return readJson(await signedPublisherFetch(absolute(`/apis/${id}/stats`), apiKey));
}

/** A transaction the server built for the provider's wallet to sign. */
export interface PreparedTx {
  unsignedXdr: string;
  networkPassphrase: string;
}

export async function prepareApiRegistration(apiKey: string, id: string): Promise<PreparedTx> {
  return readJson(await signedPublisherFetch(absolute(`/apis/${id}/register/prepare`), apiKey));
}

export async function submitApiRegistration(
  apiKey: string,
  id: string,
  signedXdr: string,
): Promise<OwnerApi> {
  return readJson(
    await signedPublisherFetch(absolute(`/apis/${id}/register`), apiKey, {
      method: "POST",
      body: JSON.stringify({ signedXdr }),
    }),
  );
}

export async function prepareApiPrice(
  apiKey: string,
  id: string,
  price: string,
): Promise<PreparedTx> {
  return readJson(
    await signedPublisherFetch(absolute(`/apis/${id}/price/prepare`), apiKey, {
      method: "POST",
      body: JSON.stringify({ price }),
    }),
  );
}

export async function submitApiPrice(
  apiKey: string,
  id: string,
  price: string,
  signedXdr: string,
): Promise<OwnerApi> {
  return readJson(
    await signedPublisherFetch(absolute(`/apis/${id}/price`), apiKey, {
      method: "POST",
      body: JSON.stringify({ price, signedXdr }),
    }),
  );
}

export async function prepareCallRefund(
  apiKey: string,
  id: string,
  callId: string,
): Promise<PreparedTx> {
  return readJson(
    await signedPublisherFetch(absolute(`/apis/${id}/calls/${callId}/refund/prepare`), apiKey, {
      method: "POST",
    }),
  );
}

export async function submitCallRefund(
  apiKey: string,
  id: string,
  callId: string,
  signedXdr: string,
): Promise<ApiCall> {
  return readJson(
    await signedPublisherFetch(absolute(`/apis/${id}/calls/${callId}/refund`), apiKey, {
      method: "POST",
      body: JSON.stringify({ signedXdr }),
    }),
  );
}

// ── OpenAPI ──────────────────────────────────────────────────────────────────

export interface ApiEndpoint {
  method: string;
  path: string;
  summary: string | null;
  parameters: { name: string; in: string; required: boolean; description: string | null }[];
  hasRequestBody: boolean;
}

export async function fetchOpenApiSpec(
  url: string,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  return readJson(await fetch(url, { signal }));
}

const OPERATIONS = ["get", "post", "put", "patch", "delete", "head", "options", "trace"];

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

/** Resolve a local `#/components/...` reference, or return the node unchanged. */
function deref(spec: Obj, node: unknown): unknown {
  if (!isObj(node) || typeof node.$ref !== "string" || !node.$ref.startsWith("#/")) return node;
  let cur: unknown = spec;
  for (const part of node.$ref.slice(2).split("/")) {
    if (!isObj(cur)) return node;
    cur = cur[part.replace(/~1/g, "/").replace(/~0/g, "~")];
  }
  return cur ?? node;
}

/** Flatten an OpenAPI document into a list of endpoints for display. */
export function endpointsFromSpec(spec: Obj): ApiEndpoint[] {
  const out: ApiEndpoint[] = [];
  const paths = isObj(spec.paths) ? spec.paths : {};
  for (const [path, rawItem] of Object.entries(paths)) {
    const item = deref(spec, rawItem);
    if (!isObj(item)) continue;
    const shared = Array.isArray(item.parameters) ? item.parameters : [];
    for (const method of OPERATIONS) {
      const op = item[method];
      if (!isObj(op)) continue;
      const params = [...shared, ...(Array.isArray(op.parameters) ? op.parameters : [])]
        .map((p) => deref(spec, p))
        .filter(isObj)
        .map((p) => ({
          name: String(p.name ?? ""),
          in: String(p.in ?? ""),
          required: p.required === true,
          description: typeof p.description === "string" ? p.description : null,
        }));
      out.push({
        method: method.toUpperCase(),
        path,
        summary:
          typeof op.summary === "string"
            ? op.summary
            : typeof op.description === "string"
              ? op.description
              : null,
        parameters: params,
        hasRequestBody: op.requestBody !== undefined,
      });
    }
  }
  return out;
}
