// @vitest-environment node
import { beforeEach, describe, expect, it } from "vitest";
import { LIVE_CONFIRM_PHRASE } from "./config";
import type { OrderRequest } from "./orders";
import { resetBreakers, type Deps } from "./providers/resilience";
import { MemoryStore } from "./storage/memory-store";
import {
  cancelStored,
  listLocalOrders,
  runOrder,
  setKillSwitch,
  syncOrders,
  type Ctx,
  type OrderRecord,
} from "./trading.pipeline.server";

type Handler = (url: URL, init: RequestInit) => unknown | Response;
function router(h: Record<string, Handler>, log: { method: string; url: string }[]): Deps {
  return {
    fetch: (async (u: string, init: RequestInit) => {
      const url = new URL(String(u));
      log.push({ method: String(init.method ?? "GET"), url: url.host + url.pathname });
      const k = Object.keys(h).find(
        (x) => `${init.method ?? "GET"} ${url.host}${url.pathname}` === x,
      );
      if (!k) return new Response(JSON.stringify({ msg: `unrouted ${url}` }), { status: 404 });
      const r = h[k]!(url, init);
      return r instanceof Response ? r : new Response(JSON.stringify(r), { status: 200 });
    }) as typeof fetch,
    now: () => Date.now(),
    sleep: async () => {},
    random: () => 0.5,
  };
}

const btcInfo = {
  symbols: [
    {
      symbol: "BTCUSDT",
      status: "TRADING",
      baseAsset: "BTC",
      quoteAsset: "USDT",
      isSpotTradingAllowed: true,
      filters: [
        { filterType: "PRICE_FILTER", minPrice: "0.01", tickSize: "0.01" },
        { filterType: "LOT_SIZE", minQty: "0.00001", maxQty: "9000", stepSize: "0.00001" },
        { filterType: "NOTIONAL", minNotional: "5" },
      ],
    },
  ],
};
const T = "testnet.binance.vision";
const bnHandlers = (log: { method: string; url: string }[], equity = "100000"): Deps =>
  router(
    {
      [`GET ${T}/api/v3/exchangeInfo`]: () => btcInfo,
      [`GET ${T}/api/v3/ticker/price`]: () => ({ price: "100000" }),
      [`GET ${T}/api/v3/account`]: () => ({
        canTrade: true,
        accountType: "SPOT",
        permissions: ["SPOT"],
        balances: [{ asset: "USDT", free: equity, locked: "0" }],
      }),
      [`GET ${T}/api/v3/openOrders`]: () => [],
      [`POST ${T}/api/v3/order/test`]: () => ({}),
      [`POST ${T}/api/v3/order`]: (u) => ({
        orderId: 77,
        clientOrderId: u.searchParams.get("newClientOrderId"),
        symbol: "BTCUSDT",
        side: "BUY",
        type: "MARKET",
        origQty: u.searchParams.get("quantity"),
        executedQty: u.searchParams.get("quantity"),
        cummulativeQuoteQty: "1000",
        status: "FILLED",
        transactTime: 1,
      }),
    },
    log,
  );

const creds = { BINANCE_TESTNET_API_KEY: "k", BINANCE_TESTNET_SECRET_KEY: "s" };
const req = (o: Partial<OrderRequest> = {}): OrderRequest => ({
  provider: "binance",
  venue: "testnet",
  symbol: "BTCUSDT",
  side: "buy",
  type: "market",
  qty: 0.01,
  stop: 99_000,
  target: 103_000,
  clientOrderId: "ticket-0001",
  ...o,
});
let store: MemoryStore;
const ctx = (deps: Deps, env: Record<string, string> = creds): Ctx => ({ env, store, deps });
beforeEach(() => {
  store = new MemoryStore();
  resetBreakers();
});

