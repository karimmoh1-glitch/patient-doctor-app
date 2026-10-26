import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { getApp, createDoctor } from "./helpers";

let app: Express;
beforeAll(async () => {
  app = await getApp();
});

describe("why a doctor appears in the directory", () => {
  it("says nothing when no filter was set: being listed is not a recommendation", async () => {
    const d = await createDoctor({ name: "Dr. Plain Listing" });
    const rows = (await request(app).get("/api/doctors?q=Plain Listing")).body;
    const mine = rows.find((r: any) => r.id === d.profileId);
    expect(mine.reasons).toEqual([{ type: "name", value: "Plain Listing" }]);
    const all = (await request(app).get("/api/doctors")).body;
    expect(all.every((r: any) => r.reasons.length === 0)).toBe(true);
  });

  it("names only the filters the person set, each one the doctor really satisfies", async () => {
    const d = await createDoctor({ name: "Dr. Filter Match", specialty: "Dermatology", state: "TX" });
    const res = (await request(app).get("/api/doctors?specialty=Dermatology&state=TX")).body;
    const mine = res.find((r: any) => r.id === d.profileId);
    expect(mine.reasons).toEqual([{ type: "specialty", value: "Dermatology" }, { type: "state", value: "TX" }]);
    expect(res.every((r: any) => r.specialty === "Dermatology" && r.state === "TX")).toBe(true);
    // A doctor who does not satisfy a filter is not listed with a made-up reason.
    expect((await request(app).get("/api/doctors?specialty=Cardiology&state=TX")).body.find((r: any) => r.id === d.profileId)).toBeUndefined();
  });

  it("never claims availability that is not published", async () => {
    const d = await createDoctor({ name: "Dr. No Times" });
    const rows = (await request(app).get("/api/doctors?available=true")).body;
    expect(rows.find((r: any) => r.id === d.profileId)).toBeUndefined();
  });
});
