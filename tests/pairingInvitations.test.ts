import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import type { Express } from "express";
import pg from "pg";
import { eq } from "drizzle-orm";
import { getApp, signupPatient, createDoctor, createAdmin, createCaregiverAccount, auth, type TestUser, type TestDoctor } from "./helpers";
import { db } from "../server/db";
import { runAsSystem } from "../server/dbContext";
import { pairingInvitations, pairingRequests, doctorProfiles } from "@shared/schema";
import { storage } from "../server/storage";
import { INVITATION_MINUTES } from "../server/services/pairingInvitations";

const ownerPool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
afterAll(() => ownerPool.end());

let app: Express;
beforeAll(async () => {
  app = await getApp();
});
const sys = <T,>(f: () => Promise<T>) => runAsSystem(f);

const create = (d: TestDoctor) => request(app).post("/api/pairing-invitations").set(auth(d.token));
const tokenOf = (url: string) => url.split("#")[1];
const preview = (u: TestUser, body: object) => request(app).post("/api/pairing-invitations/preview").set(auth(u.token)).send(body);
const accept = (u: TestUser, body: object) => request(app).post("/api/pairing-invitations/accept").set(auth(u.token)).send({ confirm: true, ...body });
const pairingsOf = (patientId: string, doctorProfileId: string) => sys(() => db.select().from(pairingRequests).where(eq(pairingRequests.patientUserId, patientId))).then((r) => r.filter((p) => p.doctorProfileId === doctorProfileId));

async function invited() {
  const doctor = await createDoctor({ name: "Dr. Invite" });
  const made = await create(doctor);
  expect(made.status).toBe(201);
  return { doctor, id: made.body.id as string, token: tokenOf(made.body.url), code: made.body.code as string, body: made.body };
}

