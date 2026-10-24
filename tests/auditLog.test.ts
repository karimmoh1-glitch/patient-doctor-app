import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { getApp, signupPatient, createDoctor, connect, auth } from "./helpers";
import { storage } from "../server/storage";
import { db } from "../server/db";
import { auditLogs } from "@shared/schema";
import { eq } from "drizzle-orm";

let app: Express;
beforeAll(async () => {
  app = await getApp();
});

describe("a patient's own access log", () => {
  it("shows who looked at their information, by name, and what they changed — and nobody else's events", async () => {
    const patient = await signupPatient();
    const bystander = await signupPatient();
    const doctor = await createDoctor({ name: "Dr. Log Reader" });
    const { pairingId } = await connect(patient, doctor);
    await connect(bystander, doctor);

    await request(app).get(`/api/pairings/${pairingId}/symptom-report`).set(auth(doctor.token));
    await request(app).put(`/api/sharing/${doctor.profileId}`).set(auth(patient.token)).send({ shareMedications: true });

    const mine = await request(app).get("/api/audit-log").set(auth(patient.token));
    expect(mine.status).toBe(200);
    const texts = mine.body.map((e: any) => e.text);
    expect(texts).toContain("Dr. Log Reader read what you wrote when you asked for help");
    expect(texts).toContain("You changed what a doctor can see");
    expect(mine.body.find((e: any) => e.text.includes("Dr. Log Reader read")).kind).toBe("access");

    // The bystander's own log has none of this patient's events.
    const theirs = await request(app).get("/api/audit-log").set(auth(bystander.token));
    expect(theirs.body.map((e: any) => e.text).join(" ")).not.toContain("read what you wrote");
  });

  it("does not lose a patient's history on a busy system", async () => {
    const patient = await signupPatient();
    const doctor = await createDoctor({ name: "Dr. Early Reader" });
    const { pairingId } = await connect(patient, doctor);
    await request(app).get(`/api/pairings/${pairingId}/symptom-report`).set(auth(doctor.token));

    // 400 unrelated events from other people land after it (the old design looked only at the latest 300).
    const noise = await signupPatient();
    await Promise.all(
      Array.from({ length: 400 }, () => storage.createAuditLog({ actorUserId: noise.id, subjectUserId: noise.id, action: "ai.chat", targetType: "user", targetId: noise.id, metadata: null })),
    );

    const log = await request(app).get("/api/audit-log").set(auth(patient.token));
    expect(log.body.map((e: any) => e.text)).toContain("Dr. Early Reader read what you wrote when you asked for help");
  });

  it("records the doctor's access against the patient, not just the doctor", async () => {
    const patient = await signupPatient();
    const doctor = await createDoctor();
    const { pairingId } = await connect(patient, doctor);
    await request(app).get(`/api/pairings/${pairingId}/symptom-report`).set(auth(doctor.token));
    const rows = await db.select().from(auditLogs).where(eq(auditLogs.actorUserId, doctor.id));
    const read = rows.find((r) => r.action === "doctor.viewed_paired_patient");
    expect(read?.subjectUserId).toBe(patient.id);
  });

  it("requires a login and is for patients only", async () => {
    expect((await request(app).get("/api/audit-log")).status).toBe(401);
    const doctor = await createDoctor();
    expect((await request(app).get("/api/audit-log").set(auth(doctor.token))).status).toBe(403);
  });
});

describe("sensitive reads fail closed", () => {
  it("does not disclose a patient's symptoms if the access cannot be recorded", async () => {
    const patient = await signupPatient();
    const doctor = await createDoctor();
    const { pairingId } = await connect(patient, doctor);

    const original = storage.createAuditLog.bind(storage);
    storage.createAuditLog = (async () => {
      throw new Error("audit store down");
    }) as typeof storage.createAuditLog;
    try {
      const res = await request(app).get(`/api/pairings/${pairingId}/symptom-report`).set(auth(doctor.token));
      expect(res.status).toBe(500);
      expect(res.body.symptomText).toBeUndefined();
    } finally {
      storage.createAuditLog = original;
    }
  });

  it("still lets ordinary actions succeed when only the descriptive log fails", async () => {
    const patient = await signupPatient();
    const original = storage.createAuditLog.bind(storage);
    storage.createAuditLog = (async () => {
      throw new Error("audit store down");
    }) as typeof storage.createAuditLog;
    try {
      const res = await request(app).post("/api/symptom-reports").set(auth(patient.token)).send({ symptomText: "A mild headache", inputMethod: "typed" });
      expect(res.status).toBe(201);
    } finally {
      storage.createAuditLog = original;
    }
  });
});
