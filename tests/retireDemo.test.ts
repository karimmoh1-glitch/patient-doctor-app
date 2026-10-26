import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import pg from "pg";
import { runMigrations } from "../script/migrate";

// The retirement procedure, run as the real script against a throwaway database: it must inventory without changing
// anything, refuse to change anything without a backup, back up only fabricated rows, retire without deleting, leave
// real accounts alone, write an audit entry, and be verifiable afterwards.

const base = new URL(process.env.DATABASE_URL!);
const NAME = "avela_retire_script_test";
const urlFor = (db: string) => { const u = new URL(base.toString()); u.pathname = `/${db}`; u.searchParams.delete("options"); return u.toString(); };
let admin: pg.Pool;
let owner: pg.Pool;
let backupDir: string;

function run(args: string[]) {
  try {
    const out = execFileSync("npx", ["tsx", "script/retire-demo.ts", ...args], {
      env: { ...process.env, DATABASE_URL: urlFor(NAME), APP_DATABASE_URL: "", DB_ENFORCE_RLS: "", NODE_ENV: "development" },
      encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, out };
  } catch (e: any) {
    return { code: e.status as number, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

beforeAll(async () => {
  admin = new pg.Pool({ connectionString: urlFor("postgres") });
  await admin.query(`DROP DATABASE IF EXISTS ${NAME}`);
  await admin.query(`CREATE DATABASE ${NAME}`);
  await runMigrations(urlFor(NAME));
  owner = new pg.Pool({ connectionString: urlFor(NAME) });
  const user = async (email: string, role: string, demo: boolean) =>
    (await owner.query(`INSERT INTO users (name, email, password_hash, role, is_demo) VALUES ($1, $2, 'x', $3, $4) RETURNING id`, [email.split("@")[0], email, role, demo])).rows[0].id as string;
  const demoPatient = await user("fixture-patient@avela.dev", "patient", true);
  const demoDoctor = await user("fixture-doctor@avela.dev", "doctor", true);
  await user("real.person@example.org", "patient", false);
  const profile = (await owner.query(`INSERT INTO doctor_profiles (user_id, name, specialty, state, phone, source, active) VALUES ($1, 'Dr Fixture', 'Dermatology', 'CA', '+10000000000', 'seed', true) RETURNING id`, [demoDoctor])).rows[0].id;
  await owner.query(`INSERT INTO doctor_profiles (user_id, name, specialty, state, phone, source, active) VALUES (NULL, 'Dr Nologin', 'Dermatology', 'CA', '+10000000001', 'seed', true)`);
  const pairing = (await owner.query(`INSERT INTO pairing_requests (patient_user_id, doctor_profile_id, status) VALUES ($1, $2, 'accepted') RETURNING id`, [demoPatient, profile])).rows[0].id;
  await owner.query(`INSERT INTO messages (pairing_request_id, sender_user_id, body) VALUES ($1, $2, 'fabricated text')`, [pairing, demoPatient]);
  await owner.query(`INSERT INTO user_devices (user_id, device_id, name, platform, browser) VALUES ($1, 'd1', 'x', 'x', 'x')`, [demoPatient]);
  backupDir = fs.mkdtempSync(path.join(os.tmpdir(), "avela-retire-"));
}, 120_000);

afterAll(async () => {
  await owner?.end();
  await admin?.query(`DROP DATABASE IF EXISTS ${NAME}`);
  await admin?.end();
  if (backupDir) fs.rmSync(backupDir, { recursive: true, force: true });
});

const active = async () => (await owner.query(`SELECT count(*)::int n FROM users WHERE is_demo AND deactivated_at IS NULL`)).rows[0].n as number;

describe("retiring fabricated accounts and providers", () => {
  it("reports what exists and changes nothing by default", () => {
    const r = run([]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/Fabricated accounts still active: 2/);
    expect(r.out).toMatch(/Seeded provider profiles still listed: 2/);
    expect(r.out).toMatch(/NOT fabricated .*: 1/);
    expect(r.out).toMatch(/Inventory only: nothing changed/);
  });

  it("verifies as failing while anything fabricated is active", async () => {
    expect(run(["--verify"]).code).toBe(1);
    expect(await active()).toBe(2);
  });

  it("refuses to change anything without a backup directory", async () => {
    const r = run(["--apply"]);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/--backup-dir/);
    expect(await active()).toBe(2);
  });

  it("backs up only the fabricated rows, retires them without deleting, and records an audit entry", async () => {
    const r = run(["--apply", `--backup-dir=${backupDir}`]);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toMatch(/Backed up \d+ row/);
    expect(r.out).toMatch(/Nothing was deleted/);

    const file = fs.readdirSync(backupDir).find((f) => f.startsWith("demo-retirement-"))!;
    expect(fs.statSync(path.join(backupDir, file)).mode & 0o077).toBe(0); // owner-only file
    const backup = JSON.parse(fs.readFileSync(path.join(backupDir, file), "utf8"));
    expect(backup.rows.users.map((u: any) => u.email).sort()).toEqual(["fixture-doctor@avela.dev", "fixture-patient@avela.dev"]);
    expect(JSON.stringify(backup)).not.toContain("real.person"); // a real account is never copied into the file
    expect(JSON.stringify(backup)).not.toContain("password_hash");
    expect(backup.rows.messages).toHaveLength(1);

    // Retired, not deleted.
    expect(await active()).toBe(0);
    expect((await owner.query(`SELECT count(*)::int n FROM users`)).rows[0].n).toBe(3);
    expect((await owner.query(`SELECT count(*)::int n FROM messages`)).rows[0].n).toBe(1);
    expect((await owner.query(`SELECT count(*)::int n FROM doctor_profiles WHERE active`)).rows[0].n).toBe(0);
    expect((await owner.query(`SELECT count(*)::int n FROM user_devices WHERE revoked_at IS NULL`)).rows[0].n).toBe(0);
    // The real account is untouched.
    expect((await owner.query(`SELECT deactivated_at FROM users WHERE email = 'real.person@example.org'`)).rows[0].deactivated_at).toBeNull();
    // Accounted for.
    const audit = (await owner.query(`SELECT metadata FROM audit_logs WHERE action = 'demo.retired'`)).rows;
    expect(audit).toHaveLength(1);
    expect(audit[0].metadata).toMatchObject({ accounts: 2, providers: 2 });
  });

  it("then verifies clean, and a second run finds nothing to do", () => {
    expect(run(["--verify"]).code).toBe(0);
    const again = run([]);
    expect(again.out).toMatch(/Fabricated accounts still active: 0/);
  });
});
