# ZentrixPay

ZentrixPay is a pay-per-call gateway for HTTP APIs, built on Stellar. A provider puts an API behind ZentrixPay and sets a price per call in USDC. Anyone who calls it — a person in a browser, a script, or an AI agent — pays for each call with the [x402 protocol](docs/GLOSSARY.md#x402), and the USDC goes straight to the provider's Stellar wallet.

No accounts, no API-key signups, no subscriptions. One HTTP request, one payment.

## How a call works

```
caller ──GET /api/<id>/weather?city=lagos──▶ ZentrixPay
       ◀──────── 402 Payment Required ─────── (price, payee, network)
caller ──same request + signed USDC payment─▶ ZentrixPay ──forward──▶ provider's API
       ◀──────────── API response ─────────── settle payment ◀──────── 200 OK
```

1. The caller requests `https://<zentrixpay>/api/<id>/<path>`.
2. ZentrixPay answers **402** with the price, the provider's wallet and the Stellar network.
3. The caller signs a USDC payment and retries. Any x402 client does this automatically.
4. ZentrixPay forwards the request to the provider's real API and returns the response.
5. The payment settles on Stellar **only if the API answered with a status below 400**. Errors, timeouts and oversized responses are never charged.

## For API providers

1. **Register as a provider** — `POST /publishers` with your name, email and payout wallet. You get an API key (shown once).
2. **Register your API** — `POST /apis` with:
   - `name`, `description`, `price` (USDC per call)
   - `upstreamUrl` — your real API's base URL. Callers never see it.
   - `allowedMethods` — e.g. `["GET", "POST"]`
   - `upstreamHeader` (optional) — a secret header ZentrixPay adds to every forwarded call, such as your own API key. It is stored AES-256-GCM encrypted.
   - `upstreamQueryParam` (optional) — `{ "name": "api_key", "value": "…" }` for APIs that take their key in the URL. Stored encrypted, added to every forwarded URL (replacing any value the caller sent under that name), and stripped or redacted from `Location` and other response headers so it never reaches callers.
   - `openapiSpec` (optional) — an OpenAPI 3 document (JSON or YAML text, or a JSON object; up to 512 KB). The catalog shows its endpoints, and `GET /apis/<id>/openapi.json` serves it with every `servers` URL pointed at your proxy URL and your upstream origin scrubbed. Send `null` in a `PATCH` to remove it.
3. **Prove you own the domain** — serve the line you were given (`zentrixpay-verification=<token>`) at `https://<your-api-domain>/.well-known/zentrixpay.txt`, then `POST /apis/<id>/verify-ownership`.
4. **Anchor it on-chain** — `GET /apis/<id>/register/prepare` returns an unsigned vault-registry `register` transaction (id = the API id, creator = your payout wallet, price in USDC base units). Sign it with your payout wallet and `POST /apis/<id>/register` with `{ "signedXdr": "…" }`. Once ownership is verified and the registration is confirmed, the API is listed.
5. **Get paid** — share your proxy URL `https://<zentrixpay>/api/<id>`. `GET /apis/<id>/stats` shows calls, revenue, refunds, net revenue, unique payers and latency.

Every paid call checks the database price and payout wallet against the on-chain record first. If they differ, the call is refused with `409` before the caller is asked to pay. That is why a registered API's price changes only through the registry: `POST /apis/<id>/price/prepare` with `{ "price": "…" }`, sign the returned `set_price` transaction, then `POST /apis/<id>/price` with `{ "price", "signedXdr" }`. A registered API's payout wallet cannot be changed.

### Refunds

A provider can refund any charged call from `GET /apis/<id>/stats` → `recentCalls`. ZentrixPay never holds funds, so the refund is a USDC transfer from your payout wallet back to the caller, and you sign it:

1. `POST /apis/<id>/calls/<callId>/refund/prepare` returns an unsigned USDC `transfer(payout wallet → payer, call amount)` transaction.
2. Sign it and `POST /apis/<id>/calls/<callId>/refund` with `{ "signedXdr": "…" }`.

The server checks that the signed transaction is exactly the prepared transfer, claims the call so it cannot be refunded twice, submits it, and records `refundStatus`, `refundAmount`, `refundTxHash` and `refundedAt` on the call. Stats then report `refunded`, `refundedCalls` and `netRevenue` (revenue minus refunds). The contract's `record_creator_refund` is not used: it needs an on-chain payment receipt, and API calls do not record one.

> **Lock your upstream down.** ZentrixPay never reveals your upstream URL, but if your API answers requests without the secret header, anyone who finds the URL can skip paying. Require the header you configured in `upstreamHeader`.

All of this is also available in the web app (**Sell your API** tab) and through the MCP tools below.

### API reference

| Endpoint                                      | Auth        | Description                                                     |
| --------------------------------------------- | ----------- | --------------------------------------------------------------- |
| `GET /apis?q=&limit=&offset=`                 | —           | Catalog of listed APIs                                          |
| `GET /apis/:id`                               | —           | One listed API: price, methods, payee, proxy URL                |
| `ANY /api/:id/*`                              | x402        | A paid call, forwarded to the provider                          |
| `POST /publishers`                            | —           | Register as a provider; returns your API key once               |
| `POST /apis`                                  | `x-api-key` | Register an API                                                 |
| `GET /apis/:id/openapi.json`                  | —           | The API's OpenAPI document, pointed at the proxy                |
| `PATCH /apis/:id`                             | `x-api-key` | Change price, upstream, methods, secrets, spec, tags or listing |
| `POST /apis/:id/verify-ownership`             | `x-api-key` | Check `/.well-known/zentrixpay.txt`                             |
| `GET /apis/:id/register/prepare`              | `x-api-key` | Unsigned registry `register` transaction                        |
| `POST /apis/:id/register`                     | `x-api-key` | Submit the signed registration; lists a verified API            |
| `POST /apis/:id/price/prepare`                | `x-api-key` | Unsigned `set_price` transaction for a registered API           |
| `POST /apis/:id/price`                        | `x-api-key` | Submit the signed `set_price` and update the price              |
| `POST /apis/:id/calls/:callId/refund/prepare` | `x-api-key` | Unsigned USDC refund transfer to the payer                      |
| `POST /apis/:id/calls/:callId/refund`         | `x-api-key` | Submit the signed refund and record it                          |
| `GET /publishers/me/apis`                     | `x-api-key` | Your APIs, listed or not                                        |
| `GET /apis/:id/stats`                         | `x-api-key` | Call counts, revenue, refunds, net revenue, recent calls        |

Changing an API's upstream to a different domain un-lists it until ownership is verified again.

## For callers

- **Browser** — open the web app, connect [Freighter](https://www.freighter.app/), pick an API and use **Try it**. Each successful call is paid from your wallet.
- **Code** — wrap `fetch` with an x402 client (`@x402/fetch` + `@x402/stellar`) and call the proxy URL like any other API.
- **AI agents** — use the MCP server below.

Try the 402 yourself:

```bash
curl -i http://localhost:4021/api/<id>
# HTTP/1.1 402 Payment Required
# PAYMENT-REQUIRED: eyJ4NDAy...   (base64: price, payee, network, scheme)
```

## MCP server

The MCP server lets Claude Code, Codex or any MCP client find APIs, call them (paying per call from an agent wallet), and manage APIs as a provider.

| Tool                              | What it does                                                      |
| --------------------------------- | ----------------------------------------------------------------- |
| `zentrixpay_setup_wallet`         | Create a Stellar agent wallet (sponsored, no XLM needed up front) |
| `zentrixpay_wallet_info`          | Wallet address and USDC balance                                   |
| `zentrixpay_list_apis`            | Search the API catalog                                            |
| `zentrixpay_api_info`             | Price, methods and proxy URL for one API                          |
| `zentrixpay_call`                 | Make a paid call (method, path, query, body, headers)             |
| `zentrixpay_register`             | Register the agent as a provider                                  |
| `zentrixpay_register_api`         | Register an API to sell                                           |
| `zentrixpay_update_api`           | Change price, upstream, methods, secret header or listing         |
| `zentrixpay_verify_api_ownership` | Verify the domain and list the API                                |
| `zentrixpay_my_apis`              | Your APIs                                                         |
| `zentrixpay_api_stats`            | Calls and earnings for one API                                    |
| `zentrixpay_purchase_history`     | Paid calls this agent has made                                    |

`zentrixpay_call` checks the wallet balance before paying, refuses methods the API does not accept, and stops at the auto-pay ceiling (`ZENTRIXPAY_MAX_AUTO_PAY_USDC`, 10 USDC by default) unless you pass `maxAutoPayUsdc`. On mainnet, calls and API changes need `confirmMainnet: true` (or `ZENTRIXPAY_ALLOW_MAINNET=1`).

```bash
pnpm --filter @zentrixpay/mcp build

# Claude Code
claude mcp add zentrixpay -e ZENTRIXPAY_URL=http://localhost:4021 -- node /path/to/zentrixpay/mcp/dist/index.js

# Codex
codex mcp add zentrixpay --env ZENTRIXPAY_URL=http://localhost:4021 -- node /path/to/zentrixpay/mcp/dist/index.js
```

Set `ZENTRIXPAY_URL` to your deployment; it defaults to `http://localhost:4021`. More client configs: [docs/mcp-client-configs.md](docs/mcp-client-configs.md).

## Running locally

Requires Node.js 20+, pnpm 10 (`corepack enable`), a Postgres database, and Stellar testnet wallets (XLM from Friendbot, USDC from the [Circle faucet](https://faucet.circle.com)).

```bash
pnpm install
cp server/.env.example server/.env   # fill in the values
pnpm db:migrate
pnpm dev:server                      # API on :4021
pnpm dev:web                         # web app on :5173 (set VITE_API_URL=http://localhost:4021)
```

Proxy settings in `server/.env`:

| Variable                        | Default    | Description                                                               |
| ------------------------------- | ---------- | ------------------------------------------------------------------------- |
| `UPSTREAM_SECRET_KEY`           | _(unset)_  | 64 hex chars; encrypts providers' secret headers. Required to store them. |
| `PROXY_MAX_REQUEST_BODY`        | `5mb`      | Largest request body forwarded upstream                                   |
| `PROXY_MAX_RESPONSE_BYTES`      | `10485760` | Larger upstream responses fail with 502 and are not charged               |
| `PROXY_DEFAULT_TIMEOUT_MS`      | `15000`    | Upstream timeout when the API sets none                                   |
| `PROXY_MAX_TIMEOUT_MS`          | `25000`    | Ceiling for a provider's own timeout                                      |
| `PROXY_ALLOW_PRIVATE_UPSTREAMS` | `false`    | Local development only: allow upstreams on localhost/private networks     |

Payments are settled by the x402 facilitator (`FACILITATOR_URL`, default `https://www.x402.org/facilitator`, testnet fees sponsored).

## Security

The proxy makes requests to URLs that providers choose, so it guards against being turned against its own network:

- Upstreams on loopback, private, link-local (including cloud metadata), and other reserved addresses are refused — at registration and again at connect time, so a domain that later re-resolves to a private address (DNS rebinding) is still blocked.
- Redirects are not followed; paths that try to climb out of the upstream base (`..`, encoded slashes) are rejected.
- Callers' cookies, payment and auth headers are stripped before forwarding; upstream cookies, CORS and x402 headers are stripped from responses.
- Responses are size-capped and every call has a timeout.

## Project structure

```
zentrixpay/
  server/     Express API, x402 paywall, pay-per-call proxy, Postgres (Drizzle)
  web/        React app: API catalog, try-it console, provider dashboard
  mcp/        MCP server for AI agents
  contract/   Soroban contracts
  packages/   Shared Stellar network and registry client
```

## Status

- Working: provider registration, API registration and ownership verification, the paid proxy with per-call x402 settlement, catalog, stats, web app and MCP tools.
- Still in the tree from the original project: the file-vault endpoints (`/resources`, AI content verification, Supabase storage) and their configuration. They are being removed; until then the server still expects the Supabase and OpenRouter variables in `server/.env.example`.
- Not yet built: per-endpoint pricing, prepaid call credits, streaming responses (responses are buffered until payment settles), mainnet deployment.

## Credits

ZentrixPay started as a fork of [MindVault](https://github.com/mind-vault-1/mindvault), a payment-protected vault for digital resources on Stellar.

## License

MIT — see [LICENSE](LICENSE).
