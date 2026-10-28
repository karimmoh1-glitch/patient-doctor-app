import { describe, it, expect } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import pg from "pg";
import { runMigrations } from "../script/migrate";
import { fingerprintLines, md5 } from "../script/lib/fingerprint";

// The release applies migrations 0024..0027 together and the recovery procedure undoes them in reverse. This proves that, on a scratch database
// built to production's state (migrations 0000-0023, whose fingerprint was compared with production's own): the four apply, are idempotent as
// a set, and their rollback scripts, run newest first, restore the production structure EXACTLY.
const FIRST_RELEASE_MIGRATION = "0024_close_rls_gaps.sql";

describe("the release's migrations and their rollback, as a chain", () => {
  it("apply on top of production's state and roll back, newest first, to exactly that state", async () => {
    const admin = new pg.Pool({ connectionString: new URL("/postgres", process.env.DATABASE_URL!).toString(), max: 1 });
    const name = "avela_chain_test";
    await admin.query(`DROP DATABASE IF EXISTS ${name}`);
    await admin.query(`CREATE DATABASE ${name}`);
    const url = new URL(`/${name}`, process.env.DATABASE_URL!).toString().split("?")[0];
    const scratch = new pg.Pool({ connectionString: url, max: 1 });
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "avela-chain-"));
    try {
      const all = fs.readdirSync("migrations").filter((f) => f.endsWith(".sql")).sort();
      const release = all.filter((f) => f >= FIRST_RELEASE_MIGRATION);
      for (const f of all.filter((f) => f < FIRST_RELEASE_MIGRATION)) fs.copyFileSync(path.join("migrations", f), path.join(tmp, f));
      await runMigrations(url, tmp);
      const q = async (sql: string) => (await scratch.query(sql)).rows as Record<string, any>[];
      const snapshot = async () => (await fingerprintLines(q)).filter((l) => !l.startsWith("migration\t"));
      const before = await snapshot();

      expect((await runMigrations(url)).length, "the release's migrations apply").toBe(release.length);
      const after = await snapshot();
      expect(md5(after.join("\n"))).not.toBe(md5(before.join("\n")));
      expect((await runMigrations(url)).length, "and applying again does nothing").toBe(0);

      for (const f of [...release].reverse()) {
        const down = path.join("ops", "rollback", f.replace(/\.sql$/, ".down.sql"));
        expect(fs.existsSync(down), `a rollback script exists for ${f}`).toBe(true);
        await scratch.query(fs.readFileSync(down, "utf8"));
      }
      const restored = await snapshot();
      const diff = before.filter((l) => !restored.includes(l)).concat(restored.filter((l) => !before.includes(l)));
      expect(diff.slice(0, 5)).toEqual([]);
      expect((await q("SELECT name FROM schema_migrations")).map((r) => r.name).sort()).toEqual(all.filter((f) => f < FIRST_RELEASE_MIGRATION));
    } finally {
      await scratch.end();
      await admin.query(`DROP DATABASE IF EXISTS ${name}`);
      await admin.end();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }, 120_000);
});
