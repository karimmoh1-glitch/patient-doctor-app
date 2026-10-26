/**
 * A canonical, secret-free description of a database's structure and protections, one line per fact, sorted: tables and
 * their columns, constraints, indexes, row-level-security state and policies, triggers, functions (by a hash of their
 * source), views, and what the application role may do. Read-only.
 *
 *   npm run schema:fingerprint > local.txt            (against DATABASE_URL, the owner connection)
 *   diff local.txt production.txt                     (an empty diff means the structures are identical)
 *
 * Why: "the migrations say X" and "the production database is X" are different claims. This is how the second one is checked
 * before a migration is applied, and after (docs/OPERATIONS_RUNBOOK.md, "Applying a migration"). It prints no row data.
 */
import crypto from "crypto";

export type Query = (sql: string) => Promise<Record<string, any>[]>;
export const md5 = (s: string) => crypto.createHash("md5").update(s).digest("hex").slice(0, 12);

/** One canonical line per structural fact, sorted. The owner's name is normalised; row data is never read. */
export async function fingerprintLines(q: Query): Promise<string[]> {
  const lines: string[] = [];
  const add = (kind: string, ...parts: unknown[]) => lines.push(`${kind}\t${parts.map((p) => (p === null || p === undefined ? "∅" : String(p).replace(/\s+/g, " ").trim())).join("\t")}`);
  // The owner's name differs between installations (a managed provider's, a developer's); only whether a thing is owned by THE owner matters.
  const ownerName = (await q(`SELECT tableowner FROM pg_tables WHERE schemaname = 'public' AND tablename = 'users'`))[0]?.tableowner;
  const who = (name: string) => (name === ownerName ? "OWNER" : name);
  const where = "n.nspname = 'public'";
  for (const r of await q(`SELECT c.relname, c.relkind, c.relrowsecurity, c.relforcerowsecurity, pg_get_userbyid(c.relowner) AS owner, c.reloptions::text AS opts
                             FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE ${where} AND c.relkind IN ('r','v','m','S') ORDER BY 1`))
    add("relation", r.relname, r.relkind, `rls=${r.relrowsecurity}`, `force=${r.relforcerowsecurity}`, `owner=${who(r.owner)}`, r.opts);
  for (const r of await q(`SELECT c.relname, a.attname, format_type(a.atttypid, a.atttypmod) AS type, a.attnotnull, pg_get_expr(d.adbin, d.adrelid) AS def, a.attidentity, a.attgenerated
                             FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
                             LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
                            WHERE ${where} AND c.relkind IN ('r','v') AND a.attnum > 0 AND NOT a.attisdropped ORDER BY 1, 2`))
    add("column", `${r.relname}.${r.attname}`, r.type, r.attnotnull ? "not null" : "null", r.def, r.attidentity, r.attgenerated);
  for (const r of await q(`SELECT c.relname, con.conname, pg_get_constraintdef(con.oid) AS def FROM pg_constraint con JOIN pg_class c ON c.oid = con.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE ${where} AND con.contype <> 'n' ORDER BY 1, 2`)) // NOT NULL appears as a constraint only on newer servers; the column line already says it
    add("constraint", `${r.relname}.${r.conname}`, r.def);
  for (const r of await q(`SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'public' ORDER BY 1`)) add("index", r.indexname, r.indexdef);
  for (const r of await q(`SELECT tablename, policyname, cmd, roles::text, qual, with_check, permissive FROM pg_policies WHERE schemaname = 'public' ORDER BY 1, 2`))
    add("policy", `${r.tablename}.${r.policyname}`, r.cmd, r.roles, r.permissive, r.qual, r.with_check);
  for (const r of await q(`SELECT c.relname, t.tgname, pg_get_triggerdef(t.oid) AS def FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE ${where} AND NOT t.tgisinternal ORDER BY 1, 2`))
    add("trigger", `${r.relname}.${r.tgname}`, r.def);
  for (const r of await q(`SELECT p.proname, pg_get_function_identity_arguments(p.oid) AS args, p.prosecdef, p.provolatile, p.proconfig::text AS cfg, md5(p.prosrc) AS src,
                                  has_function_privilege('avela_app', p.oid, 'EXECUTE') AS app_exec,
                                  EXISTS (SELECT 1 FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE') AS public_exec
                             FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE ${where} AND p.prokind = 'f' ORDER BY 1, 2`))
    add("function", `${r.proname}(${r.args})`, `definer=${r.prosecdef}`, `volatility=${r.provolatile}`, r.cfg, `src=${r.src.slice(0, 12)}`, `app_exec=${r.app_exec}`, `public_exec=${r.public_exec}`);
  for (const r of await q(`SELECT c.relname, pg_get_viewdef(c.oid) AS def FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE ${where} AND c.relkind = 'v' ORDER BY 1`)) add("view", r.relname, md5(r.def));
  // What the application role may do, per table. (The role may not exist on a database that never created it.)
  const hasRole = (await q(`SELECT 1 FROM pg_roles WHERE rolname = 'avela_app'`)).length > 0;
  if (hasRole) {
    for (const r of await q(`SELECT c.relname, string_agg(p.priv, ',' ORDER BY p.priv) AS granted
                               FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace CROSS JOIN (VALUES ('SELECT'),('INSERT'),('UPDATE'),('DELETE'),('TRUNCATE'),('REFERENCES'),('TRIGGER')) p(priv)
                              WHERE ${where} AND c.relkind IN ('r','v') AND has_table_privilege('avela_app', c.oid, p.priv) GROUP BY c.relname ORDER BY 1`))
      add("app-privileges", r.relname, r.granted);
  }
  // Default privileges for future objects the OWNER creates, per schema (the owner's name is normalised).
  for (const r of await q(`SELECT pg_get_userbyid(defaclrole) AS creator, COALESCE(n.nspname, '(all schemas)') AS schema, defaclobjtype AS kind, defaclacl::text AS acl FROM pg_default_acl d LEFT JOIN pg_namespace n ON n.oid = d.defaclnamespace WHERE pg_get_userbyid(defaclrole) = '${ownerName}' ORDER BY 1, 2, 3`)) // the provider's own defaults (cloud_admin) are not ours
    add("default-privileges", who(r.creator), r.schema, r.kind, String(r.acl).replace(new RegExp(`${ownerName}`, "g"), "OWNER"));
  for (const r of await q(`SELECT name FROM schema_migrations ORDER BY name`)) add("migration", r.name);

  lines.sort();
  return lines;
}
