import { describe, expect, it } from "vitest";
import { defaultVenue, liveAllowed, readTradingConfig } from "./config";

describe("trading config is safe by default", () => {
  const cfg = readTradingConfig({});
  it("defaults: live off, alpaca paper on, testnet on", () => {
    expect(cfg.liveTradingEnabled).toBe(false);
    expect(cfg.alpacaPaper).toBe(true);
    expect(cfg.binanceLiveEnabled).toBe(false);
    expect(cfg.binanceTestnetEnabled).toBe(true);
    expect(cfg.killSwitch).toBe(false);
    expect(cfg.maxDataAgeMs).toBe(60_000);
  });
  it("live is blocked by default on both providers", () => {
    expect(liveAllowed(cfg, "alpaca").allowed).toBe(false);
    expect(liveAllowed(cfg, "binance").allowed).toBe(false);
  });
  it("alpaca live needs master switch AND ALPACA_PAPER=false", () => {
    expect(liveAllowed(readTradingConfig({ LIVE_TRADING_ENABLED: "true" }), "alpaca").allowed).toBe(
      false,
    );
    expect(
      liveAllowed(
        readTradingConfig({ LIVE_TRADING_ENABLED: "true", ALPACA_PAPER: "false" }),
        "alpaca",
      ).allowed,
    ).toBe(true);
  });
  it("binance live needs master switch AND BINANCE_LIVE_TRADING_ENABLED", () => {
    expect(
      liveAllowed(readTradingConfig({ BINANCE_LIVE_TRADING_ENABLED: "true" }), "binance").allowed,
    ).toBe(false);
    expect(
      liveAllowed(
        readTradingConfig({ LIVE_TRADING_ENABLED: "1", BINANCE_LIVE_TRADING_ENABLED: "yes" }),
        "binance",
      ).allowed,
    ).toBe(true);
  });
  it("kill switch overrides everything", () => {
    const k = readTradingConfig({
      LIVE_TRADING_ENABLED: "true",
      ALPACA_PAPER: "false",
      TRADING_KILL_SWITCH: "true",
    });
    expect(liveAllowed(k, "alpaca").allowed).toBe(false);
  });
  it("default venues", () => {
    expect(defaultVenue(cfg, "alpaca")).toBe("paper");
    expect(defaultVenue(cfg, "binance")).toBe("testnet");
  });
  it("parses DATA_MAX_AGE_SECONDS", () => {
    expect(readTradingConfig({ DATA_MAX_AGE_SECONDS: "300" }).maxDataAgeMs).toBe(300_000);
  });
});
