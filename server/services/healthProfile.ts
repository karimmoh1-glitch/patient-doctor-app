import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "../db";
import {
  ALLERGY_STATES, ENTRY_DATA, ENTRY_KINDS, PROFILE_SECTIONS, SECTION_OF_KIND,
  allergyStatements, assistGrants, doctorProfiles, healthEntries, healthEntryEvents, onboardingSections, patientConsents, pairingRequests, users,
  type AllergyPicture, type EntryKind, type HealthEntry, type ProfileSection,
} from "@shared/schema";
import { logAudit } from "./auditService";
import { storage } from "../storage";

/**
 * A patient's own health information, with provenance.
 *
 *  - An empty allergy list is "not collected". "No known allergies" exists only as an explicit statement by the patient or a
 *    clinician, recorded with who said it and when.
 *  - Every entry says who entered it and whether a clinician verified it. Patient-reported information is never shown as verified.
 *  - Nothing is overwritten. An amendment adds a row that supersedes the old one; removal marks the row withdrawn; each step is an
 *    append-only event.
 *  - A clinician reads or enters a profile only under a grant the patient made to that clinician, with an expiry, revocable at any time.
 */

export const CONSENT_VERSION = "2026-10-health-profile-v1";

export type Actor = { userId: string; role: "patient" | "doctor" };

export class ProfileError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

const fail = (status: number, code: string, message: string): never => {
  throw new ProfileError(status, code, message);
};

// ---------------------------------------------------------------------------------------------- consent

export async function currentConsent(patientId: string) {
  const [row] = await db
    .select()
    .from(patientConsents)
    .where(and(eq(patientConsents.patientUserId, patientId), eq(patientConsents.purpose, "health_profile_storage")))
    .orderBy(desc(patientConsents.grantedAt))
    .limit(1);
  if (!row || row.revokedAt) return { given: false as const, lastVersion: row?.version ?? null, revokedAt: row?.revokedAt ?? null };
  return { given: true as const, version: row.version, grantedAt: row.grantedAt, current: row.version === CONSENT_VERSION };
}

export async function giveConsent(patientId: string) {
  await db.insert(patientConsents).values({ patientUserId: patientId, purpose: "health_profile_storage", version: CONSENT_VERSION });
  await logAudit({ actorUserId: patientId, action: "health_profile.consent_given", targetType: "patient", targetId: patientId, subjectUserId: patientId, metadata: { version: CONSENT_VERSION } });
}

export async function revokeConsent(patientId: string) {
  const open = await db
    .update(patientConsents)
    .set({ revokedAt: new Date() })
    .where(and(eq(patientConsents.patientUserId, patientId), eq(patientConsents.purpose, "health_profile_storage"), isNull(patientConsents.revokedAt)))
    .returning({ id: patientConsents.id });
  // Revoking also ends every clinician's access: nothing may be added or read on the strength of a consent that is gone.
  await db.update(assistGrants).set({ revokedAt: new Date() }).where(and(eq(assistGrants.patientUserId, patientId), isNull(assistGrants.revokedAt)));
  if (open.length) await logAudit({ actorUserId: patientId, action: "health_profile.consent_revoked", targetType: "patient", targetId: patientId, subjectUserId: patientId });
  return open.length > 0;
}

async function requireConsent(patientId: string) {
  const c = await currentConsent(patientId);
  if (!c.given) fail(403, "consent_required", "Consent to store this information is needed first.");
}

// ---------------------------------------------------------------------------------------------- grants

