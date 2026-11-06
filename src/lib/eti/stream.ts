import type { Candle, OrderBook } from "./types";

/** Per-symbol live market state assembled from Binance combined-stream messages. */
export type StreamState = {
  trade: { price: number; qty: number; ts: number; id: number } | null;
  bookTicker: { bid: number; bidQty: number; ask: number; askQty: number; updateId: number } | null;
  depth: (OrderBook & { lastUpdateId: number }) | null;
  kline: { candle: Candle; closed: boolean; interval: string; eventTs: number } | null;
  ticker: { changePct: number; high: number; low: number; volume: number; quoteVolume: number; ts: number } | null;
  applied: number;
  dropped: { duplicate: number; outOfOrder: number; malformed: number };
};

export const emptyStream = (): StreamState => ({ trade: null, bookTicker: null, depth: null, kline: null, ticker: null, applied: 0, dropped: { duplicate: 0, outOfOrder: 0, malformed: 0 } });

const n = (v: unknown) => {
  const x = Number(v);
  return Number.isFinite(x) ? x : NaN;
};
const levels = (raw: unknown): [number, number][] | null => {
  if (!Array.isArray(raw)) return null;
  const out: [number, number][] = [];
  for (const l of raw) {
    if (!Array.isArray(l)) return null;
    const p = n(l[0]), q = n(l[1]);
    if (!(p > 0) || !(q >= 0)) return null;
    if (q > 0) out.push([p, q]); // quantity 0 means "level removed"
  }
  return out;
};

const drop = (s: StreamState, k: keyof StreamState["dropped"]): StreamState => ({ ...s, dropped: { ...s.dropped, [k]: s.dropped[k] + 1 } });

/**
 * Applies one combined-stream message (`{stream, data}`). Pure and idempotent:
 * duplicates and out-of-order events (by trade id / update id / event time) are dropped and counted.
 */
export function applyStreamMessage(s: StreamState, msg: unknown): StreamState {
  const m = msg as { stream?: string; data?: Record<string, unknown> } | null;
  if (!m?.stream || !m.data || typeof m.data !== "object") return drop(s, "malformed");
  const d = m.data;
  const kind = m.stream.split("@")[1] ?? "";

  if (kind === "trade") {
    const price = n(d["p"]), qty = n(d["q"]), ts = n(d["T"]), id = n(d["t"]);
    if (!(price > 0) || !(qty > 0) || !Number.isFinite(ts) || !Number.isFinite(id)) return drop(s, "malformed");
    if (s.trade && id === s.trade.id) return drop(s, "duplicate");
    if (s.trade && id < s.trade.id) return drop(s, "outOfOrder");
    return { ...s, trade: { price, qty, ts, id }, applied: s.applied + 1 };
  }
  if (kind === "bookTicker") {
    const bid = n(d["b"]), bidQty = n(d["B"]), ask = n(d["a"]), askQty = n(d["A"]), updateId = n(d["u"]);
    if (!(bid > 0) || !(ask > 0) || ask < bid || !Number.isFinite(updateId)) return drop(s, "malformed");
    if (s.bookTicker && updateId === s.bookTicker.updateId) return drop(s, "duplicate");
    if (s.bookTicker && updateId < s.bookTicker.updateId) return drop(s, "outOfOrder");
    return { ...s, bookTicker: { bid, bidQty, ask, askQty, updateId }, applied: s.applied + 1 };
  }
  if (kind.startsWith("depth")) {
    // Partial book depth: a full top-N snapshot, so sequencing is by lastUpdateId.
    const id = n(d["lastUpdateId"]);
    const bids = levels(d["bids"]), asks = levels(d["asks"]);
    if (!Number.isFinite(id) || !bids || !asks || !bids.length || !asks.length) return drop(s, "malformed");
    if (bids[0]![0] >= asks[0]![0]) return drop(s, "malformed"); // crossed book
    if (s.depth && id === s.depth.lastUpdateId) return drop(s, "duplicate");
    if (s.depth && id < s.depth.lastUpdateId) return drop(s, "outOfOrder");
    return { ...s, depth: { bids, asks, ts: Date.now(), lastUpdateId: id }, applied: s.applied + 1 };
  }
  if (kind.startsWith("kline")) {
    const k = d["k"] as Record<string, unknown> | undefined;
    const ev = n(d["E"]);
    if (!k || !Number.isFinite(ev)) return drop(s, "malformed");
    const c: Candle = { t: n(k["t"]), o: n(k["o"]), h: n(k["h"]), l: n(k["l"]), c: n(k["c"]), v: n(k["v"]) };
    if (Object.values(c).some((x) => !Number.isFinite(x)) || c.h < c.l || c.h < Math.max(c.o, c.c) || c.l > Math.min(c.o, c.c)) return drop(s, "malformed");
    if (s.kline && ev < s.kline.eventTs) return drop(s, "outOfOrder");
    if (s.kline && ev === s.kline.eventTs) return drop(s, "duplicate");
    return { ...s, kline: { candle: c, closed: k["x"] === true, interval: String(k["i"] ?? ""), eventTs: ev }, applied: s.applied + 1 };
  }
  if (kind === "ticker") {
    const ev = n(d["E"]);
    const changePct = n(d["P"]), high = n(d["h"]), low = n(d["l"]), volume = n(d["v"]), quoteVolume = n(d["q"]);
    if ([ev, changePct, high, low, volume, quoteVolume].some((x) => !Number.isFinite(x))) return drop(s, "malformed");
    if (s.ticker && ev === s.ticker.ts) return drop(s, "duplicate");
    if (s.ticker && ev < s.ticker.ts) return drop(s, "outOfOrder");
    return { ...s, ticker: { changePct, high, low, volume, quoteVolume, ts: ev }, applied: s.applied + 1 };
  }
  return drop(s, "malformed");
}

/** Merge the in-progress/closed live kline into REST candles (replace same-open-time, append newer). */
export function mergeKline(candles: Candle[], k: StreamState["kline"]): Candle[] {
  if (!k || !candles.length) return candles;
  const last = candles[candles.length - 1]!;
  if (k.candle.t === last.t) return [...candles.slice(0, -1), k.candle];
  if (k.candle.t > last.t) return [...candles, k.candle];
  return candles; // older than what we already have
}

export const streamUrl = (host: string, symbol: string, interval: string) => {
  const s = symbol.toLowerCase();
  return `${host}/stream?streams=${[`${s}@trade`, `${s}@bookTicker`, `${s}@depth20@1000ms`, `${s}@kline_${interval}`, `${s}@ticker`].join("/")}`;
};
