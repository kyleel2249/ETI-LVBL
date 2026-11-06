import type { Candle } from "./types";
import { assessCandles } from "./quality";

export const FORECAST_MODEL = "bootstrap-ewma-v1";

export type Forecast = {
  model: string;
  horizonBars: number;
  asOf: number; // timestamp of last candle used
  lastPrice: number;
  sims: number;
  /** Per-step uncertainty bands (step 1..H). */
  bands: { step: number; p5: number; p25: number; p50: number; p75: number; p95: number }[];
  final: { p5: number; p25: number; p50: number; p75: number; p95: number };
  probUp: number;
  expectedVolPct: number; // 1-sigma move over the horizon, in %
  scenarios: { name: "bear" | "base" | "bull"; probability: number; price: number }[];
  /** Entry/exit planning from ATR; probabilities come from simulated paths, not assertions. */
  plan: {
    side: "long";
    entry: number;
    stop: number;
    target: number;
    rewardRisk: number;
    probTargetBeforeStop: number;
    probStopBeforeTarget: number;
    probNeither: number;
  };
  assumptions: string[];
  limitations: string[];
};

export type ForecastOptions = {
  horizonBars: number;
  sims?: number;
  seed?: number;
  atrMult?: number;
  rewardRisk?: number;
  interval?: string;
};
export type ForecastResult = { ok: true; forecast: Forecast } | { ok: false; reason: string };

/** Deterministic PRNG so a forecast is reproducible from its inputs. */
export function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const quantile = (sorted: number[], q: number) => {
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
};

export function atr(c: Candle[], n = 14) {
  if (c.length < n + 1) return 0;
  let sum = 0;
  for (let i = c.length - n; i < c.length; i++) {
    const k = c[i]!,
      p = c[i - 1]!;
    sum += Math.max(k.h - k.l, Math.abs(k.h - p.c), Math.abs(k.l - p.c));
  }
  return sum / n;
}

/**
 * Probabilistic forecast: standardized-residual bootstrap scaled by EWMA volatility.
 * Output is a distribution, not a point prediction. Refuses to run on poor data.
 */
