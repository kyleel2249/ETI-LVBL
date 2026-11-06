import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { defaultVenue, liveAllowed, readTradingConfig } from "./config";
import { fetchAllMacro } from "./fred.server";
import { runtimeEnv } from "./runtime-env";
import { analyzeMacro, type MacroSnapshot } from "./macro";
import type { OrderRequest } from "./orders";
import * as alpaca from "./providers/alpaca.server";
import * as binance from "./providers/binance.server";
import { breakerState } from "./providers/resilience";
import { getStore } from "./storage/index.server";
import {
  cancelStored,
  effectiveConfig,
  listLocalOrders,
  runOrder,
  setKillSwitch,
  syncOrders,
  type Ctx,
  type OrderOutcome,
} from "./trading.pipeline.server";
import { forecastKey, type Forecast } from "./forecast";

const env = () => runtimeEnv();
const ctx = async (): Promise<Ctx> => ({ env: env(), store: await getStore() });

const providerVenue = z.object({
  provider: z.enum(["alpaca", "binance"]),
  venue: z.enum(["paper", "testnet", "live"]),
});
const orderInput = providerVenue.extend({
  symbol: z.string().regex(/^[A-Za-z0-9.]{1,20}$/),
  side: z.enum(["buy", "sell"]),
  type: z.enum(["market", "limit"]),
  qty: z.number().positive().finite(),
  limitPrice: z.number().positive().finite().optional(),
  stop: z.number().positive().finite(),
  target: z.number().positive().finite(),
  clientOrderId: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/),
  confirmLive: z.string().max(40).optional(),
});
function toReq(d: z.infer<typeof orderInput>): OrderRequest {
  const { limitPrice, confirmLive, ...rest } = d;
  return {
    ...rest,
    ...(limitPrice !== undefined ? { limitPrice } : {}),
    ...(confirmLive !== undefined ? { confirmLive } : {}),
  };
}

export const getTradingStatus = createServerFn({ method: "GET" }).handler(async () => {
  const c = await ctx();
  const cfg = await effectiveConfig(c);
  const e = env();
  const store = await c.store.health();
  return {
    killSwitch: cfg.killSwitch,
    liveTradingEnabled: cfg.liveTradingEnabled,
    alpaca: {
      defaultVenue: defaultVenue(cfg, "alpaca"),
      paperKeys: !!alpaca.alpacaCreds("paper", e),
      liveKeys: !!alpaca.alpacaCreds("live", e),
      live: liveAllowed(cfg, "alpaca"),
    },
    binance: {
      defaultVenue: defaultVenue(cfg, "binance"),
      testnetKeys: !!binance.binanceCreds("testnet", e),
      liveKeys: !!binance.binanceCreds("live", e),
      live: liveAllowed(cfg, "binance"),
    },
    storage: { kind: c.store.kind, ...store, durable: c.store.kind !== "memory" },
    breakers: {
      binanceTestnet: breakerState("binance:testnet"),
      binanceLive: breakerState("binance:live"),
      alpacaPaper: breakerState("alpaca:paper"),
      alpacaLive: breakerState("alpaca:live"),
      fred: breakerState("fred"),
    },
    fredConfigured: !!e["FRED_API_KEY"],
    limits: { maxRiskPerTradePct: 1, dataMaxAgeSeconds: cfg.maxDataAgeMs / 1000 },
  };
});

export const previewOrder = createServerFn({ method: "POST" })
  .inputValidator((d: z.input<typeof orderInput>) => orderInput.parse(d))
  .handler(async ({ data }): Promise<OrderOutcome> =>
    runOrder(await ctx(), toReq(data), "preview"),
  );

export const submitOrder = createServerFn({ method: "POST" })
  .inputValidator((d: z.input<typeof orderInput>) => orderInput.parse(d))
  .handler(async ({ data }): Promise<OrderOutcome> => runOrder(await ctx(), toReq(data), "submit"));

export const cancelOrderFn = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) =>
    providerVenue.extend({ clientOrderId: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/) }).parse(d),
  )
  .handler(async ({ data }) =>
    cancelStored(await ctx(), data.provider, data.venue, data.clientOrderId),
  );

export const syncVenue = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) => providerVenue.parse(d))
  .handler(async ({ data }) => syncOrders(await ctx(), data.provider, data.venue));

export const setKill = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) => z.object({ enabled: z.boolean() }).parse(d))
  .handler(async ({ data }) => {
    await setKillSwitch(await ctx(), data.enabled);
    return { killSwitch: data.enabled };
  });