export async function activeGrantFor(doctorProfileId: string, patientId: string) {
  const [g] = await db
    .select()
    .from(assistGrants)
    .where(and(eq(assistGrants.patientUserId, patientId), eq(assistGrants.doctorProfileId, doctorProfileId), isNull(assistGrants.revokedAt), sql`${assistGrants.expiresAt} > now()`))
    .limit(1);
  if (!g) return undefined;
  // A grant is only as good as the connection and the clinician's standing behind it.
  const [pair] = await db
    .select({ id: pairingRequests.id })
    .from(pairingRequests)
    .innerJoin(doctorProfiles, eq(doctorProfiles.id, pairingRequests.doctorProfileId))
    .where(and(eq(pairingRequests.patientUserId, patientId), eq(pairingRequests.doctorProfileId, doctorProfileId), eq(pairingRequests.status, "accepted"), eq(doctorProfiles.active, true)))
    .limit(1);
  return pair ? g : undefined;
}

export async function grantAssist(patientId: string, doctorProfileId: string, days: number) {
  await requireConsent(patientId);
  const [pair] = await db
    .select({ id: pairingRequests.id })
    .from(pairingRequests)
    .innerJoin(doctorProfiles, eq(doctorProfiles.id, pairingRequests.doctorProfileId))
    .where(and(eq(pairingRequests.patientUserId, patientId), eq(pairingRequests.doctorProfileId, doctorProfileId), eq(pairingRequests.status, "accepted"), eq(doctorProfiles.active, true)))
    .limit(1);
  if (!pair) fail(404, "not_connected", "You can only invite a doctor you are connected with.");
  // One live grant per doctor: a new one replaces the old.
  await db.update(assistGrants).set({ revokedAt: new Date() }).where(and(eq(assistGrants.patientUserId, patientId), eq(assistGrants.doctorProfileId, doctorProfileId), isNull(assistGrants.revokedAt)));
  const [g] = await db.insert(assistGrants).values({ patientUserId: patientId, doctorProfileId, expiresAt: new Date(Date.now() + days * 86_400_000) }).returning();
  await logAudit({ actorUserId: patientId, action: "health_profile.assist_granted", targetType: "assist_grant", targetId: g.id, subjectUserId: patientId, metadata: { doctorProfileId, days } });
  return g;
}

export async function revokeAssist(patientId: string, grantId: string) {
  const [g] = await db
    .update(assistGrants)
    .set({ revokedAt: new Date() })
    .where(and(eq(assistGrants.id, grantId), eq(assistGrants.patientUserId, patientId), isNull(assistGrants.revokedAt)))
    .returning();
  if (g) await logAudit({ actorUserId: patientId, action: "health_profile.assist_revoked", targetType: "assist_grant", targetId: g.id, subjectUserId: patientId });
  return !!g;
}

export async function listGrants(patientId: string) {
  const rows = await db
    .select({ g: assistGrants, doctorName: doctorProfiles.name })
    .from(assistGrants)
    .innerJoin(doctorProfiles, eq(doctorProfiles.id, assistGrants.doctorProfileId))
    .where(eq(assistGrants.patientUserId, patientId))
    .orderBy(desc(assistGrants.grantedAt))
    .limit(50);
  const now = Date.now();
  return rows.map(({ g, doctorName }) => ({
    id: g.id, doctorProfileId: g.doctorProfileId, doctorName, grantedAt: g.grantedAt, expiresAt: g.expiresAt, revokedAt: g.revokedAt,
    state: g.revokedAt ? ("revoked" as const) : g.expiresAt.getTime() <= now ? ("expired" as const) : ("active" as const),
  }));
}

/** Who may act on this patient's profile: the patient themself, or a clinician under a live grant. */
async function authorize(actor: Actor, patientId: string): Promise<{ doctorProfileId: string | null }> {
  if (actor.role === "patient") {
    if (actor.userId !== patientId) fail(404, "not_found", "Not found");
    return { doctorProfileId: null };
  }
  const [profile] = await db.select().from(doctorProfiles).where(and(eq(doctorProfiles.userId, actor.userId), eq(doctorProfiles.active, true)));
  if (!profile) fail(403, "forbidden", "Not allowed");
  const grant = await activeGrantFor(profile!.id, patientId);
  if (!grant) fail(404, "not_found", "Not found"); // indistinguishable from a patient who does not exist
  return { doctorProfileId: profile!.id };
}

