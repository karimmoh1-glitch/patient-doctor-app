import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { getApp, signupPatient, createDoctor, connect, auth, prescriptionBody, issuePrescription } from "./helpers";
import { storage } from "../server/storage";

let app: Express;
beforeAll(async () => {
  app = await getApp();
});

async function setup() {
  const patient = await signupPatient();
  const doctor = await createDoctor();
  const { pairingId } = await connect(patient, doctor);
  return { patient, doctor, pairingId };
}

describe("prescription lifecycle", () => {
  it("is created as a draft the patient cannot see until the doctor authorizes it", async () => {
    const { patient, doctor, pairingId } = await setup();
    const draft = await request(app).post("/api/prescriptions").set(auth(doctor.token)).send(prescriptionBody(pairingId));
    expect(draft.status).toBe(201);
    expect(draft.body.status).toBe("draft");
    expect(draft.body.authorizedAt).toBeNull();

    expect((await request(app).get("/api/prescriptions").set(auth(patient.token))).body).toEqual([]);
    // …and cannot be tracked, refilled or ordered while it's a draft.
    expect((await request(app).post(`/api/prescriptions/${draft.body.id}/track`).set(auth(patient.token))).status).toBe(409);
    expect((await request(app).post(`/api/prescriptions/${draft.body.id}/refill`).set(auth(patient.token))).status).toBe(409);

    const authorized = await request(app).post(`/api/prescriptions/${draft.body.id}/authorize`).set(auth(doctor.token)).send({ confirm: true });
    expect(authorized.status).toBe(200);
    expect(authorized.body.status).toBe("active");
    expect(authorized.body.authorizedAt).toBeTruthy();
    expect(authorized.body.transmission).toBe("not_sent");

    const mine = await request(app).get("/api/prescriptions").set(auth(patient.token));
    expect(mine.body).toHaveLength(1);
    expect(mine.body[0].medicationName).toBe("Demo Tablet");
    expect(mine.body[0].notes).toBeUndefined();
  });

  it("requires the doctor's explicit confirmation to authorize", async () => {
    const { doctor, pairingId } = await setup();
    const draft = await request(app).post("/api/prescriptions").set(auth(doctor.token)).send(prescriptionBody(pairingId));
    expect((await request(app).post(`/api/prescriptions/${draft.body.id}/authorize`).set(auth(doctor.token)).send({})).status).toBe(400);
    expect((await request(app).post(`/api/prescriptions/${draft.body.id}/authorize`).set(auth(doctor.token)).send({ confirm: "yes" })).status).toBe(400);
  });

  it("can be edited only while a draft; an authorized prescription is immutable", async () => {
    const { doctor, pairingId } = await setup();
    const draft = await request(app).post("/api/prescriptions").set(auth(doctor.token)).send(prescriptionBody(pairingId));
    const edit = await request(app).patch(`/api/prescriptions/${draft.body.id}`).set(auth(doctor.token)).send({ dose: "2 tablets", controlledSubstance: false });
    expect(edit.status).toBe(200);
    expect(edit.body.dose).toBe("2 tablets");
    await request(app).post(`/api/prescriptions/${draft.body.id}/authorize`).set(auth(doctor.token)).send({ confirm: true });
    const after = await request(app).patch(`/api/prescriptions/${draft.body.id}`).set(auth(doctor.token)).send({ dose: "9 tablets", controlledSubstance: false });
    expect(after.status).toBe(409);
    expect((await storage.getPrescription(draft.body.id))!.dose).toBe("2 tablets");
  });

  it("authorizes exactly once when requested twice at the same moment", async () => {
    const { doctor, pairingId } = await setup();
    const draft = await request(app).post("/api/prescriptions").set(auth(doctor.token)).send(prescriptionBody(pairingId));
    const results = await Promise.all([1, 2, 3].map(() => request(app).post(`/api/prescriptions/${draft.body.id}/authorize`).set(auth(doctor.token)).send({ confirm: true })));
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    const history = await request(app).get(`/api/prescriptions/${draft.body.id}/history`).set(auth(doctor.token));
    expect(history.body.map((e: any) => e.event)).toEqual(["drafted", "authorized"]);
  });

  it("records who did what in an append-only history, and the responsible clinician on the record", async () => {
    const { doctor, pairingId } = await setup();
    const rx = await issuePrescription(doctor, pairingId);
    await request(app).patch(`/api/prescriptions/${rx.id}/cancel`).set(auth(doctor.token));
    const history = await request(app).get(`/api/prescriptions/${rx.id}/history`).set(auth(doctor.token));
    expect(history.body.map((e: any) => e.event)).toEqual(["drafted", "authorized", "cancelled"]);
    expect(history.body.every((e: any) => e.actorUserId === doctor.id)).toBe(true);
    expect(rx.authorizedByUserId).toBe(doctor.id);
  });

  it("refuses to record a controlled substance, in either create or edit", async () => {
    const { doctor, pairingId } = await setup();
    const create = await request(app).post("/api/prescriptions").set(auth(doctor.token)).send(prescriptionBody(pairingId, { controlledSubstance: true }));
    expect(create.status).toBe(422);
    expect(create.body.code).toBe("controlled_substance");
    const missing = await request(app).post("/api/prescriptions").set(auth(doctor.token)).send({ ...prescriptionBody(pairingId), controlledSubstance: undefined });
    expect(missing.status).toBe(400); // the question must be answered
    expect(await storage.getPrescriptionsByDoctorProfile(doctor.profileId)).toHaveLength(0);
  });

  it("validates clinical fields on the server", async () => {
    const { doctor, pairingId } = await setup();
    for (const bad of [{ route: "telepathy" }, { dose: "" }, { frequencyPerDay: 0 }, { frequencyPerDay: 9 }, { refillsAllowed: 99 }, { medicationName: "x" }]) {
      const res = await request(app).post("/api/prescriptions").set(auth(doctor.token)).send(prescriptionBody(pairingId, bad));
      expect(res.status, JSON.stringify(bad)).toBe(400);
    }
  });

  it("can only be written by the doctor of record for a connected patient", async () => {
    const { patient, doctor, pairingId } = await setup();
    const stranger = await createDoctor({ name: "Dr. Stranger" });
    const attempt = await request(app).post("/api/prescriptions").set(auth(stranger.token)).send(prescriptionBody(pairingId));
    expect(attempt.status).toBe(404);
    const byPatient = await request(app).post("/api/prescriptions").set(auth(patient.token)).send(prescriptionBody(pairingId));
    expect(byPatient.status).toBe(403);

    const rx = await issuePrescription(doctor, pairingId);
    for (const [method, path] of [
      ["patch", `/api/prescriptions/${rx.id}/cancel`],
      ["post", `/api/prescriptions/${rx.id}/authorize`],
      ["get", `/api/prescriptions/${rx.id}/history`],
    ] as const) {
      expect((await (request(app) as any)[method](path).set(auth(stranger.token)).send({ confirm: true })).status, path).toBe(404);
      expect((await (request(app) as any)[method](path).set(auth(patient.token)).send({ confirm: true })).status, path).toBe(403);
    }
  });

  it("does not let a doctor whose connection has ended write a new prescription", async () => {
    const { patient, doctor, pairingId } = await setup();
    await request(app).patch(`/api/pairings/${pairingId}/end`).set(auth(patient.token));
    const res = await request(app).post("/api/prescriptions").set(auth(doctor.token)).send(prescriptionBody(pairingId));
    expect(res.status).toBe(404);
  });

  it("tells the patient in-app when a prescription is authorized, without naming the medicine", async () => {
    const { patient, doctor, pairingId } = await setup();
    await issuePrescription(doctor, pairingId, { medicationName: "Secret Medicine X" });
    const notes = await storage.getNotificationsForUser(patient.id, 10);
    expect(notes.map((n) => n.kind)).toContain("prescription.authorized");
    expect(JSON.stringify(notes)).not.toMatch(/Secret Medicine X/);
  });

  it("marks a course as expired once its end date has passed", async () => {
    const { patient, doctor, pairingId } = await setup();
    const rx = await issuePrescription(doctor, pairingId, { durationDays: 3 });
    await storage.expireDuePrescriptions(new Date(Date.now() + 10 * 86_400_000));
    const mine = await request(app).get("/api/prescriptions").set(auth(patient.token));
    expect(mine.body.find((p: any) => p.id === rx.id).status).toBe("expired");
  });
});
