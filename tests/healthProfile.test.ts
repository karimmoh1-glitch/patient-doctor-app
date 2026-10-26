import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { eq, and } from "drizzle-orm";
import { getApp, signupPatient, createDoctor, connect, auth, type TestUser, type TestDoctor } from "./helpers";
import { db } from "../server/db";
import { runAsSystem } from "../server/dbContext";
import { healthEntries, healthEntryEvents, assistGrants, auditLogs, users } from "@shared/schema";
import { CONSENT_VERSION } from "../server/services/healthProfile";

let app: Express;
beforeAll(async () => {
  app = await getApp();
});

const sys = <T,>(f: () => Promise<T>) => runAsSystem(f);
const api = {
  get: (u: TestUser, path: string) => request(app).get(`/api/health-profile${path}`).set(auth(u.token)),
  post: (u: TestUser, path: string, body: object = {}) => request(app).post(`/api/health-profile${path}`).set(auth(u.token)).send(body),
  put: (u: TestUser, path: string, body: object = {}) => request(app).put(`/api/health-profile${path}`).set(auth(u.token)).send(body),
  del: (u: TestUser, path: string) => request(app).delete(`/api/health-profile${path}`).set(auth(u.token)),
};
const doc = {
  get: (d: TestUser, path: string) => request(app).get(`/api/assist${path}`).set(auth(d.token)),
  post: (d: TestUser, path: string, body: object = {}) => request(app).post(`/api/assist${path}`).set(auth(d.token)).send(body),
  put: (d: TestUser, path: string, body: object = {}) => request(app).put(`/api/assist${path}`).set(auth(d.token)).send(body),
};
const consent = (u: TestUser) => api.post(u, "/consent", { version: CONSENT_VERSION });
const penicillin = { substance: "Penicillin", reaction: "Rash", severity: "moderate" };

async function patientWithConsent() {
  const p = await signupPatient();
  expect((await consent(p)).status).toBe(201);
  return p;
}
async function connected(grant = true) {
  const patient = await patientWithConsent();
  const doctor = await createDoctor();
  await connect(patient, doctor);
  let grantId: string | undefined;
  if (grant) {
    const g = await api.post(patient, "/assist", { doctorProfileId: doctor.profileId, days: 7 });
    expect(g.status).toBe(201);
    grantId = g.body.id;
  }
  return { patient, doctor, grantId };
}

describe("allergies: what is known, what is not, and who said so", () => {
  it("starts as 'not collected' and never reads an empty list as 'none'", async () => {
    const p = await signupPatient();
    const o = await api.get(p, "/");
    expect(o.body.allergy.picture).toBe("not_collected");
    expect(o.body.allergy.statedBy).toBeNull();
    expect(o.body.sections.allergies).toBe("not_started");
  });

  it("needs consent before any health information is stored", async () => {
    const p = await signupPatient();
    const res = await api.post(p, "/entries", { kind: "allergy", data: penicillin });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("consent_required");
    expect((await api.put(p, "/allergies/statement", { state: "none_known" })).status).toBe(403);
    // A wrong or stale wording version is refused, so the record shows the version the person actually saw.
    const stale = await api.post(p, "/consent", { version: "an-old-version" });
    expect(stale.status).toBe(409);
    expect((await consent(p)).status).toBe(201);
    expect((await api.get(p, "/consent")).body).toMatchObject({ given: true, version: CONSENT_VERSION, current: true });
  });

  it("an allergy on the list means 'has known allergies'; 'none known' is refused beside it; removing the last returns to 'not collected', not 'none'", async () => {
    const p = await patientWithConsent();
    const made = await api.post(p, "/entries", { kind: "allergy", data: penicillin });
    expect(made.status).toBe(201);
    expect(made.body).toMatchObject({ source: "patient_reported", verified: null, enteredBy: { role: "patient" } });
    expect((await api.get(p, "/")).body.allergy.picture).toBe("has_known");
    const refused = await api.put(p, "/allergies/statement", { state: "none_known" });
    expect(refused.status).toBe(409);
    expect((await api.post(p, `/entries/${made.body.id}/withdraw`)).status).toBe(200);
    expect((await api.get(p, "/")).body.allergy.picture).toBe("not_collected");
  });

  it("'no known allergies' exists only as an explicit statement, labelled as the patient's own and not clinician-reviewed", async () => {
    const p = await patientWithConsent();
    expect((await api.put(p, "/allergies/statement", { state: "bananas" })).status).toBe(400);
    const said = await api.put(p, "/allergies/statement", { state: "none_known" });
    expect(said.status).toBe(200);
    expect(said.body).toMatchObject({ picture: "none_known", statedBy: "patient", clinicianReviewedAt: null, clinicianVerified: false });
    const unsure = await api.put(p, "/allergies/statement", { state: "unknown" });
    expect(unsure.body.picture).toBe("unknown");
    expect((await api.del(p, "/allergies/statement")).body.picture).toBe("not_collected");
  });
});

