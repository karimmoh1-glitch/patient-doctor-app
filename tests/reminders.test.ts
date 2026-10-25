import { describe, it, expect, beforeAll, afterEach } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { getApp, signupPatient, createDoctor, createCaregiverAccount, connect, auth, issuePrescription } from "./helpers";
import { storage } from "../server/storage";
import { dispatchAppointmentReminders, dispatchDueReminders, nextOccurrence, occurrencesInWindow, type ReminderSchedule } from "../server/services/reminderService";

let app: Express;
beforeAll(async () => {
  app = await getApp();
});
afterEach(() => {
  delete process.env.CRON_SECRET;
});

const daily = (over: Partial<ReminderSchedule> = {}): ReminderSchedule => ({
  times: ["08:00"],
  weekdays: [0, 1, 2, 3, 4, 5, 6],
  timezone: "America/Chicago",
  startDate: "2026-01-01",
  endDate: null,
  ...over,
});

describe("when a reminder is due", () => {
  it("is the wall-clock time in the patient's own zone, whatever UTC says", () => {
    // 08:00 in Chicago on 10 June (CDT, UTC-5) is 13:00 UTC.
    const found = occurrencesInWindow(daily(), new Date("2026-06-10T00:00:00Z"), new Date("2026-06-10T23:59:00Z"));
    expect(found.map((d) => d.toISOString())).toEqual(["2026-06-10T13:00:00.000Z"]);
  });

  it("keeps 08:00 as 08:00 across the daylight-saving change", () => {
    const winter = occurrencesInWindow(daily(), new Date("2026-03-07T00:00:00Z"), new Date("2026-03-07T23:59:00Z"));
    const summer = occurrencesInWindow(daily(), new Date("2026-03-09T00:00:00Z"), new Date("2026-03-09T23:59:00Z"));
    expect(winter[0].toISOString()).toBe("2026-03-07T14:00:00.000Z"); // CST, UTC-6
    expect(summer[0].toISOString()).toBe("2026-03-09T13:00:00.000Z"); // CDT, UTC-5
  });

  it("still fires, at the next valid minute, when the time doesn't exist that day", () => {
    // 2026-03-08 02:30 does not exist in Chicago.
    const found = occurrencesInWindow(daily({ times: ["02:30"] }), new Date("2026-03-08T00:00:00Z"), new Date("2026-03-08T23:59:00Z"));
    expect(found).toHaveLength(1);
  });

  it("honours chosen weekdays and the start and end dates", () => {
    const wed = daily({ weekdays: [3] }); // Wednesdays only
    const window = [new Date("2026-06-08T00:00:00Z"), new Date("2026-06-15T23:59:00Z")] as const;
    expect(occurrencesInWindow(wed, ...window).map((d) => d.toISOString())).toEqual(["2026-06-10T13:00:00.000Z"]);
    expect(occurrencesInWindow(daily({ startDate: "2026-06-12" }), ...window)).toHaveLength(4); // 12,13,14,15
    expect(occurrencesInWindow(daily({ endDate: "2026-06-09" }), ...window)).toHaveLength(2); // 8,9
  });

  it("treats the start of the window as exclusive and the end as inclusive", () => {
    const at = new Date("2026-06-10T13:00:00Z");
    expect(occurrencesInWindow(daily(), at, new Date("2026-06-10T14:00:00Z"))).toHaveLength(0);
    expect(occurrencesInWindow(daily(), new Date("2026-06-10T12:00:00Z"), at)).toHaveLength(1);
  });

  it("finds the next reminder even when it is days away", () => {
    const next = nextOccurrence(daily({ weekdays: [3] }), new Date("2026-06-11T00:00:00Z"));
    expect(next!.toISOString()).toBe("2026-06-17T13:00:00.000Z");
  });
});

