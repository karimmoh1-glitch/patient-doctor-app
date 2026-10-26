import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { getApp, signupPatient, createDoctor, createAdmin, createCaregiverAccount, auth, uniqueEmail, PASSWORD, completeSecondFactor } from "./helpers";
import { ROUTER_MOUNTS } from "../server/routes";

let app: Express;
let tokens: Record<string, string>;
beforeAll(async () => {
  app = await getApp();
  const pendingEmail = uniqueEmail("pd");
  const pendingDoctor = (await completeSecondFactor((await request(app).post("/api/doctors/register").send({ name: "Pending Doc", email: pendingEmail, password: PASSWORD })).body, pendingEmail)).token;
  tokens = {
    patient: (await signupPatient()).token,
    doctor: (await createDoctor()).token,
    pendingDoctor,
    admin: (await createAdmin()).token,
    caregiver: (await createCaregiverAccount()).token,
  };
});

// Who may even reach each read-only endpoint. "doctor" is an APPROVED doctor;
// "pendingDoctor" has registered but not been approved. Writing the access down
// means a change to who can see what shows up as a failing test, not a surprise.
const P = "patient", D = "doctor", PD = "pendingDoctor", A = "admin", C = "caregiver";
const EVERYONE = [P, D, PD, A, C];
const MATRIX: Record<string, string[]> = {
  "/api/auth/me": EVERYONE,
  "/api/auth/mfa/status": EVERYONE,
  "/api/config": EVERYONE,
  "/api/doctors": EVERYONE,
  "/api/notifications": EVERYONE,
  "/api/notifications/unread-count": EVERYONE,
  "/api/doctors/me/availability": [D],
  "/api/doctors/me/application": [D, PD],
  "/api/doctors/me/profile": [D],
  "/api/pairings": [P],
  "/api/pairings/doctor": [D],
  "/api/conversations": [P, D],
  "/api/conversations/search": [P, D],
  "/api/pairings/x/symptom-report": [D],
  "/api/pairings/x/shared-records": [D],
  "/api/pairings/x/messages": EVERYONE, // 404 for everyone but the two people in that connection
  "/api/symptom-reports/x/matches": [P],
  "/api/admin/doctor-applications": [A],
  "/api/admin/audit": [A],
  "/api/admin/reminders/status": [A],
  "/api/admin/message-reports": [A],
  "/api/health-profile": [P],
  "/api/health-profile/basic": [P],
  "/api/health-profile/preferences": [P],
  "/api/health-profile/entries": [P],
  "/api/health-profile/entries/x/history": [P],
  "/api/health-profile/consent": [P],
  "/api/health-profile/assist": [P],
  "/api/pairing-invitations": [D],
  "/api/personal-reminders": [P],
  "/api/assist/patients": [D],
  "/api/assist/x": [D],
  "/api/admin/integrations": [A],
  "/api/admin/organizations": [A],
  // Organization routes are for approved clinicians and organization staff (a different kind of account, not in this table);
  // what a clinician may do inside an organization is decided by membership, tested in tests/orgs.test.ts.
  "/api/orgs": [D],
  "/api/orgs/x": [D],
  "/api/orgs/x/dashboard": [D],
  "/api/orgs/x/staff": [D],
  "/api/orgs/x/patients": [D],
  "/api/orgs/x/appointments": [D],
  "/api/orgs/x/tasks": [D],
  "/api/orgs/x/patients/x/notes": [D],
  "/api/orgs/x/audit": [D],
  "/api/my-organizations": [P],
  "/api/admin/credentials": [A],
  "/api/admin/credentials/x/history": [A],
  "/api/appointments": [P],
  "/api/appointments/slots": [P],
  "/api/appointments/doctor": [D],
  "/api/appointments/x": [P, D],
  "/api/appointments/x/video": [P, D],
  "/api/appointments/x/history": [P, D],
  "/api/appointments/x/prepare": [P],
  "/api/prescriptions": [P],
  "/api/prescriptions/doctor": [D],
  "/api/prescriptions/x/history": [D],
  "/api/medications": [P],
  "/api/medications/today": [P],
  "/api/medications/adherence": [P],
  "/api/documents": [P],
  "/api/documents/x/file": EVERYONE, // 404 unless it is the owner's (or a doctor with a live grant)
  "/api/follow-ups": [P],
  "/api/sharing": [P],
  "/api/sharing/shared-with-me": [D],
  "/api/timeline": [P],
  "/api/dashboard": [P],
  "/api/dashboard/doctor": [D],
  "/api/care-circle": [P],
  "/api/care-circle/invitations/validate/x": EVERYONE,
  "/api/care-circle/caregiver/patients": [C],
  "/api/care-circle/caregiver/patients/x/overview": [C],
  "/api/emergency-profile": [P],
  "/api/audit-log": [P],
  "/api/me/export": [P],
  "/api/reminders": [P],
  "/api/cron/reminders": EVERYONE, // 503 here (no secret), 401 with the wrong one: guarded by the secret, not by role
};

function readEndpoints(): string[] {
  const out: string[] = [];
  for (const [prefix, router] of ROUTER_MOUNTS) {
    for (const layer of (router as any).stack) {
      if (layer.route?.methods.get) out.push((prefix + (layer.route.path === "/" ? "" : layer.route.path)).replace(/:[A-Za-z]+/g, "x"));
    }
  }
  return out;
}

describe("who can reach which read-only endpoint", () => {
  it("covers every GET endpoint the server has (a new one must be classified here)", () => {
    expect(readEndpoints().filter((e) => !(e in MATRIX))).toEqual([]);
    expect(Object.keys(MATRIX).filter((e) => !readEndpoints().includes(e))).toEqual([]);
  });

  it("matches the written matrix for patients, doctors, unapproved doctors, administrators and caregivers", async () => {
    const wrong: string[] = [];
    for (const path of readEndpoints()) {
      for (const [role, token] of Object.entries(tokens)) {
        const res = await request(app).get(path).set(auth(token));
        const reachable = res.status !== 403 && res.status !== 401;
        const expected = MATRIX[path]?.includes(role);
        if (reachable !== expected) wrong.push(`${role} ${path}: expected ${expected ? "reachable" : "forbidden"}, got ${res.status}`);
      }
    }
    expect(wrong).toEqual([]);
  });
});
