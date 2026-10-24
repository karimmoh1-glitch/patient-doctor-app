import pg from "pg";
import { runMigrations } from "../script/migrate";

// Runs once before the whole suite: empties the (already schema-pushed)
// test database, then applies the hand-written SQL migrations. Wiping is
// what keeps runs independent, and it is only ever done on a database
// whose name ends in "_test".
export default async function setup() {
  const url = process.env.TEST_DATABASE_URL || "postgresql://karimmohamed@localhost:5432/patient_doctor_app_test";
  const name = new URL(url).pathname.replace(/^\//, "");
  if (!name.endsWith("_test")) throw new Error(`Refusing to wipe/migrate non-test database "${name}"`);

  const pool = new pg.Pool({ connectionString: url });
  try {
    const { rows } = await pool.query(
      "SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> 'schema_migrations'",
    );
    if (rows.length) {
      await pool.query(`TRUNCATE ${rows.map((r) => `"${r.tablename}"`).join(", ")} RESTART IDENTITY CASCADE`);
    }
  } finally {
    await pool.end();
  }
  await runMigrations(url);
}
