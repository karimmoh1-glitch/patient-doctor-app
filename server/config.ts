// Centralised, explicit switches for behaviour that must never be on by
// accident in a real deployment.

/**
 * Seeded fixture accounts (development and test databases only) may sign in
 * everywhere except production. There is no "demo mode" any more: a
 * production deployment never has demo sign-in, simulated integrations or
 * fabricated providers, and no setting turns them on.
 */
export function fixtureAccountsAllowed(): boolean {
  return process.env.NODE_ENV !== "production";
}

export interface ConfigProblem {
  id: string;
  message: string;
}

/**
 * What a PRODUCTION server refuses to run with. Each of these would otherwise
 * give a false sense of safety or expose something that must not exist, so the
 * process stops instead of serving. Pure (takes the environment) so it can be
 * tested and reused by the pre-launch check.
 *
 * ALLOW_OWNER_DATABASE_ROLE=true is an explicit, temporary, named exception for
 * a deployment that has not yet moved to the restricted database role. It is
 * reported as a launch blocker by `npm run verify:production`; it exists so the
 * exception is a visible decision rather than a silent default.
 */
export function productionConfigProblems(env: NodeJS.ProcessEnv = process.env): ConfigProblem[] {
  if (env.NODE_ENV !== "production") return [];
  const out: ConfigProblem[] = [];
  const add = (id: string, message: string) => out.push({ id, message });

  if (env.DEMO_MODE !== undefined && env.DEMO_MODE !== "" && env.DEMO_MODE !== "false") {
    add("demo-mode", "DEMO_MODE is set. Demo mode no longer exists; remove the variable. Production never runs simulated features.");
  }
  if (env.DEMO_MODE_ACKNOWLEDGED) add("demo-ack", "DEMO_MODE_ACKNOWLEDGED is set. Remove it.");
  if (!env.DATABASE_URL && !env.OWNER_DATABASE_URL) add("database-url", "DATABASE_URL is not set.");
  if ((env.JWT_SECRET ?? "").length < 32) add("jwt-secret", "JWT_SECRET is missing or shorter than 32 characters.");
  if (!/^https:\/\//.test(env.APP_URL ?? "")) add("app-url", "APP_URL must be set to the public https address (links in e-mails are built from it).");

  // Authenticator secrets are encrypted with this key: 32 random bytes, base64. Without it nobody could enrol.
  if (!env.MFA_ENCRYPTION_KEY || Buffer.from(env.MFA_ENCRYPTION_KEY, "base64").length !== 32) {
    add("mfa-key", "MFA_ENCRYPTION_KEY must be set to 32 random bytes, base64 encoded (openssl rand -base64 32).");
  }
  if (env.MFA_ALLOW_CODE_REUSE !== undefined && env.MFA_ALLOW_CODE_REUSE !== "") {
    add("mfa-reuse", "MFA_ALLOW_CODE_REUSE is a test-only setting and must not exist in production.");
  }

  const restricted = !!env.APP_DATABASE_URL && env.DB_ENFORCE_RLS === "on";
  const halfConfigured = !!env.APP_DATABASE_URL !== (env.DB_ENFORCE_RLS === "on");
  if (halfConfigured) {
    add("rls-half", "APP_DATABASE_URL and DB_ENFORCE_RLS=on must be set together: one without the other runs unprotected while looking protected.");
  } else if (!restricted && env.ALLOW_OWNER_DATABASE_ROLE !== "true") {
    add(
      "owner-role",
      "The application would connect to the database as the table owner. Set APP_DATABASE_URL and DB_ENFORCE_RLS=on (docs/OPERATIONS_RUNBOOK.md), or, as a visible temporary exception, ALLOW_OWNER_DATABASE_ROLE=true.",
    );
  }
  if (env.ALLOW_OWNER_DATABASE_ROLE === "true" && restricted) {
    add("owner-role-contradiction", "ALLOW_OWNER_DATABASE_ROLE=true is set although the restricted role is configured. Remove it.");
  }
  return out;
}

/** Refuses to start a production server whose configuration is unsafe. */
export function assertProductionConfig(env: NodeJS.ProcessEnv = process.env): void {
  const problems = productionConfigProblems(env);
  if (!problems.length) return;
  throw new Error(`Refusing to start: ${problems.map((p) => p.message).join(" ")}`);
}
