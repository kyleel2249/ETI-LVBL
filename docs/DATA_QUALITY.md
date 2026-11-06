# Data quality and market data

Candles pass `assessCandles`: OHLC consistency, positive values, duplicates, gaps, and staleness relative to the interval. The result maps to a status (`fresh`, `stale`, `incomplete`, `invalid`, `unavailable`; `delayed` is reserved for providers that report delay).

- Stale/incomplete/invalid/unavailable data → the council decision is **INSUFFICIENT DATA** and forecasts are withheld.
- Quality score < 60 → INSUFFICIENT DATA.
- Prices from different venues/quote assets (BTC/USD vs BTC/USDT) are never treated as interchangeable; only USDT pairs can be ordered on Binance and no USDT↔USD↔GHS conversion is performed.
- Timestamps are UTC milliseconds throughout; the UI displays local time.
- A closed stock market is judged against the interval's expected cadence; weekend/overnight gaps can still show as stale for intraday intervals — treat the status as "no recent bars".
