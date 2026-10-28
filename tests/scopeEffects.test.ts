import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { getApp, signupPatient, createDoctor, createAdmin, auth, uniqueEmail, operatorPool, PASSWORD, APPROVAL, completeSecondFactor, type TestUser, type TestDoctor } from "./helpers";
import { storage } from "../server/storage";
import { runAsSystem } from "../server/dbContext";
import { checkReadiness } from "../server/services/readiness";
import { pool } from "../server/db";

// Some narrow-scope grants are used by code that cannot complain: an administrator's count, a readiness check, the name in a notice. Take the
// grant away and these read ZERO (row-level security answers "no rows", not an error), which looks like a healthy answer. These tests put rows in
// and require that the right numbers and names come out, so the grants cannot be removed unnoticed. They mean something only through the
// restricted role (npm run test:rls).

const ENFORCED = process.env.TEST_AS_APP_ROLE === "1";
let app: Express;
let admin: TestUser;
beforeAll(async () => {
  app = await getApp();
  admin = await createAdmin();
});

describe.skipIf(!ENFORCED)("what the read-only scopes show must not silently be zero", () => {
  it("the operations screen counts the reminders, deliveries, scheduler calls and e-mail it is looking at", async () => {
    const o = operatorPool();
    const patient = await signupPatient();
    const doctor = await createDoctor();
    const { pairingId } = await (await import("./helpers")).connect(patient, doctor);
    const rx = await (await import("./helpers")).issuePrescription(doctor, pairingId);
    const tracked = await request(app).post(`/api/prescriptions/${rx.id}/track`).set(auth(patient.token));
    const reminder = await runAsSystem(() => storage.upsertReminder({
      patientUserId: patient.id, medicationId: tracked.body.id, times: ["08:00"], weekdays: [0, 1, 2, 3, 4, 5, 6], timezone: "America/Chicago",
      startDate: "2026-06-01", endDate: null, enabled: true, emailEnabled: false, showMedicationName: false,
    }));
    const personal = await request(app).post("/api/personal-reminders").set(auth(patient.token)).send({ kind: "task", title: "Ops count", recurrence: "once", times: ["08:00"], anchorDate: "2026-06-10", timezone: "America/Chicago" });
    expect(personal.status).toBe(201);
    await o.query(`INSERT INTO reminder_deliveries (reminder_id, due_at, channel, status, sent_at) VALUES ($1, now() - interval '1 hour', 'in_app', 'sent', now())`, [reminder.id]);
    await o.query(`INSERT INTO personal_reminder_deliveries (reminder_id, due_at, channel, status, sent_at) VALUES ($1, now() - interval '1 hour', 'in_app', 'sent', now())`, [personal.body.id]);
    await o.query(`INSERT INTO reminder_deliveries (reminder_id, due_at, channel, status, sent_at) VALUES ($1, now() - interval '2 hours', 'email', 'sent', now())`, [reminder.id]);
    process.env.CRON_SECRET = "effects-secret-0123456789abcdef0123456789abcd";
    expect((await request(app).post("/api/cron/reminders").set({ Authorization: `Bearer ${process.env.CRON_SECRET}` })).status).toBe(200);

    const status = await request(app).get("/api/admin/reminders/status").set(auth(admin.token));
    expect(status.status).toBe(200);
    expect(status.body.job.lastRunAt, "the scheduler's last run is visible").toBeTruthy();
    expect(status.body.scheduler.callsLast24h, "its calls are counted").toBeGreaterThanOrEqual(1);
    expect(status.body.last24h.scheduled, "scheduled reminders are counted").toBeGreaterThanOrEqual(1);
    expect(status.body.last24h.emailAccepted, "delivery rows are counted").toBeGreaterThanOrEqual(1);
    expect(status.body.personal.activeReminders, "personal reminders are counted").toBeGreaterThanOrEqual(1);
    expect(status.body.personal.last24h.inAppDelivered, "personal deliveries are counted").toBeGreaterThanOrEqual(1);
  });

  it("the readiness check sees the seeded demonstration doctors, the administrator, the reminder job and the demo accounts it is meant to refuse", async () => {
    const o = operatorPool();
    const keep = (await o.query("SELECT * FROM job_runs WHERE job = 'reminders'")).rows[0];
    const seedUser = (await o.query(`INSERT INTO users (name, email, password_hash, role, is_demo) VALUES ('Seed Doc', $1, 'x', 'doctor', true) RETURNING id`, [uniqueEmail("seed")])).rows[0].id as string;
    const profile = (await o.query(
      `INSERT INTO doctor_profiles (user_id, name, specialty, state, license_number, phone, active, source, timezone, languages, modalities) VALUES ($1, 'Seed Doc', 'GP', 'CA', 'S1', '+15550009999', true, 'seed', 'America/Los_Angeles', '["en"]'::jsonb, '["phone"]'::jsonb) RETURNING id`, [seedUser])).rows[0].id as string;
    await o.query(`INSERT INTO job_runs (job, last_run_at, last_success_at) VALUES ('reminders', now(), now()) ON CONFLICT (job) DO UPDATE SET last_run_at = now(), last_success_at = now()`);
    try {
      const checks = await checkReadiness({ ...process.env, NODE_ENV: "production" }, pool);
      const by = (id: string) => checks.find((c) => c.id === id)!;
      expect(by("demo-doctors").level, "a seeded, listed demonstration doctor must be seen").toBe("fail");
      expect(by("demo-accounts").level, "an active demo account must be seen").toBe("fail");
      expect(by("admin").level, "the administrator made for this suite must be seen").toBe("ok");
      expect(by("reminder-job").level, "a recent successful run must be seen").toBe("ok");
    } finally {
      await o.query("DELETE FROM doctor_profiles WHERE id = $1", [profile]);
      await o.query("UPDATE users SET deactivated_at = now() WHERE id = $1", [seedUser]);
      if (keep) await o.query("UPDATE job_runs SET last_run_at = $1, last_success_at = $2 WHERE job = 'reminders'", [keep.last_run_at, keep.last_success_at]);
      else await o.query("DELETE FROM job_runs WHERE job = 'reminders'");
    }
  });
});

