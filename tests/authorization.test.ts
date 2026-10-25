import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { getApp, signupPatient, createDoctor, createAdmin, createCaregiverAccount, connect, auth, issuePrescription } from "./helpers";
import { storage } from "../server/storage";

let app: Express;
beforeAll(async () => {
  app = await getApp();
});

async function bookedAppointment(patientId: string, doctorProfileId: string, pairingId: string) {
  return storage.createAppointment({
    pairingRequestId: pairingId,
    patientUserId: patientId,
    doctorProfileId,
    type: "Video Visit",
    reason: "Persistent cough",
    scheduledAt: new Date(Date.now() + 3 * 24 * 3600 * 1000),
    durationMinutes: 30,
    questionsForDoctor: [],
  });
}

describe("appointments: object-level authorization", () => {
  it("lets only the owning patient and the treating doctor read an appointment", async () => {
    const patient = await signupPatient();
    const stranger = await signupPatient();
    const doctor = await createDoctor();
    const otherDoctor = await createDoctor();
    const { pairingId } = await connect(patient, doctor);
    const appt = await bookedAppointment(patient.id, doctor.profileId, pairingId);

    expect((await request(app).get(`/api/appointments/${appt.id}`).set(auth(patient.token))).status).toBe(200);
    expect((await request(app).get(`/api/appointments/${appt.id}`).set(auth(doctor.token))).status).toBe(200);
    expect((await request(app).get(`/api/appointments/${appt.id}`).set(auth(stranger.token))).status).toBe(404);
    expect((await request(app).get(`/api/appointments/${appt.id}`).set(auth(otherDoctor.token))).status).toBe(404);
  });

  it("denies caregivers and admins direct access to an appointment, even though they hold a valid login", async () => {
    const patient = await signupPatient();
    const doctor = await createDoctor();
    const { pairingId } = await connect(patient, doctor);
    const appt = await bookedAppointment(patient.id, doctor.profileId, pairingId);
    const caregiver = await createCaregiverAccount();
    const admin = await createAdmin();

    for (const who of [caregiver, admin]) {
      const read = await request(app).get(`/api/appointments/${appt.id}`).set(auth(who.token));
      expect([403, 404]).toContain(read.status);
      expect(read.body.reason).toBeUndefined();
      const cancel = await request(app).patch(`/api/appointments/${appt.id}/cancel`).set(auth(who.token));
      expect([403, 404]).toContain(cancel.status);
    }
    const still = await storage.getAppointment(appt.id);
    expect(still!.status).not.toBe("cancelled");
  });
});

describe("symptom reports and consent", () => {
  it("shows the attached symptoms to the requested doctor so they can decide whether to accept", async () => {
    const patient = await signupPatient();
    const doctor = await createDoctor();
    const { pairingId } = await connect(patient, doctor, { accept: false });
    const res = await request(app).get(`/api/pairings/${pairingId}/symptom-report`).set(auth(doctor.token));
    expect(res.status).toBe(200);
  });

  it("does not show them to any other doctor", async () => {
    const patient = await signupPatient();
    const doctor = await createDoctor();
    const other = await createDoctor();
    const { pairingId } = await connect(patient, doctor, { accept: false });
    const res = await request(app).get(`/api/pairings/${pairingId}/symptom-report`).set(auth(other.token));
    expect(res.status).toBe(404);
    expect(res.body.symptomText).toBeUndefined();
  });

  it("does not show them once the patient cancels the request", async () => {
    const patient = await signupPatient();
    const doctor = await createDoctor();
    const { pairingId } = await connect(patient, doctor, { accept: false });
    await request(app).patch(`/api/pairings/${pairingId}/cancel`).set(auth(patient.token));
    const res = await request(app).get(`/api/pairings/${pairingId}/symptom-report`).set(auth(doctor.token));
    expect(res.status).toBe(403);
  });

  it("does not show a symptom report to a doctor who declined", async () => {
    const patient = await signupPatient();
    const doctor = await createDoctor();
    const { pairingId } = await connect(patient, doctor, { accept: false });
    await request(app).patch(`/api/pairings/${pairingId}/decline`).set(auth(doctor.token));
    const res = await request(app).get(`/api/pairings/${pairingId}/symptom-report`).set(auth(doctor.token));
    expect([403, 404]).toContain(res.status);
  });

  it("shows it to the accepting doctor, and writes an audit entry for that access", async () => {
    const patient = await signupPatient();
    const doctor = await createDoctor();
    const { pairingId } = await connect(patient, doctor);
    const res = await request(app).get(`/api/pairings/${pairingId}/symptom-report`).set(auth(doctor.token));
    expect(res.status).toBe(200);
    expect(res.body.symptomText).toContain("cough");
  });
});

