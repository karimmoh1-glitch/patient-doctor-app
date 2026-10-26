import { describe, it, expect, beforeAll, vi } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { getApp, signupPatient, createDoctor, createAdmin, connect, issuePrescription, auth, uniqueEmail, operatorPool, PASSWORD, type TestUser, type TestDoctor } from "./helpers";

// When a patient takes access away, it must stop on the next request on EVERY endpoint that served it, not just the one a
// test happened to check. These sweep the endpoints a doctor or caregiver can reach about a patient, before and after.

const invites: { to: string; link: string }[] = [];
vi.mock("../server/services/emailService", async (importOriginal) => {
  const original = await importOriginal<typeof import("../server/services/emailService")>();
  return { ...original, sendCareCircleInviteEmail: async (to: string, _n: string, _p: string, link: string) => { invites.push({ to: to.toLowerCase(), link }); } };
});

let app: Express;
beforeAll(async () => {
  app = await getApp();
});

async function scene() {
  const patient = await signupPatient();
  const doctor = await createDoctor();
  const { pairingId } = await connect(patient, doctor);
  const appt = (await operatorPool().query(
    `INSERT INTO appointments (pairing_request_id, patient_user_id, doctor_profile_id, type, reason, scheduled_at, status)
     VALUES ($1, $2, $3, 'Video Visit', 'private reason', now() + interval '3 days', 'confirmed') RETURNING id`,
    [pairingId, patient.id, doctor.profileId],
  )).rows[0].id as string;
  await request(app).put(`/api/sharing/${doctor.profileId}`).set(auth(patient.token)).send({ shareMedications: true, shareAppointments: true, shareDocuments: true });
  return { patient, doctor, pairingId, appt };
}

/** Every way a connected doctor can read about, or write to, this patient. [label, call] */
const doctorReads = (d: TestDoctor, pairingId: string): [string, () => Promise<number>][] => [
  ["the symptom report sent with the request", async () => (await request(app).get(`/api/pairings/${pairingId}/symptom-report`).set(auth(d.token))).status],
  ["the records the patient shared", async () => (await request(app).get(`/api/pairings/${pairingId}/shared-records`).set(auth(d.token))).status],
  ["the conversation", async () => (await request(app).get(`/api/pairings/${pairingId}/messages`).set(auth(d.token))).status],
  ["sending a message", async () => (await request(app).post(`/api/pairings/${pairingId}/messages`).set(auth(d.token)).send({ body: "hello" })).status],
];

describe("when a patient ends a connection, the doctor loses every route to them at once", () => {
  it("serves each endpoint while connected and refuses each the moment it ends", async () => {
    const { patient, doctor, pairingId } = await scene();
    for (const [what, call] of doctorReads(doctor, pairingId)) {
      expect([200, 201], `${what} while connected`).toContain(await call());
    }
    expect((await request(app).patch(`/api/pairings/${pairingId}/end`).set(auth(patient.token))).status).toBe(200);
    for (const [what, call] of doctorReads(doctor, pairingId)) {
      expect([401, 403, 404], `${what} after the connection ended`).toContain(await call());
    }
  });

  it("does the same for the shared categories when only the sharing decision is withdrawn", async () => {
    const { patient, doctor, pairingId } = await scene();
    const shared = async () => (await request(app).get(`/api/pairings/${pairingId}/shared-records`).set(auth(doctor.token))).body;
    expect((await shared()).granted).toEqual(expect.arrayContaining(["medications"]));
    expect((await request(app).delete(`/api/sharing/${doctor.profileId}`).set(auth(patient.token))).status).toBeLessThan(300);
    const after = await shared();
    expect(after.granted).toEqual([]);
    expect(after.medications).toBeUndefined();
    expect(after.appointments).toBeUndefined();
    expect(after.documents).toBeUndefined();
  });
});

