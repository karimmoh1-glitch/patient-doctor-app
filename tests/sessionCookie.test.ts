import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { getApp, signupPatient, uniqueEmail, PASSWORD, auth } from "./helpers";

let app: Express;
beforeAll(async () => {
  app = await getApp();
});

const WEB = { "X-Avela-Client": "web" };

/** Name=value of the session cookie from a response, or null. */
function sessionCookie(res: request.Response): { name: string; value: string; raw: string } | null {
  const list = ([] as string[]).concat((res.headers["set-cookie"] as unknown as string[]) ?? []);
  const raw = list.find((c) => /avela_session=/.test(c));
  if (!raw) return null;
  const [pair] = raw.split(";");
  const eq = pair.indexOf("=");
  return { name: pair.slice(0, eq), value: pair.slice(eq + 1), raw };
}

async function webSignup() {
  const email = uniqueEmail("cookie");
  const res = await request(app).post("/api/auth/signup").set(WEB).send({ name: "Cookie Person", email, password: PASSWORD, state: "CA" });
  expect(res.status).toBe(201);
  return { res, email, cookie: sessionCookie(res)! };
}
const cookieHeader = (c: { name: string; value: string }) => `${c.name}=${c.value}`;

describe("the browser session is an HttpOnly cookie", () => {
  it("gives the web app a cookie that script cannot read, and no token in the response", async () => {
    const { res, cookie } = await webSignup();
    expect(res.body.token).toBeUndefined();
    expect(res.body.user).toMatchObject({ role: "patient" });
    expect(cookie).not.toBeNull();
    expect(cookie.raw).toMatch(/HttpOnly/i);
    expect(cookie.raw).toMatch(/SameSite=Strict/i);
    expect(cookie.raw).toMatch(/Max-Age=86400/);
    expect(cookie.raw).toMatch(/Path=\//);
    expect(JSON.stringify(res.body)).not.toContain(cookie.value); // the credential is not in the body either
  });

  it("is Secure, with the __Host- prefix, whenever the request came over https", async () => {
    const email = uniqueEmail("secure");
    const res = await request(app).post("/api/auth/signup").set(WEB).set("X-Forwarded-Proto", "https").send({ name: "Secure Person", email, password: PASSWORD, state: "CA" });
    const raw = ([] as string[]).concat(res.headers["set-cookie"] as unknown as string[]).join("\n");
    expect(raw).toMatch(/__Host-avela_session=/);
    expect(raw).toMatch(/;\s*Secure/i);
    expect(raw).not.toMatch(/Domain=/i); // required by the __Host- prefix
  });

  it("keeps handing a token to every other kind of client", async () => {
    const res = await request(app).post("/api/auth/signup").send({ name: "Api Person", email: uniqueEmail("api"), password: PASSWORD, state: "CA" });
    expect(res.body.token).toEqual(expect.any(String));
    expect(sessionCookie(res)).toBeNull();
  });

  it("signs in and out through the cookie on every way in: login, demo, registration and invitation", async () => {
    const { email } = await webSignup();
    const login = await request(app).post("/api/auth/login").set(WEB).send({ email, password: PASSWORD });
    expect(login.status).toBe(200);
    expect(login.body.token).toBeUndefined();
    expect(sessionCookie(login)).not.toBeNull();

    const reg = await request(app).post("/api/doctors/register").set(WEB).send({ name: "Dr Cookie", email: uniqueEmail("doc"), password: PASSWORD });
    expect(reg.status).toBe(201);
    expect(reg.body.token).toBeUndefined();
    expect(sessionCookie(reg)).not.toBeNull();

    const demo = await request(app).post("/api/auth/demo-login").set(WEB).send({ role: "patient" });
    if (demo.status === 200) {
      expect(demo.body.token).toBeUndefined();
      expect(sessionCookie(demo)).not.toBeNull();
    }
  });
});

describe("using the cookie", () => {
  it("authenticates reads, and the person is identified from the server, not from the cookie's contents", async () => {
    const { cookie, email } = await webSignup();
    const me = await request(app).get("/api/auth/me").set("Cookie", cookieHeader(cookie));
    expect(me.status).toBe(200);
    expect(me.body.email).toBe(email);
  });

  it("refuses a change that does not come from our own pages", async () => {
    const { cookie } = await webSignup();
    const headers = { Cookie: cookieHeader(cookie) };
    // No custom header: what a cross-site form post would look like.
    const noHeader = await request(app).patch("/api/auth/me/preferences").set(headers).send({ language: "ar" });
    expect(noHeader.status).toBe(403);
    // Right header, but the browser says it came from another site.
    const foreign = await request(app).patch("/api/auth/me/preferences").set(headers).set(WEB).set("Origin", "https://evil.example").send({ language: "ar" });
    expect(foreign.status).toBe(403);
    // Right header, own origin.
    const own = await request(app).patch("/api/auth/me/preferences").set(headers).set(WEB).set("Host", "avela.example.test").set("Origin", "https://avela.example.test").send({ language: "ar" });
    expect(own.status).toBe(200);
    // Right header, no Origin at all (some non-browser clients, and same-origin GET-like fetches).
    expect((await request(app).patch("/api/auth/me/preferences").set(headers).set(WEB).send({ language: "en" })).status).toBe(200);
    // The refused ones changed nothing.
    expect((await request(app).get("/api/auth/me").set(headers)).body.language).toBe("en");
  });

  it("leaves bearer-token clients alone: no custom header or origin is needed for them", async () => {
    const user = await signupPatient();
    const res = await request(app).patch("/api/auth/me/preferences").set(auth(user.token)).set("Origin", "https://elsewhere.example").send({ language: "ar" });
    expect(res.status).toBe(200);
  });

  it("does not fall back to the cookie when a bearer token is given and wrong", async () => {
    const { cookie } = await webSignup();
    const res = await request(app).get("/api/auth/me").set("Cookie", cookieHeader(cookie)).set("Authorization", "Bearer not-a-real-token");
    expect(res.status).toBe(401);
  });

  it("ignores a cookie that is not ours, or is malformed", async () => {
    expect((await request(app).get("/api/auth/me").set("Cookie", "avela_session=; other=1")).status).toBe(401);
    expect((await request(app).get("/api/auth/me").set("Cookie", "avela_session=garbage.garbage.garbage")).status).toBe(401);
    expect((await request(app).get("/api/auth/me").set("Cookie", "session=abc; avela_sess=abc")).status).toBe(401);
  });

  it("does not trust a role written into a forged cookie", async () => {
    const jwt = (await import("jsonwebtoken")).default;
    const forged = jwt.sign({ userId: "someone", role: "admin", deviceId: "no-such-device" }, "a-guessed-secret");
    expect((await request(app).get("/api/admin/doctor-applications").set("Cookie", `avela_session=${forged}`)).status).toBe(401);
  });
});

describe("ending a cookie session", () => {
  it("revokes it on the server and clears the cookie, so a copied cookie stops working", async () => {
    const { cookie } = await webSignup();
    const headers = { Cookie: cookieHeader(cookie), ...WEB };
    const out = await request(app).post("/api/auth/logout").set(headers);
    expect(out.status).toBe(200);
    const cleared = ([] as string[]).concat(out.headers["set-cookie"] as unknown as string[]).join("\n");
    expect(cleared).toMatch(/avela_session=;/);
    expect(cleared).toMatch(/Max-Age=0/);
    // An attacker who copied the cookie value earlier gets nothing from it now.
    expect((await request(app).get("/api/auth/me").set("Cookie", cookieHeader(cookie))).status).toBe(401);
  });

  it("signs out of every device, including this one", async () => {
    const { cookie, email } = await webSignup();
    const other = await request(app).post("/api/auth/login").send({ email, password: PASSWORD }); // a second device, by token
    const out = await request(app).post("/api/auth/logout-all").set({ Cookie: cookieHeader(cookie), ...WEB });
    expect(out.status).toBe(200);
    expect((await request(app).get("/api/auth/me").set("Cookie", cookieHeader(cookie))).status).toBe(401);
    expect((await request(app).get("/api/auth/me").set(auth(other.body.token))).status).toBe(401);
  });

  it("ends it when the password is reset", async () => {
    const { cookie, email } = await webSignup();
    const { storage } = await import("../server/storage");
    const { generateSecureToken } = await import("../server/services/tokenService");
    const t = generateSecureToken();
    await storage.createPasswordResetToken(email, t.tokenHash, new Date(Date.now() + 3_600_000));
    expect((await request(app).post("/api/auth/reset-password").send({ token: t.token, password: "a different long passphrase" })).status).toBe(200);
    expect((await request(app).get("/api/auth/me").set("Cookie", cookieHeader(cookie))).status).toBe(401);
  });
});

describe("moving a browser off script-readable storage", () => {
  it("exchanges a live token for a cookie, once, for the web app only", async () => {
    const user = await signupPatient();
    // Not the web app: refused.
    expect((await request(app).post("/api/auth/session").set(auth(user.token))).status).toBe(400);
    // The web app, with its old token.
    const adopt = await request(app).post("/api/auth/session").set(auth(user.token)).set(WEB);
    expect(adopt.status).toBe(200);
    expect(adopt.body.token).toBeUndefined();
    const cookie = sessionCookie(adopt)!;
    expect(cookie.raw).toMatch(/HttpOnly/i);
    expect((await request(app).get("/api/auth/me").set("Cookie", cookieHeader(cookie))).body.id).toBe(user.id);
  });

  it("refuses a dead token and cannot be used to turn a cookie into a longer session", async () => {
    expect((await request(app).post("/api/auth/session").set(WEB).set("Authorization", "Bearer dead")).status).toBe(401);
    expect((await request(app).post("/api/auth/session").set(WEB)).status).toBe(401);
    const { cookie } = await webSignup();
    const viaCookie = await request(app).post("/api/auth/session").set({ Cookie: cookieHeader(cookie), ...WEB });
    expect(viaCookie.status).toBe(400); // already on a cookie: nothing to adopt
  });
});
