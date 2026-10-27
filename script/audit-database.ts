/**
 * The database access audit, from the catalog: for every table, whether row-level security is on and enforced, which policies
 * exist, what the application role may do, and who owns it; beside what the table is for (script/dbClassification.ts). Read-only.
 *
 *   npm run audit:db                 prints the findings and exits 1 if there is any
 *   npm run audit:db -- --markdown   prints the inventory table used in docs/DATABASE_ACCESS_AUDIT.md
 *
 * Findings: a table outside row-level security; a table with RLS but no policy (other than the migration record); a table with
 * no classification; the application role holding more than SELECT/INSERT/UPDATE/DELETE, or write access to an append-only
 * table; a function executable by PUBLIC or, for the application role, beyond the policy helpers; a SECURITY DEFINER function
 * without a fixed search_path; the application role being a superuser, owner or able to bypass row-level security.
 */
import "dotenv/config";
import "./asOperator";
import { pool } from "../server/db";
import { CLASSIFICATION } from "./dbClassification";

const q = async (sql: string) => (await pool.query(sql)).rows as Record<string, any>[];
const APPEND_ONLY = ["audit_logs", "prescription_events"];
// Owner-only tables: row-level security on, no policy, and no privilege at all for the application role.
const OWNER_ONLY = ["schema_migrations", "app_identity_keys", "app_identity_config"];

