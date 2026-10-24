import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { getApp, signupPatient, createDoctor, connect, auth, type TestDoctor, type TestUser } from "./helpers";
import { storage } from "../server/storage";

let app: Express;
beforeAll(async () => {
  app = await getApp();
});

const EVERY_DAY = [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, startMinute: 0, endMinute: 1440 }));

async function publish(doctor: TestDoctor, timezone = "America/Los_Angeles") {
  const res = await request(app).put("/api/doctors/me/availability").set(auth(doctor.token)).send({ timezone, windows: EVERY_DAY });
  expect(res.status).toBe(200);
}

async function slotsFor(patient: TestUser, pairingId: string) {
  const res = await request(app).get(`/api/appointments/slots?pairingRequestId=${pairingId}&days=10`).set(auth(patient.token));
  expect(res.status).toBe(200);
  return res.body as { doctorTimezone: string; hasPublishedAvailability: boolean; slots: string[] };
}

function book(patient: TestUser, pairingId: string, scheduledAt: string) {
  return request(app)
    .post("/api/appointments")
    .set(auth(patient.token))
    .send({ pairingRequestId: pairingId, type: "Video Visit", reason: "Follow-up on cough", scheduledAt });
}

describe("doctor availability", () => {
  it("is set by the doctor, validated, and unavailable to other roles", async () => {
    const doctor = await createDoctor();
    const patient = await signupPatient();
    expect((await request(app).put("/api/doctors/me/availability").set(auth(patient.token)).send({ timezone: "America/Chicago", windows: [] })).status).toBe(403);
    expect((await request(app).put("/api/doctors/me/availability").set(auth(doctor.token)).send({ timezone: "Nowhere/Land", windows: [] })).status).toBe(400);
    expect(
      (await request(app).put("/api/doctors/me/availability").set(auth(doctor.token)).send({ timezone: "America/Chicago", windows: [{ weekday: 1, startMinute: 600, endMinute: 540 }] })).status,
    ).toBe(400);
    await publish(doctor, "America/Chicago");
    const got = await request(app).get("/api/doctors/me/availability").set(auth(doctor.token));
    expect(got.body.timezone).toBe("America/Chicago");
    expect(got.body.windows).toHaveLength(7);
  });
});

describe("booking", () => {
  it("offers real slots only to a connected patient, and never to a stranger", async () => {
    const doctor = await createDoctor();
    await publish(doctor);
    const patient = await signupPatient();
    const stranger = await signupPatient();
    const { pairingId } = await connect(patient, doctor);

    const mine = await slotsFor(patient, pairingId);
    expect(mine.hasPublishedAvailability).toBe(true);
    expect(mine.doctorTimezone).toBe("America/Los_Angeles");
    expect(mine.slots.length).toBeGreaterThan(50);

    const denied = await request(app).get(`/api/appointments/slots?pairingRequestId=${pairingId}`).set(auth(stranger.token));
    expect(denied.status).toBe(404);
  });

  it("tells the truth when a doctor has not published any times", async () => {
    const doctor = await createDoctor();
    const patient = await signupPatient();
    const { pairingId } = await connect(patient, doctor);
    const s = await slotsFor(patient, pairingId);
    expect(s.hasPublishedAvailability).toBe(false);
    expect(s.slots).toEqual([]);

    const tryBook = await book(patient, pairingId, new Date(Date.now() + 3 * 86_400_000).toISOString());
    expect(tryBook.status).toBe(409);
    expect(tryBook.body.code).toBe("no_availability");
  });

  it("books an offered slot and removes it for everyone else", async () => {
    const doctor = await createDoctor();
    await publish(doctor);
    const a = await signupPatient();
    const b = await signupPatient();
    const { pairingId: pa } = await connect(a, doctor);
    const { pairingId: pb } = await connect(b, doctor);

    const slot = (await slotsFor(a, pa)).slots[10];
    const first = await book(a, pa, slot);
    expect(first.status).toBe(201);
    expect(first.body.status).toBe("requested");

    expect((await slotsFor(b, pb)).slots).not.toContain(slot);
    const second = await book(b, pb, slot);
    expect(second.status).toBe(409);
    expect(second.body.code).toBe("slot_unavailable");
  });

  it("lets exactly one of two simultaneous requests win the same slot", async () => {
    const doctor = await createDoctor();
    await publish(doctor);
    const a = await signupPatient();
    const b = await signupPatient();
    const { pairingId: pa } = await connect(a, doctor);
    const { pairingId: pb } = await connect(b, doctor);
    const slot = (await slotsFor(a, pa)).slots[20];

    const [r1, r2] = await Promise.all([book(a, pa, slot), book(b, pb, slot)]);
    expect([r1.status, r2.status].sort()).toEqual([201, 409]);

    const live = (await storage.getAppointmentsByDoctorProfile(doctor.profileId)).filter((x) => x.status !== "cancelled");
    expect(live.filter((x) => x.scheduledAt.toISOString() === slot)).toHaveLength(1);
  });

  it("rejects times that are not offered: off-grid, past, and outside working hours", async () => {
    const doctor = await createDoctor();
    await request(app)
      .put("/api/doctors/me/availability")
      .set(auth(doctor.token))
      .send({ timezone: "America/Los_Angeles", windows: EVERY_DAY.map((w) => ({ ...w, startMinute: 540, endMinute: 600 })) });
    const patient = await signupPatient();
    const { pairingId } = await connect(patient, doctor);
    const slots = (await slotsFor(patient, pairingId)).slots;

    const offGrid = new Date(new Date(slots[0]).getTime() + 7 * 60_000).toISOString();
    expect((await book(patient, pairingId, offGrid)).status).toBe(409);
    expect((await book(patient, pairingId, new Date(Date.now() - 86_400_000).toISOString())).status).toBe(409);
    const midnightPacific = new Date(new Date(slots[0]).getTime() - 9 * 3600_000).toISOString();
    expect((await book(patient, pairingId, midnightPacific)).status).toBe(409);
  });

  it("requires an accepted connection to the doctor", async () => {
    const doctor = await createDoctor();
    await publish(doctor);
    const patient = await signupPatient();
    const { pairingId } = await connect(patient, doctor, { accept: false });
    const res = await book(patient, pairingId, new Date(Date.now() + 3 * 86_400_000).toISOString());
    expect(res.status).toBe(404);
  });
});