// ---------------------------------------------------------------------------------------------- allergies

export interface AllergyView {
  picture: AllergyPicture;
  statedBy: "patient" | "doctor" | null;
  statedAt: Date | null;
  clinicianReviewedAt: Date | null;
  clinicianVerified: boolean;
}

export async function allergyView(patientId: string): Promise<AllergyView> {
  const [stmt] = await db.select().from(allergyStatements).where(eq(allergyStatements.patientUserId, patientId));
  const active = await db.select().from(healthEntries).where(and(eq(healthEntries.patientUserId, patientId), eq(healthEntries.kind, "allergy"), eq(healthEntries.status, "active")));
  const picture: AllergyPicture = active.length ? "has_known" : stmt ? (stmt.state as AllergyPicture) : "not_collected";
  return {
    picture,
    statedBy: stmt ? (stmt.statedByRole as "patient" | "doctor") : null,
    statedAt: stmt?.statedAt ?? null,
    clinicianReviewedAt: stmt?.reviewedAt ?? null,
    clinicianVerified: active.length > 0 && active.every((e) => !!e.verifiedAt),
  };
}

export async function stateAllergies(actor: Actor, patientId: string, state: "none_known" | "unknown") {
  await authorize(actor, patientId);
  await requireConsent(patientId);
  await refuseOverwritingReviewed(actor, patientId);
  const active = await db.select({ id: healthEntries.id }).from(healthEntries).where(and(eq(healthEntries.patientUserId, patientId), eq(healthEntries.kind, "allergy"), eq(healthEntries.status, "active"))).limit(1);
  if (state === "none_known" && active.length) fail(409, "has_allergies", "There are allergies on the list. Remove them first if they were entered by mistake.");
  const clinician = actor.role === "doctor";
  const values = { state, statedByUserId: actor.userId, statedByRole: actor.role, statedAt: new Date(), reviewedByUserId: clinician ? actor.userId : null, reviewedAt: clinician ? new Date() : null };
  await db.insert(allergyStatements).values({ patientUserId: patientId, ...values }).onConflictDoUpdate({ target: allergyStatements.patientUserId, set: values });
  await logAudit({ actorUserId: actor.userId, action: "health_profile.allergy_statement", targetType: "patient", targetId: patientId, subjectUserId: patientId, metadata: { state, by: actor.role } });
}

/** A patient cannot overwrite or clear an allergy statement a clinician recorded or reviewed. */
async function refuseOverwritingReviewed(actor: Actor, patientId: string) {
  if (actor.role !== "patient") return;
  const [existing] = await db.select().from(allergyStatements).where(eq(allergyStatements.patientUserId, patientId));
  if (existing && (existing.reviewedAt || existing.statedByRole === "doctor")) fail(409, "dispute_instead", "A clinician recorded or reviewed this. Add an allergy to the list if something is missing, or tell your clinician.");
}

export async function clearAllergyStatement(actor: Actor, patientId: string) {
  await authorize(actor, patientId);
  await refuseOverwritingReviewed(actor, patientId);
  const hasEntries = await db.select({ id: healthEntries.id }).from(healthEntries).where(and(eq(healthEntries.patientUserId, patientId), eq(healthEntries.kind, "allergy"), eq(healthEntries.status, "active"))).limit(1);
  if (hasEntries.length) fail(409, "has_allergies", "There are allergies on the list.");
  await db.delete(allergyStatements).where(eq(allergyStatements.patientUserId, patientId));
  await logAudit({ actorUserId: actor.userId, action: "health_profile.allergy_statement_cleared", targetType: "patient", targetId: patientId, subjectUserId: patientId });
}

