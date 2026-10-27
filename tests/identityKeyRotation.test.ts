import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import crypto from "crypto";
import pg from "pg";
import request from "supertest";
import { getApp, signupPatient, createDoctor, connect, auth, operatorPool, uniqueEmail, PASSWORD } from "./helpers";
import { appRoleUrl } from "./fastCommit";
import { signAssertion, devIdentityKey } from "../server/identity";
import { registerIdentityKey } from "../script/lib/identityKeys";

// Replacing the signing key must never lock anybody out, and the key and the assertions it signs must not leak into logs or responses.

const dev = devIdentityKey();
let app_: pg.Pool;
const whoIs = async (token: string) => {
  const c = await app_.connect();
  try {
    await c.query("SELECT set_config('app.assertion', $1, false)", [token]);
    const r = await c.query("SELECT app_user_id() AS u, app_is_system() AS s");
    return { user: r.rows[0].u as string | null, system: r.rows[0].s as boolean };
  } finally {
    await c.query("RESET ALL").catch(() => {});
    c.release();
  }
};
const NOBODY = { user: null, system: false };

beforeAll(async () => {
  await getApp();
  app_ = new pg.Pool({ connectionString: appRoleUrl(process.env.DATABASE_URL!), max: 2 });
});
afterAll(async () => {
  await operatorPool().query("DELETE FROM app_identity_keys WHERE kid LIKE 'rot-%'");
  await app_.end();
});
afterEach(() => vi.restoreAllMocks());

describe("rotating the signing key", () => {
  it("never leaves a moment in which the old or the new key is refused: both verify while both are registered, and the old stops only when retired", async () => {
    const owner = operatorPool();
    const next = { kid: `rot-${crypto.randomBytes(3).toString("hex")}`, key: crypto.randomBytes(32) };
    const oldToken = () => signAssertion({ userId: "user-rot-1" }, dev)!;
    const newToken = () => signAssertion({ userId: "user-rot-1" }, next)!;

    expect(await whoIs(newToken())).toEqual(NOBODY); // not registered yet: the server cannot yet use it
    await registerIdentityKey(owner, next); // step 1: generate + register (the database accepts both)
    expect(await whoIs(oldToken())).toEqual({ user: "user-rot-1", system: false }); // step 2: servers still on the old key keep working
    expect(await whoIs(newToken())).toEqual({ user: "user-rot-1", system: false }); // …and servers already switched work too (a rolling deploy)
    await owner.query("UPDATE app_identity_keys SET retired_at = now() WHERE kid = $1", [dev.kid]); // step 3: retire the old key after the new one is live
    try {
      expect(await whoIs(oldToken())).toEqual(NOBODY);
      expect(await whoIs(newToken())).toEqual({ user: "user-rot-1", system: false });
      // A scoped system identity follows the same rule for either key.
      expect(await whoIs(signAssertion({ system: true, scope: "auth" }, next)!)).toEqual(NOBODY); // (app_is_system() is false for narrow scopes)
    } finally {
      await owner.query("UPDATE app_identity_keys SET retired_at = NULL WHERE kid = $1", [dev.kid]);
    }
    // Retiring the new one instead (a rollback of the rotation) leaves the old working.
    await owner.query("UPDATE app_identity_keys SET retired_at = now() WHERE kid = $1", [next.kid]);
    expect(await whoIs(newToken())).toEqual(NOBODY);
    expect(await whoIs(oldToken())).toEqual({ user: "user-rot-1", system: false });
  });

  it("re-registering a key id under a new value replaces what the database verifies with, so the old value stops working", async () => {
    const owner = operatorPool();
    const kid = `rot-${crypto.randomBytes(3).toString("hex")}`;
    const first = { kid, key: crypto.randomBytes(32) };
    const second = { kid, key: crypto.randomBytes(32) };
    await registerIdentityKey(owner, first);
    expect(await whoIs(signAssertion({ userId: "u" }, first)!)).toEqual({ user: "u", system: false });
    await registerIdentityKey(owner, second);
    expect(await whoIs(signAssertion({ userId: "u" }, first)!)).toEqual(NOBODY);
    expect(await whoIs(signAssertion({ userId: "u" }, second)!)).toEqual({ user: "u", system: false });
  });
});

