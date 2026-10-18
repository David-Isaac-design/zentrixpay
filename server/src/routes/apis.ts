import express, { Router, type Router as RouterType, type Request, type Response } from "express";
import { apiKeyAuth } from "../middleware/apiKeyAuth.js";
import { requestSignatureAuth } from "../middleware/requestSignatureAuth.js";
import { validate } from "../middleware/validate.js";
import { publishIpRateLimit, publishWalletRateLimit } from "../middleware/rateLimiters.js";
import { apiPaywall, loadProxiedApi } from "../middleware/apiPaywall.js";
import {
  apiCatalogQuerySchema,
  confirmApiPriceSchema,
  createApiSchema,
  prepareApiPriceSchema,
  signedXdrSchema,
  updateApiSchema,
} from "../schemas/requests.js";
import {
  ApiServiceError,
  createApi,
  getApiById,
  getApiStats,
  getOwnedApi,
  listPublicApis,
  listPublisherApis,
  listRecentCalls,
  recordApiCall,
  toOwnerApi,
  toPublicApi,
  toPublicOpenApi,
  updateApi,
  verifyOwnership,
  type ApiRow,
} from "../services/apiService.js";
import {
  confirmApiPrice,
  confirmApiRegistration,
  prepareApiPrice,
  prepareApiRegistration,
} from "../services/apiOnchain.js";
import { confirmCallRefund, prepareCallRefund } from "../services/apiRefunds.js";
import { sendUpstream, UpstreamError } from "../lib/upstreamClient.js";
import { filterRequestHeaders, filterResponseHeaders } from "../lib/proxyHeaders.js";
import { parsePayerFromXPayment } from "../lib/parseXPayment.js";
import { decryptSecret } from "../utils/secretBox.js";
import { getLogger } from "../lib/logger.js";
import { config } from "../config.js";

const router: RouterType = Router();

function sendServiceError(res: Response, err: unknown): void {
  if (err instanceof ApiServiceError) {
    res.status(err.status).json({ error: err.message });
    return;
  }
  throw err;
}

// ── Management ────────────────────────────────────────────────────────────────

// POST /apis — register an API to sell per call (authenticated)
router.post(
  "/apis",
  apiKeyAuth,
  publishIpRateLimit,
  publishWalletRateLimit,
  requestSignatureAuth,
  validate(createApiSchema),
  async (req, res) => {
    const publisher = req.publisher!;
    try {
      const api = await createApi({
        ...req.body,
        publisherId: publisher.id,
        walletAddress: req.body.walletAddress ?? publisher.walletAddress,
      });
      const owner = toOwnerApi(api);
      res.status(201).json({
        ...owner,
        nextStep:
          `Serve "${owner.ownershipVerification.expectedContent}" at ` +
          `${owner.ownershipVerification.url}, then POST /apis/${api.id}/verify-ownership. ` +
          `Register it on-chain with GET /apis/${api.id}/register/prepare and ` +
          `POST /apis/${api.id}/register to list the API.`,
      });
    } catch (err) {
      sendServiceError(res, err);
    }
  },
);

// GET /apis — public catalog of listed APIs
router.get("/apis", async (req, res) => {
  const parsed = apiCatalogQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.format() });
    return;
  }
  res.json(await listPublicApis(parsed.data));
});

// GET /publishers/me/apis — the caller's own APIs, listed or not
router.get("/publishers/me/apis", apiKeyAuth, async (req, res) => {
  res.json(await listPublisherApis(req.publisher!.id));
});

// GET /apis/:id — public details of a listed API
router.get("/apis/:id", async (req, res) => {
  const api = await getApiById(req.params.id);
  if (!api || !api.listed) {
    res.status(404).json({ error: "API not found" });
    return;
  }
  res.json(toPublicApi(api));
});

// GET /apis/:id/openapi.json — the API's OpenAPI document, pointed at the proxy
router.get("/apis/:id/openapi.json", async (req, res) => {
  const api = await getApiById(req.params.id);
  const spec = api?.listed ? toPublicOpenApi(api) : null;
  if (!spec) {
    res.status(404).json({ error: "No OpenAPI document for this API" });
    return;
  }
  res.json(spec);
});

