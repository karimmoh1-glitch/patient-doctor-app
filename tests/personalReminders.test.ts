import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { eq } from "drizzle-orm";
import { getApp, signupPatient, createDoctor, createAdmin, createCaregiverAccount, auth, type TestUser } from "./helpers";
import { db } from "../server/db";
import { runAsSystem } from "../server/dbContext";
import { notifications, personalReminderDeliveries, personalReminders, users } from "@shared/schema";
import { dispatchPersonalReminders } from "../server/services/personalReminders";
import { CONSENT_VERSION } from "../server/services/healthProfile";

const provider = vi.hoisted(() => ({ fails: 0, accepted: [] as { to: string[]; subject: string; text: string }[] }));
vi.mock("resend", () => ({
  Resend: class {
    emails = {
      send: async (m: any) => {
        if (provider.fails > 0) { provider.fails--; return { data: null, error: { name: "rate_limit_exceeded" } }; }
        provider.accepted.push(m);
        return { data: { id: `msg_${Math.random().toString(36).slice(2)}` }, error: null };
      },
    };
  },
}));

let app: Express;
beforeAll(async () => {
  app = await getApp();
});
afterEach(() => {
  delete process.env.RESEND_API_KEY;
  provider.fails = 0;
  provider.accepted.length = 0;
});

const sys = <T,>(f: () => Promise<T>) => runAsSystem(f);
async function confirmedPatient() {
  const p = await signupPatient();
  await sys(() => db.update(users).set({ emailVerifiedAt: new Date() }).where(eq(users.id, p.id)));
  return p;
}
const NOW = new Date("2026-06-10T12:00:00Z");
const api = {
  post: (u: TestUser, path: string, body: object = {}) => request(app).post(`/api/personal-reminders${path}`).set(auth(u.token)).send(body),
  put: (u: TestUser, path: string, body: object = {}) => request(app).put(`/api/personal-reminders${path}`).set(auth(u.token)).send(body),
  get: (u: TestUser, path = "") => request(app).get(`/api/personal-reminders${path}`).set(auth(u.token)),
  del: (u: TestUser, path: string) => request(app).delete(`/api/personal-reminders${path}`).set(auth(u.token)),
};
const once = (over: Record<string, unknown> = {}) => ({ kind: "task", title: "Call the pharmacy", recurrence: "once", times: ["11:50"], anchorDate: "2026-06-10", timezone: "UTC", ...over });
const sub = (over: Record<string, unknown> = {}) => ({ kind: "subscription", title: "Streaming", renewalDate: "2026-06-13", renewalInterval: "monthly", offsetsDays: [3], time: "11:55", timezone: "UTC", ...over });
const notesFor = (u: TestUser) => sys(() => db.select().from(notifications).where(eq(notifications.userId, u.id)));
const deliveriesFor = async (reminderId: string) => sys(() => db.select().from(personalReminderDeliveries).where(eq(personalReminderDeliveries.reminderId, reminderId)));
// The tests pretend it is June 2026; reminders made "long ago" are what a scheduler normally finds, so back-date their edit time.
const run = async (opts: Record<string, unknown> = {}, now = NOW) => {
  await sys(() => db.update(personalReminders).set({ updatedAt: new Date("2020-01-01T00:00:00Z") }).where(eq(personalReminders.status, "active")));
  return dispatchPersonalReminders(now, opts);
};
const runKeepingEditTimes = (opts: Record<string, unknown> = {}, now = NOW) => dispatchPersonalReminders(now, opts);