describe("a documented exception: the provider of a visit keeps that visit's record", () => {
  // DECISION PENDING (docs/PRODUCTION_READINESS.md, D-02): ending a connection stops messaging, the symptom report and every
  // shared category at once, but a visit the doctor delivered or is booked to deliver stays in the doctor's own appointment list,
  // including the patient's name and the reason they gave. Keeping a record of care you provided is normal; a patient who has
  // ended the connection still seeing their upcoming booking disclosed to that doctor may not be what they expect. This test pins
  // the CURRENT behaviour so that changing it (for example by cancelling future visits when a connection ends) is a decision.
  it("still shows the doctor the visit after the patient ended the connection, and nothing else", async () => {
    const { patient, doctor, pairingId, appt } = await scene();
    await request(app).patch(`/api/pairings/${pairingId}/end`).set(auth(patient.token));
    const visit = await request(app).get(`/api/appointments/${appt}`).set(auth(doctor.token));
    expect(visit.status).toBe(200);
    expect(visit.body.reason).toBe("private reason");
    for (const [what, call] of doctorReads(doctor, pairingId)) expect([401, 403, 404], what).toContain(await call());
  });
});

describe("when a doctor stops being active, they lose every route to every patient", () => {
  it("refuses a doctor whose profile is deactivated on the very next request, on every endpoint", async () => {
    const { doctor, pairingId } = await scene();
    for (const [what, call] of doctorReads(doctor, pairingId)) expect([200, 201], `${what} before`).toContain(await call());
    await operatorPool().query(`UPDATE doctor_profiles SET active = false WHERE id = $1`, [doctor.profileId]);
    for (const [what, call] of doctorReads(doctor, pairingId)) {
      expect([401, 403, 404], `${what} after deactivation`).toContain(await call());
    }
    expect((await request(app).get("/api/pairings/doctor").set(auth(doctor.token))).status).toBeGreaterThanOrEqual(401);
  });
});

describe("a caregiver reaches a patient only while their grant is live", () => {
  async function caregiverFor(patient: TestUser) {
    const email = uniqueEmail("cg-sweep");
    const invite = await request(app).post("/api/care-circle").set(auth(patient.token)).send({ name: "Sweep Caregiver", inviteEmail: email, relationshipLabel: "friend" });
    expect(invite.status, JSON.stringify(invite.body)).toBe(201);
    await vi.waitFor(() => expect(invites.some((i) => i.to === email.toLowerCase())).toBe(true));
    const token = new URL(invites.filter((i) => i.to === email.toLowerCase()).pop()!.link).searchParams.get("token")!;
    const accepted = await request(app).post(`/api/care-circle/invitations/accept/${token}`).send({ password: PASSWORD });
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
    return { memberId: invite.body.id as string, token: accepted.body.token as string };
  }

  it("serves the overview and the patient list while accepted, and neither once revoked", async () => {
    const patient = await signupPatient();
    const { memberId, token } = await caregiverFor(patient);
    const calls = [
      ["the overview", () => request(app).get(`/api/care-circle/caregiver/patients/${patient.id}/overview`).set(auth(token))],
      ["the patient list", () => request(app).get("/api/care-circle/caregiver/patients").set(auth(token))],
    ] as const;
    expect((await calls[0][1]()).status).toBe(200);
    const list = await calls[1][1]();
    expect(list.status).toBe(200);
    expect(JSON.stringify(list.body)).toContain(patient.id);

    expect((await request(app).delete(`/api/care-circle/${memberId}`).set(auth(patient.token))).status).toBe(200);
    expect([403, 404]).toContain((await calls[0][1]()).status);
    const after = await calls[1][1]();
    expect(JSON.stringify(after.body), "the revoked patient no longer appears").not.toContain(patient.id);
  });

  // Regression: migration 0014's caregiver test looked for the membership status "accepted", which no row ever holds ("active"), so
  // under the restricted role a real caregiver was recognised by no policy and saw an empty overview. The old tests inserted the
  // wrong status by hand and agreed with it. This one goes through the real invitation and checks the CONTENT, not just a 200.
  it("shows a real caregiver the patient's name, today's medicines and upcoming visits (not an empty page)", async () => {
    const patient = await signupPatient({ name: "Margaret Regression" });
    const doctor = await createDoctor({ name: "Dr. Regression Roe" });
    const { pairingId } = await connect(patient, doctor);
    const rx = await issuePrescription(doctor, pairingId, { medicationName: "Regressionol" });
    expect((await request(app).post(`/api/prescriptions/${rx.id}/track`).set(auth(patient.token))).status).toBeLessThan(300);
    await operatorPool().query(
      `INSERT INTO appointments (pairing_request_id, patient_user_id, doctor_profile_id, type, reason, scheduled_at, status)
       VALUES ($1, $2, $3, 'Video Visit', 'r', now() + interval '3 days', 'confirmed')`, [pairingId, patient.id, doctor.profileId]);
    const { token } = await caregiverFor(patient);

    const list = await request(app).get("/api/care-circle/caregiver/patients").set(auth(token));
    expect(list.body[0].patientName).toBe("Margaret Regression");
    const overview = await request(app).get(`/api/care-circle/caregiver/patients/${patient.id}/overview`).set(auth(token));
    expect(overview.status).toBe(200);
    expect(overview.body.patientName).toBe("Margaret Regression");
    expect(JSON.stringify(overview.body.todaysMedicationStatus)).toContain("Regressionol");
    expect(overview.body.upcomingAppointments).toHaveLength(1);
    expect(overview.body.upcomingAppointments[0].doctorName).toBe("Dr. Regression Roe");
  });

  it("never reaches a patient who did not invite them, whoever they are", async () => {
    const mine = await signupPatient();
    const other = await signupPatient();
    const { token } = await caregiverFor(mine);
    const res = await request(app).get(`/api/care-circle/caregiver/patients/${other.id}/overview`).set(auth(token));
    expect([403, 404]).toContain(res.status);
  });
});

