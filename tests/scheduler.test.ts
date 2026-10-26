import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import request from "supertest";
import type { Express } from "express";
import crypto from "crypto";
import { sql } from "drizzle-orm";
import { getApp, signupPatient, createDoctor, createAdmin, connect, auth, issuePrescription } from "./helpers";
import { storage } from "../server/storage";
import { db } from "../server/db";
import { dispatchDueReminders } from "../server/services/reminderService";
import { runScheduledJob } from "../server/services/schedulerRun";
import { sendEmail } from "../server/services/emailService";

// The email provider is always a stand-in here: no test ever sends a real message.
const provider = vi.hoisted(() => ({ hang: false, accepted: [] as { to: string[]; subject: string; text: string }[] }));
vi.mock("resend", () => ({
  Resend: class {
    emails = {
      send: async (m: any) => {
        if (provider.hang) return new Promise(() => {});
        provider.accepted.push(m);
        return { data: { id: "test" }, error: null };
      },
    };
  },
}));

const SECRET = "s3cret-value-for-scheduler-test";
const header = { Authorization: `Bearer ${SECRET}` };
let app: Express;
beforeAll(async () => {
  app = await getApp();
});
afterEach(() => {
  delete process.env.CRON_SECRET;
  delete process.env.RESEND_API_KEY;
  delete process.env.OPS_ALERT_EMAIL;
  delete process.env.SCHEDULER_HEARTBEAT_URL;
  delete process.env.EMAIL_TIMEOUT_MS;
  provider.hang = false;
  provider.accepted.length = 0;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const uniqueJob = () => `test-job-${crypto.randomUUID().slice(0, 8)}`;
const ok = (counts: Record<string, number | boolean> = {}) => async () => ({ counts });

async function resetReminderJob() {
  await db.execute(sql`DELETE FROM job_runs WHERE job = 'reminders'`);
  await db.execute(sql`DELETE FROM job_run_history WHERE job = 'reminders'`);
}

describe("only one run at a time", () => {
  it("lets exactly one of many simultaneous callers take the lease", async () => {
    const job = uniqueJob();
    const now = new Date();
    const results = await Promise.all(Array.from({ length: 10 }, () => storage.acquireJobLease(job, crypto.randomUUID(), now, 60_000)));
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it("skips a call that arrives while a run is in progress, and records that it did", async () => {
    const job = uniqueJob();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const first = runScheduledJob({ job, source: "test", steps: [{ name: "slow", run: async () => { await gate; return { counts: { done: 1 } }; } }] });
    await vi.waitFor(async () => expect((await storage.getJobRunHistory(job, new Date(0))).length).toBe(1));

    const second = await runScheduledJob({ job, source: "other", steps: [{ name: "never", run: async () => { throw new Error("must not run"); } }] });
    expect(second.status).toBe("skipped");

    release();
    expect((await first).status).toBe("ok");
    const history = await storage.getJobRunHistory(job, new Date(0));
    expect(history.map((h) => h.outcome).sort()).toEqual(["ok", "skipped_overlap"]);
    // A skipped call is not a success and not a failure: the job's record is the finished run's.
    const run = await storage.getJobRun(job);
    expect(run!.consecutiveFailures).toBe(0);
    expect(run!.lastSuccessAt).not.toBeNull();
  });

  it("frees a job whose run died, once its lease expires", async () => {
    const job = uniqueJob();
    const t0 = new Date();
    expect(await storage.acquireJobLease(job, "dead-run", t0, 1_000)).toBe(true);
    expect(await storage.acquireJobLease(job, "second", new Date(t0.getTime() + 500), 1_000)).toBe(false);
    expect(await storage.acquireJobLease(job, "third", new Date(t0.getTime() + 1_500), 1_000)).toBe(true);
  });

  it("lets a run that lost its lease finish without overwriting the run that replaced it", async () => {
    const job = uniqueJob();
    const t0 = new Date();
    await storage.acquireJobLease(job, "slow-old-run", t0, 1_000);
    await storage.acquireJobLease(job, "new-run", new Date(t0.getTime() + 2_000), 60_000);
    expect(await storage.finishJobRun(job, "new-run", new Date(t0.getTime() + 3_000), { who: "new" }, { ok: true })).toBe(true);
    // The old run limps in late with a failure: it must change nothing.
    expect(await storage.finishJobRun(job, "slow-old-run", new Date(t0.getTime() + 4_000), { who: "old" }, { ok: false, error: "late" })).toBe(false);
    const run = await storage.getJobRun(job);
    expect(run!.lastResult).toEqual({ who: "new" });
    expect(run!.consecutiveFailures).toBe(0);
    expect(run!.lastError).toBeNull();
  });
});

describe("a broken run is never reported healthy", () => {
  it("attempts every step, fails the run, keeps the error to a kind, and does not record a success", async () => {
    const job = uniqueJob();
    let laterStepRan = false;
    const summary = await runScheduledJob({
      job,
      source: "test",
      steps: [
        { name: "first", run: async () => { throw new Error("connection string postgres://user:SECRETPW@host/db"); } },
        { name: "second", run: async () => { laterStepRan = true; return { counts: { x: 1 } }; } },
      ],
    });
    expect(summary.status).toBe("failed");
    expect(laterStepRan).toBe(true);
    const run = await storage.getJobRun(job);
    expect(run!.lastError).toBe("first:Error");
    expect(run!.lastSuccessAt).toBeNull();
    expect(run!.consecutiveFailures).toBe(1);
    expect(JSON.stringify(run)).not.toMatch(/SECRETPW|postgres/);
    const [h] = await storage.getJobRunHistory(job, new Date(0));
    expect(h.outcome).toBe("failed");
  });

  it("fails the run when a step reports item errors, even though it finished", async () => {
    const job = uniqueJob();
    const summary = await runScheduledJob({ job, source: "test", steps: [{ name: "items", run: async () => ({ counts: { n: 3 }, errors: 1 }) }] });
    expect(summary.status).toBe("failed");
    expect((await storage.getJobRun(job))!.lastError).toBe("items_item_errors");
  });

  it("counts failures in a row, and a good run clears them", async () => {
    const job = uniqueJob();
    const bad = { name: "bad", run: async () => { throw new Error("x"); } };
    await runScheduledJob({ job, source: "t", steps: [bad] });
    await runScheduledJob({ job, source: "t", steps: [bad] });
    expect((await storage.getJobRun(job))!.consecutiveFailures).toBe(2);
    await runScheduledJob({ job, source: "t", steps: [{ name: "good", run: ok() }] });
    expect((await storage.getJobRun(job))!.consecutiveFailures).toBe(0);
  });

  it("does not look healthy if its own outcome could not be written", async () => {
    const job = uniqueJob();
    vi.spyOn(storage, "finishJobRun").mockRejectedValueOnce(new Error("db down"));
    const summary = await runScheduledJob({ job, source: "t", steps: [{ name: "good", run: ok() }] });
    expect(summary.status).toBe("failed");
    expect((await storage.getJobRun(job))!.lastSuccessAt).toBeNull();
  });
});

async function dueReminder() {
  const patient = await signupPatient();
  const doctor = await createDoctor();
  const { pairingId } = await connect(patient, doctor);
  const rx = await issuePrescription(doctor, pairingId, { medicationName: "Private Medicine Z" });
  const tracked = await request(app).post(`/api/prescriptions/${rx.id}/track`).set(auth(patient.token));
  const reminder = await storage.upsertReminder({
    patientUserId: patient.id, medicationId: tracked.body.id, times: ["08:00"], weekdays: [0, 1, 2, 3, 4, 5, 6],
    timezone: "America/Chicago", startDate: "2026-06-01", endDate: null, enabled: true, emailEnabled: false, showMedicationName: false,
  });
  return { patient, reminder };
}
const justAfter = new Date("2026-06-10T13:01:00Z"); // 08:01 in Chicago
const inAppRows = async (reminderId: string) =>
  (await storage.getDeliveriesSince(new Date("2026-06-09T00:00:00Z"))).filter((d) => d.reminderId === reminderId && d.channel === "in_app");

describe("one reminder that cannot be processed does not stop the others", () => {
  it("delivers everyone else's, reports the error, and delivers the broken one's once it can be", async () => {
    const good = await dueReminder();
    const poison = await dueReminder();
    const real = storage.deliverInApp.bind(storage);
    const spy = vi.spyOn(storage, "deliverInApp").mockImplementation(async (reminderId, dueAt, notice) => {
      if (reminderId === poison.reminder.id) throw new Error("boom with a name: Jane Doe");
      return real(reminderId, dueAt, notice);
    });

    const first = await dispatchDueReminders(justAfter);
    expect(first.errors).toBeGreaterThanOrEqual(1);
    expect(await inAppRows(good.reminder.id)).toHaveLength(1);
    expect(await inAppRows(poison.reminder.id)).toHaveLength(0);

    spy.mockRestore();
    const second = await dispatchDueReminders(new Date(justAfter.getTime() + 60_000));
    expect(second.errors).toBe(0);
    expect(await inAppRows(poison.reminder.id)).toHaveLength(1);
    expect(await inAppRows(good.reminder.id)).toHaveLength(1); // still exactly once
  });

  it("never writes the error's text to the log", async () => {
    const r = await dueReminder();
    const lines: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void lines.push(a.map(String).join(" ")));
    vi.spyOn(storage, "deliverInApp").mockImplementation(async () => { throw new Error("Jane Doe took Private Medicine Z"); });
    await dispatchDueReminders(justAfter);
    expect(lines.join("\n")).not.toMatch(/Jane|Private Medicine/);
    expect(await inAppRows(r.reminder.id)).toHaveLength(0);
  });
});

describe("a run that is out of time defers work instead of losing it", () => {
  it("stops starting new work at the deadline, says so, and the next run finishes the job", async () => {
    const r = await dueReminder();
    const cut = await dispatchDueReminders(justAfter, { deadline: Date.now() - 1 });
    expect(cut.truncated).toBe(true);
    expect(await inAppRows(r.reminder.id)).toHaveLength(0);

    const next = await dispatchDueReminders(new Date(justAfter.getTime() + 60_000));
    expect(next.truncated).toBe(false);
    expect(await inAppRows(r.reminder.id)).toHaveLength(1);
  });

  it("makes a repeated run cheap: nothing already delivered is written again", async () => {
    const r = await dueReminder();
    await dispatchDueReminders(justAfter);
    const spy = vi.spyOn(storage, "deliverInApp");
    const again = await dispatchDueReminders(new Date(justAfter.getTime() + 60_000));
    expect(spy.mock.calls.filter(([id]) => id === r.reminder.id)).toHaveLength(0);
    expect(again.errors).toBe(0);
    expect(await inAppRows(r.reminder.id)).toHaveLength(1);
  });

  it("gives up on a hung email provider instead of hanging the run, and reports the email as not accepted", async () => {
    process.env.RESEND_API_KEY = "re_test";
    process.env.EMAIL_TIMEOUT_MS = "60";
    provider.hang = true;
    const started = Date.now();
    expect(await sendEmail({ to: "a@example.com", subject: "s", body: "b" })).toBe(false);
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});

describe("the endpoint", () => {
  it("answers 202 and runs nothing when another run holds the lease, and still demands the secret", async () => {
    process.env.CRON_SECRET = SECRET;
    await resetReminderJob();
    const before = (await storage.getJobRunHistory("reminders", new Date(0))).length;
    expect((await request(app).get("/api/cron/reminders")).status).toBe(401);
    expect((await request(app).get("/api/cron/reminders").set("Authorization", "Bearer nope")).status).toBe(401);
    expect((await storage.getJobRunHistory("reminders", new Date(0))).length).toBe(before); // refused calls leave no trace

    await storage.acquireJobLease("reminders", "someone-else", new Date(), 60_000);
    const res = await request(app).get("/api/cron/reminders").set(header);
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ ok: true, skipped: true });
    const [h] = await storage.getJobRunHistory("reminders", new Date(0));
    expect(h.outcome).toBe("skipped_overlap");
    await resetReminderJob();
  });

  it("runs overlapping calls one at a time and never twice at once", async () => {
    process.env.CRON_SECRET = SECRET;
    await resetReminderJob();
    const responses = await Promise.all(Array.from({ length: 6 }, () => request(app).get("/api/cron/reminders").set(header)));
    for (const r of responses) expect([200, 202]).toContain(r.status);
    expect(responses.filter((r) => r.status === 200).length).toBeGreaterThanOrEqual(1);
    const history = await storage.getJobRunHistory("reminders", new Date(0));
    // Every call is accounted for, and none ended in failure.
    expect(history).toHaveLength(6);
    expect(history.every((h) => h.outcome === "ok" || h.outcome === "skipped_overlap")).toBe(true);
    await resetReminderJob();
  });

  it("returns 500 for a failed run, with no detail, so the caller's own alerting fires", async () => {
    process.env.CRON_SECRET = SECRET;
    await resetReminderJob();
    vi.spyOn(storage, "expireDuePrescriptions").mockRejectedValueOnce(new Error("postgres://u:SECRETPW@h/db"));
    const res = await request(app).get("/api/cron/reminders").set(header);
    expect(res.status).toBe(500);
    expect(JSON.stringify(res.body)).not.toMatch(/SECRETPW|postgres/);
    // The reminders step still ran: housekeeping failing does not hold medicine reminders back.
    const run = await storage.getJobRun("reminders");
    expect(run!.lastResult).toHaveProperty("considered");
    expect(run!.lastError).toBe("expiry:Error");
    await resetReminderJob();
  });

  it("writes one structured line per run with counts only", async () => {
    process.env.CRON_SECRET = SECRET;
    await resetReminderJob();
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void lines.push(a.map(String).join(" ")));
    await request(app).get("/api/cron/reminders").set({ ...header, "X-Avela-Scheduler": "github-actions" });
    const line = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).find((j) => j?.event === "scheduler.run");
    expect(line).toMatchObject({ event: "scheduler.run", job: "reminders", source: "github-actions", outcome: "ok" });
    expect(typeof line.durationMs).toBe("number");
    expect(typeof line.runId).toBe("string");
    expect(JSON.stringify(line)).not.toMatch(/@|Bearer|secret/i);
    await resetReminderJob();
  });
});

describe("telling someone when it is wrong", () => {
  it("pings the heartbeat after a good run, the /fail address after a bad one, and survives the heartbeat being down", async () => {
    process.env.SCHEDULER_HEARTBEAT_URL = "https://hc.example.test/ping/abc123";
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: any) => { calls.push(String(url)); return { ok: true, status: 200 }; }));

    const good = await runScheduledJob({ job: uniqueJob(), source: "t", steps: [{ name: "g", run: ok() }] });
    const bad = await runScheduledJob({ job: uniqueJob(), source: "t", steps: [{ name: "b", run: async () => { throw new Error("x"); } }] });
    expect(good.status).toBe("ok");
    expect(bad.status).toBe("failed");
    expect(calls).toEqual(["https://hc.example.test/ping/abc123", "https://hc.example.test/ping/abc123/fail"]);

    vi.stubGlobal("fetch", vi.fn(async () => { throw Object.assign(new Error("offline"), { name: "TypeError" }); }));
    expect((await runScheduledJob({ job: uniqueJob(), source: "t", steps: [{ name: "g", run: ok() }] })).status).toBe("ok");
  });

  it("does nothing, and says nothing, when no heartbeat is configured", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    await runScheduledJob({ job: uniqueJob(), source: "t", steps: [{ name: "g", run: ok() }] });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("e-mails the operator when failures begin and when they end, not on every failure in between", async () => {
    process.env.RESEND_API_KEY = "re_test";
    process.env.OPS_ALERT_EMAIL = "ops@example.test";
    const job = uniqueJob();
    const bad = { name: "b", run: async () => { throw new Error("patient Jane Doe"); } };
    await runScheduledJob({ job, source: "t", steps: [bad] });
    await runScheduledJob({ job, source: "t", steps: [bad] });
    await runScheduledJob({ job, source: "t", steps: [bad] });
    expect(provider.accepted.map((m) => m.subject)).toEqual(["[Avela] Reminder scheduler is failing (1 in a row)"]);
    await runScheduledJob({ job, source: "t", steps: [{ name: "g", run: ok() }] });
    expect(provider.accepted.map((m) => m.subject)).toEqual(["[Avela] Reminder scheduler is failing (1 in a row)", "[Avela] Reminder scheduler recovered"]);
    expect(provider.accepted.map((m) => m.text).join("\n")).not.toMatch(/Jane|Doe/);
  });

  it("exposes a monitor address that is healthy only while the scheduler really runs", async () => {
    await resetReminderJob();
    expect((await request(app).get("/api/health/scheduler")).status).toBe(503); // no CRON_SECRET
    process.env.CRON_SECRET = SECRET;
    const none = await request(app).get("/api/health/scheduler");
    expect(none.status).toBe(503);
    expect(none.body.status).toBe("stale");

    expect((await request(app).get("/api/cron/reminders").set(header)).status).toBe(200);
    const good = await request(app).get("/api/health/scheduler"); // no credentials needed
    expect(good.status).toBe(200);
    expect(Object.keys(good.body).sort()).toEqual(["minutesSinceSuccess", "status"]);
    expect(good.body.status).toBe("active");

    vi.spyOn(storage, "expireDuePrescriptions").mockRejectedValueOnce(new Error("x"));
    await request(app).get("/api/cron/reminders").set(header);
    const failing = await request(app).get("/api/health/scheduler");
    expect(failing.status).toBe(503);
    expect(failing.body.status).toBe("failing");
    await resetReminderJob();
  });
});

describe("evidence that it is really being called", () => {
  it("counts calls by who made them, from our own records, for an administrator only", async () => {
    process.env.CRON_SECRET = SECRET;
    await resetReminderJob();
    await request(app).get("/api/cron/reminders").set({ ...header, "X-Avela-Scheduler": "github-actions" });
    await request(app).get("/api/cron/reminders").set({ ...header, "User-Agent": "vercel-cron/1.0" });
    await request(app).get("/api/cron/reminders").set({ ...header, "X-Avela-Scheduler": "../../etc/passwd" });

    const admin = await createAdmin();
    const res = await request(app).get("/api/admin/reminders/status").set(auth(admin.token));
    expect(res.status).toBe(200);
    expect(res.body.scheduler).toMatchObject({ expectedIntervalMinutes: 5, callsLast24h: 3, okLast24h: 3, failedLast24h: 0 });
    expect(res.body.scheduler.bySource).toEqual({ "github-actions": 1, "vercel-cron": 1, unknown: 1 });
    expect(res.body.scheduler.longestGapMinutes).toBeLessThan(2);

    const patient = await signupPatient();
    expect((await request(app).get("/api/admin/reminders/status").set(auth(patient.token))).status).toBe(403);
    await resetReminderJob();
  });
});