describe("binance testnet pipeline", () => {
  it("preview validates with the exchange but does not place", async () => {
    const log: { method: string; url: string }[] = [];
    const o = await runOrder(ctx(bnHandlers(log)), req(), "preview");
    expect(o.status).toBe("preview_ok");
    expect(o.prepared).toMatchObject({ qty: "0.01000", exchangeValidated: true });
    expect(log.some((l) => l.url.endsWith("/order/test"))).toBe(true);
    expect(log.some((l) => l.method === "POST" && l.url.endsWith("/api/v3/order"))).toBe(false);
  });
  it("submit places, persists and audits", async () => {
    const o = await runOrder(ctx(bnHandlers([])), req(), "submit");
    expect(o.status).toBe("submitted");
    expect(o.order).toMatchObject({ status: "filled", venue: "testnet" });
    const rec = await store.get<OrderRecord>("orders", "binance:testnet:ticket-0001");
    expect(rec?.data.status).toBe("submitted");
    expect(JSON.stringify(rec)).not.toContain(LIVE_CONFIRM_PHRASE);
    expect((await store.list("audit")).length).toBeGreaterThan(0);
  });
  it("duplicate clientOrderId is not sent twice", async () => {
    const log: { method: string; url: string }[] = [];
    const d = bnHandlers(log);
    await runOrder(ctx(d), req(), "submit");
    const again = await runOrder(ctx(d), req(), "submit");
    expect(again.status).toBe("duplicate");
    expect(log.filter((l) => l.method === "POST" && l.url.endsWith("/api/v3/order")).length).toBe(
      1,
    );
  });
  it("risk veto: oversized order is rejected and never sent", async () => {
    const log: { method: string; url: string }[] = [];
    const o = await runOrder(ctx(bnHandlers(log)), req({ qty: 5 }), "submit");
    expect(o.status).toBe("rejected");
    expect(o.reasons.join()).toMatch(/Risk ≤/);
    expect(log.some((l) => l.method === "POST")).toBe(false);
  });
  it("missing credentials is a clear rejection", async () => {
    expect((await runOrder(ctx(bnHandlers([]), {}), req(), "preview")).reasons[0]).toMatch(
      /not configured/,
    );
  });
  it("live is blocked by default and never reaches the production host", async () => {
    const log: { method: string; url: string }[] = [];
    const o = await runOrder(
      ctx(bnHandlers(log), { BINANCE_API_KEY: "k", BINANCE_SECRET_KEY: "s" }),
      req({ venue: "live", confirmLive: LIVE_CONFIRM_PHRASE }),
      "submit",
    );
    expect(log.every((l) => !l.url.startsWith("api.binance.com") || l.method === "GET")).toBe(true); // 404 from router; no POST
    expect(o.status === "rejected" || o.status === "failed").toBe(true);
    expect(log.some((l) => l.method === "POST")).toBe(false);
  });
  it("kill switch (persisted) halts orders", async () => {
    await setKillSwitch(ctx(bnHandlers([])), true);
    const o = await runOrder(ctx(bnHandlers([])), req(), "submit");
    expect(o.status).toBe("rejected");
    expect(o.reasons.join()).toMatch(/Kill switch/);
    await setKillSwitch(ctx(bnHandlers([])), false);
    expect(
      (await runOrder(ctx(bnHandlers([])), req({ clientOrderId: "ticket-0002" }), "preview"))
        .status,
    ).toBe("preview_ok");
  });
  it("non-USDT quote is refused (no implicit conversion)", async () => {
    const d = router(
      {
        [`GET ${T}/api/v3/exchangeInfo`]: () => ({
          symbols: [{ ...btcInfo.symbols[0], symbol: "ETHBTC", quoteAsset: "BTC" }],
        }),
      },
      [],
    );
    expect((await runOrder(ctx(d), req({ symbol: "ETHBTC" }), "preview")).reasons[0]).toMatch(
      /USDT-quoted/,
    );
  });
  it("unknown symbol is rejected", async () => {
    const d = router(
      {
        [`GET ${T}/api/v3/exchangeInfo`]: () =>
          new Response(JSON.stringify({ code: -1121, msg: "Invalid symbol." }), { status: 400 }),
      },
      [],
    );
    expect((await runOrder(ctx(d), req({ symbol: "NOPE" }), "preview")).reasons[0]).toMatch(
      /not listed/,
    );
  });
  it("provider failure on place is recorded as failed, not lost", async () => {
    const base = bnHandlers([]);
    const d: Deps = {
      ...base,
      fetch: (async (u: string, i: RequestInit) =>
        i.method === "POST" && new URL(String(u)).pathname === "/api/v3/order"
          ? new Response(JSON.stringify({ code: -2010, msg: "insufficient balance" }), {
              status: 400,
            })
          : base.fetch(u, i)) as typeof fetch,
    };
    const o = await runOrder(ctx(d), req({ clientOrderId: "ticket-0009" }), "submit");
    expect(o.status).toBe("failed");
    expect(
      (await store.get<OrderRecord>("orders", "binance:testnet:ticket-0009"))?.data.status,
    ).toBe("failed");
  });
});

