import { describe, it, expect } from "vitest";
import { execFile } from "child_process";
import path from "path";
import request from "supertest";
import { getApp, signIn, uniqueEmail, operatorPool, signupPatient, PASSWORD } from "./helpers";
import { appRoleUrl } from "./fastCommit";

// The two ways back into an administrator account, run for real as a child process against the test database, the way an operator
// runs them from a trusted shell. What matters: no public path, the owner connection only, no secret on screen or in the log,
// every use recorded, and no way to change an existing account's role.

const root = path.resolve(__dirname, "..");
function run(script: string, args: string[], env: Record<string, string>): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const child = execFile(path.join(root, "node_modules/.bin/tsx"), [path.join(root, "script", script), ...args], { cwd: root, env: { ...process.env, ...env, NODE_ENV: "test" }, timeout: 60_000 }, (err, stdout, stderr) =>
      resolve({ code: err ? ((err as any).code ?? 1) : 0, out: `${stdout}${stderr}` }),
    );
    child.stdin?.end(); // no terminal
  });
}
const STRONG = "tangerine-orbit-77-lantern";

describe("npm run admin:create", () => {
  it("creates an administrator who must set up a second factor, records who did it, and prints no secret", async () => {
    const email = uniqueEmail("first-admin");
    const r = await run("create-admin.ts", [], { ADMIN_EMAIL: email, ADMIN_NAME: "First Admin", ADMIN_PASSWORD: STRONG });
    expect(r.code, r.out).toBe(0);
    expect(r.out).not.toContain(STRONG);
    expect(r.out).toContain("second factor");
    const user = (await operatorPool().query(`SELECT id, role, password_hash FROM users WHERE email = $1`, [email])).rows[0];
    expect(user.role).toBe("admin");
    expect(user.password_hash).not.toContain(STRONG);
    const audit = (await operatorPool().query(`SELECT metadata FROM audit_logs WHERE action = 'admin.bootstrapped' AND target_id = $1`, [user.id])).rows;
    expect(audit).toHaveLength(1);
    expect(JSON.stringify(audit[0].metadata)).not.toMatch(new RegExp(`${STRONG}|${email}`));
    // The password works, and the session it opens is a second-factor challenge, not a session.
    const login = await request(await getApp()).post("/api/auth/login").send({ email, password: STRONG });
    expect(login.status).toBe(200);
    expect(login.body.token).toBeUndefined();
    expect(login.body.mfa).toBe("setup");
  });

  it("asks at a terminal when no password is supplied, and refuses to run without one", async () => {
    const r = await run("create-admin.ts", [], { ADMIN_EMAIL: uniqueEmail("noprompt"), ADMIN_NAME: "No Terminal", ADMIN_PASSWORD: "" });
    // An empty string counts as supplied-but-too-short; unset it entirely for the prompt path.
    expect(r.code).not.toBe(0);
    const env = { ...process.env, ADMIN_EMAIL: uniqueEmail("noprompt2"), ADMIN_NAME: "No Terminal" } as Record<string, string | undefined>;
    delete env.ADMIN_PASSWORD;
    const out = await new Promise<{ code: number; out: string }>((resolve) => {
      const c = execFile(path.join(root, "node_modules/.bin/tsx"), [path.join(root, "script/create-admin.ts")], { cwd: root, env: env as any, timeout: 60_000 }, (err, so, se) => resolve({ code: err ? 1 : 0, out: `${so}${se}` }));
      c.stdin?.end();
    });
    expect(out.code).toBe(1);
    expect(out.out).toMatch(/No terminal to ask on/);
  });

  it("refuses short, common and e-mail-derived passwords, and an address that already has an account, changing nothing", async () => {
    const email = uniqueEmail("refused");
    const local = email.split("@")[0];
    for (const bad of ["short1!", "password123", `${local}-secret-1`]) {
      const r = await run("create-admin.ts", [], { ADMIN_EMAIL: email, ADMIN_NAME: "Refused Person", ADMIN_PASSWORD: bad });
      expect(r.code, bad).not.toBe(0);
      expect(r.out).not.toContain(bad);
    }
    expect((await operatorPool().query(`SELECT 1 FROM users WHERE email = $1`, [email])).rowCount).toBe(0);

    const patient = await signupPatient();
    const before = (await operatorPool().query(`SELECT role, password_hash FROM users WHERE id = $1`, [patient.id])).rows[0];
    const r = await run("create-admin.ts", [], { ADMIN_EMAIL: patient.email, ADMIN_NAME: "Takeover", ADMIN_PASSWORD: STRONG });
    expect(r.code).not.toBe(0);
    expect(r.out).toMatch(/already exists/);
    expect((await operatorPool().query(`SELECT role, password_hash FROM users WHERE id = $1`, [patient.id])).rows[0]).toEqual(before); // no escalation of an existing account
  });

  it("ignores the application's restricted connection, which the database would refuse anyway", async () => {
    const email = uniqueEmail("via-app-url");
    const r = await run("create-admin.ts", [], { ADMIN_EMAIL: email, ADMIN_NAME: "Via App Url", ADMIN_PASSWORD: STRONG, APP_DATABASE_URL: appRoleUrl(process.env.DATABASE_URL!), DB_ENFORCE_RLS: "on" });
    expect(r.code, r.out).toBe(0);
    expect((await operatorPool().query(`SELECT role FROM users WHERE email = $1`, [email])).rows[0].role).toBe("admin");
  });
});

describe("npm run password:reset", () => {
  it("sets a new password, ends every session, and records who did it and why without the password", async () => {
    const patient = await signupPatient();
    const before = await request(await getApp()).get("/api/auth/me").set({ Authorization: `Bearer ${patient.token}` });
    expect(before.status).toBe(200);
    const r = await run("reset-password.ts", [`--email=${patient.email}`, "--reason=forgot password; identity confirmed by phone call"], { NEW_PASSWORD: STRONG });
    expect(r.code, r.out).toBe(0);
    expect(r.out).not.toContain(STRONG);
    const app = await getApp();
    expect((await request(app).get("/api/auth/me").set({ Authorization: `Bearer ${patient.token}` })).status).toBe(401); // old session ended
    expect((await request(app).post("/api/auth/login").send({ email: patient.email, password: PASSWORD })).status).toBe(401);
    expect((await request(app).post("/api/auth/login").send({ email: patient.email, password: STRONG })).status).toBe(200);
    const audit = (await operatorPool().query(`SELECT metadata FROM audit_logs WHERE action = 'password.reset_by_operator' AND target_id = $1`, [patient.id])).rows;
    expect(audit).toHaveLength(1);
    expect(JSON.stringify(audit[0].metadata)).toContain("identity confirmed");
    expect(JSON.stringify(audit[0].metadata)).not.toContain(STRONG);
  });

  it("needs a stated reason and a real account, and a strong password", async () => {
    const patient = await signupPatient();
    expect((await run("reset-password.ts", [`--email=${patient.email}`], { NEW_PASSWORD: STRONG })).code).not.toBe(0);
    expect((await run("reset-password.ts", ["--email=nobody@test.example", "--reason=because I said so, honestly"], { NEW_PASSWORD: STRONG })).code).not.toBe(0);
    expect((await run("reset-password.ts", [`--email=${patient.email}`, "--reason=forgot password; identity confirmed"], { NEW_PASSWORD: "short" })).code).not.toBe(0);
    expect((await request(await getApp()).post("/api/auth/login").send({ email: patient.email, password: PASSWORD })).status).toBe(200); // unchanged
    void signIn;
  });
});
