import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { eq, and } from "drizzle-orm";
import { getApp, signupPatient, createDoctor, createAdmin, connect, auth, signIn, completeSecondFactor, uniqueEmail, PASSWORD, type TestUser, type TestDoctor } from "./helpers";
import { db } from "../server/db";
import { runAsSystem } from "../server/dbContext";
import { orgNotes, orgInvitations, orgMemberships, organizations, auditLogs } from "@shared/schema";
import { MATRIX, ORG_ROLES, PERMISSIONS, assignableRoles, can } from "../shared/permissions";

let app: Express;
beforeAll(async () => {
  app = await getApp();
});
const sys = <T,>(f: () => Promise<T>) => runAsSystem(f);
const get = (u: TestUser, path: string) => request(app).get(path).set(auth(u.token));
const post = (u: TestUser, path: string, body: object = {}) => request(app).post(path).set(auth(u.token)).send(body);
const patch = (u: TestUser, path: string, body: object = {}) => request(app).patch(path).set(auth(u.token)).send(body);
const del = (u: TestUser, path: string) => request(app).delete(path).set(auth(u.token));
const tokenOf = (link: string) => link.split("#")[1];

const ORG = { name: "Riverside Clinic", kind: "clinic", country: "US", contactEmail: "front@riverside.example.org", contactPhone: "+1 555 010 2000" };

/** An organization with a doctor-owner, built through the real endpoints. */
async function newOrg(name = "Riverside Clinic") {
  const owner = await createDoctor({ name: `Dr. Owner of ${name}` });
  const made = await post(owner, "/api/orgs", { ...ORG, name });
  expect(made.status).toBe(201);
  return { owner, orgId: made.body.id as string };
}

/** Invites by e-mail and has the invited person create their staff account, as they really would. */
async function addStaff(owner: TestUser, orgId: string, role: string, name = `Staff ${role}`): Promise<TestUser> {
  const email = uniqueEmail(`staff-${role}`);
  const inv = await post(owner, `/api/orgs/${orgId}/staff/invitations`, { email, role });
  expect(inv.status).toBe(201);
  const accepted = await request(app).post("/api/orgs/invitations/accept-new").send({ token: tokenOf(inv.body.link), name, password: PASSWORD });
  expect(accepted.status).toBe(201);
  expect(accepted.body.mfa).toBe("setup"); // no session until the second factor is set up
  const session = await completeSecondFactor(accepted.body, email);
  return { id: session.user.id, email, token: session.token };
}

/** A clinician joining an existing organization with their own clinician account. */
async function addClinician(owner: TestUser, orgId: string, doctor?: TestDoctor): Promise<TestDoctor> {
  const d = doctor ?? (await createDoctor({ name: "Dr. Joiner" }));
  const inv = await post(owner, `/api/orgs/${orgId}/staff/invitations`, { email: d.email, role: "clinician" });
  expect(inv.status).toBe(201);
  expect((await post(d, "/api/orgs/invitations/accept", { token: tokenOf(inv.body.link) })).status).toBe(200);
  return d;
}

describe("the permission matrix", () => {
  it("covers every role and every permission, and keeps patient records out of every organization role", () => {
    expect(Object.keys(MATRIX).sort()).toEqual([...ORG_ROLES].sort());
    for (const role of ORG_ROLES) for (const p of MATRIX[role]) expect(PERMISSIONS).toContain(p);
    // No role can read clinical records through an organization: there is no such permission to give.
    expect(PERMISSIONS.some((p) => /clinical|record|health|message|prescri/.test(p))).toBe(false);
    expect(MATRIX.owner).toEqual(PERMISSIONS);
    expect(can("auditor", "org.audit.view")).toBe(true);
    for (const p of ["org.patients.list", "org.appointments.view", "org.tasks.view", "org.notes.read"] as const) expect(can("auditor", p)).toBe(false);
    expect(can("scheduler", "org.tasks.manage")).toBe(false);
    expect(can("scheduler", "org.notes.read")).toBe(false);
    expect(can("coordinator", "org.staff.invite")).toBe(false);
    expect(can("clinician", "org.audit.view")).toBe(false);
    expect(can(null, "org.view")).toBe(false);
  });

  it("lets only an owner make owners, and an administrator never grant their own level or above", () => {
    expect(assignableRoles("owner")).toEqual([...ORG_ROLES]);
    expect(assignableRoles("admin")).toEqual(["clinician", "coordinator", "scheduler", "auditor"]);
    for (const r of ["clinician", "coordinator", "scheduler", "auditor"] as const) expect(assignableRoles(r)).toEqual([]);
  });
});

