import { describe, it, expect, afterEach } from "vitest";
import express from "express";
import request from "supertest";
import { registerRoutes } from "../server/routes";

// A pilot can switch the organization-staff module off without touching anything else.
const build = async () => {
  const app = express();
  app.use(express.json());
  await registerRoutes(null as any, app);
  return app;
};
const before = process.env.ORGANIZATIONS_DISABLED;
afterEach(() => {
  if (before === undefined) delete process.env.ORGANIZATIONS_DISABLED;
  else process.env.ORGANIZATIONS_DISABLED = before;
});

describe("ORGANIZATIONS_DISABLED", () => {
  it("leaves the module mounted by default: its routes ask for a sign-in", async () => {
    delete process.env.ORGANIZATIONS_DISABLED;
    const app = await build();
    expect((await request(app).get("/api/orgs")).status).toBe(401);
  });

  it("answers 'not available' for every organization route, signed in or not, and leaves the patient's own list and everything else alone", async () => {
    process.env.ORGANIZATIONS_DISABLED = "true";
    const app = await build();
    for (const [m, p] of [["get", "/api/orgs"], ["post", "/api/orgs"], ["get", "/api/orgs/x/staff"], ["post", "/api/orgs/invitations/accept-new"], ["delete", "/api/orgs/x/membership"]] as const) {
      const r = await (request(app) as any)[m](p).send({});
      expect(r.status, `${m} ${p}`).toBe(404);
      expect(r.body.message).toMatch(/aren't available/);
    }
    expect((await request(app).get("/api/my-organizations")).status).toBe(401); // still mounted: the patient's own privacy list
    expect((await request(app).get("/api/config")).body.features.organizations).toBe(false);
  });

  it("is reported to the interface as a feature flag", async () => {
    delete process.env.ORGANIZATIONS_DISABLED;
    expect((await request(await build()).get("/api/config")).body.features.organizations).toBe(true);
  });
});