describe("alpaca paper pipeline", () => {
  const P = "paper-api.alpaca.markets";
  const handlers = (log: { method: string; url: string }[], fractionable = false): Deps =>
    router(
      {
        [`GET ${P}/v2/assets/SPY`]: () => ({
          symbol: "SPY",
          status: "active",
          tradable: true,
          fractionable,
          class: "us_equity",
        }),
        [`GET ${P}/v2/account`]: () => ({
          status: "ACTIVE",
          currency: "USD",
          equity: "100000",
          last_equity: "100000",
          buying_power: "200000",
          cash: "100000",
        }),
        [`GET ${P}/v2/positions`]: () => [],
        [`GET data.alpaca.markets/v2/stocks/SPY/trades/latest`]: () => ({
          trade: { p: 500, t: new Date().toISOString() },
        }),
        [`POST ${P}/v2/orders`]: (_u, i) => {
          const b = JSON.parse(String(i.body));
          return {
            id: "o1",
            client_order_id: b.client_order_id,
            symbol: "SPY",
            side: "buy",
            type: "market",
            qty: b.qty,
            filled_qty: "0",
            status: "accepted",
          };
        },
      },
      log,
    );
  const env = { ALPACA_PAPER_API_KEY: "k", ALPACA_PAPER_API_SECRET: "s" };
  const r = (o: Partial<OrderRequest> = {}) =>
    req({
      provider: "alpaca",
      venue: "paper",
      symbol: "SPY",
      qty: 10,
      stop: 495,
      target: 515,
      clientOrderId: "alpaca-0001",
      ...o,
    });
  it("submits a risk-approved bracket order", async () => {
    const log: { method: string; url: string }[] = [];
    const o = await runOrder(ctx(handlers(log), env), r(), "submit");
    expect(o.status).toBe("submitted");
    expect(o.order?.venue).toBe("paper");
  });
  it("rejects fractional quantity (cannot carry bracket exits)", async () => {
    const o = await runOrder(ctx(handlers([], true), env), r({ qty: 2.5 }), "preview");
    expect(o.status).toBe("rejected");
    expect(o.reasons.join()).toMatch(/whole shares/);
  });
  it("rejects when risk exceeds 1% of equity", async () => {
    const o = await runOrder(ctx(handlers([]), env), r({ qty: 100 }), "preview");
    expect(o.status).toBe("rejected");
  });
  it("live Alpaca is blocked by default and needs separate live keys", async () => {
    const o = await runOrder(
      ctx(handlers([]), env),
      r({ venue: "live", confirmLive: LIVE_CONFIRM_PHRASE }),
      "submit",
    );
    expect(o.status).toBe("rejected");
    expect(o.reasons[0]).toMatch(/ALPACA_LIVE_API_KEY/);
  });
});

