import type { Candle } from "./types";

export function sma(v: number[], n: number): (number | null)[] {
  return v.map((_, i) => (i < n - 1 ? null : v.slice(i - n + 1, i + 1).reduce((a, b) => a + b, 0) / n));
}

export function ema(v: number[], n: number): (number | null)[] {
  const k = 2 / (n + 1);
  const out: (number | null)[] = [];
  let prev: number | null = null;
  v.forEach((x, i) => {
    if (i < n - 1) return out.push(null);
    if (prev === null) prev = v.slice(0, n).reduce((a, b) => a + b, 0) / n;
    else prev = x * k + prev * (1 - k);
    out.push(prev);
  });
  return out;
}

/** Wilder RSI */
export function rsi(v: number[], n = 14): number | null {
  if (v.length <= n) return null;
  let g = 0, l = 0;
  for (let i = 1; i <= n; i++) {
    const d = v[i]! - v[i - 1]!;
    if (d >= 0) g += d; else l -= d;
  }
  g /= n; l /= n;
  for (let i = n + 1; i < v.length; i++) {
    const d = v[i]! - v[i - 1]!;
    g = (g * (n - 1) + Math.max(d, 0)) / n;
    l = (l * (n - 1) + Math.max(-d, 0)) / n;
  }
  if (l === 0) return 100;
  return 100 - 100 / (1 + g / l);
}

export function macd(v: number[]) {
  const e12 = ema(v, 12), e26 = ema(v, 26);
  const line = v.map((_, i) => (e12[i] != null && e26[i] != null ? (e12[i] as number) - (e26[i] as number) : null));
  const valid = line.filter((x): x is number => x != null);
  const sig = ema(valid, 9);
  const signal = sig.at(-1) ?? null;
  const last = valid.at(-1) ?? null;
  return { macd: last, signal, hist: last != null && signal != null ? last - signal : null };
}

export function atr(c: Candle[], n = 14): number | null {
  if (c.length <= n) return null;
  const tr = c.slice(1).map((k, i) => Math.max(k.h - k.l, Math.abs(k.h - c[i]!.c), Math.abs(k.l - c[i]!.c)));
  let a = tr.slice(0, n).reduce((x, y) => x + y, 0) / n;
  for (let i = n; i < tr.length; i++) a = (a * (n - 1) + tr[i]!) / n;
  return a;
}

/** Annualisation-free realised volatility of log returns (stdev, %) */
export function volatility(v: number[]): number | null {
  if (v.length < 3) return null;
  const r = v.slice(1).map((x, i) => Math.log(x / v[i]!));
  const m = r.reduce((a, b) => a + b, 0) / r.length;
  const s = Math.sqrt(r.reduce((a, b) => a + (b - m) ** 2, 0) / (r.length - 1));
  return s * 100;
}

export function maxDrawdown(v: number[]): number {
  let peak = -Infinity, dd = 0;
  for (const x of v) { peak = Math.max(peak, x); dd = Math.min(dd, (x - peak) / peak); }
  return dd * 100;
}

export type Snapshot = {
  last: number;
  rsi: number | null;
  macd: ReturnType<typeof macd>;
  sma20: number | null;
  sma50: number | null;
  ema200: number | null;
  atr: number | null;
  atrPct: number | null;
  volPct: number | null;
  maxDrawdownPct: number;
  trend: "up" | "down" | "sideways";
  regime: "trending" | "ranging" | "volatile";
  support: number;
  resistance: number;
  volumeZ: number | null;
};

export function snapshot(c: Candle[]): Snapshot {
  const closes = c.map((k) => k.c);
  const last = closes.at(-1) ?? 0;
  const s20 = sma(closes, 20).at(-1) ?? null;
  const s50 = sma(closes, 50).at(-1) ?? null;
  const e200 = ema(closes, 200).at(-1) ?? null;
  const a = atr(c);
  const vol = volatility(closes.slice(-50));
  const recent = c.slice(-50);
  const vols = c.slice(-50).map((k) => k.v);
  const vm = vols.reduce((x, y) => x + y, 0) / (vols.length || 1);
  const vs = Math.sqrt(vols.reduce((x, y) => x + (y - vm) ** 2, 0) / (vols.length || 1));
  const trend = s20 && s50 ? (s20 > s50 * 1.002 && last > s20 ? "up" : s20 < s50 * 0.998 && last < s20 ? "down" : "sideways") : "sideways";
  const atrPct = a && last ? (a / last) * 100 : null;
  const regime = atrPct != null && atrPct > 3 ? "volatile" : trend === "sideways" ? "ranging" : "trending";
  return {
    last, rsi: rsi(closes), macd: macd(closes), sma20: s20, sma50: s50, ema200: e200,
    atr: a, atrPct, volPct: vol, maxDrawdownPct: maxDrawdown(closes), trend, regime,
    support: Math.min(...recent.map((k) => k.l)), resistance: Math.max(...recent.map((k) => k.h)),
    volumeZ: vs ? ((vols.at(-1) ?? vm) - vm) / vs : null,
  };
}
