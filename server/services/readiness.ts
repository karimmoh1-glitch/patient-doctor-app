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
export async function checkReadiness(env: NodeJS.ProcessEnv, db: Queryable): Promise<Check[]> {
  const out: Check[] = [];
  const add = (id: string, ok: boolean, level: "fail" | "warn", good: string, bad: string) =>
    out.push({ id, level: ok ? "ok" : level, message: ok ? good : bad });

  add("node-env", env.NODE_ENV === "production", "fail", "NODE_ENV is production", "NODE_ENV is not production");
  add("jwt-secret", (env.JWT_SECRET ?? "").length >= 32, "fail", "JWT_SECRET is set and long enough", "JWT_SECRET is missing or shorter than 32 characters");
  add("demo-off", env.DEMO_MODE !== "true", "fail", "DEMO_MODE is off", "DEMO_MODE=true: demo accounts and simulated features are enabled");
  add("demo-ack-unset", !env.DEMO_MODE_ACKNOWLEDGED, "fail", "DEMO_MODE_ACKNOWLEDGED is not set", "DEMO_MODE_ACKNOWLEDGED is set: remove it");
  add("app-url", /^https:\/\//.test(env.APP_URL ?? ""), "fail", "APP_URL is https", "APP_URL is missing or not https (links in emails would be unsafe)");
  add("cron-secret", (env.CRON_SECRET ?? "").length >= 24, "fail", "CRON_SECRET is set", "CRON_SECRET is missing or short: reminders cannot be delivered");
  add("email", !!env.RESEND_API_KEY, "warn", "An email provider is configured", "No email provider: password resets and email reminders cannot be sent");
  add("support", !!(env.SUPPORT_PHONE || env.SUPPORT_EMAIL), "warn", "A support contact is published", "No support phone or email is configured; the Help page says nobody can be reached");
  add("emergency-number", !!env.VITE_EMERGENCY_NUMBER, "warn", "The emergency number is set for this country", "VITE_EMERGENCY_NUMBER is not set: the default (911) is shown");
  add("ai-phi", !(env.OPENAI_API_KEY && env.AI_PHI_PROCESSING_CONFIRMED === "true"), "warn", "No health information is sent to an AI provider", "Health information may be sent to an AI provider: confirm the agreement exists");

  // Database protection (docs/SECURITY.md): the application should run as the restricted role with row-level security enforced.
  add("rls-enforced", !!env.APP_DATABASE_URL && env.DB_ENFORCE_RLS === "on", "fail",
    "The application connects as the restricted database role with row-level security enforced",
    "APP_DATABASE_URL and DB_ENFORCE_RLS=on are not both set: the application runs with full database privileges (npm run db:create-app-role)");
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
  const appRole = await db.query("SELECT r.rolcanlogin, r.rolsuper, r.rolbypassrls FROM pg_roles r WHERE r.rolname = 'avela_runtime'");
  const role = appRole.rows[0];
  add("app-role", !!role && role.rolcanlogin && !role.rolsuper && !role.rolbypassrls, "fail",
    "The restricted login role (avela_runtime) exists and cannot bypass row-level security",
    "The restricted login role avela_runtime does not exist (npm run db:create-app-role)");

  // Has anything really been calling the scheduler? Our own records, not a workflow file. One call is expected every 5 minutes.
  const calls = await count("SELECT count(*)::int AS n FROM job_run_history WHERE job = 'reminders' AND outcome <> 'skipped_overlap' AND started_at > now() - interval '24 hours'");
  add("scheduler-history", calls >= 0.9 * 288, "fail", `The scheduler called ${calls} times in the last 24 hours`, `The scheduler called only ${calls} times in the last 24 hours (about 288 expected)`);
  const sources = await db.query("SELECT DISTINCT source FROM job_run_history WHERE job = 'reminders' AND started_at > now() - interval '24 hours'");
  const dependable = sources.rows.some((r) => r.source !== "github-actions" && r.source !== "unknown");
  add("scheduler-caller", dependable, "warn", "A dedicated scheduler (not only GitHub's best-effort schedule) is calling", "Only GitHub Actions' best-effort schedule (or an unnamed caller) has called in the last 24 hours");
  return out;
}
