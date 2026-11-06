import { describe, expect, it } from "vitest";
import { analyzeBook, liquidityShift } from "./orderbook";

const book = {
  bids: [
    [100, 2],
    [99.9, 1],
    [99.8, 1],
    [99.5, 1],
  ] as [number, number][],
  asks: [
    [100.2, 1],
    [100.3, 1],
    [100.4, 20],
    [100.8, 1],
  ] as [number, number][],
  ts: 1,
};
describe("order book analytics", () => {
  const a = analyzeBook(book)!;
  it("spread and mid", () => {
    expect(a.bestBid).toBe(100);
    expect(a.bestAsk).toBe(100.2);
    expect(a.spread).toBeCloseTo(0.2);
    expect(a.spreadBps).toBeCloseTo((0.2 / 100.1) * 1e4, 4);
  });
  it("imbalance is (bid-ask)/(bid+ask)", () => {
    expect(a.bidVolume).toBe(5);
    expect(a.askVolume).toBe(23);
    expect(a.imbalance).toBeCloseTo((5 - 23) / 28);
  });
  it("detects the large ask wall", () => {
    expect(a.largeOrders[0]).toMatchObject({ side: "ask", price: 100.4, size: 20 });
  });
  it("concentration within 0..1", () => {
    expect(a.concentration.ask).toBeGreaterThan(0.8);
    expect(a.concentration.bid).toBeLessThanOrEqual(1);
  });
  it("rejects empty or crossed books", () => {
    expect(analyzeBook({ bids: [], asks: [], ts: 1 })).toBeNull();
    expect(analyzeBook({ bids: [[101, 1]], asks: [[100, 1]], ts: 1 })).toBeNull();
  });
  it("flags abnormal liquidity shift", () => {
    const thin = analyzeBook({ ...book, bids: [[100, 0.2]] })!;
    expect(liquidityShift(a, thin).abnormal).toBe(true);
    expect(liquidityShift(a, a).abnormal).toBe(false);
  });
});
