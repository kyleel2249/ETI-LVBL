import type { Store, StoreKind, StoredRecord } from "./types";

/** Minimal async SQL driver implemented by SQLite (Node) and D1 (Cloudflare). */
export interface SqlDriver {
  run(sql: string, params?: (string | number | null)[]): Promise<{ changes: number }>;
  all<T = Record<string, unknown>>(sql: string, params?: (string | number | null)[]): Promise<T[]>;
}

/** Ordered, append-only migrations. Never edit an applied migration; add a new one. */
export const MIGRATIONS: { version: number; statements: string[] }[] = [
  {
    version: 1,
    statements: [
      "CREATE TABLE IF NOT EXISTS records (collection TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (collection, id))",
      "CREATE INDEX IF NOT EXISTS idx_records_collection_created ON records (collection, created_at DESC)",
    ],
  },
];
export const LATEST_VERSION = MIGRATIONS[MIGRATIONS.length - 1]!.version;

export class SqlStore implements Store {
  constructor(
    readonly kind: StoreKind,
    private db: SqlDriver,
  ) {}

  async migrate(): Promise<number> {
    await this.db.run("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)");
    const rows = await this.db.all<{ v: number | null }>(
      "SELECT MAX(version) AS v FROM schema_version",
    );
    let current = Number(rows[0]?.v ?? 0);
    for (const m of MIGRATIONS) {
      if (m.version <= current) continue;
      for (const s of m.statements) await this.db.run(s);
      await this.db.run("INSERT INTO schema_version (version) VALUES (?)", [m.version]);
      current = m.version;
    }
    return current;
  }

  async put<T>(collection: string, id: string, data: T, opts?: { overwrite?: boolean }) {
    const verb = opts?.overwrite ? "INSERT OR REPLACE" : "INSERT OR IGNORE";
    const r = await this.db.run(
      `${verb} INTO records (collection, id, data, created_at) VALUES (?, ?, ?, ?)`,
      [collection, id, JSON.stringify(data), Date.now()],
    );
    return r.changes > 0;
  }

  async get<T>(collection: string, id: string): Promise<StoredRecord<T> | null> {
    const r = await this.db.all<Row>("SELECT * FROM records WHERE collection = ? AND id = ?", [
      collection,
      id,
    ]);
    return r[0] ? toRecord<T>(r[0]) : null;
  }

  async list<T>(collection: string, opts?: { limit?: number }): Promise<StoredRecord<T>[]> {
    const limit = Math.max(1, Math.min(opts?.limit ?? 100, 1000));
    const r = await this.db.all<Row>(
      "SELECT * FROM records WHERE collection = ? ORDER BY created_at DESC, rowid DESC LIMIT ?",
      [collection, limit],
    );
    return r.map((x) => toRecord<T>(x));
  }

  async delete(collection: string, id: string) {
    return (
      (await this.db.run("DELETE FROM records WHERE collection = ? AND id = ?", [collection, id]))
        .changes > 0
    );
  }

  async exportAll(): Promise<StoredRecord[]> {
    const r = await this.db.all<Row>("SELECT * FROM records ORDER BY created_at ASC, rowid ASC");
    return r.map((x) => toRecord(x));
  }

  async importAll(rows: StoredRecord[]) {
    let n = 0;
    for (const row of rows) {
      const r = await this.db.run(
        "INSERT OR IGNORE INTO records (collection, id, data, created_at) VALUES (?, ?, ?, ?)",
        [row.collection, row.id, JSON.stringify(row.data), row.createdAt],
      );
      n += r.changes;
    }
    return n;
  }

  async health() {
    try {
      const v = await this.db.all<{ v: number | null }>(
        "SELECT MAX(version) AS v FROM schema_version",
      );
      const n = await this.db.all<{ n: number }>("SELECT COUNT(*) AS n FROM records");
      const ver = Number(v[0]?.v ?? 0);
      return {
        ok: ver === LATEST_VERSION,
        detail: `${this.kind} · schema v${ver}/${LATEST_VERSION} · ${n[0]?.n ?? 0} records`,
      };
    } catch (e) {
      return {
        ok: false,
        detail: `${this.kind} error: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
  }
}

type Row = { collection: string; id: string; data: string; created_at: number };
function toRecord<T>(r: Row): StoredRecord<T> {
  return {
    collection: r.collection,
    id: r.id,
    data: JSON.parse(r.data) as T,
    createdAt: Number(r.created_at),
  };
}