// PATCH /apis/:id — update price, upstream, methods, secret header, listing (owner)
router.patch(
  "/apis/:id",
  apiKeyAuth,
  requestSignatureAuth,
  validate(updateApiSchema),
  async (req, res) => {
    try {
      const api = await getOwnedApi(req.params.id as string, req.publisher!.id);
      res.json(toOwnerApi(await updateApi(api, req.body)));
    } catch (err) {
      sendServiceError(res, err);
    }
  },
);

// POST /apis/:id/verify-ownership — check /.well-known/zentrixpay.txt, then list (owner)
router.post("/apis/:id/verify-ownership", apiKeyAuth, requestSignatureAuth, async (req, res) => {
  try {
    const api = await getOwnedApi(req.params.id as string, req.publisher!.id);
    res.json(toOwnerApi(await verifyOwnership(api)));
  } catch (err) {
    sendServiceError(res, err);
  }
});

// GET /apis/:id/register/prepare — unsigned registry `register` tx for the payout wallet (owner)
router.get("/apis/:id/register/prepare", apiKeyAuth, async (req, res) => {
  try {
    const api = await getOwnedApi(req.params.id as string, req.publisher!.id);
    res.json(await prepareApiRegistration(api));
  } catch (err) {
    sendServiceError(res, err);
  }
});

// POST /apis/:id/register — submit the signed `register` tx; lists the API if verified (owner)
router.post(
  "/apis/:id/register",
  apiKeyAuth,
  requestSignatureAuth,
  validate(signedXdrSchema),
  async (req, res) => {
    try {
      const api = await getOwnedApi(req.params.id as string, req.publisher!.id);
      res.json(toOwnerApi(await confirmApiRegistration(api, req.body.signedXdr)));
    } catch (err) {
      sendServiceError(res, err);
    }
  },
);

// POST /apis/:id/price/prepare — unsigned `set_price` tx for an API registered on-chain (owner)
router.post(
  "/apis/:id/price/prepare",
  apiKeyAuth,
  requestSignatureAuth,
  validate(prepareApiPriceSchema),
  async (req, res) => {
    try {
      const api = await getOwnedApi(req.params.id as string, req.publisher!.id);
      res.json(await prepareApiPrice(api, req.body.price));
    } catch (err) {
      sendServiceError(res, err);
    }
  },
);

// POST /apis/:id/price — submit the signed `set_price` tx and sync the price (owner)
router.post(
  "/apis/:id/price",
  apiKeyAuth,
  requestSignatureAuth,
  validate(confirmApiPriceSchema),
  async (req, res) => {
    try {
      const api = await getOwnedApi(req.params.id as string, req.publisher!.id);
      res.json(toOwnerApi(await confirmApiPrice(api, req.body.price, req.body.signedXdr)));
    } catch (err) {
      sendServiceError(res, err);
    }
  },
);

// POST /apis/:id/calls/:callId/refund/prepare — unsigned USDC transfer back to the payer (owner)
router.post(
  "/apis/:id/calls/:callId/refund/prepare",
  apiKeyAuth,
  requestSignatureAuth,
  async (req, res) => {
    try {
      const api = await getOwnedApi(req.params.id as string, req.publisher!.id);
      res.json(await prepareCallRefund(api, req.params.callId as string));
    } catch (err) {
      sendServiceError(res, err);
    }
  },
);

// POST /apis/:id/calls/:callId/refund — submit the signed refund and record it (owner)
router.post(
  "/apis/:id/calls/:callId/refund",
  apiKeyAuth,
  requestSignatureAuth,
  validate(signedXdrSchema),
  async (req, res) => {
    try {
      const api = await getOwnedApi(req.params.id as string, req.publisher!.id);
      res.json(await confirmCallRefund(api, req.params.callId as string, req.body.signedXdr));
    } catch (err) {
      sendServiceError(res, err);
    }
  },
);

