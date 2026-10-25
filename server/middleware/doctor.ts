import type { Request, Response, NextFunction } from "express";
import { storage } from "../storage";
import { doctorStatusFor } from "../services/doctorStatus";

/**
 * Clinical routes. Registering as a doctor is not the same as being one:
 * only an account whose application an administrator approved (and which is
 * not suspended) gets through. The status is read live from the database on
 * every request, so a suspension takes effect immediately.
 *
 * Use after requireAuth. Attaches req.doctorProfile.
 */
export async function requireApprovedDoctor(req: Request, res: Response, next: NextFunction) {
  if ((req as any).userRole !== "doctor") {
    return res.status(403).json({ message: "Access denied" });
  }
  const userId = (req as any).userId as string;
  const status = await doctorStatusFor(userId);
  if (status !== "approved") {
    return res.status(403).json({
      message: "Your doctor account has not been approved for patient care yet.",
      code: "doctor_not_approved",
      doctorStatus: status,
    });
  }
  const profile = await storage.getDoctorProfileByUserId(userId);
  if (!profile || !profile.active) {
    return res.status(403).json({ message: "Your doctor account is not active.", code: "doctor_not_approved", doctorStatus: "suspended" });
  }
  (req as any).doctorProfile = profile;
  next();
}

/** For routes shared by patients and doctors: a doctor must be approved, a patient passes straight through. */
export function requirePatientOrApprovedDoctor(req: Request, res: Response, next: NextFunction) {
  const role = (req as any).userRole as string;
  if (role === "patient") return next();
  return requireApprovedDoctor(req, res, next);
}
