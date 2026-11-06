import { describe, expect, it } from "vitest";
import { LIVE_CONFIRM_PHRASE, readTradingConfig } from "./config";
import {
  floorToStep,
  gateOrder,
  prepareAlpacaOrder,
  prepareBinanceOrder,
  type BinanceSymbolInfo,
  type OrderRequest,
} from "./orders";

const now = 1_000_000;
const base: OrderRequest = {
  provider: "binance",
  venue: "testnet",
  symbol: "BTCUSDT",
  side: "buy",
  type: "market",
  qty: 0.01,
  stop: 99_000,
  target: 103_000,
  clientOrderId: "abcdefgh1",
};
const ok = (over: Partial<OrderRequest> = {}, cfgEnv: Record<string, string> = {}) =>
  gateOrder({
    req: { ...base, ...over },
    cfg: readTradingConfig(cfgEnv),
    refPrice: 100_000,
    dataTs: now - 1000,
    risk: { equity: 100_000, openPositions: 0, realizedTodayPnl: 0 },
    now,
  });

describe("gateOrder", () => {
  it("approves a compliant testnet order", () => {
    const r = ok();
    expect(r.blocked).toEqual([]);
    expect(r.ok).toBe(true);
  });
  it("blocks live by default even with confirmation", () => {
    const r = ok({ venue: "live", confirmLive: LIVE_CONFIRM_PHRASE });
    expect(r.ok).toBe(false);
    expect(r.blocked.join()).toMatch(/LIVE_TRADING_ENABLED/);
  });
  it("blocks live without the confirmation phrase even when enabled", () => {
    const r = ok(
      { venue: "live" },
      { LIVE_TRADING_ENABLED: "true", BINANCE_LIVE_TRADING_ENABLED: "true" },
    );
    expect(r.ok).toBe(false);
    expect(r.blocked.join()).toMatch(/confirmation phrase/);
  });
  it("allows live only with config + confirmation + passing risk", () => {
    const r = ok(
      { venue: "live", confirmLive: LIVE_CONFIRM_PHRASE },
      { LIVE_TRADING_ENABLED: "true", BINANCE_LIVE_TRADING_ENABLED: "true" },
    );
    expect(r.ok).toBe(true);
  });
  it("risk engine veto cannot be bypassed by live config", () => {
    const r = ok(
      { venue: "live", qty: 5, confirmLive: LIVE_CONFIRM_PHRASE },
      { LIVE_TRADING_ENABLED: "true", BINANCE_LIVE_TRADING_ENABLED: "true" },
    );
    expect(r.ok).toBe(false);
    expect(r.blocked.join()).toMatch(/Risk ≤/);
  });
  it("kill switch blocks everything", () => {
    expect(ok({}, { TRADING_KILL_SWITCH: "true" }).ok).toBe(false);
  });
  it("rejects stale data", () => {
    const r = gateOrder({
      req: base,
      cfg: readTradingConfig({}),
      refPrice: 100_000,
      dataTs: now - 10 * 60_000,
      risk: { equity: 100_000, openPositions: 0, realizedTodayPnl: 0 },
      now,
    });
    expect(r.blocked.join()).toMatch(/Price data fresh/);
  });
  it("rejects wrong venue/provider pairs and bad idempotency keys", () => {
    expect(ok({ provider: "alpaca", venue: "testnet" }).ok).toBe(false);
    expect(ok({ provider: "binance", venue: "paper" }).ok).toBe(false);
    expect(ok({ clientOrderId: "x" }).ok).toBe(false);
  });
  it("limit order uses limit price as entry and requires it", () => {
    expect(ok({ type: "limit" }).ok).toBe(false);
    expect(ok({ type: "limit", limitPrice: 100_000 }).entry).toBe(100_000);
  });
  it("paper venue is unavailable when ALPACA_PAPER=false", () => {
    expect(ok({ provider: "alpaca", venue: "paper" }, { ALPACA_PAPER: "false" }).ok).toBe(false);
  });
});

const info: BinanceSymbolInfo = {
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
};
describe("exchange precision", () => {
  it("floorToStep avoids float noise", () => {
    expect(floorToStep(0.123456789, "0.00001")).toBe("0.12345");
    expect(floorToStep(0.3, "0.1")).toBe("0.3");
    expect(floorToStep(5, "1")).toBe("5");
  });
  it("rounds qty/price and checks notional", () => {
    const p = prepareBinanceOrder(info, "buy", "limit", 0.0123456, 100000.129, 100000);
    expect(p).toMatchObject({ ok: true, qty: "0.01234", price: "100000.12" });
  });
  it("rejects below min notional and non-trading symbols", () => {
    expect(prepareBinanceOrder(info, "buy", "market", 0.00001, undefined, 100).ok).toBe(false);
    expect(
      prepareBinanceOrder({ ...info, status: "BREAK" }, "buy", "market", 1, undefined, 100).ok,
    ).toBe(false);
  });
  it("alpaca: whole shares for non-fractionable, rejects untradable", () => {
    expect(
      prepareAlpacaOrder(
        { symbol: "X", status: "active", tradable: true, fractionable: false },
        2.7,
      ),
    ).toMatchObject({ ok: true, qty: "2" });
    expect(
      prepareAlpacaOrder(
        { symbol: "X", status: "active", tradable: true, fractionable: false },
        0.5,
      ).ok,
    ).toBe(false);
    expect(prepareAlpacaOrder({ symbol: "X", status: "active", tradable: false }, 1).ok).toBe(
      false,
    );
    expect(prepareAlpacaOrder(null, 1).ok).toBe(false);
  });
});