describe("starting an organization and inviting people", () => {
  it("is open to an approved clinician only, and starts unverified with them as its owner", async () => {
    const { owner, orgId } = await newOrg();
    const patient = await signupPatient();
    const admin = await createAdmin();
    for (const who of [patient, admin]) expect((await post(who, "/api/orgs", ORG)).status).toBe(403);
    expect((await request(app).post("/api/orgs").send(ORG)).status).toBe(401);
    const mine = (await get(owner, "/api/orgs")).body;
    expect(mine).toEqual([expect.objectContaining({ id: orgId, status: "unverified", role: "owner" })]);
    expect((await post(owner, "/api/orgs", { ...ORG, country: "FR" })).status).toBe(400);
    expect((await post(owner, "/api/orgs", { ...ORG, surprise: 1 })).status).toBe(400);
  });

  it("invites staff by an e-mail-bound link, creates their account with a second factor, and refuses the link twice", async () => {
    const { owner, orgId } = await newOrg();
    const email = uniqueEmail("coord");
    const inv = await post(owner, `/api/orgs/${orgId}/staff/invitations`, { email, role: "coordinator" });
    expect(inv.body.link).toMatch(/\/join-team#[A-Za-z0-9_-]{40,}$/);
    expect(typeof inv.body.emailAccepted).toBe("boolean"); // honest about whether e-mail took it
    const token = tokenOf(inv.body.link);
    const [row] = await sys(() => db.select().from(orgInvitations).where(eq(orgInvitations.id, inv.body.id)));
    expect(JSON.stringify(row)).not.toContain(token); // only a hash is stored
    expect((await request(app).post("/api/orgs/invitations/preview").send({ token })).body).toMatchObject({ role: "coordinator", email, accountExists: false });

    const bad = await request(app).post("/api/orgs/invitations/accept-new").send({ token, name: "Weak", password: "short" });
    expect(bad.status).toBe(400);
    const ok = await request(app).post("/api/orgs/invitations/accept-new").send({ token, name: "Nour Coordinator", password: PASSWORD });
    expect(ok.status).toBe(201);
    expect(ok.body.token).toBeUndefined();
    const again = await request(app).post("/api/orgs/invitations/accept-new").send({ token, name: "Someone Else", password: PASSWORD });
    expect(again.status).toBe(404);
    const session = await completeSecondFactor(ok.body, email);
    expect((await get({ id: "", email, token: session.token }, `/api/orgs/${orgId}`)).body.role).toBe("coordinator");
  });

  it("is not possible for roles that cannot invite, and an administrator cannot hand out administrator", async () => {
    const { owner, orgId } = await newOrg();
    const admin = await addStaff(owner, orgId, "admin");
    const coord = await addStaff(owner, orgId, "coordinator");
    const auditor = await addStaff(owner, orgId, "auditor");
    for (const who of [coord, auditor]) expect((await post(who, `/api/orgs/${orgId}/staff/invitations`, { email: uniqueEmail("x"), role: "scheduler" })).status).toBe(403);
    expect((await post(admin, `/api/orgs/${orgId}/staff/invitations`, { email: uniqueEmail("x"), role: "admin" })).status).toBe(403);
    expect((await post(admin, `/api/orgs/${orgId}/staff/invitations`, { email: uniqueEmail("x"), role: "owner" })).status).toBe(403);
    expect((await post(admin, `/api/orgs/${orgId}/staff/invitations`, { email: uniqueEmail("x"), role: "scheduler" })).status).toBe(201);
  });

  it("will not let someone else use a link meant for another e-mail address", async () => {
    const { owner, orgId } = await newOrg();
    const doctor = await createDoctor();
    const inv = await post(owner, `/api/orgs/${orgId}/staff/invitations`, { email: doctor.email, role: "clinician" });
    const intruder = await createDoctor();
    expect((await post(intruder, "/api/orgs/invitations/accept", { token: tokenOf(inv.body.link) })).status).toBe(404);
    expect((await post(doctor, "/api/orgs/invitations/accept", { token: tokenOf(inv.body.link) })).status).toBe(200);
    expect((await post(doctor, "/api/orgs/invitations/accept", { token: tokenOf(inv.body.link) })).status).toBe(404); // single use
    // A clinician invitation cannot be used to open a staff account.
    const inv2 = await post(owner, `/api/orgs/${orgId}/staff/invitations`, { email: uniqueEmail("c"), role: "clinician" });
    expect((await request(app).post("/api/orgs/invitations/accept-new").send({ token: tokenOf(inv2.body.link), name: "Pretend Staff", password: PASSWORD })).status).toBe(404);
  });

  it("refuses an expired or revoked invitation, answering exactly as for a made-up one", async () => {
    const { owner, orgId } = await newOrg();
    const a = await post(owner, `/api/orgs/${orgId}/staff/invitations`, { email: uniqueEmail("a"), role: "scheduler" });
    const b = await post(owner, `/api/orgs/${orgId}/staff/invitations`, { email: uniqueEmail("b"), role: "scheduler" });
    await sys(() => db.update(orgInvitations).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(orgInvitations.id, a.body.id)));
    expect((await del(owner, `/api/orgs/${orgId}/staff/invitations/${b.body.id}`)).status).toBe(200);
    const answers = [tokenOf(a.body.link), tokenOf(b.body.link), "x".repeat(43)].map((token) => request(app).post("/api/orgs/invitations/preview").send({ token }));
    const results = await Promise.all(answers);
    expect(results.map((r) => r.status)).toEqual([404, 404, 404]);
    expect(new Set(results.map((r) => JSON.stringify(r.body))).size).toBe(1);
  });
});

