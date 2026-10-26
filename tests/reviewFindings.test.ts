import { describe, it, expect, vi, beforeAll, afterEach } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { eq } from "drizzle-orm";

const provider = vi.hoisted(() => ({ sent: [] as { to: string[]; text: string }[] }));
vi.mock("resend", () => ({
  Resend: class {
    emails = { send: async (m: any) => { provider.sent.push(m); return { data: { id: `msg_${Math.random().toString(36).slice(2)}` }, error: null }; } };
  },
}));

import { getApp, signupPatient, createDoctor, createAdmin, connect, auth, completeSecondFactor, uniqueEmail, PASSWORD, type TestUser, type TestDoctor } from "./helpers";
import { db } from "../server/db";
import { runAsSystem } from "../server/dbContext";
import { notifications, organizations, orgMemberships, healthEntries, allergyStatements } from "@shared/schema";
import { CONSENT_VERSION } from "../server/services/healthProfile";
import { signupPatient as _sp } from "./helpers";
void _sp;

let app: Express;
beforeAll(async () => {
  app = await getApp();
});
afterEach(() => {
  delete process.env.RESEND_API_KEY;
  provider.sent.length = 0;
});
const sys = <T,>(f: () => Promise<T>) => runAsSystem(f);
const get = (u: TestUser, path: string) => request(app).get(path).set(auth(u.token));
const post = (u: TestUser, path: string, body: object = {}) => request(app).post(path).set(auth(u.token)).send(body);
const patch = (u: TestUser, path: string, body: object = {}) => request(app).patch(path).set(auth(u.token)).send(body);
const del = (u: TestUser, path: string) => request(app).delete(path).set(auth(u.token));
const tokenOf = (link: string) => link.split("#")[1];
const ORG = { name: "Review Clinic", kind: "clinic", country: "US" };

async function newOrg(name = "Review Clinic") {
  const owner = await createDoctor({ name: `Dr. Owner ${name}` });
  const made = await post(owner, "/api/orgs", { ...ORG, name });
  return { owner, orgId: made.body.id as string };
}
async function addStaff(owner: TestUser, orgId: string, role: string): Promise<TestUser> {
  const email = uniqueEmail(`rv-${role}`);
  const inv = await post(owner, `/api/orgs/${orgId}/staff/invitations`, { email, role });
  const accepted = await request(app).post("/api/orgs/invitations/accept-new").send({ token: tokenOf(inv.body.link), name: `Staff ${role}`, password: PASSWORD });
  const session = await completeSecondFactor(accepted.body, email);
  return { id: session.user.id, email, token: session.token };
}

