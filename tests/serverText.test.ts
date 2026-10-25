import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { getApp, signupPatient, createDoctor, connect, auth, issuePrescription } from "./helpers";

let app: Express;
beforeAll(async () => {
  app = await getApp();
});

describe("sentences the server writes follow the person's language", () => {
  async function setup() {
    const patient = await signupPatient();
    const doctor = await createDoctor({ name: "Dr. Layla Nasser" });
    const { pairingId } = await connect(patient, doctor);
    await request(app).get(`/api/pairings/${pairingId}/symptom-report`).set(auth(doctor.token));
    await issuePrescription(doctor, pairingId, { medicationName: "Zyrtec" });
    return { patient, doctor };
  }

  it("shows the access log and the timeline in English by default, naming the doctor as written", async () => {
    const { patient } = await setup();
    const log = (await request(app).get("/api/audit-log").set(auth(patient.token))).body as { text: string }[];
    expect(log.some((e) => e.text === "Dr. Layla Nasser read what you wrote when you asked for help")).toBe(true);
    const timeline = (await request(app).get("/api/timeline").set(auth(patient.token))).body as { title: string }[];
    expect(timeline.some((e) => e.title === "New prescription: Zyrtec")).toBe(true);
  });

  it("shows them in Arabic once the account's language is Arabic, leaving names and medicines untouched", async () => {
    const { patient } = await setup();
    expect((await request(app).patch("/api/auth/me/preferences").set(auth(patient.token)).send({ language: "ar" })).status).toBe(200);
    const log = (await request(app).get("/api/audit-log").set(auth(patient.token))).body as { text: string }[];
    expect(log.some((e) => e.text === "اطّلع Dr. Layla Nasser على ما كتبته عندما طلبت المساعدة")).toBe(true);
    const timeline = (await request(app).get("/api/timeline").set(auth(patient.token))).body as { title: string }[];
    expect(timeline.some((e) => e.title === "وصفة طبية جديدة: Zyrtec")).toBe(true);
    // No English template text leaks into the Arabic reply.
    expect(JSON.stringify(timeline)).not.toMatch(/Connected with|Appointment|prescription:/);
  });

  it("only accepts the languages Avela has", async () => {
    const patient = await signupPatient();
    for (const bad of ["fr", "", "AR", 5]) {
      expect((await request(app).patch("/api/auth/me/preferences").set(auth(patient.token)).send({ language: bad })).status).toBe(400);
    }
  });
});