describe("entries keep their author and are never overwritten", () => {
  it("validates each kind of entry and stores what was written", async () => {
    const p = await patientWithConsent();
    expect((await api.post(p, "/entries", { kind: "allergy", data: { substance: "" } })).status).toBe(400);
    expect((await api.post(p, "/entries", { kind: "allergy", data: { ...penicillin, severity: "catastrophic" } })).status).toBe(400);
    expect((await api.post(p, "/entries", { kind: "medication", data: { name: "Metformin", dose_decided_by_avela: "500mg" } })).status).toBe(400); // unknown fields refused
    expect((await api.post(p, "/entries", { kind: "horoscope", data: {} })).status).toBe(400);
    const med = await api.post(p, "/entries", { kind: "medication", data: { name: "Metformin", strength: "500 mg", instructions: "Take with food, as my doctor told me" } });
    expect(med.status).toBe(201);
    expect(med.body.data.instructions).toBe("Take with food, as my doctor told me"); // as written, not interpreted
    expect(med.body.verified).toBeNull();
  });

  it("an amendment adds a new entry that supersedes the old; both stay, with their history", async () => {
    const p = await patientWithConsent();
    const first = (await api.post(p, "/entries", { kind: "condition", data: { name: "Asthma", since: "about 2015" } })).body;
    const amended = await api.post(p, `/entries/${first.id}/amend`, { data: { name: "Asthma", since: "2014", notes: "Corrected the year" } });
    expect(amended.status).toBe(200);
    expect(amended.body.amended).toBe(true);
    const list = (await api.get(p, "/entries?kind=condition")).body;
    expect(list.map((e: any) => e.id)).toEqual([amended.body.id]);
    const oldRow = (await sys(() => db.select().from(healthEntries).where(eq(healthEntries.id, first.id))))[0];
    expect(oldRow.status).toBe("superseded");
    expect(oldRow.data).toMatchObject({ since: "about 2015" });
    const history = (await api.get(p, `/entries/${first.id}/history`)).body;
    expect(history.map((h: any) => h.action)).toEqual(["created", "amended"]);
    // The old one cannot be amended again: it is no longer the current version.
    expect((await api.post(p, `/entries/${first.id}/amend`, { data: { name: "x" } })).status).toBe(409);
  });

  it("the database itself refuses to edit an entry in place, delete it, or alter its history", async () => {
    const p = await patientWithConsent();
    const e = (await api.post(p, "/entries", { kind: "need", data: { description: "Large print please" } })).body;
    await expect(sys(() => db.update(healthEntries).set({ data: { description: "changed" } }).where(eq(healthEntries.id, e.id)))).rejects.toThrow();
    // Deleting either fails outright (owner) or removes nothing (restricted role has no delete policy): never both gone.
    await sys(() => db.delete(healthEntries).where(eq(healthEntries.id, e.id))).catch(() => {});
    await sys(() => db.delete(healthEntryEvents).where(eq(healthEntryEvents.entryId, e.id))).catch(() => {});
    expect(await sys(() => db.select().from(healthEntries).where(eq(healthEntries.id, e.id)))).toHaveLength(1);
    expect(await sys(() => db.select().from(healthEntryEvents).where(eq(healthEntryEvents.entryId, e.id)))).toHaveLength(1);
  });

  it("is invisible to another patient, whatever id they use", async () => {
    const a = await patientWithConsent();
    const b = await patientWithConsent();
    const e = (await api.post(a, "/entries", { kind: "allergy", data: penicillin })).body;
    expect((await api.get(b, "/entries")).body).toEqual([]);
    for (const res of [
      await api.post(b, `/entries/${e.id}/amend`, { data: penicillin }),
      await api.post(b, `/entries/${e.id}/withdraw`),
      await api.post(b, `/entries/${e.id}/dispute`, { note: "not mine to say" }),
      await api.get(b, `/entries/${e.id}/history`),
    ]) expect(res.status).toBe(404);
    expect((await api.get(a, "/entries")).body).toHaveLength(1);
  });

  it("records an audit event for every change, about the right person", async () => {
    const p = await patientWithConsent();
    const e = (await api.post(p, "/entries", { kind: "allergy", data: penicillin })).body;
    await api.post(p, `/entries/${e.id}/withdraw`);
    const rows = await sys(() => db.select().from(auditLogs).where(eq(auditLogs.subjectUserId, p.id)));
    const actions = rows.map((r) => r.action);
    expect(actions).toEqual(expect.arrayContaining(["health_profile.consent_given", "health_profile.entry_created", "health_profile.entry_withdrawn"]));
    expect(JSON.stringify(rows)).not.toContain("Penicillin"); // what was written is not copied into the audit log
  });
});

