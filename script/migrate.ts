/**
 * Applies hand-written SQL migrations from ./migrations, once each, in
 * filename order, each inside a transaction, recorded in schema_migrations.
 *
 * Why this exists: `drizzle-kit push` is fine for creating tables in local
 * development and tests, but it does not detect changes to partial-index
 * predicates or custom constraints, and it must never be pointed at
 * production. Anything push can't express goes in a numbered .sql file here.
 *
 * Usage: DATABASE_URL=... npm run db:migrate
 */
import "dotenv/config";
import fs from "fs";
import path from "path";
import pg from "pg";
import { fileURLToPath } from "url";

const BASELINE = "0000_baseline.sql";

export async function runMigrations(databaseUrl: string, dir = path.resolve(process.cwd(), "migrations")): Promise<string[]> {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  const applied: string[] = [];
  try {
    await pool.query(
      "CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())",
    );
    const done = new Set((await pool.query("SELECT name FROM schema_migrations")).rows.map((r) => r.name as string));

    // A database created earlier by `drizzle-kit push` already has the
    // baseline schema: record it as applied rather than failing on
    // "relation already exists".
    if (!done.has(BASELINE)) {
      const existing = await pool.query("SELECT to_regclass('public.users') AS t");
      if (existing.rows[0].t) {
        await pool.query("INSERT INTO schema_migrations (name) VALUES ($1) ON CONFLICT DO NOTHING", [BASELINE]);
        done.add(BASELINE);
      }
    }
    const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith(".sql")).sort() : [];
    for (const file of files) {
      if (done.has(file)) continue;
      const sql = fs.readFileSync(path.join(dir, file), "utf8");
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [file]);
        await client.query("COMMIT");
        applied.push(file);
      } catch (err) {
        await client.query("ROLLBACK");
        throw new Error(`Migration ${file} failed and was rolled back: ${(err as Error).message}`);
      } finally {
        client.release();
      }
    }
  } finally {
    await pool.end();
  }
  return applied;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL must be set");
  runMigrations(process.env.DATABASE_URL)
    .then((applied) => console.log(applied.length ? `Applied: ${applied.join(", ")}` : "No pending migrations."))
    .catch((err) => {
      console.error(err.message);
      process.exit(1);
    });
}
