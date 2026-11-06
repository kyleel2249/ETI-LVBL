# Paper / testnet trading and the Order desk

`/trading` is the only way ETI places orders. Defaults: Alpaca **paper**, Binance **testnet**.

- Step 1 **Check order** runs every gate and (Binance) exchange validation; nothing is sent.
- Step 2 **Submit** is enabled only for the exact ticket that passed the check.
- Each ticket has an idempotency key; re-submitting returns "duplicate" without sending.
- **Sync with provider** re-reads statuses, stores changes and lists drift (orders the provider cannot find, status/quantity mismatches).
- **Kill switch** (UI toggle or `TRADING_KILL_SWITCH=true`) blocks all orders on all venues.
- Risk limits: ≤1% of equity at the stop, R:R ≥ 1.5, daily-loss cap, max open positions, price data fresher than `DATA_MAX_AGE_SECONDS`.

The older `/paper` page is a separate in-browser simulator kept unchanged.
