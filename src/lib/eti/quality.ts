import type { Candle } from "./types";

export type QualityReport = { score: number; issues: string[]; stale: boolean; count: number };

const INTERVAL_MS: Record<string, number> = { "1m": 6e4, "15m": 9e5, "1h": 3.6e6, "4h": 1.44e7, "1d": 8.64e7 };

/** Validates OHLCV integrity, gaps, duplicates and freshness. */
export function assessCandles(c: Candle[], interval: string, now = Date.now()): QualityReport {
  const issues: string[] = [];
  const step = INTERVAL_MS[interval] ?? 3.6e6;
  let bad = 0, gaps = 0, dupes = 0;
  c.forEach((k, i) => {
    if (![k.o, k.h, k.l, k.c, k.v].every(Number.isFinite) || k.h < Math.max(k.o, k.c) || k.l > Math.min(k.o, k.c) || k.l <= 0 || k.v < 0) bad++;
    if (i > 0) {
      const d = k.t - c[i - 1]!.t;
      if (d === 0) dupes++;
      else if (d > step * 1.5) gaps++;
    }
  });
  if (bad) issues.push(`${bad} malformed candle(s)`);
  if (gaps) issues.push(`${gaps} gap(s) in series`);
  if (dupes) issues.push(`${dupes} duplicate timestamp(s)`);
  const lastT = c.at(-1)?.t ?? 0;
  const stale = now - lastT > step * 2;
  if (stale) issues.push("data is stale");
  if (c.length === 0) issues.push("no data");
  const score = c.length === 0 ? 0 : Math.max(0, 100 - bad * 10 - gaps * 3 - dupes * 5 - (stale ? 30 : 0));
  return { score, issues, stale, count: c.length };
}
