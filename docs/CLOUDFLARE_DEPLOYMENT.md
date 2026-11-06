# Cloudflare deployment (Workers via Nitro)

```
npx wrangler login
npx wrangler d1 create eti                 # copy the database_id it prints
set ETI_D1_DATABASE_ID=<id>                # PowerShell: $env:ETI_D1_DATABASE_ID="<id>"
npm run deploy:check                       # builds, shows generated wrangler config, deploys nothing
npm run deploy:cloudflare                  # applies D1 migrations, then deploys
```

Secrets (one command each): `npx wrangler secret put ALPACA_PAPER_API_KEY` … see `.env.example` for names. Plain vars (e.g. `LIVE_TRADING_ENABLED`) via the dashboard or wrangler `vars`.

What the script does: writes a temporary `wrangler.jsonc` (name `eti`, `nodejs_compat`, D1 binding `DB` → `cloudflare/migrations`), builds with the `cloudflare-module` preset, runs migrations, deploys, removes the temp file. Without `ETI_D1_DATABASE_ID` it deploys with **non-durable** in-memory storage and says so.

Verified here: the build generates the expected Wrangler config incl. the D1 binding. **Not verified**: an actual deploy or a live D1 (needs your Cloudflare account). After deploying check `/providers` (Storage should say `d1 · schema v1`). Free-plan D1 and Workers limits apply; ETI needs no paid add-ons.

Rollback: `npx wrangler rollback`. Data: D1 export via `npx wrangler d1 export eti --remote`.
