import type { SqlDriver } from "./sql-store";

type Params = (string | number | null)[];

/** node:sqlite (Node >= 22.13) driver. */
export interface NodeSqliteDb {
  exec(sql: string): void;
  prepare(sql: string): {
    run(...p: Params): { changes: number | bigint };
    all(...p: Params): unknown[];
  };
}
export function sqliteDriver(db: NodeSqliteDb): SqlDriver {
  return {
    async run(sql, params = []) {
      const r = db.prepare(sql).run(...params);
      return { changes: Number(r.changes) };
    },
    async all<T>(sql: string, params: Params = []) {
      return db.prepare(sql).all(...params) as T[];
    },
  };
}

/** Cloudflare D1 driver (binding `DB`). */
export interface D1Like {
  prepare(sql: string): {
    bind(...p: Params): {
      run(): Promise<{ meta?: { changes?: number } }>;
      all<T>(): Promise<{ results?: T[] }>;
    };
  };
}
export function d1Driver(db: D1Like): SqlDriver {
  return {
    async run(sql, params = []) {
      const r = await db
        .prepare(sql)
        .bind(...params)
        .run();
      return { changes: r.meta?.changes ?? 0 };
    },
    async all<T>(sql: string, params: Params = []) {
      const r = await db
        .prepare(sql)
        .bind(...params)
        .all<T>();
      return r.results ?? [];
    },
  };
}
