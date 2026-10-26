import crypto from "crypto";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db";
import { runAsSystem } from "../dbContext";
import {
  appointments, auditLogs, doctorProfiles, notifications, orgInvitations, orgMemberships, orgNotes, orgTasks, organizations, pairingRequests, users,
  type OrgMembership, type Organization,
} from "@shared/schema";
import { ORG_ROLES, assignableRoles, can, type OrgRole, type Permission } from "@shared/permissions";
import { logAudit, logAuditStrict, type AuditParams } from "./auditService";

/**
 * Organizations and their staff.
 *
 * Belonging to an organization gives NO clinical access. What staff can see of patients is the narrow operational view below
 * (name, appointment times and status, tasks and notes the organization itself wrote), only for patients who are connected to
 * the organization's own clinicians and have not hidden themselves from staff. Another organization's patients do not exist
 * as far as this code is concerned: every query starts from the organization id carried by the caller's own membership.
 *
 * These functions run with system database access AFTER the permission matrix has been checked in `access()`, because a staff
 * member has no relationship rows (a connection, a grant) that row-level security could use to say yes. That is why the check and
 * the scoping live in one place, and why tests/orgs.test.ts attacks it from the outside.
 */

export class OrgError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}
const fail = (status: number, code: string, message: string): never => {
  throw new OrgError(status, code, message);
};
/** Every organization event carries the organization's id, so an organization's activity view shows its own events and no others. */
type OrgEvent = Omit<AuditParams, "actorUserId">;
const withOrg = (a: OrgAccess, e: OrgEvent) => ({ ...e, actorUserId: a.membership.userId, metadata: { ...(e.metadata ?? {}), orgId: a.org.id } });
const orgAudit = (a: OrgAccess, e: OrgEvent) => logAudit(withOrg(a, e));
const orgAuditStrict = (a: OrgAccess, e: OrgEvent) => logAuditStrict(withOrg(a, e));
const NOT_FOUND = () => new OrgError(404, "not_found", "Not found");

// ---------------------------------------------------------------------------------------------- input

const text = (max: number) => z.string().trim().max(max);
export const orgInput = z.object({
  name: text(160).min(2, "Give the organization a name"),
  kind: z.enum(["clinic", "hospital", "practice"]),
  country: z.enum(["EG", "US"]),
  contactEmail: z.string().trim().toLowerCase().email().max(254).nullable().optional(),
  contactPhone: z.string().trim().regex(/^[+()\d\s.-]{7,25}$/, "That phone number isn't valid").nullable().optional(),
  address: text(500).nullable().optional(),
}).strict();
export type OrgInput = z.infer<typeof orgInput>;

export const inviteInput = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  role: z.enum(ORG_ROLES),
}).strict();

export const taskInput = z.object({
  patientUserId: z.string().min(1).max(64),
  title: text(200).min(2, "Say what needs doing"),
  dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  assignedToUserId: z.string().max(64).nullable().optional(),
}).strict();

// ---------------------------------------------------------------------------------------------- access

export interface OrgAccess { org: Organization; membership: OrgMembership; role: OrgRole }

/** The caller's membership of this organization, or "not found". Never says whether the organization exists. */
export async function access(userId: string, orgId: string, permission: Permission): Promise<OrgAccess> {
  return runAsSystem(async () => {
    const [row] = await db
      .select({ org: organizations, membership: orgMemberships })
      .from(orgMemberships)
      .innerJoin(organizations, eq(organizations.id, orgMemberships.orgId))
      .where(and(eq(orgMemberships.orgId, orgId), eq(orgMemberships.userId, userId), eq(orgMemberships.status, "active")));
    if (!row) throw NOT_FOUND();
    const role = row.membership.role as OrgRole;
    if (!can(role, permission)) fail(403, "forbidden", "You don't have permission to do that here.");
    // A suspended organization can be looked at (so its members understand what happened) and nothing else.
    if (row.org.status === "suspended" && permission !== "org.view") fail(403, "org_suspended", "This organization is suspended.");
    return { org: row.org, membership: row.membership, role };
  });
}

// ---------------------------------------------------------------------------------------------- organizations

export async function createOrg(userId: string, input: OrgInput) {
  return runAsSystem(async () => {
    const [user] = await db.select().from(users).where(eq(users.id, userId));
    if (user?.role !== "doctor") fail(403, "forbidden", "Only an approved clinician can start an organization.");
    return db.transaction(async (tx) => {
      const [org] = await tx.insert(organizations).values({ ...input, contactEmail: input.contactEmail ?? null, contactPhone: input.contactPhone ?? null, address: input.address ?? null, createdByUserId: userId }).returning();
      await tx.insert(orgMemberships).values({ orgId: org.id, userId, role: "owner", invitedByUserId: userId });
      return org;
    }).then(async (org) => {
      await tellPatientsOfClinicianAbout(userId, org.id);
      return org;
    });
  });
}

