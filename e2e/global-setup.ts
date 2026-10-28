import { execFileSync } from "child_process";
import pg from "pg";
import { runMigrations } from "../script/migrate";
import { prepareLocalIdentity } from "../script/lib/devIdentity";
import { E2E_DB, E2E_MFA_KEY } from "../playwright.config";

// Gives every e2e run a brand-new, migrated, seeded database — and refuses to
// touch anything whose name doesn't end in "_test".
export default async function globalSetup() {
  const url = new URL(E2E_DB);
  const name = url.pathname.replace(/^\//, "");
  if (!name.endsWith("_test")) throw new Error(`Refusing to reset non-test database "${name}"`);

  const adminUrl = new URL(E2E_DB);
  adminUrl.pathname = "/postgres";
  const admin = new pg.Pool({ connectionString: adminUrl.toString() });
  try {
    const exists = await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [name]);
    if (!exists.rowCount) await admin.query(`CREATE DATABASE "${name}"`);
  } finally {
    await admin.end();
  }

  const db = new pg.Pool({ connectionString: E2E_DB });
  try {
    await db.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
  } finally {
    await db.end();
  }
  await runMigrations(E2E_DB);
  await prepareLocalIdentity(E2E_DB);
  execFileSync("npx", ["tsx", "script/seed.ts"], {
    env: { ...process.env, DATABASE_URL: E2E_DB, NODE_ENV: "development", MFA_ENCRYPTION_KEY: E2E_MFA_KEY },
    stdio: "pipe",
  });
  // `npm run test:e2e:noserver`: the database REFUSES the unrestricted "server" scope, so every browser flow below must work on the narrow scopes alone.
  if (process.env.E2E_SERVER_SCOPE_OFF === "1") {
    const owner = new pg.Pool({ connectionString: E2E_DB });
    try {
      await owner.query("UPDATE app_identity_config SET allow_server_scope = false, updated_at = now()");
    } finally {
      await owner.end();
    }
  }
}
