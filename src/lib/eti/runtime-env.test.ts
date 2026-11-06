import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MIGRATIONS } from "./storage/sql-store";
import { mergeEnv } from "./runtime-env";

describe("runtime env", () => {
  it("merges worker string bindings over process.env and ignores non-strings (e.g. D1)", () => {
    const e = mergeEnv({ A: "1", B: "old" }, { B: "new", C: "3", DB: { prepare() {} }, N: 5 });
    expect(e).toEqual({ A: "1", B: "new", C: "3" });
  });
  it("tolerates missing sources", () => {
    expect(mergeEnv(undefined, undefined)).toEqual({});
  });
});

describe("D1 migration file stays in sync with the runtime schema", () => {
  it("0001_init.sql contains exactly the v1 statements", () => {
    const sql = readFileSync("cloudflare/migrations/0001_init.sql", "utf8")
      .split("\n")
      .filter((l) => l.trim() && !l.startsWith("--"))
      .map((l) => l.trim().replace(/;$/, ""));
    expect(sql).toEqual(MIGRATIONS[0]!.statements);
  });
});
