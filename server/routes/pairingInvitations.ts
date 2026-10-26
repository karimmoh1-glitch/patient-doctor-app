import { Router, type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import { requireAuth, requireRole } from "../middleware/auth";
import { requireApprovedDoctor } from "../middleware/doctor";
import { makeLimiter, userKey } from "../middleware/rateLimit";
import * as inv from "../services/pairingInvitations";

const router = Router();
const patientOnly = [requireAuth, requireRole("patient")] as const;
const doctorOnly = [requireAuth, requireApprovedDoctor] as const;

const createLimiter = makeLimiter({ windowMs: 60 * 60 * 1000, limit: 20, keyGenerator: userKey, message: "You've made a lot of codes. Please wait a while." });
// Guessing is the attack on a code, so the number of tries is limited per person, per minute and per day (failures only).
const tryLimiter = makeLimiter({ windowMs: 60 * 1000, limit: 12, keyGenerator: userKey, message: "That's a lot of tries. Please wait a minute." });
const failureLimiter = makeLimiter({ windowMs: 24 * 60 * 60 * 1000, limit: 40, failuresOnly: true, keyGenerator: userKey, message: "Too many codes that didn't work today. Please try again tomorrow." });

function handle(fn: (req: Request, res: Response) => Promise<unknown>) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      await fn(req, res);
    } catch (err) {
      if (err instanceof inv.InvitationError) return res.status(err.status).json({ message: err.message, code: err.code });
      next(err);
    }
  };
}

const presented = z.union([z.object({ token: z.string().max(100) }).strict(), z.object({ code: z.string().max(30) }).strict()]);

// ---- clinician
router.post("/", ...doctorOnly, createLimiter, handle(async (req, res) => {
  const created = await inv.createInvitation((req as any).userId);
  const origin = process.env.APP_URL?.replace(/\/$/, "") || `${req.protocol}://${req.get("host")}`;
  // The token travels in the URL fragment: it is never sent to a server, a log or a referrer when the page is opened.
  res.status(201).json({ id: created.id, code: created.code, expiresAt: created.expiresAt, url: `${origin}/connect#${created.token}` });
}));

router.get("/", ...doctorOnly, handle(async (req, res) => res.json(await inv.listInvitations((req as any).userId))));

router.delete("/:id", ...doctorOnly, handle(async (req, res) => {
  if (!(await inv.revokeInvitation((req as any).userId, req.params.id))) return res.status(404).json({ message: "Not found" });
  res.json({ ok: true });
}));

// ---- patient
router.post("/preview", ...patientOnly, tryLimiter, failureLimiter, handle(async (req, res) => {
  const parsed = presented.safeParse(req.body);
  if (!parsed.success) return res.status(404).json({ message: "That code isn't valid or has expired.", code: "invalid_code" });
  res.json(await inv.preview((req as any).userId, parsed.data));
}));

router.post("/accept", ...patientOnly, tryLimiter, failureLimiter, handle(async (req, res) => {
  // Connecting needs an explicit yes from the patient, separate from looking at who the code is from.
  if (req.body?.confirm !== true) return res.status(400).json({ message: "Please confirm that you want to connect.", code: "confirm_required" });
  const { confirm: _confirm, ...rest } = req.body;
  const parsed = presented.safeParse(rest);
  if (!parsed.success) return res.status(404).json({ message: "That code isn't valid or has expired.", code: "invalid_code" });
  const result = await inv.acceptInvitation((req as any).userId, parsed.data);
  res.status(result.repeat ? 200 : 201).json({ pairingId: result.pairingId, status: "accepted" });
}));

export default router;
