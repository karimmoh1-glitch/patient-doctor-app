import { describe, it, expect, beforeAll, vi } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { getApp, signupPatient, createDoctor, createAdmin, connect, issuePrescription, auth, uniqueEmail, operatorPool, PASSWORD, type TestUser, type TestDoctor } from "./helpers";
import { ROUTER_MOUNTS } from "../server/routes";

// The read crawl in privateAccountColumns.test.ts covers every GET. This is the other half: every route that CHANGES something, called by people
// who must not be able to, with empty and hostile bodies (error paths are where private values most often slip into a response); the public
// flows (sign-in, recovery, sign-up) which must not tell a stranger whether an account exists; and a patient changing their details while others read.

vi.mock("../server/services/emailService", async (importOriginal) => {
  const original = await importOriginal<typeof import("../server/services/emailService")>();
  return { ...original, sendCareCircleInviteEmail: async () => {} };
});

let app: Express;
let A: TestUser, B: TestUser, D1: TestDoctor, D2: TestDoctor, admin: TestUser;
let aEmail: string, aHash: string, pairingId: string, apptId: string;
const MARK = { phone: "+15557771234", dob: "1971-02-03", contact: "Zed Zeldaworth", cphone: "+15558889999", allergy: "ZEBRA-ALLERGY", note: "ZEBRA-NOTE", rel: "ZEBRA-SISTER", pref: "ZEBRA-PREFERRED", access: "ZEBRA-ACCESS" };
const MARKERS = Object.values(MARK);

beforeAll(async () => {
  app = await getApp();
  A = await signupPatient({ name: "Margaret Marked" });
  B = await signupPatient();
  D1 = await createDoctor();
  D2 = await createDoctor();
  admin = await createAdmin();
  ({ pairingId } = await connect(A, D1));
  await issuePrescription(D1, pairingId);
  const o = operatorPool();
  await o.query(
    `UPDATE users SET phone = $2, date_of_birth = $3, emergency_contact_name = $4, emergency_contact_phone = $5, allergies_text = $6, emergency_notes = $7,
            emergency_contact_relationship = $8, preferred_name = $9, accessibility_notes = $10 WHERE id = $1`,
    [A.id, MARK.phone, MARK.dob, MARK.contact, MARK.cphone, MARK.allergy, MARK.note, MARK.rel, MARK.pref, MARK.access],
  );
  const row = (await o.query("SELECT email, password_hash FROM users WHERE id = $1", [A.id])).rows[0];
  aEmail = row.email;
  aHash = row.password_hash;
  apptId = (await o.query(`INSERT INTO appointments (pairing_request_id, patient_user_id, doctor_profile_id, type, reason, scheduled_at, status)
    VALUES ($1, $2, $3, 'Video Visit', 'r', now() + interval '3 days', 'confirmed') RETURNING id`, [pairingId, A.id, D1.profileId])).rows[0].id as string;
});

const leaks = (text: string): string[] => {
  const found: string[] = [];
  if (/\$2[aby]\$\d\d\$/.test(text)) found.push("a password hash");
  if (text.includes(aHash)) found.push("the patient's hash");
  if (text.toLowerCase().includes(aEmail.toLowerCase())) found.push("the patient's address");
  for (const m of MARKERS) if (text.includes(m)) found.push(m);
  return found;
};
const filled = (pattern: string, values: string[]): string[] => (/:[A-Za-z]+/.test(pattern) ? values.map((v) => pattern.replace(/:[A-Za-z]+/g, v)) : [pattern]);

