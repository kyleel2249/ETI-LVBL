// Local SQLite maintenance (Node >= 22.13, uses built-in node:sqlite).
// Usage: node scripts/db.mjs <migrate|check|backup|restore|seed> [file]
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const dir = process.env.ETI_DATA_DIR ?? "data";
const file = process.env.ETI_DB_PATH ?? join(dir, "eti.db");
const [cmd, arg] = process.argv.slice(2);

let DatabaseSync;
try {
  ({ DatabaseSync } = await import("node:sqlite"));
} catch {
  console.error("node:sqlite is unavailable. Install Node.js 22.13 or newer (https://nodejs.org). ETI then falls back to a JSON file store automatically at runtime.");
  process.exit(1);
}
mkdirSync(dir, { recursive: true });
const db = new DatabaseSync(file);
db.exec("PRAGMA journal_mode = WAL");

function migrate() {
  db.exec("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)");
  const cur = Number(db.prepare("SELECT MAX(version) AS v FROM schema_version").get()?.v ?? 0);
  const files = readdirSync("cloudflare/migrations").filter((f) => /^\d{4}_.+\.sql$/.test(f)).sort();
  let applied = cur;
  for (const f of files) {
    const v = Number(f.slice(0, 4));
    if (v <= cur) continue;
    db.exec("BEGIN");
    try {
      db.exec(readFileSync(join("cloudflare/migrations", f), "utf8"));
      db.prepare("INSERT INTO schema_version (version) VALUES (?)").run(v);
      db.exec("COMMIT");
      applied = v;
      console.log(`applied ${f}`);
    } catch (e) {
      db.exec("ROLLBACK");
      console.error(`migration ${f} failed and was rolled back: ${e.message}`);
      process.exit(1);
    }
  }
  console.log(`schema v${applied} at ${file}`);
}

switch (cmd) {
  case "migrate":
    migrate();
    break;
  case "check": {
    migrate();
    const ok = db.prepare("PRAGMA integrity_check").get();
    const n = db.prepare("SELECT COUNT(*) AS n FROM records").get().n;
    console.log(`integrity: ${Object.values(ok)[0]} · ${n} records`);
    process.exit(Object.values(ok)[0] === "ok" ? 0 : 1);
    break;
  }
  case "backup": {
    migrate();
    const out = arg ?? join(dir, `backup-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
    const rows = db.prepare("SELECT collection, id, data, created_at FROM records ORDER BY created_at, rowid").all();
    writeFileSync(out, JSON.stringify(rows.map((r) => ({ collection: r.collection, id: r.id, data: JSON.parse(r.data), createdAt: r.created_at }))));
    console.log(`backed up ${rows.length} records to ${out}`);
    break;
  }
  case "restore": {
    if (!arg || !existsSync(arg)) { console.error("usage: npm run db:restore -- <backup.json>"); process.exit(1); }
    migrate();
    const rows = JSON.parse(readFileSync(arg, "utf8"));
    const ins = db.prepare("INSERT OR IGNORE INTO records (collection, id, data, created_at) VALUES (?, ?, ?, ?)");
    let n = 0;
    db.exec("BEGIN");
    for (const r of rows) n += Number(ins.run(r.collection, r.id, JSON.stringify(r.data), r.createdAt).changes);
    db.exec("COMMIT");
    console.log(`restored ${n} new records (${rows.length - n} already present)`);
    break;
  }
  case "seed": {
    // Writes default risk-limit settings only. ETI never seeds fake market data, orders or forecasts.
    migrate();
    const r = db.prepare("INSERT OR IGNORE INTO records (collection, id, data, created_at) VALUES ('settings', 'risk_defaults', ?, ?)").run(JSON.stringify({ maxRiskPerTradePct: 1, maxDailyLossPct: 3, maxOpenPositions: 5 }), Date.now());
    console.log(Number(r.changes) ? "seeded default risk settings" : "defaults already present");
    break;
  }
  default:
    console.error("usage: node scripts/db.mjs <migrate|check|backup|restore|seed> [file]");
    process.exit(2);
}