describe("a clinician helping with onboarding", () => {
  it("sees nothing, and cannot tell the patient exists, without the patient's grant", async () => {
    const { patient, doctor } = await connected(false);
    expect((await doc.get(doctor, `/${patient.id}`)).status).toBe(404);
    expect((await doc.post(doctor, `/${patient.id}/entries`, { kind: "allergy", data: penicillin })).status).toBe(404);
    expect((await doc.get(doctor, `/00000000-0000-0000-0000-000000000000`)).status).toBe(404);
    expect((await doc.get(doctor, "/patients")).body).toEqual([]);
  });

  it("can enter and verify information under a live grant; the patient sees who did it and that it is verified", async () => {
    const { patient, doctor } = await connected();
    expect((await doc.get(doctor, "/patients")).body.map((r: any) => r.patientUserId)).toEqual([patient.id]);
    const entered = await doc.post(doctor, `/${patient.id}/entries`, { kind: "allergy", data: { substance: "Latex", severity: "severe" } });
    expect(entered.status).toBe(201);
    expect(entered.body).toMatchObject({ source: "clinician_entered", verified: null, enteredBy: { role: "doctor" } });
    expect((await doc.post(doctor, `/${patient.id}/entries/${entered.body.id}/verify`)).status).toBe(200);
    const mine = (await api.get(patient, "/entries?kind=allergy")).body[0];
    expect(mine).toMatchObject({ source: "clinician_entered", enteredBy: { role: "doctor" } });
    expect(mine.verified).toBeTruthy();
    expect((await doc.get(doctor, `/${patient.id}`)).body.allergy.picture).toBe("has_known");
    // A clinician's read of a patient's profile is recorded.
    const reads = await sys(() => db.select().from(auditLogs).where(and(eq(auditLogs.subjectUserId, patient.id), eq(auditLogs.action, "health_profile.read_by_clinician"))));
    expect(reads.length).toBeGreaterThan(0);
  });

  it("a patient cannot silently remove what a clinician entered or verified: they dispute it, and it is flagged", async () => {
    const { patient, doctor } = await connected();
    const entered = (await doc.post(doctor, `/${patient.id}/entries`, { kind: "condition", data: { name: "Hypertension" } })).body;
    const removal = await api.post(patient, `/entries/${entered.id}/withdraw`);
    expect(removal.status).toBe(409);
    expect(removal.body.code).toBe("dispute_instead");
    expect((await api.post(patient, `/entries/${entered.id}/dispute`, { note: "I was never told this" })).status).toBe(200);
    const flagged = (await doc.get(doctor, `/${patient.id}`)).body.entries.find((e: any) => e.id === entered.id);
    expect(flagged.disputed).toMatchObject({ note: "I was never told this" });
    // The clinician, not the patient, then amends or removes it, each leaving history.
    expect((await doc.post(doctor, `/${patient.id}/entries/${entered.id}/withdraw`)).status).toBe(200);
    expect((await api.get(patient, `/entries/${entered.id}/history`)).body.map((h: any) => h.action)).toEqual(["created", "disputed", "withdrawn"]);
  });

  it("a patient who reported something themselves and nobody verified can remove it; once verified they cannot", async () => {
    const { patient, doctor } = await connected();
    const a = (await api.post(patient, "/entries", { kind: "condition", data: { name: "Migraine" } })).body;
    const b = (await api.post(patient, "/entries", { kind: "condition", data: { name: "Eczema" } })).body;
    expect((await api.post(patient, `/entries/${a.id}/withdraw`)).status).toBe(200);
    await doc.post(doctor, `/${patient.id}/entries/${b.id}/verify`);
    expect((await api.post(patient, `/entries/${b.id}/withdraw`)).status).toBe(409);
    // A clinician cannot remove what the patient reported.
    expect((await doc.post(doctor, `/${patient.id}/entries/${b.id}/withdraw`)).status).toBe(409);
  });

  it("loses access the moment the patient revokes, when the grant expires, or when consent is withdrawn", async () => {
    const one = await connected();
    expect((await doc.get(one.doctor, `/${one.patient.id}`)).status).toBe(200);
    expect((await request(app).delete(`/api/health-profile/assist/${one.grantId}`).set(auth(one.patient.token))).status).toBe(200);
    expect((await doc.get(one.doctor, `/${one.patient.id}`)).status).toBe(404);
    expect((await doc.post(one.doctor, `/${one.patient.id}/entries`, { kind: "need", data: { description: "x" } })).status).toBe(404);

    const two = await connected();
    await sys(() => db.update(assistGrants).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(assistGrants.id, two.grantId!)));
    expect((await doc.get(two.doctor, `/${two.patient.id}`)).status).toBe(404);

    const three = await connected();
    expect((await api.del(three.patient, "/consent")).status).toBe(200);
    expect((await doc.get(three.doctor, `/${three.patient.id}`)).status).toBe(404);
    expect((await api.post(three.patient, "/entries", { kind: "need", data: { description: "x" } })).status).toBe(403);
  });

  it("is not available to a doctor the patient is not connected to, or to a connected doctor who was not named", async () => {
    const { patient } = await connected();
    const stranger = await createDoctor();
    expect((await api.post(patient, "/assist", { doctorProfileId: stranger.profileId, days: 3 })).status).toBe(404);
    expect((await doc.get(stranger, `/${patient.id}`)).status).toBe(404);
    const other = await createDoctor();
    await connect(patient, other);
    expect((await doc.get(other, `/${patient.id}`)).status).toBe(404); // connected, but not authorised for this
  });

  it("is not available to patients, caregivers or anyone signed out, on either side", async () => {
    const { patient, doctor } = await connected();
    expect((await doc.get(patient, `/${patient.id}`)).status).toBe(403);
    expect((await request(app).get(`/api/assist/${patient.id}`)).status).toBe(401);
    expect((await request(app).get("/api/health-profile")).status).toBe(401);
    expect((await request(app).get("/api/health-profile").set(auth(doctor.token))).status).toBe(403);
  });

  it("a clinician can record that they reviewed allergies with the patient, which the patient's own statement cannot claim", async () => {
    const { patient, doctor } = await connected();
    expect((await doc.post(doctor, `/${patient.id}/allergies/review`)).status).toBe(409); // nothing recorded yet
    const stated = await doc.put(doctor, `/${patient.id}/allergies/statement`, { state: "none_known" });
    expect(stated.body).toMatchObject({ picture: "none_known", statedBy: "doctor" });
    expect(stated.body.clinicianReviewedAt).toBeTruthy();
    const seen = (await api.get(patient, "/")).body.allergy;
    expect(seen).toMatchObject({ picture: "none_known", statedBy: "doctor" });
  });
});

