// @vitest-environment node
import { beforeEach, describe, expect, it } from "vitest";
import * as alpaca from "./alpaca.server";
import * as binance from "./binance.server";
import { normalizeAlpacaOrder, normalizeBinanceOrder, reconcileOrders } from "./normalize";
import {
  BREAKER_THRESHOLD,
  ProviderError,
  backoff,
  breakerState,
  resetBreakers,
  type Deps,
} from "./resilience";

type Call = { url: string; init: RequestInit };
function deps(responses: (Response | Error)[], calls: Call[] = []): Deps {
  let i = 0;
  return {
    fetch: (async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), init });
      const r = responses[Math.min(i++, responses.length - 1)]!;
      if (r instanceof Error) throw r;
      return r.clone();
    }) as typeof fetch,
    now: () => 1_700_000_000_000,
    sleep: async () => {},
    random: () => 0.5,
  };
}
const json = (b: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(b), { status, headers });
const creds = { key: "KEY123", secret: "SUPERSECRETVALUE" };

beforeEach(() => resetBreakers());

describe("binance client", () => {
  it("signs requests, sends key header only, never puts the secret in the URL", async () => {
    const calls: Call[] = [];
    await binance.getAccount(
      "testnet",
      creds,
      deps(
        [
          json({
            canTrade: true,
            accountType: "SPOT",
            permissions: ["SPOT"],
            balances: [{ asset: "USDT", free: "100", locked: "0" }],
          }),
        ],
        calls,
      ),
    );
    const c = calls[0]!;
    expect(c.url.startsWith("https://testnet.binance.vision/api/v3/account?")).toBe(true);
    expect(c.url).toMatch(/signature=[0-9a-f]{64}/);
    expect(c.url).not.toContain(creds.secret);
    expect((c.init.headers as Record<string, string>)["X-MBX-APIKEY"]).toBe("KEY123");
  });
  it("testnet venue always targets testnet host; live targets production", () => {
    expect(binance.binanceBase("testnet")).toBe("https://testnet.binance.vision");
    expect(binance.binanceBase("live")).toBe("https://api.binance.com");
  });
  it("keeps testnet and production credentials separate", () => {
    const env = { BINANCE_API_KEY: "prodK", BINANCE_SECRET_KEY: "prodS" };
    expect(binance.binanceCreds("testnet", env)).toBeNull();
    expect(binance.binanceCreds("live", env)).toEqual({ key: "prodK", secret: "prodS" });
  });
  it("order body carries client id and FULL response type", async () => {
    const calls: Call[] = [];
    await binance.placeOrder(
      "testnet",
      creds,
      {
        symbol: "BTCUSDT",
        side: "buy",
        type: "limit",
        qty: "0.01",
        price: "50000.00",
        clientOrderId: "cid-12345",
      },
      deps(
        [
          json({
            orderId: 1,
            clientOrderId: "cid-12345",
            symbol: "BTCUSDT",
            side: "BUY",
            type: "LIMIT",
            origQty: "0.01",
            executedQty: "0",
            cummulativeQuoteQty: "0",
            status: "NEW",
            transactTime: 5,
          }),
        ],
        calls,
      ),
    );
    const u = new URL(calls[0]!.url);
    expect(calls[0]!.init.method).toBe("POST");
    expect(u.pathname).toBe("/api/v3/order");
    expect(u.searchParams.get("newClientOrderId")).toBe("cid-12345");
    expect(u.searchParams.get("timeInForce")).toBe("GTC");
  });
  it("maps Binance error JSON to a ProviderError without leaking secrets", async () => {
    const err = await binance
      .getAccount(
        "testnet",
        creds,
        deps([json({ code: -2015, msg: "Invalid API-key, IP, or permissions for action." }, 401)]),
      )
      .catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.message).toMatch(/Invalid API-key/);
    expect(String(err.message)).not.toContain(creds.secret);
  });
  it("returns null for an invalid symbol (-1121)", async () => {
    expect(
      await binance.getSymbolInfo(
        "testnet",
        "NOPE",
        deps([json({ code: -1121, msg: "Invalid symbol." }, 400)]),
      ),
    ).toBeNull();
  });
});

describe("resilience", () => {
  it("retries GET on 500 then succeeds", async () => {
    const calls: Call[] = [];
    const r = await binance.getRefPrice(
      "live",
      "BTCUSDT",
      deps([json({}, 500), json({}, 503), json({ price: "100.5" })], calls),
    );
    expect(r.price).toBe(100.5);
    expect(calls.length).toBe(3);
  });
  it("does not retry order POSTs", async () => {
    const calls: Call[] = [];
    await expect(
      binance.placeOrder(
        "testnet",
        creds,
        { symbol: "BTCUSDT", side: "buy", type: "market", qty: "1", clientOrderId: "cid-12345" },
        deps([json({}, 500)], calls),
      ),
    ).rejects.toBeInstanceOf(ProviderError);
    expect(calls.length).toBe(1);
  });
  it("opens the circuit after repeated outages and fails fast", async () => {
    const calls: Call[] = [];
    const d = deps([json({}, 500)], calls);
    for (let i = 0; i < BREAKER_THRESHOLD; i++)
      await binance.getRefPrice("live", "BTCUSDT", d).catch(() => {});
    expect(breakerState("binance:live", d.now()).open).toBe(true);
    const before = calls.length;
    const e = await binance.getRefPrice("live", "BTCUSDT", d).catch((x) => x);
    expect(e.code).toBe("CIRCUIT_OPEN");
    expect(calls.length).toBe(before);
  });
  it("does not trip the breaker on 4xx", async () => {
    for (let i = 0; i < 10; i++)
      await binance
        .getSymbolInfo("live", "X", deps([json({ code: -1100, msg: "bad" }, 400)]))
        .catch(() => {});
    expect(breakerState("binance:live").open).toBe(false);
  });
  it("network errors are retryable provider errors", async () => {
    const e = await binance
      .getRefPrice("live", "BTCUSDT", deps([new Error("boom")]))
      .catch((x) => x);
    expect(e.code).toBe("NETWORK");
  });
  it("backoff grows and is jittered within bounds", () => {
    expect(backoff(0, { random: () => 0 })).toBe(125);
    expect(backoff(3, { random: () => 1 })).toBe(2000);
    expect(backoff(10, { random: () => 1 })).toBe(8000);
  });
});