describe("creating reminders", () => {
  it("works for a patient with no doctor at all, for every kind, and keeps what was said", async () => {
    const p = await signupPatient();
    for (const body of [
      once({ kind: "medication", title: "Evening tablet", recurrence: "daily", times: ["08:00", "20:00"], anchorDate: "2026-06-01" }),
      once({ kind: "appointment", title: "Dentist" }),
      once({ kind: "other", title: "Water the plants", recurrence: "weekly", weekdays: [1, 4], anchorDate: "2026-06-01" }),
      sub({ kind: "bill", title: "Electricity", renewalInterval: null, amountMinor: 45000, currency: "EGP" }),
      sub({ title: "Music", cancelByDate: "2026-06-10", amountMinor: 999, currency: "USD", offsetsDays: [7, 1] }),
    ]) {
      const res = await api.post(p, "", body);
      expect(res.status).toBe(201);
      expect(res.body.status).toBe("active");
    }
    const list = (await api.get(p)).body;
    expect(list.reminders).toHaveLength(5);
    const music = list.reminders.find((r: any) => r.title === "Music");
    expect(music).toMatchObject({ amountMinor: 999, currency: "USD", offsetsDays: [7, 1], cancelByDate: "2026-06-10" });
    // Only what is really available is said to be.
    expect(list.channels).toEqual({ inApp: true, email: false, sms: false, push: false });
  });

  it("refuses bad input with a plain reason", async () => {
    const p = await signupPatient();
    for (const bad of [
      once({ times: ["25:00"] }), once({ times: [] }), once({ times: ["08:00", "08:00"] }), once({ timezone: "Mars/Base" }), once({ anchorDate: "2026-02-30" }),
      once({ title: "   " }), once({ recurrence: "hourly" }), once({ quietStart: "22:00" }), once({ endDate: "2026-01-01" }),
      sub({ offsetsDays: [] }), sub({ offsetsDays: [-1] }), sub({ currency: "usd", amountMinor: 5 }), sub({ amountMinor: 5 }), sub({ renewalDate: "soon" }), { ...once(), surprise: 1 },
    ]) {
      expect((await api.post(p, "", bad)).status).toBe(400);
    }
    expect((await api.post(p, "", once({ kind: "medication", healthEntryId: "not-mine" }))).status).toBe(404);
    expect((await api.get(p)).body.reminders).toEqual([]);
  });

  it("links a medicine reminder only to a medicine the person listed themselves", async () => {
    const a = await signupPatient();
    const b = await signupPatient();
    for (const u of [a, b]) await request(app).post("/api/health-profile/consent").set(auth(u.token)).send({ version: CONSENT_VERSION });
    const entry = (await request(app).post("/api/health-profile/entries").set(auth(a.token)).send({ kind: "medication", data: { name: "Metformin" } })).body;
    expect((await api.post(a, "", once({ kind: "medication", healthEntryId: entry.id, title: "Metformin" }))).status).toBe(201);
    expect((await api.post(b, "", once({ kind: "medication", healthEntryId: entry.id, title: "Mine now" }))).status).toBe(404);
  });

  it("is private: other patients, doctors, administrators and caregivers cannot see, change or remove it", async () => {
    const owner = await signupPatient();
    const other = await signupPatient();
    const made = (await api.post(owner, "", once())).body;
    expect((await api.get(other)).body.reminders).toEqual([]);
    expect((await api.put(other, `/${made.id}`, once({ title: "Hijacked" }))).status).toBe(404);
    expect((await api.post(other, `/${made.id}/pause`)).status).toBe(404);
    expect((await api.del(other, `/${made.id}`)).status).toBe(404);
    for (const who of [await createDoctor(), await createAdmin(), await createCaregiverAccount()]) {
      expect((await api.get(who as any)).status).toBe(403);
      expect((await api.post(who as any, "", once())).status).toBe(403);
    }
    expect((await request(app).get("/api/personal-reminders")).status).toBe(401);
    expect((await api.get(owner)).body.reminders[0].title).toBe("Call the pharmacy");
  });
});

