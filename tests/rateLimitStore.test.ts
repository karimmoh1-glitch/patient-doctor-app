import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import express from "express";
import request from "supertest";
import crypto from "crypto";
import { getApp } from "./helpers";
import { pool } from "../server/db";
import { PgRateLimitStore } from "../server/middleware/pgRateLimitStore";
import { makeLimiter, useSharedStore } from "../server/middleware/rateLimit";

beforeAll(async () => {
  await getApp(); // makes sure the test database is ready
  process.env.TEST_RATE_LIMITS = "on"; // limiters are skipped in the suite unless a test asks for them
});
afterAll(() => {
  delete process.env.TEST_RATE_LIMITS;
});
afterEach(() => vi.restoreAllMocks());

const name = () => `test-${crypto.randomUUID()}`;
const opts = (windowMs: number, limit = 1000) => ({ windowMs, limit }) as any;

/** An app whose only route is limited by the given store, to stand in for one server instance. */
function instance(store: PgRateLimitStore, limit: number) {
  const app = express();
  app.set("trust proxy", true);
  app.get("/x", makeLimiter({ windowMs: 60_000, limit, message: "slow down", store }), (_req, res) => res.json({ ok: true }));
  return app;
}

describe("the shared rate-limit store", () => {
  it("counts every hit exactly once, even when they arrive at the same moment", async () => {
    const store = new PgRateLimitStore(name());
    store.init(opts(60_000));
    const results = await Promise.all(Array.from({ length: 25 }, () => store.increment("203.0.113.9")));
    expect(Math.max(...results.map((r) => r.totalHits))).toBe(25);
    expect(new Set(results.map((r) => r.totalHits)).size).toBe(25); // no two callers saw the same count
  });

  it("starts a new window once the old one has ended", async () => {
    const store = new PgRateLimitStore(name());
    store.init(opts(300));
    expect((await store.increment("k")).totalHits).toBe(1);
    expect((await store.increment("k")).totalHits).toBe(2);
    await new Promise((r) => setTimeout(r, 450));
    expect((await store.increment("k")).totalHits).toBe(1);
  });

  it("keeps limiters and keys apart", async () => {
    const a = new PgRateLimitStore(name());
    const b = new PgRateLimitStore(name());
    a.init(opts(60_000));
    b.init(opts(60_000));
    await a.increment("same");
    await a.increment("same");
    expect((await b.increment("same")).totalHits).toBe(1);
    expect((await a.increment("other")).totalHits).toBe(1);
  });

  it("supports giving a hit back (successful sign-ins are not counted) and resetting a key", async () => {
    const store = new PgRateLimitStore(name());
    store.init(opts(60_000));
    await store.increment("k");
    await store.increment("k");
    await store.decrement("k");
    expect((await store.increment("k")).totalHits).toBe(2);
    await store.resetKey("k");
    expect((await store.increment("k")).totalHits).toBe(1);
  });

  it("stores no address or e-mail, only a hash", async () => {
    const store = new PgRateLimitStore(name());
    store.init(opts(60_000));
    await store.increment("acct:jane.doe@example.com");
    await store.increment("ip:198.51.100.77");
    const { rows } = await pool.query("SELECT key FROM rate_limit_hits");
    expect(rows.length).toBeGreaterThanOrEqual(2);
    for (const r of rows) expect(r.key).toMatch(/^[0-9a-f]{64}$/);
  });

  it("enforces one limit across separate server instances", async () => {
    // Two instances (as two warm serverless functions) share the limiter's name, so they share its counters.
    const shared = name();
    const one = instance(new PgRateLimitStore(shared), 5);
    const two = instance(new PgRateLimitStore(shared), 5);
    const statuses: number[] = [];
    for (let i = 0; i < 8; i++) statuses.push((await request(i % 2 ? one : two).get("/x").set("X-Forwarded-For", "203.0.113.50")).status);
    expect(statuses.filter((s) => s === 200)).toHaveLength(5); // not 10, which per-instance memory would allow
    expect(statuses.filter((s) => s === 429)).toHaveLength(3);
  });

  it("keeps limiting, from this instance's memory, if the database cannot be reached", async () => {
    const store = new PgRateLimitStore(name());
    store.init(opts(60_000));
    vi.spyOn(pool, "query").mockRejectedValue(Object.assign(new Error("connection terminated"), { code: "ECONNRESET" }));
    vi.spyOn(console, "error").mockImplementation(() => {});
    const app = instance(store, 3);
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) statuses.push((await request(app).get("/x").set("X-Forwarded-For", "203.0.113.60")).status);
    expect(statuses).toEqual([200, 200, 200, 429, 429]);
  });

  it("logs a failed store only as a kind, and only once a minute", async () => {
    const store = new PgRateLimitStore(name());
    store.init(opts(60_000));
    vi.spyOn(pool, "query").mockRejectedValue(Object.assign(new Error("password authentication failed for user secretuser@host"), { code: "28P01" }));
    const logged: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void logged.push(a.map(String).join(" ")));
    for (let i = 0; i < 5; i++) await store.increment("k");
    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain("28P01");
    expect(logged[0]).not.toMatch(/secretuser|password/);
  });

  it("is what production uses, and memory is what development and tests use", () => {
    const env = process.env;
    const saved = { NODE_ENV: env.NODE_ENV, RATE_LIMIT_STORE: env.RATE_LIMIT_STORE };
    try {
      delete env.RATE_LIMIT_STORE;
      expect(useSharedStore()).toBe(false); // NODE_ENV=test
      (env as any).NODE_ENV = "development";
      expect(useSharedStore()).toBe(false);
      (env as any).NODE_ENV = "production";
      expect(useSharedStore()).toBe(true);
      env.RATE_LIMIT_STORE = "memory";
      expect(useSharedStore()).toBe(false);
      (env as any).NODE_ENV = "test";
      env.RATE_LIMIT_STORE = "postgres";
      expect(useSharedStore()).toBe(true);
    } finally {
      (env as any).NODE_ENV = saved.NODE_ENV;
      if (saved.RATE_LIMIT_STORE === undefined) delete env.RATE_LIMIT_STORE;
      else env.RATE_LIMIT_STORE = saved.RATE_LIMIT_STORE;
    }
  });
});
