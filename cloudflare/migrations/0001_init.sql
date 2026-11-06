-- ETI storage schema v1. Must match MIGRATIONS[0] in src/lib/eti/storage/sql-store.ts (enforced by a test).
CREATE TABLE IF NOT EXISTS records (collection TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (collection, id));
CREATE INDEX IF NOT EXISTS idx_records_collection_created ON records (collection, created_at DESC);
