import type { Candle } from "./types";

export type QualityReport = { score: number; issues: string[]; stale: boolean; count: number };

export const INTERVAL_MS: Record<string, number> = {
  "1m": 6e4,
  "3m": 1.8e5,
  "5m": 3e5,
  "15m": 9e5,
  "30m": 1.8e6,
  "1h": 3.6e6,
  "2h": 7.2e6,
  "4h": 1.44e7,
  "6h": 2.16e7,
  "8h": 2.88e7,
  "12h": 4.32e7,
  "1d": 8.64e7,
  "3d": 2.592e8,
  "1w": 6.048e8,
  "1M": 2.592e9,
};

/** Validates OHLCV integrity, gaps, duplicates and freshness. */
export function assessCandles(c: Candle[], interval: string, now = Date.now()): QualityReport {
  const issues: string[] = [];
  const step = INTERVAL_MS[interval] ?? 3.6e6;
  let bad = 0,
    gaps = 0,
    dupes = 0;
  c.forEach((k, i) => {
    if (
      ![k.o, k.h, k.l, k.c, k.v].every(Number.isFinite) ||
      k.h < Math.max(k.o, k.c) ||
      k.l > Math.min(k.o, k.c) ||
      k.l <= 0 ||
      k.v < 0
    )
      bad++;
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
  const score =
    c.length === 0 ? 0 : Math.max(0, 100 - bad * 10 - gaps * 3 - dupes * 5 - (stale ? 30 : 0));
  return { score, issues, stale, count: c.length };
}

import type { DataStatus } from "./decision";

/** Map a quality report onto the data-status vocabulary used by the council decision. */
export function dataStatusOf(q: QualityReport): DataStatus {
  if (q.count === 0) return "unavailable";
  if (q.issues.some((i) => /malformed/.test(i))) return "invalid";
  if (q.stale) return "stale";
  if (q.issues.some((i) => /gap|duplicate/.test(i))) return "incomplete";
  return "fresh";
}
