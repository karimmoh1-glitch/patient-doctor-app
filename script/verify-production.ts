/**
 * Prints whether this deployment is safe to open to real people, and exits
 * non-zero if any hard blocker remains. Reads the same environment the server
 * would (DATABASE_URL and friends), so run it where the production variables
 * are set. It never prints a secret or any patient information.
 */
import "dotenv/config";
import { pool } from "../server/db";
import { checkReadiness } from "../server/services/readiness";

async function main() {
  const checks = await checkReadiness(process.env, pool);
  const mark = { ok: "PASS", warn: "WARN", fail: "FAIL" } as const;
  for (const c of checks) console.log(`${mark[c.level]}  ${c.message}`);
  const failures = checks.filter((c) => c.level === "fail").length;
  const warnings = checks.filter((c) => c.level === "warn").length;
  console.log(`\n${failures} blocker(s), ${warnings} warning(s).`);
  console.log(failures ? "NOT ready for real patient information." : "No automated blocker remains. This is necessary, not sufficient: see docs/REAL_PATIENT_READINESS.md.");
  process.exitCode = failures ? 1 : 0;
}

main().catch((err) => { console.error(err.message); process.exitCode = 2; }).finally(() => pool.end());
