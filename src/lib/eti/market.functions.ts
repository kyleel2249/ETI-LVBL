import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import type { Candle, OrderBook, ProviderStatus, Ticker } from "./types";

const BINANCE = ["https://data-api.binance.vision", "https://api.binance.com", "https://api1.binance.com"];
const ALPACA_DATA = "https://data.alpaca.markets";
const ALPACA_PAPER = "https://paper-api.alpaca.markets";

async function binance<T>(path: string): Promise<T> {
  let lastErr = "";
  for (const base of BINANCE) {
    try {
      const r = await fetch(base + path, { signal: AbortSignal.timeout(6000) });
      if (r.ok) return (await r.json()) as T;
      lastErr = `${r.status} ${await r.text()}`;
      if (r.status === 400) break; // bad symbol — no failover
    } catch (e) {
      lastErr = String(e);
    }
  }
  throw new Error(`Binance request failed: ${lastErr}`);
}

function alpacaHeaders() {
  const key = process.env['ALPACA_PAPER_API_KEY'];
  const secret = process.env['ALPACA_PAPER_API_SECRET'];
  if (!key || !secret) return null;
  return { "APCA-API-KEY-ID": key, "APCA-API-SECRET-KEY": secret };
}

const symbolSchema = z.string().regex(/^[A-Z0-9.]{1,20}$/);

export const getCryptoTickers = createServerFn({ method: "GET" })
  .inputValidator((d: { symbols: string[] }) => z.object({ symbols: z.array(symbolSchema).max(50) }).parse(d))
  .handler(async ({ data }): Promise<Ticker[]> => {
    const raw = await binance<any[]>(`/api/v3/ticker/24hr?symbols=${encodeURIComponent(JSON.stringify(data.symbols))}`);
    return raw.map((t) => ({
      symbol: t.symbol, provider: "binance", assetClass: "crypto",
      last: +t.lastPrice, changePct: +t.priceChangePercent, high: +t.highPrice, low: +t.lowPrice,
      volume: +t.volume, quoteVolume: +t.quoteVolume, ts: +t.closeTime,
    }));
  });

export const getCandles = createServerFn({ method: "GET" })
  .inputValidator((d: { symbol: string; interval: string; limit?: number }) =>
    z.object({ symbol: symbolSchema, interval: z.enum(["15m", "1h", "4h", "1d"]), limit: z.number().int().min(50).max(1000).optional() }).parse(d))
  .handler(async ({ data }): Promise<{ candles: Candle[]; source: string }> => {
    const isCrypto = data.symbol.endsWith("USDT");
    const limit = data.limit ?? 300;
    if (isCrypto) {
      const raw = await binance<any[]>(`/api/v3/klines?symbol=${data.symbol}&interval=${data.interval}&limit=${limit}`);
      return { source: "Binance Spot", candles: raw.map((k) => ({ t: k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5] })) };
    }
    const h = alpacaHeaders();
    if (!h) throw new Error("Alpaca is not configured — add paper API keys to load equity data.");
    const tf = { "15m": "15Min", "1h": "1Hour", "4h": "4Hour", "1d": "1Day" }[data.interval];
    const days = { "15m": 10, "1h": 40, "4h": 160, "1d": 600 }[data.interval]!;
    const start = new Date(Date.now() - days * 864e5).toISOString();
    const r = await fetch(`${ALPACA_DATA}/v2/stocks/${data.symbol}/bars?timeframe=${tf}&start=${start}&limit=${limit}&feed=iex&adjustment=split&sort=asc`, { headers: h });
    if (!r.ok) throw new Error(`Alpaca bars failed [${r.status}]: ${await r.text()}`);
    const j = await r.json();
    return { source: "Alpaca (IEX feed)", candles: (j.bars ?? []).map((b: any) => ({ t: Date.parse(b.t), o: b.o, h: b.h, l: b.l, c: b.c, v: b.v })) };
  });

