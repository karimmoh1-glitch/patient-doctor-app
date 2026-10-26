/**
 * Creates (or rotates the password of) the LOGIN role the running application should connect as, and checks
 * that it is as restricted as intended. Run by an operator, with the OWNER connection string:
 *
 *   DATABASE_URL=<owner url> AVELA_RUNTIME_PASSWORD='<32+ random characters>' npm run db:create-app-role
 *   DATABASE_URL=<owner url> npm run db:create-app-role -- --check        (verify only; changes nothing)
 *
 * The password comes from the environment you supply and is NEVER printed or logged. You then build the
 * application's connection string yourself (same host and database as DATABASE_URL, user `avela_runtime`,
 * that password) and set it as APP_DATABASE_URL, together with DB_ENFORCE_RLS=on. See docs/SECURITY.md for the
 * staged rollout and for how to go back.
 *
 * The group role `avela_app` and its privileges and policies come from migration 0014; this script only adds a
 * login member of it.
 */
import "dotenv/config";
import pg from "pg";

const LOGIN_ROLE = "avela_runtime";

async function check(client: pg.PoolClient): Promise<boolean> {
  const problems: string[] = [];
  const role = await client.query(
    `SELECT rolsuper, rolbypassrls, rolcreatedb, rolcreaterole, rolcanlogin FROM pg_roles WHERE rolname = $1`,
    [LOGIN_ROLE],
  );
  if (!role.rowCount) problems.push(`role ${LOGIN_ROLE} does not exist`);
  else {
    const r = role.rows[0];
    if (r.rolsuper) problems.push("is a superuser");
    if (r.rolbypassrls) problems.push("bypasses row-level security");
    if (r.rolcreatedb || r.rolcreaterole) problems.push("can create databases or roles");
    if (!r.rolcanlogin) problems.push("cannot log in");
  }
  const member = await client.query(`SELECT pg_has_role($1, 'avela_app', 'member') AS ok`, [LOGIN_ROLE]).catch(() => ({ rows: [{ ok: false }] }));
  if (!member.rows[0].ok) problems.push("is not a member of avela_app");

  const priv = await client.query(
    `SELECT has_table_privilege($1, 'users', 'TRUNCATE') AS truncate,
            has_table_privilege($1, 'audit_logs', 'UPDATE') AS audit_update,
            has_table_privilege($1, 'audit_logs', 'DELETE') AS audit_delete,
            has_table_privilege($1, 'prescription_events', 'UPDATE') AS rx_update,
            has_table_privilege($1, 'schema_migrations', 'SELECT') AS migrations,
            has_schema_privilege($1, 'public', 'CREATE') AS create_in_schema,
            has_table_privilege($1, 'medications', 'SELECT') AS can_read,
            (SELECT tableowner FROM pg_tables WHERE schemaname = 'public' AND tablename = 'users') = $1 AS owns`,
    [LOGIN_ROLE],
  ).catch(() => null);
  if (priv) {
    const p = priv.rows[0];
    if (p.truncate) problems.push("can TRUNCATE tables");
    if (p.audit_update || p.audit_delete || p.rx_update) problems.push("can edit the append-only records");
    if (p.migrations) problems.push("can read the migration record");
    if (p.create_in_schema) problems.push("can create objects in the schema");
    if (!p.can_read) problems.push("cannot read application tables (grants not applied)");
    if (p.owns) problems.push("owns the tables");
  }
  const rls = await client.query(`SELECT count(*)::int AS n FROM pg_class WHERE relkind = 'r' AND relrowsecurity AND relnamespace = 'public'::regnamespace`);
  if (rls.rows[0].n < 15) problems.push(`row-level security is on for only ${rls.rows[0].n} tables (migration 0014 not applied?)`);

  if (problems.length) {
    for (const p of problems) console.error(`FAIL  ${LOGIN_ROLE}: ${p}`);
    return false;
  }
  console.log(`PASS  ${LOGIN_ROLE} is a restricted login member of avela_app; row-level security is on for ${rls.rows[0].n} tables.`);
  return true;
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL (the OWNER connection) must be set.");
  const verifyOnly = process.argv.includes("--check");
  const pool = new pg.Pool({ connectionString: url, max: 1 });
  const client = await pool.connect();
  try {
    if (!verifyOnly) {
      const password = process.env.AVELA_RUNTIME_PASSWORD;
      if (!password || password.length < 32) throw new Error("Set AVELA_RUNTIME_PASSWORD to at least 32 random characters (it is never printed).");
      const have = await client.query("SELECT 1 FROM pg_roles WHERE rolname = 'avela_app'");
      if (!have.rowCount) throw new Error("The role avela_app does not exist. Apply migration 0014 first (npm run db:migrate).");
      // CREATE/ALTER ROLE cannot take a bind parameter for the password, so quote it as a literal.
      const literal = client.escapeLiteral(password);
      const exists = await client.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [LOGIN_ROLE]);
      if (exists.rowCount) {
        await client.query(`ALTER ROLE ${LOGIN_ROLE} WITH LOGIN PASSWORD ${literal} NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`);
        console.log(`Rotated the password of ${LOGIN_ROLE}.`);
      } else {
        await client.query(`CREATE ROLE ${LOGIN_ROLE} WITH LOGIN PASSWORD ${literal} NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS IN ROLE avela_app`);
        console.log(`Created ${LOGIN_ROLE}.`);
      }
      await client.query("GRANT avela_app TO " + LOGIN_ROLE);
      await client.query("SELECT avela_apply_grants()");
    }
    const ok = await check(client);
    if (!ok) process.exitCode = 1;
    else if (!verifyOnly) {
      console.log("\nNext (docs/SECURITY.md, 'Rolling out the restricted role'):");
      console.log(`  1. Build APP_DATABASE_URL: the same host and database as DATABASE_URL, user ${LOGIN_ROLE}, the password you supplied.`);
      console.log("  2. Set APP_DATABASE_URL and DB_ENFORCE_RLS=on on the host and redeploy. DATABASE_URL stays the owner (migrations).");
      console.log("  3. Run the live checks. To go back: remove APP_DATABASE_URL and DB_ENFORCE_RLS and redeploy.");
    }
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  // The message of a failed CREATE ROLE can echo the statement; print only what we composed or the error code.
  console.error(err?.code ? `Failed (${err.code}).` : err?.message?.startsWith("Set ") || err?.message?.startsWith("The role") || err?.message?.startsWith("DATABASE_URL") ? err.message : "Failed.");
  process.exit(1);
});