export function forecast(candles: Candle[], o: ForecastOptions): ForecastResult {
  const H = Math.max(1, Math.min(Math.floor(o.horizonBars), 200));
  if (candles.length < 60)
    return { ok: false, reason: `Need at least 60 candles, have ${candles.length}` };
  const q = assessCandles(candles, o.interval ?? "1h", candles.at(-1)!.t + 1); // freshness judged by the caller
  if (q.issues.some((i) => /malformed|duplicate/.test(i)))
    return { ok: false, reason: `Data integrity problem: ${q.issues.join(", ")}` };

  const closes = candles.map((k) => k.c);
  const rets: number[] = [];
  for (let i = 1; i < closes.length; i++) rets.push(Math.log(closes[i]! / closes[i - 1]!));
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  // EWMA variance (lambda 0.94, RiskMetrics) to get the current volatility level.
  const lambda = 0.94;
  let v = rets.slice(0, 20).reduce((a, r) => a + (r - mean) ** 2, 0) / 20;
  const vars: number[] = [];
  for (const r of rets) {
    v = lambda * v + (1 - lambda) * (r - mean) ** 2;
    vars.push(v);
  }
  const sigmaNow = Math.sqrt(vars.at(-1)!);
  if (!(sigmaNow > 0))
    return { ok: false, reason: "Volatility is zero; cannot form a distribution" };
  const z = rets
    .map((r, i) => (r - mean) / Math.sqrt(vars[Math.max(0, i - 1)]!))
    .filter(Number.isFinite);
  // Drift is shrunk to zero: sample means are far too noisy to forecast direction.
  const drift = 0;

  const last = closes.at(-1)!;
  const a = atr(candles) || last * sigmaNow;
  const mult = o.atrMult ?? 1.5;
  const rr = o.rewardRisk ?? 2;
  const stop = last - mult * a;
  const target = last + mult * rr * a;

  const sims = Math.max(200, Math.min(o.sims ?? 1000, 5000));
  const rand = mulberry32(o.seed ?? 12345);
  const stepPrices: number[][] = Array.from({ length: H }, () => []);
  let up = 0,
    tHit = 0,
    sHit = 0;
  const finals: number[] = [];
  for (let s = 0; s < sims; s++) {
    let p = last,
      sv = sigmaNow ** 2,
      state = 0; // 0 neither, 1 target first, -1 stop first
    for (let h = 0; h < H; h++) {
      const e = z[Math.floor(rand() * z.length)]!;
      const r = drift + Math.sqrt(sv) * e;
      p *= Math.exp(r);
      sv = lambda * sv + (1 - lambda) * r * r;
      stepPrices[h]!.push(p);
      if (state === 0) {
        if (p >= target) state = 1;
        else if (p <= stop) state = -1;
      }
    }
    finals.push(p);
    if (p > last) up++;
    if (state === 1) tHit++;
    else if (state === -1) sHit++;
  }
  const bands = stepPrices.map((arr, i) => {
    const s = arr.sort((x, y) => x - y);
    return {
      step: i + 1,
      p5: quantile(s, 0.05),
      p25: quantile(s, 0.25),
      p50: quantile(s, 0.5),
      p75: quantile(s, 0.75),
      p95: quantile(s, 0.95),
    };
  });
  const fs = [...finals].sort((x, y) => x - y);
  const sigmaH = sigmaNow * Math.sqrt(H);
  const bull = fs.filter((p) => Math.log(p / last) > 0.5 * sigmaH);
  const bear = fs.filter((p) => Math.log(p / last) < -0.5 * sigmaH);
  const base = fs.filter((p) => Math.abs(Math.log(p / last)) <= 0.5 * sigmaH);
  const med = (x: number[]) => (x.length ? quantile(x, 0.5) : last);

  return {
    ok: true,
    forecast: {
      model: FORECAST_MODEL,
      horizonBars: H,
      asOf: candles.at(-1)!.t,
      lastPrice: last,
      sims,
      bands,
      final: {
        p5: quantile(fs, 0.05),
        p25: quantile(fs, 0.25),
        p50: quantile(fs, 0.5),
        p75: quantile(fs, 0.75),
        p95: quantile(fs, 0.95),
      },
      probUp: up / sims,
      expectedVolPct: sigmaH * 100,
      scenarios: [
        { name: "bear", probability: bear.length / sims, price: med(bear) },
        { name: "base", probability: base.length / sims, price: med(base) },
        { name: "bull", probability: bull.length / sims, price: med(bull) },
      ],
      plan: {
        side: "long",
        entry: last,
        stop,
        target,
        rewardRisk: rr,
        probTargetBeforeStop: tHit / sims,
        probStopBeforeTarget: sHit / sims,
        probNeither: (sims - tHit - sHit) / sims,
      },
      assumptions: [
        "Returns are resampled from this instrument's own history (standardized by EWMA volatility)",
        "Drift assumed zero; probabilities describe dispersion, not a directional edge",
        `Seeded simulation (${sims} paths) — reproducible`,
      ],
      limitations: [
        "Cannot anticipate news, regime breaks or liquidity gaps",
        "Probabilities are model estimates; check the validation status before relying on them",
        "Entry/stop/target zones are ATR-based planning aids, not predicted turning points",
      ],
    },
  };
}

/** Stable identity for an immutable forecast record. */
export const forecastKey = (
  symbol: string,
  interval: string,
  f: Pick<Forecast, "asOf" | "model" | "horizonBars">,
) => `${symbol}:${interval}:${f.model}:h${f.horizonBars}:${f.asOf}`;

export type ForecastScore = {
  realized: number | null;
  inside90: boolean | null;
  inside50: boolean | null;
  directionCorrect: boolean | null;
  errorPct: number | null;
  due: number;
};

/** Score a stored forecast against candles that have arrived since (null until its horizon has elapsed). */
export function scoreForecast(
  f: Pick<Forecast, "asOf" | "horizonBars" | "lastPrice" | "final" | "probUp">,
  candles: Candle[],
  stepMs: number,
): ForecastScore {
  const due = f.asOf + f.horizonBars * stepMs;
  const c = candles.find((k) => k.t >= due && k.t < due + stepMs) ?? null;
  if (!c)
    return {
      realized: null,
      inside90: null,
      inside50: null,
      directionCorrect: null,
      errorPct: null,
      due,
    };
  const y = c.c;
  return {
    realized: y,
    due,
    inside90: y >= f.final.p5 && y <= f.final.p95,
    inside50: y >= f.final.p25 && y <= f.final.p75,
    directionCorrect: f.probUp > 0.5 === y > f.lastPrice,
    errorPct: ((y - f.final.p50) / f.final.p50) * 100,
  };
}