/** A clinician records that they reviewed the whole allergy picture with the patient. */
export async function reviewAllergies(actor: Actor, patientId: string) {
  if (actor.role !== "doctor") fail(403, "forbidden", "Only a clinician can review.");
  await authorize(actor, patientId);
  const view = await allergyView(patientId);
  if (view.picture === "not_collected") fail(409, "nothing_to_review", "Nothing has been recorded about allergies yet.");
  const [existing] = await db.select().from(allergyStatements).where(eq(allergyStatements.patientUserId, patientId));
  if (existing) await db.update(allergyStatements).set({ reviewedByUserId: actor.userId, reviewedAt: new Date() }).where(eq(allergyStatements.patientUserId, patientId));
  else {
    // The list has allergies but no statement row yet: record the review against a "has_known" statement by the clinician.
    await db.insert(allergyStatements).values({ patientUserId: patientId, state: "has_known", statedByUserId: actor.userId, statedByRole: "doctor", reviewedByUserId: actor.userId, reviewedAt: new Date() });
  }
  await logAudit({ actorUserId: actor.userId, action: "health_profile.allergies_reviewed", targetType: "patient", targetId: patientId, subjectUserId: patientId });
}

// ---------------------------------------------------------------------------------------------- entries

export interface EntryView {
  id: string;
  kind: EntryKind;
  data: Record<string, unknown>;
  source: "patient_reported" | "clinician_entered";
  enteredBy: { role: "patient" | "doctor"; name: string | null };
  enteredAt: Date;
  verified: { at: Date; byName: string | null } | null;
  disputed: { at: Date; note: string | null } | null;
  amended: boolean;
}

async function names(ids: string[]): Promise<Map<string, string>> {
  if (!ids.length) return new Map();
  const rows = await db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, ids));
  return new Map(rows.map((r) => [r.id, r.name]));
}

async function toViews(rows: HealthEntry[]): Promise<EntryView[]> {
  const nm = await names(Array.from(new Set(rows.flatMap((r) => [r.enteredByUserId, r.verifiedByUserId].filter(Boolean) as string[]))));
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind as EntryKind,
    data: r.data,
    source: r.source as EntryView["source"],
    // A patient sees who helped; a clinician is named, the patient is "you" to themselves and "the patient" to others.
    enteredBy: { role: r.enteredByRole as "patient" | "doctor", name: r.enteredByRole === "doctor" ? nm.get(r.enteredByUserId) ?? null : null },
    enteredAt: r.createdAt,
    verified: r.verifiedAt ? { at: r.verifiedAt, byName: r.verifiedByUserId ? nm.get(r.verifiedByUserId) ?? null : null } : null,
    disputed: r.disputedAt ? { at: r.disputedAt, note: r.disputeNote } : null,
    amended: !!r.supersedesId,
  }));
}

export async function listEntries(actor: Actor, patientId: string, kind?: EntryKind): Promise<EntryView[]> {
  await authorize(actor, patientId);
  const where = [eq(healthEntries.patientUserId, patientId), eq(healthEntries.status, "active")];
  if (kind) where.push(eq(healthEntries.kind, kind));
  const rows = await db.select().from(healthEntries).where(and(...where)).orderBy(healthEntries.createdAt);
  return toViews(rows);
}

export function parseEntryData(kind: EntryKind, data: unknown) {
  if (!ENTRY_KINDS.includes(kind)) fail(400, "bad_kind", "Unknown kind of entry");
  const parsed = ENTRY_DATA[kind].safeParse(data);
  if (!parsed.success) fail(400, "invalid", parsed.error.issues[0]?.message || "Those details aren't valid");
  return (parsed as { data: Record<string, unknown> }).data;
}

const sourceFor = (actor: Actor) => (actor.role === "doctor" ? ("clinician_entered" as const) : ("patient_reported" as const));

async function event(entryId: string, action: string, actor: Actor, data?: Record<string, unknown> | null, note?: string | null) {
  await db.insert(healthEntryEvents).values({ entryId, action, actorUserId: actor.userId, actorRole: actor.role, data: data ?? null, note: note ?? null });
}