describe("ending a connection", () => {
  it("lets the patient end an accepted connection, which cuts the doctor's access immediately", async () => {
    const patient = await signupPatient();
    const doctor = await createDoctor();
    const { pairingId } = await connect(patient, doctor);

    const end = await request(app).patch(`/api/pairings/${pairingId}/end`).set(auth(patient.token));
    expect(end.status).toBe(200);

    expect((await request(app).get(`/api/pairings/${pairingId}/symptom-report`).set(auth(doctor.token))).status).toBeGreaterThanOrEqual(403);
    expect((await request(app).get(`/api/pairings/${pairingId}/messages`).set(auth(doctor.token))).status).toBe(403);
    expect(
      (await request(app).post(`/api/pairings/${pairingId}/messages`).set(auth(doctor.token)).send({ body: "hello?" })).status,
    ).toBe(403);
  });

  it("does not let anyone else end a connection", async () => {
    const patient = await signupPatient();
    const stranger = await signupPatient();
    const doctor = await createDoctor();
    const { pairingId } = await connect(patient, doctor);
    expect((await request(app).patch(`/api/pairings/${pairingId}/end`).set(auth(stranger.token))).status).toBe(404);
    expect((await request(app).patch(`/api/pairings/${pairingId}/end`).set(auth(doctor.token))).status).toBe(403);
  });

  it("allows a patient to request the same doctor again after ending", async () => {
    const patient = await signupPatient();
    const doctor = await createDoctor();
    const { pairingId } = await connect(patient, doctor);
    await request(app).patch(`/api/pairings/${pairingId}/end`).set(auth(patient.token));
    const again = await request(app).post("/api/pairings").set(auth(patient.token)).send({ doctorProfileId: doctor.profileId });
    expect(again.status).toBe(201);
  });

  it("refuses a second request to a doctor the patient is already connected to", async () => {
    const patient = await signupPatient();
    const doctor = await createDoctor();
    await connect(patient, doctor);
    const dup = await request(app).post("/api/pairings").set(auth(patient.token)).send({ doctorProfileId: doctor.profileId });
    expect(dup.status).toBe(409);
  });
});

describe("messaging", () => {
  it("is limited to the two parties of an accepted connection", async () => {
    const patient = await signupPatient();
    const stranger = await signupPatient();
    const doctor = await createDoctor();
    const otherDoctor = await createDoctor();
    const { pairingId } = await connect(patient, doctor);

    const sent = await request(app).post(`/api/pairings/${pairingId}/messages`).set(auth(patient.token)).send({ body: "Hello doctor" });
    expect(sent.status).toBe(201);
    expect((await request(app).get(`/api/pairings/${pairingId}/messages`).set(auth(doctor.token))).body).toHaveLength(1);
    expect((await request(app).get(`/api/pairings/${pairingId}/messages`).set(auth(stranger.token))).status).toBe(404);
    expect((await request(app).get(`/api/pairings/${pairingId}/messages`).set(auth(otherDoctor.token))).status).toBe(404);
  });
});

describe("unauthenticated access", () => {
  it.each([
    ["GET", "/api/appointments"],
    ["GET", "/api/pairings"],
    ["GET", "/api/medications/today"],
    ["GET", "/api/documents"],
    ["GET", "/api/timeline"],
    ["GET", "/api/care-circle"],
    ["GET", "/api/audit-log"],
    ["GET", "/api/admin/doctor-applications"],
    ["POST", "/api/ai/chat"],
  ])("%s %s requires a login", async (method, path) => {
    const res = await (request(app) as any)[method.toLowerCase()](path).send({});
    expect(res.status).toBe(401);
  });

  it("forbids a patient from admin and doctor endpoints", async () => {
    const patient = await signupPatient();
    expect((await request(app).get("/api/admin/doctor-applications").set(auth(patient.token))).status).toBe(403);
    expect((await request(app).get("/api/pairings/doctor").set(auth(patient.token))).status).toBe(403);
    expect((await request(app).get("/api/appointments/doctor").set(auth(patient.token))).status).toBe(403);
  });
});