describe("delivering reminders", () => {
  it("places a notice in the app once, however many times the scheduler runs, including at the same moment", async () => {
    const p = await signupPatient();
    const r = (await api.post(p, "", once())).body;
    await Promise.all([run(), run(), run()]);
    await run();
    const notes = (await notesFor(p)).filter((n) => n.kind === "personal.due");
    expect(notes).toHaveLength(1);
    expect(notes[0].params).toMatchObject({ title: "Call the pharmacy", time: "11:50" });
    const ds = await deliveriesFor(r.id);
    expect(ds).toHaveLength(1);
    expect(ds[0]).toMatchObject({ channel: "in_app", status: "sent" });
  });

  it("delivers several daily times and weekdays correctly, and nothing outside them", async () => {
    const p = await signupPatient();
    // 2026-06-10 is a Wednesday (3).
    const yes = (await api.post(p, "", once({ recurrence: "daily", times: ["10:30", "11:40", "13:00"], weekdays: [3], anchorDate: "2026-06-01" }))).body;
    const no = (await api.post(p, "", once({ recurrence: "weekly", times: ["11:30"], weekdays: [1], anchorDate: "2026-06-01", title: "Mondays" }))).body;
    await run();
    expect((await deliveriesFor(yes.id)).map((d) => d.dueAt.toISOString().slice(11, 16)).sort()).toEqual(["10:30", "11:40"]); // 13:00 is still in the future
    expect(await deliveriesFor(no.id)).toHaveLength(0);
  });

  it("catches up after an outage without a storm: each missed occurrence once, nothing older than the window", async () => {
    const p = await signupPatient();
    const r = (await api.post(p, "", once({ recurrence: "daily", times: ["07:00", "10:00", "11:00", "11:45"], anchorDate: "2026-06-01" }))).body;
    await run({ lookbackMinutes: 180 }); // 09:00 to 12:00: 10:00, 11:00, 11:45; the 07:00 one is too old
    expect((await deliveriesFor(r.id)).map((d) => d.dueAt.toISOString().slice(11, 16)).sort()).toEqual(["10:00", "11:00", "11:45"]);
    await run({ lookbackMinutes: 180 });
    expect(await deliveriesFor(r.id)).toHaveLength(3);
  });

  it("does nothing for a paused or cancelled reminder, and resumes cleanly", async () => {
    const p = await signupPatient();
    const paused = (await api.post(p, "", once({ title: "Paused one" }))).body;
    const cancelled = (await api.post(p, "", once({ title: "Cancelled one" }))).body;
    expect((await api.post(p, `/${paused.id}/pause`)).body.status).toBe("paused");
    expect((await api.post(p, `/${cancelled.id}/cancel`)).body.status).toBe("cancelled");
    await run();
    expect(await deliveriesFor(paused.id)).toHaveLength(0);
    expect(await deliveriesFor(cancelled.id)).toHaveLength(0);
    expect((await api.post(p, `/${paused.id}/resume`)).body.status).toBe("active");
    await run();
    expect(await deliveriesFor(paused.id)).toHaveLength(1);
    // A cancelled one cannot be revived, edited or snoozed.
    expect((await api.post(p, `/${cancelled.id}/resume`)).status).toBe(404);
    expect((await api.put(p, `/${cancelled.id}`, once())).status).toBe(404);
    expect((await api.post(p, `/${cancelled.id}/snooze`, { minutes: 10 })).status).toBe(404);
  });

  it("does not deliver for a closed account", async () => {
    const p = await signupPatient();
    const r = (await api.post(p, "", once())).body;
    await sys(() => db.update(users).set({ deactivatedAt: new Date() }).where(eq(users.id, p.id)));
    await run();
    expect(await deliveriesFor(r.id)).toHaveLength(0);
  });

  it("snoozing adds one more notice at the chosen time", async () => {
    const p = await signupPatient();
    const r = (await api.post(p, "", once({ anchorDate: "2026-06-09" }))).body; // not due today
    await api.post(p, `/${r.id}/snooze`, { minutes: 5 });
    expect((await api.post(p, `/${r.id}/snooze`, { minutes: 1 })).status).toBe(400);
    const snoozedUntil = (await sys(() => db.select().from(personalReminders).where(eq(personalReminders.id, r.id))))[0].snoozedUntil!;
    await run({}, new Date(snoozedUntil.getTime() + 60_000));
    const ds = await deliveriesFor(r.id);
    expect(ds).toHaveLength(1);
    expect(ds[0].dueAt.getTime()).toBe(snoozedUntil.getTime());
  });

  it("reminds before a renewal and before the cancellation deadline, and says nothing was charged or cancelled", async () => {
    const p = await signupPatient();
    // Renewal 13 June, 3 days before is today at 11:55; cancel-by 13 June too, with the same offset.
    const r = (await api.post(p, "", sub({ cancelByDate: "2026-06-13", amountMinor: 1299, currency: "USD" }))).body;
    await run();
    const notes = (await notesFor(p)).filter((n) => n.kind.startsWith("personal."));
    expect(notes.map((n) => n.kind).sort()).toEqual(["personal.cancel_by", "personal.renewal"]);
    expect(notes.every((n) => (n.params as any).days === 3 && (n.params as any).title === "Streaming")).toBe(true);
    expect(JSON.stringify(notes)).not.toMatch(/charged|paid|cancelled/i);
    expect(await deliveriesFor(r.id)).toHaveLength(2);
  });
});

