# Security

- Keys are read server-side only (`process.env` and Worker bindings). No endpoint returns them; tests assert outcomes, stored orders, audit records and error messages contain no credentials.
- Signed Binance requests put the signature (not the secret) in the URL; the secret never leaves `sign.ts`.
- Testnet and production credentials are different variables; the testnet venue only ever targets `testnet.binance.vision`. Alpaca paper/live likewise.
- **Real-money orders are off by default.** To enable: `LIVE_TRADING_ENABLED=true` plus (`ALPACA_PAPER=false` + `ALPACA_LIVE_*` keys) or `BINANCE_LIVE_TRADING_ENABLED=true` + production keys with trading permission. Every live order additionally needs the typed confirmation phrase and passes the same risk engine. You take responsibility for enabling this; start with tiny size.
- No withdrawal functionality exists in the code (a test greps for it).
- All server inputs are validated with zod; order requests need a unique idempotency key.
- Server functions reject cross-site requests (framework default) — verified: unauthenticated cross-site calls return 403.
- There is no user authentication in ETI itself. Do not expose a deployment with live trading enabled to the public internet without putting it behind Cloudflare Access or similar.
