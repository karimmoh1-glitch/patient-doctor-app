import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { getApp } from "./helpers";
import { EMERGENCY, SUPPORTED_COUNTRIES } from "../shared/emergency";
import { emergencyDataReviewed, publicEmergency } from "../server/services/emergencyInfo";
import { en } from "../client/src/locales/en";
import { ar } from "../client/src/locales/ar";

let app: Express;
beforeAll(async () => {
  app = await getApp();
});

describe("emergency information", () => {
  it("covers exactly Egypt and the United States, each with sources, a check date and notes about what was not confirmed", () => {
    expect(SUPPORTED_COUNTRIES.sort()).toEqual(["EG", "US"]);
    for (const code of SUPPORTED_COUNTRIES) {
      const c = EMERGENCY[code];
      expect(c.services.length).toBeGreaterThan(0);
      expect(c.sources.length).toBeGreaterThan(0);
      for (const s of c.sources) {
        expect(s.url).toMatch(/^https:\/\//);
        expect(s.checkedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      }
      for (const n of c.services) expect(n.number).toMatch(/^\d{2,4}$/);
      expect(c.services.some((s) => s.kind === c.primary)).toBe(true);
    }
  });

  it("holds only numbers that have a source: nothing the research could not confirm", () => {
    expect(EMERGENCY.US.services.map((s) => s.number)).toEqual(["911"]);
    expect(EMERGENCY.EG.services.map((s) => `${s.kind}:${s.number}`).sort()).toEqual(["ambulance:123", "fire:180", "police:122"]);
    const all = JSON.stringify(EMERGENCY.EG.services);
    for (const unconfirmed of ["112", "126", "125", "128"]) expect(all).not.toContain(unconfirmed);
  });

  it("is honest that the Egyptian numbers rest on a United States government compilation", () => {
    expect(EMERGENCY.EG.sources.every((s) => s.official === "government_compilation")).toBe(true);
    expect(EMERGENCY.EG.reviewedBy).toBeNull();
    expect(EMERGENCY.US.reviewedBy).toBeNull();
  });

  it("every note shown to a reader exists in English and in Arabic", () => {
    for (const code of SUPPORTED_COUNTRIES) for (const key of EMERGENCY[code].caveats) {
      expect((en as Record<string, string>)[key], key).toBeTruthy();
      expect((ar as Record<string, string>)[key], key).toBeTruthy();
    }
  });

  it("in production serves no number for a country until a person has reviewed it", () => {
    const unreviewed = publicEmergency({ NODE_ENV: "production" } as NodeJS.ProcessEnv);
    for (const code of SUPPORTED_COUNTRIES) expect(unreviewed.countries[code]).toMatchObject({ reviewed: false, services: null });
    const reviewed = publicEmergency({ NODE_ENV: "production", EMERGENCY_DATA_REVIEWED_BY: "Dr. Reviewer" } as NodeJS.ProcessEnv);
    for (const code of SUPPORTED_COUNTRIES) expect(reviewed.countries[code]).toMatchObject({ reviewed: true, reviewedBy: "Dr. Reviewer" });
    expect(reviewed.countries.US.services).toEqual(EMERGENCY.US.services);
  });

  it("outside production serves the numbers, marked as not reviewed, so the screens can be built", () => {
    const dev = publicEmergency({ NODE_ENV: "development" } as NodeJS.ProcessEnv);
    expect(dev.countries.EG).toMatchObject({ reviewed: false });
    expect(dev.countries.EG.services?.length).toBe(3);
  });

  it("blocks a launch until a person has reviewed every country", () => {
    expect(emergencyDataReviewed({} as NodeJS.ProcessEnv)).toEqual({ ok: false, missing: ["EG", "US"] });
    expect(emergencyDataReviewed({ EMERGENCY_DATA_REVIEWED_BY: "A. Person" } as NodeJS.ProcessEnv).ok).toBe(true);
  });

  it("is public, needs no sign-in, and does not change with the language of the request", async () => {
    const en1 = await request(app).get("/api/config").set("Accept-Language", "en-US");
    const ar1 = await request(app).get("/api/config").set("Accept-Language", "ar-EG");
    expect(en1.status).toBe(200);
    expect(en1.body.emergency).toEqual(ar1.body.emergency);
    expect(en1.body.emergencyNumber).toBeUndefined(); // no single deployment-wide number any more
    expect(Object.keys(en1.body.emergency.countries).sort()).toEqual(["EG", "US"]);
  });
});
