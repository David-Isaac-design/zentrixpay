import { describe, expect, it, vi } from "vitest";
import {
  createApiToolHandler,
  type ApiToolDeps,
  type ApiToolDefinition,
} from "./apiTools.js";

/**
 * Handler-level tests for the pay-per-call tools.
 *
 * These complement the dispatcher-level integration test by exercising
 * `createApiToolHandler` directly with injected dependencies, so we can assert
 * on the exact guard behavior (method allow-list, auto-pay ceiling, funds
 * short-circuit, mainnet / paid-confirmation guards) and on the side effects
 * (purchase recording, settlement tx hash) without going through the network.
 */

const TOOL: ApiToolDefinition = {
  name: "zentrixpay_call",
  description: "Pay-per-call tool",
  method: "POST",
  path: "/v1/call",
  priceUsdc: 0.05,
  maxAutoPayUsdc: 0.1,
};

function makeDeps(overrides: Partial<ApiToolDeps> = {}): ApiToolDeps {
  const deps: ApiToolDeps = {
    fetch: vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "application/json" }),
      json: async () => ({ result: "ok" }),
      text: async () => JSON.stringify({ result: "ok" }),
    })) as unknown as ApiToolDeps["fetch"],
    getBalanceUsdc: vi.fn(async () => 1),
    pay: vi.fn(async () => ({ txHash: "0xsettlement" })),
    recordPurchase: vi.fn(async () => undefined),
    isMainnet: false,
    confirmPaidCall: undefined,
    ...overrides,
  };
  return deps;
}

describe("createApiToolHandler / zentrixpay_call", () => {
  it("rejects a method not allowed by the API", async () => {
    const deps = makeDeps();
    const handler = createApiToolHandler(TOOL, deps);

    const result = await handler({ method: "DELETE" });

    expect(result.isError).toBe(true);
    expect(String(result.content)).toMatch(/method/i);
    expect(deps.fetch).not.toHaveBeenCalled();
    expect(deps.pay).not.toHaveBeenCalled();
    expect(deps.recordPurchase).not.toHaveBeenCalled();
  });

  it("rejects a price above the maxAutoPayUsdc ceiling", async () => {
    const deps = makeDeps();
    const handler = createApiToolHandler(
      { ...TOOL, priceUsdc: 0.5, maxAutoPayUsdc: 0.1 },
      deps,
    );

    const result = await handler({ method: "POST" });

    expect(result.isError).toBe(true);
    expect(String(result.content)).toMatch(/ceiling|max/i);
    expect(deps.fetch).not.toHaveBeenCalled();
    expect(deps.pay).not.toHaveBeenCalled();
    expect(deps.recordPurchase).not.toHaveBeenCalled();
  });

  it("short-circuits when funds are insufficient", async () => {
    const deps = makeDeps({
      getBalanceUsdc: vi.fn(async () => 0.01),
    });
    const handler = createApiToolHandler(TOOL, deps);

    const result = await handler({ method: "POST" });

    expect(result.isError).toBe(true);
    expect(String(result.content)).toMatch(/insufficient|funds|balance/i);
    expect(deps.pay).not.toHaveBeenCalled();
    expect(deps.recordPurchase).not.toHaveBeenCalled();
  });

  it("performs a successful paid call and records the purchase with the settlement tx hash", async () => {
    const deps = makeDeps();
    const handler = createApiToolHandler(TOOL, deps);

    const result = await handler({ method: "POST", body: { foo: "bar" } });

    expect(result.isError).toBeFalsy();
    expect(deps.fetch).toHaveBeenCalledTimes(1);
    expect(deps.pay).toHaveBeenCalledTimes(1);
    expect(deps.recordPurchase).toHaveBeenCalledTimes(1);

    const purchaseArg = (deps.recordPurchase as ReturnType<typeof vi.fn>).mock
      .calls[0][0];
    expect(purchaseArg).toMatchObject({
      tool: "zentrixpay_call",
      txHash: "0xsettlement",
    });
  });

  it("does not charge or record a purchase when the upstream call fails (>=400)", async () => {
    const deps = makeDeps({
      fetch: vi.fn(async () => ({
        ok: false,
        status: 500,
        headers: new Headers({ "content-type": "application/json" }),
        json: async () => ({ error: "boom" }),
        text: async () => JSON.stringify({ error: "boom" }),
      })) as unknown as ApiToolDeps["fetch"],
    });
    const handler = createApiToolHandler(TOOL, deps);

    const result = await handler({ method: "POST" });

    expect(result.isError).toBe(true);
    expect(deps.pay).not.toHaveBeenCalled();
    expect(deps.recordPurchase).not.toHaveBeenCalled();
  });

  it("rejects unknown arguments", async () => {
    const deps = makeDeps();
    const handler = createApiToolHandler(TOOL, deps);

    const result = await handler({ method: "POST", bogus: true });

    expect(result.isError).toBe(true);
    expect(String(result.content)).toMatch(/unknown|argument|unexpected/i);
    expect(deps.fetch).not.toHaveBeenCalled();
    expect(deps.pay).not.toHaveBeenCalled();
  });

  it("blocks paid calls on mainnet without explicit confirmation", async () => {
    const deps = makeDeps({ isMainnet: true });
    const handler = createApiToolHandler(TOOL, deps);

    const result = await handler({ method: "POST" });

    expect(result.isError).toBe(true);
    expect(String(result.content)).toMatch(/mainnet|confirm/i);
    expect(deps.pay).not.toHaveBeenCalled();
    expect(deps.recordPurchase).not.toHaveBeenCalled();
  });

  it("blocks paid calls when the paid-confirmation guard rejects", async () => {
    const confirmPaidCall = vi.fn(async () => false);
    const deps = makeDeps({ isMainnet: true, confirmPaidCall });
    const handler = createApiToolHandler(TOOL, deps);

    const result = await handler({ method: "POST" });

    expect(result.isError).toBe(true);
    expect(confirmPaidCall).toHaveBeenCalled();
    expect(deps.pay).not.toHaveBeenCalled();
    expect(deps.recordPurchase).not.toHaveBeenCalled();
  });

  it("allows a paid call on mainnet once the paid-confirmation guard approves", async () => {
    const confirmPaidCall = vi.fn(async () => true);
    const deps = makeDeps({ isMainnet: true, confirmPaidCall });
    const handler = createApiToolHandler(TOOL, deps);

    const result = await handler({ method: "POST" });

    expect(result.isError).toBeFalsy();
    expect(confirmPaidCall).toHaveBeenCalled();
    expect(deps.pay).toHaveBeenCalledTimes(1);
    expect(deps.recordPurchase).toHaveBeenCalledTimes(1);
  });
});