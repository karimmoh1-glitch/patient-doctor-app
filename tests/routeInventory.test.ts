import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { getApp } from "./helpers";
import { ROUTER_MOUNTS, RAW_BODY_MOUNTS } from "../server/routes";

let app: Express;
beforeAll(async () => {
  app = await getApp();
});

interface Endpoint { method: string; path: string }

function endpoints(): Endpoint[] {
  const out: Endpoint[] = [];
  for (const [prefix, router] of [...ROUTER_MOUNTS, ...RAW_BODY_MOUNTS]) {
    for (const layer of (router as any).stack) {
      if (!layer.route) continue;
      const methods = Object.keys(layer.route.methods).filter((m) => layer.route.methods[m]);
      for (const method of methods) out.push({ method: method.toUpperCase(), path: (prefix + (layer.route.path === "/" ? "" : layer.route.path)).replace(/:[A-Za-z]+/g, "x") });
    }
  }
  return out;
}

// The ONLY endpoints that answer someone who is not signed in. Anything added
// to this list is a deliberate decision that the endpoint is safe to expose.
// Everything else must refuse an anonymous caller with 401.
const PUBLIC: Record<string, string> = {
  "GET /api/config": "capabilities only, no personal data",
  "GET /api/doctors": "public directory: names, specialties, languages, never a phone number",
  "POST /api/doctors/register": "creates an account with no clinical access",
  "POST /api/auth/signup": "creates a patient account",
  "POST /api/auth/login": "sign-in",
  "POST /api/auth/forgot-password": "always the same answer",
  "POST /api/auth/reset-password": "single-use emailed token",
  "GET /api/care-circle/invitations/validate/x": "single-use emailed token",
  "POST /api/care-circle/invitations/accept/x": "single-use emailed token",
  "POST /api/auth/email/verify": "single-use e-mailed token; the same answer for any bad link",
  "POST /api/orgs/invitations/preview": "e-mail-bound single-use token; a stranger learns nothing",
  "POST /api/orgs/invitations/accept-new": "e-mail-bound single-use token; creates a staff account that still needs a second factor",
  "POST /api/webhooks/resend": "refused without a valid provider signature",
  "GET /api/cron/reminders": "bearer secret",
  "POST /api/cron/reminders": "bearer secret",
};

describe("every endpoint the server exposes", () => {
  const all = endpoints();

  it("is discovered (the inventory is not silently empty)", () => {
    expect(all.length).toBeGreaterThan(100);
  });

  it("refuses an anonymous caller, except the short list of public ones", async () => {
    const leaks: string[] = [];
    for (const { method, path } of all) {
      if (`${method} ${path}` in PUBLIC) continue;
      const res = await (request(app) as any)[method.toLowerCase()](path).send({});
      if (res.status !== 401) leaks.push(`${method} ${path} -> ${res.status}`);
    }
    expect(leaks).toEqual([]);
  });

  it("has no public entry that no longer exists (the list can't rot)", () => {
    const known = new Set(all.map((e) => `${e.method} ${e.path}`));
    for (const key of Object.keys(PUBLIC)) expect(known.has(key), key).toBe(true);
  });

  it("never lets the garbage token a stranger might send through", async () => {
    const leaks: string[] = [];
    for (const { method, path } of all) {
      if (`${method} ${path}` in PUBLIC) continue;
      const res = await (request(app) as any)[method.toLowerCase()](path).set("Authorization", "Bearer not.a.token").send({});
      if (res.status !== 401) leaks.push(`${method} ${path} -> ${res.status}`);
    }
    expect(leaks).toEqual([]);
  });
});

describe("things that were removed because they were not real", () => {
  const removed: [string, string][] = [
    ["POST", "/api/auth/demo-login"], // one-tap demo sign-in
    ["GET", "/api/pharmacy/pharmacies"], ["POST", "/api/pharmacy/orders"], ["POST", "/api/pharmacy/orders/x/advance"], // simulated pharmacy
    ["POST", "/api/health-summary/share"], // "shared" nothing with nobody
    ["POST", "/api/ai/chat"], ["POST", "/api/ai/explain-simply"], ["GET", "/api/ai/messages"], // keyword responder shown as an assistant
    ["POST", "/api/speech/transcribe"], // voice input with no provider
  ];
  it("do not exist at all: not for a stranger, not for a signed-in patient", async () => {
    const { signupPatient, auth } = await import("./helpers");
    const patient = await signupPatient();
    for (const [method, path] of removed) {
      const anon = await (request(app) as any)[method.toLowerCase()](path).send({});
      expect(anon.status, `${method} ${path} (anonymous)`).not.toBe(200);
      const authed = await (request(app) as any)[method.toLowerCase()](path).set(auth(patient.token)).send({});
      expect([401, 404], `${method} ${path} (patient)`).toContain(authed.status);
      expect(authed.status, `${method} ${path} must not be handled`).not.toBe(200);
    }
  });
});
