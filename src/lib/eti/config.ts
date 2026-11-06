/**
 * Trading safety configuration. Pure: takes an env object so it is unit-testable.
 * SAFE BY DEFAULT: real-money order placement is OFF unless explicitly enabled.
 */
export type Venue = "paper" | "testnet" | "live";
export type Provider = "alpaca" | "binance";

export type TradingConfig = {
  /** Master switch for any real-money order. Default false. */
  liveTradingEnabled: boolean;
  /** Alpaca: true (default) = paper endpoint. */
  alpacaPaper: boolean;
  /** Binance production orders also need the master switch. Default false. */
  binanceLiveEnabled: boolean;
  binanceTestnetEnabled: boolean;
  /** Emergency stop: blocks every order on every venue. */
  killSwitch: boolean;
  maxDataAgeMs: number;
};

type Env = Record<string, string | undefined>;

const truthy = (v: string | undefined, d: boolean) =>
  v === undefined || v.trim() === "" ? d : /^(1|true|yes|on)$/i.test(v.trim());

export function readTradingConfig(env: Env): TradingConfig {
  const age = Number(env["DATA_MAX_AGE_SECONDS"]);
  return {
    liveTradingEnabled: truthy(env["LIVE_TRADING_ENABLED"], false),
    alpacaPaper: truthy(env["ALPACA_PAPER"], true),
    binanceLiveEnabled: truthy(env["BINANCE_LIVE_TRADING_ENABLED"], false),
    binanceTestnetEnabled: truthy(env["BINANCE_TESTNET_ENABLED"], true),
    killSwitch: truthy(env["TRADING_KILL_SWITCH"], false),
    maxDataAgeMs: Number.isFinite(age) && age > 0 ? age * 1000 : 60_000,
  };
}

export const LIVE_CONFIRM_PHRASE = "PLACE LIVE ORDER";

/** Is a real-money order permitted on this provider by configuration alone? */
export function liveAllowed(
  cfg: TradingConfig,
  provider: Provider,
): { allowed: boolean; reason: string } {
  if (cfg.killSwitch) return { allowed: false, reason: "Kill switch is on" };
  if (!cfg.liveTradingEnabled)
    return { allowed: false, reason: "LIVE_TRADING_ENABLED is not true" };
  if (provider === "alpaca" && cfg.alpacaPaper)
    return {
      allowed: false,
      reason: "ALPACA_PAPER=true — set ALPACA_PAPER=false to use the live endpoint",
    };
  if (provider === "binance" && !cfg.binanceLiveEnabled)
    return { allowed: false, reason: "BINANCE_LIVE_TRADING_ENABLED is not true" };
  return { allowed: true, reason: "Live trading enabled by configuration" };
}

/** The venue an order on `provider` would hit given config. */
export function defaultVenue(cfg: TradingConfig, provider: Provider): Venue {
  if (provider === "alpaca") return cfg.alpacaPaper ? "paper" : "live";
  return cfg.binanceTestnetEnabled ? "testnet" : "live";
}
