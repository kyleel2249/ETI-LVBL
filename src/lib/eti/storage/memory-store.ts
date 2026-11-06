import type { Store, StoreKind, StoredRecord } from "./types";

/** In-memory store, optionally persisted to a JSON file (fallback for Node without node:sqlite). */
export class MemoryStore implements Store {
  private rows = new Map<string, StoredRecord>();
  private seq = 0;
  private order = new Map<string, number>();
  constructor(
    readonly kind: StoreKind = "memory",
    private persist?: (rows: StoredRecord[]) => Promise<void>,
    initial: StoredRecord[] = [],
  ) {
    for (const r of initial) {
      this.rows.set(key(r.collection, r.id), r);
      this.order.set(key(r.collection, r.id), this.seq++);
    }
  }
  async migrate() {
    return 1;
  }
  async put<T>(collection: string, id: string, data: T, opts?: { overwrite?: boolean }) {
    const k = key(collection, id);
    if (this.rows.has(k) && !opts?.overwrite) return false;
    this.rows.set(k, { collection, id, data, createdAt: Date.now() });
    this.order.set(k, this.seq++);
    await this.persist?.([...this.rows.values()]);
    return true;
  }
  async get<T>(collection: string, id: string) {
    return (this.rows.get(key(collection, id)) as StoredRecord<T> | undefined) ?? null;
  }
  async list<T>(collection: string, opts?: { limit?: number }) {
    const limit = Math.max(1, Math.min(opts?.limit ?? 100, 1000));
    return [...this.rows.entries()]
      .filter(([, r]) => r.collection === collection)
      .sort(
        (a, b) =>
          b[1].createdAt - a[1].createdAt ||
          (this.order.get(b[0]) ?? 0) - (this.order.get(a[0]) ?? 0),
      )
      .slice(0, limit)
      .map(([, r]) => r as StoredRecord<T>);
  }
  async delete(collection: string, id: string) {
    const ok = this.rows.delete(key(collection, id));
    if (ok) await this.persist?.([...this.rows.values()]);
    return ok;
  }
  async exportAll() {
    return [...this.rows.values()];
  }
  async importAll(rows: StoredRecord[]) {
    let n = 0;
    for (const r of rows) {
      if (this.rows.has(key(r.collection, r.id))) continue;
      this.rows.set(key(r.collection, r.id), r);
      n++;
    }
    if (n) await this.persist?.([...this.rows.values()]);
    return n;
  }
  async health() {
    return { ok: true, detail: `${this.kind} · ${this.rows.size} records` };
  }
}
const key = (c: string, id: string) => `${c}\u0000${id}`;
