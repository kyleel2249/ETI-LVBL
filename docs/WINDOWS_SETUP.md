# Windows setup (verified commands)

Requires Node.js 20.19+ (LTS 22 recommended) from https://nodejs.org — tick **Add to PATH**, then open a *new* CMD/PowerShell window.

```
node -v
npm -v
install.bat        :: npm install, creates .env from .env.example, runs diagnostics
start.bat          :: builds the Node target if needed, serves http://localhost:4173
```

Or manually: `npm install`, `npm start`, `npm run health`.

| Command | What it does |
|---|---|
| `npm run dev` | Vite dev server |
| `npm start` | Build (node-server target) if needed, then serve on port 4173 |
| `npm run production` | Force a fresh build, then serve |
| `npm run build` | Build; Cloudflare target by default, `NITRO_PRESET=node-server` for local |
| `npm run typecheck` / `lint` / `test` | Quality gates |
| `npm run health` | Probes `/`, `/providers`, `/paper` on a running instance |
| `npm run diagnostics` | Node/npm/PATH/deps/.npmrc/PowerShell policy checks |
| `npm run api:check` | Real Binance + Alpaca-paper connectivity (never prints secrets) |
| `npm run deploy:cloudflare` | Build and `wrangler deploy` (requires `wrangler login`) |

Port 4173 busy? Run `stop.bat` or set `PORT=4200` before `npm start`.

## Root cause of "npm doesn't work"
`npm install` fails with `Cannot read properties of null (reading 'edgesOut')` on this
dependency set (reproduced on Node 22 / npm 10). Cause: conflicting peer ranges in the
Vite 8 / TanStack toolchain trip an npm resolver bug. Fixed by `.npmrc`
(`legacy-peer-deps=true`). `vite preview` also could not serve the build because the
default build targets Cloudflare; `npm start` now builds a Node target.

## PowerShell blocked scripts
Use CMD, or: `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`.
