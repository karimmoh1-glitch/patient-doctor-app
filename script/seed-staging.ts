/**
 * SYNTHETIC ACCOUNTS FOR A TEST DEPLOYMENT. Creates one administrator and a few clinicians who are listed in the directory so testers
 * can find a doctor, connect, message and book. Everything is invented, every address ends in @staging.invalid (a name that can
 * never be delivered), and nothing here is a real person. Patients are NOT created: testers sign up themselves.
 *
 * Unlike `npm run db:seed` (fixture accounts every production server refuses, with a published password and authenticator secret),
 * these are ordinary accounts a production-mode server accepts, each with its OWN random password. The passwords go to a private
 * file (mode 600, created exclusively); nothing secret is printed. The second factor is NOT pre-enrolled: clinicians and the
 * administrator set up an authenticator at first sign-in, which is part of what is being tested.
 *
 *   STAGING_SEED=synthetic-only DATABASE_URL=<the test database's OWNER url> npm run seed:staging -- --out=<new file>
 *
 * Refuses to run when the database holds any account whose address does not end in @staging.invalid, so it cannot be pointed at a
 * database that has real people in it.
 */
import "dotenv/config";
import "./asOperator";
import crypto from "node:crypto";
import fs from "node:fs";
import bcrypt from "bcryptjs";
import { pool } from "../server/db";
import { storage } from "../server/storage";
import { defaultTimezoneForState } from "../shared/timezones";
import { replaceAvailability } from "../server/services/schedulingService";

const DOMAIN = "staging.invalid";

const DOCTORS = [
  { handle: "doctor.alpha", name: "Dr. Alpha Test (synthetic)", specialty: "Family Medicine", state: "CA", languages: ["en", "ar"] },
  { handle: "doctor.beta", name: "Dr. Beta Test (synthetic)", specialty: "Cardiology", state: "NY", languages: ["en"] },
  { handle: "doctor.gamma", name: "Dr. Gamma Test (synthetic)", specialty: "Pediatrics", state: "TX", languages: ["en", "ar"] },
  { handle: "doctor.delta", name: "Dr. Delta Test (synthetic)", specialty: "Dermatology", state: "FL", languages: ["en"] },
];

const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const password = () => crypto.randomBytes(15).toString("base64url");

async function main() {
  if (process.env.STAGING_SEED !== "synthetic-only") throw new Error("Set STAGING_SEED=synthetic-only to confirm this database holds synthetic data only.");
  const out = arg("out");
  if (!out) throw new Error("Pass --out=<a new file>; the generated passwords are written there (mode 600) and nowhere else.");
  if (fs.existsSync(out)) throw new Error(`${out} already exists. Nothing was changed.`);

  const foreign = await pool.query("SELECT count(*)::int AS n FROM users WHERE email NOT LIKE $1", [`%@${DOMAIN}`]);
  if (foreign.rows[0].n > 0) throw new Error("This database holds accounts that are not staging.invalid ones. Refusing to seed it. Nothing was changed.");
  if (await storage.getUserByEmail(`admin@${DOMAIN}`)) throw new Error("Already seeded. Nothing was changed.");

  const lines: string[] = ["# Synthetic test accounts. Private: mode 600. Every account is invented. The second factor is set up at first sign-in."];

  const adminPw = password();
  const admin = await storage.createUser({ name: "Test Administrator (synthetic)", email: `admin@${DOMAIN}`, passwordHash: await bcrypt.hash(adminPw, 12), role: "admin", state: null, phone: null, deactivatedAt: null, emailVerifiedAt: null });
  await pool.query(
    "INSERT INTO audit_logs (action, target_type, target_id, subject_user_id, metadata) VALUES ('admin.bootstrapped', 'user', $1, $1, $2)",
    [admin.id, JSON.stringify({ operator: process.env.USER ?? "unknown", via: "npm run seed:staging" })],
  );
  lines.push(`admin  admin@${DOMAIN}  ${adminPw}`);

  for (const [i, d] of DOCTORS.entries()) {
    const pw = password();
    const email = `${d.handle}@${DOMAIN}`;
    const user = await storage.createUser({ name: d.name, email, passwordHash: await bcrypt.hash(pw, 12), role: "doctor", state: d.state, phone: null, deactivatedAt: null, emailVerifiedAt: null });
    const tz = defaultTimezoneForState(d.state);
    const profile = await storage.createDoctorProfile({
      userId: user.id, timezone: tz, name: d.name, specialty: d.specialty, state: d.state,
      licenseNumber: null, npiNumber: null, phone: `+1555010000${i + 1}`, // a reserved fictitious number
      bio: "An invented clinician for testing. Not a real person; gives no real advice.",
      active: true, source: "seed", languages: d.languages, modalities: ["phone", "messaging"],
    });
    const windows = [1, 2, 3, 4, 5].flatMap((weekday) => [
      { weekday, startMinute: 9 * 60, endMinute: 12 * 60 },
      { weekday, startMinute: 13 * 60, endMinute: 17 * 60 },
    ]);
    await replaceAvailability(profile.id, profile.timezone, windows);
    lines.push(`doctor  ${email}  ${pw}`);
  }

  fs.writeFileSync(out, lines.join("\n") + "\n", { mode: 0o600, flag: "wx" });
  console.log(`Seeded 1 administrator and ${DOCTORS.length} clinicians, all synthetic. Passwords are in ${out} (mode 600); none was printed.`);
}

main()
  .catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