async function patientWithMedicine() {
  const patient = await signupPatient();
  const doctor = await createDoctor();
  const { pairingId } = await connect(patient, doctor);
  const rx = await issuePrescription(doctor, pairingId, { medicationName: "Private Medicine Q" });
  const tracked = await request(app).post(`/api/prescriptions/${rx.id}/track`).set(auth(patient.token));
  expect(tracked.status).toBe(201);
  return { patient, doctor, rx, medicationId: tracked.body.id as string };
}

const body = (over: object = {}) => ({ times: ["08:00", "20:00"], weekdays: [0, 1, 2, 3, 4, 5, 6], enabled: true, ...over });

describe("setting reminders", () => {
  it("saves the patient's own schedule in their own time zone and says when the next one is", async () => {
    const { patient, medicationId } = await patientWithMedicine();
    const put = await request(app).put(`/api/reminders/${medicationId}`).set({ ...auth(patient.token), "X-Timezone": "Asia/Dubai" }).send(body());
    expect(put.status).toBe(200);
    expect(put.body.timezone).toBe("Asia/Dubai");
    expect(put.body.times).toEqual(["08:00", "20:00"]);
    expect(new Date(put.body.nextDueAt).getTime()).toBeGreaterThan(Date.now());

    const list = await request(app).get("/api/reminders").set(auth(patient.token));
    expect(list.body.medications[0].reminder.times).toEqual(["08:00", "20:00"]);
    expect(list.body.medications[0].suggestedTimes.length).toBeGreaterThan(0);
  });

  it("validates times, days and duplicates on the server", async () => {
    const { patient, medicationId } = await patientWithMedicine();
    for (const bad of [{ times: ["8am"] }, { times: ["25:00"] }, { times: [] }, { times: ["08:00", "08:00"] }, { weekdays: [] }, { weekdays: [7] }, { times: Array(7).fill("08:00") }]) {
      const res = await request(app).put(`/api/reminders/${medicationId}`).set(auth(patient.token)).send(body(bad));
      expect(res.status, JSON.stringify(bad)).toBe(400);
    }
  });

  it("belongs to the patient: nobody else can set, read or delete it", async () => {
    const { patient, doctor, medicationId } = await patientWithMedicine();
    await request(app).put(`/api/reminders/${medicationId}`).set(auth(patient.token)).send(body());
    const other = await signupPatient();
    const caregiver = await createCaregiverAccount();
    for (const who of [other]) {
      expect((await request(app).put(`/api/reminders/${medicationId}`).set(auth(who.token)).send(body())).status).toBe(404);
      expect((await request(app).delete(`/api/reminders/${medicationId}`).set(auth(who.token))).status).toBe(404);
      expect((await request(app).get("/api/reminders").set(auth(who.token))).body.medications).toEqual([]);
    }
    for (const who of [doctor, caregiver]) {
      expect((await request(app).get("/api/reminders").set(auth(who.token))).status).toBe(403);
      expect((await request(app).put(`/api/reminders/${medicationId}`).set(auth(who.token)).send(body())).status).toBe(403);
    }
  });

  it("refuses email reminders when no email provider is configured", async () => {
    const { patient, medicationId } = await patientWithMedicine();
    const res = await request(app).put(`/api/reminders/${medicationId}`).set(auth(patient.token)).send(body({ emailEnabled: true }));
    expect(res.status).toBe(409);
  });
});

