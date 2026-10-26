import { Router } from "express";
import { z } from "zod";
import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "../db";
import { assistGrants, users, ENTRY_KINDS, type EntryKind } from "@shared/schema";
import { requireAuth } from "../middleware/auth";
import { requireApprovedDoctor } from "../middleware/doctor";
import { makeLimiter, userKey } from "../middleware/rateLimit";
import { logAuditStrict } from "../services/auditService";
import * as profile from "../services/healthProfile";
import { handle } from "./healthProfile";

/**
 * A clinician helping a patient with their health information. Every route names the patient and is allowed only while that
 * patient's grant to this clinician is live, the connection is accepted, and the clinician is approved. Anything else is "not found",
 * so a clinician cannot tell a patient who does not exist from one who has not authorised them. Reads are written to the audit log
 * before anything is returned.
 */
const router = Router();
const doctorOnly = [requireAuth, requireApprovedDoctor] as const;
const writeLimiter = makeLimiter({ windowMs: 60 * 1000, limit: 60, keyGenerator: userKey, message: "You're saving very quickly. Please wait a moment." });
const actor = (req: any): profile.Actor => ({ userId: req.userId as string, role: "doctor" });
const kindSchema = z.enum(ENTRY_KINDS);

// The patients who have asked this clinician for help right now. Names only.
router.get("/patients", ...doctorOnly, handle(async (req, res) => {
  const doctorProfile = (req as any).doctorProfile;
  const rows = await db
    .select({ id: assistGrants.id, patientUserId: assistGrants.patientUserId, name: users.name, expiresAt: assistGrants.expiresAt })
    .from(assistGrants)
    .innerJoin(users, eq(users.id, assistGrants.patientUserId))
    .where(and(eq(assistGrants.doctorProfileId, doctorProfile.id), isNull(assistGrants.revokedAt), sql`${assistGrants.expiresAt} > now()`));
  const live: typeof rows = [];
  for (const r of rows) if (await profile.activeGrantFor(doctorProfile.id, r.patientUserId)) live.push(r);
  res.json(live);
}));

router.get("/:patientUserId", ...doctorOnly, handle(async (req, res) => {
  const patientId = req.params.patientUserId;
  const entries = await profile.listEntries(actor(req), patientId); // authorises
  await logAuditStrict({ actorUserId: (req as any).userId, action: "health_profile.read_by_clinician", targetType: "patient", targetId: patientId, subjectUserId: patientId });
  const [u] = await db.select({ name: users.name, language: users.language }).from(users).where(eq(users.id, patientId));
  res.json({ patient: { name: u?.name ?? "", language: u?.language ?? "en" }, allergy: await profile.allergyView(patientId), entries });
}));

router.post("/:patientUserId/entries", ...doctorOnly, writeLimiter, handle(async (req, res) => {
  const kind = kindSchema.safeParse(req.body?.kind);
  if (!kind.success) return res.status(400).json({ message: "Unknown kind" });
  res.status(201).json(await profile.createEntry(actor(req), req.params.patientUserId, kind.data as EntryKind, req.body?.data));
}));

router.post("/:patientUserId/entries/:id/amend", ...doctorOnly, writeLimiter, handle(async (req, res) => {
  res.json(await profile.amendEntry(actor(req), req.params.patientUserId, req.params.id, req.body?.data));
}));

router.post("/:patientUserId/entries/:id/verify", ...doctorOnly, writeLimiter, handle(async (req, res) => {
  await profile.verifyEntry(actor(req), req.params.patientUserId, req.params.id);
  res.json({ ok: true });
}));

router.post("/:patientUserId/entries/:id/withdraw", ...doctorOnly, writeLimiter, handle(async (req, res) => {
  await profile.withdrawEntry(actor(req), req.params.patientUserId, req.params.id);
  res.json({ ok: true });
}));

router.put("/:patientUserId/allergies/statement", ...doctorOnly, writeLimiter, handle(async (req, res) => {
  const parsed = z.object({ state: z.enum(["none_known", "unknown"]) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ message: "Choose one of the options" });
  await profile.stateAllergies(actor(req), req.params.patientUserId, parsed.data.state);
  res.json(await profile.allergyView(req.params.patientUserId));
}));

router.post("/:patientUserId/allergies/review", ...doctorOnly, writeLimiter, handle(async (req, res) => {
  await profile.reviewAllergies(actor(req), req.params.patientUserId);
  res.json(await profile.allergyView(req.params.patientUserId));
}));

export default router;
