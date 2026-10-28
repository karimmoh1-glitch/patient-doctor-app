import type { Express } from "express";
import type { Server } from "http";
import authRoutes from "./routes/auth";
import doctorRoutes from "./routes/doctors";
import symptomRoutes from "./routes/symptoms";
import pairingRoutes from "./routes/pairings";
import conversationRoutes from "./routes/conversations";
import adminRoutes from "./routes/admin";
import appointmentRoutes from "./routes/appointments";
import prescriptionRoutes from "./routes/prescriptions";
import medicationRoutes from "./routes/medications";
import documentRoutes from "./routes/documents";
import followUpRoutes from "./routes/followups";
import sharingRoutes from "./routes/sharing";
import timelineRoutes from "./routes/timeline";
import dashboardRoutes from "./routes/dashboard";
import careCircleRoutes from "./routes/careCircle";
import emergencyRoutes from "./routes/emergency";
import auditRoutes from "./routes/audit";
import reminderRoutes from "./routes/reminders";
import notificationRoutes from "./routes/notifications";
import cronRoutes from "./routes/cron";
import webhookRoutes from "./routes/webhooks";
import healthProfileRoutes from "./routes/healthProfile";
import assistedProfileRoutes from "./routes/assistedProfile";
import pairingInvitationRoutes from "./routes/pairingInvitations";
import personalReminderRoutes from "./routes/personalReminders";
import orgRoutes from "./routes/orgs";
import myOrganizationRoutes from "./routes/myOrganizations";
import configRoutes from "./routes/config";
import meRoutes from "./routes/me";

import type { Router } from "express";

/** Every API router and where it is mounted. One list, so tests can inspect exactly what the server exposes. */
export const ROUTER_MOUNTS: [prefix: string, router: Router][] = [
  ["/api/auth", authRoutes],
  ["/api/doctors", doctorRoutes],
  ["/api/symptom-reports", symptomRoutes],
  ["/api/pairings", pairingRoutes],
  ["/api/conversations", conversationRoutes],
  ["/api/admin", adminRoutes],
  ["/api/appointments", appointmentRoutes],
  ["/api/prescriptions", prescriptionRoutes],
  ["/api/medications", medicationRoutes],
  ["/api/documents", documentRoutes],
  ["/api/follow-ups", followUpRoutes],
  ["/api/sharing", sharingRoutes],
  ["/api/timeline", timelineRoutes],
  ["/api/dashboard", dashboardRoutes],
  ["/api/care-circle", careCircleRoutes],
  ["/api/emergency-profile", emergencyRoutes],
  ["/api/audit-log", auditRoutes],
  ["/api/config", configRoutes],
  ["/api/reminders", reminderRoutes],
  ["/api/notifications", notificationRoutes],
  ["/api/cron", cronRoutes],
  ["/api/me", meRoutes],
  ["/api/health-profile", healthProfileRoutes],
  ["/api/assist", assistedProfileRoutes],
  ["/api/pairing-invitations", pairingInvitationRoutes],
  ["/api/personal-reminders", personalReminderRoutes],
  ["/api/orgs", orgRoutes],
  ["/api/my-organizations", myOrganizationRoutes],
];

/** Mounted BEFORE the JSON body parser: a provider's signature covers the exact bytes it sent. */
export const RAW_BODY_MOUNTS: [string, Router][] = [["/api/webhooks", webhookRoutes]];

/** A pilot can run without the organization-staff module (ORGANIZATIONS_DISABLED=true): its endpoints answer "not available", nothing else changes. */
export const organizationsEnabled = (): boolean => process.env.ORGANIZATIONS_DISABLED !== "true";

export async function registerRoutes(_httpServer: Server, app: Express): Promise<void> {
  for (const [prefix, router] of ROUTER_MOUNTS) {
    if (prefix === "/api/orgs" && !organizationsEnabled()) {
      app.use(prefix, (_req, res) => res.status(404).json({ message: "Organizations aren't available on this service yet." }));
      continue;
    }
    app.use(prefix, router);
  }
}
