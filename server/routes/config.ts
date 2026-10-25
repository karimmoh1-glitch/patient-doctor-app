import { Router } from "express";
import { isDemoMode } from "../config";
import { videoAvailable } from "../services/videoService";
import { DOCUMENT_UPLOADS_ENABLED } from "./documents";
import { reminderDeliveryStatus } from "../services/reminderService";

const router = Router();

// Public, non-sensitive description of what this deployment can actually do,
// so the interface can say so plainly instead of implying capabilities that
// aren't configured (a fake "online" agent, a video button that goes nowhere).
// Nothing here is a secret or identifies a person.
router.get("/", async (_req, res) => {
  res.json({
    demoMode: isDemoMode(),
    features: {
      // Real, configured capabilities only. Add a flag here when — and only
      // when — an integration is wired up and tested.
      email: !!process.env.RESEND_API_KEY,
      videoVisits: videoAvailable(),
      // Speech-to-text. A real provider adapter is not implemented yet
      // (see speechService.ts), so the only "voice" available is the
      // clearly-labelled demo transcription in demo mode.
      voiceInput: isDemoMode() && process.env.NODE_ENV !== "production",
      voiceInputIsDemo: !process.env.STT_PROVIDER,
      documentUploads: DOCUMENT_UPLOADS_ENABLED,
      // "active" only if the scheduler has actually run recently; otherwise the
      // interface says reminders are saved but not being delivered.
      reminderDelivery: await reminderDeliveryStatus(),
      smsReminders: false,
      liveSupportChat: false,
      aiAssistant: !!process.env.OPENAI_API_KEY && process.env.AI_PHI_PROCESSING_CONFIRMED === "true",
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