// GET /apis/:id/stats — call counts, revenue and recent calls (owner)
router.get("/apis/:id/stats", apiKeyAuth, async (req, res) => {
  try {
    const api = await getOwnedApi(req.params.id as string, req.publisher!.id);
    const [totals, recentCalls] = await Promise.all([
      getApiStats(api.id),
      listRecentCalls(api.id, 50),
    ]);
    res.json({ apiId: api.id, ...totals, recentCalls });
  } catch (err) {
    sendServiceError(res, err);
  }
});

// ── Paid proxy ────────────────────────────────────────────────────────────────

/** Map /api/:id/<segments>?<query> onto the API's upstream URL. */
export function buildUpstreamUrl(
  upstreamUrl: string,
  segments: string[],
  originalUrl: string,
): URL | null {
  // Segments arrive decoded. Refuse anything that could climb out of the
  // upstream base path or smuggle a separator.
  if (segments.some((s) => s === "." || s === ".." || /[/\\]/.test(s))) return null;

  const base = new URL(upstreamUrl);
  const basePath = base.pathname.replace(/\/+$/, "");
  const subPath = segments.map(encodeURIComponent).join("/");
  const target = new URL(base.origin);
  target.pathname = subPath ? `${basePath}/${subPath}` : basePath || "/";

  const queryStart = originalUrl.indexOf("?");
  const requestQuery = queryStart === -1 ? "" : originalUrl.slice(queryStart + 1);
  target.search = [base.search.slice(1), requestQuery].filter(Boolean).join("&");
  return target;
}

function decodeQueryPart(part: string): string {
  try {
    return decodeURIComponent(part.replace(/\+/g, " "));
  } catch {
    return part;
  }
}

/**
 * Set the provider's secret query parameter on the upstream URL. Any value the
 * caller sent under the same name is dropped so it cannot override the
 * provider's key. The rest of the query string is left byte-for-byte as sent.
 */
export function withSecretQueryParam(target: URL, name: string, value: string): URL {
  const kept = target.search
    .slice(1)
    .split("&")
    .filter((pair) => pair && decodeQueryPart(pair.split("=")[0]) !== name);
  kept.push(`${encodeURIComponent(name)}=${encodeURIComponent(value)}`);
  target.search = kept.join("&");
  return target;
}

export interface UpstreamSecrets {
  queryName?: string;
  values: string[];
}

/** Remove a secret query parameter (by name or by value) from a URL-ish string. */
function stripSecretParam(value: string, secrets: UpstreamSecrets): string {
  const queryStart = value.indexOf("?");
  if (queryStart === -1) return value;
  const hashStart = value.indexOf("#", queryStart);
  const query = value.slice(queryStart + 1, hashStart === -1 ? undefined : hashStart);
  const kept = query.split("&").filter((pair) => {
    if (!pair) return false;
    const [rawKey, ...rest] = pair.split("=");
    const key = decodeQueryPart(rawKey);
    return key !== secrets.queryName && !secrets.values.includes(decodeQueryPart(rest.join("=")));
  });
  return (
    value.slice(0, queryStart) +
    (kept.length ? `?${kept.join("&")}` : "") +
    (hashStart === -1 ? "" : value.slice(hashStart))
  );
}

/** Replace any literal (or URL-encoded) occurrence of a secret value. */
function redactSecrets(value: string, secrets: UpstreamSecrets): string {
  let out = value;
  for (const secret of secrets.values) {
    if (secret.length < 4) continue;
    for (const form of new Set([secret, encodeURIComponent(secret)])) {
      out = out.split(form).join("[redacted]");
    }
  }
  return out;
}

// Response headers that carry URLs; secret query parameters are removed from these.
const URL_HEADERS = new Set(["location", "content-location", "link", "refresh"]);

/**
 * Prepare an upstream response header for the caller: point upstream URLs at
 * the proxy and make sure no provider secret is echoed back.
 */
export function rewriteResponseHeader(
  name: string,
  value: string,
  api: ApiRow,
  secrets: UpstreamSecrets,
): string {
  let out = value;
  if (name === "location") {
    const base = api.upstreamUrl.replace(/\/+$/, "");
    if (out.startsWith(base)) out = `${config.BASE_URL}/api/${api.id}${out.slice(base.length)}`;
  }
  if (URL_HEADERS.has(name)) out = stripSecretParam(out, secrets);
  return redactSecrets(out, secrets);
}

