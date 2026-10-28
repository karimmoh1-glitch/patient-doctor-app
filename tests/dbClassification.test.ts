import { describe, it, expect } from "vitest";
import { operatorPool } from "./helpers";
import { CLASSIFICATION } from "../script/dbClassification";

// The access audit (docs/DATABASE_ACCESS_AUDIT.md) is only as good as its inventory. A table added without saying what it holds
// and who may reach it fails here, and so does an entry for a table that no longer exists.
describe("the database access inventory", () => {
  it("classifies every table and view in the schema, and nothing else", async () => {
    const { rows } = await operatorPool().query(`SELECT relname FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relkind IN ('r', 'v') ORDER BY 1`);
    const actual = rows.map((r) => r.relname as string);
    expect(actual.filter((t) => !(t in CLASSIFICATION)), "tables with no entry in script/dbClassification.ts").toEqual([]);
    expect(Object.keys(CLASSIFICATION).filter((t) => !actual.includes(t)), "entries for tables that do not exist").toEqual([]);
  });
});