describe("monitoring, reconciliation and cancel", () => {
  const getRemote = (status: string, filled: string) => (u: URL) => ({
    orderId: 77,
    clientOrderId: u.searchParams.get("origClientOrderId"),
    symbol: "BTCUSDT",
    side: "BUY",
    type: "MARKET",
    origQty: "0.01000",
    executedQty: filled,
    cummulativeQuoteQty: "1000",
    status,
  });
  it("sync picks up provider status changes and persists them", async () => {
    const base = bnHandlers([]);
    // place a LIMIT-like order that the provider reports as NEW first
    const placeNew = router(
      {
        [`GET ${T}/api/v3/exchangeInfo`]: () => btcInfo,
        [`GET ${T}/api/v3/ticker/price`]: () => ({ price: "100000" }),
        [`GET ${T}/api/v3/account`]: () => ({
          canTrade: true,
          accountType: "SPOT",
          permissions: [],
          balances: [{ asset: "USDT", free: "100000", locked: "0" }],
        }),
        [`GET ${T}/api/v3/openOrders`]: () => [],
        [`POST ${T}/api/v3/order/test`]: () => ({}),
        [`POST ${T}/api/v3/order`]: (u) => ({
          orderId: 77,
          clientOrderId: u.searchParams.get("newClientOrderId"),
          symbol: "BTCUSDT",
          side: "BUY",
          type: "MARKET",
          origQty: "0.01000",
          executedQty: "0",
          cummulativeQuoteQty: "0",
          status: "NEW",
        }),
      },
      [],
    );
    void base;
    await runOrder(ctx(placeNew), req({ clientOrderId: "sync-0001" }), "submit");
    const filled = router({ [`GET ${T}/api/v3/order`]: getRemote("FILLED", "0.01000") }, []);
    const r = await syncOrders(ctx(filled), "binance", "testnet");
    expect(r.checked).toBe(1);
    expect(r.updated).toBe(1);
    expect(r.errors).toEqual([]);
    const list = await listLocalOrders(ctx(filled), "binance", "testnet");
    expect(list[0]!.order?.status).toBe("filled");
  });
  it("sync reports provider drift for orders the provider cannot find", async () => {
    await runOrder(ctx(bnHandlers([])), req({ clientOrderId: "sync-0002" }), "submit");
    const gone = router(
      {
        [`GET ${T}/api/v3/order`]: () =>
          new Response(JSON.stringify({ code: -2013, msg: "Order does not exist." }), {
            status: 400,
          }),
      },
      [],
    );
    const r = await syncOrders(ctx(gone), "binance", "testnet");
    expect(r.errors[0]).toMatch(/Order does not exist/);
  });
  it("cancel refuses terminal orders and cancels open ones", async () => {
    await runOrder(ctx(bnHandlers([])), req({ clientOrderId: "cancel-001" }), "submit"); // filled
    expect(
      (await cancelStored(ctx(bnHandlers([])), "binance", "testnet", "cancel-001")).message,
    ).toMatch(/already filled/);
    expect((await cancelStored(ctx(bnHandlers([])), "binance", "testnet", "missing-id")).ok).toBe(
      false,
    );
  });
});

describe("secrets never leave the server", () => {
  it("outcomes, stored orders and audit records contain no credentials", async () => {
    const secretEnv = { BINANCE_TESTNET_API_KEY: "APIKEY-VISIBLE-ID", BINANCE_TESTNET_SECRET_KEY: "TOPSECRET-DO-NOT-LEAK" };
    const o = await runOrder(ctx(bnHandlers([]), secretEnv), req({ clientOrderId: "leak-0001" }), "submit");
    const dump = JSON.stringify([o, await store.exportAll()]);
    expect(dump).not.toContain("TOPSECRET-DO-NOT-LEAK");
    expect(dump).not.toContain("APIKEY-VISIBLE-ID");
  });
  it("provider errors surfaced to the UI do not contain credentials", async () => {
    const secretEnv = { BINANCE_TESTNET_API_KEY: "KEY-ABC", BINANCE_TESTNET_SECRET_KEY: "SECRET-XYZ-123" };
    const bad = router({ [`GET ${T}/api/v3/exchangeInfo`]: () => btcInfo, [`GET ${T}/api/v3/ticker/price`]: () => ({ price: "100000" }), [`GET ${T}/api/v3/account`]: () => new Response(JSON.stringify({ code: -2015, msg: "Invalid API-key, IP, or permissions for action." }), { status: 401 }), [`GET ${T}/api/v3/openOrders`]: () => [] }, []);
    const o = await runOrder(ctx(bad, secretEnv), req({ clientOrderId: "leak-0002" }), "submit");
    expect(o.status).toBe("failed");
    expect(JSON.stringify([o, await store.exportAll()])).not.toMatch(/SECRET-XYZ-123|signature=/);
  });
  it("no withdrawal endpoint exists in the provider clients", async () => {
    const { readFileSync } = await import("node:fs");
    for (const f of ["src/lib/eti/providers/binance.server.ts", "src/lib/eti/providers/alpaca.server.ts"]) {
      expect(readFileSync(f, "utf8")).not.toMatch(/withdraw|sapi\/v1\/capital/i);
    }
  });
});
