import { execFileSync } from "child_process";
import pg from "pg";
import { runMigrations } from "../script/migrate";
import { prepareLocalIdentity } from "../script/lib/devIdentity";
import { PROD_DB, PROD_SMOKE_MFA_KEY } from "../playwright.prod.config";

// A brand-new migrated and seeded database for every run; refuses anything
// whose name does not end in "_test".
export default async function globalSetup() {
  const url = new URL(PROD_DB);
  const name = url.pathname.replace(/^\//, "");
  if (!name.endsWith("_test")) throw new Error(`Refusing to reset non-test database "${name}"`);

  const adminUrl = new URL(PROD_DB);
  adminUrl.pathname = "/postgres";
  const admin = new pg.Pool({ connectionString: adminUrl.toString() });
  try {
    const exists = await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [name]);
    if (!exists.rowCount) await admin.query(`CREATE DATABASE "${name}"`);
  } finally {
    await admin.end();
  }
  const db = new pg.Pool({ connectionString: PROD_DB });
  try {
    await db.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
  } finally {
    await db.end();
  }
  await runMigrations(PROD_DB);
  await prepareLocalIdentity(PROD_DB);
  execFileSync("npx", ["tsx", "script/seed.ts"], {
    env: { ...process.env, DATABASE_URL: PROD_DB, NODE_ENV: "development", SEED_AS_REAL_ACCOUNTS: "1", MFA_ENCRYPTION_KEY: PROD_SMOKE_MFA_KEY },
    stdio: "pipe",
  });
  // One account is deliberately left marked as a fixture: the production server must refuse it and not list it.
  const mark = new pg.Pool({ connectionString: PROD_DB });
  try {
    await mark.query("UPDATE users SET is_demo = true WHERE email = 'fixture.doctor3@avela.dev'");
  } finally {
    await mark.end();
  }
}
