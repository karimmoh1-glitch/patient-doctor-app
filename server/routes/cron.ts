import { Router } from "express";
import crypto from "crypto";
import { makeLimiter } from "../middleware/rateLimit";
import { storage } from "../storage";
import { dispatchAppointmentReminders, dispatchDueReminders, REMINDER_JOB } from "../services/reminderService";

const router = Router();

// Someone guessing the secret gets a handful of tries a minute, not unlimited ones.
const guessLimiter = makeLimiter({ windowMs: 60_000, limit: 30, failuresOnly: true, message: "Too many attempts." });

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
  try {
    const expired = await storage.expireDuePrescriptions(now);
    const result = await dispatchDueReminders(now, { emailEnabled: !!process.env.RESEND_API_KEY });
    const appointmentNotices = await dispatchAppointmentReminders(now);
    const summary = { ...result, expiredPrescriptions: expired.length, appointmentNotices };
    await storage.recordJobRun(REMINDER_JOB, now, summary, { ok: true });
    // Counts only: never a name, an address or a medicine.
    console.log(`[reminders] ok due=${result.due} inApp=${result.inApp} emailSent=${result.emailSent} emailFailed=${result.emailFailed} retried=${result.emailRetried}`);
    res.json({ ok: true, ...summary });
  } catch (err: any) {
    console.error("[reminders] run failed:", err?.name || "Error");
    await storage.recordJobRun(REMINDER_JOB, now, {}, { ok: false, error: String(err?.name || "Error").slice(0, 60) }).catch(() => {});
    res.status(500).json({ ok: false, message: "The reminder run failed" });
  }
}

router.get("/reminders", guessLimiter, runReminders);
router.post("/reminders", guessLimiter, runReminders);

export default router;
