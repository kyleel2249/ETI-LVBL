import { SqlStore } from "./sql-store";
import { d1Driver, sqliteDriver, type D1Like, type NodeSqliteDb } from "./drivers";
import { MemoryStore } from "./memory-store";
import type { Store, StoredRecord } from "./types";

let cached: Promise<Store> | null = null;

/**
 * Picks the persistence backend for the current runtime:
 *  1. Cloudflare D1 when a `DB` binding exists
 *  2. SQLite file (node:sqlite, Node >= 22.13) at ETI_DB_PATH or ./data/eti.db
 *  3. JSON file at ETI_DB_PATH(.json) as a Node fallback
 *  4. In-memory (never silently — `kind` reports it so the UI can say data is not durable)
 */
export function getStore(): Promise<Store> {
  cached ??= create().then(async (s) => (await s.migrate(), s));
  return cached;
}
export function resetStoreForTests() {
  cached = null;
}

async function create(): Promise<Store> {
  const g = globalThis as unknown as {
    __env__?: { DB?: D1Like };
    navigator?: { userAgent?: string };
  };
  const isWorkers = g.navigator?.userAgent === "Cloudflare-Workers";
  const d1 = g.__env__?.DB;
  if (d1) return new SqlStore("d1", d1Driver(d1));
  if (isWorkers) return new MemoryStore("memory");

  const dir = process.env["ETI_DATA_DIR"] ?? "data";
  const spec = "node:" + "sqlite";
  const fsSpec = "node:" + "fs";
  const pathSpec = "node:" + "path";
  const fs = (await import(/* @vite-ignore */ fsSpec)) as typeof import("node:fs");
  const path = (await import(/* @vite-ignore */ pathSpec)) as typeof import("node:path");
  fs.mkdirSync(dir, { recursive: true });
  try {
    const sqlite = (await import(/* @vite-ignore */ spec)) as {
      DatabaseSync: new (p: string) => NodeSqliteDb;
    };
    const file = process.env["ETI_DB_PATH"] ?? path.join(dir, "eti.db");
    const db = new sqlite.DatabaseSync(file);
    db.exec("PRAGMA journal_mode = WAL");
    return new SqlStore("sqlite", sqliteDriver(db));
  } catch {
    const file = path.join(dir, "eti.json");
    let initial: StoredRecord[] = [];
    try {
      initial = JSON.parse(fs.readFileSync(file, "utf8")) as StoredRecord[];
    } catch {
      /* first run */
    }
    return new MemoryStore(
      "json-file",
      async (rows) => {
        const tmp = file + ".tmp";
        fs.writeFileSync(tmp, JSON.stringify(rows));
        fs.renameSync(tmp, file);
      },
      initial,
    );
  }
}

let n = 0;
/** Append-only audit record. Never throws: auditing must not break trading, but failures are surfaced in the return. */
export async function audit(event: string, detail: Record<string, unknown>): Promise<boolean> {
  try {
    const s = await getStore();
    return await s.put("audit", `${Date.now()}-${n++}`, { event, ...detail });
  } catch {
    return false;
  }
}
