import crypto from "crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "../db";
import { withScope } from "../dbContext";
import { doctorProfiles, pairingInvitations, pairingRequests, users } from "@shared/schema";
import { storage } from "../storage";
import { logAudit } from "./auditService";
import { credentialSummaryForUser } from "./credentialService";
import { organizationsOfClinician, tellPatientAboutOrganizationStaff } from "./orgs";

/**
 * Connecting a patient and a clinician with a code the clinician shows.
 *
 *  - The QR code carries a single-use token; a short code is the same invitation typed by hand. Neither contains any patient or
 *    clinical information, and neither grants access by itself: a connection exists only after the patient has seen who it is
 *    from and confirmed.
 *  - Only keyed hashes are stored, so a copy of the table cannot be turned back into working codes.
 *  - All checks are made on the server, and what a stranger can learn is the same for a code that never existed, one that
 *    expired, one already used, and one revoked: nothing.
 *  - "Accepted" and the connection are written in one transaction, with the invitation row locked, so two patients scanning one
 *    code at once cannot both win.
 */

export const INVITATION_MINUTES = 15;
export const MAX_PENDING_PER_CLINICIAN = 5;
// No 0/O or 1/I/L: this is read aloud and typed by people who are not looking at a keyboard they know.
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 8;

export class InvitationError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}
const INVALID = () => new InvitationError(404, "invalid_code", "That code isn't valid or has expired.");

function key(): string {
  return `${process.env.JWT_SECRET || "dev-secret-change-me"}:pairing-invitation:v1`;
}
const hash = (value: string) => crypto.createHmac("sha256", key()).update(value).digest("hex");

export const normalizeCode = (raw: string) => raw.toUpperCase().replace(/[^A-Z0-9]/g, "");
export const formatCode = (code: string) => `${code.slice(0, 4)}-${code.slice(4)}`;

function newCode(): string {
  let out = "";
  const bytes = crypto.randomBytes(64);
  for (let i = 0; out.length < CODE_LENGTH; i++) {
    // Rejection sampling: no modulo bias.
    const b = bytes[i];
    if (b < 248) out += CODE_ALPHABET[b % CODE_ALPHABET.length];
  }
  return out;
}

export type Presented = { token: string } | { code: string };

function lookupHash(input: Presented): { column: "tokenHash" | "codeHash"; value: string } | null {
  if ("token" in input) {
    if (typeof input.token !== "string" || !/^[A-Za-z0-9_-]{40,60}$/.test(input.token)) return null;
    return { column: "tokenHash", value: hash(`token:${input.token}`) };
  }
  if (typeof input.code !== "string") return null;
  const code = normalizeCode(input.code);
  if (code.length !== CODE_LENGTH || Array.from(code).some((c) => !CODE_ALPHABET.includes(c))) return null;
  return { column: "codeHash", value: hash(`code:${code}`) };
}

// ---------------------------------------------------------------------------------------------- the clinician's side

async function approvedProfile(userId: string) {
  const [profile] = await db.select().from(doctorProfiles).where(and(eq(doctorProfiles.userId, userId), eq(doctorProfiles.active, true)));
  if (!profile) throw new InvitationError(403, "forbidden", "Not allowed");
  const listable = await withScope("pairing", () => storage.getListableDoctorProfile(profile.id));
  // Same standard as being listed to patients: approved, active, and a licence check that has not expired.
  if (!listable) throw new InvitationError(403, "not_listed", "You can connect patients once your licence check is valid.");
  return profile;
}

