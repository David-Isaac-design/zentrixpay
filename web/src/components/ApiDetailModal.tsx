import React from "react";
import {
  endpointsFromSpec,
  fetchOpenApiSpec,
  type ApiEndpoint,
  type PublicApi,
} from "../api/apis.js";
import { useAsync } from "../hooks/useAsync.js";
import { ErrorBanner } from "./ErrorBanner.js";

interface Props {
  api: PublicApi;
  onTry: (api: PublicApi) => void;
  onClose: () => void;
}

const METHOD_COLORS: Record<string, string> = {
  GET: "bg-sky-100 text-sky-800 dark:bg-sky-900/40 dark:text-sky-300",
  POST: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300",
  PUT: "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300",
  PATCH: "bg-violet-100 text-violet-800 dark:bg-violet-900/40 dark:text-violet-300",
  DELETE: "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300",
};

function Endpoint({ endpoint, allowed }: { endpoint: ApiEndpoint; allowed: boolean }) {
  return (
    <li className="border-t border-gray-100 py-3 first:border-t-0 dark:border-gray-700">
      <div className="flex flex-wrap items-center gap-2">
        <span
          className={`rounded px-1.5 py-0.5 font-mono text-xs font-semibold ${METHOD_COLORS[endpoint.method] ?? "bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-200"}`}
        >
          {endpoint.method}
        </span>
        <code className="break-all text-sm text-gray-900 dark:text-gray-100">{endpoint.path}</code>
        {!allowed && (
          <span className="text-xs text-gray-500 dark:text-gray-400">
            (method not enabled on this gateway)
          </span>
        )}
      </div>
      {endpoint.summary && (
        <p className="mt-1 text-sm text-gray-600 dark:text-gray-300">{endpoint.summary}</p>
      )}
      {endpoint.parameters.length > 0 && (
        <table className="mt-2 w-full text-left text-xs">
          <tbody className="text-gray-700 dark:text-gray-200">
            {endpoint.parameters.map((p) => (
              <tr key={`${p.in}:${p.name}`}>
                <td className="py-0.5 pr-3 font-mono">
                  {p.name}
                  {p.required && <span className="text-red-600 dark:text-red-400">*</span>}
                </td>
                <td className="py-0.5 pr-3 text-gray-500 dark:text-gray-400">{p.in}</td>
                <td className="py-0.5">{p.description}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {endpoint.hasRequestBody && (
        <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">Accepts a request body.</p>
      )}
    </li>
  );
}

export function ApiDetailModal({ api, onTry, onClose }: Props) {
  const { status, data, error, retry } = useAsync<ApiEndpoint[]>(
    async (signal) =>
      api.openapiUrl ? endpointsFromSpec(await fetchOpenApiSpec(api.openapiUrl, signal)) : [],
    [api.openapiUrl],
  );

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="api-detail-title"
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/50 p-4"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-xl bg-white p-6 shadow-xl dark:bg-gray-800">
        <div className="mb-4 flex items-start justify-between gap-4">
          <div>
            <h2
              id="api-detail-title"
              className="text-lg font-semibold text-gray-900 dark:text-gray-100"
            >
              {api.name}
            </h2>
            <p className="text-sm text-gray-500 dark:text-gray-400">
              {api.price} USDC per call · <span className="font-mono">{api.proxyUrl}</span>
            </p>
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            className="rounded p-1 text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-700"
          >
            ✕
          </button>
        </div>

        {api.description && (
          <p className="mb-4 text-sm text-gray-600 dark:text-gray-300">{api.description}</p>
        )}

        {api.onchain.registered && (
          <p className="mb-4 text-xs text-gray-500 dark:text-gray-400">
            Price and payee are anchored in registry{" "}
            <span className="font-mono">{api.onchain.contractId}</span> under id{" "}
            <span className="font-mono">{api.id}</span>.
          </p>
        )}

        <h3 className="mb-1 font-semibold text-gray-900 dark:text-gray-100">Endpoints</h3>
        {status === "error" && (
          <ErrorBanner message={error ?? "Failed to load endpoints"} onRetry={retry} />
        )}
        {(status === "loading" || status === "idle") && !data && (
          <div className="h-24 animate-pulse rounded-lg bg-gray-100 dark:bg-gray-700" />
        )}
        {data && data.length === 0 && (
          <p className="text-sm text-gray-500 dark:text-gray-400">
            This provider has not described its endpoints.
          </p>
        )}
        {data && data.length > 0 && (
          <ul>
            {data.map((endpoint) => (
              <Endpoint
                key={`${endpoint.method} ${endpoint.path}`}
                endpoint={endpoint}
                allowed={(api.allowedMethods as string[]).includes(endpoint.method)}
              />
            ))}
          </ul>
        )}

        {api.openapiUrl && (
          <p className="mt-4 text-xs text-gray-500 dark:text-gray-400">
            OpenAPI document: <span className="font-mono break-all">{api.openapiUrl}</span>
          </p>
        )}

        <div className="mt-4 flex justify-end">
          <button
            onClick={() => onTry(api)}
            className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700"
          >
            Try it
          </button>
        </div>
      </div>
    </div>
  );
}
