import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { getApp, signupPatient, createAdmin, connect, auth, uniqueEmail, PASSWORD, prescriptionBody, signIn, completeSecondFactor } from "./helpers";
import { storage } from "../server/storage";

let app: Express;
beforeAll(async () => {
  app = await getApp();
});

const APPLICATION = {
  professionalRole: "physician", specialty: "Cardiology", state: "CA", licenseNumber: "SUSP-1", licensingBody: "Board",
  languages: ["en"], modalities: ["phone"], phone: "+15550007777",
};

// A doctor who WAS approved and had real patients, then is suspended: the
// harshest test of "no clinical access", because everything they could
// previously reach still exists.
async function suspendedDoctorWithPatient(opts: { suspend?: boolean } = {}) {
  const admin = await createAdmin();
  const email = uniqueEmail("susp");
  const reg = await request(app).post("/api/doctors/register").send({ name: "Dr. Soon Suspended", email, password: PASSWORD });
  const session = await completeSecondFactor(reg.body, email);
  const regToken = session.token as string;
  await request(app).put("/api/doctors/me/application").set(auth(regToken)).send(APPLICATION);
  const submitted = await request(app).post("/api/doctors/me/application/submit").set(auth(regToken));
  await request(app).post(`/api/admin/doctor-applications/${submitted.body.id}/approve`).set(auth(admin.token));
  const approvedLogin = (await signIn(email)).token as string;
  const profile = (await storage.getDoctorProfileByUserId(session.user.id))!;
  const doctor = { id: session.user.id as string, email, token: approvedLogin, profileId: profile.id };

  const patient = await signupPatient({ state: "CA" });
  const { pairingId } = await connect(patient, doctor);
  // Everything a connected doctor can normally touch.
  const doc = await request(app).post("/api/documents").set(auth(patient.token)).field("title", "Blood test").attach("file", Buffer.from("lab values"), { filename: "lab.txt", contentType: "text/plain" });
  expect(doc.status).toBe(201);
  const grant = await request(app).put(`/api/sharing/${doctor.profileId}`).set(auth(patient.token)).send({ shareMedications: true, shareDocuments: true, shareAppointments: true, shareFullHistory: false });
  expect(grant.status).toBe(200);
  const appt = await storage.createAppointment({
    pairingRequestId: pairingId, patientUserId: patient.id, doctorProfileId: doctor.profileId, type: "Phone Call", reason: "private reason",
    scheduledAt: new Date(Date.now() + 3 * 86400000), durationMinutes: 30, questionsForDoctor: [],
  });
  const draft = await request(app).post("/api/prescriptions").set(auth(doctor.token)).send(prescriptionBody(pairingId));

  const suspend = () => request(app).post(`/api/admin/doctor-applications/${submitted.body.id}/suspend`).set(auth(admin.token)).send({ reason: "test" });
  if (opts.suspend === false) return { token: approvedLogin, patient, pairingId, appt, draftId: draft.body.id as string, doctor, docId: doc.body.id as string, suspend };
  await suspend();
  const token = (await signIn(email)).token as string;
  return { token, patient, pairingId, appt, draftId: draft.body.id as string, doctor, docId: doc.body.id as string, suspend };
}

describe("a suspended doctor", () => {
  it("is cut off from every patient, record and action they could reach a moment earlier", async () => {
    const { token, pairingId, appt, draftId, patient } = await suspendedDoctorWithPatient();
    const h = auth(token);
    const get = (p: string) => request(app).get(p).set(h);
    const send = (m: "post" | "patch" | "put", p: string, body: object = {}) => (request(app) as any)[m](p).set(h).send(body);

    const forbiddenReads = [
      "/api/pairings/doctor", "/api/appointments/doctor", `/api/appointments/${appt.id}`, `/api/appointments/${appt.id}/video`,
      "/api/prescriptions/doctor", `/api/prescriptions/${draftId}/history`, "/api/sharing/shared-with-me", "/api/dashboard/doctor",
      `/api/pairings/${pairingId}/symptom-report`, `/api/pairings/${pairingId}/shared-records`, "/api/doctors/me/availability", "/api/doctors/me/profile",
    ];
    for (const path of forbiddenReads) expect((await get(path)).status, path).toBe(403);

    // Messages in a connection they used to be part of: as if it doesn't exist.
    expect((await get(`/api/pairings/${pairingId}/messages`)).status).toBe(404);
    expect((await send("post", `/api/pairings/${pairingId}/messages`, { body: "hello?" })).status).toBe(404);

    const forbiddenWrites: [string, string, object][] = [
      ["patch", `/api/appointments/${appt.id}/confirm`, {}], ["post", `/api/appointments/${appt.id}/complete`, { doctorNotes: "x" }],
      ["patch", `/api/appointments/${appt.id}/cancel`, {}], ["post", "/api/prescriptions", prescriptionBody(pairingId)],
      ["post", `/api/prescriptions/${draftId}/authorize`, { confirm: true }], ["patch", `/api/prescriptions/${draftId}/cancel`, {}],
      ["patch", `/api/pairings/${pairingId}/accept`, {}], ["put", "/api/doctors/me/availability", { timezone: "UTC", windows: [] }],
    ];
    for (const [m, path, body] of forbiddenWrites) expect((await send(m as any, path, body)).status, `${m} ${path}`).toBe(403);

    // The prescription that was still a draft was not authorized behind the patient's back.
    expect((await storage.getPrescription(draftId))!.status).toBe("draft");
    expect((await request(app).get("/api/prescriptions").set(auth(patient.token))).body).toEqual([]);
  });

  it("could open the patient's shared document while approved, and can't once suspended, though the sharing grant still exists", async () => {
    const ctx = await suspendedDoctorWithPatient({ suspend: false });
    const { token, docId, suspend } = ctx;
    expect((await request(app).get(`/api/documents/${docId}/file`).set(auth(token))).status).toBe(200); // the control
    const { doctor } = ctx;
    await suspend();
    const later = (await signIn(doctor.email)).token as string;
    expect([403, 404]).toContain((await request(app).get(`/api/documents/${docId}/file`).set(auth(later))).status);
  });

  it("does not appear to patients any more", async () => {
    const { doctor } = await suspendedDoctorWithPatient();
    const list = (await request(app).get("/api/doctors")).body as { id: string }[];
    expect(list.map((d) => d.id)).not.toContain(doctor.profileId);
  });
});
