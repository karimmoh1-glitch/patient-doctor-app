import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import pg from "pg";
import type { Express } from "express";
import { getApp, signupPatient, createDoctor, connect, auth, operatorPool, type TestUser, type TestDoctor } from "./helpers";
import { appRoleUrl } from "./fastCommit";
import { assertionFor } from "./identityHelpers";
import { storage } from "../server/storage";
import { runAsSystem } from "../server/dbContext";
import { dispatchAppointmentReminders } from "../server/services/reminderService";

// Ending a connection (docs/CONNECTION_END.md). The patient's decision about visits that have not happened yet is explicit, never silent;
// everything that depended on the connection stops at once in the routes AND in the database; what the clinician authored or provided stays
// theirs; the patient keeps their whole history.

let app: Express;
let app_: pg.Pool;
beforeAll(async () => {
  app = await getApp();
  app_ = new pg.Pool({ connectionString: appRoleUrl(process.env.DATABASE_URL!), max: 3 });
});
async function as<T>(userId: string, fn: (q: (t: string, p?: unknown[]) => Promise<pg.QueryResult>) => Promise<T>): Promise<T> {
  const c = await app_.connect();
  try {
    await c.query("SELECT set_config('app.assertion', $1, false)", [assertionFor({ userId })]);
    return await fn((t, p) => c.query(t, p));
  } finally {
    await c.query("SELECT set_config('app.assertion', '', false)").catch(() => {});
    c.release();
  }
}

async function scene(visit: "none" | "in3days" | "in3hours" = "in3days") {
  const patient = await signupPatient();
  const doctor = await createDoctor();
  const { pairingId } = await connect(patient, doctor);
  const o = operatorPool();
  const insert = async (when: string, status: string) =>
    (await o.query(
      `INSERT INTO appointments (pairing_request_id, patient_user_id, doctor_profile_id, type, reason, scheduled_at, status)
       VALUES ($1, $2, $3, 'Video Visit', 'the private reason', ${when}, $4) RETURNING id`, [pairingId, patient.id, doctor.profileId, status])).rows[0].id as string;
  const past = await insert("now() - interval '30 days'", "completed");
  const upcoming = visit === "none" ? null : await insert(visit === "in3days" ? "now() + interval '3 days'" : "now() + interval '3 hours'", "confirmed");
  const message = (await o.query(`INSERT INTO messages (pairing_request_id, sender_user_id, body) VALUES ($1, $2, 'hello doctor') RETURNING id`, [pairingId, patient.id])).rows[0].id as string;
  const task = (await o.query(`INSERT INTO follow_up_tasks (patient_user_id, doctor_profile_id, title) VALUES ($1, $2, 'check in') RETURNING id`, [patient.id, doctor.profileId])).rows[0].id as string;
  return { patient, doctor, pairingId, past, upcoming, message, task };
}
const end = (patient: TestUser, id: string, body?: object) => request(app).patch(`/api/pairings/${id}/end`).set(auth(patient.token)).send(body ?? {});
const status = async (id: string) => (await operatorPool().query("SELECT status FROM appointments WHERE id = $1", [id])).rows[0].status as string;
const pairingStatus = async (id: string) => (await operatorPool().query("SELECT status FROM pairing_requests WHERE id = $1", [id])).rows[0].status as string;

describe("ending a connection with nothing booked", () => {
  it("ends at once, and the clinician's routes close on the very next request with the session they already held", async () => {
    const { patient, doctor, pairingId } = await scene("none");
    const reads = [`/api/pairings/${pairingId}/symptom-report`, `/api/pairings/${pairingId}/shared-records`, `/api/pairings/${pairingId}/messages`];
    for (const p of reads) expect((await request(app).get(p).set(auth(doctor.token))).status, p).toBe(200);
    const res = await end(patient, pairingId);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "ended", visitsCancelled: 0, visitsKept: 0 });
    for (const p of reads) expect([401, 403, 404], p).toContain((await request(app).get(p).set(auth(doctor.token))).status);
    expect((await request(app).post(`/api/pairings/${pairingId}/messages`).set(auth(doctor.token)).send({ body: "still there?" })).status).toBeGreaterThanOrEqual(400);
    expect((await end(patient, pairingId)).status).toBe(409); // not twice
  });
});

