import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { getApp, signupPatient, createDoctor, connect, auth, type TestUser, issuePrescription } from "./helpers";
import { dateKeyInZone, clockInZone, isValidZone } from "../server/lib/localTime";

let app: Express;
beforeAll(async () => {
  app = await getApp();
});

describe("the patient's own day", () => {
  it("is computed in their time zone, not UTC", () => {
    // 03:00 UTC on Oct 25 is still the evening of Oct 24 in California.
    const instant = new Date("2026-10-25T03:00:00Z");
    expect(dateKeyInZone(instant, "America/Los_Angeles")).toBe("2026-10-24");
    expect(clockInZone(instant, "America/Los_Angeles")).toBe("20:00");
    expect(dateKeyInZone(instant, "UTC")).toBe("2026-10-25");
    expect(dateKeyInZone(instant, "Pacific/Auckland")).toBe("2026-10-25");
  });

  it("accepts real zones and rejects junk", () => {
    expect(isValidZone("America/Chicago")).toBe(true);
    expect(isValidZone("Mars/Olympus")).toBe(false);
    expect(isValidZone("")).toBe(false);
    expect(isValidZone(undefined)).toBe(false);
  });
});

async function patientWithMedication(): Promise<{ patient: TestUser; medicationId: string }> {
  const patient = await signupPatient();
  const doctor = await createDoctor();
  const { pairingId } = await connect(patient, doctor);
  const rx = { body: await issuePrescription(doctor, pairingId, { instructions: "One with water" }) };
  const tracked = await request(app).post(`/api/prescriptions/${rx.body.id}/track`).set(auth(patient.token));
  expect(tracked.status).toBe(201);
  return { patient, medicationId: tracked.body.id };
}

const withZone = (token: string, tz: string) => ({ ...auth(token), "X-Timezone": tz });

describe("logging a dose", () => {
  it("records it against the patient's own today, and undo puts it back to 'not yet logged'", async () => {
    const { patient, medicationId } = await patientWithMedication();
    const h = withZone(patient.token, "America/Chicago");

    const before = await request(app).get("/api/medications/today").set(h);
    const dose = before.body.schedule[0];
    expect(dose.status).toBe("upcoming");

    expect((await request(app).post(`/api/medications/${medicationId}/log`).set(h).send({ doseTime: dose.time, status: "taken" })).status).toBe(200);
    expect((await request(app).get("/api/medications/today").set(h)).body.schedule[0].status).toBe("taken");

    expect((await request(app).delete(`/api/medications/${medicationId}/log?doseTime=${dose.time}`).set(h)).status).toBe(200);
    expect((await request(app).get("/api/medications/today").set(h)).body.schedule[0].status).toBe("upcoming");
  });

  it("belongs to a calendar day: a zone more than a day away does not see it", async () => {
    const { patient, medicationId } = await patientWithMedication();
    const dose = (await request(app).get("/api/medications/today").set(withZone(patient.token, "Pacific/Kiritimati"))).body.schedule[0];
    await request(app).post(`/api/medications/${medicationId}/log`).set(withZone(patient.token, "Pacific/Kiritimati")).send({ doseTime: dose.time, status: "taken" });

    // UTC+14 and UTC-11 are 25 hours apart, so their calendar dates always differ.
    const elsewhere = await request(app).get("/api/medications/today").set(withZone(patient.token, "Pacific/Pago_Pago"));
    expect(elsewhere.body.schedule[0].status).toBe("upcoming");
  });

  it("ignores a client-supplied date, so history can't be back-filled", async () => {
    const { patient, medicationId } = await patientWithMedication();
    const h = withZone(patient.token, "America/New_York");
    const dose = (await request(app).get("/api/medications/today").set(h)).body.schedule[0];
    const res = await request(app).post(`/api/medications/${medicationId}/log`).set(h).send({ doseTime: dose.time, status: "taken", doseDate: "2020-01-01" });
    expect(res.status).toBe(200);
    expect(res.body.doseDate).not.toBe("2020-01-01");
  });

  it("only lets the owner log or undo", async () => {
    const { patient, medicationId } = await patientWithMedication();
    const other = await signupPatient();
    const dose = (await request(app).get("/api/medications/today").set(auth(patient.token))).body.schedule[0];
    expect((await request(app).post(`/api/medications/${medicationId}/log`).set(auth(other.token)).send({ doseTime: dose.time, status: "taken" })).status).toBe(404);
    expect((await request(app).delete(`/api/medications/${medicationId}/log?doseTime=${dose.time}`).set(auth(other.token))).status).toBe(404);
  });

  it("rejects a time that isn't on the schedule", async () => {
    const { patient, medicationId } = await patientWithMedication();
    expect((await request(app).post(`/api/medications/${medicationId}/log`).set(auth(patient.token)).send({ doseTime: "03:17", status: "taken" })).status).toBe(400);
  });
});

describe("the remembered time zone", () => {
  it("is saved from the browser and used when it is not sent", async () => {
    const patient = await signupPatient();
    await request(app).get("/api/dashboard").set(withZone(patient.token, "America/Denver"));
    const { storage } = await import("../server/storage");
    expect((await storage.getUser(patient.id))!.timezone).toBe("America/Denver");
    // A garbage header is ignored rather than stored.
    await request(app).get("/api/dashboard").set({ ...auth(patient.token), "X-Timezone": "Not/AZone" });
    expect((await storage.getUser(patient.id))!.timezone).toBe("America/Denver");
  });
});