export const getOrderBook = createServerFn({ method: "GET" })
  .inputValidator((d: { symbol: string }) => z.object({ symbol: symbolSchema }).parse(d))
  .handler(async ({ data }): Promise<OrderBook> => {
    const j = await binance<any>(`/api/v3/depth?symbol=${data.symbol}&limit=50`);
    return { bids: j.bids.map((b: string[]) => [+b[0]!, +b[1]!]), asks: j.asks.map((a: string[]) => [+a[0]!, +a[1]!]), ts: Date.now() };
  });

export const getEquitySnapshots = createServerFn({ method: "GET" })
  .inputValidator((d: { symbols: string[] }) => z.object({ symbols: z.array(symbolSchema).max(30) }).parse(d))
  .handler(async ({ data }): Promise<{ configured: boolean; tickers: Ticker[]; error?: string }> => {
    const h = alpacaHeaders();
    if (!h) return { configured: false, tickers: [] };
    const r = await fetch(`${ALPACA_DATA}/v2/stocks/snapshots?symbols=${data.symbols.join(",")}&feed=iex`, { headers: h });
    if (!r.ok) return { configured: true, tickers: [], error: `Alpaca [${r.status}]: ${await r.text()}` };
    const j = await r.json();
    const tickers: Ticker[] = Object.entries<any>(j).map(([sym, s]) => {
      const last = s.latestTrade?.p ?? s.dailyBar?.c ?? 0;
      const prev = s.prevDailyBar?.c ?? last;
      return {
        symbol: sym, provider: "alpaca", assetClass: "equity", last,
        changePct: prev ? ((last - prev) / prev) * 100 : 0, high: s.dailyBar?.h ?? 0, low: s.dailyBar?.l ?? 0,
        volume: s.dailyBar?.v ?? 0, quoteVolume: (s.dailyBar?.v ?? 0) * last, ts: Date.parse(s.latestTrade?.t ?? s.dailyBar?.t ?? new Date().toISOString()),
      };
    });
    return { configured: true, tickers };
  });

export const getProviderStatus = createServerFn({ method: "GET" }).handler(async (): Promise<ProviderStatus[]> => {
  const out: ProviderStatus[] = [];
  const t0 = Date.now();
  try {
    await binance("/api/v3/ping");
    out.push({ provider: "binance", configured: true, reachable: true, latencyMs: Date.now() - t0, mode: "Public market data", detail: "Spot REST reachable · keys not required for market data", checkedAt: Date.now() });
  } catch (e) {
    out.push({ provider: "binance", configured: true, reachable: false, latencyMs: null, mode: "Public market data", detail: String(e), checkedAt: Date.now() });
  }
  const h = alpacaHeaders();
  if (!h) {
    out.push({ provider: "alpaca", configured: false, reachable: false, latencyMs: null, mode: "Paper", detail: "Paper API keys not configured", checkedAt: Date.now() });
  } else {
    const t1 = Date.now();
    try {
      const r = await fetch(`${ALPACA_PAPER}/v2/account`, { headers: h, signal: AbortSignal.timeout(6000) });
      if (!r.ok) throw new Error(`[${r.status}] ${r.status === 401 || r.status === 403 ? "authentication failed" : await r.text()}`);
      const a = await r.json();
      out.push({ provider: "alpaca", configured: true, reachable: true, latencyMs: Date.now() - t1, mode: "Paper",
        detail: `Account ${a.status} · ${a.currency} · equity ${Number(a.equity).toLocaleString()} · buying power ${Number(a.buying_power).toLocaleString()}${a.trading_blocked ? " · TRADING BLOCKED" : ""}`, checkedAt: Date.now() });
    } catch (e) {
      out.push({ provider: "alpaca", configured: true, reachable: false, latencyMs: null, mode: "Paper", detail: String(e), checkedAt: Date.now() });
    }
  }
  return out;
});