async function syncProfileSectionStarted(patientId: string, kind: EntryKind) {
  const section = SECTION_OF_KIND[kind];
  await db.insert(onboardingSections).values({ patientUserId: patientId, section, status: "in_progress" }).onConflictDoNothing();
}

export async function createEntry(actor: Actor, patientId: string, kind: EntryKind, rawData: unknown): Promise<EntryView> {
  await authorize(actor, patientId);
  await requireConsent(patientId);
  const data = parseEntryData(kind, rawData);
  const [row] = await db.insert(healthEntries).values({ patientUserId: patientId, kind, data, source: sourceFor(actor), enteredByUserId: actor.userId, enteredByRole: actor.role }).returning();
  await event(row.id, "created", actor, data);
  if (kind === "allergy") {
    // Having an allergy on the list IS the statement that there are known allergies.
    const values = { state: "has_known", statedByUserId: actor.userId, statedByRole: actor.role, statedAt: new Date(), reviewedByUserId: null, reviewedAt: null };
    await db.insert(allergyStatements).values({ patientUserId: patientId, ...values }).onConflictDoUpdate({ target: allergyStatements.patientUserId, set: values });
  }
  if (actor.role === "patient") await syncProfileSectionStarted(patientId, kind);
  await logAudit({ actorUserId: actor.userId, action: "health_profile.entry_created", targetType: "health_entry", targetId: row.id, subjectUserId: patientId, metadata: { kind, source: row.source } });
  return (await toViews([row]))[0];
}

async function loadActive(patientId: string, id: string): Promise<HealthEntry> {
  const [row] = await db.select().from(healthEntries).where(and(eq(healthEntries.id, id), eq(healthEntries.patientUserId, patientId)));
  if (!row) fail(404, "not_found", "Not found");
  if (row!.status !== "active") fail(409, "not_active", "That entry has already been changed.");
  return row!;
}

/** Changes are made by adding a new entry that supersedes the old one. The old one stays, with its author and its time. */
export async function amendEntry(actor: Actor, patientId: string, id: string, rawData: unknown): Promise<EntryView> {
  await authorize(actor, patientId);
  await requireConsent(patientId);
  const old = await loadActive(patientId, id);
  // A patient does not replace what a clinician entered or checked (that would turn a checked entry into an unchecked one without a
  // trace the clinician can see): they ask for a correction, and the clinician amends it.
  if (actor.role === "patient" && (old.source === "clinician_entered" || old.verifiedAt)) fail(409, "dispute_instead", "A clinician entered or checked this. Ask for a correction instead.");
  const data = parseEntryData(old.kind as EntryKind, rawData);
  return db.transaction(async (tx) => {
    const [fresh] = await tx.insert(healthEntries).values({ patientUserId: patientId, kind: old.kind, data, source: sourceFor(actor), enteredByUserId: actor.userId, enteredByRole: actor.role, supersedesId: old.id }).returning();
    const [done] = await tx.update(healthEntries).set({ status: "superseded" }).where(and(eq(healthEntries.id, old.id), eq(healthEntries.status, "active"))).returning({ id: healthEntries.id });
    if (!done) throw new ProfileError(409, "not_active", "That entry has already been changed.");
    await tx.insert(healthEntryEvents).values([
      { entryId: old.id, action: "amended", actorUserId: actor.userId, actorRole: actor.role, data: null, note: `superseded by ${fresh.id}` },
      { entryId: fresh.id, action: "created", actorUserId: actor.userId, actorRole: actor.role, data, note: `amends ${old.id}` },
    ]);
    await logAudit({ actorUserId: actor.userId, action: "health_profile.entry_amended", targetType: "health_entry", targetId: fresh.id, subjectUserId: patientId, metadata: { kind: old.kind, supersedes: old.id } });
    return (await toViews([fresh]))[0];
  });
}

/**
 * Removing. A patient may remove what they reported themselves and nobody has verified. Anything a clinician entered or verified
 * is disputed instead (so the clinician sees the objection), never silently dropped. A clinician may remove only what a
 * clinician entered.
 */