describe("delivering reminders", () => {
  async function saved(over: object = {}) {
    const ctx = await patientWithMedicine();
    await storage.upsertReminder({
      patientUserId: ctx.patient.id, medicationId: ctx.medicationId, times: ["08:00"], weekdays: [0, 1, 2, 3, 4, 5, 6],
      timezone: "America/Chicago", startDate: "2026-06-01", endDate: null, enabled: true, emailEnabled: false, showMedicationName: false, ...over,
    });
    return ctx;
  }
  const justAfter = new Date("2026-06-10T13:01:00Z"); // 08:01 in Chicago

  it("sends an in-app notification that does NOT name the medicine by default", async () => {
    const { patient } = await saved();
    const result = await dispatchDueReminders(justAfter);
    expect(result.inApp).toBeGreaterThanOrEqual(1);
    const mine = (await storage.getNotificationsForUser(patient.id, 10)).filter((n) => n.kind === "reminder.due");
    expect(mine).toHaveLength(1);
    expect(mine[0].params).toEqual({ time: "08:00" });
    expect(JSON.stringify(mine)).not.toMatch(/Private Medicine Q/);
  });

  it("names the medicine only when the patient chose to show it", async () => {
    const { patient } = await saved({ showMedicationName: true });
    await dispatchDueReminders(justAfter);
    const mine = (await storage.getNotificationsForUser(patient.id, 10)).filter((n) => n.kind === "reminder.due");
    expect(mine[0].params).toMatchObject({ medicationName: "Private Medicine Q" });
  });

  it("is idempotent: running again, or twice at once, never duplicates", async () => {
    const { patient } = await saved();
    await Promise.all([dispatchDueReminders(justAfter), dispatchDueReminders(justAfter), dispatchDueReminders(justAfter)]);
    await dispatchDueReminders(new Date(justAfter.getTime() + 60_000));
    const mine = (await storage.getNotificationsForUser(patient.id, 20)).filter((n) => n.kind === "reminder.due");
    expect(mine).toHaveLength(1);
  });

  it("does not send a paused reminder, or one for a cancelled prescription", async () => {
    const paused = await saved({ enabled: false });
    const cancelled = await saved();
    await request(app).patch(`/api/prescriptions/${cancelled.rx.id}/cancel`).set(auth(cancelled.doctor.token));
    await dispatchDueReminders(justAfter);
    expect((await storage.getNotificationsForUser(paused.patient.id, 10)).filter((n) => n.kind === "reminder.due")).toHaveLength(0);
    expect((await storage.getNotificationsForUser(cancelled.patient.id, 10)).filter((n) => n.kind === "reminder.due")).toHaveLength(0);
  });

  it("does not send a stale reminder hours late", async () => {
    const { patient } = await saved();
    await dispatchDueReminders(new Date("2026-06-10T20:00:00Z"), { lookbackMinutes: 180 }); // 15:00 Chicago; 08:00 was 7h ago
    expect((await storage.getNotificationsForUser(patient.id, 10)).filter((n) => n.kind === "reminder.due")).toHaveLength(0);
  });

  it("never records anything about whether a dose was taken", async () => {
    const { patient, medicationId } = await saved();
    await dispatchDueReminders(justAfter);
    const logs = await storage.getMedicationLogsByPatientAndDate(patient.id, "2026-06-10");
    expect(logs.filter((l) => l.medicationId === medicationId)).toHaveLength(0);
  });
});

describe("the scheduler endpoint and its honesty", () => {
  it("does not exist without a secret, rejects a wrong one, and runs with the right one", async () => {
    expect((await request(app).get("/api/cron/reminders")).status).toBe(503);
    process.env.CRON_SECRET = "s3cret-value-for-test";
    expect((await request(app).get("/api/cron/reminders")).status).toBe(401);
    expect((await request(app).get("/api/cron/reminders").set("Authorization", "Bearer wrong-value-for-test!")).status).toBe(401);
    expect((await request(app).get("/api/cron/reminders").set("Authorization", "Bearer s3cret-value-for-test")).status).toBe(200);
  });

  it("reports delivery as active only after a recent run", async () => {
    const cfg = async () => (await request(app).get("/api/config")).body.features.reminderDelivery;
    expect(await cfg()).toBe("not_configured");
    process.env.CRON_SECRET = "s3cret-value-for-test";
    await storage.recordJobRun("reminders", new Date(Date.now() - 5 * 3_600_000), {});
    expect(await cfg()).toBe("stale");
    await request(app).get("/api/cron/reminders").set("Authorization", "Bearer s3cret-value-for-test");
    expect(await cfg()).toBe("active");
  });
});

