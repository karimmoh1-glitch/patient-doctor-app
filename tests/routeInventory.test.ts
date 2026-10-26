import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { getApp } from "./helpers";
import { ROUTER_MOUNTS } from "../server/routes";

let app: Express;
beforeAll(async () => {
  app = await getApp();
});

interface Endpoint { method: string; path: string }

function endpoints(): Endpoint[] {
  const out: Endpoint[] = [];
  for (const [prefix, router] of ROUTER_MOUNTS) {
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
  "POST /api/auth/demo-login": "404 unless demo mode",
  "POST /api/auth/forgot-password": "always the same answer",
  "POST /api/auth/reset-password": "single-use emailed token",
  "GET /api/care-circle/invitations/validate/x": "single-use emailed token",
  "POST /api/care-circle/invitations/accept/x": "single-use emailed token",
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
