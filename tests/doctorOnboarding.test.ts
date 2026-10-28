import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { eq } from "drizzle-orm";
import { getApp, signupPatient, createAdmin, createDoctor, connect, auth, uniqueEmail, PASSWORD, completeSecondFactor, signIn, APPROVAL, operatorPool } from "./helpers";
import { storage } from "../server/storage";
import { db } from "../server/db";
import { users } from "@shared/schema";

let app: Express;
beforeAll(async () => {
  app = await getApp();
});

const COMPLETE = {
  displayName: "Dr. Amira Haddad",
  professionalRole: "physician",
  specialty: "Cardiology",
  state: "TX",
  licenseNumber: "TX-998877",
  licensingBody: "Texas Medical Board",
  languages: ["en", "ar"],
  modalities: ["phone", "messaging"],
  phone: "+1 555 000 3333",
  qualifications: "MD, board certified",
  yearsExperience: 12,
  clinic: "Haddad Heart Clinic",
  bio: "Cardiology in English and Arabic.",
};

async function register(name = "Amira Haddad") {
  const email = uniqueEmail("newdoc");
  const res = await request(app).post("/api/doctors/register").send({ name, email, password: PASSWORD });
  expect(res.status).toBe(201);
  // A clinician is not given a session at registration: the second factor is set up first.
  expect(res.body.token).toBeUndefined();
  expect(res.body.mfa).toBe("setup");
  const session = await completeSecondFactor(res.body, email);
  return { email, token: session.token as string, id: session.user.id as string, body: session };
}

async function submitted() {
  const doc = await register();
  expect((await request(app).put("/api/doctors/me/application").set(auth(doc.token)).send(COMPLETE)).status).toBe(200);
  const sub = await request(app).post("/api/doctors/me/application/submit").set(auth(doc.token));
  expect(sub.status).toBe(200);
  return { ...doc, applicationId: sub.body.id as string };
}

describe("registering as a doctor", () => {
  it("creates a doctor account that is NOT approved, whatever the request says", async () => {
    const email = uniqueEmail("sneaky");
    const res = await request(app)
      .post("/api/doctors/register")
      .send({ name: "Sneaky Doc", email, password: PASSWORD, role: "admin", doctorStatus: "approved" });
    expect(res.status).toBe(201);
    const session = await completeSecondFactor(res.body, email);
    expect(session.user.role).toBe("doctor");
    expect(session.user.doctorStatus).toBe("incomplete");
    const [row] = (await operatorPool().query("SELECT id, role FROM users WHERE email = $1", [email])).rows;
    expect(row.role).toBe("doctor");
    expect(await storage.getDoctorProfileByUserId(row.id)).toBeUndefined();
  });

  it("cannot be used to self-assign a role through patient signup either", async () => {
    const email = uniqueEmail("pt");
    const res = await request(app).post("/api/auth/signup").send({ name: "X", email, password: PASSWORD, state: "CA", role: "admin" });
    expect(res.status).toBe(201);
    expect(res.body.user.role).toBe("patient");
  });

  it("refuses an email that already has an account", async () => {
    const doc = await register();
    const again = await request(app).post("/api/doctors/register").send({ name: "Dup", email: doc.email, password: PASSWORD });
    expect(again.status).toBe(409);
  });

  it("can't reach any clinical route, can't be listed, and can't read patients, before approval", async () => {
    const doc = await register();
    for (const [method, path] of [
      ["get", "/api/pairings/doctor"],
      ["get", "/api/appointments/doctor"],
      ["get", "/api/dashboard/doctor"],
      ["get", "/api/prescriptions/doctor"],
      ["get", "/api/doctors/me/availability"],
      ["get", "/api/sharing/shared-with-me"],
    ] as const) {
      const res = await (request(app) as any)[method](path).set(auth(doc.token));
      expect(res.status, path).toBe(403);
      expect(res.body.code, path).toBe("doctor_not_approved");
    }
    const directory = await request(app).get("/api/doctors");
    expect(directory.body.map((d: any) => d.name)).not.toContain("Amira Haddad");
  });

  it("must complete the required details before submitting, and is told which are missing", async () => {
    const doc = await register();
    const res = await request(app).post("/api/doctors/me/application/submit").set(auth(doc.token));
    expect(res.status).toBe(400);
    expect(res.body.missing).toEqual(expect.arrayContaining(["specialty", "licenseNumber", "licensingBody", "languages", "phone", "state"]));
  });

  it("rejects invalid professional details (unknown specialty, junk language, phone)", async () => {
    const doc = await register();
    const put = (body: object) => request(app).put("/api/doctors/me/application").set(auth(doc.token)).send(body);
    expect((await put({ specialty: "Wizardry" })).status).toBe(400);
    expect((await put({ languages: ["klingon"] })).status).toBe(400);
    expect((await put({ phone: "abc" })).status).toBe(400);
    expect((await put({ status: "approved" })).status).toBe(400); // unknown field: strict
  });

  it("locks the application while it is under review", async () => {
    const doc = await submitted();
    const edit = await request(app).put("/api/doctors/me/application").set(auth(doc.token)).send({ bio: "changed" });
    expect(edit.status).toBe(409);
    const status = await request(app).get("/api/doctors/me/application").set(auth(doc.token));
    expect(status.body.status).toBe("pending");
  });
});

