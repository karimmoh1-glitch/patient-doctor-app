import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { getApp, signupPatient, createDoctor, createAdmin, connect, auth, uniqueEmail, PASSWORD, issuePrescription } from "./helpers";
import { storage } from "../server/storage";
import { db } from "../server/db";
import { users, followUpTasks } from "@shared/schema";
import { eq } from "drizzle-orm";

let app: Express;
beforeAll(async () => {
  app = await getApp();
});

async function appointmentFor(patientId: string, doctorProfileId: string, pairingId: string, minutesFromNow = 3 * 24 * 60) {
  return storage.createAppointment({
    pairingRequestId: pairingId,
    patientUserId: patientId,
    doctorProfileId,
    type: "Phone Call",
    reason: "Check-up",
    scheduledAt: new Date(Date.now() + minutesFromNow * 60_000),
    durationMinutes: 30,
    questionsForDoctor: [],
  });
}

describe("appointment state changes are guarded", () => {
  it("completes a visit once, keeps the first notes, and creates follow-ups once", async () => {
    const patient = await signupPatient();
    const doctor = await createDoctor();
    const { pairingId } = await connect(patient, doctor);
    const appt = await appointmentFor(patient.id, doctor.profileId, pairingId);

    const body = { doctorNotes: "First notes", followUpInstructions: "Rest and fluids" };
    const [a, b] = await Promise.all([
      request(app).post(`/api/appointments/${appt.id}/complete`).set(auth(doctor.token)).send(body),
      request(app).post(`/api/appointments/${appt.id}/complete`).set(auth(doctor.token)).send({ ...body, doctorNotes: "Second notes" }),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);

    const tasks = await db.select().from(followUpTasks).where(eq(followUpTasks.appointmentId, appt.id));
    expect(tasks).toHaveLength(1);
    const final = await storage.getAppointment(appt.id);
    expect(["First notes", "Second notes"]).toContain(final!.doctorNotes);
  });

  it("will not complete a cancelled visit, or cancel a completed one", async () => {
    const patient = await signupPatient();
    const doctor = await createDoctor();
    const { pairingId } = await connect(patient, doctor);
    const cancelled = await appointmentFor(patient.id, doctor.profileId, pairingId, 4 * 24 * 60);
    await request(app).patch(`/api/appointments/${cancelled.id}/cancel`).set(auth(patient.token));
    expect((await request(app).post(`/api/appointments/${cancelled.id}/complete`).set(auth(doctor.token)).send({ doctorNotes: "x" })).status).toBe(409);

    const done = await appointmentFor(patient.id, doctor.profileId, pairingId, 5 * 24 * 60);
    await request(app).post(`/api/appointments/${done.id}/complete`).set(auth(doctor.token)).send({ doctorNotes: "ok" });
    expect((await request(app).patch(`/api/appointments/${done.id}/cancel`).set(auth(patient.token))).status).toBe(409);
  });

  it("answers a simultaneous accept and decline with exactly one winner", async () => {
    const patient = await signupPatient();
    const doctor = await createDoctor();
    const { pairingId } = await connect(patient, doctor, { accept: false });
    const [accept, decline] = await Promise.all([
      request(app).patch(`/api/pairings/${pairingId}/accept`).set(auth(doctor.token)),
      request(app).patch(`/api/pairings/${pairingId}/decline`).set(auth(doctor.token)),
    ]);
    expect([accept.status, decline.status].sort()).toEqual([200, 409]);
  });
});

describe("refills", () => {
  it("never exceed the number the doctor allowed, even when requested at the same moment, and reach the doctor as a message", async () => {
    const patient = await signupPatient();
    const doctor = await createDoctor();
    const { pairingId } = await connect(patient, doctor);
    const rx = { body: await issuePrescription(doctor, pairingId, { refillsAllowed: 1 }) };

    const results = await Promise.all(Array.from({ length: 5 }, () => request(app).post(`/api/prescriptions/${rx.body.id}/refill`).set(auth(patient.token))));
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(4);
    expect((await storage.getPrescription(rx.body.id))!.refillsUsed).toBe(1);

    const thread = await request(app).get(`/api/pairings/${pairingId}/messages`).set(auth(doctor.token));
    expect(thread.body.filter((m: any) => String(m.body).startsWith("Refill request"))).toHaveLength(1);
  });
});

describe("pharmacy orders", () => {
  it("allows one order per prescription even under simultaneous requests", async () => {
    const patient = await signupPatient();
    const doctor = await createDoctor();
    const { pairingId } = await connect(patient, doctor);
    const rx = { body: await issuePrescription(doctor, pairingId) };
    const pharmacy = await storage.createPharmacy({
      name: "Test Pharmacy", address: "1 Main St", city: "Town", state: "CA", zip: "90000", phone: "+15550002222",
      hoursText: null, deliveryAvailable: true, pickupAvailable: true, isMailOrder: false, distanceMiles: 2,
    });
    const place = () =>
      request(app).post("/api/pharmacy/orders").set(auth(patient.token)).send({ prescriptionId: rx.body.id, pharmacyId: pharmacy.id, fulfillmentType: "pickup" });
    const results = await Promise.all([place(), place(), place()]);
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(2);
  });
});
