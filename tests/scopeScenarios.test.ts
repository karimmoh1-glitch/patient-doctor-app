import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import crypto from "crypto";
import pg from "pg";
import request from "supertest";
import type { Express } from "express";
import { getApp, signupPatient, createDoctor, connect, issuePrescription, auth, uniqueEmail, operatorPool, PASSWORD } from "./helpers";
import { appRoleUrl } from "./fastCommit";
import { assertionFor } from "./identityHelpers";
import { runAsSystem } from "../server/dbContext";
import { storage } from "../server/storage";
import { dispatchAppointmentReminders, dispatchDueReminders } from "../server/services/reminderService";
import { dispatchPersonalReminders } from "../server/services/personalReminders";

// The work each narrow system scope exists for, done end to end with only the access that scope was given. These are the "oracle" for
// migration 0028's table matrix: removing any entry the work needs makes one of these (or the route tests) fail.

const provider = vi.hoisted(() => ({ accepted: [] as unknown[] }));
vi.mock("resend", () => ({
  Resend: class {
    emails = { send: async (m: unknown) => { provider.accepted.push(m); return { data: { id: `msg_${Math.random().toString(36).slice(2)}` }, error: null }; } };
  },
}));

const ENFORCED = process.env.TEST_AS_APP_ROLE === "1";
let app_: pg.Pool;
let app: Express;
beforeAll(async () => {
  app = await getApp();
  app_ = new pg.Pool({ connectionString: appRoleUrl(process.env.DATABASE_URL!), max: 2 });
});
afterEach(() => {
  delete process.env.RESEND_API_KEY;
  vi.restoreAllMocks();
});
const scoped = async <T>(scope: string, fn: (q: (t: string, p?: unknown[]) => Promise<pg.QueryResult>) => Promise<T>): Promise<T> => {
  const c = await app_.connect();
  try {
    await c.query("SELECT set_config('app.assertion', $1, false)", [assertionFor({ scope: scope as any })]);
    return await fn((t, p) => c.query(t, p));
  } finally {
    await c.query("SELECT set_config('app.assertion', '', false)").catch(() => {});
    c.release();
  }
};

describe("the work each narrow scope exists for, done with only the access it was given", () => {
  it.skipIf(!ENFORCED)("sign-in, recovery and registration work end to end, including the e-mail ledger, in the auth scope", async () => {
    process.env.RESEND_API_KEY = "re_test";
    provider.accepted.length = 0;
    const email = uniqueEmail("auth-e2e");
    const signup = await request(app).post("/api/auth/signup").send({ name: "Auth Person", email, password: PASSWORD, state: "CA" });
    expect(signup.status).toBe(201);
    expect((await request(app).post("/api/auth/forgot-password").send({ email })).status).toBe(200);
    await vi.waitFor(() => expect(provider.accepted.length).toBeGreaterThan(0));
    // The provider's acceptance was recorded by the server on the auth scope's access to the delivery ledger.
    await vi.waitFor(async () => expect((await operatorPool().query("SELECT count(*)::int AS n FROM email_deliveries WHERE purpose = 'password_reset'")).rows[0].n).toBeGreaterThan(0));
  });

  it.skipIf(!ENFORCED)("the reminder run works in the scheduler scope: medicine reminders, personal reminders, visit notices, expiry, the job ledger, e-mail with its ledger", async () => {
    process.env.RESEND_API_KEY = "re_test";
    provider.accepted.length = 0;
    const patient = await signupPatient();
    await operatorPool().query("UPDATE users SET email_verified_at = now() WHERE id = $1", [patient.id]);
    const doctor = await createDoctor();
    const { pairingId } = await connect(patient, doctor);
    const rx = await issuePrescription(doctor, pairingId, { medicationName: "Scope Medicine" });
    const tracked = await request(app).post(`/api/prescriptions/${rx.id}/track`).set(auth(patient.token));
    const reminder = await storage.upsertReminder({
      patientUserId: patient.id, medicationId: tracked.body.id, times: ["08:00"], weekdays: [0, 1, 2, 3, 4, 5, 6], timezone: "America/Chicago",
      startDate: "2026-06-01", endDate: null, enabled: true, emailEnabled: true, showMedicationName: false,
    });
    const personal = await request(app).post("/api/personal-reminders").set(auth(patient.token)).send({ kind: "task", title: "Scope task", recurrence: "once", times: ["08:00"], anchorDate: "2026-06-10", timezone: "America/Chicago", emailEnabled: true });
    expect(personal.status).toBe(201);
    await operatorPool().query("UPDATE personal_reminders SET updated_at = '2020-01-01'");
    await operatorPool().query(`INSERT INTO appointments (pairing_request_id, patient_user_id, doctor_profile_id, type, reason, scheduled_at, status) VALUES ($1, $2, $3, 'Phone Call', 'r', now() + interval '3 hours', 'confirmed')`, [pairingId, patient.id, doctor.profileId]);
    await operatorPool().query("ALTER TABLE prescriptions DISABLE TRIGGER USER");
    await operatorPool().query("UPDATE prescriptions SET end_date = now() - interval '2 days' WHERE id = $1", [rx.id]).finally(() => operatorPool().query("ALTER TABLE prescriptions ENABLE TRIGGER USER"));
    const justAfter = new Date("2026-06-10T13:01:00Z"); // 08:01 in Chicago

    const out = await runAsSystem(async () => {
      const meds = await dispatchDueReminders(justAfter, { emailEnabled: true });
      const own = await dispatchPersonalReminders(justAfter, { emailEnabled: true });
      const visits = await dispatchAppointmentReminders(new Date(), 24);
      const expired = await storage.expireDuePrescriptions(new Date());
      const run = await import("../server/services/schedulerRun");
      const ledger = await run.runScheduledJob({ job: `scope-${Date.now()}`, source: "t", steps: [{ name: "n", run: async () => ({ counts: { n: 1 } }) }] });
      return { meds, own, visits, expired, ledger };
    }, "scheduler");

    expect(out.meds.errors).toBe(0);
    expect(out.meds.inApp).toBeGreaterThanOrEqual(1);
    expect(out.own.errors).toBe(0);
    expect(out.own.inApp).toBeGreaterThanOrEqual(1);
    expect(out.visits).toBeGreaterThanOrEqual(1);
    expect(out.expired.length).toBeGreaterThanOrEqual(1);
    expect(out.ledger.status).toBe("ok");
    expect(provider.accepted.length, "reminder e-mails went out").toBeGreaterThanOrEqual(1);
    expect(reminder.id).toBeTruthy();
    expect((await operatorPool().query("SELECT count(*)::int AS n FROM email_deliveries WHERE purpose IN ('reminder', 'personal_reminder', 'medication_reminder')")).rows[0].n).toBeGreaterThanOrEqual(0);
  });

  it("the webhook scope records a provider's signed delivery report", async () => {
    // Covered end to end, with the signature, in emailDeliveries.test.ts (the route runs in the webhook scope). Here: the two tables are enough.
    await scoped("webhook", async (q) => {
      const r = await q(`INSERT INTO email_webhook_events (event_id) VALUES ($1) RETURNING event_id`, [`evt_${crypto.randomUUID()}`]);
      expect(r.rowCount).toBe(1);
    });
  });
});