describe("one organization can never reach another's people or data", () => {
  async function twoOrgs() {
    const a = await newOrg("Org A");
    const b = await newOrg("Org B");
    const coordA = await addStaff(a.owner, a.orgId, "coordinator");
    const coordB = await addStaff(b.owner, b.orgId, "coordinator");
    const patientA = await signupPatient({ name: "Patient Of A" });
    const patientB = await signupPatient({ name: "Patient Of B" });
    const pairA = (await connect(patientA, a.owner as TestDoctor)).pairingId;
    const pairB = (await connect(patientB, b.owner as TestDoctor)).pairingId;
    return { a, b, coordA, coordB, patientA, patientB, pairA, pairB };
  }

  it("shows each organization only its own patients, appointments, tasks and notes", async () => {
    const { a, b, coordA, coordB, patientA, patientB } = await twoOrgs();
    expect((await get(coordA, `/api/orgs/${a.orgId}/patients`)).body.map((p: any) => p.name)).toEqual(["Patient Of A"]);
    expect((await get(coordB, `/api/orgs/${b.orgId}/patients`)).body.map((p: any) => p.name)).toEqual(["Patient Of B"]);
    // A task or a note about the other organization's patient is "not found", exactly as for a stranger.
    expect((await post(coordA, `/api/orgs/${a.orgId}/tasks`, { patientUserId: patientB.id, title: "Call them" })).status).toBe(404);
    expect((await post(coordA, `/api/orgs/${a.orgId}/patients/${patientB.id}/notes`, { body: "Spying" })).status).toBe(404);
    expect((await get(coordA, `/api/orgs/${a.orgId}/patients/${patientB.id}/notes`)).status).toBe(404);
    expect((await post(coordA, `/api/orgs/${a.orgId}/tasks`, { patientUserId: patientA.id, title: "Call them" })).status).toBe(201);
    expect((await get(coordB, `/api/orgs/${b.orgId}/tasks`)).body).toEqual([]);
  });

  it("answers a request for another organization (or one that does not exist) identically: not found", async () => {
    const { a, b, coordA } = await twoOrgs();
    const paths = ["", "/dashboard", "/staff", "/patients", "/appointments", "/tasks", "/audit"];
    for (const path of paths) {
      const other = await get(coordA, `/api/orgs/${b.orgId}${path}`);
      const none = await get(coordA, `/api/orgs/00000000-0000-0000-0000-000000000000${path}`);
      expect([other.status, none.status], path).toEqual([404, 404]);
      expect(other.body, path).toEqual(none.body);
    }
    expect((await patch(coordA, `/api/orgs/${b.orgId}`, { name: "Hijacked" })).status).toBe(404);
    expect((await post(coordA, `/api/orgs/${b.orgId}/staff/invitations`, { email: uniqueEmail("x"), role: "scheduler" })).status).toBe(404);
    void a;
  });

  it("does not let a task be assigned to someone outside the organization, or touched by another organization", async () => {
    const { a, b, coordA, coordB, patientA } = await twoOrgs();
    const t = (await post(coordA, `/api/orgs/${a.orgId}/tasks`, { patientUserId: patientA.id, title: "Follow up", dueDate: "2026-01-01" })).body;
    expect((await post(coordA, `/api/orgs/${a.orgId}/tasks`, { patientUserId: patientA.id, title: "Mine", assignedToUserId: coordB.id })).status).toBe(400);
    expect((await patch(coordB, `/api/orgs/${b.orgId}/tasks/${t.id}`, { status: "done" })).status).toBe(404);
    expect((await patch(coordB, `/api/orgs/${a.orgId}/tasks/${t.id}`, { status: "done" })).status).toBe(404);
  });

  it("gives staff no route into any clinical record, message or health information", async () => {
    const { a, coordA, patientA, pairA } = await twoOrgs();
    for (const [method, path] of [
      ["get", "/api/pairings/doctor"], ["get", `/api/pairings/${pairA}/messages`], ["get", "/api/health-profile"], ["get", `/api/assist/${patientA.id}`],
      ["get", "/api/prescriptions"], ["get", "/api/appointments/doctor"], ["get", "/api/personal-reminders"], ["get", "/api/documents"], ["get", "/api/admin/doctor-applications"],
    ] as const) {
      const res = await (request(app) as any)[method](path).set(auth(coordA.token));
      expect([401, 403, 404], `${method} ${path}`).toContain(res.status);
    }
    void a;
  });

  it("answers organization endpoints with 'forbidden' to patients, administrators and the signed-out", async () => {
    const { a } = await twoOrgs();
    const patient = await signupPatient();
    const admin = await createAdmin();
    expect((await get(patient, `/api/orgs/${a.orgId}`)).status).toBe(403);
    expect((await get(admin, `/api/orgs/${a.orgId}/staff`)).status).toBe(403);
    expect((await request(app).get(`/api/orgs/${a.orgId}`)).status).toBe(401);
  });
});

