import { forecast, type ForecastOptions } from "./forecast";
import type { Candle } from "./types";

export type WalkForward = {
  origins: number;
  horizonBars: number;
  coverage90: number; // share of outcomes inside p5..p95 (nominal 0.90)
  coverage50: number; // inside p25..p75 (nominal 0.50)
  directionalHitRate: number; // P(up) > 0.5 matched the realized sign
  /** Mean pinball loss across the 5 reported quantiles (lower is better). */
  meanPinball: number;
  drift: { early90: number; late90: number; flagged: boolean };
  status: "validated" | "miscalibrated" | "unvalidated";
  notes: string[];
};

const pinball = (y: number, q: number, tau: number) =>
  y >= q ? tau * (y - q) : (1 - tau) * (q - y);

/**
 * Rolling-origin, out-of-sample evaluation: each forecast only sees candles up to its origin;
 * it is scored against what actually happened `horizonBars` later.
 */
export function walkForward(
  candles: Candle[],
  o: ForecastOptions & { minTrain?: number; step?: number },
): WalkForward {
  const H = o.horizonBars;
  const minTrain = o.minTrain ?? 120;
  const step = o.step ?? Math.max(1, Math.floor(H / 2));
  const results: OriginResult[] = [];
  for (let t = minTrain; t + H < candles.length; t += step) {
    const r = forecast(candles.slice(0, t + 1), { ...o, sims: o.sims ?? 300 });
    if (!r.ok) continue;
    const f = r.forecast;
    const y = candles[t + H]!.c;
    const taus: [number, number][] = [
      [0.05, f.final.p5],
      [0.25, f.final.p25],
      [0.5, f.final.p50],
      [0.75, f.final.p75],
      [0.95, f.final.p95],
    ];
    results.push({
      in90: y >= f.final.p5 && y <= f.final.p95,
      in50: y >= f.final.p25 && y <= f.final.p75,
      hit: f.probUp > 0.5 === y > f.lastPrice,
      loss: taus.reduce((a, [tau, q]) => a + pinball(y, q, tau), 0) / taus.length / f.lastPrice,
    });
  }
  return summarizeWalkForward(results, H);
}

export type OriginResult = { in90: boolean; in50: boolean; hit: boolean; loss: number };

/** Pure scoring of out-of-sample results (exported so drift/calibration logic is directly testable). */
export function summarizeWalkForward(results: OriginResult[], H: number): WalkForward {
  const n = results.length;
  const rate = (xs: boolean[]) => (xs.length ? xs.filter(Boolean).length / xs.length : 0);
  const third = Math.max(1, Math.floor(n / 3));
  const early = results.slice(0, n - third).map((r) => r.in90);
  const late = results.slice(n - third).map((r) => r.in90);
  const early90 = rate(early),
    late90 = rate(late);
  const c90 = rate(results.map((r) => r.in90));
  const c50 = rate(results.map((r) => r.in50));
  const notes: string[] = [];
  let status: WalkForward["status"] = "unvalidated";
  if (n < 30)
    notes.push(
      `Only ${n} out-of-sample forecasts; at least 30 are needed before any reliability claim.`,
    );
  else if (Math.abs(c90 - 0.9) <= 0.1 && Math.abs(c50 - 0.5) <= 0.15) {
    status = "validated";
    notes.push(
      "Interval coverage is close to nominal. This validates dispersion calibration only — not trading profitability.",
    );
  } else {
    status = "miscalibrated";
    notes.push(
      `Coverage ${(c90 * 100).toFixed(0)}% vs nominal 90% — intervals are ${c90 < 0.9 ? "too narrow" : "too wide"}.`,
    );
  }
  const flagged = n >= 30 && Math.abs(late90 - early90) > 0.15;
  if (flagged) notes.push("Model drift: recent coverage differs materially from earlier coverage.");
  return {
    origins: n,
    horizonBars: H,
    coverage90: c90,
    coverage50: c50,
    directionalHitRate: rate(results.map((r) => r.hit)),
    meanPinball: n ? results.reduce((a, r) => a + r.loss, 0) / n : NaN,
    drift: { early90, late90, flagged },
    status,
    notes,
  };
}

export type StrategyBacktest = {
  trades: number;
  winRate: number;
  totalReturnPct: number;
  maxDrawdownPct: number;
  buyHoldPct: number;
  inSample: { returnPct: number; trades: number };
  outOfSample: { returnPct: number; trades: number };
  decay: boolean;
  notes: string[];
};

/** Long-only SMA crossover with fees and slippage; 70/30 in/out-of-sample split. */
export function backtestSma(
  c: Candle[],
  o: { fast?: number; slow?: number; feeBps?: number; slipBps?: number; split?: number } = {},
): StrategyBacktest {
  const fast = o.fast ?? 20,
    slow = o.slow ?? 50;
  const cost = ((o.feeBps ?? 10) + (o.slipBps ?? 5)) / 1e4; // per side
  const split = Math.floor(c.length * (o.split ?? 0.7));
  const sma = (i: number, n: number) => {
    let s = 0;
    for (let k = i - n + 1; k <= i; k++) s += c[k]!.c;
    return s / n;
  };
  let eq = 1,
    peak = 1,
    maxDd = 0,
    inPos = false,
    entry = 0,
    wins = 0,
    trades = 0;
  let eqIS = 1,
    eqOOS = 1,
    tIS = 0,
    tOOS = 0;
  const apply = (i: number, mult: number) => {
    eq *= mult;
    if (i < split) eqIS *= mult;
    else eqOOS *= mult;
    peak = Math.max(peak, eq);
    maxDd = Math.max(maxDd, (peak - eq) / peak);
  };
  for (let i = slow; i < c.length - 1; i++) {
    const want = sma(i, fast) > sma(i, slow); // signal at close i, executed at close i+1 (no look-ahead)
    const px = c[i + 1]!.c;
    if (inPos) apply(i, px / c[i]!.c);
    if (want && !inPos) {
      inPos = true;
      entry = px * (1 + cost);
      apply(i, 1 - cost);
    } else if (!want && inPos) {
      inPos = false;
      const ex = px * (1 - cost);
      apply(i, 1 - cost);
      trades++;
      if (i < split) tIS++;
      else tOOS++;
      if (ex > entry) wins++;
    }
  }
  const bh = (c.at(-1)!.c / c[slow]!.c - 1) * 100;
  const isRet = (eqIS - 1) * 100,
    oosRet = (eqOOS - 1) * 100;
  const decay = trades >= 6 && isRet > 0 && oosRet < isRet * 0.25;
  const notes: string[] = [];
  if (trades < 10) notes.push(`Only ${trades} trades — results are statistically weak.`);
  if (decay) notes.push("Strategy decay: out-of-sample return is far below in-sample return.");
  return {
    trades,
    winRate: trades ? wins / trades : 0,
    totalReturnPct: (eq - 1) * 100,
    maxDrawdownPct: maxDd * 100,
    buyHoldPct: bh,
    inSample: { returnPct: isRet, trades: tIS },
    outOfSample: { returnPct: oosRet, trades: tOOS },
    decay,
    notes,
  };
}