describe("making a code", () => {
  it("is for an approved clinician only, and the code carries no patient information or credentials", async () => {
    const doctor = await createDoctor();
    const patient = await signupPatient();
    const admin = await createAdmin();
    expect((await create({ ...doctor, token: patient.token } as TestDoctor)).status).toBe(403);
    expect((await create({ ...doctor, token: admin.token } as TestDoctor)).status).toBe(403);
    expect((await request(app).post("/api/pairing-invitations")).status).toBe(401);
    const made = await create(doctor);
    expect(made.status).toBe(201);
    expect(made.body.url).toMatch(/\/connect#[A-Za-z0-9_-]{40,}$/);
    expect(made.body.code).toMatch(/^[A-HJ-KM-NP-Z2-9]{4}-[A-HJ-KM-NP-Z2-9]{4}$/);
    const minutes = (new Date(made.body.expiresAt).getTime() - Date.now()) / 60_000;
    expect(minutes).toBeGreaterThan(INVITATION_MINUTES - 1);
    expect(minutes).toBeLessThanOrEqual(INVITATION_MINUTES);
    expect(made.body.url).not.toContain(doctor.id);
    expect(made.body.url).not.toContain(doctor.profileId);
  });

  it("stores only hashes, never the token or the code", async () => {
    const { id, token, code } = await invited();
    const [row] = await sys(() => db.select().from(pairingInvitations).where(eq(pairingInvitations.id, id)));
    const dump = JSON.stringify(row);
    expect(dump).not.toContain(token);
    expect(dump).not.toContain(code.replace("-", ""));
    expect(row.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.codeHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("limits how many codes are waiting at once", async () => {
    const doctor = await createDoctor();
    for (let i = 0; i < 5; i++) expect((await create(doctor)).status).toBe(201);
    const sixth = await create(doctor);
    expect(sixth.status).toBe(429);
  });
});

describe("a patient connecting with a code", () => {
  it("sees who it is from, confirms, and only then is connected; the clinician sees it accepted only after that", async () => {
    const { doctor, id, token } = await invited();
    const patient = await signupPatient({ name: "Nadia Scanner" });
    const seen = await preview(patient, { token });
    expect(seen.status).toBe(200);
    expect(seen.body.doctor).toMatchObject({ name: "Dr. Invite", specialty: "Family Medicine" });
    expect(JSON.stringify(seen.body)).not.toContain(doctor.profileId); // no internal ids, no phone number
    expect(seen.body.doctor.phone).toBeUndefined();
    // Looking is not connecting.
    expect(await pairingsOf(patient.id, doctor.profileId)).toHaveLength(0);
    const pending = (await request(app).get("/api/pairing-invitations").set(auth(doctor.token))).body.find((i: any) => i.id === id);
    expect(pending).toMatchObject({ state: "pending", patientName: null });

    expect((await request(app).post("/api/pairing-invitations/accept").set(auth(patient.token)).send({ token })).status).toBe(400); // no explicit yes
    expect(await pairingsOf(patient.id, doctor.profileId)).toHaveLength(0);

    const done = await accept(patient, { token });
    expect(done.status).toBe(201);
    const [pairing] = await pairingsOf(patient.id, doctor.profileId);
    expect(pairing).toMatchObject({ status: "accepted", connectedVia: "invitation", invitationId: id });
    expect(done.body.pairingId).toBe(pairing.id);
    const after = (await request(app).get("/api/pairing-invitations").set(auth(doctor.token))).body.find((i: any) => i.id === id);
    expect(after).toMatchObject({ state: "accepted", patientName: "Nadia Scanner" });
    // The connection now behaves like any other: they can message.
    expect((await request(app).post(`/api/pairings/${pairing.id}/messages`).set(auth(patient.token)).send({ body: "Hello doctor" })).status).toBe(201);
  });

  it("works by typing the short code, in any case, with or without the dash", async () => {
    const { doctor, code } = await invited();
    const patient = await signupPatient();
    const typed = code.toLowerCase().replace("-", " ");
    expect((await preview(patient, { code: typed })).status).toBe(200);
    expect((await accept(patient, { code: typed })).status).toBe(201);
    expect(await pairingsOf(patient.id, doctor.profileId)).toHaveLength(1);
  });

  it("is single-use: a second patient gets the same answer as for a code that never existed", async () => {
    const { token, doctor } = await invited();
    const first = await signupPatient();
    const second = await signupPatient();
    expect((await accept(first, { token })).status).toBe(201);
    const reused = await accept(second, { token });
    const never = await accept(second, { token: "x".repeat(43) });
    expect(reused.status).toBe(404);
    expect(reused.body).toEqual(never.body);
    expect(await pairingsOf(second.id, doctor.profileId)).toHaveLength(0);
  });

  it("answers an expired code, a revoked code and a made-up code identically", async () => {
    const a = await invited();
    const b = await invited();
    const patient = await signupPatient();
    await sys(() => db.update(pairingInvitations).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(pairingInvitations.id, a.id)));
    expect((await request(app).delete(`/api/pairing-invitations/${b.id}`).set(auth(b.doctor.token))).status).toBe(200);
    const results = [
      await preview(patient, { token: a.token }),
      await preview(patient, { token: b.token }),
      await preview(patient, { code: "ZZZZ-ZZZZ" }),
    ];
    expect(results.map((r) => r.status)).toEqual([404, 404, 404]);
    expect(new Set(results.map((r) => JSON.stringify(r.body))).size).toBe(1);
    expect((await accept(patient, { token: a.token })).status).toBe(404);
    expect((await accept(patient, { token: b.token })).status).toBe(404);
    expect(await pairingsOf(patient.id, a.doctor.profileId)).toHaveLength(0);
    // The clinician sees the truth about their own codes.
    const states = (await request(app).get("/api/pairing-invitations").set(auth(a.doctor.token))).body.map((i: any) => i.state);
    expect(states).toContain("expired");
    expect((await request(app).get("/api/pairing-invitations").set(auth(b.doctor.token))).body[0].state).toBe("revoked");
  });

  it("lets only the clinician who made a code revoke it", async () => {
    const a = await invited();
    const other = await createDoctor();
    expect((await request(app).delete(`/api/pairing-invitations/${a.id}`).set(auth(other.token))).status).toBe(404);
    const patient = await signupPatient();
    expect((await request(app).delete(`/api/pairing-invitations/${a.id}`).set(auth(patient.token))).status).toBe(403);
    expect((await preview(patient, { token: a.token })).status).toBe(200);
    // Another clinician's list never shows it.
    expect((await request(app).get("/api/pairing-invitations").set(auth(other.token))).body).toEqual([]);
  });

  it("declining is just not confirming: nothing is created and the code still works for someone else", async () => {
    const { token, doctor } = await invited();
    const sceptic = await signupPatient();
    const other = await signupPatient();
    expect((await preview(sceptic, { token })).status).toBe(200);
    expect(await pairingsOf(sceptic.id, doctor.profileId)).toHaveLength(0);
    expect((await accept(other, { token })).status).toBe(201);
  });

  it("is refused to anyone who is not a signed-in patient", async () => {
    const { token } = await invited();
    const doctor = await createDoctor();
    const admin = await createAdmin();
    const caregiver = await createCaregiverAccount();
    expect((await request(app).post("/api/pairing-invitations/preview").send({ token })).status).toBe(401);
    expect((await request(app).post("/api/pairing-invitations/accept").send({ token, confirm: true })).status).toBe(401);
    for (const who of [doctor, admin, caregiver]) {
      expect((await preview(who, { token })).status).toBe(403);
      expect((await accept(who, { token })).status).toBe(403);
    }
  });

  it("never connects to a clinician who is suspended, unlisted, or whose licence check has expired, even with a valid code", async () => {
    const a = await invited();
    const patient = await signupPatient();
    await sys(() => db.update(doctorProfiles).set({ active: false }).where(eq(doctorProfiles.id, a.doctor.profileId)));
    expect((await preview(patient, { token: a.token })).status).toBe(404);
    expect((await accept(patient, { token: a.token })).status).toBe(404);
    expect(await pairingsOf(patient.id, a.doctor.profileId)).toHaveLength(0);

    const b = await invited();
    await sys(() => db.update(doctorProfiles).set({ credentialExpiresAt: new Date(Date.now() - 1000) }).where(eq(doctorProfiles.id, b.doctor.profileId)));
    expect((await accept(patient, { token: b.token })).status).toBe(404);
    // And such a clinician cannot make a new code.
    expect((await create(b.doctor)).status).toBe(403);
  });

  it("does not connect people who have blocked each other", async () => {
    const { token, doctor } = await invited();
    const patient = await signupPatient();
    await sys(() => storage.blockUser(patient.id, doctor.id));
    expect((await preview(patient, { token })).status).toBe(404);
    expect((await accept(patient, { token })).status).toBe(404);
  });

  it("lets exactly one of several simultaneous patients win a code", async () => {
    const { token, doctor, id } = await invited();
    const patients = await Promise.all(Array.from({ length: 6 }, () => signupPatient()));
    const results = await Promise.all(patients.map((p) => accept(p, { token })));
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 404)).toHaveLength(5);
    const rows = await sys(() => db.select().from(pairingRequests).where(eq(pairingRequests.invitationId, id)));
    expect(rows).toHaveLength(1);
    const winner = patients[results.findIndex((r) => r.status === 201)];
    expect(rows[0].patientUserId).toBe(winner.id);
    void doctor;
  });

  it("turns a patient's own pending request into a connection instead of making a second one, and repeats are harmless", async () => {
    const { token, doctor } = await invited();
    const patient = await signupPatient();
    const asked = await request(app).post("/api/pairings").set(auth(patient.token)).send({ doctorProfileId: doctor.profileId });
    expect(asked.status).toBe(201);
    const first = await accept(patient, { token });
    expect(first.status).toBe(201);
    expect(first.body.pairingId).toBe(asked.body.id);
    expect(await pairingsOf(patient.id, doctor.profileId)).toHaveLength(1);
    const again = await accept(patient, { token }); // a retry after a slow network
    expect(again.status).toBe(200);
    expect(again.body.pairingId).toBe(first.body.pairingId);
  });

  it("answers a retry soon after, but a code used long ago is no longer 'repeated' into existence", async () => {
    const { token, id } = await invited();
    const patient = await signupPatient();
    expect((await accept(patient, { token })).status).toBe(201);
    expect((await accept(patient, { token })).status).toBe(200);
    await sys(() => db.update(pairingInvitations).set({ acceptedAt: new Date(Date.now() - 3_600_000) }).where(eq(pairingInvitations.id, id)));
    expect((await accept(patient, { token })).status).toBe(404);
  });

  it("limits how fast codes can be tried", async () => {
    const patient = await signupPatient();
    const statuses: number[] = [];
    process.env.TEST_RATE_LIMITS = "on";
    try {
      for (let i = 0; i < 14; i++) statuses.push((await preview(patient, { code: `AAAA-${String(2222 + i)}` })).status);
    } finally {
      delete process.env.TEST_RATE_LIMITS;
    }
    expect(statuses.slice(0, 12).every((s) => s === 404)).toBe(true);
    expect(statuses.slice(12)).toContain(429);
  });

  it("creates the connection only if the whole transaction commits", async () => {
    const { token, doctor, id } = await invited();
    const patient = await signupPatient();
    await ownerPool.query(`CREATE OR REPLACE FUNCTION zz_fail_invitation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'simulated failure'; END $$`);
    await ownerPool.query(`CREATE TRIGGER zz_fail BEFORE UPDATE ON pairing_invitations FOR EACH ROW WHEN (NEW.id = '${id}') EXECUTE FUNCTION zz_fail_invitation()`);
    try {
      expect((await accept(patient, { token })).status).toBe(500);
    } finally {
      await ownerPool.query("DROP TRIGGER IF EXISTS zz_fail ON pairing_invitations");
    }
    expect(await pairingsOf(patient.id, doctor.profileId)).toHaveLength(0);
    const [row] = await sys(() => db.select().from(pairingInvitations).where(eq(pairingInvitations.id, id)));
    expect(row.status).toBe("pending");
    expect((await accept(patient, { token })).status).toBe(201); // and it still works afterwards
  });
});