describe("what staff can see of a patient, and the patient's say", () => {
  it("is a name and appointment times, never a reason, and the patient can hide from staff while the clinician keeps their own patient", async () => {
    const { owner, orgId } = await newOrg();
    const coord = await addStaff(owner, orgId, "coordinator");
    const clinician = await addClinician(owner, orgId);
    const patient = await signupPatient({ name: "Visible Vera" });
    const { pairingId } = await connect(patient, clinician);
    await post(clinician, "/api/doctors/me/availability".replace("/me/availability", "/me/availability"), {}).catch(() => {});
    // An appointment with a private reason.
    const when = new Date(Date.now() + 3 * 86_400_000);
    when.setUTCMinutes(0, 0, 0);
    await sys(async () => {
      const { storage } = await import("../server/storage");
      await storage.createAppointment({ pairingRequestId: pairingId, patientUserId: patient.id, doctorProfileId: clinician.profileId, type: "Phone Call", reason: "Very private reason", scheduledAt: when, durationMinutes: 30, status: "confirmed" } as any);
    });
    const seen = (await get(coord, `/api/orgs/${orgId}/appointments`)).body;
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ patientName: "Visible Vera", status: "confirmed" });
    expect(JSON.stringify(seen)).not.toContain("Very private reason");
    expect(Object.keys(seen[0]).sort()).toEqual(["doctorName", "durationMinutes", "id", "patientName", "scheduledAt", "status", "type"]);

    // The patient is told which organization's staff can see this, and turns it off.
    const mine = (await get(patient, "/api/my-organizations")).body;
    expect(mine).toEqual([expect.objectContaining({ pairingId, organizationName: "Riverside Clinic", staffCanSee: true })]);
    expect((await request(app).put(`/api/my-organizations/${pairingId}`).set(auth((await signupPatient()).token)).send({ visible: false })).status).toBe(404); // not theirs
    expect((await request(app).put(`/api/my-organizations/${pairingId}`).set(auth(patient.token)).send({ visible: false })).status).toBe(200);
    expect((await get(coord, `/api/orgs/${orgId}/appointments`)).body).toEqual([]);
    expect((await get(coord, `/api/orgs/${orgId}/patients`)).body).toEqual([]);
    // The clinician's own patient stays theirs.
    expect((await get(clinician, `/api/orgs/${orgId}/patients`)).body.map((p: any) => p.name)).toEqual(["Visible Vera"]);
    expect((await post(coord, `/api/orgs/${orgId}/tasks`, { patientUserId: patient.id, title: "Valid title" })).status).toBe(404);
    expect((await post(clinician, `/api/orgs/${orgId}/tasks`, { patientUserId: patient.id, title: "My follow-up" })).status).toBe(201);
  });

  it("keeps notes internal: append-only, never readable by the patient, and a read is recorded", async () => {
    const { owner, orgId } = await newOrg();
    const coord = await addStaff(owner, orgId, "coordinator");
    const patient = await signupPatient();
    await connect(patient, owner as TestDoctor);
    const note = await post(coord, `/api/orgs/${orgId}/patients/${patient.id}/notes`, { body: "Prefers morning calls" });
    expect(note.status).toBe(201);
    expect((await get(coord, `/api/orgs/${orgId}/patients/${patient.id}/notes`)).body.map((n: any) => n.body)).toEqual(["Prefers morning calls"]);
    // The patient has no way to read it.
    expect((await get(patient, `/api/orgs/${orgId}/patients/${patient.id}/notes`)).status).toBe(403);
    expect(JSON.stringify((await get(patient, "/api/me/export")).body)).not.toContain("Prefers morning calls");
    // Append-only at the database.
    await expect(sys(() => db.update(orgNotes).set({ body: "edited" }).where(eq(orgNotes.orgId, orgId)))).rejects.toThrow();
    await expect(sys(() => db.delete(orgNotes).where(eq(orgNotes.orgId, orgId)))).rejects.toThrow();
    // The audit entry says a note was written and read, and not what it said.
    const rows = await sys(() => db.select().from(auditLogs).where(eq(auditLogs.subjectUserId, patient.id)));
    expect(rows.map((r) => r.action)).toEqual(expect.arrayContaining(["org.note_added", "org.notes_read"]));
    expect(JSON.stringify(rows)).not.toContain("Prefers morning calls");
  });
});