export async function myOrganizations(userId: string) {
  return runAsSystem(() =>
    db
      .select({ org: organizations, role: orgMemberships.role })
      .from(orgMemberships)
      .innerJoin(organizations, eq(organizations.id, orgMemberships.orgId))
      .where(and(eq(orgMemberships.userId, userId), eq(orgMemberships.status, "active")))
      .orderBy(asc(organizations.name)),
  ).then((rows) => rows.map((r) => ({ ...r.org, role: r.role as OrgRole })));
}

export async function updateOrg(a: OrgAccess, input: Partial<OrgInput>) {
  return runAsSystem(async () => {
    // Changing what an organization IS (its name, kind, country) is not covered by a check made of the old one: it goes back to unverified.
    const identityChanged = (input.name !== undefined && input.name !== a.org.name) || (input.kind !== undefined && input.kind !== a.org.kind) || (input.country !== undefined && input.country !== a.org.country);
    const set: Partial<typeof organizations.$inferInsert> = { ...input, ...(identityChanged && a.org.status === "verified" ? { status: "unverified" as const } : {}) };
    const [org] = await db.update(organizations).set(set).where(eq(organizations.id, a.org.id)).returning();
    await orgAudit(a, { action: "org.settings_updated", targetType: "organization", targetId: a.org.id, metadata: { fields: Object.keys(input) } });
    return org;
  });
}

// ---------------------------------------------------------------------------------------------- staff

const hashToken = (token: string) => crypto.createHmac("sha256", `${process.env.JWT_SECRET || "dev-secret-change-me"}:org-invitation:v1`).update(token).digest("hex");

export async function listStaff(a: OrgAccess) {
  return runAsSystem(async () => {
    const members = await db
      .select({ m: orgMemberships, name: users.name, email: users.email })
      .from(orgMemberships)
      .innerJoin(users, eq(users.id, orgMemberships.userId))
      .where(and(eq(orgMemberships.orgId, a.org.id)))
      .orderBy(desc(orgMemberships.createdAt));
    const invites = await db.select().from(orgInvitations).where(and(eq(orgInvitations.orgId, a.org.id), eq(orgInvitations.status, "pending")));
    const canSeeEmail = can(a.role, "org.staff.invite");
    return {
      members: members.map(({ m, name, email }) => ({ id: m.id, userId: m.userId, name, email: canSeeEmail ? email : null, role: m.role as OrgRole, status: m.status, since: m.createdAt, revokedAt: m.revokedAt })),
      invitations: canSeeEmail ? invites.map((i) => ({ id: i.id, email: i.email, role: i.role as OrgRole, expiresAt: i.expiresAt })) : [],
    };
  });
}

const MAX_PENDING_INVITATIONS = 50;
const MAX_INVITATIONS_PER_DAY = 30;

export async function invite(a: OrgAccess, email: string, role: OrgRole) {
  if (!assignableRoles(a.role).includes(role)) fail(403, "forbidden", "You can't give that role.");
  return runAsSystem(async () => {
    const [existingUser] = await db.select().from(users).where(eq(users.email, email));
    // Whether this address has an account of some other kind is not revealed: an invitation that cannot be used is created all the same,
    // and the person simply cannot accept it (accepting checks the kind of account again).
    if (existingUser) {
      const [already] = await db.select({ id: orgMemberships.id }).from(orgMemberships).where(and(eq(orgMemberships.orgId, a.org.id), eq(orgMemberships.userId, existingUser.id), eq(orgMemberships.status, "active")));
      if (already) fail(409, "already_member", "They are already a member.");
    }
    const [{ pending, today }] = await db
      .select({
        pending: sql<number>`count(*) FILTER (WHERE ${orgInvitations.status} = 'pending' AND ${orgInvitations.expiresAt} > now())::int`,
        today: sql<number>`count(*) FILTER (WHERE ${orgInvitations.createdAt} > now() - interval '24 hours')::int`,
      })
      .from(orgInvitations)
      .where(eq(orgInvitations.orgId, a.org.id));
    if (pending >= MAX_PENDING_INVITATIONS || today >= MAX_INVITATIONS_PER_DAY) fail(429, "too_many", "This organization has sent a lot of invitations. Revoke some, or wait.");
    const token = crypto.randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + 7 * 86_400_000);
    // A newer invitation for the same address and organization replaces an older one.
    await db.update(orgInvitations).set({ status: "revoked" }).where(and(eq(orgInvitations.orgId, a.org.id), eq(orgInvitations.email, email), eq(orgInvitations.status, "pending")));
    const [row] = await db.insert(orgInvitations).values({ orgId: a.org.id, email, role, tokenHash: hashToken(token), expiresAt, invitedByUserId: a.membership.userId }).returning();
    await orgAudit(a, { action: "org.staff_invited", targetType: "org_invitation", targetId: row.id, metadata: { role } });
    // E-mail is sent only for an organization Avela has verified; for any other the inviter hands the link over themselves.
    return { id: row.id, token, expiresAt, org: a.org, emailAllowed: a.org.status === "verified" };
  });
}

