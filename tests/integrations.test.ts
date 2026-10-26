import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { getApp, createAdmin, signupPatient, auth } from "./helpers";
import { integrationRegistry } from "../server/services/integrations";

let app: Express;
beforeAll(async () => {
  app = await getApp();
});

const byId = (list: Awaited<ReturnType<typeof integrationRegistry>>) => Object.fromEntries(list.map((i) => [i.id, i]));

describe("the integration registry", () => {
  it("claims nothing for a deployment with no settings", async () => {
    const r = byId(await integrationRegistry({} as NodeJS.ProcessEnv));
    for (const id of ["email", "email_receipts", "scheduler", "heartbeat", "ops_alert"]) expect(r[id].status).toBe("not_configured");
    for (const id of ["video", "sms", "push", "pharmacy", "ehr", "credential_registry", "sso"]) expect(r[id].status).toBe("unavailable");
  });

  it("never calls something verified because a key is present", async () => {
    const r = byId(await integrationRegistry({ RESEND_API_KEY: "re_x", RESEND_WEBHOOK_SECRET: "whsec_x", CRON_SECRET: "c".repeat(30), SCHEDULER_HEARTBEAT_URL: "https://hc.example/x", OPS_ALERT_EMAIL: "ops@example.org" } as unknown as NodeJS.ProcessEnv));
    expect(r.heartbeat.status).toBe("configured_unverified"); // only a drill can prove an outside monitor alerts
    expect(r.ops_alert.status).toBe("configured_unverified");
    // These can be verified, but only by recorded evidence: the facts must agree with the status.
    expect(r.email.status === "verified").toBe(Number(r.email.facts.delivered) > 0 && r.email.status !== "failed");
    expect(r.email_receipts.status === "verified").toBe(Number(r.email_receipts.facts.eventsReceived) > 0);
    expect(r.scheduler.status === "verified").toBe(Number(r.scheduler.facts.daysWithDependableCaller) >= Number(r.scheduler.facts.daysRequired) && r.scheduler.status !== "failed");
  });

  it("is shown to administrators only, with no secret in it", async () => {
    const admin = await createAdmin();
    const patient = await signupPatient();
    expect((await request(app).get("/api/admin/integrations").set(auth(patient.token))).status).toBe(403);
    expect((await request(app).get("/api/admin/integrations")).status).toBe(401);
    const res = await request(app).get("/api/admin/integrations").set(auth(admin.token));
    expect(res.status).toBe(200);
    expect(res.body.integrations.length).toBeGreaterThanOrEqual(12);
    expect(res.body.emailLast7Days).toEqual(expect.objectContaining({ accepted: expect.any(Number), delivered: expect.any(Number), bounced: expect.any(Number) }));
    expect(JSON.stringify(res.body)).not.toMatch(/re_[A-Za-z0-9]|whsec_|postgres:\/\//);
  });
});