async function main() {
  const findings: string[] = [];
  const ownerName = (await q(`SELECT tableowner FROM pg_tables WHERE schemaname = 'public' AND tablename = 'users'`))[0]?.tableowner as string;
  const hasApp = (await q(`SELECT 1 FROM pg_roles WHERE rolname = 'avela_app'`)).length > 0;
  const rels = await q(`SELECT c.oid, c.relname, c.relkind, c.relrowsecurity AS rls, pg_get_userbyid(c.relowner) AS owner,
                               (SELECT string_agg(p.cmd || ':' || p.policyname, ', ' ORDER BY p.policyname) FROM pg_policies p WHERE p.schemaname = 'public' AND p.tablename = c.relname) AS policies,
                               (SELECT count(*)::int FROM pg_policy p WHERE p.polrelid = c.oid) AS npolicies
                          FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r','v') ORDER BY c.relname`);
  const privs = new Map<string, string>();
  if (hasApp) {
    for (const r of await q(`SELECT c.relname, string_agg(p.priv, ',' ORDER BY p.priv) AS granted
                               FROM pg_class c CROSS JOIN (VALUES ('SELECT'),('INSERT'),('UPDATE'),('DELETE'),('TRUNCATE'),('REFERENCES'),('TRIGGER')) p(priv)
                              WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r','v') AND has_table_privilege('avela_app', c.oid, p.priv) GROUP BY c.relname`))
      privs.set(r.relname, r.granted);
  }
  const rows: string[] = [];
  for (const r of rels) {
    const facts = CLASSIFICATION[r.relname];
    const granted = privs.get(r.relname) ?? "(none)";
    if (!facts) findings.push(`${r.relname}: no entry in script/dbClassification.ts`);
    if (r.relkind === "r" && !r.rls) findings.push(`${r.relname}: outside row-level security`);
    if (r.relkind === "r" && r.rls && r.npolicies === 0 && !OWNER_ONLY.includes(r.relname)) findings.push(`${r.relname}: row-level security on but no policy (nobody but the owner can use it)`);
    if (r.relkind === "r" && r.owner !== ownerName) findings.push(`${r.relname}: owned by ${r.owner}, not the schema owner`);
    if (hasApp && /TRUNCATE|REFERENCES|TRIGGER/.test(granted)) findings.push(`${r.relname}: the application role holds ${granted}`);
    if (hasApp && APPEND_ONLY.includes(r.relname) && /UPDATE|DELETE/.test(granted)) findings.push(`${r.relname}: append-only table is writable by the application role (${granted})`);
    if (hasApp && OWNER_ONLY.includes(r.relname) && granted !== "(none)") findings.push(`${r.relname}: the application role holds ${granted}`);
    if (hasApp && r.relkind === "v" && /INSERT|UPDATE|DELETE/.test(granted)) findings.push(`${r.relname}: a view the application role can write through (runs with the owner's rights)`);
    const c = facts ?? { data: ["?"], whose: "?", path: [], boundary: "?" };
    rows.push(`| \`${r.relname}\`${r.relkind === "v" ? " (view)" : ""} | ${c.data.join(", ")} | ${c.whose} | ${r.relkind === "v" ? "n/a (owner's rights)" : r.rls ? "on" : "**OFF**"} | ${r.npolicies} | ${granted.replace(/DELETE/g, "D").replace(/INSERT/g, "I").replace(/SELECT/g, "S").replace(/UPDATE/g, "U")} | ${c.path.join(", ") || "none"} | ${c.boundary} |`);
  }
  for (const name of Object.keys(CLASSIFICATION)) if (!rels.some((r) => r.relname === name)) findings.push(`${name}: classified but does not exist`);

  if (hasApp) {
    // Which columns of an account the application role can read: exactly the ones that identify a person (migration 0026).
    const readable = (await q(`SELECT a.attname FROM pg_attribute a WHERE a.attrelid = 'public.users'::regclass AND a.attnum > 0 AND NOT a.attisdropped AND has_column_privilege('avela_app', 'public.users', a.attname, 'SELECT') ORDER BY 1`)).map((r) => r.attname as string);
    const expected = ["created_at", "deactivated_at", "email_verified_at", "id", "is_demo", "language", "name", "read_receipts", "role", "timezone"];
    if (JSON.stringify(readable) !== JSON.stringify(expected)) findings.push(`users: the application role can read [${readable.join(", ")}] but only [${expected.join(", ")}] are meant to be readable`);
  }
  const fns = await q(`SELECT p.proname, p.prosecdef, p.proconfig::text AS cfg, ${hasApp ? "has_function_privilege('avela_app', p.oid, 'EXECUTE')" : "false"} AS app_exec,
                              EXISTS (SELECT 1 FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE') AS public_exec
                         FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.prokind = 'f' AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e') ORDER BY 1`);
  for (const f of fns) {
    if (f.public_exec) findings.push(`function ${f.proname}: executable by PUBLIC`);
    if (f.app_exec && !String(f.proname).startsWith("app_")) findings.push(`function ${f.proname}: executable by the application role but is not a policy helper`);
    if (f.prosecdef && !/search_path/.test(f.cfg ?? "")) findings.push(`function ${f.proname}: SECURITY DEFINER without a fixed search_path`);
  }
  if (hasApp) {
    for (const r of await q(`SELECT rolname, rolsuper, rolbypassrls, rolcreatedb, rolcreaterole FROM pg_roles WHERE rolname IN ('avela_app', 'avela_runtime')`)) {
      if (r.rolsuper || r.rolbypassrls || r.rolcreatedb || r.rolcreaterole) findings.push(`role ${r.rolname}: has elevated attributes`);
    }
  }

  if (process.argv.includes("--markdown")) {
    console.log("| Table | Data | Whose / what | RLS | Policies | App role (S/I/U/D) | Reached by | Boundary |\n| --- | --- | --- | --- | --- | --- | --- | --- |");
    console.log(rows.join("\n"));
    console.log(`\nSECURITY DEFINER functions: ${fns.filter((f) => f.prosecdef).map((f) => f.proname).join(", ")}`);
    console.log(`Policy helpers the application role may execute: ${fns.filter((f) => f.app_exec).map((f) => f.proname).join(", ")}`);
    console.log(`Functions it may not execute: ${fns.filter((f) => !f.app_exec).map((f) => f.proname).join(", ")}`);
  }
  console.error(`${rels.filter((r) => r.relkind === "r").length} tables, ${rels.filter((r) => r.relkind === "r" && r.rls).length} behind row-level security, ${fns.length} functions, ${findings.length} finding(s).`);
  for (const f of findings) console.error(`FINDING  ${f}`);
  if (findings.length) process.exitCode = 1;
}

main()
  .catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
