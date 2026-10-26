import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { eq } from "drizzle-orm";
import { getApp, createAdmin, signupPatient, auth, uniqueEmail, PASSWORD, completeSecondFactor, APPROVAL } from "./helpers";
import { db } from "../server/db";
import { runAsSystem } from "../server/dbContext";
import { doctorCredentials, credentialEvents, doctorProfiles } from "@shared/schema";

let app: Express;
beforeAll(async () => {
  app = await getApp();
});

const COMPLETE = {
  displayName: "Dr. Credential Case", professionalRole: "physician", specialty: "Cardiology", state: "TX", licenseNumber: "TX-554433",
  licensingBody: "Texas Medical Board", npiNumber: "1234567890", languages: ["en"], modalities: ["phone"], phone: "+1 555 000 4444",
  qualifications: "MD", yearsExperience: 7, clinic: "Case Clinic", bio: "Cardiology.",
};

async function submitted() {
  const email = uniqueEmail("cred");
  const reg = await request(app).post("/api/doctors/register").send({ name: "Credential Case", email, password: PASSWORD });
  const session = await completeSecondFactor(reg.body, email);
  const displayName = `Dr. Credential ${Math.random().toString(36).slice(2, 8)}`;
  await request(app).put("/api/doctors/me/application").set(auth(session.token)).send({ ...COMPLETE, displayName });
  const sub = await request(app).post("/api/doctors/me/application/submit").set(auth(session.token));
  return { token: session.token as string, userId: session.user.id as string, applicationId: sub.body.id as string, name: displayName };
}
const approve = (adminToken: string, id: string, body: unknown) => request(app).post(`/api/admin/doctor-applications/${id}/approve`).set(auth(adminToken)).send(body as object);
const listed = async (name: string) => (await request(app).get(`/api/doctors?q=${encodeURIComponent(name)}`)).body.map((d: any) => d.name).includes(name);
const sys = <T,>(f: () => Promise<T>) => runAsSystem(f);

