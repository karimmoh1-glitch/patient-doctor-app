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
  delete process.env.DEMO_MODE;
});

describe("demo profiles and simulated controls", () => {
  it("hides doctors who can never answer, and refuses requests to them, outside demo mode", async () => {
    process.env.DEMO_MODE = "false";
    const patient = await signupPatient();
    const ghost = await storage.createDoctorProfile({
      userId: null, name: "Dr. Nobody", specialty: "Family Medicine", state: "CA", licenseNumber: null,
      npiNumber: null, phone: "+15550009999", bio: null, active: true, source: "seed",
    });
    const real = await createDoctor({ name: "Dr. Real" });

    const list = await request(app).get("/api/doctors");
    const names = list.body.map((d: any) => d.name);
    expect(names).toContain("Dr. Real");
    expect(names).not.toContain("Dr. Nobody");

    const attempt = await request(app).post("/api/pairings").set(auth(patient.token)).send({ doctorProfileId: ghost.id });
    expect(attempt.status).toBe(404);
    const ok = await request(app).post("/api/pairings").set(auth(patient.token)).send({ doctorProfileId: real.profileId });
    expect(ok.status).toBe(201);
  });

  it("lists and labels them inside demo mode", async () => {
    const list = await request(app).get("/api/doctors");
    const demo = list.body.filter((d: any) => d.isDemoProfile);
    expect(demo.length).toBeGreaterThan(0);
  });

  it("does not let a patient fake their own pharmacy delivery outside demo mode", async () => {
    process.env.DEMO_MODE = "false";
    const patient = await signupPatient();
    const res = await request(app).post("/api/pharmacy/orders/any-id/advance").set(auth(patient.token));
    expect(res.status).toBe(404);
    expect(res.body.message).toBe("Not found");
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

describe("pharmacy ordering", () => {
  it("is refused outright outside demo mode, because no real pharmacy is connected", async () => {
    process.env.DEMO_MODE = "false";
    const patient = await signupPatient();
    const res = await request(app).post("/api/pharmacy/orders").set(auth(patient.token)).send({ prescriptionId: "x", pharmacyId: "y", fulfillmentType: "pickup" });
    expect(res.status).toBe(501);
    expect(res.body.message).toMatch(/isn't available/);
  });
});

describe("demo sign-in", () => {
  it("exists only in demo mode and never grants a real deployment's accounts", async () => {
    process.env.DEMO_MODE = "false";
    const off = await request(app).post("/api/auth/demo-login").send({ role: "patient" });
    expect(off.status).toBe(404);
    delete process.env.DEMO_MODE;
    if (!(await storage.getUserByEmail("patient@avela.dev"))) {
      await storage.createUser({ name: "Demo Patient", email: "patient@avela.dev", passwordHash: "x", role: "patient", state: "CA", phone: null, deactivatedAt: null, emailVerifiedAt: null });
    }
    const on = await request(app).post("/api/auth/demo-login").send({ role: "patient" });
    expect(on.status).toBe(200);
    expect(on.body.user.email).toBe("patient@avela.dev");
    // Only the two named demo roles — never an arbitrary account.
    expect((await request(app).post("/api/auth/demo-login").send({ role: "admin" })).status).toBe(404);
  });
});

describe("/api/config", () => {
  it("reports only capabilities that are really configured", async () => {
    const res = await request(app).get("/api/config");
    expect(res.status).toBe(200);
    expect(res.body.features.videoVisits).toBe(false);
    expect(res.body.features.smsReminders).toBe(false);
    expect(res.body.features.liveSupportChat).toBe(false);
    // Voice is offered only as a labelled demo until a real speech provider exists.
    expect(res.body.features.voiceInput).toBe(true);
    expect(res.body.features.voiceInputIsDemo).toBe(true);
    process.env.DEMO_MODE = "false";
    const real = await request(app).get("/api/config");
    expect(real.body.features.voiceInput).toBe(false);
    expect(res.body.features.aiAssistant).toBe(false);
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
    expect(res.body).toEqual({ ok: true });
  });
});
