import type { OrderBook } from "./types";

export type BookAnalytics = {
  bestBid: number;
  bestAsk: number;
  mid: number;
  spread: number;
  spreadBps: number;
  bidVolume: number;
  askVolume: number;
  /** (bid - ask) / (bid + ask) over the observed depth, -1..1. Observation, not a prediction. */
  imbalance: number;
  /** Levels whose size is >= `largeMult` x median level size. */
  largeOrders: { side: "bid" | "ask"; price: number; size: number; multipleOfMedian: number }[];
  /** Share of side volume held by the top 3 levels (0..1). */
  concentration: { bid: number; ask: number };
  /** Notional (price*size) within +/- pct of mid. */
  depthWithinPct: { pct: number; bid: number; ask: number };
};

const median = (a: number[]) => {
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length === 0 ? 0 : s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

export function analyzeBook(
  book: OrderBook,
  opts: { largeMult?: number; depthPct?: number } = {},
): BookAnalytics | null {
  const { bids, asks } = book;
  if (!bids.length || !asks.length) return null;
  const bestBid = bids[0]![0];
  const bestAsk = asks[0]![0];
  if (!(bestBid > 0) || !(bestAsk > 0) || bestAsk < bestBid) return null; // crossed/invalid book
  const mid = (bestBid + bestAsk) / 2;
  const sum = (l: [number, number][]) => l.reduce((a, [, s]) => a + s, 0);
  const bidVolume = sum(bids);
  const askVolume = sum(asks);
  const tot = bidVolume + askVolume;
  const med = median([...bids, ...asks].map(([, s]) => s));
  const mult = opts.largeMult ?? 5;
  const largeOrders = [
    ...bids.map(([price, size]) => ({ side: "bid" as const, price, size })),
    ...asks.map(([price, size]) => ({ side: "ask" as const, price, size })),
  ]
    .filter((l) => med > 0 && l.size >= mult * med)
    .map((l) => ({ ...l, multipleOfMedian: l.size / med }))
    .sort((a, b) => b.size - a.size);
  const top3 = (l: [number, number][], v: number) =>
    v > 0 ? l.slice(0, 3).reduce((a, [, s]) => a + s, 0) / v : 0;
  const pct = opts.depthPct ?? 1;
  const lo = mid * (1 - pct / 100);
  const hi = mid * (1 + pct / 100);
  const notional = (l: [number, number][], inRange: (p: number) => boolean) =>
    l.filter(([p]) => inRange(p)).reduce((a, [p, s]) => a + p * s, 0);
  return {
    bestBid,
    bestAsk,
    mid,
    spread: bestAsk - bestBid,
    spreadBps: ((bestAsk - bestBid) / mid) * 1e4,
    bidVolume,
    askVolume,
    imbalance: tot > 0 ? (bidVolume - askVolume) / tot : 0,
    largeOrders,
    concentration: { bid: top3(bids, bidVolume), ask: top3(asks, askVolume) },
    depthWithinPct: {
      pct,
      bid: notional(bids, (p) => p >= lo),
      ask: notional(asks, (p) => p <= hi),
    },
  };
}

/** Flags abnormal liquidity change between two snapshots (observation only). */
export function liquidityShift(prev: BookAnalytics, next: BookAnalytics, thresholdPct = 40) {
  const chg = (a: number, b: number) => (a > 0 ? ((b - a) / a) * 100 : 0);
  const bid = chg(prev.depthWithinPct.bid, next.depthWithinPct.bid);
  const ask = chg(prev.depthWithinPct.ask, next.depthWithinPct.ask);
  return {
    bidChangePct: bid,
    askChangePct: ask,
    abnormal: Math.abs(bid) >= thresholdPct || Math.abs(ask) >= thresholdPct,
  };
}