describe("alpaca client", () => {
  it("paper and live keys are separate variables", () => {
    const env = { ALPACA_PAPER_API_KEY: "pk", ALPACA_PAPER_API_SECRET: "ps" };
    expect(alpaca.alpacaCreds("paper", env)).toEqual({ key: "pk", secret: "ps" });
    expect(alpaca.alpacaCreds("live", env)).toBeNull();
    expect(alpaca.alpacaBase("paper")).toContain("paper-api");
    expect(alpaca.alpacaBase("live")).not.toContain("paper");
  });
  it("submits a native bracket with client_order_id", async () => {
    const calls: Call[] = [];
    await alpaca.submitOrder(
      "paper",
      { key: "k", secret: "s" },
      {
        symbol: "SPY",
        side: "buy",
        type: "market",
        qty: "2",
        stop: 400,
        target: 450,
        clientOrderId: "cid-12345",
        bracket: true,
      },
      deps(
        [
          json({
            id: "a1",
            client_order_id: "cid-12345",
            symbol: "SPY",
            side: "buy",
            type: "market",
            qty: "2",
            filled_qty: "0",
            status: "accepted",
            submitted_at: "2026-01-01T00:00:00Z",
          }),
        ],
        calls,
      ),
    );
    const body = JSON.parse(String(calls[0]!.init.body));
    expect(calls[0]!.url).toBe("https://paper-api.alpaca.markets/v2/orders");
    expect(body).toMatchObject({
      order_class: "bracket",
      client_order_id: "cid-12345",
      take_profit: { limit_price: "450" },
      stop_loss: { stop_price: "400" },
    });
  });
  it("auth failure message is safe and actionable", async () => {
    const e = await alpaca
      .getAccount(
        "paper",
        { key: "k", secret: "TOPSECRET" },
        deps([json({ message: "forbidden." }, 403)]),
      )
      .catch((x) => x);
    expect(e.message).toMatch(/authentication failed/);
    expect(e.message).not.toContain("TOPSECRET");
  });
  it("missing latest trade is an error, not substituted data", async () => {
    await expect(
      alpaca.getLatestTrade("paper", { key: "k", secret: "s" }, "SPY", deps([json({})])),
    ).rejects.toThrow(/No latest trade/);
  });
  it("asset 404 -> null", async () => {
    expect(
      await alpaca.getAsset(
        "paper",
        { key: "k", secret: "s" },
        "ZZZZ",
        deps([json({ message: "not found" }, 404)]),
      ),
    ).toBeNull();
  });
});

describe("normalization and reconciliation", () => {
  const b = normalizeBinanceOrder(
    {
      orderId: 9,
      clientOrderId: "c1",
      symbol: "BTCUSDT",
      side: "SELL",
      type: "MARKET",
      origQty: "2",
      executedQty: "2",
      cummulativeQuoteQty: "200",
      status: "FILLED",
    },
    "testnet",
  );
  it("binance", () =>
    expect(b).toMatchObject({
      side: "sell",
      status: "filled",
      avgFillPrice: 100,
      filledQty: 2,
      venue: "testnet",
    }));
  const a = normalizeAlpacaOrder(
    {
      id: "x",
      client_order_id: "c2",
      symbol: "SPY",
      side: "buy",
      type: "limit",
      qty: "1",
      filled_qty: "0",
      status: "partially_filled",
    },
    "paper",
  );
  it("alpaca", () => expect(a).toMatchObject({ status: "partially_filled", avgFillPrice: null }));
  it("unknown provider status is flagged unknown, never assumed filled", () => {
    expect(normalizeAlpacaOrder({ status: "weird" }, "paper").status).toBe("unknown");
  });
  it("reconciliation finds matches, drift, and orphans", () => {
    const local = [b, { ...a, status: "new" as const }, { ...b, clientOrderId: "ghost" }];
    const remote = [b, a, { ...b, clientOrderId: "extra" }];
    const r = reconcileOrders(local, remote);
    expect(r.matched).toBe(1);
    expect(r.mismatched).toEqual([
      { clientOrderId: "c2", field: "status", local: "new", remote: "partially_filled" },
    ]);
    expect(r.missingAtProvider).toEqual(["ghost"]);
    expect(r.missingLocally).toEqual(["extra"]);
  });
});