describe("a visit still booked is never dealt with silently", () => {
  it("refuses to end until the patient chooses, lists the visits, and changes nothing meanwhile", async () => {
    const { patient, doctor, pairingId, upcoming } = await scene();
    const res = await end(patient, pairingId);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("decide_upcoming_visits");
    expect(res.body.upcoming.map((v: any) => v.id)).toEqual([upcoming]);
    expect(JSON.stringify(res.body)).not.toContain("the private reason");
    expect(await pairingStatus(pairingId)).toBe("accepted");
    expect(await status(upcoming!)).toBe("confirmed");
    expect((await request(app).get(`/api/pairings/${pairingId}/messages`).set(auth(doctor.token))).status).toBe(200); // still connected
  });

  it("refuses an answer it does not understand, and anyone else's attempt", async () => {
    const { patient, doctor, pairingId } = await scene();
    expect((await end(patient, pairingId, { upcomingVisits: "delete everything" })).status).toBe(400);
    expect((await end(patient, pairingId, { upcomingVisits: "cancel", extra: true })).status).toBe(400);
    expect((await request(app).patch(`/api/pairings/${pairingId}/end`).set(auth(doctor.token)).send({ upcomingVisits: "cancel" })).status).toBe(403);
    expect((await end(await signupPatient(), pairingId, { upcomingVisits: "cancel" })).status).toBe(404);
    expect(await pairingStatus(pairingId)).toBe("accepted");
  });

  it("'cancel' cancels the upcoming visits (not the history), tells the clinician without a name or reason, and records why", async () => {
    const { patient, doctor, pairingId, upcoming, past } = await scene();
    const res = await end(patient, pairingId, { upcomingVisits: "cancel" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ visitsCancelled: 1, visitsKept: 0 });
    expect(await status(upcoming!)).toBe("cancelled");
    expect(await status(past)).toBe("completed");
    const note = (await runAsSystem(() => storage.getNotificationsForUser(doctor.id, 20))).find((n) => n.kind === "pairing.ended");
    expect(note).toBeTruthy();
    expect(JSON.stringify(note)).not.toMatch(/the private reason|Test Patient/);
    const audit = (await operatorPool().query(`SELECT metadata FROM audit_logs WHERE action = 'pairing.ended' AND target_id = $1`, [pairingId])).rows[0].metadata;
    expect(audit).toMatchObject({ upcomingVisits: "cancel", cancelled: 1, kept: 0 });
    const why = (await operatorPool().query(`SELECT metadata FROM audit_logs WHERE action = 'appointment.cancelled' AND target_id = $1`, [upcoming])).rows[0].metadata;
    expect(why).toMatchObject({ because: "connection_ended" });
  });

  it("'keep' leaves the visit as it was: the clinician can still see and complete THAT visit, and nothing else", async () => {
    const { patient, doctor, pairingId, upcoming } = await scene();
    expect((await end(patient, pairingId, { upcomingVisits: "keep" })).body).toMatchObject({ visitsCancelled: 0, visitsKept: 1 });
    expect(await status(upcoming!)).toBe("confirmed");
    const visit = await request(app).get(`/api/appointments/${upcoming}`).set(auth(doctor.token));
    expect(visit.status).toBe(200);
    expect(visit.body.patientName).toBe("Test Patient"); // the visit record carries the name (database: the clinician provides this visit)
    for (const p of [`/api/pairings/${pairingId}/symptom-report`, `/api/pairings/${pairingId}/shared-records`, `/api/pairings/${pairingId}/messages`]) {
      expect([401, 403, 404], p).toContain((await request(app).get(p).set(auth(doctor.token))).status);
    }
    const done = await request(app).post(`/api/appointments/${upcoming}/complete`).set(auth(doctor.token)).send({ doctorNotes: "Seen as booked." });
    expect(done.status).toBe(200);
    expect(await status(upcoming!)).toBe("completed");
  });
});

