import { describe, expect, it } from "vitest";
import { backtestSma, summarizeWalkForward, walkForward, type OriginResult } from "./backtest";
import { forecast, forecastKey, mulberry32 } from "./forecast";
import type { Candle } from "./types";

/** Synthetic random walk with known volatility, for testing the model (never shown as market data). */
function walk(n: number, sigma = 0.01, seed = 7, start = 100, drift = 0): Candle[] {
  const r = mulberry32(seed);
  const gauss = () => Math.sqrt(-2 * Math.log(r() || 1e-9)) * Math.cos(2 * Math.PI * r());
  const out: Candle[] = [];
  let p = start;
  for (let i = 0; i < n; i++) {
    const o = p;
    p = p * Math.exp(drift + sigma * gauss());
    const hi = Math.max(o, p) * (1 + Math.abs(sigma * gauss()) * 0.3);
    const lo = Math.min(o, p) * (1 - Math.abs(sigma * gauss()) * 0.3);
    out.push({ t: 1_700_000_000_000 + i * 3_600_000, o, h: hi, l: lo, c: p, v: 100 });
  }
  return out;
}

describe("forecast", () => {
  const c = walk(300);
  it("is deterministic for the same seed and different for another", () => {
    const a = forecast(c, { horizonBars: 12, seed: 1 }),
      b = forecast(c, { horizonBars: 12, seed: 1 }),
      d = forecast(c, { horizonBars: 12, seed: 2 });
    if (!a.ok || !b.ok || !d.ok) throw new Error("forecast failed");
    expect(a.forecast.final).toEqual(b.forecast.final);
    expect(a.forecast.final.p50).not.toBe(d.forecast.final.p50);
  });
  it("quantiles are ordered and bracket the last price; probabilities are valid", () => {
    const r = forecast(c, { horizonBars: 12 });
    if (!r.ok) throw new Error(r.reason);
    const f = r.forecast;
    expect(f.final.p5).toBeLessThan(f.final.p25);
    expect(f.final.p25).toBeLessThan(f.final.p50);
    expect(f.final.p75).toBeLessThan(f.final.p95);
    expect(f.final.p5).toBeLessThan(f.lastPrice);
    expect(f.final.p95).toBeGreaterThan(f.lastPrice);
    expect(f.probUp).toBeGreaterThan(0.3);
    expect(f.probUp).toBeLessThan(0.7);
    const s = f.scenarios.reduce((a, x) => a + x.probability, 0);
    expect(s).toBeCloseTo(1, 5);
    const p = f.plan;
    expect(p.probTargetBeforeStop + p.probStopBeforeTarget + p.probNeither).toBeCloseTo(1, 5);
    expect(f.bands.length).toBe(12);
  });
  it("uncertainty widens with horizon", () => {
    const a = forecast(c, { horizonBars: 4 }),
      b = forecast(c, { horizonBars: 48 });
    if (!a.ok || !b.ok) throw new Error("fail");
    expect(b.forecast.final.p95 - b.forecast.final.p5).toBeGreaterThan(
      a.forecast.final.p95 - a.forecast.final.p5,
    );
  });
  it("refuses insufficient or corrupt data instead of guessing", () => {
    expect(forecast(c.slice(0, 30), { horizonBars: 5 }).ok).toBe(false);
    const bad = c.map((k, i) => (i === 100 ? { ...k, h: k.l - 1 } : k));
    expect(forecast(bad, { horizonBars: 5 }).ok).toBe(false);
  });
  it("record key is stable and unique per origin", () => {
    const r = forecast(c, { horizonBars: 6 });
    if (!r.ok) throw new Error("x");
    expect(forecastKey("BTCUSDT", "1h", r.forecast)).toBe(forecastKey("BTCUSDT", "1h", r.forecast));
    expect(forecastKey("BTCUSDT", "1h", r.forecast)).toContain(String(r.forecast.asOf));
  });
});

