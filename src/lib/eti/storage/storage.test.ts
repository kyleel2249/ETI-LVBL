// @vitest-environment node
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { d1Driver, sqliteDriver, type D1Like } from "./drivers";
import { MemoryStore } from "./memory-store";
import { LATEST_VERSION, SqlStore } from "./sql-store";
import type { Store } from "./types";

/** A D1-shaped fake backed by real SQLite, so the D1 driver code path is exercised. */
function fakeD1(): D1Like {
  const db = new DatabaseSync(":memory:");
  return {
    prepare: (sql: string) => ({
      bind: (...p) => ({
        run: async () => ({ meta: { changes: Number(db.prepare(sql).run(...p).changes) } }),
        all: async <T>() => ({ results: db.prepare(sql).all(...p) as T[] }),
      }),
    }),
  };
}

const factories: [string, () => Store][] = [
  ["sqlite", () => new SqlStore("sqlite", sqliteDriver(new DatabaseSync(":memory:")))],
  ["d1 (fake over sqlite)", () => new SqlStore("d1", d1Driver(fakeD1()))],
  ["memory", () => new MemoryStore()],
];

describe.each(factories)("store: %s", (_n, make) => {
  it("migrates and reports healthy", async () => {
    const s = make();
    expect(await s.migrate()).toBeGreaterThanOrEqual(1);
    expect((await s.health()).ok).toBe(true);
  });
  it("put/get round-trips JSON and is immutable by default", async () => {
    const s = make();
    await s.migrate();
    expect(await s.put("forecasts", "f1", { a: 1 })).toBe(true);
    expect(await s.put("forecasts", "f1", { a: 2 })).toBe(false); // immutable
    expect((await s.get<{ a: number }>("forecasts", "f1"))?.data.a).toBe(1);
    expect(await s.put("forecasts", "f1", { a: 3 }, { overwrite: true })).toBe(true);
    expect((await s.get<{ a: number }>("forecasts", "f1"))?.data.a).toBe(3);
  });
  it("lists newest first, per collection, with limit", async () => {
    const s = make();
    await s.migrate();
    for (let i = 0; i < 5; i++) await s.put("orders", `o${i}`, { i });
    await s.put("audit", "a", {});
    const l = await s.list<{ i: number }>("orders", { limit: 3 });
    expect(l.map((r) => r.data.i)).toEqual([4, 3, 2]);
    expect((await s.list("audit")).length).toBe(1);
  });
  it("delete, export and import (backup/restore)", async () => {
    const s = make();
    await s.migrate();
    await s.put("journal", "j1", { x: 1 });
    await s.put("journal", "j2", { x: 2 });
    expect(await s.delete("journal", "j1")).toBe(true);
    expect(await s.delete("journal", "nope")).toBe(false);
    const dump = await s.exportAll();
    const t = make();
    await t.migrate();
    expect(await t.importAll(dump)).toBe(1);
    expect(await t.importAll(dump)).toBe(0); // idempotent
    expect((await t.get("journal", "j2"))?.collection).toBe("journal");
  });
});

describe("SQL migrations", () => {
  it("is idempotent and versioned", async () => {
    const s = new SqlStore("sqlite", sqliteDriver(new DatabaseSync(":memory:")));
    expect(await s.migrate()).toBe(LATEST_VERSION);
    expect(await s.migrate()).toBe(LATEST_VERSION);
  });
  it("persists across reopen of the same file", async () => {
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "eti-"));
    const file = join(dir, "t.db");
    const dbA = new DatabaseSync(file);
    const a = new SqlStore("sqlite", sqliteDriver(dbA));
    await a.migrate();
    await a.put("orders", "o1", { ok: true });
    dbA.close();
    const dbB = new DatabaseSync(file);
    const b = new SqlStore("sqlite", sqliteDriver(dbB));
    await b.migrate();
    expect((await b.get<{ ok: boolean }>("orders", "o1"))?.data.ok).toBe(true);
    dbB.close(); // Windows cannot delete a database file that is still open
    rmSync(dir, { recursive: true, force: true });
  });
});