describe("review by an administrator", () => {
  it("approval creates the profile, marks it reviewed, lists the doctor with languages, and unlocks clinical routes", async () => {
    const admin = await createAdmin();
    const doc = await submitted();
    const approve = await request(app).post(`/api/admin/doctor-applications/${doc.applicationId}/approve`).set(auth(admin.token)).send(APPROVAL);
    expect(approve.status).toBe(200);

    const profile = await storage.getDoctorProfileByUserId(doc.id);
    expect(profile!.timezone).toBe("America/Chicago");
    expect(profile!.verifiedAt).toBeTruthy();
    expect(profile!.languages).toEqual(["en", "ar"]);
    expect(profile!.name).toBe("Dr. Amira Haddad");

    expect((await request(app).get("/api/pairings/doctor").set(auth(doc.token))).status).toBe(200);
    const directory = await request(app).get("/api/doctors?q=Amira");
    expect(directory.body.map((d: any) => d.name)).toContain("Dr. Amira Haddad");

    const me = await request(app).get("/api/auth/me").set(auth(doc.token));
    expect(me.body.doctorStatus).toBe("approved");
  });

  it("creates exactly one profile when two administrators approve at once", async () => {
    const a1 = await createAdmin();
    const a2 = await createAdmin();
    const doc = await submitted();
    const [r1, r2] = await Promise.all([
      request(app).post(`/api/admin/doctor-applications/${doc.applicationId}/approve`).set(auth(a1.token)).send(APPROVAL),
      request(app).post(`/api/admin/doctor-applications/${doc.applicationId}/approve`).set(auth(a2.token)).send(APPROVAL),
    ]);
    expect([r1.status, r2.status].filter((s) => s === 200)).toHaveLength(1);
  });

  it("asking for more information returns the application to the doctor, who can fix it and resubmit", async () => {
    const admin = await createAdmin();
    const doc = await submitted();
    const ask = await request(app)
      .post(`/api/admin/doctor-applications/${doc.applicationId}/request-info`)
      .set(auth(admin.token))
      .send({ message: "Please add the issuing board's full name." });
    expect(ask.status).toBe(200);

    const mine = await request(app).get("/api/doctors/me/application").set(auth(doc.token));
    expect(mine.body.status).toBe("needs_info");
    expect(mine.body.application.infoRequest).toMatch(/issuing board/);

    expect((await request(app).put("/api/doctors/me/application").set(auth(doc.token)).send({ licensingBody: "Texas Medical Board (TMB)" })).status).toBe(200);
    expect((await request(app).post("/api/doctors/me/application/submit").set(auth(doc.token))).status).toBe(200);
    expect((await request(app).get("/api/doctors/me/application").set(auth(doc.token))).body.status).toBe("pending");
  });

  it("a rejected doctor stays out: still no clinical access and no further edits", async () => {
    const admin = await createAdmin();
    const doc = await submitted();
    expect((await request(app).post(`/api/admin/doctor-applications/${doc.applicationId}/reject`).set(auth(admin.token)).send({ reason: "Licence not found" })).status).toBe(200);
    expect((await request(app).get("/api/pairings/doctor").set(auth(doc.token))).status).toBe(403);
    expect((await request(app).put("/api/doctors/me/application").set(auth(doc.token)).send({ bio: "x" })).status).toBe(409);
    const mine = await request(app).get("/api/doctors/me/application").set(auth(doc.token));
    expect(mine.body.status).toBe("rejected");
    expect(mine.body.application.decisionNote).toBe("Licence not found");
  });

  it("suspension signs the doctor out, hides them, and blocks care; reinstating restores them", async () => {
    const admin = await createAdmin();
    const doc = await submitted();
    await request(app).post(`/api/admin/doctor-applications/${doc.applicationId}/approve`).set(auth(admin.token)).send(APPROVAL);
    const patient = await signupPatient({ state: "TX" });
    const profile = (await storage.getDoctorProfileByUserId(doc.id))!;
    const connection = await connect(patient, { id: doc.id, email: doc.email, token: doc.token, profileId: profile.id });

    const suspend = await request(app).post(`/api/admin/doctor-applications/${doc.applicationId}/suspend`).set(auth(admin.token)).send({ reason: "Under investigation" });
    expect(suspend.status).toBe(200);

    expect((await request(app).get("/api/pairings/doctor").set(auth(doc.token))).status).toBe(401); // sessions ended
    const relog = { status: 200, body: await signIn(doc.email) };
    expect(relog.status).toBe(200);
    expect(relog.body.user.doctorStatus).toBe("suspended");
    expect((await request(app).get("/api/pairings/doctor").set(auth(relog.body.token))).status).toBe(403);
    // …and cannot read the existing patient's messages either.
    expect((await request(app).get(`/api/pairings/${connection.pairingId}/messages`).set(auth(relog.body.token))).status).toBe(404);
    expect((await request(app).get("/api/doctors")).body.map((d: any) => d.id)).not.toContain(profile.id);

    expect((await request(app).post(`/api/admin/doctor-applications/${doc.applicationId}/reinstate`).set(auth(admin.token))).status).toBe(200);
    const back = { status: 200, body: await signIn(doc.email) };
    expect((await request(app).get("/api/pairings/doctor").set(auth(back.body.token))).status).toBe(200);
  });

  it("only an administrator can review, and the review queue is not open to doctors or patients", async () => {
    const doc = await submitted();
    const patient = await signupPatient();
    const approved = await createDoctor();
    for (const who of [patient, approved]) {
      expect((await request(app).get("/api/admin/doctor-applications").set(auth(who.token))).status).toBe(403);
      expect((await request(app).post(`/api/admin/doctor-applications/${doc.applicationId}/approve`).set(auth(who.token)).send(APPROVAL)).status).toBe(403);
      expect((await request(app).get("/api/admin/audit").set(auth(who.token))).status).toBe(403);
    }
    // A doctor cannot approve themselves.
    expect((await request(app).post(`/api/admin/doctor-applications/${doc.applicationId}/approve`).set(auth(doc.token)).send(APPROVAL)).status).toBe(403);
  });

  it("the audit view lists who did what, without any metadata", async () => {
    const admin = await createAdmin();
    const doc = await submitted();
    await request(app).post(`/api/admin/doctor-applications/${doc.applicationId}/reject`).set(auth(admin.token)).send({ reason: "secret reviewer reason" });
    const res = await request(app).get("/api/admin/audit?limit=20").set(auth(admin.token));
    expect(res.status).toBe(200);
    expect(res.body.some((r: any) => r.action === "doctor_application.rejected" && r.actor?.role === "admin")).toBe(true);
    expect(JSON.stringify(res.body)).not.toMatch(/secret reviewer reason|metadata/);
  });
});