describe("nothing secret leaves the server through logs or responses", () => {
  const secrets = () => [dev.key.toString("base64"), dev.key.toString("hex"), dev.key.toString("base64url"), process.env.IDENTITY_KEY ?? "(unset)", process.env.JWT_SECRET ?? "(unset)"].filter((s) => s.length > 8);
  const TOKEN_SHAPE = /v1\.[a-z0-9_-]{1,32}\.(user|system)\.[A-Za-z0-9_-]{1,64}\.\d{1,12}\.[A-Za-z0-9_-]{43}/;

  it("has detectors that would notice a leak (positive control)", () => {
    expect(TOKEN_SHAPE.test(signAssertion({ userId: "someone" }, dev)!)).toBe(true);
    expect(TOKEN_SHAPE.test(signAssertion({ system: true, scope: "auth" }, dev)!)).toBe(true);
    expect(secrets().length).toBeGreaterThanOrEqual(2);
    expect(`log ${dev.key.toString("base64")}`.includes(secrets()[0])).toBe(true);
  });

  it("writes neither the key nor any signed identity to the console while serving ordinary, failing and hostile requests", async () => {
    const lines: string[] = [];
    for (const m of ["log", "info", "warn", "error", "debug"] as const) vi.spyOn(console, m).mockImplementation((...a: unknown[]) => { lines.push(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x, Object.getOwnPropertyNames(x ?? {})))).join(" ")); });
    const app = await getApp();
    const patient = await signupPatient();
    const doctor = await createDoctor();
    await connect(patient, doctor);
    const bodies: string[] = [];
    const keep = (r: request.Response) => { bodies.push(JSON.stringify({ body: r.body, text: r.text, headers: r.headers })); return r; };
    keep(await request(app).get("/api/auth/me").set(auth(patient.token)));
    keep(await request(app).get("/api/pairings").set(auth(patient.token)));
    keep(await request(app).post("/api/auth/login").send({ email: patient.email, password: "wrong-password-1" }));
    keep(await request(app).post("/api/auth/login").send({ email: uniqueEmail("nobody"), password: PASSWORD }));
    keep(await request(app).get("/api/prescriptions/not-a-real-id").set(auth(patient.token)));
    keep(await request(app).get("/api/pairings/%00%27%3B--").set(auth(patient.token)));
    keep(await request(app).post("/api/messages").set(auth(patient.token)).send({ pairingId: "x'; select app_user_id() --", body: "x" }));
    keep(await request(app).get("/api/me/export").set({ ...auth(patient.token), "X-Avela-Assertion": signAssertion({ system: true }, dev)!, "app.assertion": "v1.dev.system.-.9999999999.AAAA" }));
    keep(await request(app).post("/api/webhooks/resend").set("content-type", "application/json").send("{}"));
    keep(await request(app).get("/api/cron/reminders").set({ Authorization: "Bearer wrong" }));

    const out = lines.join("\n");
    for (const s of secrets()) {
      expect(out.includes(s), "console").toBe(false);
      for (const b of bodies) expect(b.includes(s), "response").toBe(false);
    }
    expect(TOKEN_SHAPE.test(out), "a signed identity in the console").toBe(false);
    for (const b of bodies) expect(TOKEN_SHAPE.test(b), "a signed identity in a response").toBe(false);
  });

  it("returns a generic failure, not a database error, to a request that makes a query fail", async () => {
    const app = await getApp();
    const patient = await signupPatient();
    const r = await request(app).get(`/api/pairings/${"%".repeat(3)}`).set(auth(patient.token));
    expect(JSON.stringify(r.body) + r.text).not.toMatch(/relation "|syntax error|pg_catalog|app_identity|avela_identity_check|set_config/);
  });
});
