import { Router } from "express";
import crypto from "crypto";
import { storage } from "../storage";
import { dispatchDueReminders, REMINDER_JOB } from "../services/reminderService";

const router = Router();

// Background work is triggered over HTTP by a scheduler (Vercel Cron, a GitHub
// Actions schedule, or any pinger) that presents CRON_SECRET as a bearer
// token. With no secret configured the endpoint does not exist, so it can
// never be run by an unauthenticated caller.
function authorized(header: string | undefined): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret || !header?.startsWith("Bearer ")) return false;
  const given = Buffer.from(header.slice("Bearer ".length));
  const expected = Buffer.from(secret);
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

async function runReminders(req: any, res: any) {
  if (!process.env.CRON_SECRET) return res.status(503).json({ message: "Scheduled jobs are not configured" });
  if (!authorized(req.headers.authorization)) return res.status(401).json({ message: "Unauthorized" });
  const now = new Date();
  const expired = await storage.expireDuePrescriptions(now);
  const result = await dispatchDueReminders(now, { emailEnabled: !!process.env.RESEND_API_KEY });
  await storage.recordJobRun(REMINDER_JOB, now, { ...result, expiredPrescriptions: expired.length });
  res.json({ ok: true, ...result, expiredPrescriptions: expired.length });
}

router.get("/reminders", runReminders);
router.post("/reminders", runReminders);

export default router;