export async function revokeInvitation(a: OrgAccess, id: string) {
  return runAsSystem(async () => {
    const [row] = await db.update(orgInvitations).set({ status: "revoked" }).where(and(eq(orgInvitations.id, id), eq(orgInvitations.orgId, a.org.id), eq(orgInvitations.status, "pending"))).returning({ id: orgInvitations.id });
    if (!row) throw NOT_FOUND();
    await orgAudit(a, { action: "org.invitation_revoked", targetType: "org_invitation", targetId: id });
  });
}

export async function previewInvitation(token: string) {
  if (typeof token !== "string" || !/^[A-Za-z0-9_-]{40,60}$/.test(token)) throw NOT_FOUND();
  return runAsSystem(async () => {
    const [row] = await db
      .select({ inv: orgInvitations, orgName: organizations.name, orgStatus: organizations.status })
      .from(orgInvitations)
      .innerJoin(organizations, eq(organizations.id, orgInvitations.orgId))
      .where(and(eq(orgInvitations.tokenHash, hashToken(token)), eq(orgInvitations.status, "pending"), sql`${orgInvitations.expiresAt} > now()`));
    if (!row || row.orgStatus === "suspended") throw NOT_FOUND();
    const [u] = await db.select({ id: users.id }).from(users).where(eq(users.email, row.inv.email));
    return { orgName: row.orgName, role: row.inv.role as OrgRole, email: row.inv.email, accountExists: !!u };
  });
}

/** Adds the membership for an account that already exists and belongs to the invited e-mail. */
export async function acceptWithAccount(userId: string, token: string) {
  if (typeof token !== "string" || !/^[A-Za-z0-9_-]{40,60}$/.test(token)) throw NOT_FOUND();
  return runAsSystem(async () => {
    return db.transaction(async (tx) => {
      const [inv] = await tx.select().from(orgInvitations).where(and(eq(orgInvitations.tokenHash, hashToken(token)), eq(orgInvitations.status, "pending"), sql`${orgInvitations.expiresAt} > now()`)).for("update");
      if (!inv) throw NOT_FOUND();
      const [user] = await tx.select().from(users).where(eq(users.id, userId));
      // The invitation belongs to one e-mail address: possessing the link is not enough.
      if (!user || user.email.toLowerCase() !== inv.email.toLowerCase()) throw NOT_FOUND();
      if (inv.role === "clinician" && user.role !== "doctor") throw NOT_FOUND();
      if (inv.role !== "clinician" && user.role !== "staff") throw NOT_FOUND();
      const [org] = await tx.select().from(organizations).where(eq(organizations.id, inv.orgId));
      if (!org || org.status === "suspended") throw NOT_FOUND();
      const [m] = await tx.insert(orgMemberships).values({ orgId: inv.orgId, userId, role: inv.role, invitedByUserId: inv.invitedByUserId }).onConflictDoNothing().returning();
      if (!m) throw new OrgError(409, "already_member", "You are already a member of this organization.");
      await tx.update(orgInvitations).set({ status: "accepted", acceptedByUserId: userId, acceptedAt: new Date() }).where(eq(orgInvitations.id, inv.id));
      return { orgId: inv.orgId, role: inv.role as OrgRole, membershipId: m?.id ?? null };
    }).then(async (r) => {
      if (r.role === "clinician") await tellPatientsOfClinicianAbout(userId, r.orgId);
      await logAudit({ actorUserId: userId, action: "org.invitation_accepted", targetType: "organization", targetId: r.orgId, metadata: { role: r.role, orgId: r.orgId } });
      return r;
    });
  });
}

