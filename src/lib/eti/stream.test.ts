import { describe, expect, it } from "vitest";
import { applyStreamMessage, emptyStream, mergeKline, streamUrl } from "./stream";

const trade = (id: number, p = "100", q = "1") => ({ stream: "btcusdt@trade", data: { p, q, T: 1000 + id, t: id } });
const book = (id: number, bid = "100", ask = "100.1") => ({ stream: "btcusdt@bookTicker", data: { u: id, b: bid, B: "1", a: ask, A: "2" } });
const depth = (id: number, bids: string[][] = [["100", "2"], ["99.9", "1"]], asks: string[][] = [["100.1", "1"], ["100.2", "3"]]) => ({ stream: "btcusdt@depth20@1000ms", data: { lastUpdateId: id, bids, asks } });
const kline = (ev: number, t = 60_000, c = "101", x = false) => ({ stream: "btcusdt@kline_1m", data: { E: ev, k: { t, o: "100", h: "102", l: "99", c, v: "10", x, i: "1m" } } });
const ticker = (ev: number) => ({ stream: "btcusdt@ticker", data: { E: ev, P: "1.5", h: "110", l: "90", v: "1000", q: "100000" } });

describe("binance stream reducer", () => {
  it("applies each stream type", () => {
    let s = emptyStream();
    for (const m of [trade(1), book(1), depth(1), kline(1), ticker(1)]) s = applyStreamMessage(s, m);
    expect(s.applied).toBe(5);
    expect(s.trade?.price).toBe(100);
    expect(s.bookTicker?.ask).toBe(100.1);
    expect(s.depth?.bids[0]).toEqual([100, 2]);
    expect(s.kline).toMatchObject({ closed: false, interval: "1m" });
    expect(s.ticker?.changePct).toBe(1.5);
  });
  it("drops duplicates and out-of-order events and counts them", () => {
    let s = applyStreamMessage(emptyStream(), trade(5));
    s = applyStreamMessage(s, trade(5));
    s = applyStreamMessage(s, trade(4));
    s = applyStreamMessage(s, depth(10));
    s = applyStreamMessage(s, depth(10));
    s = applyStreamMessage(s, depth(9));
    s = applyStreamMessage(s, book(3));
    s = applyStreamMessage(s, book(2));
    expect(s.trade?.id).toBe(5);
    expect(s.depth?.lastUpdateId).toBe(10);
    expect(s.dropped).toEqual({ duplicate: 2, outOfOrder: 3, malformed: 0 });
  });
  it("rejects malformed and crossed data without changing state", () => {
    let s = emptyStream();
    for (const bad of [null, {}, { stream: "x@trade", data: { p: "abc", q: "1", T: 1, t: 1 } }, trade(1, "-5"), book(1, "101", "100"), depth(1, [["101", "1"]], [["100", "1"]]), depth(2, [], [["1", "1"]]), kline(1, 1, "999"), { stream: "btcusdt@weird", data: {} }]) s = applyStreamMessage(s, bad);
    expect(s.applied).toBe(0);
    expect(s.trade).toBeNull();
    expect(s.dropped.malformed).toBe(9);
  });
  it("removes zero-quantity depth levels", () => {
    const s = applyStreamMessage(emptyStream(), depth(1, [["100", "2"], ["99.9", "0"]]));
    expect(s.depth?.bids).toEqual([[100, 2]]);
  });
  it("kline closed flag", () => {
    expect(applyStreamMessage(emptyStream(), kline(1, 60_000, "101", true)).kline?.closed).toBe(true);
  });
  it("merges live kline into REST candles", () => {
    const rest = [{ t: 0, o: 1, h: 2, l: 1, c: 2, v: 1 }, { t: 60_000, o: 2, h: 3, l: 2, c: 3, v: 1 }];
    const live = applyStreamMessage(emptyStream(), kline(1, 60_000, "101")).kline;
    expect(mergeKline(rest, live)).toHaveLength(2); // replaced in place
    expect(mergeKline(rest, live)[1]!.c).toBe(101);
    expect(mergeKline(rest, applyStreamMessage(emptyStream(), kline(1, 120_000)).kline)).toHaveLength(3); // appended
    expect(mergeKline(rest, applyStreamMessage(emptyStream(), kline(1, -60_000)).kline)).toHaveLength(2); // older ignored
    expect(mergeKline(rest, null)).toBe(rest);
  });
  it("builds a combined-stream url that resubscribes all channels", () => {
    expect(streamUrl("wss://h", "BTCUSDT", "1m")).toBe("wss://h/stream?streams=btcusdt@trade/btcusdt@bookTicker/btcusdt@depth20@1000ms/btcusdt@kline_1m/btcusdt@ticker");
  });
});