describe("e-mail: what is attempted, accepted, held back or given up", () => {
  const emailOn = { emailEnabled: true };

  it("sends nothing by e-mail when no provider is configured, and says so", async () => {
    const p = await confirmedPatient();
    const r = (await api.post(p, "", once(emailOn))).body;
    await run({ emailEnabled: false });
    expect((await deliveriesFor(r.id)).map((d) => d.channel)).toEqual(["in_app"]);
    expect((await api.get(p)).body.channels.email).toBe(false);
  });

  it("is generic by default and names the reminder only if the person chose that", async () => {
    process.env.RESEND_API_KEY = "re_test";
    const p = await confirmedPatient();
    const generic = (await api.post(p, "", once({ ...emailOn, title: "Secret thing" }))).body;
    const named = (await api.post(p, "", once({ ...emailOn, title: "Visible thing", showTitleInEmail: true }))).body;
    await run({ emailEnabled: true });
    const mine = provider.accepted.filter((m) => m.to.includes(p.email)); // the run also covers other tests' people
    expect(mine).toHaveLength(2);
    const bodies = mine.map((m) => m.text);
    expect(bodies.some((b) => b.includes("Secret thing"))).toBe(false);
    expect(bodies.some((b) => b.includes("Visible thing"))).toBe(true);
    for (const r of [generic, named]) expect((await deliveriesFor(r.id)).find((d) => d.channel === "email")).toMatchObject({ status: "sent" });
  });

  it("retries a refused send at most three times in total and then gives up, never claiming delivery", async () => {
    process.env.RESEND_API_KEY = "re_test";
    provider.fails = 99;
    const p = await confirmedPatient();
    const r = (await api.post(p, "", once(emailOn))).body;
    for (let i = 0; i < 5; i++) {
      await run({ emailEnabled: true });
      await sys(() => db.update(personalReminderDeliveries).set({ updatedAt: new Date(Date.now() - 3_600_000) }).where(eq(personalReminderDeliveries.reminderId, r.id)));
    }
    const email = (await deliveriesFor(r.id)).find((d) => d.channel === "email")!;
    expect(email).toMatchObject({ status: "failed", attempts: 3 });
    expect(provider.accepted.filter((m) => m.to.includes(p.email))).toHaveLength(0);
    // The in-app notice was still delivered, once.
    expect((await deliveriesFor(r.id)).filter((d) => d.channel === "in_app")).toHaveLength(1);
  });

  it("recovers when the provider comes back, within the attempts that remain", async () => {
    process.env.RESEND_API_KEY = "re_test";
    provider.fails = 1;
    const p = await confirmedPatient();
    const r = (await api.post(p, "", once(emailOn))).body;
    await run({ emailEnabled: true });
    expect((await deliveriesFor(r.id)).find((d) => d.channel === "email")).toMatchObject({ status: "failed", attempts: 1 });
    await run({ emailEnabled: true });
    expect((await deliveriesFor(r.id)).find((d) => d.channel === "email")).toMatchObject({ status: "sent", attempts: 2 });
    expect(provider.accepted.filter((m) => m.to.includes(p.email))).toHaveLength(1);
  });

  it("holds e-mail back in quiet hours for good, while the in-app notice still arrives", async () => {
    process.env.RESEND_API_KEY = "re_test";
    const p = await confirmedPatient();
    const r = (await api.post(p, "", once({ ...emailOn, quietStart: "11:00", quietEnd: "13:00" }))).body;
    await run({ emailEnabled: true });
    await run({ emailEnabled: true }, new Date(NOW.getTime() + 90 * 60_000)); // quiet hours over: still not sent late
    const ds = await deliveriesFor(r.id);
    expect(ds.find((d) => d.channel === "email")?.status).toBe("suppressed");
    expect(ds.find((d) => d.channel === "in_app")?.status).toBe("sent");
    expect(provider.accepted.filter((m) => m.to.includes(p.email))).toHaveLength(0);
  });

  it("a send to the provider that throws does not stop other people's reminders", async () => {
    process.env.RESEND_API_KEY = "re_test";
    const a = await confirmedPatient();
    const b = await confirmedPatient();
    const ra = (await api.post(a, "", once(emailOn))).body;
    const rb = (await api.post(b, "", once({ title: "Other person" }))).body;
    provider.fails = 1;
    const result = await run({ emailEnabled: true });
    expect(result.errors).toBe(0);
    expect((await deliveriesFor(ra.id)).find((d) => d.channel === "in_app")).toBeTruthy();
    expect((await deliveriesFor(rb.id)).find((d) => d.channel === "in_app")).toBeTruthy();
  });
});