describe("tasks and who may do what", () => {
  it("lets a coordinator create, assign and complete tasks; a scheduler only look; and flags overdue ones", async () => {
    const { owner, orgId } = await newOrg();
    const coord = await addStaff(owner, orgId, "coordinator");
    const sched = await addStaff(owner, orgId, "scheduler");
    const patient = await signupPatient({ name: "Task Person" });
    await connect(patient, owner as TestDoctor);
    const overdue = (await post(coord, `/api/orgs/${orgId}/tasks`, { patientUserId: patient.id, title: "Send forms", dueDate: "2020-01-01", assignedToUserId: coord.id })).body;
    await post(coord, `/api/orgs/${orgId}/tasks`, { patientUserId: patient.id, title: "Call later", dueDate: "2999-01-01" });
    expect((await post(sched, `/api/orgs/${orgId}/tasks`, { patientUserId: patient.id, title: "Nope" })).status).toBe(403);
    const list = (await get(sched, `/api/orgs/${orgId}/tasks`)).body;
    expect(list.map((t: any) => [t.title, t.overdue])).toEqual([["Send forms", true], ["Call later", false]]);
    expect(list[0].assignedToName).toBe("Staff coordinator");
    expect((await patch(sched, `/api/orgs/${orgId}/tasks/${overdue.id}`, { status: "done" })).status).toBe(403);
    expect((await patch(coord, `/api/orgs/${orgId}/tasks/${overdue.id}`, { status: "done" })).status).toBe(200);
    expect((await get(coord, `/api/orgs/${orgId}/tasks?status=done`)).body.map((t: any) => t.title)).toEqual(["Send forms"]);
    expect((await post(coord, `/api/orgs/${orgId}/tasks`, { patientUserId: patient.id, title: "x" })).status).toBe(400); // too short
  });

  it("returns a removed person's open tasks to 'unassigned' and cuts their access at once", async () => {
    const { owner, orgId } = await newOrg();
    const coord = await addStaff(owner, orgId, "coordinator");
    const patient = await signupPatient();
    await connect(patient, owner as TestDoctor);
    await post(coord, `/api/orgs/${orgId}/tasks`, { patientUserId: patient.id, title: "Mine to do", assignedToUserId: coord.id });
    const members = (await get(owner, `/api/orgs/${orgId}/staff`)).body.members;
    const m = members.find((x: any) => x.userId === coord.id);
    expect((await del(owner, `/api/orgs/${orgId}/staff/${m.id}`)).status).toBe(200);
    expect((await get(coord, `/api/orgs/${orgId}/tasks`)).status).toBe(404); // the same token no longer opens anything
    expect((await get(owner, `/api/orgs/${orgId}/tasks`)).body[0]).toMatchObject({ title: "Mine to do", assignedToUserId: null });
  });
});

