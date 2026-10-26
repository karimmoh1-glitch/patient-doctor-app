import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { getApp, signupPatient, auth } from "./helpers";
import { pool } from "../server/db";

let app: Express;
beforeAll(async () => {
  app = await getApp();
});
afterEach(() => vi.restoreAllMocks());

describe("health checks tell a monitor what is actually wrong", () => {
  it("liveness answers without the database; readiness reports the database separately", async () => {
    const live = await request(app).get("/api/health");
    expect(live.status).toBe(200);
    const ready = await request(app).get("/api/health/ready");
    expect(ready.status).toBe(200);
    expect(ready.body).toEqual({ ok: true, database: "up" });
  });

  it("readiness is 503 when the database cannot be reached, and leaks nothing about why", async () => {
    vi.spyOn(pool, "query").mockRejectedValue(new Error('password authentication failed for user "avela_runtime" at ep-secret-host.neon.tech'));
    const res = await request(app).get("/api/health/ready");
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ ok: false, database: "down" });
    expect(JSON.stringify(res.body) + JSON.stringify(res.headers)).not.toMatch(/avela_runtime|neon|password/i);
    // liveness is unaffected by a database outage: the process is up, which is a different fact
    expect((await request(app).get("/api/health")).status).toBe(200);
  });
});

describe("nothing under /api is cached by a browser, proxy or CDN", () => {
  it("sends no-store on public, signed-in, refused and unknown API responses alike", async () => {
    const patient = await signupPatient();
    for (const res of [
      await request(app).get("/api/health"),
      await request(app).get("/api/config"),
      await request(app).get("/api/me"),
      await request(app).get("/api/me").set(auth(patient.token)),
      await request(app).get("/api/no-such-endpoint"),
    ]) {
      expect(res.headers["cache-control"]).toMatch(/no-store/);
    }
  });
});