describe("what the reminder list says about delivery", () => {
  it("shows the next time, the renewal date, and the real status of recent deliveries, per channel", async () => {
    const p = await signupPatient();
    const r = (await api.post(p, "", once())).body;
    await run();
    const listed = (await api.get(p)).body.reminders.find((x: any) => x.id === r.id);
    expect(listed.recent).toEqual([expect.objectContaining({ channel: "in_app", status: "sent", occurrence: "due" })]);
    const s = (await api.post(p, "", sub({ renewalDate: "2027-01-31", renewalInterval: "monthly" }))).body;
    const listedSub = (await api.get(p)).body.reminders.find((x: any) => x.id === s.id);
    expect(listedSub.nextRenewal).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(listedSub.nextDueAt).toBeTruthy();
  });

  it("is deleted with the account's data on erasure and included in the download", async () => {
    const p = await signupPatient();
    await api.post(p, "", once({ title: "Export me" }));
    const exported = (await request(app).get("/api/me/export").set(auth(p.token))).body;
    expect(exported.personalReminders.map((x: any) => x.title)).toContain("Export me");
  });
});

describe("what an administrator sees of personal reminders", () => {
  it("counts only: how many are on and what happened in the last day, naming no one and no reminder", async () => {
    const admin = await createAdmin();
    const p = await signupPatient();
    await api.post(p, "", once({ title: "A very private errand" }));
    const res = await request(app).get("/api/admin/reminders/status").set(auth(admin.token));
    expect(res.status).toBe(200);
    expect(res.body.personal).toEqual({ activeReminders: expect.any(Number), last24h: { inAppDelivered: expect.any(Number), emailAccepted: expect.any(Number), emailFailed: expect.any(Number), emailHeldForQuietHours: expect.any(Number), overdue: expect.any(Number) } });
    expect(JSON.stringify(res.body)).not.toContain("A very private errand");
    expect((await request(app).get("/api/admin/reminders/status").set(auth(p.token))).status).toBe(403);
  });
});