describe("routes that change something, called by people who must not reach the patient's records", () => {
  const mutating = (): { method: "post" | "put" | "patch" | "delete"; path: string }[] => {
    const out: { method: "post" | "put" | "patch" | "delete"; path: string }[] = [];
    for (const [prefix, router] of ROUTER_MOUNTS) {
      for (const layer of (router as any).stack) {
        if (!layer.route) continue;
        for (const method of ["post", "put", "patch", "delete"] as const) {
          const path = prefix + (layer.route.path === "/" ? "" : layer.route.path);
          // Signing out / changing the credentials of the account that is making the call would end the crawl itself; those flows have their own tests.
          if (layer.route.methods[method] && !/^\/api\/auth\//.test(path) && !/^\/api\/me(\/|$)/.test(path) && !/^\/api\/webhooks|^\/api\/cron/.test(path)) out.push({ method, path });
        }
      }
    }
    return out;
  };

  it("never answers with the patient's private values, and never fails with a server error, to an empty or hostile request", async () => {
    const hostile = { id: A.id, userId: A.id, patientUserId: A.id, email: aEmail, pairingId, appointmentId: apptId, doctorProfileId: D1.profileId, body: "x", status: "confirmed", __proto__: { admin: true } };
    const people: Record<string, string | null> = { anonymous: null, "unconnected doctor": D2.token, "other patient": B.token, administrator: admin.token };
    const state = async () => ({
      pairing: (await operatorPool().query("SELECT status FROM pairing_requests WHERE id = $1", [pairingId])).rows[0].status,
      appointment: (await operatorPool().query("SELECT status FROM appointments WHERE id = $1", [apptId])).rows[0].status,
    });
    const before = await state();
    const routes = mutating();
    expect(routes.length).toBeGreaterThan(80);
    let calls = 0;
    const serverErrors: string[] = [];
    for (const [who, token] of Object.entries(people)) {
      for (const { method, path: pattern } of routes) {
        for (const path of filled(pattern, [pairingId, A.id, apptId])) {
          for (const body of [{}, hostile]) {
            let req = (request(app) as any)[method](path).send(body);
            if (token) req = req.set(auth(token));
            const res = await req;
            calls++;
            const text = JSON.stringify(res.body) + (res.text ?? "") + JSON.stringify(res.headers);
            expect(leaks(text), `${who} ${method.toUpperCase()} ${path}`).toEqual([]);
            if (res.status >= 500) serverErrors.push(`${who} ${method.toUpperCase()} ${path} -> ${res.status}`);
          }
        }
      }
    }
    expect(calls).toBeGreaterThan(1500);
    expect(serverErrors).toEqual([]);
    // …and nothing was changed on the patient's side by any of it.
    const after = (await operatorPool().query("SELECT phone, date_of_birth::text AS dob, emergency_contact_name AS c FROM users WHERE id = $1", [A.id])).rows[0];
    expect(after).toEqual({ phone: MARK.phone, dob: MARK.dob, c: MARK.contact });
    expect(await state()).toEqual(before);
  }, 600_000);
});

describe("an approved doctor editing their own profile", () => {
  it("is told 'nothing to change' for an empty edit instead of getting a server error", async () => {
    const empty = await request(app).patch("/api/doctors/me/profile").set(auth(D1.token)).send({});
    expect(empty.status).toBe(400);
    const real = await request(app).patch("/api/doctors/me/profile").set(auth(D1.token)).send({ bio: "A short bio" });
    expect(real.status).toBe(200);
  });
});

describe("the public flows do not tell a stranger whether an account exists, and never echo it back", () => {
  it("answers sign-in with a wrong password and sign-in for an unknown address in the same way", async () => {
    const known = await request(app).post("/api/auth/login").send({ email: aEmail, password: "wrong-password-1" });
    const unknown = await request(app).post("/api/auth/login").send({ email: uniqueEmail("ghost"), password: "wrong-password-1" });
    expect(known.status).toBe(unknown.status);
    expect(known.body).toEqual(unknown.body);
    expect(leaks(JSON.stringify(known.body) + known.text)).toEqual([]);
  });

  it("answers password recovery for a real and an unknown address identically", async () => {
    const real = await request(app).post("/api/auth/forgot-password").send({ email: aEmail });
    const ghost = await request(app).post("/api/auth/forgot-password").send({ email: uniqueEmail("ghost") });
    expect(real.status).toBe(ghost.status);
    expect(real.body).toEqual(ghost.body);
    expect(leaks(JSON.stringify(real.body) + real.text)).toEqual([]);
  });

  it("does not return the stored details when someone signs up again with an existing address", async () => {
    const again = await request(app).post("/api/auth/signup").send({ name: "Impostor", email: aEmail, password: PASSWORD, state: "CA" });
    expect(again.status).toBeGreaterThanOrEqual(400);
    const text = JSON.stringify(again.body) + again.text;
    for (const m of [...MARKERS, aHash]) expect(text).not.toContain(m);
    expect(text).not.toMatch(/\$2[aby]\$/);
  });
});

describe("while the patient changes their details, nobody else reads them", () => {
  it("shows every reader either nothing or their own data on each read, through fifty interleaved edits", async () => {
    const newPhone = "+15550001111";
    const readers: [string, string][] = [["connected doctor", D1.token], ["unconnected doctor", D2.token], ["other patient", B.token], ["administrator", admin.token]];
    const edits = Array.from({ length: 50 }, (_, i) => request(app).put("/api/health-profile/basic").set(auth(A.token)).send({ phone: i % 2 ? newPhone : MARK.phone }));
    const reads = readers.flatMap(([who, token]) =>
      Array.from({ length: 12 }, () =>
        Promise.all(
          [`/api/pairings`, `/api/pairings/${pairingId}`, `/api/appointments`, `/api/doctors`, `/api/auth/me`, `/api/emergency-profile`, `/api/health-profile/basic`].map(async (p) => {
            const res = await request(app).get(p).set(auth(token));
            const text = JSON.stringify(res.body) + (res.text ?? "");
            expect(text.includes(newPhone) || text.includes(MARK.phone), `${who} GET ${p}`).toBe(false);
            expect(leaks(text), `${who} GET ${p}`).toEqual([]);
          }),
        ),
      ),
    );
    const results = await Promise.all([...edits, ...reads]);
    expect(results.length).toBeGreaterThan(50);
    const mine = await request(app).get("/api/health-profile/basic").set(auth(A.token));
    expect([newPhone, MARK.phone]).toContain(mine.body.phone);
  }, 120_000);
});