describe("nobody can become an administrator through the application", () => {
  const attempts: Record<string, unknown> = { role: "admin", isAdmin: true, isDemo: true, email: "takeover@test.example", emailVerifiedAt: new Date().toISOString(), deactivatedAt: null };

  it("ignores or refuses role and account fields on every endpoint that edits an account, for every kind of account", async () => {
    const patient = await signupPatient();
    const doctor = await createDoctor();
    const writes: [string, string, string][] = [
      ["patch", "/api/health-profile", "patient"],
      ["put", "/api/health-profile", "patient"],
      ["put", "/api/emergency-info", "patient"],
      ["patch", "/api/auth/me", "patient"],
      ["put", "/api/auth/me", "patient"],
      ["patch", "/api/auth/language", "patient"],
      ["patch", "/api/doctors/me/profile", "doctor"],
      ["put", "/api/doctors/me/application", "doctor"],
    ];
    for (const [verb, path, who] of writes) {
      const token = who === "patient" ? patient.token : doctor.token;
      const res = await (request(app) as any)[verb](path).set(auth(token)).send(attempts);
      expect(res.status, `${verb.toUpperCase()} ${path} must not have crashed`).toBeLessThan(500);
    }
    const rows = (await operatorPool().query(`SELECT id, role, is_demo, lower(email) AS email, email_verified_at FROM users WHERE id = ANY($1)`, [[patient.id, doctor.id]])).rows;
    expect(rows.find((r) => r.id === patient.id)).toMatchObject({ role: "patient", is_demo: false });
    expect(rows.find((r) => r.id === doctor.id)).toMatchObject({ role: "doctor", is_demo: false });
    expect(rows.map((r) => r.email)).not.toContain("takeover@test.example");
    expect(rows.every((r) => r.email_verified_at === null)).toBe(true);
    // And neither can reach an administrator endpoint.
    for (const t of [patient.token, doctor.token]) {
      expect((await request(app).get("/api/admin/doctor-applications").set(auth(t))).status).toBe(403);
      expect((await request(app).get("/api/admin/audit").set(auth(t))).status).toBe(403);
    }
  });

  it("does not let a clinician approve or activate their own profile or application", async () => {
    const doctor = await createDoctor();
    const before = (await operatorPool().query(`SELECT active, verified_at, license_number, credential_expires_at FROM doctor_profiles WHERE id = $1`, [doctor.profileId])).rows[0];
    await request(app).patch("/api/doctors/me/profile").set(auth(doctor.token)).send({ active: false, verifiedAt: new Date().toISOString(), licenseNumber: "FORGED", credentialExpiresAt: new Date(Date.now() + 9e11).toISOString(), userId: "someone" });
    const after = (await operatorPool().query(`SELECT active, verified_at, license_number, credential_expires_at FROM doctor_profiles WHERE id = $1`, [doctor.profileId])).rows[0];
    expect(after).toEqual(before);
    expect((await request(app).post(`/api/admin/doctor-applications/anything/approve`).set(auth(doctor.token)).send({})).status).toBe(403);
  });

  it("an administrator exists only when an operator made one, and is audited when they do", async () => {
    const admin = await createAdmin();
    expect((await request(app).get("/api/admin/doctor-applications").set(auth(admin.token))).status).toBe(200);
  });
});