export async function createInvitation(doctorUserId: string) {
  const profile = await approvedProfile(doctorUserId);
  const pending = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(pairingInvitations)
    .where(and(eq(pairingInvitations.doctorProfileId, profile.id), eq(pairingInvitations.status, "pending"), sql`${pairingInvitations.expiresAt} > now()`));
  if ((pending[0]?.n ?? 0) >= MAX_PENDING_PER_CLINICIAN) throw new InvitationError(429, "too_many", "You have several codes waiting. Revoke one or wait for them to expire.");
  const token = crypto.randomBytes(32).toString("base64url");
  const code = newCode();
  const expiresAt = new Date(Date.now() + INVITATION_MINUTES * 60_000);
  const [row] = await db.insert(pairingInvitations).values({
    doctorProfileId: profile.id, createdByUserId: doctorUserId, tokenHash: hash(`token:${token}`), codeHash: hash(`code:${code}`), expiresAt,
  }).returning();
  await logAudit({ actorUserId: doctorUserId, action: "pairing_invitation.created", targetType: "pairing_invitation", targetId: row.id });
  // The only time the token and the code exist in readable form.
  return { id: row.id, token, code: formatCode(code), expiresAt };
}

export type InvitationState = "pending" | "accepted" | "expired" | "revoked";

export async function listInvitations(doctorUserId: string, now = new Date()) {
  const profile = await approvedProfile(doctorUserId).catch(() => null);
  if (!profile) return [];
  const rows = await db
    .select({ inv: pairingInvitations, patientName: users.name })
    .from(pairingInvitations)
    .leftJoin(users, eq(users.id, pairingInvitations.acceptedByUserId))
    .where(eq(pairingInvitations.doctorProfileId, profile.id))
    .orderBy(desc(pairingInvitations.createdAt))
    .limit(20);
  return rows.map(({ inv, patientName }) => ({
    id: inv.id,
    state: (inv.status === "pending" && inv.expiresAt.getTime() <= now.getTime() ? "expired" : inv.status) as InvitationState,
    createdAt: inv.createdAt,
    expiresAt: inv.expiresAt,
    acceptedAt: inv.acceptedAt,
    patientName: inv.status === "accepted" ? patientName : null,
  }));
}

export async function revokeInvitation(doctorUserId: string, id: string) {
  const profile = await approvedProfile(doctorUserId);
  const [row] = await db
    .update(pairingInvitations)
    .set({ status: "revoked", revokedAt: new Date() })
    .where(and(eq(pairingInvitations.id, id), eq(pairingInvitations.doctorProfileId, profile.id), eq(pairingInvitations.status, "pending")))
    .returning({ id: pairingInvitations.id });
  if (row) await logAudit({ actorUserId: doctorUserId, action: "pairing_invitation.revoked", targetType: "pairing_invitation", targetId: id });
  return !!row;
}

// ---------------------------------------------------------------------------------------------- the patient's side

async function findUsable(input: Presented, forUpdate = false, tx?: Pick<typeof db, "select">) {
  const h = lookupHash(input);
  if (!h) return undefined;
  const q = (tx ?? db).select().from(pairingInvitations).where(and(eq(pairingInvitations[h.column], h.value), eq(pairingInvitations.status, "pending"), sql`${pairingInvitations.expiresAt} > now()`));
  const [row] = await (forUpdate ? q.for("update") : q);
  return row;
}

/** Who the code is from, as far as Avela can honestly say. Nothing is created. */
export async function preview(patientUserId: string, input: Presented) {
  return withScope("pairing", async () => {
    const inv = await findUsable(input);
    if (!inv) throw INVALID();
    const doctor = await storage.getListableDoctorProfile(inv.doctorProfileId);
    if (!doctor?.userId || (await storage.isBlockedEitherWay(patientUserId, doctor.userId))) throw INVALID();
    const credential = await credentialSummaryForUser(doctor.userId);
    const [existing] = await db
      .select({ status: pairingRequests.status })
      .from(pairingRequests)
      .where(and(eq(pairingRequests.patientUserId, patientUserId), eq(pairingRequests.doctorProfileId, doctor.id), sql`${pairingRequests.status} IN ('requested','accepted')`));
    return {
      expiresAt: inv.expiresAt,
      alreadyConnected: existing?.status === "accepted",
      // Staff of these organizations can see the patient's name and appointment times once connected (the patient can switch that off).
      organizations: (await organizationsOfClinician(doctor.userId)).map((o) => o.name),
      doctor: {
        name: doctor.name, specialty: doctor.specialty, state: doctor.state, languages: doctor.languages ?? [], clinic: doctor.clinic,
        // What Avela did and did not do: a person on the team checked the licence (or not yet). It is not a guarantee of anything else.
        licence: credential && credential.status === "verified" ? { checkedBy: "avela_reviewer", how: credential.source, checkedAt: credential.checkedAt, validUntil: credential.expiresAt } : null,
      },
    };
  });
}

