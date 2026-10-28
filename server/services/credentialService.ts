import { and, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db";
import { withScope } from "../dbContext";
import { CREDENTIAL_SOURCES, credentialEvents, doctorCredentials, doctorProfiles, type CredentialStatus, type DoctorCredential } from "@shared/schema";

/**
 * Clinician credential verification.
 *
 * "Verified" means a named reviewer recorded how the credential was checked (document, registry lookup, or confirmation from
 * the issuer), what they saw, and until when it is valid. A stored "verified" whose expiry has passed is reported as
 * "expired". Avela does not look anything up itself: it records a person's check and says so.
 */

const MAX_VALIDITY_YEARS = 6;

export const verificationInput = z.object({
  source: z.enum(CREDENTIAL_SOURCES),
  evidenceNote: z.string().trim().min(10, "Say what you checked and where").max(1000),
  expiresAt: z
    .string()
    .datetime()
    .transform((v) => new Date(v))
    .refine((d) => d.getTime() > Date.now(), "The expiry must be in the future")
    .refine((d) => d.getTime() < Date.now() + MAX_VALIDITY_YEARS * 365.25 * 86_400_000, `Expiry more than ${MAX_VALIDITY_YEARS} years away is not accepted`),
});
export type VerificationInput = z.infer<typeof verificationInput>;

export function effectiveStatus(c: Pick<DoctorCredential, "status" | "expiresAt">, now = new Date()): CredentialStatus {
  if (c.status === "verified" && c.expiresAt && c.expiresAt.getTime() <= now.getTime()) return "expired";
  return c.status as CredentialStatus;
}

export type CredentialView = Omit<DoctorCredential, "status"> & { status: CredentialStatus; storedStatus: string; doctorName: string | null };

const view = (c: DoctorCredential, doctorName: string | null, now = new Date()): CredentialView => ({ ...c, status: effectiveStatus(c, now), storedStatus: c.status, doctorName });

/** After any change: the profile is listed only while a verified, unexpired licence stands behind it. */
async function syncProfileExpiry(tx: Pick<typeof db, "select" | "update">, userId: string | null) {
  if (!userId) return;
  const licences = await tx.select().from(doctorCredentials).where(and(eq(doctorCredentials.userId, userId), eq(doctorCredentials.kind, "license")));
  const live = licences.filter((c) => c.status === "verified" && c.expiresAt);
  // No verified licence (rejected or suspended): not listed from now on. Otherwise listed until the earliest expiry.
  const until = live.length ? new Date(Math.min(...live.map((c) => c.expiresAt!.getTime()))) : new Date();
  await tx.update(doctorProfiles).set({ credentialExpiresAt: until }).where(eq(doctorProfiles.userId, userId));
}

async function transition(id: string, actorUserId: string, to: CredentialStatus, patch: Partial<typeof doctorCredentials.$inferInsert>, note: string | null, allowedFrom: string[]) {
  return withScope("review", () =>
    db.transaction(async (tx) => {
      const [current] = await tx.select().from(doctorCredentials).where(eq(doctorCredentials.id, id)).for("update");
      if (!current || !allowedFrom.includes(current.status)) return undefined;
      const [updated] = await tx
        .update(doctorCredentials)
        .set({ ...patch, status: to, reviewerUserId: actorUserId, reviewedAt: new Date(), updatedAt: new Date() })
        .where(eq(doctorCredentials.id, id))
        .returning();
      await tx.insert(credentialEvents).values({ credentialId: id, fromStatus: current.status, toStatus: to, actorUserId, source: patch.source ?? null, note });
      await syncProfileExpiry(tx, updated.userId);
      return updated;
    }),
  );
}

/** Verify (or renew) a credential. Allowed from pending, expired-by-time, or already verified (renewal). */
export const verifyCredential = (id: string, actorUserId: string, input: VerificationInput) =>
  transition(id, actorUserId, "verified", { source: input.source, evidenceNote: input.evidenceNote, expiresAt: input.expiresAt }, input.evidenceNote, ["submitted", "pending", "verified", "suspended"]);

export const rejectCredential = (id: string, actorUserId: string, note: string) =>
  transition(id, actorUserId, "rejected", { evidenceNote: note }, note, ["submitted", "pending", "verified"]);

export const suspendCredential = (id: string, actorUserId: string, note: string) =>
  transition(id, actorUserId, "suspended", {}, note, ["verified"]);

export async function listCredentials(filter: "all" | "expiring" | "expired" | "open", now = new Date()): Promise<CredentialView[]> {
  const rows = await withScope("review", () =>
    db
      .select({ c: doctorCredentials, name: doctorProfiles.name })
      .from(doctorCredentials)
      .leftJoin(doctorProfiles, eq(doctorProfiles.userId, doctorCredentials.userId))
      .orderBy(desc(doctorCredentials.updatedAt))
      .limit(5000),
  );
  const soon = now.getTime() + 60 * 86_400_000;
  return rows
    .map((r) => view(r.c, r.name, now))
    .filter((v) => {
      if (filter === "expired") return v.status === "expired";
      if (filter === "expiring") return v.status === "verified" && !!v.expiresAt && v.expiresAt.getTime() < soon;
      if (filter === "open") return v.status === "pending" || v.status === "submitted";
      return true;
    });
}

export async function credentialHistory(id: string) {
  return withScope("review", () => db.select().from(credentialEvents).where(eq(credentialEvents.credentialId, id)).orderBy(credentialEvents.createdAt));
}

/** What a clinician may see about their own credentials, and what a patient may be told about a listed clinician. */
export async function credentialSummaryForUser(userId: string, now = new Date()) {
  const rows = await withScope("review", () => db.select().from(doctorCredentials).where(and(eq(doctorCredentials.userId, userId), eq(doctorCredentials.kind, "license"))));
  const c = rows[0];
  if (!c) return null;
  return { status: effectiveStatus(c, now), source: c.status === "verified" ? c.source : null, checkedAt: c.status === "verified" ? c.reviewedAt : null, expiresAt: c.expiresAt };
}

/** Counts for the operations screen. */
export async function credentialCounts(now = new Date()) {
  const all = await listCredentials("all", now);
  const count = (s: CredentialStatus) => all.filter((c) => c.status === s).length;
  return { pending: count("pending") + count("submitted"), verified: count("verified"), expired: count("expired"), suspended: count("suspended"), rejected: count("rejected"), expiringWithin60Days: (await listCredentials("expiring", now)).length };
}

void sql;
