import { emergencyDataReviewed } from "./emergencyInfo";
import { withScope } from "../dbContext";
import { attestedSourceNames } from "./schedulerRun";
export interface Check {
  id: string;
  level: "fail" | "warn" | "ok";
  message: string;
}

interface Queryable {
  query(sql: string): Promise<{ rows: any[] }>;
}

/**
 * Is this deployment safe to open to real people? Every "fail" is a hard
 * blocker. It reports configuration and counts only; it prints no secret and
 * no patient information. Run it before any real-patient launch:
 *   npm run verify:production
 */
export function checkReadiness(env: NodeJS.ProcessEnv, db: Queryable): Promise<Check[]> {
  // These are counts over every account and every scheduler call. Through the restricted role with nobody established they
  // would all read zero (row-level security), and "no demo account is active" would pass for the wrong reason.
  return withScope("ops", () => readiness(env, db));
}

async function readiness(env: NodeJS.ProcessEnv, db: Queryable): Promise<Check[]> {
  const out: Check[] = [];
  const add = (id: string, ok: boolean, level: "fail" | "warn", good: string, bad: string) =>
    out.push({ id, level: ok ? "ok" : level, message: ok ? good : bad });

  add("node-env", env.NODE_ENV === "production", "fail", "NODE_ENV is production", "NODE_ENV is not production");
  add("jwt-secret", (env.JWT_SECRET ?? "").length >= 32, "fail", "JWT_SECRET is set and long enough", "JWT_SECRET is missing or shorter than 32 characters");
  add("demo-absent", (env.DEMO_MODE === undefined || env.DEMO_MODE === "" || env.DEMO_MODE === "false") && !env.DEMO_MODE_ACKNOWLEDGED, "fail",
    "No demo setting is present", "DEMO_MODE or DEMO_MODE_ACKNOWLEDGED is set: remove it (production refuses to start with it)");
  add("app-url", /^https:\/\//.test(env.APP_URL ?? ""), "fail", "APP_URL is https", "APP_URL is missing or not https (links in emails would be unsafe)");
  add("cron-secret", (env.CRON_SECRET ?? "").length >= 24, "fail", "CRON_SECRET is set", "CRON_SECRET is missing or short: reminders cannot be delivered");
  add("email", !!env.RESEND_API_KEY, "fail", "An email provider is configured", "No email provider: password resets and email confirmation cannot reach anyone, so a locked-out person has no way back");
  // The built-in default sender belongs to a domain nobody here has verified: providers refuse or spam-fold mail from it.
  add("email-from", !env.RESEND_API_KEY || !!env.EMAIL_FROM?.trim(), "fail", "The sender address is set explicitly", "EMAIL_FROM is not set: mail would go out from the built-in default address, on a domain that has not been verified for sending");
  add("email-receipts", !!env.RESEND_WEBHOOK_SECRET, "warn", "E-mail delivery reports are accepted (webhook secret set)", "No RESEND_WEBHOOK_SECRET: Avela can say only that e-mail was accepted, never that it was delivered or bounced");
  add("support", !!(env.SUPPORT_PHONE || env.SUPPORT_EMAIL), "warn", "A support contact is published", "No support phone or email is configured; the Help page says nobody can be reached");
  const emergency = emergencyDataReviewed(env);
  add("emergency-data", emergency.ok, "fail", "A person has reviewed the emergency numbers for every supported country",
    `Emergency numbers not reviewed by a person for: ${emergency.missing.join(", ")}. Compare shared/emergency.ts with its sources, then set EMERGENCY_DATA_REVIEWED_BY to your name (the screens show no number in production until then)`);

  // Database protection (docs/SECURITY.md): the application should run as the restricted role with row-level security enforced.
  add("rls-enforced", !!env.APP_DATABASE_URL && env.DB_ENFORCE_RLS === "on", "fail",
    "The application connects as the restricted database role with row-level security enforced",
    "APP_DATABASE_URL and DB_ENFORCE_RLS=on are not both set: the application runs with full database privileges (npm run db:create-app-role)");
  add("owner-role-exception", env.ALLOW_OWNER_DATABASE_ROLE !== "true", "fail",
    "No exception allows the owner database role", "ALLOW_OWNER_DATABASE_ROLE=true: the application is knowingly running as the table owner");
  add("heartbeat", !!env.SCHEDULER_HEARTBEAT_URL, "warn", "A heartbeat monitor is notified after each scheduler run", "No SCHEDULER_HEARTBEAT_URL: nothing outside Avela notices if the scheduler stops calling");
  add("ops-alert", !!env.OPS_ALERT_EMAIL, "warn", "Scheduler failures are e-mailed to an operator", "No OPS_ALERT_EMAIL: a failing scheduler is visible only in the admin screen");

  const count = async (sql: string) => Number((await db.query(sql)).rows[0]?.n ?? 0);
  const activeDemo = await count("SELECT count(*)::int AS n FROM users WHERE is_demo AND deactivated_at IS NULL");
  add("demo-accounts", activeDemo === 0, "fail", "No demo account is active", `${activeDemo} demo account(s) are still active (npm run demo:retire)`);
  const seededDoctors = await count("SELECT count(*)::int AS n FROM doctor_profiles WHERE source = 'seed' AND active");
  add("demo-doctors", seededDoctors === 0, "fail", "No seeded demonstration doctor is listed", `${seededDoctors} seeded demonstration doctor profile(s) are still listed`);
  const admins = await count("SELECT count(*)::int AS n FROM users WHERE role = 'admin' AND NOT is_demo AND deactivated_at IS NULL");
  add("admin", admins >= 1, "fail", "A real administrator exists", "No real administrator: run npm run admin:create");
  const lastRun = await db.query("SELECT last_success_at FROM job_runs WHERE job = 'reminders'");
  const ageMin = lastRun.rows[0]?.last_success_at ? (Date.now() - new Date(lastRun.rows[0].last_success_at).getTime()) / 60_000 : Infinity;
  add("reminder-job", ageMin <= 30, "fail", "The reminder scheduler ran successfully in the last 30 minutes", "The reminder scheduler has not run successfully in the last 30 minutes");
  // Every table behind row-level security, and nothing executable by the application role beyond the policy helpers
  // (migration 0024). The migration record is protected by a missing privilege instead of a policy.
  const bare = await db.query("SELECT relname FROM pg_class WHERE relkind = 'r' AND relnamespace = 'public'::regnamespace AND NOT relrowsecurity ORDER BY 1");
  add("rls-complete", bare.rows.length === 0, "fail", "Every table is behind row-level security",
    `${bare.rows.length} table(s) are outside row-level security: ${bare.rows.map((r: { relname: string }) => r.relname).join(", ")} (migration 0024)`);
  // Signed identities (migration 0025): the database must be enforcing them, with a key registered. Until then it still honours the plain
  // settings an attacker with SQL could write, and the roll-out is not finished.
  const identity = await db
    .query("SELECT (SELECT enforce FROM app_identity_config LIMIT 1) AS enforce, (SELECT count(*)::int FROM app_identity_keys WHERE retired_at IS NULL) AS keys")
    .catch(() => ({ rows: [{ enforce: false, keys: 0 }] }));
  const idRow = identity.rows[0] as { enforce: boolean | null; keys: number };
  add("identity-enforced", idRow.enforce === true && idRow.keys >= 1, "fail", "The database verifies signed identities and ignores plain settings (a key is registered)",
    `Signed identities are not enforced (enforce=${idRow.enforce}, active keys=${idRow.keys}): run the release procedure, then \`npm run identity:enforce -- on\``);
  const appRole = await db.query("SELECT r.rolcanlogin, r.rolsuper, r.rolbypassrls FROM pg_roles r WHERE r.rolname = 'avela_runtime'");
  const role = appRole.rows[0];
  add("app-role", !!role && role.rolcanlogin && !role.rolsuper && !role.rolbypassrls, "fail",
    "The restricted login role (avela_runtime) exists and cannot bypass row-level security",
    "The restricted login role avela_runtime does not exist (npm run db:create-app-role)");

  // Has anything really been calling the scheduler? Our own records, not a workflow file. One call is expected every 5 minutes.
  // A person's manual check proves the endpoint works; it is not a scheduler, so it counts for nothing here. A caller is
  // "dependable" only if ONE source the SERVER attested (it presented that caller's own secret; a label in a header proves
  // nothing) made nearly every expected call: GitHub's best-effort schedule, a daily cron, a handful of lucky calls or a
  // look-alike label must not read as a scheduler.
  const expected = 288;
  const bySource = await db.query(
    "SELECT source, count(*)::int AS n FROM job_run_history WHERE job = 'reminders' AND outcome <> 'skipped_overlap' AND source <> 'manual-verification' AND started_at > now() - interval '24 hours' GROUP BY source",
  );
  const calls = (bySource.rows as { n: number }[]).reduce((sum, r) => sum + Number(r.n), 0);
  add("scheduler-history", calls >= 0.9 * expected, "fail", `The scheduler called ${calls} times in the last 24 hours`, `The scheduler called only ${calls} times in the last 24 hours (about ${expected} expected; manual checks are not counted)`);
  const attested = attestedSourceNames();
  const dependable = (bySource.rows as { source: string; n: number }[]).some((r) => attested.includes(r.source) && Number(r.n) >= 0.9 * expected);
  add("scheduler-caller", dependable, "fail", "A dedicated scheduler, identified by its own secret, made nearly every expected call in the last 24 hours", `No attested scheduler (${attested.join(", ")}) made 90% of the expected calls in the last 24 hours (GitHub Actions' best-effort schedule, a daily cron, manual checks and look-alike labels do not qualify)`);
  return out;
}
