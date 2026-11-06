# ETI — Elite Trading Intelligence

Research, probabilistic forecasting, risk-gated paper/testnet trading and an AI analyst council for crypto (Binance) and US equities/ETFs (Alpaca), with FRED macro context. Runs on a Windows PC with npm, or on Cloudflare Workers, from one codebase (TanStack Start + Vite + TypeScript).

> Research and paper trading tool. Not financial advice. Real-money orders are **off by default** (see [docs/SECURITY.md](docs/SECURITY.md)).

## Quick start (Windows or any OS)

Requires Node.js 20.19+ (22 LTS recommended).

```
install.bat      :: or: npm install
start.bat        :: or: npm start   → http://localhost:4173
```

Optional: copy `.env.example` to `.env` and add keys. Without keys ETI still serves Binance public market data; every keyed feature reports "not configured" instead of faking data. Details: [docs/WINDOWS_SETUP.md](docs/WINDOWS_SETUP.md), [docs/API_SETUP.md](docs/API_SETUP.md).

## What is built

| Area | Status |
|---|---|
| Binance public data: tickers, klines (1m…1w), order book, WebSocket trade/bookTicker/depth/kline/ticker with reconnect, dedupe, out-of-order and malformed handling | Implemented, unit-tested |
| Binance testnet + read-only account, order validate (`/order/test`), place, query, cancel, reconcile | Implemented, tested against mocked responses; needs your testnet keys to verify live |
| Alpaca paper: account, positions, asset checks, orders with native bracket exits, cancel, reconcile | Implemented, tested against mocked responses; needs your paper keys to verify live |
| Alpaca WebSocket streaming | **Not implemented** (equities refresh by polling; a keyed stream cannot run from the browser or a stateless Worker) |
| FRED macro (rates, CPI, unemployment, curve, payrolls) feeding the council | Implemented; needs `FRED_API_KEY` |
| Data-quality engine (OHLC integrity, gaps, duplicates, staleness, status fresh/delayed/stale/incomplete/invalid/unavailable) | Implemented |
| 12-analyst council → evidence-weighted decision with Risk Officer veto and abstention | Implemented (`src/lib/eti/decision.ts`) |
| Probabilistic forecast (seeded bootstrap), walk-forward validation, immutable forecast records, accuracy tracking | Implemented |
| Risk engine (1% risk, R:R, daily loss, max positions, data freshness, kill switch) applied to **every** order server-side | Implemented |
| Persistence: SQLite locally, D1 on Cloudflare, JSON-file/memory fallbacks; migrations, backup/restore | Implemented; D1 tested through a fake driver, not a live D1 |
| Real-money order path (Binance production, Alpaca live) | Implemented but **disabled by default**; needs explicit config + confirmation phrase + risk approval |

Pages: Markets (`/`), Asset (`/asset/BTCUSDT`), Paper & Risk (`/paper`), Order desk (`/trading`), Macro (`/macro`), Providers (`/providers`).

## Commands

`npm run dev | start | production | build | test | lint | typecheck | health | diagnostics | api:check | db:migrate | db:check | db:backup | db:restore | db:seed | deploy:check | deploy:cloudflare` — see [docs/WINDOWS_SETUP.md](docs/WINDOWS_SETUP.md).

## Docs

[ARCHITECTURE](docs/ARCHITECTURE.md) · [API_SETUP](docs/API_SETUP.md) · [PAPER_TRADING](docs/PAPER_TRADING.md) · [DATA_QUALITY](docs/DATA_QUALITY.md) · [SECURITY](docs/SECURITY.md) · [TESTING](docs/TESTING.md) · [CLOUDFLARE_DEPLOYMENT](docs/CLOUDFLARE_DEPLOYMENT.md) · [WINDOWS_SETUP](docs/WINDOWS_SETUP.md) · [TROUBLESHOOTING](docs/TROUBLESHOOTING.md)

Built with [Lovable](https://lovable.dev); changes pushed to `main` sync back into it.
