# Architecture

One TypeScript codebase, two runtimes. The Nitro preset decides the target: `node-server` for `npm start`, `cloudflare-module` for `npm run deploy:cloudflare`.

```
src/lib/eti/
  config.ts            safety flags (live OFF by default), venues
  orders.ts            pre-trade gate (venue rules + risk engine), Binance/Alpaca precision & asset checks
  risk.ts              risk engine (1%/trade, R:R, daily loss, positions, freshness, kill switch)
  providers/           binance.server.ts, alpaca.server.ts (REST clients), normalize.ts, resilience.ts
  trading.pipeline.server.ts   preview/submit/cancel/sync pipeline (idempotent, audited)
  trading.functions.ts server functions exposed to the UI
  storage/             Store interface; SQLite, D1, JSON-file, memory; migrations
  stream.ts, live.ts   Binance WebSocket reducer + React hook
  orderbook.ts         spread, imbalance, large orders, concentration, liquidity shifts
  quality.ts           candle integrity/freshness → status
  indicators.ts        technical snapshot
  forecast.ts, backtest.ts   probabilistic forecast, walk-forward validation, SMA backtest
  macro.ts, fred.server.ts   FRED series → backdrop signals
  council.functions.ts 12-analyst AI council (existing)
  decision.ts          evidence-weighted aggregation, Risk Officer veto, abstention
src/routes/            /, /asset/$symbol, /paper, /trading, /macro, /providers
cloudflare/migrations/ D1 schema (kept identical to runtime migrations by a test)
scripts/               install/diagnostics/health/api-check/db/deploy helpers
```

## Order flow (every order, every venue)

1. Venue/config gate: kill switch, live flags + confirmation phrase, venue↔provider match, idempotency key format.
2. Instrument checks: Binance `exchangeInfo` (status, lot/tick/notional, USDT quote only) or Alpaca asset (active, tradable, fractionable).
3. Server-observed price and equity (never client-supplied) → risk engine (stop/target, R:R ≥ 1.5, ≤1% risk, daily loss, positions, freshness).
4. Binance: exchange-side validation via `/order/test`. Alpaca: native bracket order.
5. The order record is claimed in storage (insert-if-absent) **before** sending → duplicates are never re-sent.
6. Result persisted, audited; `Sync` re-reads provider status and reports drift.

## Honest limits

Binance spot has no native bracket: stop/target are risk-validated but not placed as OCO. Binance equity is the USDT balance only; no currency conversion is ever applied. Alpaca latest trade comes from the IEX feed. Spot daily realized P&L is not tracked for Binance.