describe("approving a clinician is verifying their licence", () => {
  it("refuses an approval that does not say how the licence was checked, and leaves the application waiting", async () => {
    const admin = await createAdmin();
    const doc = await submitted();
    const bad = [
      undefined,
      { verification: { ...APPROVAL.verification, source: "trust_me" } },
      { verification: { ...APPROVAL.verification, evidenceNote: "ok" } },
      { verification: { ...APPROVAL.verification, expiresAt: new Date(Date.now() - 86_400_000).toISOString() } },
      { verification: { ...APPROVAL.verification, expiresAt: new Date(Date.now() + 20 * 365 * 86_400_000).toISOString() } },
    ];
    for (const body of bad) {
      const res = await approve(admin.token, doc.applicationId, body ?? {});
      expect(res.status).toBe(400);
    }
    expect(await listed(doc.name)).toBe(false);
    expect((await approve(admin.token, doc.applicationId, APPROVAL)).status).toBe(200);
  });

  it("records the source, the evidence, the reviewer and the expiry, and leaves the NPI unverified", async () => {
    const admin = await createAdmin();
    const doc = await submitted();
    expect((await approve(admin.token, doc.applicationId, APPROVAL)).status).toBe(200);
    const rows = await sys(() => db.select().from(doctorCredentials).where(eq(doctorCredentials.applicationId, doc.applicationId)));
    const licence = rows.find((r) => r.kind === "license")!;
    const npi = rows.find((r) => r.kind === "npi")!;
    expect(licence).toMatchObject({ status: "verified", source: "document_review", reviewerUserId: admin.id, jurisdiction: "TX" });
    expect(licence.evidenceNote).toContain("Licence certificate");
    expect(licence.expiresAt!.getTime()).toBeGreaterThan(Date.now());
    expect(npi).toMatchObject({ status: "pending", source: null, reviewerUserId: null });
    const events = await sys(() => db.select().from(credentialEvents).where(eq(credentialEvents.credentialId, licence.id)));
    expect(events.map((e) => e.toStatus)).toEqual(["verified"]);
    expect(await listed(doc.name)).toBe(true);
  });

  it("cannot store 'verified' without evidence, even by a direct write", async () => {
    const admin = await createAdmin();
    const doc = await submitted();
    await approve(admin.token, doc.applicationId, APPROVAL);
    const [npi] = await sys(() => db.select().from(doctorCredentials).where(eq(doctorCredentials.applicationId, doc.applicationId))).then((r) => r.filter((c) => c.kind === "npi"));
    await expect(sys(() => db.update(doctorCredentials).set({ status: "verified" }).where(eq(doctorCredentials.id, npi.id)))).rejects.toThrow();
  });

  it("stops listing a clinician when the verified licence expires, and lists them again when a reviewer renews it", async () => {
    const admin = await createAdmin();
    const doc = await submitted();
    await approve(admin.token, doc.applicationId, APPROVAL);
    expect(await listed(doc.name)).toBe(true);

    const [licence] = (await sys(() => db.select().from(doctorCredentials).where(eq(doctorCredentials.applicationId, doc.applicationId)))).filter((c) => c.kind === "license");
    const past = new Date(Date.now() - 3_600_000);
    await sys(async () => {
      await db.update(doctorCredentials).set({ expiresAt: past }).where(eq(doctorCredentials.id, licence.id));
      await db.update(doctorProfiles).set({ credentialExpiresAt: past }).where(eq(doctorProfiles.userId, doc.userId));
    });
    expect(await listed(doc.name)).toBe(false);
    const expired = await request(app).get("/api/admin/credentials?filter=expired").set(auth(admin.token));
    expect(expired.body.find((c: any) => c.id === licence.id)).toMatchObject({ status: "expired", storedStatus: "verified" });

    const renew = await request(app).post(`/api/admin/credentials/${licence.id}/verify`).set(auth(admin.token)).send({
      source: "registry_lookup", evidenceNote: "Renewal confirmed on the public register.", expiresAt: new Date(Date.now() + 400 * 86_400_000).toISOString(),
    });
    expect(renew.status).toBe(200);
    expect(await listed(doc.name)).toBe(true);
    const history = await request(app).get(`/api/admin/credentials/${licence.id}/history`).set(auth(admin.token));
    expect(history.body.map((e: any) => e.toStatus)).toEqual(["verified", "verified"]);
  });

  it("removes a clinician from the directory at once when the licence is suspended, and only an administrator can do it", async () => {
    const admin = await createAdmin();
    const doc = await submitted();
    const patient = await signupPatient();
    await approve(admin.token, doc.applicationId, APPROVAL);
    const [licence] = (await sys(() => db.select().from(doctorCredentials).where(eq(doctorCredentials.applicationId, doc.applicationId)))).filter((c) => c.kind === "license");

    for (const who of [patient.token, doc.token]) {
      expect((await request(app).post(`/api/admin/credentials/${licence.id}/suspend`).set(auth(who)).send({ note: "no" })).status).toBe(403);
    }
    expect((await request(app).post(`/api/admin/credentials/${licence.id}/suspend`).set(auth(admin.token)).send({ note: "x" })).status).toBe(400);
    expect((await request(app).post(`/api/admin/credentials/${licence.id}/suspend`).set(auth(admin.token)).send({ note: "Board action reported" })).status).toBe(200);
    expect(await listed(doc.name)).toBe(false);
    // A suspended credential is not silently revived by an unrelated call.
    expect((await request(app).post(`/api/admin/credentials/${licence.id}/suspend`).set(auth(admin.token)).send({ note: "again" })).status).toBe(409);
  });

  it("keeps the history of a credential append-only", async () => {
    const admin = await createAdmin();
    const doc = await submitted();
    await approve(admin.token, doc.applicationId, APPROVAL);
    const [licence] = (await sys(() => db.select().from(doctorCredentials).where(eq(doctorCredentials.applicationId, doc.applicationId)))).filter((c) => c.kind === "license");
    await expect(sys(() => db.update(credentialEvents).set({ note: "rewritten" }).where(eq(credentialEvents.credentialId, licence.id)))).rejects.toThrow();
    await expect(sys(() => db.delete(credentialEvents).where(eq(credentialEvents.credentialId, licence.id)))).rejects.toThrow();
  });
});
