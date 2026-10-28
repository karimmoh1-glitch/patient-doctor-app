import { describe, it, expect, vi, beforeAll } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { getApp, signupPatient, createDoctor, createCaregiverAccount, auth, uniqueEmail, PASSWORD } from "./helpers";
import { storage } from "../server/storage";
import { db } from "../server/db";
import { careCircleMembers } from "@shared/schema";
import { eq } from "drizzle-orm";

const invites: { to: string; link: string }[] = [];
vi.mock("../server/services/emailService", async (importOriginal) => {
  const original = await importOriginal<typeof import("../server/services/emailService")>();
  return {
    ...original,
    sendCareCircleInviteEmail: async (to: string, _name: string, _patient: string, link: string) => {
      invites.push({ to: to.toLowerCase(), link });
    },
  };
});

let app: Express;
beforeAll(async () => {
  app = await getApp();
});

async function invite(patientToken: string, email: string, extra: Record<string, unknown> = {}) {
  const res = await request(app)
    .post("/api/care-circle")
    .set(auth(patientToken))
    .send({ name: "Sarah", inviteEmail: email, relationshipLabel: "Daughter", ...extra });
  expect(res.status).toBe(201);
  await vi.waitFor(() => expect(invites.some((i) => i.to === email.toLowerCase())).toBe(true));
  const link = invites.filter((i) => i.to === email.toLowerCase()).pop()!.link;
  return { memberId: res.body.id as string, token: new URL(link).searchParams.get("token")! };
}

describe("care circle invitations", () => {
  it("creates a caregiver account only with a new password, and the caregiver sees only what was granted", async () => {
    const patient = await signupPatient();
    const email = uniqueEmail("daughter");
    const { token } = await invite(patient.token, email, { permissionMedicationStatus: true, permissionDocuments: false });

    const accept = await request(app).post("/api/care-circle/invitations/accept").send({ token: token, password: PASSWORD });
    expect(accept.status).toBe(200);
    expect(accept.body.user.role).toBe("caregiver");

    const cg = accept.body.token as string;
    const patients = await request(app).get("/api/care-circle/caregiver/patients").set(auth(cg));
    expect(patients.body).toHaveLength(1);
    expect(patients.body[0].permissions.documents).toBe(false);

    const overview = await request(app).get(`/api/care-circle/caregiver/patients/${patient.id}/overview`).set(auth(cg));
    expect(overview.status).toBe(200);
    expect(JSON.stringify(overview.body)).not.toContain("doctorNotes");
  });

  it("never logs an invite into an existing doctor/admin/patient account", async () => {
    const patient = await signupPatient();
    const victim = await createDoctor();
    const { token } = await invite(patient.token, victim.email);

    const attack = await request(app).post("/api/care-circle/invitations/accept").send({ token: token, password: "any-password-1234" });
    expect(attack.status).toBeGreaterThanOrEqual(400);
    expect(attack.body.token).toBeUndefined();

    // Even with the doctor's real password: a doctor account can't become a caregiver.
    const attack2 = await request(app).post("/api/care-circle/invitations/accept").send({ token: token, password: PASSWORD });
    expect(attack2.status).toBeGreaterThanOrEqual(400);
    expect(attack2.body.token).toBeUndefined();
  });

  it("requires the existing caregiver's own password to attach a second patient", async () => {
    const existing = await createCaregiverAccount();
    const patient = await signupPatient();
    const { token } = await invite(patient.token, existing.email);

    const wrong = await request(app).post("/api/care-circle/invitations/accept").send({ token: token, password: "not-their-password-1" });
    expect(wrong.status).toBe(401);
    expect(wrong.body.token).toBeUndefined();

    const right = await request(app).post("/api/care-circle/invitations/accept").send({ token: token, password: PASSWORD });
    expect(right.status).toBe(200);
    expect(right.body.user.id).toBe(existing.id);
  });

  it("expires after seven days", async () => {
    const patient = await signupPatient();
    const { memberId, token } = await invite(patient.token, uniqueEmail("late"));
    await db.update(careCircleMembers).set({ invitedAt: new Date(Date.now() - 8 * 24 * 3600 * 1000) }).where(eq(careCircleMembers.id, memberId));

    const validate = await request(app).post("/api/care-circle/invitations/validate").send({ token: token });
    expect(validate.status).toBe(404);
    const accept = await request(app).post("/api/care-circle/invitations/accept").send({ token: token, password: PASSWORD });
    expect(accept.status).toBe(404);
  });

  it("can be used only once", async () => {
    const patient = await signupPatient();
    const { token } = await invite(patient.token, uniqueEmail("once"));
    expect((await request(app).post("/api/care-circle/invitations/accept").send({ token: token, password: PASSWORD })).status).toBe(200);
    expect((await request(app).post("/api/care-circle/invitations/accept").send({ token: token, password: PASSWORD })).status).toBe(404);
  });
});

describe("sending an invitation", () => {
  it("gives the patient the real link and says honestly whether an email went out", async () => {
    const patient = await signupPatient();
    const email = uniqueEmail("linkonly");
    const res = await request(app).post("/api/care-circle").set(auth(patient.token)).send({ name: "Tom", inviteEmail: email, relationshipLabel: "Son" });
    expect(res.status).toBe(201);
    // No email provider is configured in tests, so nothing was emailed — and it says so.
    expect(res.body.emailSent).toBe(false);
    const token = new URL(res.body.inviteLink).searchParams.get("token")!;
    const accept = await request(app).post("/api/care-circle/invitations/accept").send({ token: token, password: PASSWORD });
    expect(accept.status).toBe(200);
  });
});

describe("revoking caregiver access", () => {
  it("takes effect on the very next request and is recorded", async () => {
    const patient = await signupPatient();
    const email = uniqueEmail("rev");
    const { memberId, token } = await invite(patient.token, email);
    const accept = await request(app).post("/api/care-circle/invitations/accept").send({ token: token, password: PASSWORD });
    const cg = accept.body.token as string;

    expect((await request(app).get(`/api/care-circle/caregiver/patients/${patient.id}/overview`).set(auth(cg))).status).toBe(200);

    const revoke = await request(app).delete(`/api/care-circle/${memberId}`).set(auth(patient.token));
    expect(revoke.status).toBe(200);

    expect((await request(app).get(`/api/care-circle/caregiver/patients/${patient.id}/overview`).set(auth(cg))).status).toBe(404);
    const member = await storage.getCareCircleMember(memberId);
    expect(member!.status).toBe("revoked");
  });

  it("does not let a patient change or revoke another patient's caregiver", async () => {
    const owner = await signupPatient();
    const other = await signupPatient();
    const { memberId } = await invite(owner.token, uniqueEmail("x"));
    expect((await request(app).delete(`/api/care-circle/${memberId}`).set(auth(other.token))).status).toBe(404);
    expect(
      (await request(app).patch(`/api/care-circle/${memberId}/permissions`).set(auth(other.token)).send({
        permissionMedicationStatus: true, permissionAppointments: true, permissionDeliveryStatus: true, permissionDocuments: true, permissionFullRecords: true,
      })).status,
    ).toBe(404);
  });

  it("does not let a caregiver see a patient who never invited them", async () => {
    const cg = await createCaregiverAccount();
    const patient = await signupPatient();
    expect((await request(app).get(`/api/care-circle/caregiver/patients/${patient.id}/overview`).set(auth(cg.token))).status).toBe(404);
  });
});