/** The invitation for a brand-new staff account: valid, unexpired, for a role that uses a staff account, and no account exists yet. */
export async function claimInvitationForNewAccount(token: string) {
  if (typeof token !== "string" || !/^[A-Za-z0-9_-]{40,60}$/.test(token)) throw NOT_FOUND();
  return runAsSystem(async () => {
    const [inv] = await db.select().from(orgInvitations).where(and(eq(orgInvitations.tokenHash, hashToken(token)), eq(orgInvitations.status, "pending"), sql`${orgInvitations.expiresAt} > now()`));
    if (!inv || inv.role === "clinician") throw NOT_FOUND();
    const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.email, inv.email));
    if (existing) fail(409, "account_exists", "An account with this e-mail already exists. Sign in, then accept the invitation.");
    const [org] = await db.select().from(organizations).where(eq(organizations.id, inv.orgId));
    if (!org || org.status === "suspended") throw NOT_FOUND();
    return inv;
  });
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Locks every active owner of the organization, so two people demoting or removing each other cannot both succeed. */
async function lockOwners(tx: Tx, orgId: string) {
  return tx
    .select({ id: orgMemberships.id })
    .from(orgMemberships)
    .where(and(eq(orgMemberships.orgId, orgId), eq(orgMemberships.role, "owner"), eq(orgMemberships.status, "active")))
    .orderBy(orgMemberships.id)
    .for("update");
}

async function requireAnotherOwner(tx: Tx, orgId: string, excludingMembership: string) {
  const owners = await lockOwners(tx, orgId);
  if (!owners.some((o) => o.id !== excludingMembership)) fail(409, "last_owner", "An organization needs at least one owner. Make someone else an owner first.");
}

export async function changeRole(a: OrgAccess, membershipId: string, role: OrgRole) {
  return runAsSystem(async () => {
    const done = await db.transaction(async (tx) => {
      const [row] = await tx
        .select({ m: orgMemberships, accountRole: users.role })
        .from(orgMemberships)
        .innerJoin(users, eq(users.id, orgMemberships.userId))
        .where(and(eq(orgMemberships.id, membershipId), eq(orgMemberships.orgId, a.org.id), eq(orgMemberships.status, "active")));
      if (!row) throw NOT_FOUND();
      const target = row.m;
      if (!assignableRoles(a.role).includes(role) || !assignableRoles(a.role).includes(target.role as OrgRole)) fail(403, "forbidden", "You can't change that person's role.");
      // The kind of account decides which roles it can hold: clinicians are clinician accounts, desk roles are staff accounts.
      if (role === "clinician" && row.accountRole !== "doctor") fail(409, "wrong_account", "Only a clinician account can be a clinician here.");
      if (["coordinator", "scheduler", "auditor"].includes(role) && row.accountRole !== "staff") fail(409, "wrong_account", "A clinician account cannot hold this role; invite a staff account instead.");
      if (target.role === "owner" && role !== "owner") await requireAnotherOwner(tx, a.org.id, target.id);
      await tx.update(orgMemberships).set({ role }).where(eq(orgMemberships.id, target.id));
      return target;
    });
    await orgAudit(a, { action: "org.role_changed", targetType: "org_membership", targetId: done.id, subjectUserId: done.userId, metadata: { from: done.role, to: role } });
  });
}

export async function revokeMember(a: OrgAccess, membershipId: string) {
  return runAsSystem(async () => {
    const target = await db.transaction(async (tx) => {
      const [t] = await tx.select().from(orgMemberships).where(and(eq(orgMemberships.id, membershipId), eq(orgMemberships.orgId, a.org.id), eq(orgMemberships.status, "active")));
      if (!t) throw NOT_FOUND();
      const self = t.userId === a.membership.userId;
      if (!self && !assignableRoles(a.role).includes(t.role as OrgRole)) fail(403, "forbidden", "You can't remove that person.");
      if (t.role === "owner") await requireAnotherOwner(tx, a.org.id, t.id);
      await tx.update(orgMemberships).set({ status: "revoked", revokedAt: new Date(), revokedByUserId: a.membership.userId }).where(eq(orgMemberships.id, t.id));
      // Anything they were assigned goes back to "unassigned" rather than waiting on someone who can no longer act.
      await tx.update(orgTasks).set({ assignedToUserId: null }).where(and(eq(orgTasks.orgId, a.org.id), eq(orgTasks.assignedToUserId, t.userId), eq(orgTasks.status, "open")));
      return t;
    });
    await orgAudit(a, { action: "org.member_revoked", targetType: "org_membership", targetId: target.id, subjectUserId: target.userId });
  });
}

// ---------------------------------------------------------------------------------------------- who the organization's patients are

/** User ids of the organization's clinicians: members with the clinician role, and owners/admins who are themselves approved doctors. */
async function clinicianUserIds(orgId: string): Promise<string[]> {
  const rows = await db
    .select({ userId: orgMemberships.userId, role: orgMemberships.role, accountRole: users.role })
    .from(orgMemberships)
    .innerJoin(users, eq(users.id, orgMemberships.userId))
    .where(and(eq(orgMemberships.orgId, orgId), eq(orgMemberships.status, "active")));
  return rows.filter((r) => r.role === "clinician" || (["owner", "admin"].includes(r.role) && r.accountRole === "doctor")).map((r) => r.userId);
}