export async function withdrawEntry(actor: Actor, patientId: string, id: string, note?: string) {
  await authorize(actor, patientId);
  const row = await loadActive(patientId, id);
  const allowed = actor.role === "patient" ? row.source === "patient_reported" && !row.verifiedAt : row.source === "clinician_entered";
  if (!allowed) fail(409, "dispute_instead", actor.role === "patient" ? "A clinician has entered or verified this. Ask for a correction instead." : "Only what a clinician entered can be removed by a clinician.");
  const [done] = await db.update(healthEntries).set({ status: "withdrawn" }).where(and(eq(healthEntries.id, id), eq(healthEntries.status, "active"))).returning({ id: healthEntries.id });
  if (!done) fail(409, "not_active", "That entry has already been changed.");
  await event(id, "withdrawn", actor, null, note);
  if (row.kind === "allergy") {
    const left = await db.select({ id: healthEntries.id }).from(healthEntries).where(and(eq(healthEntries.patientUserId, patientId), eq(healthEntries.kind, "allergy"), eq(healthEntries.status, "active"))).limit(1);
    // The list is empty again: that is "not collected", not "none". The earlier statement no longer describes anything.
    if (!left.length) await db.delete(allergyStatements).where(eq(allergyStatements.patientUserId, patientId));
  }
  await logAudit({ actorUserId: actor.userId, action: "health_profile.entry_withdrawn", targetType: "health_entry", targetId: id, subjectUserId: patientId, metadata: { kind: row.kind } });
}

export async function verifyEntry(actor: Actor, patientId: string, id: string) {
  if (actor.role !== "doctor") fail(403, "forbidden", "Only a clinician can verify.");
  await authorize(actor, patientId);
  const row = await loadActive(patientId, id);
  if (row.verifiedAt) fail(409, "already_verified", "Already verified.");
  await db.update(healthEntries).set({ verifiedByUserId: actor.userId, verifiedAt: new Date(), disputedAt: null, disputeNote: null }).where(eq(healthEntries.id, id));
  await event(id, "verified", actor);
  await logAudit({ actorUserId: actor.userId, action: "health_profile.entry_verified", targetType: "health_entry", targetId: id, subjectUserId: patientId, metadata: { kind: row.kind } });
}

export async function disputeEntry(actor: Actor, patientId: string, id: string, note: string) {
  if (actor.role !== "patient") fail(403, "forbidden", "Only the patient can ask for a correction.");
  await authorize(actor, patientId);
  const row = await loadActive(patientId, id);
  await db.update(healthEntries).set({ disputedAt: new Date(), disputeNote: note.slice(0, 500) }).where(eq(healthEntries.id, row.id));
  await event(id, "disputed", actor, null, note.slice(0, 500));
  await logAudit({ actorUserId: actor.userId, action: "health_profile.entry_disputed", targetType: "health_entry", targetId: id, subjectUserId: patientId, metadata: { kind: row.kind } });
}

export async function entryHistory(actor: Actor, patientId: string, id: string) {
  await authorize(actor, patientId);
  const [row] = await db.select().from(healthEntries).where(and(eq(healthEntries.id, id), eq(healthEntries.patientUserId, patientId)));
  if (!row) fail(404, "not_found", "Not found");
  const events = await db.select().from(healthEntryEvents).where(eq(healthEntryEvents.entryId, id)).orderBy(healthEntryEvents.createdAt);
  const nm = await names(Array.from(new Set(events.map((e) => e.actorUserId))));
  return events.map((e) => ({ action: e.action, at: e.createdAt, by: e.actorRole, name: e.actorRole === "doctor" ? nm.get(e.actorUserId) ?? null : null, note: e.note }));
}

// ---------------------------------------------------------------------------------------------- sections and overview