describe("notifications", () => {
  it("are private to their owner and can be marked read", async () => {
    const a = await signupPatient();
    const b = await signupPatient();
    const n = await storage.createNotification({ userId: a.id, kind: "reminder.due", params: { time: "08:00" }, link: "/medications" });
    const mineBefore = await request(app).get("/api/notifications").set(auth(a.token));
    expect(mineBefore.body.unread).toBe(1);
    expect((await request(app).get("/api/notifications").set(auth(b.token))).body.items).toEqual([]);
    // Someone else can't mark it read.
    await request(app).post("/api/notifications/read").set(auth(b.token)).send({ ids: [n.id] });
    expect((await request(app).get("/api/notifications").set(auth(a.token))).body.unread).toBe(1);
    await request(app).post("/api/notifications/read").set(auth(a.token)).send({ ids: [n.id] });
    expect((await request(app).get("/api/notifications").set(auth(a.token))).body.unread).toBe(0);
  });
});

describe("appointment notices and message notices", () => {
  async function confirmedVisit(hoursAhead: number) {
    const patient = await signupPatient();
    const doctor = await createDoctor({ name: "Dr. Notice" });
    const { pairingId } = await connect(patient, doctor);
    const appt = await storage.createAppointment({
      pairingRequestId: pairingId, patientUserId: patient.id, doctorProfileId: doctor.profileId, type: "Phone Call",
      reason: "SECRET REASON", scheduledAt: new Date(Date.now() + hoursAhead * 3_600_000), durationMinutes: 30, questionsForDoctor: [],
    });
    await request(app).patch(`/api/appointments/${appt.id}/confirm`).set(auth(doctor.token));
    return { patient, doctor, appt, pairingId };
  }
  const notices = async (userId: string) => (await storage.getNotificationsForUser(userId, 20)).filter((n) => n.kind === "appointment.soon");

  it("tells the patient once, in the 24 hours before a confirmed visit, without saying why they're going", async () => {
    const { patient } = await confirmedVisit(5);
    await Promise.all([dispatchAppointmentReminders(new Date()), dispatchAppointmentReminders(new Date())]);
    await dispatchAppointmentReminders(new Date());
    const mine = await notices(patient.id);
    expect(mine).toHaveLength(1);
    expect(mine[0].params).toMatchObject({ doctorName: "Dr. Notice" });
    expect(JSON.stringify(mine)).not.toMatch(/SECRET REASON/);
  });

  it("does not remind about visits that are far off, unconfirmed or cancelled", async () => {
    const far = await confirmedVisit(72);
    await dispatchAppointmentReminders(new Date());
    expect(await notices(far.patient.id)).toHaveLength(0);

    const cancelled = await confirmedVisit(5);
    await request(app).patch(`/api/appointments/${cancelled.appt.id}/cancel`).set(auth(cancelled.patient.token));
    await dispatchAppointmentReminders(new Date());
    expect(await notices(cancelled.patient.id)).toHaveLength(0);
  });

  it("tells the other person about a new message, once until they have seen it, and never includes the text", async () => {
    const patient = await signupPatient({ name: "Nora Patient" });
    const doctor = await createDoctor({ name: "Dr. Reader" });
    const { pairingId } = await connect(patient, doctor);
    for (const body of ["PRIVATE words one", "PRIVATE words two"]) {
      expect((await request(app).post(`/api/pairings/${pairingId}/messages`).set(auth(patient.token)).send({ body })).status).toBe(201);
    }
    const forDoctor = (await storage.getNotificationsForUser(doctor.id, 10)).filter((n) => n.kind === "message.new");
    expect(forDoctor).toHaveLength(1);
    expect(forDoctor[0].params).toEqual({ name: "Nora Patient" });
    expect(JSON.stringify(forDoctor)).not.toMatch(/PRIVATE/);
    // And the patient is told when the doctor replies.
    await request(app).post(`/api/pairings/${pairingId}/messages`).set(auth(doctor.token)).send({ body: "reply" });
    expect((await storage.getNotificationsForUser(patient.id, 10)).filter((n) => n.kind === "message.new")).toHaveLength(1);
  });
});
