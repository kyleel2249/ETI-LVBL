# API setup

Put keys in `.env` (local) or Cloudflare secrets (`npx wrangler secret put NAME`). Verify with `npm run api:check` (Binance public + Alpaca paper) and the `/providers` page.

## Alpaca (equities/ETFs)
1. Create a paper account, generate **paper** keys → `ALPACA_PAPER_API_KEY`, `ALPACA_PAPER_API_SECRET`.
2. Market data uses the free IEX feed; other feeds need a subscription (ETI reports entitlement errors, never substitutes data).
3. Live keys (`ALPACA_LIVE_*`) are separate variables and are never used for paper, nor paper keys for live.

## Binance
1. Public market data needs no key.
2. Testnet: sign in at https://testnet.binance.vision, create keys → `BINANCE_TESTNET_API_KEY`, `BINANCE_TESTNET_SECRET_KEY`.
3. Production account view: create a key with **only "Enable Reading"** → `BINANCE_API_KEY`, `BINANCE_SECRET_KEY`. Never enable withdrawals; ETI has no withdrawal code.
4. Some regions are blocked by Binance (HTTP 451). Respect Binance terms and your local rules.

## FRED
Free key → `FRED_API_KEY`. Without it `/macro` says so and the council receives no macro input.
