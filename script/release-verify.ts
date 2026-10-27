/**
 * The checks to run immediately after a deployment, and the stop conditions in docs/RELEASE_PROCEDURE.md. Read-only; creates no account and
 * writes nothing. Prints names and verdicts, never a secret or a row.
 *
 *   LIVE_URL=https://avela-taupe.vercel.app EXPECTED_COMMIT=$(git rev-parse HEAD) npm run release:verify
 *   (add OWNER_DATABASE_URL=… to also check the database: migrations, identity enforcement, the access audit, readiness)
 *
 * Exit code 1 if anything FAILS. A FAIL here is a STOP condition: follow the recovery steps, do not continue the roll-out.
 */
import "dotenv/config";
import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";

const live = (process.env.LIVE_URL ?? "").replace(/\/$/, "");
const expected = process.env.EXPECTED_COMMIT ?? "";
if (!live || !expected) throw new Error("Set LIVE_URL and EXPECTED_COMMIT.");

let failed = 0;
const report = (ok: boolean, what: string, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${what}${detail ? ` (${detail})` : ""}`);
  if (!ok) failed++;
};
const get = async (p: string, init: RequestInit = {}) => fetch(`${live}${p}`, { redirect: "manual", ...init });

async function http() {
  const health = await (await get("/api/health")).json().catch(() => ({}));
  report(health.commit === expected, "live commit is the release candidate", `live ${String(health.commit).slice(0, 7)}, expected ${expected.slice(0, 7)}`);
  const version = await (await get("/version.json")).json().catch(() => ({}));
  report(version.commit === expected, "the static version file agrees");
  const ready = await get("/api/health/ready");
  report(ready.status === 200 && (await ready.json().catch(() => ({}))).database === "up", "readiness: the database answers");

  const me = await get("/api/auth/me");
  report(me.status === 401, "an anonymous caller is refused on /api/auth/me");
  report(me.headers.get("cache-control")?.includes("no-store") === true, "API responses are not cached");
  for (const p of ["/api/admin/doctor-applications", "/api/pairings", "/api/pairings/doctor", "/api/care-circle/caregiver/patients", "/api/me/export", "/api/emergency-profile", "/api/health-profile/basic"]) {
    const r = await get(p);
    report(r.status === 401, `anonymous refused: ${p}`, String(r.status));
  }
  const demo = await get("/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "patient@avela.dev", password: "DemoPass123!" }) });
  report(demo.status === 401, "the published demo login does nothing", String(demo.status));
  const cron = await get("/api/cron/reminders", { headers: { Authorization: "Bearer not-the-secret" } });
  report([401, 503].includes(cron.status), "the scheduler endpoint refuses a wrong secret", String(cron.status));
  const hook = await get("/api/webhooks/resend", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  report([401, 503].includes(hook.status), "the e-mail webhook refuses an unsigned call", String(hook.status));

  const doctors = await get("/api/doctors");
  const text = await doctors.text();
  report(doctors.status === 200 && !/passwordHash|licenseNumber|npiNumber|"phone"/.test(text), "the public directory exposes no private field");
  report(!/avela\.dev/.test(text), "the public directory lists no fixture provider");
  const csp = (await get("/")).headers;
  report(!!csp.get("content-security-policy") && /nosniff/i.test(csp.get("x-content-type-options") ?? ""), "page security headers are present");
  const hsts = (await get("/api/health")).headers.get("strict-transport-security");
  report(!!hsts, "HSTS is sent");
  const config = await (await get("/api/config")).json().catch(() => ({}));
  console.log(`INFO  features: ${JSON.stringify(config.features ?? {})}; reminder delivery: ${config.features?.reminderDelivery ?? "?"}`);
}

function database() {
  const url = process.env.OWNER_DATABASE_URL ?? "";
  if (!url) {
    console.log("SKIP  database checks (set OWNER_DATABASE_URL to include them)");
    return;
  }
  const env = { ...process.env, DATABASE_URL: url, NODE_ENV: "development" };
  const run = (script: string, args: string[] = []) => {
    try {
      return { ok: true, out: execFileSync("npx", ["tsx", script, ...args], { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }) };
    } catch (e: any) {
      return { ok: false, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
    }
  };
  const migrations = fs.readdirSync(path.resolve("migrations")).filter((f) => f.endsWith(".sql")).length;
  const fp = run("script/schema-fingerprint.ts");
  report(fp.ok, "schema fingerprint taken", (fp.out.match(/fingerprint (\w+)/) ?? [])[0] ?? "");
  const audit = run("script/audit-database.ts");
  report(audit.ok && /0 finding/.test(audit.out), "database access audit: no findings", (audit.out.match(/\d+ tables.*finding/) ?? [""])[0]);
  const keys = run("script/identity-keys.ts", ["status"]);
  report(/Enforcement: ON/.test(keys.out) && /active/.test(keys.out), "signed identities are enforced and a key is active");
  const ready = run("script/verify-production.ts");
  const fails = (ready.out.match(/^FAIL .*/gm) ?? []).map((l) => l.slice(0, 120));
  console.log(`INFO  verify:production blockers (${fails.length}): ${fails.join(" | ") || "none"}`);
  console.log(`INFO  repository has ${migrations} migrations; compare with: SELECT count(*) FROM schema_migrations`);
}

(async () => {
  await http();
  database();
  console.log(failed ? `\n${failed} check(s) FAILED: STOP. Follow the recovery steps in docs/RELEASE_PROCEDURE.md.` : "\nAll checks passed.");
  process.exit(failed ? 1 : 0);
})();