describe("review findings", () => {
  it("never e-mails an address the person has not confirmed, and says why when asked to switch e-mail on", async () => {
    process.env.RESEND_API_KEY = "re_test";
    const p = await signupPatient(); // not confirmed
    const refused = await api.post(p, "", once({ emailEnabled: true }));
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe("email_not_verified");
    // Even a reminder that somehow has e-mail switched on sends nothing until the address is confirmed.
    const r = (await api.post(p, "", once())).body;
    await sys(() => db.update(personalReminders).set({ emailEnabled: true, showTitleInEmail: true }).where(eq(personalReminders.id, r.id)));
    await run({ emailEnabled: true });
    expect((await deliveriesFor(r.id)).map((d) => d.channel)).toEqual(["in_app"]);
    expect(provider.accepted.filter((m) => m.to.includes(p.email))).toHaveLength(0);
    // Once confirmed, a title is allowed only because the address is the person's.
    await sys(() => db.update(users).set({ emailVerifiedAt: new Date() }).where(eq(users.id, p.id)));
    await sys(() => db.delete(personalReminderDeliveries).where(eq(personalReminderDeliveries.reminderId, r.id)));
    await run({ emailEnabled: true });
    expect(provider.accepted.filter((m) => m.to.includes(p.email))).toHaveLength(1);
  });

  it("limits how many e-mails one person can be sent in a day", async () => {
    process.env.RESEND_API_KEY = "re_test";
    const p = await confirmedPatient();
    const times = ["08:00", "08:30", "09:00", "09:30", "10:00", "10:30"];
    for (let i = 0; i < 5; i++) await api.post(p, "", once({ emailEnabled: true, recurrence: "daily", times, anchorDate: "2026-06-01", title: `Many ${i}` }));
    await run({ emailEnabled: true, lookbackMinutes: 600 });
    expect(provider.accepted.filter((m) => m.to.includes(p.email)).length).toBeLessThanOrEqual(20);
  });

  it("refuses dates that are typos and a weekly reminder on every day, and keeps an old renewal date cheap", async () => {
    const p = await signupPatient();
    expect((await api.post(p, "", sub({ renewalDate: "0001-01-01" }))).status).toBe(400);
    expect((await api.post(p, "", sub({ renewalDate: "9999-12-31" }))).status).toBe(400);
    expect((await api.post(p, "", once({ recurrence: "weekly", weekdays: [0, 1, 2, 3, 4, 5, 6], anchorDate: "2026-06-01" }))).status).toBe(400);
    const old = await api.post(p, "", sub({ renewalDate: "2000-01-31", renewalInterval: "weekly" }));
    expect(old.status).toBe(201);
    const t0 = Date.now();
    const list = await api.get(p);
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(list.body.reminders[0].nextRenewal).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("delivers nothing for moments before the reminder was created or last edited", async () => {
    const p = await signupPatient();
    const justNow = new Date();
    const hhmm = (d: Date) => d.toISOString().slice(11, 16);
    const earlier = new Date(justNow.getTime() - 30 * 60_000);
    const r = (await api.post(p, "", once({ anchorDate: justNow.toISOString().slice(0, 10), times: [hhmm(earlier)] }))).body;
    await runKeepingEditTimes({}, new Date(justNow.getTime() + 60_000));
    expect(await deliveriesFor(r.id)).toHaveLength(0); // it was due before it existed
  });

  it("keeps two notices that fall at the same instant, one a minute after the other", async () => {
    const p = await signupPatient();
    // Weekly renewal with offsets 0 and 7: the 7-day-early reminder for one renewal and the on-the-day reminder for the previous one coincide.
    const r = (await api.post(p, "", sub({ renewalDate: "2026-06-17", renewalInterval: "weekly", offsetsDays: [7, 0], time: "11:55" }))).body;
    await run({}, new Date("2026-06-10T12:30:00Z"));
    const ds = (await deliveriesFor(r.id)).filter((d) => d.channel === "in_app");
    expect(ds.length).toBeGreaterThanOrEqual(1);
    expect(new Set(ds.map((d) => d.dueAt.getTime())).size).toBe(ds.length);
  });
});