interface Scope { patientIds: string[]; doctorProfileIds: string[] }

/**
 * Whose patients this member may see. Everyone but a clinician sees the organization's patients who allowed staff to see them;
 * a clinician sees only their own (the connection is theirs, whatever the patient chose about staff).
 */
async function scopeFor(a: OrgAccess): Promise<Scope> {
  const all = await clinicianUserIds(a.org.id);
  const own = a.role === "clinician" ? [a.membership.userId] : all;
  if (own.length === 0) return { patientIds: [], doctorProfileIds: [] };
  const profiles = await db.select({ id: doctorProfiles.id, userId: doctorProfiles.userId }).from(doctorProfiles).where(inArray(doctorProfiles.userId, own));
  const profileIds = profiles.map((p) => p.id);
  if (profileIds.length === 0) return { patientIds: [], doctorProfileIds: [] };
  const conditions = [inArray(pairingRequests.doctorProfileId, profileIds), eq(pairingRequests.status, "accepted")];
  if (a.role !== "clinician") conditions.push(eq(pairingRequests.orgStaffVisible, true));
  const pairs = await db.select({ patientUserId: pairingRequests.patientUserId, doctorProfileId: pairingRequests.doctorProfileId }).from(pairingRequests).where(and(...conditions));
  return { patientIds: Array.from(new Set(pairs.map((p) => p.patientUserId))), doctorProfileIds: Array.from(new Set(pairs.map((p) => p.doctorProfileId))) };
}

export async function listPatients(a: OrgAccess) {
  return runAsSystem(async () => {
    const scope = await scopeFor(a);
    if (scope.patientIds.length === 0) return [];
    const rows = await db.select({ id: users.id, name: users.name }).from(users).where(and(inArray(users.id, scope.patientIds), sql`${users.deactivatedAt} IS NULL`)).orderBy(asc(users.name));
    await orgAudit(a, { action: "org.patients_listed", targetType: "organization", targetId: a.org.id });
    return rows;
  });
}

export async function listAppointments(a: OrgAccess, days = 7, now = new Date()) {
  return runAsSystem(async () => {
    const scope = await scopeFor(a);
    if (scope.patientIds.length === 0) return [];
    const until = new Date(now.getTime() + days * 86_400_000);
    const rows = await db
      .select({ id: appointments.id, patientName: users.name, doctorName: doctorProfiles.name, scheduledAt: appointments.scheduledAt, durationMinutes: appointments.durationMinutes, status: appointments.status, type: appointments.type })
      .from(appointments)
      .innerJoin(users, eq(users.id, appointments.patientUserId))
      .innerJoin(doctorProfiles, eq(doctorProfiles.id, appointments.doctorProfileId))
      .where(and(inArray(appointments.patientUserId, scope.patientIds), inArray(appointments.doctorProfileId, scope.doctorProfileIds), inArray(appointments.status, ["requested", "confirmed"]), sql`${appointments.scheduledAt} >= ${now}`, sql`${appointments.scheduledAt} < ${until}`))
      .orderBy(asc(appointments.scheduledAt))
      .limit(200);
    // Times, who and with whom. Never the reason for the visit.
    return rows;
  });
}

// ---------------------------------------------------------------------------------------------- tasks and notes

async function patientInScope(a: OrgAccess, patientUserId: string, scope?: Scope) {
  const s = scope ?? (await scopeFor(a));
  if (!s.patientIds.includes(patientUserId)) throw NOT_FOUND();
}

export async function listTasks(a: OrgAccess, status: "open" | "done" | "all" = "open") {
  return runAsSystem(async () => {
    const scope = await scopeFor(a);
    if (scope.patientIds.length === 0) return [];
    const conds = [eq(orgTasks.orgId, a.org.id), inArray(orgTasks.patientUserId, scope.patientIds)];
    if (status !== "all") conds.push(eq(orgTasks.status, status));
    const rows = await db
      .select({ t: orgTasks, patientName: users.name })
      .from(orgTasks)
      .innerJoin(users, eq(users.id, orgTasks.patientUserId))
      .where(and(...conds))
      .orderBy(asc(orgTasks.dueDate), desc(orgTasks.createdAt))
      .limit(300);
    const assigneeIds = Array.from(new Set(rows.map((r) => r.t.assignedToUserId).filter(Boolean) as string[]));
    const assignees = assigneeIds.length ? await db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, assigneeIds)) : [];
    const nm = new Map(assignees.map((u) => [u.id, u.name]));
    const today = new Date().toISOString().slice(0, 10);
    return rows.map(({ t, patientName }) => ({
      id: t.id, patientUserId: t.patientUserId, patientName, title: t.title, dueDate: t.dueDate, status: t.status, assignedToUserId: t.assignedToUserId,
      assignedToName: t.assignedToUserId ? nm.get(t.assignedToUserId) ?? null : null, createdAt: t.createdAt, completedAt: t.completedAt,
      overdue: t.status === "open" && !!t.dueDate && t.dueDate < today,
    }));
  });
}