describe("staff, roles and the last owner", () => {
  it("never leaves an organization without an owner, and an administrator cannot touch an owner or another administrator", async () => {
    const { owner, orgId } = await newOrg();
    const admin = await addStaff(owner, orgId, "admin");
    const admin2 = await addStaff(owner, orgId, "admin", "Second admin");
    const ids = async () => (await get(owner, `/api/orgs/${orgId}/staff`)).body.members as { id: string; userId: string }[];
    const ownerM = (await ids()).find((m) => m.userId === owner.id)!;
    const admin2M = (await ids()).find((m) => m.userId === admin2.id)!;
    expect((await del(owner, `/api/orgs/${orgId}/staff/${ownerM.id}`)).status).toBe(409); // the only owner
    expect((await patch(owner, `/api/orgs/${orgId}/staff/${ownerM.id}`, { role: "admin" })).status).toBe(409);
    expect((await patch(admin, `/api/orgs/${orgId}/staff/${ownerM.id}`, { role: "scheduler" })).status).toBe(403);
    expect((await del(admin, `/api/orgs/${orgId}/staff/${ownerM.id}`)).status).toBe(403);
    expect((await patch(admin, `/api/orgs/${orgId}/staff/${admin2M.id}`, { role: "auditor" })).status).toBe(403);
    expect((await patch(admin, `/api/orgs/${orgId}/staff/${admin2M.id}`, { role: "owner" })).status).toBe(403);
    // With a second owner, the first may step down.
    expect((await patch(owner, `/api/orgs/${orgId}/staff/${admin2M.id}`, { role: "owner" })).status).toBe(200);
    expect((await del(admin2, `/api/orgs/${orgId}/staff/${ownerM.id}`)).status).toBe(200);
    expect((await get(owner, `/api/orgs/${orgId}`)).status).toBe(404);
  });

  it("shows e-mail addresses only to those who may invite", async () => {
    const { owner, orgId } = await newOrg();
    const auditor = await addStaff(owner, orgId, "auditor");
    expect((await get(owner, `/api/orgs/${orgId}/staff`)).body.members.every((m: any) => !!m.email)).toBe(true);
    expect((await get(auditor, `/api/orgs/${orgId}/staff`)).body.members.every((m: any) => m.email === null)).toBe(true);
  });
});

