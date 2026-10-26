import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { getApp, signupPatient, createDoctor, connect, auth, issuePrescription, prescriptionBody, PASSWORD } from "./helpers";
import { storage } from "../server/storage";
import pg from "pg";
import { pool } from "../server/db";
import { eraseUser } from "../server/services/erasure";

// Erasure is an operator action (`npm run erase:user`) that runs with the owner connection, never through the
// application's restricted role, which cannot edit a sent message by design.
const ownerPool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
afterAll(() => ownerPool.end());

let app: Express;
beforeAll(async () => {
  app = await getApp();
});

async function patientWithRecords() {
  const patient = await signupPatient({ name: "Zainab Erasable" });
  const doctor = await createDoctor({ name: "Dr. Keeper" });
  const { pairingId } = await connect(patient, doctor);
  await request(app).post(`/api/pairings/${pairingId}/messages`).set(auth(patient.token)).send({ body: "My private worry about my heart" });
  await request(app).post(`/api/pairings/${pairingId}/messages`).set(auth(doctor.token)).send({ body: "Doctor reply kept for the record" });
  await request(app).put("/api/emergency-profile").set(auth(patient.token)).send({ emergencyContactName: "Her sister", emergencyContactPhone: "+15550001234", allergiesText: "penicillin", emergencyNotes: null });
  await request(app).post("/api/documents").set(auth(patient.token)).field("title", "My lab results").field("notes", "private note");
  const rx = await issuePrescription(doctor, pairingId, { medicationName: "Visible Medicine" });
  const draft = await request(app).post("/api/prescriptions").set(auth(doctor.token)).send(prescriptionBody(pairingId, { medicationName: "Draft Medicine", notes: "DOCTOR PRIVATE NOTE" }));
  return { patient, doctor, pairingId, rx, draftId: draft.body.id as string };
}

