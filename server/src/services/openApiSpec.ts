import { parse as parseYaml } from "yaml";

// OpenAPI 3 documents that providers attach to an API. The stored copy is the
// provider's own; callers only ever get publicOpenApiSpec(), which points every
// `servers` entry at the paid proxy and scrubs the upstream origin everywhere.

export const MAX_OPENAPI_SPEC_BYTES = 512 * 1024;

const HTTP_OPERATIONS = ["get", "put", "post", "delete", "options", "head", "patch", "trace"];

export class OpenApiSpecError extends Error {}

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Parse (JSON or YAML text, or an already-parsed object) and check it is OpenAPI 3. */
export function parseOpenApiSpec(input: string | Json): Json {
  let doc: unknown = input;
  if (typeof input === "string") {
    if (Buffer.byteLength(input, "utf8") > MAX_OPENAPI_SPEC_BYTES) {
      throw new OpenApiSpecError(`OpenAPI document exceeds ${MAX_OPENAPI_SPEC_BYTES} bytes`);
    }
    try {
      // YAML is a superset of JSON, so one parser covers both. Aliases are
      // capped so a small document cannot expand into a huge one.
      doc = parseYaml(input, { maxAliasCount: 100 });
    } catch (err) {
      throw new OpenApiSpecError(
        `OpenAPI document is not valid JSON or YAML: ${(err as Error).message}`,
      );
    }
  }
  if (!isObject(doc)) throw new OpenApiSpecError("OpenAPI document must be an object");

  const serialized = JSON.stringify(doc);
  if (Buffer.byteLength(serialized, "utf8") > MAX_OPENAPI_SPEC_BYTES) {
    throw new OpenApiSpecError(`OpenAPI document exceeds ${MAX_OPENAPI_SPEC_BYTES} bytes`);
  }
  if (typeof doc.openapi !== "string" || !/^3\.\d+(\.\d+)?$/.test(doc.openapi)) {
    throw new OpenApiSpecError('Only OpenAPI 3.x documents are supported ("openapi": "3.x.y")');
  }
  if (!isObject(doc.info) || typeof doc.info.title !== "string") {
    throw new OpenApiSpecError("OpenAPI document needs info.title");
  }
  if (!isObject(doc.paths)) throw new OpenApiSpecError("OpenAPI document needs a paths object");
  // Round-trip so only plain JSON values are stored.
  return JSON.parse(serialized) as Json;
}

function trimSlash(path: string): string {
  return path.replace(/\/+$/, "");
}

/** Server URL with its `{variables}` filled from their defaults. */
function serverUrl(server: unknown): string | null {
  if (!isObject(server) || typeof server.url !== "string") return null;
  const variables = isObject(server.variables) ? server.variables : {};
  return server.url.replace(/\{([^}]+)\}/g, (_, name: string) => {
    const variable = variables[name];
    return isObject(variable) && typeof variable.default === "string" ? variable.default : "";
  });
}

/**
 * Where a spec server URL lands behind the proxy. A server inside the
 * upstream base keeps its extra path (`…/v1/beta` → `<proxy>/beta`); anything
 * else maps to the proxy root.
 */
function proxiedServerUrl(raw: string | null, upstream: URL, proxyUrl: string): string {
  if (!raw) return proxyUrl;
  let resolved: URL;
  try {
    resolved = new URL(raw, upstream);
  } catch {
    return proxyUrl;
  }
  const base = trimSlash(upstream.pathname);
  const path = trimSlash(resolved.pathname);
  if (resolved.host === upstream.host && (path === base || path.startsWith(`${base}/`))) {
    return `${proxyUrl}${path.slice(base.length)}`;
  }
  return proxyUrl;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Replace any mention of the upstream (base URL first, then bare origin) in every string. */
function scrubStrings(value: unknown, upstream: URL, proxyUrl: string): unknown {
  const base = new RegExp(escapeRegExp(trimSlash(`${upstream.origin}${upstream.pathname}`)), "gi");
  const origin = new RegExp(
    `[a-z][a-z0-9+.-]*://(?:[^/@\\s]*@)?${escapeRegExp(upstream.hostname)}(?::\\d+)?`,
    "gi",
  );
  const walk = (node: unknown): unknown => {
    if (typeof node === "string") return node.replace(base, proxyUrl).replace(origin, proxyUrl);
    if (Array.isArray(node)) return node.map(walk);
    if (isObject(node)) {
      return Object.fromEntries(Object.entries(node).map(([k, v]) => [walk(k) as string, walk(v)]));
    }
    return node;
  };
  return walk(value);
}

/** The spec as callers see it: servers point at the proxy, the upstream is never named. */
export function publicOpenApiSpec(spec: Json, upstreamUrl: string, proxyUrl: string): Json {
  const upstream = new URL(upstreamUrl);
  const doc = structuredClone(spec);
  const base = trimSlash(upstream.pathname);

  // Root servers: when the spec's server sits above the upstream base (server
  // https://api.x.com, upstream https://api.x.com/v1), its paths carry the
  // missing prefix, which the proxy already adds, so strip it from the paths.
  const rootServer = Array.isArray(doc.servers) ? serverUrl(doc.servers[0]) : null;
  if (rootServer && isObject(doc.paths)) {
    try {
      const resolved = new URL(rootServer, upstream);
      const serverPath = trimSlash(resolved.pathname);
      if (resolved.host === upstream.host && base.startsWith(`${serverPath}/`)) {
        const prefix = base.slice(serverPath.length);
        doc.paths = Object.fromEntries(
          Object.entries(doc.paths).map(([path, item]) => [
            path === prefix || path.startsWith(`${prefix}/`)
              ? path.slice(prefix.length) || "/"
              : path,
            item,
          ]),
        );
      }
    } catch {
      // Unparseable server URL: leave the paths alone.
    }
  }
  doc.servers = [{ url: proxiedServerUrl(rootServer, upstream, proxyUrl) }];

  if (isObject(doc.paths)) {
    for (const item of Object.values(doc.paths)) {
      if (!isObject(item)) continue;
      const nodes = [item, ...HTTP_OPERATIONS.map((m) => item[m]).filter(isObject)];
      for (const node of nodes) {
        if (Array.isArray(node.servers)) {
          node.servers = node.servers.map((s) => ({
            url: proxiedServerUrl(serverUrl(s), upstream, proxyUrl),
          }));
        }
      }
    }
  }

  return scrubStrings(doc, upstream, proxyUrl) as Json;
}
