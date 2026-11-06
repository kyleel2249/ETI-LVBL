# Testing

`npm test` (Vitest) runs without any API keys or network: provider behaviour uses injected fake `fetch`.

Covered: config safety defaults, HMAC signing (official Binance test vector), SQLite/D1-driver/memory stores (immutability, persistence across reopen, backup/restore), migrations, order gate and precision, order pipeline (preview/submit/duplicate/veto/kill switch/live blocked/failure), sync and cancel, retry/backoff/circuit breaker, normalisation and reconciliation, order-book analytics, stream reducer (dedupe/out-of-order/malformed), council decision aggregation, macro analysis, forecast determinism and calibration, walk-forward scoring, SMA backtest, secrets-leak checks.

Not covered by automated tests: live provider calls (use `npm run api:check` with your keys), a live D1 database, browser rendering beyond the routing test.

CI (GitHub Actions) runs install, typecheck, lint, tests and the build on Ubuntu and Windows.