export async function setSectionStatus(patientId: string, section: ProfileSection, status: "in_progress" | "complete" | "skipped") {
  if (!PROFILE_SECTIONS.includes(section)) fail(400, "bad_section", "Unknown section");
  await db.insert(onboardingSections).values({ patientUserId: patientId, section, status }).onConflictDoUpdate({ target: [onboardingSections.patientUserId, onboardingSections.section], set: { status, updatedAt: new Date() } });
}

export type SectionState = "not_started" | "in_progress" | "complete" | "skipped";

export async function overview(patientId: string) {
  const [rows, consent, allergy, active, grants] = await Promise.all([
    db.select().from(onboardingSections).where(eq(onboardingSections.patientUserId, patientId)),
    currentConsent(patientId),
    allergyView(patientId),
    db.select({ kind: healthEntries.kind, verifiedAt: healthEntries.verifiedAt }).from(healthEntries).where(and(eq(healthEntries.patientUserId, patientId), eq(healthEntries.status, "active"))),
    listGrants(patientId),
  ]);
  const stateOf = (s: ProfileSection): SectionState => (rows.find((r) => r.section === s)?.status as SectionState | undefined) ?? "not_started";
  const counts: Record<string, number> = {};
  for (const e of active) counts[e.kind] = (counts[e.kind] ?? 0) + 1;
  return {
    sections: Object.fromEntries(PROFILE_SECTIONS.map((s) => [s, stateOf(s)])) as Record<ProfileSection, SectionState>,
    allergy,
    counts,
    unverified: active.filter((e) => !e.verifiedAt).length,
    consent,
    grants: grants.filter((g) => g.state === "active"),
  };
}

export const ALLERGY_STATES_FOR_STATEMENT = ALLERGY_STATES.filter((s) => s !== "has_known");

/** Everything held about this patient's health information, with provenance and history, for their own data download. */
export async function exportProfile(patientId: string) {
  // The person's own private details (their data download): the database releases these to them, the server, or a clinician they authorised.
  const u = await storage.getUserPrivate(patientId);
  const entries = await db.select().from(healthEntries).where(eq(healthEntries.patientUserId, patientId)).orderBy(healthEntries.createdAt);
  const events = entries.length ? await db.select().from(healthEntryEvents).where(inArray(healthEntryEvents.entryId, entries.map((e) => e.id))).orderBy(healthEntryEvents.createdAt) : [];
  const nm = await names(Array.from(new Set([...entries.flatMap((e) => [e.enteredByUserId, e.verifiedByUserId].filter(Boolean) as string[])])));
  return {
    about: { preferredName: u?.preferredName ?? null, dateOfBirth: u?.dateOfBirth ?? null, country: u?.country ?? null, timezone: u?.timezone ?? null, contactMethod: u?.contactMethod ?? null, accessibilityNotes: u?.accessibilityNotes ?? null,
      emergencyContact: { name: u?.emergencyContactName ?? null, phone: u?.emergencyContactPhone ?? null, relationship: u?.emergencyContactRelationship ?? null }, carePreferences: u?.carePreferences ?? {} },
    allergies: await allergyView(patientId),
    entries: entries.map((e) => ({
      kind: e.kind, status: e.status, data: e.data, source: e.source, enteredByRole: e.enteredByRole, enteredByName: e.enteredByRole === "doctor" ? nm.get(e.enteredByUserId) ?? null : null,
      enteredAt: e.createdAt, verifiedAt: e.verifiedAt, verifiedByName: e.verifiedByUserId ? nm.get(e.verifiedByUserId) ?? null : null, disputedAt: e.disputedAt, amends: e.supersedesId ?? null,
      history: events.filter((v) => v.entryId === e.id).map((v) => ({ action: v.action, by: v.actorRole, at: v.createdAt, note: v.note })),
    })),
    consents: await db.select({ purpose: patientConsents.purpose, version: patientConsents.version, grantedAt: patientConsents.grantedAt, revokedAt: patientConsents.revokedAt }).from(patientConsents).where(eq(patientConsents.patientUserId, patientId)),
    clinicianHelp: await listGrants(patientId),
  };
}