export async function createTask(a: OrgAccess, input: z.infer<typeof taskInput>) {
  return runAsSystem(async () => {
    await patientInScope(a, input.patientUserId);
    if (input.assignedToUserId) {
      const [m] = await db.select({ id: orgMemberships.id }).from(orgMemberships).where(and(eq(orgMemberships.orgId, a.org.id), eq(orgMemberships.userId, input.assignedToUserId), eq(orgMemberships.status, "active")));
      if (!m) fail(400, "bad_assignee", "That person is not on this organization's staff.");
    }
    const [t] = await db.insert(orgTasks).values({ orgId: a.org.id, patientUserId: input.patientUserId, title: input.title, dueDate: input.dueDate ?? null, assignedToUserId: input.assignedToUserId ?? null, createdByUserId: a.membership.userId }).returning();
    await orgAudit(a, { action: "org.task_created", targetType: "org_task", targetId: t.id, subjectUserId: input.patientUserId });
    return t;
  });
}

export async function updateTask(a: OrgAccess, id: string, change: { status?: "open" | "done" | "cancelled"; assignedToUserId?: string | null }) {
  return runAsSystem(async () => {
    const [t] = await db.select().from(orgTasks).where(and(eq(orgTasks.id, id), eq(orgTasks.orgId, a.org.id)));
    if (!t) throw NOT_FOUND();
    await patientInScope(a, t.patientUserId);
    if (change.assignedToUserId) {
      const [m] = await db.select({ id: orgMemberships.id }).from(orgMemberships).where(and(eq(orgMemberships.orgId, a.org.id), eq(orgMemberships.userId, change.assignedToUserId), eq(orgMemberships.status, "active")));
      if (!m) fail(400, "bad_assignee", "That person is not on this organization's staff.");
    }
    const set: Partial<typeof orgTasks.$inferInsert> = {};
    if (change.assignedToUserId !== undefined) set.assignedToUserId = change.assignedToUserId;
    if (change.status) {
      set.status = change.status;
      set.completedAt = change.status === "done" ? new Date() : null;
      set.completedByUserId = change.status === "done" ? a.membership.userId : null;
    }
    const [updated] = await db.update(orgTasks).set(set).where(eq(orgTasks.id, id)).returning();
    await orgAudit(a, { action: "org.task_updated", targetType: "org_task", targetId: id, subjectUserId: t.patientUserId, metadata: { status: change.status ?? null } });
    return updated;
  });
}

export async function listNotes(a: OrgAccess, patientUserId: string) {
  return runAsSystem(async () => {
    await patientInScope(a, patientUserId);
    // Reading what staff wrote about a person is itself recorded before anything is returned.
    await orgAuditStrict(a, { action: "org.notes_read", targetType: "organization", targetId: a.org.id, subjectUserId: patientUserId });
    const rows = await db
      .select({ n: orgNotes, author: users.name })
      .from(orgNotes)
      .innerJoin(users, eq(users.id, orgNotes.authorUserId))
      .where(and(eq(orgNotes.orgId, a.org.id), eq(orgNotes.patientUserId, patientUserId)))
      .orderBy(desc(orgNotes.createdAt))
      .limit(200);
    return rows.map(({ n, author }) => ({ id: n.id, body: n.body, authorName: author, createdAt: n.createdAt }));
  });
}

export async function addNote(a: OrgAccess, patientUserId: string, body: string) {
  return runAsSystem(async () => {
    await patientInScope(a, patientUserId);
    const [n] = await db.insert(orgNotes).values({ orgId: a.org.id, patientUserId, body, authorUserId: a.membership.userId }).returning();
    // The audit entry records that a note was written, not what it said.
    await orgAudit(a, { action: "org.note_added", targetType: "org_note", targetId: n.id, subjectUserId: patientUserId });
    return { id: n.id, createdAt: n.createdAt };
  });
}

// ---------------------------------------------------------------------------------------------- dashboard and audit