describe("audit and the dashboard", () => {
  it("lets an auditor read what the organization's own staff did and nobody else's, and no patient data", async () => {
    const { owner, orgId } = await newOrg();
    const coord = await addStaff(owner, orgId, "coordinator");
    const auditor = await addStaff(owner, orgId, "auditor");
    const patient = await signupPatient();
    await connect(patient, owner as TestDoctor);
    await post(coord, `/api/orgs/${orgId}/tasks`, { patientUserId: patient.id, title: "Secret errand" });
    const outsider = await createDoctor();
    await sys(async () => { const { logAudit } = await import("../server/services/auditService"); await logAudit({ actorUserId: outsider.id, action: "outsider.did_something", targetType: "x", targetId: "1" }); });
    const rows = (await get(auditor, `/api/orgs/${orgId}/audit`)).body;
    expect(rows.map((r: any) => r.action)).toContain("org.task_created");
    expect(rows.some((r: any) => r.action === "outsider.did_something")).toBe(false);
    expect(JSON.stringify(rows)).not.toContain("Secret errand");
    expect(Object.keys(rows[0]).sort()).toEqual(["action", "actorName", "actorUserId", "createdAt", "id", "targetType"]);
    expect((await get(auditor, `/api/orgs/${orgId}/audit?action=org.task`)).body.every((r: any) => r.action.startsWith("org.task"))).toBe(true);
    expect((await get(auditor, `/api/orgs/${orgId}/audit?actor=${outsider.id}`)).body).toEqual([]);
    for (const who of [coord, owner]) void who;
    expect((await get(coord, `/api/orgs/${orgId}/audit`)).status).toBe(403);
    expect((await get(auditor, `/api/orgs/${orgId}/patients`)).status).toBe(403);
    expect((await get(auditor, `/api/orgs/${orgId}/tasks`)).status).toBe(403);
  });

  it("reports real counts, and only what the role may see", async () => {
    const { owner, orgId } = await newOrg();
    const coord = await addStaff(owner, orgId, "coordinator");
    const auditor = await addStaff(owner, orgId, "auditor");
    const empty = (await get(owner, `/api/orgs/${orgId}/dashboard`)).body;
    expect(empty.patients).toEqual({ count: 0 });
    expect(empty.tasks).toEqual({ open: 0, overdue: 0, unassigned: 0, doneLast7Days: 0 });
    expect(empty.staff.total).toBe(3);

    const p1 = await signupPatient();
    const p2 = await signupPatient();
    await connect(p1, owner as TestDoctor);
    await connect(p2, owner as TestDoctor);
    await post(coord, `/api/orgs/${orgId}/tasks`, { patientUserId: p1.id, title: "Overdue one", dueDate: "2020-05-05" });
    await post(coord, `/api/orgs/${orgId}/tasks`, { patientUserId: p2.id, title: "Open one", assignedToUserId: coord.id });
    const done = (await post(coord, `/api/orgs/${orgId}/tasks`, { patientUserId: p2.id, title: "Done one" })).body;
    await patch(coord, `/api/orgs/${orgId}/tasks/${done.id}`, { status: "done" });
    const d = (await get(coord, `/api/orgs/${orgId}/dashboard`)).body;
    expect(d.patients.count).toBe(2);
    expect(d.tasks).toEqual({ open: 2, overdue: 1, unassigned: 1, doneLast7Days: 1 });
    // An auditor's dashboard has no patient numbers at all.
    const a = (await get(auditor, `/api/orgs/${orgId}/dashboard`)).body;
    expect(a.patients).toBeUndefined();
    expect(a.tasks).toBeUndefined();
    expect(a.appointments).toBeUndefined();
  });
});