function payerFrom(req: Request): string {
  const header = req.headers["payment-signature"] ?? req.headers["x-payment"];
  if (typeof header !== "string") return "unknown";
  return parsePayerFromXPayment(header).payer ?? "unknown";
}

const UPSTREAM_ERROR_STATUS = { blocked: 502, network: 502, too_large: 502, timeout: 504 } as const;

async function proxyHandler(req: Request, res: Response) {
  const api = res.locals.api as ApiRow;
  const segments = (req.params.path as unknown as string[] | undefined) ?? [];
  const target = buildUpstreamUrl(api.upstreamUrl, segments, req.originalUrl);
  if (!target) {
    res.status(400).json({ error: "Invalid path" });
    return;
  }

  const headers = filterRequestHeaders(req.headers);
  const secrets: UpstreamSecrets = { values: [] };
  if (api.upstreamHeaderName && api.upstreamHeaderValueEnc && config.UPSTREAM_SECRET_KEY) {
    const value = decryptSecret(api.upstreamHeaderValueEnc, config.UPSTREAM_SECRET_KEY);
    headers[api.upstreamHeaderName] = value;
    secrets.values.push(value);
  }
  if (api.upstreamQueryName && api.upstreamQueryValueEnc && config.UPSTREAM_SECRET_KEY) {
    const value = decryptSecret(api.upstreamQueryValueEnc, config.UPSTREAM_SECRET_KEY);
    withSecretQueryParam(target, api.upstreamQueryName, value);
    secrets.queryName = api.upstreamQueryName;
    secrets.values.push(value);
  }
  const body = Buffer.isBuffer(req.body) && req.body.length > 0 ? req.body : undefined;

  const started = Date.now();
  // Recorded once the response (and settlement) is complete: a final status
  // below 400 means the x402 middleware settled the payment.
  res.on("finish", () => {
    recordApiCall({
      apiId: api.id,
      payerAddress: payerFrom(req),
      amount: api.price,
      charged: res.statusCode < 400,
      method: req.method,
      path:
        target.pathname.slice(new URL(api.upstreamUrl).pathname.replace(/\/+$/, "").length) || "/",
      responseStatus: res.statusCode,
      durationMs: Date.now() - started,
    }).catch((err) =>
      getLogger().error(
        { event: "api_call_record_failed", apiId: api.id, err },
        "failed to record API call",
      ),
    );
  });

  let upstream;
  try {
    upstream = await sendUpstream({
      url: target,
      method: req.method,
      headers,
      body,
      timeoutMs: api.timeoutMs ?? config.PROXY_DEFAULT_TIMEOUT_MS,
      maxResponseBytes: config.PROXY_MAX_RESPONSE_BYTES,
      allowPrivate: config.PROXY_ALLOW_PRIVATE_UPSTREAMS,
    });
  } catch (err) {
    if (err instanceof UpstreamError) {
      getLogger().warn(
        { event: "api_upstream_failed", apiId: api.id, kind: err.kind, error: err.message },
        "upstream call failed; caller not charged",
      );
      res
        .status(UPSTREAM_ERROR_STATUS[err.kind])
        .json({ error: "upstream_failed", reason: err.kind });
      return;
    }
    throw err;
  }

  res.status(upstream.status);
  for (const [name, value] of Object.entries(filterResponseHeaders(upstream.headers))) {
    res.setHeader(
      name,
      Array.isArray(value)
        ? value.map((v) => rewriteResponseHeader(name, v, api, secrets))
        : rewriteResponseHeader(name, value, api, secrets),
    );
  }
  // res.end, not res.send: send() would add an ETag and could turn the reply
  // into a bodiless 304 that still counts as a successful (charged) call.
  res.setHeader("Content-Length", String(upstream.body.length));
  res.end(upstream.body);
}

// ANY /api/:id[/*path] — one paid call to the provider's API
router.all(
  "/api/:id{/*path}",
  loadProxiedApi,
  express.raw({ type: () => true, limit: config.PROXY_MAX_REQUEST_BODY }),
  apiPaywall,
  proxyHandler,
);

export default router;
