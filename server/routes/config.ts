import { Router } from "express";
import { videoAvailable } from "../services/videoService";
import { DOCUMENT_UPLOADS_ENABLED } from "./documents";
import { reminderDeliveryStatus } from "../services/reminderService";

const router = Router();

// Public, non-sensitive description of what this deployment can actually do,
// so the interface can say so plainly instead of implying capabilities that
// aren't configured (a fake "online" agent, a video button that goes nowhere).
// Nothing here is a secret or identifies a person.
router.get("/", async (_req, res) => {
  // Where this deployment operates decides the number; there is deliberately no default.
  const configured = (process.env.EMERGENCY_NUMBER || process.env.VITE_EMERGENCY_NUMBER || "").trim();
  const emergencyNumber = /^[0-9+\-() ]{2,20}$/.test(configured) ? configured : null;
  res.json({
    emergencyNumber,
    features: {
      // Real, configured capabilities only. Add a flag here when — and only
      // when — an integration is wired up and tested.
      email: !!process.env.RESEND_API_KEY,
      videoVisits: videoAvailable(),
      documentUploads: DOCUMENT_UPLOADS_ENABLED,
      // "active" only if the scheduler has actually run recently; otherwise the
      // interface says reminders are saved but not being delivered.
      reminderDelivery: await reminderDeliveryStatus(),
      smsReminders: false,
      liveSupportChat: false,
    },
    support: {
      // Set these to publish a real support line. When unset, the app shows
      // no support phone/email rather than a placeholder.
      phone: process.env.SUPPORT_PHONE || null,
      email: process.env.SUPPORT_EMAIL || null,
      hours: process.env.SUPPORT_HOURS || null,
    },
  });
});

export default router;