describe("downloading your own data", () => {
  it("gives a patient their information, and only theirs", async () => {
    const { patient } = await patientWithRecords();
    const other = await signupPatient({ name: "Someone Else" });
    await request(app).put("/api/emergency-profile").set(auth(other.token)).send({ emergencyContactName: "OTHERS CONTACT", emergencyContactPhone: "+15559998888", allergiesText: null, emergencyNotes: null });

    const res = await request(app).get("/api/me/export").set(auth(patient.token));
    expect(res.status).toBe(200);
    expect(res.headers["content-disposition"]).toMatch(/attachment; filename="avela-my-data-/);
    const body = res.body;
    expect(body.account.name).toBe("Zainab Erasable");
    expect(body.messages.map((m: any) => m.text)).toEqual(expect.arrayContaining(["My private worry about my heart", "Doctor reply kept for the record"]));
    expect(body.prescriptions.map((p: any) => p.medication)).toEqual(["Visible Medicine"]); // authorized only
    expect(body.prescriptions[0].sentToPharmacy).toBe(false);
    expect(body.savedPapers[0].title).toBe("My lab results");

    const text = JSON.stringify(body);
    expect(text).not.toMatch(/OTHERS CONTACT|Someone Else|Draft Medicine|DOCTOR PRIVATE NOTE/);
    expect(text).not.toMatch(/passwordHash|password_hash/);
  });

  it("is for patients only, needs a session, and is recorded in the access log", async () => {
    const { patient, doctor } = await patientWithRecords();
    expect((await request(app).get("/api/me/export")).status).toBe(401);
    expect((await request(app).get("/api/me/export").set(auth(doctor.token))).status).toBe(403);
    await request(app).get("/api/me/export").set(auth(patient.token));
    const logs = await storage.getAuditLogsForSubject(patient.id, 20);
    expect(logs.map((l) => l.action)).toContain("account.exported");
  });
});

describe("signing out everywhere", () => {
  it("ends every session on every device at once", async () => {
    const patient = await signupPatient();
    const second = (await request(app).post("/api/auth/login").send({ email: patient.email, password: PASSWORD })).body.token as string;
    expect((await request(app).get("/api/auth/me").set(auth(second))).status).toBe(200);
    expect((await request(app).post("/api/auth/logout-all").set(auth(patient.token))).status).toBe(200);
    expect((await request(app).get("/api/auth/me").set(auth(patient.token))).status).toBe(401);
    expect((await request(app).get("/api/auth/me").set(auth(second))).status).toBe(401);
    // The password still works: this is a sign-out, not a lock-out.
    expect((await request(app).post("/api/auth/login").send({ email: patient.email, password: PASSWORD })).status).toBe(200);
  });
});

describe("closing an account", () => {
  it("needs the password again, then closes the account immediately and records the request", async () => {
    const patient = await signupPatient();
    expect((await request(app).post("/api/me/delete-request").set(auth(patient.token)).send({ confirm: true, password: "wrong" })).status).toBe(403);
    expect((await request(app).post("/api/me/delete-request").set(auth(patient.token)).send({ confirm: true })).status).toBe(400);
    expect((await request(app).get("/api/auth/me").set(auth(patient.token))).status).toBe(200); // a wrong password changed nothing

    const done = await request(app).post("/api/me/delete-request").set(auth(patient.token)).send({ confirm: true, password: PASSWORD });
    expect(done.status).toBe(202);
    expect((await request(app).get("/api/auth/me").set(auth(patient.token))).status).toBe(401);
    expect((await request(app).post("/api/auth/login").send({ email: patient.email, password: PASSWORD })).status).toBe(401);
    const rows = (await pool.query("SELECT kind, status FROM data_requests WHERE user_id = $1", [patient.id])).rows;
    expect(rows).toEqual([{ kind: "deletion", status: "open" }]);
  });
});

describe("erasing a person's records (an operator's job)", () => {
  it("removes identity and what the patient wrote, keeps what doctors authored, and leaves the account unusable", async () => {
    const { patient, doctor, rx } = await patientWithRecords();
    await request(app).post("/api/me/delete-request").set(auth(patient.token)).send({ confirm: true, password: PASSWORD });

    const report = await eraseUser(ownerPool, patient.id);
    expect(report.erased.account).toBe(1);

    const user = (await storage.getUser(patient.id))!;
    expect(user.name).toBe("Deleted user");
    expect(user.email).toMatch(/^deleted-.*@invalid\.example$/);
    expect(user.phone).toBeNull();
    expect(user.emergencyContactName).toBeNull();
    expect(user.allergiesText).toBeNull();
    expect(user.deactivatedAt).not.toBeNull();

    const theirs = (await pool.query("SELECT body FROM messages WHERE sender_user_id = $1", [patient.id])).rows.map((r) => r.body as string);
    expect(theirs).toEqual(["[erased]"]);
    const doctorsReply = (await pool.query("SELECT body FROM messages WHERE sender_user_id = $1", [doctor.id])).rows.map((r) => r.body as string);
    expect(doctorsReply).toEqual(["Doctor reply kept for the record"]); // the doctor's record is retained
    expect((await pool.query("SELECT symptom_text FROM symptom_reports WHERE patient_user_id = $1", [patient.id])).rows.every((r) => r.symptom_text === "[erased]")).toBe(true);
    expect((await pool.query("SELECT title FROM documents WHERE patient_user_id = $1", [patient.id])).rows.every((r) => r.title === "[erased]")).toBe(true);
    // The authorized prescription still exists, immutable, now attached to an anonymous account.
    expect((await storage.getPrescription(rx.id))!.medicationName).toBe("Visible Medicine");
    expect((await pool.query("SELECT status FROM data_requests WHERE user_id = $1", [patient.id])).rows[0].status).toBe("done");
  });

  it("refuses to run for a person who does not exist, and changes nothing", async () => {
    await expect(eraseUser(ownerPool, "00000000-0000-0000-0000-000000000000")).rejects.toThrow(/No such user/);
  });
});