describe("invitations: who holds the link, and what an inviter can learn", () => {
  it("e-mails the link for a verified organization and does NOT hand it to the inviter; an unverified one gets no e-mail and the inviter hands it over", async () => {
    process.env.RESEND_API_KEY = "re_test";
    const { owner, orgId } = await newOrg("Verified Clinic");
    const unverified = await post(owner, `/api/orgs/${orgId}/staff/invitations`, { email: uniqueEmail("u"), role: "coordinator" });
    expect(unverified.body).toMatchObject({ emailAllowed: false, emailAccepted: false });
    expect(unverified.body.link).toMatch(/\/join-team#/);
    expect(provider.sent).toHaveLength(0);

    const admin = await createAdmin();
    await post(admin, `/api/admin/organizations/${orgId}/verify`, { source: "document_review", evidenceNote: "Registration certificate seen." });
    const email = uniqueEmail("v");
    const verified = await post(owner, `/api/orgs/${orgId}/staff/invitations`, { email, role: "coordinator" });
    expect(verified.body).toMatchObject({ emailAllowed: true, emailAccepted: true, link: null });
    // The inviter never sees the token; only the mailbox does.
    expect(JSON.stringify(verified.body)).not.toMatch(/join-team/);
    const mailed = provider.sent.find((m) => m.to.includes(email));
    expect(mailed?.text).toMatch(/join-team#[A-Za-z0-9_-]{40,}/);
  });

  it("does not reveal whether an address has an account of another kind", async () => {
    const { owner, orgId } = await newOrg();
    const patient = await signupPatient();
    const stranger = uniqueEmail("nobody");
    const a = await post(owner, `/api/orgs/${orgId}/staff/invitations`, { email: patient.email, role: "coordinator" });
    const b = await post(owner, `/api/orgs/${orgId}/staff/invitations`, { email: stranger, role: "coordinator" });
    expect([a.status, b.status]).toEqual([201, 201]);
    // The patient cannot use it: accepting needs a staff account.
    expect((await post(patient, "/api/orgs/invitations/accept", { token: tokenOf(a.body.link) })).status).toBe(403);
  });

  it("limits how many invitations an organization can have waiting", async () => {
    const { owner, orgId } = await newOrg();
    let last = 0;
    for (let i = 0; i < 31; i++) last = (await post(owner, `/api/orgs/${orgId}/staff/invitations`, { email: uniqueEmail(`cap${i}`), role: "scheduler" })).status;
    expect(last).toBe(429);
  });

  it("does not consume an invitation for someone who is already a member", async () => {
    const { owner, orgId } = await newOrg();
    const clinician = await createDoctor();
    const first = await post(owner, `/api/orgs/${orgId}/staff/invitations`, { email: clinician.email, role: "clinician" });
    expect((await post(clinician, "/api/orgs/invitations/accept", { token: tokenOf(first.body.link) })).status).toBe(200);
    // A fresh invitation to the same person now says so (they are on the staff list the inviter can see).
    expect((await post(owner, `/api/orgs/${orgId}/staff/invitations`, { email: clinician.email, role: "clinician" })).status).toBe(409);
  });
});

describe("roles, owners and leaving", () => {
  it("never ends up with no owner when two owners remove each other at the same moment", async () => {
    const { owner, orgId } = await newOrg();
    const second = await addStaff(owner, orgId, "admin");
    const members = async () => (await get(owner, `/api/orgs/${orgId}/staff`)).body.members as { id: string; userId: string }[];
    const secondM = (await members()).find((m) => m.userId === second.id)!;
    expect((await patch(owner, `/api/orgs/${orgId}/staff/${secondM.id}`, { role: "owner" })).status).toBe(200);
    const ownerM = (await members()).find((m) => m.userId === owner.id)!;
    const results = await Promise.all([del(owner, `/api/orgs/${orgId}/staff/${secondM.id}`), del(second, `/api/orgs/${orgId}/staff/${ownerM.id}`)]);
    // One wins. The other finds its target already gone (404) or would leave no owner (409): either way, not 200.
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status !== 200).every((r) => [404, 409].includes(r.status))).toBe(true);
    const owners = await sys(() => db.select().from(orgMemberships).where(eq(orgMemberships.orgId, orgId))).then((rows) => rows.filter((r) => r.role === "owner" && r.status === "active"));
    expect(owners).toHaveLength(1);
  });

  it("keeps doctor accounts to clinician-side roles and staff accounts to desk roles", async () => {
    const { owner, orgId } = await newOrg();
    const clinician = await createDoctor();
    const inv = await post(owner, `/api/orgs/${orgId}/staff/invitations`, { email: clinician.email, role: "clinician" });
    await post(clinician, "/api/orgs/invitations/accept", { token: tokenOf(inv.body.link) });
    const coord = await addStaff(owner, orgId, "coordinator");
    const rows = (await get(owner, `/api/orgs/${orgId}/staff`)).body.members as { id: string; userId: string }[];
    expect((await patch(owner, `/api/orgs/${orgId}/staff/${rows.find((m) => m.userId === clinician.id)!.id}`, { role: "coordinator" })).status).toBe(409);
    expect((await patch(owner, `/api/orgs/${orgId}/staff/${rows.find((m) => m.userId === coord.id)!.id}`, { role: "clinician" })).status).toBe(409);
  });

  it("lets any member leave, and the last owner not", async () => {
    const { owner, orgId } = await newOrg();
    const clinician = await createDoctor();
    const inv = await post(owner, `/api/orgs/${orgId}/staff/invitations`, { email: clinician.email, role: "clinician" });
    await post(clinician, "/api/orgs/invitations/accept", { token: tokenOf(inv.body.link) });
    expect((await del(clinician, `/api/orgs/${orgId}/membership`)).status).toBe(200);
    expect((await get(clinician, `/api/orgs/${orgId}`)).status).toBe(404);
    expect((await del(owner, `/api/orgs/${orgId}/membership`)).status).toBe(409);
  });

  it("takes verification away when an organization changes what it is", async () => {
    const { owner, orgId } = await newOrg("Old Name Clinic");
    const admin = await createAdmin();
    await post(admin, `/api/admin/organizations/${orgId}/verify`, { source: "registry_lookup", evidenceNote: "Found in the register under this name." });
    expect((await patch(owner, `/api/orgs/${orgId}`, { contactPhone: "+1 555 010 3000" })).body.status).toBe("verified");
    expect((await patch(owner, `/api/orgs/${orgId}`, { name: "Cairo University Hospital" })).body.status).toBe("unverified");
    const [row] = await sys(() => db.select().from(organizations).where(eq(organizations.id, orgId)));
    expect(row.status).toBe("unverified");
  });
});

