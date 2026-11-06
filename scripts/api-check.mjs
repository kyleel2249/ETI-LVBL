// Real connectivity checks against provider APIs. Never prints secrets.
import { readFileSync, existsSync } from "node:fs";
if (existsSync(".env")) {
  for (const l of readFileSync(".env", "utf8").split(/\r?\n/)) {
    const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}
const t = (u, o = {}) => fetch(u, { ...o, signal: AbortSignal.timeout(8000) });
let bad = 0;
const line = (ok, n, d) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${n} — ${d}`);
  if (!ok) bad++;
};

for (const base of ["https://data-api.binance.vision", "https://api.binance.com"]) {
  try {
    const r = await t(base + "/api/v3/ping");
    line(r.ok, "Binance public", `${base} HTTP ${r.status}`);
    if (r.ok) break;
  } catch (e) {
    line(false, "Binance public", `${base} ${e.cause?.code ?? e.message}`);
  }
}
const key = process.env.ALPACA_PAPER_API_KEY ?? process.env.ALPACA_API_KEY;
const sec = process.env.ALPACA_PAPER_API_SECRET ?? process.env.ALPACA_SECRET_KEY;
if (!key || !sec) console.log("SKIP  Alpaca paper — keys not configured (not a failure)");
else {
  try {
    const r = await t("https://paper-api.alpaca.markets/v2/account", {
      headers: { "APCA-API-KEY-ID": key, "APCA-API-SECRET-KEY": sec },
    });
    const a = r.ok ? await r.json() : null;
    line(
      r.ok,
      "Alpaca paper",
      r.ok
        ? `status ${a.status}, ${a.currency}`
        : `HTTP ${r.status}${r.status === 401 || r.status === 403 ? " (authentication failed)" : ""}`,
    );
  } catch (e) {
    line(false, "Alpaca paper", e.cause?.code ?? e.message);
  }
}
process.exit(bad ? 1 : 0);
