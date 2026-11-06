import { describe, expect, it } from "vitest";
import { evaluateTrade, suggestQty } from "./risk";
import { assessCandles } from "./quality";

const ctx = { equity: 100_000, openPositions: 0, realizedTodayPnl: 0, killSwitch: false, now: 1_000_000 };
const good = { side: "buy" as const, qty: 10, entry: 100, stop: 95, target: 110, dataTs: 1_000_000 };

describe("risk engine", () => {
  it("approves a trade within all limits", () => {
    expect(evaluateTrade(good, ctx).approved).toBe(true);
  });
  it("rejects when risk exceeds 1% of equity", () => {
    expect(evaluateTrade({ ...good, qty: 300 }, ctx).approved).toBe(false); // 1500 risk = 1.5%
  });
  it("rejects reward:risk below 1.5", () => {
    expect(evaluateTrade({ ...good, target: 105 }, ctx).approved).toBe(false);
  });
  it("rejects when kill switch is on", () => {
    expect(evaluateTrade(good, { ...ctx, killSwitch: true }).approved).toBe(false);
  });
  it("rejects stale price data older than 60s", () => {
    expect(evaluateTrade({ ...good, dataTs: 1_000_000 - 61_000 }, ctx).approved).toBe(false);
  });
  it("rejects after 3% daily loss", () => {
    expect(evaluateTrade(good, { ...ctx, realizedTodayPnl: -3000 }).approved).toBe(false);
  });
  it("sizes position to 1% risk", () => {
    expect(suggestQty(100_000, 100, 95)).toBe(200);
  });
});

describe("data quality", () => {
  it("flags malformed candles", () => {
    const r = assessCandles([{ t: 0, o: 10, h: 9, l: 8, c: 10, v: 1 }], "1h", 0);
    expect(r.issues.some((i) => i.includes("malformed"))).toBe(true);
  });
});
