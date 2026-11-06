export type StoredRecord<T = unknown> = {
  collection: string;
  id: string;
  data: T;
  createdAt: number;
};

export type StoreKind = "memory" | "json-file" | "sqlite" | "d1";

export interface Store {
  readonly kind: StoreKind;
  /** Apply schema migrations; returns the schema version now in effect. */
  migrate(): Promise<number>;
  /** Insert. Returns false (and writes nothing) if the id exists and overwrite is not set. */
  put<T>(collection: string, id: string, data: T, opts?: { overwrite?: boolean }): Promise<boolean>;
  get<T>(collection: string, id: string): Promise<StoredRecord<T> | null>;
  /** Newest first. */
  list<T>(collection: string, opts?: { limit?: number }): Promise<StoredRecord<T>[]>;
  delete(collection: string, id: string): Promise<boolean>;
  exportAll(): Promise<StoredRecord[]>;
  importAll(rows: StoredRecord[]): Promise<number>;
  health(): Promise<{ ok: boolean; detail: string }>;
}

/** Well-known collections. */
export const COLLECTIONS = {
  orders: "orders",
  audit: "audit",
  forecasts: "forecasts",
  council: "council",
  journal: "journal",
  syncEvents: "sync_events",
  settings: "settings",
} as const;
