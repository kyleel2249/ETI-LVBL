# Troubleshooting

- **`npm install` edgesOut error** — make sure `.npmrc` exists (`legacy-peer-deps=true`); delete `node_modules` and `package-lock.json`, retry.
- **`'node' is not recognized`** — reinstall Node.js with Add to PATH; open a new terminal.
- **Engine/version errors** — need Node >= 20.19.
- **Alpaca "not configured"** — copy `.env.example` to `.env`, add *paper* keys, restart.
- **Alpaca 401/403** — wrong or live keys used against the paper endpoint.
- **Binance unreachable / HTTP 451** — region/network block; ETI shows an error state, never fake prices.
- **Port in use** — `stop.bat`, or set `PORT`.
- **Health check fails** — start ETI first (`npm start`).