describe("in the database too", () => {
  it("shuts the clinician out of the conversation and the follow-up tasks, keeps the patient's history, and keeps the clinician's own visits", async () => {
    const { patient, doctor, pairingId, upcoming, past, message, task } = await scene();
    const ids = (userId: string, table: string, id: string) => as(userId, async (q) => (await q(`SELECT id FROM ${table} WHERE id = $1`, [id])).rowCount);
    expect(await ids(doctor.id, "messages", message), "doctor sees the conversation while connected").toBe(1);
    expect(await ids(doctor.id, "follow_up_tasks", task)).toBe(1);
    await end(patient, pairingId, { upcomingVisits: "keep" });

    expect(await ids(doctor.id, "messages", message), "doctor, conversation").toBe(0);
    expect(await ids(doctor.id, "follow_up_tasks", task), "doctor, task").toBe(0);
    expect(await ids(patient.id, "messages", message), "patient keeps the ended conversation").toBe(1);
    expect(await ids(patient.id, "follow_up_tasks", task)).toBe(1);
    expect(await ids(doctor.id, "appointments", past), "the clinician keeps the visits they provided").toBe(1);
    expect(await ids(doctor.id, "appointments", upcoming!)).toBe(1);
    expect(await ids(doctor.id, "users", patient.id), "…and the name on them").toBe(1);

    await expect(as(doctor.id, (q) => q(`INSERT INTO messages (pairing_request_id, sender_user_id, body) VALUES ($1, $2, 'sneaky')`, [pairingId, doctor.id]))).rejects.toThrow(/row-level security/);
    await expect(as(patient.id, (q) => q(`INSERT INTO messages (pairing_request_id, sender_user_id, body) VALUES ($1, $2, 'one more')`, [pairingId, patient.id]))).rejects.toThrow(/row-level security/);
    expect((await as(doctor.id, (q) => q(`UPDATE appointments SET status = 'confirmed', reason = 'edited' WHERE id = $1`, [past]))).rowCount, "a finished visit cannot be reopened or rewritten").toBe(0);
    expect((await as(doctor.id, (q) => q(`UPDATE follow_up_tasks SET status = 'done' WHERE id = $1`, [task]))).rowCount).toBe(0);
  });

  it("shows the clinician no patient name once there is no connection and no visit between them", async () => {
    const { patient, doctor, pairingId } = await scene("none");
    await operatorPool().query("DELETE FROM appointments WHERE pairing_request_id = $1", [pairingId]);
    const seen = () => as(doctor.id, async (q) => (await q(`SELECT id FROM users WHERE id = $1`, [patient.id])).rowCount);
    expect(await seen()).toBe(1);
    await end(patient, pairingId);
    expect(await seen()).toBe(0);
  });
});

describe("background work follows the decision", () => {
  it("keeps reminding the patient about a kept visit and never about a cancelled one", async () => {
    const kept = await scene("in3hours");
    const cancelled = await scene("in3hours");
    await end(kept.patient, kept.pairingId, { upcomingVisits: "keep" });
    await end(cancelled.patient, cancelled.pairingId, { upcomingVisits: "cancel" });
    await dispatchAppointmentReminders(new Date(), 24);
    const soon = async (u: TestUser) => (await runAsSystem(() => storage.getNotificationsForUser(u.id, 20))).filter((n) => n.kind === "appointment.soon").length;
    expect(await soon(kept.patient)).toBe(1);
    expect(await soon(cancelled.patient)).toBe(0);
  });

  it("lets the patient connect again afterwards, as a new connection", async () => {
    const { patient, doctor, pairingId } = await scene("none");
    await end(patient, pairingId);
    const again = await connect(patient, doctor);
    expect(again.pairingId).not.toBe(pairingId);
    expect(await pairingStatus(again.pairingId)).toBe("accepted");
  });
});