describe("verification and suspension by Avela's reviewers", () => {
  it("needs evidence to call an organization verified, and a suspended one can be looked at but not changed", async () => {
    const { owner, orgId } = await newOrg();
    const admin = await createAdmin();
    const coord = await addStaff(owner, orgId, "coordinator");
    expect((await post(owner, `/api/admin/organizations/${orgId}/verify`, { source: "document_review", evidenceNote: "x".repeat(20) })).status).toBe(403);
    expect((await post(admin, `/api/admin/organizations/${orgId}/verify`, { source: "document_review", evidenceNote: "ok" })).status).toBe(400);
    await expect(sys(() => db.update(organizations).set({ status: "verified" }).where(eq(organizations.id, orgId)))).rejects.toThrow(); // CHECK constraint
    const verified = await post(admin, `/api/admin/organizations/${orgId}/verify`, { source: "registry_lookup", evidenceNote: "Found in the national register under this name." });
    expect(verified.body).toMatchObject({ status: "verified", verificationSource: "registry_lookup" });
    expect((await get(owner, `/api/orgs/${orgId}`)).body.status).toBe("verified");

    expect((await post(admin, `/api/admin/organizations/${orgId}/suspend`, { note: "Reported fraudulent" })).status).toBe(200);
    expect((await get(owner, `/api/orgs/${orgId}`)).status).toBe(200);
    expect((await patch(owner, `/api/orgs/${orgId}`, { name: "New name" })).status).toBe(403);
    expect((await get(coord, `/api/orgs/${orgId}/tasks`)).status).toBe(403);
    expect((await post(owner, `/api/orgs/${orgId}/staff/invitations`, { email: uniqueEmail("n"), role: "scheduler" })).status).toBe(403);
  });
});

describe("staff sign in", () => {
  it("require a second factor like clinicians: the password alone gives no session", async () => {
    const { owner, orgId } = await newOrg();
    const staff = await addStaff(owner, orgId, "scheduler");
    const login = await request(app).post("/api/auth/login").send({ email: staff.email, password: PASSWORD });
    expect(login.body.mfa).toBe("verify");
    expect(login.body.token).toBeUndefined();
    const full = await signIn(staff.email);
    expect(full.user.role).toBe("staff");
    void and;
    void orgMemberships;
  });
});

describe("closing a patient's account", () => {
  it("erases what staff wrote about them, and cancels their open tasks", async () => {
    const pg = (await import("pg")).default;
    const ownerPool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
    try {
      const { eraseUser } = await import("../server/services/erasure");
      const { owner, orgId } = await newOrg();
      const coord = await addStaff(owner, orgId, "coordinator");
      const patient = await signupPatient();
      await connect(patient, owner as TestDoctor);
      await post(coord, `/api/orgs/${orgId}/patients/${patient.id}/notes`, { body: "Has a dog called Biscuit" });
      await post(coord, `/api/orgs/${orgId}/tasks`, { patientUserId: patient.id, title: "Ask about Biscuit" });
      await eraseUser(ownerPool, patient.id);
      const notes = (await ownerPool.query("SELECT body FROM org_notes WHERE patient_user_id = $1", [patient.id])).rows.map((r) => r.body);
      const tasks = (await ownerPool.query("SELECT title, status FROM org_tasks WHERE patient_user_id = $1", [patient.id])).rows;
      expect(notes).toEqual(["[erased]"]);
      expect(tasks).toEqual([{ title: "[erased]", status: "cancelled" }]);
    } finally {
      await ownerPool.end();
    }
  });
});