export async function dashboard(a: OrgAccess, now = new Date()) {
  const out: Record<string, unknown> = { organization: { id: a.org.id, name: a.org.name, status: a.org.status, role: a.role } };
  const today = now.toISOString().slice(0, 10);
  await runAsSystem(async () => {
    if (can(a.role, "org.staff.view")) {
      const staff = await db.select({ role: orgMemberships.role }).from(orgMemberships).where(and(eq(orgMemberships.orgId, a.org.id), eq(orgMemberships.status, "active")));
      out.staff = { total: staff.length, byRole: Object.fromEntries(ORG_ROLES.map((r) => [r, staff.filter((s) => s.role === r).length])) };
    }
    if (can(a.role, "org.patients.list") || a.role === "clinician") {
      out.patients = { count: (await scopeFor(a)).patientIds.length };
    }
    if (can(a.role, "org.appointments.view")) {
      const rows = await listAppointmentsRaw(a, 7, now);
      out.appointments = { next7Days: rows.length, requested: rows.filter((r) => r.status === "requested").length, confirmed: rows.filter((r) => r.status === "confirmed").length };
    }
    if (can(a.role, "org.tasks.view")) {
      const scope = await scopeFor(a);
      const tasks = scope.patientIds.length ? await db.select().from(orgTasks).where(and(eq(orgTasks.orgId, a.org.id), inArray(orgTasks.patientUserId, scope.patientIds))) : [];
      const open = tasks.filter((t) => t.status === "open");
      out.tasks = {
        open: open.length, overdue: open.filter((t) => t.dueDate && t.dueDate < today).length, unassigned: open.filter((t) => !t.assignedToUserId).length,
        doneLast7Days: tasks.filter((t) => t.status === "done" && t.completedAt && now.getTime() - t.completedAt.getTime() < 7 * 86_400_000).length,
      };
    }
  });
  return out;
}

async function listAppointmentsRaw(a: OrgAccess, days: number, now: Date) {
  const scope = await scopeFor(a);
  if (scope.patientIds.length === 0) return [];
  const until = new Date(now.getTime() + days * 86_400_000);
  return db
    .select({ status: appointments.status })
    .from(appointments)
    .where(and(inArray(appointments.patientUserId, scope.patientIds), inArray(appointments.doctorProfileId, scope.doctorProfileIds), inArray(appointments.status, ["requested", "confirmed"]), sql`${appointments.scheduledAt} >= ${now}`, sql`${appointments.scheduledAt} < ${until}`));
}

/** What staff of this organization did, for the organization's own auditors and administrators. Actions and times; no content. */
export async function searchAudit(a: OrgAccess, filter: { action?: string; actorUserId?: string; from?: Date; to?: Date }) {
  return runAsSystem(async () => {
    // Only events recorded as belonging to THIS organization: a member's actions elsewhere (another organization, clinical work,
    // or after they left) are not this organization's to read.
    const conds = [sql`${auditLogs.metadata}->>'orgId' = ${a.org.id}`];
    if (filter.actorUserId) conds.push(eq(auditLogs.actorUserId, filter.actorUserId));
    if (filter.action) conds.push(sql`${auditLogs.action} LIKE ${filter.action.replace(/[%_\\]/g, "\\$&") + "%"}`);
    if (filter.from) conds.push(sql`${auditLogs.createdAt} >= ${filter.from}`);
    if (filter.to) conds.push(sql`${auditLogs.createdAt} <= ${filter.to}`);
    const rows = await db
      .select({ id: auditLogs.id, action: auditLogs.action, targetType: auditLogs.targetType, createdAt: auditLogs.createdAt, actorName: users.name, actorUserId: auditLogs.actorUserId })
      .from(auditLogs)
      .leftJoin(users, eq(users.id, auditLogs.actorUserId))
      .where(and(...conds))
      .orderBy(desc(auditLogs.createdAt))
      .limit(200);
    await orgAudit(a, { action: "org.audit_searched", targetType: "organization", targetId: a.org.id });
    return rows;
  });
}

// ---------------------------------------------------------------------------------------------- the patient's side

/** Which organizations' staff can see this patient's name and appointment times, through which connections. */
export async function organizationsSeeingPatient(patientUserId: string) {
  return runAsSystem(async () => {
    const pairs = await db
      .select({ pairingId: pairingRequests.id, visible: pairingRequests.orgStaffVisible, doctorName: doctorProfiles.name, doctorUserId: doctorProfiles.userId })
      .from(pairingRequests)
      .innerJoin(doctorProfiles, eq(doctorProfiles.id, pairingRequests.doctorProfileId))
      .where(and(eq(pairingRequests.patientUserId, patientUserId), eq(pairingRequests.status, "accepted")));
    const out: { pairingId: string; doctorName: string; organizationName: string; staffCanSee: boolean }[] = [];
    for (const p of pairs) {
      if (!p.doctorUserId) continue;
      const orgs = await db
        .select({ name: organizations.name })
        .from(orgMemberships)
        .innerJoin(organizations, eq(organizations.id, orgMemberships.orgId))
        .where(and(eq(orgMemberships.userId, p.doctorUserId), eq(orgMemberships.status, "active"), inArray(orgMemberships.role, ["clinician", "owner", "admin"]), sql`${organizations.status} <> 'suspended'`));
      for (const o of orgs) out.push({ pairingId: p.pairingId, doctorName: p.doctorName, organizationName: o.name, staffCanSee: p.visible });
    }
    return out;
  });
}

