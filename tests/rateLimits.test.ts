import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { getApp, signupPatient, uniqueEmail, PASSWORD } from "./helpers";

let app: Express;
beforeAll(async () => {
  app = await getApp();
  process.env.TEST_RATE_LIMITS = "on";
});
afterAll(() => {
  delete process.env.TEST_RATE_LIMITS;
});

describe("login throttling", () => {
  it("locks one account after repeated wrong passwords, even for the right password, without affecting others", async () => {
    const victim = await signupPatient();
    const bystander = await signupPatient();

    let last = 0;
    for (let i = 0; i < 10; i++) {
      last = (await request(app).post("/api/auth/login").send({ email: victim.email, password: `wrong-guess-${i}` })).status;
    }
    expect(last).toBe(401);

    const locked = await request(app).post("/api/auth/login").send({ email: victim.email, password: PASSWORD });
    expect(locked.status).toBe(429);
    expect(locked.body.token).toBeUndefined();

    // A different account from the same address still works.
    const ok = await request(app).post("/api/auth/login").send({ email: bystander.email, password: PASSWORD });
    expect(ok.status).toBe(200);
  });

  it("does not count successful sign-ins against the account", async () => {
    const user = await signupPatient();
    for (let i = 0; i < 12; i++) {
      expect((await request(app).post("/api/auth/login").send({ email: user.email, password: PASSWORD })).status).toBe(200);
    }
  });

  it("treats email case differences as the same account when counting", async () => {
    const email = uniqueEmail("CaseUser");
    await request(app).post("/api/auth/signup").send({ name: "Case", email, password: PASSWORD, state: "CA" });
    for (let i = 0; i < 5; i++) await request(app).post("/api/auth/login").send({ email: email.toUpperCase(), password: "nope-nope-1" });
    for (let i = 0; i < 5; i++) await request(app).post("/api/auth/login").send({ email: email.toLowerCase(), password: "nope-nope-1" });
    const res = await request(app).post("/api/auth/login").send({ email, password: PASSWORD });
    expect(res.status).toBe(429);
  });
});

describe("email handling", () => {
  it("treats Jane@x.com and jane@x.com as one account", async () => {
    const base = uniqueEmail("Mixed");
    const first = await request(app).post("/api/auth/signup").send({ name: "A", email: base.toUpperCase(), password: PASSWORD, state: "CA" });
    expect(first.status).toBe(201);
    const second = await request(app).post("/api/auth/signup").send({ name: "B", email: base.toLowerCase(), password: PASSWORD, state: "CA" });
    expect(second.status).toBe(409);
    const login = await request(app).post("/api/auth/login").send({ email: base, password: PASSWORD });
    expect(login.status).toBe(200);
  });
});
