import { Router, type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import { requireAuth, requireRole } from "../middleware/auth";
import { makeLimiter, userKey } from "../middleware/rateLimit";
import { storage } from "../storage";
import { resolvePatientTimezone } from "../lib/localTime";
import { reminderDeliveryStatus } from "../services/reminderService";
import * as pr from "../services/personalReminders";

/**
 * Reminders a person sets for themselves. Private to the patient who made them: no doctor, caregiver or administrator reads
 * them, and they work whether or not the patient has a connected doctor.
 */
const router = Router();
const patientOnly = [requireAuth, requireRole("patient")] as const;
const writeLimiter = makeLimiter({ windowMs: 60 * 1000, limit: 60, keyGenerator: userKey, message: "You're saving very quickly. Please wait a moment." });

function handle(fn: (req: Request, res: Response) => Promise<unknown>) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      await fn(req, res);
    } catch (err) {
      if (err instanceof pr.ReminderError) return res.status(err.status).json({ message: err.message, code: err.code });
      next(err);
    }
  };
}
const me = (req: Request) => (req as any).userId as string;

async function zoneFor(req: Request) {
  const user = await storage.getUser(me(req));
  return resolvePatientTimezone(req, user!);
}

router.get("/", ...patientOnly, handle(async (req, res) => {
  const now = new Date();
  res.json({
    reminders: await pr.listReminders(me(req), now),
    // What can really carry a reminder today. Only a channel that is set up is described as working.
    channels: { inApp: true, email: !!process.env.RESEND_API_KEY && !!(await storage.getUser(me(req)))?.emailVerifiedAt, sms: false, push: false },
    emailNeedsConfirmation: !!process.env.RESEND_API_KEY && !(await storage.getUser(me(req)))?.emailVerifiedAt,
    delivery: await reminderDeliveryStatus(now),
  });
}));

router.post("/", ...patientOnly, writeLimiter, handle(async (req, res) => {
  const parsed = pr.reminderInput.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ message: parsed.error.issues[0]?.message || "Those details aren't valid" });
  res.status(201).json(await pr.createReminder(me(req), parsed.data, await zoneFor(req)));
}));

router.put("/:id", ...patientOnly, writeLimiter, handle(async (req, res) => {
  const parsed = pr.reminderInput.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ message: parsed.error.issues[0]?.message || "Those details aren't valid" });
  res.json(await pr.replaceReminder(me(req), req.params.id, parsed.data, await zoneFor(req)));
}));

for (const [path, status] of [["pause", "paused"], ["resume", "active"], ["cancel", "cancelled"]] as const) {
  router.post(`/:id/${path}`, ...patientOnly, writeLimiter, handle(async (req, res) => res.json(await pr.setStatus(me(req), req.params.id, status))));
}

router.post("/:id/snooze", ...patientOnly, writeLimiter, handle(async (req, res) => {
  const parsed = z.object({ minutes: z.number().int().min(5).max(240) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ message: "Choose between 5 minutes and 4 hours" });
  res.json(await pr.snooze(me(req), req.params.id, parsed.data.minutes));
}));

router.delete("/:id", ...patientOnly, writeLimiter, handle(async (req, res) => {
  await pr.removeReminder(me(req), req.params.id);
  res.json({ ok: true });
}));

export default router;
