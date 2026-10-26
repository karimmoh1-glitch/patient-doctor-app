import { Router } from "express";
import crypto from "crypto";
import { makeLimiter } from "../middleware/rateLimit";
import { storage } from "../storage";
import { dispatchAppointmentReminders, dispatchDueReminders, REMINDER_JOB } from "../services/reminderService";
import { dispatchPersonalReminders } from "../services/personalReminders";
import { runScheduledJob, schedulerSource } from "../services/schedulerRun";
import { systemAccess } from "../middleware/systemAccess";

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
  const emailEnabled = !!process.env.RESEND_API_KEY;

  // Reminder delivery comes first and is isolated from housekeeping: a failure to
  // expire old prescriptions must never delay anyone's medicine reminder. Every
  // step is attempted; any failure still makes the whole run a failure.
  const summary = await runScheduledJob({
    job: REMINDER_JOB,
    source: schedulerSource({ get: (name) => req.get(name) }),
    now,
    steps: [
      {
        name: "reminders",
        run: async (ctx) => {
          const r = await dispatchDueReminders(now, { emailEnabled, deadline: ctx.deadline });
          return { counts: { considered: r.considered, due: r.due, inApp: r.inApp, emailSent: r.emailSent, emailFailed: r.emailFailed, emailRetried: r.emailRetried, truncated: r.truncated }, errors: r.errors };
        },
      },
      {
        name: "personalReminders",
        run: async (ctx) => {
          const r = await dispatchPersonalReminders(now, { emailEnabled, deadline: ctx.deadline });
          return { counts: { personalConsidered: r.considered, personalDue: r.due, personalInApp: r.inApp, personalEmailSent: r.emailSent, personalEmailFailed: r.emailFailed, personalEmailSuppressed: r.emailSuppressed, personalEmailRetried: r.emailRetried, personalTruncated: r.truncated, truncated: r.truncated }, errors: r.errors };
        },
      },
      { name: "appointmentNotices", run: async () => ({ counts: { appointmentNotices: await dispatchAppointmentReminders(now) } }) },
      { name: "expiry", run: async () => ({ counts: { expiredPrescriptions: (await storage.expireDuePrescriptions(now)).length } }) },
    ],
  });

  if (summary.status === "skipped") return res.status(202).json({ ok: true, skipped: true, reason: summary.reason });
  if (summary.status === "superseded") return res.json({ ok: true, superseded: true });
  if (summary.status === "failed") return res.status(500).json({ ok: false, message: "The reminder run failed", runId: summary.runId });
  res.json({ ok: true, runId: summary.runId, ...summary.result });
}

router.get("/reminders", systemAccess, guessLimiter, runReminders);
router.post("/reminders", systemAccess, guessLimiter, runReminders);

export default router;
