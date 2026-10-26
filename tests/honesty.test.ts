import { describe, it, expect, beforeAll, afterEach } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { getApp, signupPatient, createDoctor, auth } from "./helpers";
import { storage } from "../server/storage";
import { formatRequestLog, describeErrorForLog } from "../server/app";
import { escapeHtml } from "../server/services/emailService";

let app: Express;
beforeAll(async () => {
  app = await getApp();
});
afterEach(() => {
});

describe("demo profiles and simulated controls", () => {
  it("hides doctors who can never answer, and refuses requests to them, outside demo mode", async () => {
    const patient = await signupPatient();
    const ghost = await storage.createDoctorProfile({
      userId: null, name: "Dr. Nobody", specialty: "Family Medicine", state: "CA", licenseNumber: null,
      npiNumber: null, phone: "+15550009999", bio: null, active: true, source: "seed",
    });
    const real = await createDoctor({ name: "Dr. Real" });

    const list = await request(app).get("/api/doctors?q=Dr.%20Real");
    const names = list.body.map((d: any) => d.name);
    expect(names).toContain("Dr. Real");
    expect((await request(app).get("/api/doctors?q=Nobody")).body.map((d: any) => d.name)).not.toContain("Dr. Nobody");

    const attempt = await request(app).post("/api/pairings").set(auth(patient.token)).send({ doctorProfileId: ghost.id });
    expect(attempt.status).toBe(404);
    const ok = await request(app).post("/api/pairings").set(auth(patient.token)).send({ doctorProfileId: real.profileId });
    expect(ok.status).toBe(201);
  });

  it("are never listed in any environment, and the directory carries no 'demo profile' notion at all", async () => {
    const list = await request(app).get("/api/doctors?q=Nobody");
    expect(list.status).toBe(200);
    expect(list.body.map((d: any) => d.name)).not.toContain("Dr. Nobody");
    for (const d of list.body) expect(d).not.toHaveProperty("isDemoProfile");
  });
});

describe("video visits", () => {
  it("say plainly that video isn't available and what to do instead, and are never offered to non-participants", async () => {
    const { createDoctor, connect } = await import("./helpers");
    const patient = await signupPatient();
    const stranger = await signupPatient();
    const doctor = await createDoctor();
    const { pairingId } = await connect(patient, doctor);
    const appt = await storage.createAppointment({
      pairingRequestId: pairingId, patientUserId: patient.id, doctorProfileId: doctor.profileId, type: "Video Visit",
      reason: "Check-in", scheduledAt: new Date(Date.now() + 86400000), durationMinutes: 30, questionsForDoctor: [],
    });

    // Not confirmed yet: no video of any kind.
    expect((await request(app).get(`/api/appointments/${appt.id}/video`).set(auth(patient.token))).status).toBe(409);

    await request(app).patch(`/api/appointments/${appt.id}/confirm`).set(auth(doctor.token));
    for (const who of [patient, doctor]) {
      const res = await request(app).get(`/api/appointments/${appt.id}/video`).set(auth(who.token));
      expect(res.status).toBe(200);
      expect(res.body.available).toBe(false);
      expect(res.body.joinUrl).toBeUndefined();
      expect(res.body.message).toMatch(/isn't set up/);
    }
    expect((await request(app).get(`/api/appointments/${appt.id}/video`).set(auth(stranger.token))).status).toBe(404);
  });

  it("refuses to pretend a misconfigured provider works", async () => {
    process.env.VIDEO_PROVIDER = "no-such-provider";
    try {
      const res = await request(app).get("/api/config");
      expect(res.body.features.videoVisits).toBe(false);
    } finally {
      delete process.env.VIDEO_PROVIDER;
    }
  });
});

describe("/api/config", () => {
  it("reports only capabilities that are really configured, and has no demo notion", async () => {
    const res = await request(app).get("/api/config");
    expect(res.status).toBe(200);
    expect(res.body).not.toHaveProperty("demoMode");
    expect(res.body.features.videoVisits).toBe(false);
    expect(res.body.features.smsReminders).toBe(false);
    expect(res.body.features.liveSupportChat).toBe(false);
    expect(res.body.features.email).toBe(false);
    for (const gone of ["voiceInput", "voiceInputIsDemo", "aiAssistant"]) expect(res.body.features, gone).not.toHaveProperty(gone);
    expect(res.body.support.phone).toBeNull();
  });
});

describe("logging never carries personal or secret data", () => {
  it("request log lines contain only method, path, status and timing", () => {
    expect(formatRequestLog("POST", "/api/auth/login", 200, 12)).toBe("POST /api/auth/login 200 in 12ms");
  });

  it("database error logs drop the message, which can embed query parameters", () => {
    const err = Object.assign(new Error('Failed query: insert ... params: ["I have chest pain","jane@example.com"]'), { code: "23505" });
    const out = describeErrorForLog(err);
    expect(out).not.toContain("chest pain");
    expect(out).not.toContain("jane@example.com");
    expect(out).toContain("23505");
  });
});

describe("email safety", () => {
  it("escapes markup in names so it can't become a link in an email", () => {
    expect(escapeHtml('<a href="https://evil.example">click</a> & "x"')).toBe("&lt;a href=&quot;https://evil.example&quot;&gt;click&lt;/a&gt; &amp; &quot;x&quot;");
  });
});

describe("health check", () => {
  it("answers without authentication or database access", async () => {
    const res = await request(app).get("/api/health");
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(Object.keys(res.body).sort()).toEqual(["builtAt", "commit", "ok"]); // build identity only: nothing about data
  });
});

describe("booking a video visit", () => {
  it("is refused while no video provider exists, so nobody books a call that can't happen", async () => {
    const patient = await signupPatient();
    const doctor = await createDoctor();
    const { connect: _unused } = await import("./helpers");
    const { pairingId } = await _unused(patient, doctor);
    const res = await request(app)
      .post("/api/appointments")
      .set(auth(patient.token))
      .send({ pairingRequestId: pairingId, type: "Video Visit", reason: "Check-in", scheduledAt: new Date(Date.now() + 3 * 86400000).toISOString() });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/aren't available/);
  });
});

describe("the emergency number", () => {
  it("has no default: it is exactly what the operator configured, and null until then", async () => {
    delete process.env.EMERGENCY_NUMBER;
    delete process.env.VITE_EMERGENCY_NUMBER;
    expect((await request(app).get("/api/config")).body.emergencyNumber).toBeNull();
    process.env.EMERGENCY_NUMBER = "112";
    try {
      expect((await request(app).get("/api/config")).body.emergencyNumber).toBe("112");
      process.env.EMERGENCY_NUMBER = "<script>alert(1)</script>";
      expect((await request(app).get("/api/config")).body.emergencyNumber).toBeNull(); // only a plausible number is ever served
    } finally {
      delete process.env.EMERGENCY_NUMBER;
    }
  });
});
