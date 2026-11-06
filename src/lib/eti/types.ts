export type Candle = { t: number; o: number; h: number; l: number; c: number; v: number };

export type Ticker = {
  symbol: string;
  provider: "binance" | "alpaca";
  assetClass: "crypto" | "equity";
  last: number;
  changePct: number;
  high: number;
  low: number;
  volume: number;
  quoteVolume: number;
  ts: number;
};

export type ProviderStatus = {
  provider: "binance" | "alpaca";
  configured: boolean;
  reachable: boolean;
  latencyMs: number | null;
  mode: string;
  detail: string;
  checkedAt: number;
};

export type OrderBook = { bids: [number, number][]; asks: [number, number][]; ts: number };

export const CRYPTO_WATCHLIST = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "XRPUSDT", "ADAUSDT", "DOGEUSDT", "AVAXUSDT", "LINKUSDT", "DOTUSDT"];
export const EQUITY_WATCHLIST = ["SPY", "QQQ", "AAPL", "MSFT", "NVDA", "TSLA"];
export const INTERVALS = ["1m", "5m", "15m", "30m", "1h", "4h", "1d", "1w"] as const;
export type Interval = (typeof INTERVALS)[number];