describe("sharing grants end with the connection", () => {
  const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

  it("a doctor the patient has stopped sharing with can no longer open their documents", async () => {
    const patient = await signupPatient();
    const doctor = await createDoctor();
    const { pairingId } = await connect(patient, doctor);
    const up = await request(app).post("/api/documents").set(auth(patient.token)).field("title", "Scan").attach("file", PNG, { filename: "s.png", contentType: "image/png" });
    await request(app).put(`/api/sharing/${doctor.profileId}`).set(auth(patient.token)).send({ shareDocuments: true });

    expect((await request(app).get(`/api/documents/${up.body.id}/file`).set(auth(doctor.token))).status).toBe(200);

    await request(app).patch(`/api/pairings/${pairingId}/end`).set(auth(patient.token));

    expect((await request(app).get(`/api/documents/${up.body.id}/file`).set(auth(doctor.token))).status).toBe(404);
    const shared = await request(app).get("/api/sharing/shared-with-me").set(auth(doctor.token));
    expect(shared.body.filter((g: any) => g.patientUserId === patient.id)).toHaveLength(0);
  });

  it("a grant can only be made to a doctor the patient is connected with", async () => {
    const patient = await signupPatient();
    const stranger = await createDoctor();
    const res = await request(app).put(`/api/sharing/${stranger.profileId}`).set(auth(patient.token)).send({ shareDocuments: true });
    expect(res.status).toBe(404);
  });
});

describe("what a doctor can read about a patient beyond the visit", () => {
  async function setup() {
    const patient = await signupPatient();
    const doctor = await createDoctor();
    const other = await createDoctor({ name: "Dr. Other", specialty: "Cardiology" });
    const { pairingId } = await connect(patient, doctor);
    const { pairingId: otherPairing } = await connect(patient, other);
    // A medicine, a document, and a visit with the OTHER doctor.
    const rx = { body: await issuePrescription(other, otherPairing, { medicationName: "Demo Heart Tablet", instructions: "Daily" }) };
    await request(app).post(`/api/prescriptions/${rx.body.id}/track`).set(auth(patient.token));
    await request(app).post("/api/documents").set(auth(patient.token)).field("title", "Blood test results");
    await storage.createAppointment({
      pairingRequestId: otherPairing, patientUserId: patient.id, doctorProfileId: other.profileId, type: "Phone Call",
      reason: "PRIVATE-REASON", scheduledAt: new Date(Date.now() + 5 * 86400000), durationMinutes: 30, questionsForDoctor: [],
    });
    return { patient, doctor, pairingId };
  }
  const read = (token: string, pairingId: string) => request(app).get(`/api/pairings/${pairingId}/shared-records`).set(auth(token));

  it("shows nothing at all until the patient grants something", async () => {
    const { doctor, pairingId } = await setup();
    const res = await read(doctor.token, pairingId);
    expect(res.status).toBe(200);
    expect(res.body.medications).toBeUndefined();
    expect(res.body.documents).toBeUndefined();
    expect(res.body.appointments).toBeUndefined();
  });

  it("shows exactly the categories granted — and never visit reasons or notes from other doctors", async () => {
    const { patient, doctor, pairingId } = await setup();
    await request(app).put(`/api/sharing/${doctor.profileId}`).set(auth(patient.token)).send({ shareMedications: true });
    let res = await read(doctor.token, pairingId);
    expect(res.body.medications.map((m: any) => m.name)).toEqual(["Demo Heart Tablet"]);
    expect(res.body.documents).toBeUndefined();
    expect(res.body.appointments).toBeUndefined();

    await request(app).put(`/api/sharing/${doctor.profileId}`).set(auth(patient.token)).send({ shareMedications: true, shareDocuments: true, shareAppointments: true });
    res = await read(doctor.token, pairingId);
    expect(res.body.documents.map((d: any) => d.title)).toContain("Blood test results");
    expect(res.body.appointments).toHaveLength(1);
    expect(JSON.stringify(res.body)).not.toContain("PRIVATE-REASON");
  });

  it("stops the moment the grant is withdrawn or the connection ends", async () => {
    const { patient, doctor, pairingId } = await setup();
    await request(app).put(`/api/sharing/${doctor.profileId}`).set(auth(patient.token)).send({ shareMedications: true });
    expect((await read(doctor.token, pairingId)).body.medications).toBeDefined();

    await request(app).delete(`/api/sharing/${doctor.profileId}`).set(auth(patient.token));
    expect((await read(doctor.token, pairingId)).body.medications).toBeUndefined();

    await request(app).put(`/api/sharing/${doctor.profileId}`).set(auth(patient.token)).send({ shareMedications: true });
    await request(app).patch(`/api/pairings/${pairingId}/end`).set(auth(patient.token));
    expect((await read(doctor.token, pairingId)).status).toBe(403);
  });

  it("is only for the connected doctor — not another doctor, not the patient's other contacts", async () => {
    const { patient, pairingId } = await setup();
    const stranger = await createDoctor();
    expect((await read(stranger.token, pairingId)).status).toBe(404);
    expect((await read(patient.token, pairingId)).status).toBe(403);
  });
});