describe("activity belongs to the organization it happened in", () => {
  it("shows an auditor only events recorded for their own organization, not a member's work elsewhere or after they left", async () => {
    const a = await newOrg("Org A");
    const b = await newOrg("Org B");
    const shared = await createDoctor();
    for (const o of [a, b]) {
      const inv = await post(o.owner, `/api/orgs/${o.orgId}/staff/invitations`, { email: shared.email, role: "clinician" });
      await post(shared, "/api/orgs/invitations/accept", { token: tokenOf(inv.body.link) });
    }
    const auditorA = await addStaff(a.owner, a.orgId, "auditor");
    const coordB = await addStaff(b.owner, b.orgId, "coordinator");
    const patient = await signupPatient();
    await connect(patient, b.owner as TestDoctor);
    await post(coordB, `/api/orgs/${b.orgId}/tasks`, { patientUserId: patient.id, title: "Work in organization B" });
    await post(shared, `/api/orgs/${b.orgId}/tasks`, { patientUserId: (await signupPatient()).id, title: "Not mine" }); // refused, but attempted
    const seen = (await get(auditorA, `/api/orgs/${a.orgId}/audit`)).body as { action: string; actorUserId: string }[];
    expect(seen.some((r) => r.actorUserId === coordB.id)).toBe(false);
    expect(seen.some((r) => r.action === "org.task_created")).toBe(false);
    // Their own organization's events are there.
    expect(seen.some((r) => r.action === "org.staff_invited")).toBe(true);
    // And an actor filter cannot be used to look at someone else's work in another organization.
    expect((await get(auditorA, `/api/orgs/${a.orgId}/audit?actor=${coordB.id}`)).body).toEqual([]);
  });
});

describe("the patient is told, and the code preview discloses it", () => {
  it("tells connected patients when their clinician joins an organization, and a new patient at connection", async () => {
    const owner = await createDoctor({ name: "Dr. Joins" });
    const early = await signupPatient();
    await connect(early, owner);
    const made = await post(owner, "/api/orgs", { ...ORG, name: "Notice Clinic" });
    expect(made.status).toBe(201);
    const notes = async (u: TestUser) => (await sys(() => db.select().from(notifications).where(eq(notifications.userId, u.id)))).filter((n) => n.kind === "org.staff_visibility");
    expect((await notes(early)).map((n) => n.params)).toEqual([{ doctorName: "Dr. Joins", orgName: "Notice Clinic" }]);
    // A later connection, by a code, is told when it is made, and shown at the preview.
    const created = await post(owner, "/api/pairing-invitations");
    const late = await signupPatient();
    const preview = await post(late, "/api/pairing-invitations/preview", { token: tokenOf(created.body.url) });
    expect(preview.body.organizations).toEqual(["Notice Clinic"]);
    expect((await post(late, "/api/pairing-invitations/accept", { token: tokenOf(created.body.url), confirm: true })).status).toBe(201);
    expect((await notes(late)).map((n) => n.params)).toEqual([{ doctorName: "Dr. Joins", orgName: "Notice Clinic" }]);
  });
});