describe("an approved doctor's own profile", () => {
  it("can edit the permitted fields but never licence, specialty or region", async () => {
    const admin = await createAdmin();
    const doc = await submitted();
    await request(app).post(`/api/admin/doctor-applications/${doc.applicationId}/approve`).set(auth(admin.token)).send(APPROVAL);
    const ok = await request(app).patch("/api/doctors/me/profile").set(auth(doc.token)).send({ bio: "New bio", languages: ["en", "ar", "fr"] });
    expect(ok.status).toBe(200);
    expect((await storage.getDoctorProfileByUserId(doc.id))!.languages).toEqual(["en", "ar", "fr"]);
    for (const body of [{ specialty: "Dermatology" }, { licenseNumber: "FAKE" }, { state: "CA" }, { verifiedAt: new Date() }]) {
      expect((await request(app).patch("/api/doctors/me/profile").set(auth(doc.token)).send(body)).status, JSON.stringify(body)).toBe(400);
    }
  });
});

describe("finding doctors", () => {
  async function approvedDoctor(over: Record<string, unknown>) {
    const admin = await createAdmin();
    const doc = await register(`Dir ${Math.random().toString(36).slice(2, 7)}`);
    await request(app).put("/api/doctors/me/application").set(auth(doc.token)).send({ ...COMPLETE, displayName: `Dr. Dir ${doc.email.slice(0, 6)}`, ...over });
    const sub = await request(app).post("/api/doctors/me/application/submit").set(auth(doc.token));
    await request(app).post(`/api/admin/doctor-applications/${sub.body.id}/approve`).set(auth(admin.token)).send(APPROVAL);
    return { ...doc, profile: (await storage.getDoctorProfileByUserId(doc.id))! };
  }

  it("filters by language, modality and specialty, and marks reviewed profiles", async () => {
    const arabic = await approvedDoctor({ languages: ["ar", "fr"], modalities: ["in_person"], specialty: "Dermatology", state: "NM" });
    const list = (qs: string) => request(app).get(`/api/doctors?${qs}`).then((r) => r.body as any[]);

    const byLang = await list("language=fr&state=NM");
    expect(byLang.map((d) => d.id)).toContain(arabic.profile.id);
    expect((await list("language=ko&state=NM")).map((d) => d.id)).not.toContain(arabic.profile.id);
    expect((await list("modality=in_person&state=NM")).map((d) => d.id)).toContain(arabic.profile.id);
    expect((await list("modality=messaging&state=NM")).map((d) => d.id)).not.toContain(arabic.profile.id);
    expect((await list("specialty=Dermatology&state=NM")).map((d) => d.id)).toContain(arabic.profile.id);

    const row = byLang.find((d) => d.id === arabic.profile.id);
    expect(row.reviewedByAvela).toBe(true);
    expect(row.languages).toEqual(["ar", "fr"]);
    expect(row.phone).toBeUndefined();
  });

  it("offers a time only when the doctor has really published availability", async () => {
    const doc = await approvedDoctor({ state: "NM", specialty: "Dermatology" });
    const none = await request(app).get("/api/doctors?available=true&state=NM").then((r) => r.body as any[]);
    expect(none.map((d) => d.id)).not.toContain(doc.profile.id);

    const weekdays = [1, 2, 3, 4, 5].map((weekday) => ({ weekday, startMinute: 540, endMinute: 1020 }));
    expect((await request(app).put("/api/doctors/me/availability").set(auth(doc.token)).send({ timezone: "America/Denver", windows: weekdays })).status).toBe(200);
    const some = await request(app).get("/api/doctors?available=true&state=NM").then((r) => r.body as any[]);
    const row = some.find((d) => d.id === doc.profile.id);
    expect(row.nextAvailable).toBeTruthy();
    expect(new Date(row.nextAvailable).getTime()).toBeGreaterThan(Date.now());
  });

  it("rejects filters it doesn't understand instead of ignoring them", async () => {
    expect((await request(app).get("/api/doctors?language=klingon")).status).toBe(400);
    expect((await request(app).get("/api/doctors?modality=video")).status).toBe(400);
  });
});