/** Account, positions/balances and locally tracked orders for one provider/venue. Read-only. */
export const getVenueState = createServerFn({ method: "GET" })
  .inputValidator((d: unknown) => providerVenue.parse(d))
  .handler(async ({ data }) => {
    const c = await ctx();
    const orders = await listLocalOrders(c, data.provider, data.venue);
    try {
      if (data.provider === "binance") {
        if (data.venue === "paper")
          return { ok: false as const, error: "Binance has no paper venue", orders };
        const creds = binance.binanceCreds(data.venue, c.env);
        if (!creds)
          return {
            ok: false as const,
            error: `Binance ${data.venue} credentials are not configured`,
            orders,
          };
        const [account, open] = await Promise.all([
          binance.getAccount(data.venue, creds),
          binance.openOrders(data.venue, creds),
        ]);
        return {
          ok: true as const,
          equityLabel: "USDT balance",
          equity: account.balances
            .filter((b) => b.asset === "USDT")
            .reduce((a, b) => a + b.free + b.locked, 0),
          account: { canTrade: account.canTrade, type: account.accountType },
          balances: account.balances,
          positions: [],
          openOrders: open,
          orders,
        };
      }
      if (data.venue === "testnet")
        return { ok: false as const, error: "Alpaca has no testnet", orders };
      const creds = alpaca.alpacaCreds(data.venue, c.env);
      if (!creds)
        return {
          ok: false as const,
          error: `Alpaca ${data.venue} credentials are not configured`,
          orders,
        };
      const [a, positions, open] = await Promise.all([
        alpaca.getAccount(data.venue, creds),
        alpaca.getPositions(data.venue, creds),
        alpaca.listOrders(data.venue, creds, "open"),
      ]);
      return {
        ok: true as const,
        equityLabel: `${a.currency} equity`,
        equity: a.equity,
        account: {
          status: a.status,
          buyingPower: a.buyingPower,
          cash: a.cash,
          dayPnl: a.equity - a.lastEquity,
          tradingBlocked: a.tradingBlocked || a.accountBlocked,
        },
        balances: [],
        positions,
        openOrders: open,
        orders,
      };
    } catch (e) {
      return { ok: false as const, error: (e as Error).message, orders };
    }
  });

/* ---------- macro (FRED) ---------- */
export const getMacro = createServerFn({ method: "GET" }).handler(
  async (): Promise<{
    configured: boolean;
    snapshot: MacroSnapshot | null;
    errors: Record<string, string>;
  }> => {
    const key = env()["FRED_API_KEY"];
    if (!key) return { configured: false, snapshot: null, errors: {} };
    const { data, errors } = await fetchAllMacro(key);
    return {
      configured: true,
      snapshot: Object.keys(data).length ? analyzeMacro(data) : null,
      errors,
    };
  },
);

/* ---------- immutable forecast records & accuracy tracking ---------- */
const forecastInput = z.object({
  symbol: z.string().regex(/^[A-Z0-9.]{1,20}$/),
  interval: z.enum(["1m", "5m", "15m", "30m", "1h", "4h", "1d", "1w"]),
  forecast: z.any(),
});

export const saveForecast = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) => forecastInput.parse(d))
  .handler(async ({ data }) => {
    const f = data.forecast as Forecast;
    const store = await getStore();
    const id = forecastKey(data.symbol, data.interval, f);
    const created = await store.put("forecasts", id, {
      symbol: data.symbol,
      interval: data.interval,
      forecast: f,
    });
    return { id, created }; // created=false means this exact forecast already exists (records are immutable)
  });

export const listForecasts = createServerFn({ method: "GET" })
  .inputValidator((d: unknown) =>
    z
      .object({
        symbol: z.string().regex(/^[A-Z0-9.]{1,20}$/),
        interval: z.enum(["1m", "5m", "15m", "30m", "1h", "4h", "1d", "1w"]),
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    const store = await getStore();
    const rows = await store.list<{ symbol: string; interval: string; forecast: Forecast }>(
      "forecasts",
      { limit: 200 },
    );
    return rows
      .filter((r) => r.data.symbol === data.symbol && r.data.interval === data.interval)
      .map((r) => ({ id: r.id, at: r.createdAt, forecast: r.data.forecast }));
  });

/* ---------- backup ---------- */
export const exportBackup = createServerFn({ method: "GET" }).handler(async () => {
  const store = await getStore();
  const records = await store.exportAll();
  return {
    exportedAt: Date.now(),
    kind: store.kind,
    count: records.length,
    json: JSON.stringify(records),
  };
});

export const getReadTradingConfig = createServerFn({ method: "GET" }).handler(async () =>
  readTradingConfig(env()),
);