describe.skipIf(!ENFORCED)("what the write scopes do must not silently be nothing", () => {
  it("the clinician's notice of a new connection carries the patient's name (the pairing scope reads it)", async () => {
    const doctor = await createDoctor();
    const patient = await signupPatient({ name: "Scope Effects Patient" });
    const created = await request(app).post("/api/pairing-invitations").set(auth(doctor.token));
    expect(created.status).toBeLessThan(300);
    const accepted = await request(app).post("/api/pairing-invitations/accept").set(auth(patient.token)).send({ confirm: true, code: created.body.code });
    expect(accepted.status).toBeLessThan(300);
    const notes = await runAsSystem(() => storage.getNotificationsForUser(doctor.id, 20));
    const note = notes.find((n) => n.kind === "pairing.connected");
    expect(note, "the clinician was told").toBeTruthy();
    expect(JSON.stringify(note!.params)).toContain("Scope Effects Patient");
  });

  it("an administrator's approval copies the application's state and phone onto the clinician's account (the review scope updates users)", async () => {
    const email = uniqueEmail("effects-doc");
    const reg = await request(app).post("/api/doctors/register").send({ name: "Effects Doc", email, password: PASSWORD });
    const session = await completeSecondFactor(reg.body, email);
    const COMPLETE = { displayName: "Dr. Effects", professionalRole: "physician", specialty: "Cardiology", state: "TX", licenseNumber: `TX-${Date.now()}`, licensingBody: "Texas Medical Board", languages: ["en"], modalities: ["phone"], phone: "+1 555 000 7777", qualifications: "MD", yearsExperience: 5, clinic: "Clinic", bio: "Cardiology." };
    expect((await request(app).put("/api/doctors/me/application").set(auth(session.token)).send(COMPLETE)).status).toBe(200);
    const sub = await request(app).post("/api/doctors/me/application/submit").set(auth(session.token));
    expect((await request(app).post(`/api/admin/doctor-applications/${sub.body.id}/approve`).set(auth(admin.token)).send(APPROVAL)).status).toBe(200);
    const row = (await operatorPool().query("SELECT state, phone FROM users WHERE id = $1", [session.user.id])).rows[0];
    expect(row).toEqual({ state: "TX", phone: "+1 555 000 7777" });
  });
});