describe("health information: what a patient cannot replace", () => {
  const consent = (u: TestUser) => post(u, "/api/health-profile/consent", { version: CONSENT_VERSION });
  async function connectedWithGrant() {
    const patient = await signupPatient();
    await consent(patient);
    const doctor = await createDoctor();
    await connect(patient, doctor);
    await post(patient, "/api/health-profile/assist", { doctorProfileId: doctor.profileId, days: 7 });
    return { patient, doctor };
  }

  it("will not let a patient amend an entry a clinician entered or checked, and will not let them overwrite a reviewed allergy statement", async () => {
    const { patient, doctor } = await connectedWithGrant();
    const entered = (await post(doctor, `/api/assist/${patient.id}/entries`, { kind: "allergy", data: { substance: "Penicillin", severity: "severe" } })).body;
    await post(doctor, `/api/assist/${patient.id}/entries/${entered.id}/verify`);
    const tryAmend = await post(patient, `/api/health-profile/entries/${entered.id}/amend`, { data: { substance: "Penicillin", severity: "mild" } });
    expect(tryAmend.status).toBe(409);
    expect(tryAmend.body.code).toBe("dispute_instead");
    expect((await get(patient, "/api/health-profile/entries?kind=allergy")).body[0].data.severity).toBe("severe");

    const other = await connectedWithGrant();
    await post(other.doctor, `/api/assist/${other.patient.id}/allergies/statement`, { state: "none_known" }).catch(() => {});
    await request(app).put(`/api/assist/${other.patient.id}/allergies/statement`).set(auth(other.doctor.token)).send({ state: "none_known" });
    expect((await request(app).put("/api/health-profile/allergies/statement").set(auth(other.patient.token)).send({ state: "unknown" })).status).toBe(409);
    expect((await request(app).delete("/api/health-profile/allergies/statement").set(auth(other.patient.token))).status).toBe(409);
  });

  it("lets a clinician see what an amendment replaced", async () => {
    const { patient, doctor } = await connectedWithGrant();
    const own = (await post(patient, "/api/health-profile/entries", { kind: "condition", data: { name: "Asthma" } })).body;
    const amended = (await post(doctor, `/api/assist/${patient.id}/entries/${own.id}/amend`, { data: { name: "Asthma (mild)" } })).body;
    const history = await get(doctor, `/api/assist/${patient.id}/entries/${own.id}/history`);
    expect(history.status).toBe(200);
    expect(history.body.map((h: any) => h.action)).toEqual(["created", "amended"]);
    expect(amended.amended).toBe(true);
    void healthEntries;
    void allergyStatements;
  });
});

describe("a staff account reaches nothing outside the organization area", () => {
  it("is refused by every other endpoint that is not open to every signed-in person", async () => {
    const { ROUTER_MOUNTS } = await import("../server/routes");
    const { owner, orgId } = await newOrg();
    const coord = await addStaff(owner, orgId, "coordinator");
    const OPEN_TO_ALL_SIGNED_IN = new Set(["/api/auth/me", "/api/auth/mfa/status", "/api/config", "/api/notifications", "/api/notifications/unread-count", "/api/audit-log", "/api/doctors", "/api/cron/reminders"]); // the scheduler endpoint is guarded by its own secret, not by role
    const reached: string[] = [];
    for (const [prefix, router] of ROUTER_MOUNTS) {
      for (const layer of (router as any).stack) {
        if (!layer.route?.methods.get) continue;
        const path = (prefix + (layer.route.path === "/" ? "" : layer.route.path)).replace(/:[A-Za-z]+/g, "x");
        if (path.startsWith("/api/orgs") || OPEN_TO_ALL_SIGNED_IN.has(path)) continue;
        const res = await request(app).get(path).set(auth(coord.token));
        if (res.status !== 401 && res.status !== 403 && res.status !== 404) reached.push(`${path} -> ${res.status}`);
      }
    }
    expect(reached).toEqual([]);
  });
});