export async function setStaffVisibility(patientUserId: string, pairingId: string, visible: boolean) {
  return runAsSystem(async () => {
    const [row] = await db.update(pairingRequests).set({ orgStaffVisible: visible }).where(and(eq(pairingRequests.id, pairingId), eq(pairingRequests.patientUserId, patientUserId))).returning({ id: pairingRequests.id });
    if (!row) throw NOT_FOUND();
    await logAudit({ actorUserId: patientUserId, action: "pairing.staff_visibility_changed", targetType: "pairing_request", targetId: pairingId, subjectUserId: patientUserId, metadata: { visible } });
  });
}

/** The organizations a clinician currently belongs to (as a clinician, owner or administrator), excluding suspended ones. */
export async function organizationsOfClinician(doctorUserId: string): Promise<{ id: string; name: string }[]> {
  return runAsSystem(() =>
    db
      .select({ id: organizations.id, name: organizations.name })
      .from(orgMemberships)
      .innerJoin(organizations, eq(organizations.id, orgMemberships.orgId))
      .where(and(eq(orgMemberships.userId, doctorUserId), eq(orgMemberships.status, "active"), inArray(orgMemberships.role, ["clinician", "owner", "admin"]), sql`${organizations.status} <> 'suspended'`)),
  );
}

/**
 * Tells a patient, in their app, that the staff of a clinician's organization can see their name and appointment times, and where to
 * turn that off. Sent when a clinician joins an organization and when a new connection is made with a clinician who belongs to one.
 */
export async function tellPatientAboutOrganizationStaff(patientUserId: string, doctorUserId: string, doctorName: string, onlyOrgId?: string) {
  const orgs = (await organizationsOfClinician(doctorUserId)).filter((o) => !onlyOrgId || o.id === onlyOrgId);
  for (const o of orgs) {
    await runAsSystem(() => db.insert(notifications).values({ userId: patientUserId, kind: "org.staff_visibility", params: { doctorName, orgName: o.name }, link: "/profile" })).catch(() => {});
  }
}

/** Every patient connected to this clinician is told when the clinician joins an organization. */
export async function tellPatientsOfClinicianAbout(doctorUserId: string, orgId: string) {
  await runAsSystem(async () => {
    const rows = await db
      .select({ patientUserId: pairingRequests.patientUserId, doctorName: doctorProfiles.name })
      .from(pairingRequests)
      .innerJoin(doctorProfiles, eq(doctorProfiles.id, pairingRequests.doctorProfileId))
      .where(and(eq(doctorProfiles.userId, doctorUserId), eq(pairingRequests.status, "accepted")));
    for (const r of rows) await tellPatientAboutOrganizationStaff(r.patientUserId, doctorUserId, r.doctorName, orgId);
  });
}

// ---------------------------------------------------------------------------------------------- platform review

export const orgVerification = z.object({
  source: z.enum(["document_review", "registry_lookup", "issuer_confirmation"]),
  evidenceNote: z.string().trim().min(10, "Say what you checked and where").max(1000),
}).strict();

export async function listForReview() {
  return runAsSystem(() => db.select().from(organizations).orderBy(desc(organizations.createdAt)).limit(200));
}

export async function setOrgStatus(adminUserId: string, orgId: string, status: "verified" | "suspended" | "unverified", evidence?: z.infer<typeof orgVerification>, note?: string) {
  return runAsSystem(async () => {
    const set: Partial<typeof organizations.$inferInsert> =
      status === "verified"
        ? { status, verifiedAt: new Date(), verifiedByUserId: adminUserId, verificationSource: evidence!.source, verificationNote: evidence!.evidenceNote }
        : { status, ...(note ? { verificationNote: note } : {}) };
    const [org] = await db.update(organizations).set(set).where(eq(organizations.id, orgId)).returning();
    if (!org) throw NOT_FOUND();
    await logAudit({ actorUserId: adminUserId, action: `org.${status}`, targetType: "organization", targetId: orgId, metadata: { orgId } });
    return org;
  });
}
