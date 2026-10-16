# x402 Gateway

A payment-gated API gateway that lets you charge for any HTTP endpoint using the [x402 protocol](https://x402.org). Callers pay per request with USDC on Base; the gateway verifies the payment on-chain and proxies the request to your upstream service.

## Features

- **Pay-per-call HTTP endpoints** — wrap any upstream API behind a `402 Payment Required` handshake
- **MCP server** — expose paid tools to agents (Claude Code, Codex, and any MCP client)
- **On-chain verification** — payments are verified against Base mainnet/testnet before the request is proxied
- **Per-route pricing** — configure price, network, and payee per endpoint
- **Call history** — every paid call is recorded and queryable

## Quick start

```bash
npm install
cp .env.example .env
# edit .env with your RPC URL, payee address, and upstream URLs
npm run dev
```

The gateway listens on `http://localhost:3000` by default.

## Configuration

Routes are defined in `config/routes.json`:

```json
{
  "routes": [
    {
      "path": "/api/weather",
      "upstream": "https://api.example.com/weather",
      "price": "0.001",
      "network": "base-sepolia",
      "payee": "0xYourAddress"
    }
  ]
}
```

| Field      | Description                                              |
| ---------- | -------------------------------------------------------- |
| `path`     | Public path exposed by the gateway                       |
| `upstream` | Upstream URL the request is proxied to after payment     |
| `price`    | Price in USDC per call                                   |
| `network`  | `base` or `base-sepolia`                                 |
| `payee`    | Address that receives the payment                        |

## For callers

Every paid route responds with `402 Payment Required` until a valid payment is attached. The response includes a `PAYMENT-REQUIRED` header describing what to pay; retry the same request with a `PAYMENT-SIGNATURE` header and the gateway returns the upstream response plus a `PAYMENT-RESPONSE` header.

```bash
# 1. First call — expect a 402 with payment instructions
curl -i http://localhost:3000/api/weather

# 2. Retry with the signed payment
curl -i http://localhost:3000/api/weather \
  -H "PAYMENT-SIGNATURE: <base64-encoded-payment-payload>"
```

For a full walkthrough with real (redacted) testnet headers — decoding `PAYMENT-REQUIRED`, constructing the `PAYMENT-SIGNATURE`, and reading the `PAYMENT-RESPONSE` receipt — see **[docs/curl-402-walkthrough.md](docs/curl-402-walkthrough.md)**.

## MCP server

The gateway ships an MCP server that exposes paid routes as tools, so agents can discover and call them directly. Start it with:

```bash
npm run mcp
```

Tools include `list_paid_tools`, `call_paid_tool`, and `get_call_history`. Wallet setup, example prompts, and sample tool outputs for Claude Code and Codex are documented in **[docs/mcp-pay-per-call.md](docs/mcp-pay-per-call.md)**.

## Development

```bash
npm run dev     # start the gateway with hot reload
npm test        # run the test suite
npm run lint    # lint the codebase
```

## License

MIT