describe("cancelling and rescheduling", () => {
  it("frees the slot when an appointment is cancelled", async () => {
    const doctor = await createDoctor();
    await publish(doctor);
    const a = await signupPatient();
    const b = await signupPatient();
    const { pairingId: pa } = await connect(a, doctor);
    const { pairingId: pb } = await connect(b, doctor);
    const slot = (await slotsFor(a, pa)).slots[5];
    const appt = await book(a, pa, slot);
    expect((await request(app).patch(`/api/appointments/${appt.body.id}/cancel`).set(auth(a.token))).status).toBe(200);
    expect((await book(b, pb, slot)).status).toBe(201);
  });

  it("moves an appointment to a new offered time, asks the doctor to reconfirm, and frees the old time", async () => {
    const doctor = await createDoctor();
    await publish(doctor);
    const a = await signupPatient();
    const b = await signupPatient();
    const { pairingId: pa } = await connect(a, doctor);
    const { pairingId: pb } = await connect(b, doctor);
    const slots = (await slotsFor(a, pa)).slots;
    const appt = await book(a, pa, slots[3]);
    await request(app).patch(`/api/appointments/${appt.body.id}/confirm`).set(auth(doctor.token));

    const moved = await request(app).patch(`/api/appointments/${appt.body.id}/reschedule`).set(auth(a.token)).send({ scheduledAt: slots[8] });
    expect(moved.status).toBe(200);
    expect(moved.body.status).toBe("requested");
    expect(new Date(moved.body.scheduledAt).toISOString()).toBe(slots[8]);

    expect((await book(b, pb, slots[3])).status).toBe(201);
    expect((await book(b, pb, slots[8])).status).toBe(409);
  });

  it("cannot reschedule into a taken time, someone else's appointment, or a finished one", async () => {
    const doctor = await createDoctor();
    await publish(doctor);
    const a = await signupPatient();
    const b = await signupPatient();
    const { pairingId: pa } = await connect(a, doctor);
    const { pairingId: pb } = await connect(b, doctor);
    const slots = (await slotsFor(a, pa)).slots;
    const mine = await book(a, pa, slots[1]);
    const theirs = await book(b, pb, slots[2]);

    expect((await request(app).patch(`/api/appointments/${mine.body.id}/reschedule`).set(auth(a.token)).send({ scheduledAt: slots[2] })).status).toBe(409);
    expect((await request(app).patch(`/api/appointments/${theirs.body.id}/reschedule`).set(auth(a.token)).send({ scheduledAt: slots[9] })).status).toBe(404);

    await request(app).patch(`/api/appointments/${mine.body.id}/cancel`).set(auth(a.token));
    expect((await request(app).patch(`/api/appointments/${mine.body.id}/reschedule`).set(auth(a.token)).send({ scheduledAt: slots[9] })).status).toBe(409);
  });
});