describe("basic information and sections", () => {
  it("validates dates, countries and time zones, and keeps language and country independent", async () => {
    const p = await signupPatient();
    for (const bad of [{ dateOfBirth: "2999-01-01" }, { dateOfBirth: "1800-01-01" }, { dateOfBirth: "2020-02-31" }, { country: "FR" }, { timezone: "Mars/Olympus" }, { contactMethod: "carrier_pigeon" }, { unknown: 1 }]) {
      expect((await api.put(p, "/basic", bad)).status).toBe(400);
    }
    expect((await api.put(p, "/basic", { dateOfBirth: "1950-06-15", country: "EG", timezone: "Africa/Cairo", contactMethod: "phone", phone: "+20 100 000 0000", accessibilityNotes: "Large print" })).status).toBe(200);
    // Language was never touched by choosing a country.
    await request(app).patch("/api/auth/me/preferences").set(auth(p.token)).send({ language: "en" });
    const got = (await api.get(p, "/basic")).body;
    expect(got).toMatchObject({ country: "EG", language: "en", timezone: "Africa/Cairo", dateOfBirth: "1950-06-15" });
    await request(app).patch("/api/auth/me/preferences").set(auth(p.token)).send({ language: "ar" });
    expect((await api.get(p, "/basic")).body).toMatchObject({ country: "EG", language: "ar" });
  });

  it("lets a person skip sections and come back, and skipping stores nothing", async () => {
    const p = await signupPatient();
    expect((await api.put(p, "/sections/allergies", { status: "skipped" })).status).toBe(200);
    expect((await api.put(p, "/sections/nonsense", { status: "skipped" })).status).toBe(404);
    expect((await api.put(p, "/sections/medications", { status: "finished" })).status).toBe(400);
    const o = (await api.get(p, "/")).body;
    expect(o.sections).toMatchObject({ allergies: "skipped", medications: "not_started", basic: "not_started" });
    expect(o.allergy.picture).toBe("not_collected"); // skipped is not "none"
    expect(o.counts).toEqual({});
    expect((await api.put(p, "/sections/allergies", { status: "in_progress" })).status).toBe(200);
  });

  it("keeps emergency contact and care preferences, with the relationship, and nothing else changes", async () => {
    const p = await signupPatient();
    expect((await api.put(p, "/preferences", { emergencyContactName: "Salma", emergencyContactPhone: "+1 555 000 1212", emergencyContactRelationship: "Daughter", appointmentFormat: "phone", preferredClinic: "Riverside" })).status).toBe(200);
    expect((await api.put(p, "/preferences", { appointmentFormat: "teleport" })).status).toBe(400);
    expect((await api.get(p, "/preferences")).body).toMatchObject({ emergencyContactName: "Salma", emergencyContactRelationship: "Daughter", appointmentFormat: "phone", preferredClinic: "Riverside" });
    const [row] = await sys(() => db.select().from(users).where(eq(users.id, p.id)));
    expect(row.role).toBe("patient");
  });
});

void ({} as TestDoctor);