export async function acceptInvitation(patientUserId: string, input: Presented) {
  const result = await withScope("pairing", async () => {
    const first = await findUsable(input);
    if (!first) {
      // A patient who retries after a slow network may find their own earlier acceptance: answer that honestly instead of "invalid".
      const h = lookupHash(input);
      if (h) {
        const [done] = await db.select().from(pairingInvitations).where(and(eq(pairingInvitations[h.column], h.value), eq(pairingInvitations.status, "accepted"), eq(pairingInvitations.acceptedByUserId, patientUserId)));
        // Only a retry soon after: a code that was used long ago and a connection that may since have ended are not "repeated" into existence.
        if (done?.pairingRequestId && done.acceptedAt && Date.now() - done.acceptedAt.getTime() < 10 * 60_000) return { pairingId: done.pairingRequestId, doctorProfileId: done.doctorProfileId, repeat: true };
      }
      throw INVALID();
    }
    const doctor = await storage.getListableDoctorProfile(first.doctorProfileId);
    if (!doctor?.userId || (await storage.isBlockedEitherWay(patientUserId, doctor.userId))) throw INVALID();

    return db.transaction(async (tx) => {
      const inv = await findUsable(input, true, tx);
      if (!inv) throw INVALID(); // someone else got there first, or it was revoked a moment ago
      const [existing] = await tx
        .select()
        .from(pairingRequests)
        .where(and(eq(pairingRequests.patientUserId, patientUserId), eq(pairingRequests.doctorProfileId, doctor.id), sql`${pairingRequests.status} IN ('requested','accepted')`))
        .for("update");
      let pairingId: string;
      if (existing) {
        pairingId = existing.id;
        if (existing.status === "requested") await tx.update(pairingRequests).set({ status: "accepted", respondedAt: new Date(), connectedVia: "invitation", invitationId: inv.id }).where(eq(pairingRequests.id, existing.id));
      } else {
        const [created] = await tx.insert(pairingRequests).values({ patientUserId, doctorProfileId: doctor.id, status: "accepted", respondedAt: new Date(), connectedVia: "invitation", invitationId: inv.id }).returning({ id: pairingRequests.id });
        pairingId = created.id;
      }
      await tx.update(pairingInvitations).set({ status: "accepted", acceptedByUserId: patientUserId, acceptedAt: new Date(), pairingRequestId: pairingId }).where(eq(pairingInvitations.id, inv.id));
      return { pairingId, doctorProfileId: doctor.id, repeat: false, doctorUserId: doctor.userId, invitationId: inv.id };
    });
  });
  if (!result.repeat) {
    await logAudit({ actorUserId: patientUserId, action: "pairing_invitation.accepted", targetType: "pairing_request", targetId: result.pairingId, subjectUserId: patientUserId, metadata: { invitationId: (result as any).invitationId } });
    if ((result as any).doctorUserId) {
      await tellPatientAboutOrganizationStaff(patientUserId, (result as any).doctorUserId, (await withScope("pairing", () => storage.getDoctorProfile((result as any).doctorProfileId)))?.name ?? "").catch(() => {});
      const patient = await withScope("pairing", () => storage.getUser(patientUserId));
      await withScope("pairing", () => storage.createNotification({ userId: (result as any).doctorUserId, kind: "pairing.connected", params: { name: patient?.name ?? "" }, link: "/doctor/patients" })).catch(() => {});
    }
  }
  return { pairingId: result.pairingId, repeat: result.repeat };
}
