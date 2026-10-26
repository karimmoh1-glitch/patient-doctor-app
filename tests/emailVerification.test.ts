import { describe, it, expect, vi, beforeAll, afterEach } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { eq } from "drizzle-orm";

const provider = vi.hoisted(() => ({ sent: [] as { to: string[]; text: string }[] }));
vi.mock("resend", () => ({
  Resend: class {
    emails = { send: async (m: any) => { provider.sent.push(m); return { data: { id: `msg_${Math.random().toString(36).slice(2)}` }, error: null }; } };
  },
}));

import { getApp, signupPatient, auth } from "./helpers";
import { db } from "../server/db";
import { runAsSystem } from "../server/dbContext";
import { emailVerificationTokens, users } from "@shared/schema";

let app: Express;
beforeAll(async () => {
  app = await getApp();
});
afterEach(() => {
  delete process.env.RESEND_API_KEY;
  provider.sent.length = 0;
});
const tokenFrom = (to: string) => {
  const m = provider.sent.filter((s) => s.to.includes(to)).at(-1)?.text.match(/verify-email#([A-Za-z0-9_-]+)/);
  return m?.[1];
};

describe("confirming an e-mail address", () => {
  it("sends a single-use link to the address, and confirms it only for the holder of that link", async () => {
    process.env.RESEND_API_KEY = "re_test";
    const p = await signupPatient();
    expect((await request(app).get("/api/auth/me").set(auth(p.token))).body.emailVerified).toBe(false);
    expect((await request(app).post("/api/auth/email/verify/request")).status).toBe(401);
    const asked = await request(app).post("/api/auth/email/verify/request").set(auth(p.token));
    expect(asked.body).toEqual({ verified: false, sent: true });
    const token = tokenFrom(p.email)!;
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    // The stored value is a hash of it, not the token.
    const rows = await runAsSystem(() => db.select().from(emailVerificationTokens).where(eq(emailVerificationTokens.userId, p.id)));
    expect(JSON.stringify(rows)).not.toContain(token);

    const ok = await request(app).post("/api/auth/email/verify").send({ token });
    expect(ok.status).toBe(200);
    expect((await request(app).get("/api/auth/me").set(auth(p.token))).body.emailVerified).toBe(true);
    expect((await request(app).post("/api/auth/email/verify").send({ token })).status).toBe(404); // single use
    expect((await request(app).post("/api/auth/email/verify/request").set(auth(p.token))).body).toEqual({ verified: true, sent: false });
  });

  it("answers an expired, a used and an invented link identically", async () => {
    process.env.RESEND_API_KEY = "re_test";
    const p = await signupPatient();
    await request(app).post("/api/auth/email/verify/request").set(auth(p.token));
    const token = tokenFrom(p.email)!;
    await runAsSystem(() => db.update(emailVerificationTokens).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(emailVerificationTokens.userId, p.id)));
    const results = await Promise.all([token, "f".repeat(64), "short"].map((t) => request(app).post("/api/auth/email/verify").send({ token: t })));
    expect(results.map((r) => r.status)).toEqual([404, 404, 404]);
    expect(new Set(results.map((r) => JSON.stringify(r.body))).size).toBe(1);
    const [row] = await runAsSystem(() => db.select({ at: users.emailVerifiedAt }).from(users).where(eq(users.id, p.id)));
    expect(row.at).toBeNull();
  });
});