describe("walk-forward validation", () => {
  it("is well calibrated on data matching its assumptions", () => {
    const w = walkForward(walk(900, 0.01, 11), { horizonBars: 6, step: 6, sims: 300 });
    expect(w.origins).toBeGreaterThanOrEqual(30);
    expect(w.coverage90).toBeGreaterThan(0.8);
    expect(w.coverage90).toBeLessThan(0.99);
    expect(w.status).toBe("validated");
    expect(Number.isFinite(w.meanPinball)).toBe(true);
  });
  it("never claims validation with too few forecasts", () => {
    const w = walkForward(walk(200), { horizonBars: 6, step: 6 });
    expect(w.status).toBe("unvalidated");
    expect(w.notes.join()).toMatch(/at least 30/);
  });
  it("is honest that an adaptive-volatility model tracks a pure volatility shift", () => {
    const a = walk(500, 0.005, 3),
      b = walk(500, 0.04, 4, a.at(-1)!.c).map((k, i) => ({
        ...k,
        t: a.at(-1)!.t + (i + 1) * 3_600_000,
      }));
    const w = walkForward([...a, ...b], { horizonBars: 6, step: 6, sims: 200 });
    expect(w.coverage90).toBeGreaterThan(0.75); // EWMA re-scales quickly; do not overclaim failure
  });
  it("flags drift and miscalibration from out-of-sample results (scoring logic)", () => {
    const mk = (n: number, hit90: number): OriginResult[] =>
      Array.from({ length: n }, (_, i) => ({
        in90: Math.floor((i + 1) * hit90) > Math.floor(i * hit90),
        in50: i % 2 === 0,
        hit: true,
        loss: 0.01,
      }));
    const early = mk(60, 0.9),
      late = mk(30, 0.5);
    const w = summarizeWalkForward([...early, ...late], 6);
    expect(w.drift.flagged).toBe(true);
    expect(w.drift.late90).toBeLessThan(w.drift.early90);
    expect(w.status).not.toBe("validated");
    expect(w.notes.join()).toMatch(/drift/i);
    const good = summarizeWalkForward(mk(60, 0.9), 6);
    expect(good.drift.flagged).toBe(false);
  });
});

describe("strategy backtest", () => {
  it("includes costs, has no look-ahead, and reports out-of-sample separately", () => {
    const up = walk(600, 0.01, 5, 100, 0.0008);
    const r = backtestSma(up);
    expect(r.trades).toBeGreaterThan(0);
    expect(r.maxDrawdownPct).toBeGreaterThanOrEqual(0);
    expect(r.inSample.trades + r.outOfSample.trades).toBe(r.trades);
    const free = backtestSma(up, { feeBps: 0, slipBps: 0 });
    expect(free.totalReturnPct).toBeGreaterThanOrEqual(r.totalReturnPct);
  });
  it("warns that few trades are statistically weak", () => {
    expect(backtestSma(walk(120, 0.01, 9)).notes.join()).toMatch(/statistically weak|trades/);
  });
});

import { scoreForecast } from "./forecast";
import { dataStatusOf, assessCandles } from "./quality";
describe("forecast accuracy tracking and data status", () => {
  const f = {
    asOf: 0,
    horizonBars: 2,
    lastPrice: 100,
    probUp: 0.6,
    final: { p5: 90, p25: 97, p50: 101, p75: 105, p95: 112 },
  };
  const step = 3_600_000;
  it("returns null until the horizon has elapsed, then scores", () => {
    expect(
      scoreForecast(f, [{ t: step, o: 1, h: 1, l: 1, c: 100, v: 1 }], step).realized,
    ).toBeNull();
    const s = scoreForecast(f, [{ t: 2 * step, o: 1, h: 1, l: 1, c: 103, v: 1 }], step);
    expect(s).toMatchObject({
      realized: 103,
      inside90: true,
      inside50: true,
      directionCorrect: true,
    });
    expect(scoreForecast(f, [{ t: 2 * step, o: 1, h: 1, l: 1, c: 80, v: 1 }], step)).toMatchObject({
      inside90: false,
      directionCorrect: false,
    });
  });
  it("maps candle quality to data status", () => {
    const now = 10 * step;
    const k = (t: number, c = 100) => ({ t, o: c, h: c + 1, l: c - 1, c, v: 1 });
    expect(dataStatusOf(assessCandles([], "1h", now))).toBe("unavailable");
    expect(dataStatusOf(assessCandles([k(now - 20 * step)], "1h", now))).toBe("stale");
    expect(dataStatusOf(assessCandles([{ ...k(now - step), h: 1, l: 5 }], "1h", now))).toBe(
      "invalid",
    );
    expect(dataStatusOf(assessCandles([k(now - 5 * step), k(now - step)], "1h", now))).toBe(
      "incomplete",
    );
    expect(dataStatusOf(assessCandles([k(now - 2 * step), k(now - step)], "1h", now))).toBe(
      "fresh",
    );
  });
});
