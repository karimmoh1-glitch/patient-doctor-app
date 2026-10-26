import { Router } from "express";
import { makeLimiter } from "../middleware/rateLimit";
import { z } from "zod";
import bcrypt from "bcryptjs";
import { storage } from "../storage";
import { requireAuth, requireRole, signToken, createDeviceForLogin } from "../middleware/auth";
import { generateSecureToken, hashToken } from "../services/tokenService";
import { weakPasswordReason } from "../lib/password";
import { normalizeLang } from "../services/serverText";
import { sendCareCircleInviteEmail } from "../services/emailService";
import { logAudit, logAuditStrict } from "../services/auditService";
import { clockInZone, dateKeyInZone, isMedicationActiveOn, patientTimezoneById } from "../lib/localTime";

const router = Router();

// An invitation link is a bearer credential: it is only valid for a week, and
// anyone holding it can try it, so redemption is rate limited.
const INVITE_VALID_MS = 7 * 24 * 60 * 60 * 1000;
function isInviteLive(member: { status: string; invitedAt: Date | null }): boolean {
  return member.status === "invited" && !!member.invitedAt && Date.now() - member.invitedAt.getTime() <= INVITE_VALID_MS;
}

const inviteRedeemLimiter = makeLimiter({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  message: "Too many attempts. Please try again later.",
});

const inviteSendLimiter = makeLimiter({
  windowMs: 60 * 60 * 1000,
  limit: 15,
  message: "You've sent a lot of invitations. Please try again later.",
});

const permissionsSchema = z.object({
  permissionMedicationStatus: z.boolean(),
  permissionAppointments: z.boolean(),
  permissionDeliveryStatus: z.boolean(),
  permissionDocuments: z.boolean(),
  permissionFullRecords: z.boolean(),
});

const inviteSchema = z.object({
  name: z.string().trim().min(1).max(100),
  inviteEmail: z.string().trim().toLowerCase().email().max(254),
  relationshipLabel: z.string().trim().min(1).max(60),
}).merge(permissionsSchema.partial());

// Every patient who invites this exact permission shape by default matches
// the product's example ("Daughter: medication status, appointments,
// delivery status — not full records") without the patient having to
// think about it first; they can still narrow or widen it before sending.
const DEFAULT_PERMISSIONS = {
  permissionMedicationStatus: true,
  permissionAppointments: true,
  permissionDeliveryStatus: true,
  permissionDocuments: false,
  permissionFullRecords: false,
};

router.post("/", requireAuth, requireRole("patient"), inviteSendLimiter, async (req, res) => {
  const parsed = inviteSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: parsed.error.issues[0]?.message || "Invalid invite" });
  }
  const patientUserId = (req as any).userId as string;
  const patient = await storage.getUser(patientUserId);
  if (!patient) return res.status(404).json({ message: "Account not found" });

  const { token, tokenHash } = generateSecureToken();
  const member = await storage.createCareCircleInvite({
    patientUserId,
    name: parsed.data.name,
    inviteEmail: parsed.data.inviteEmail,
    relationshipLabel: parsed.data.relationshipLabel,
    permissionMedicationStatus: parsed.data.permissionMedicationStatus ?? DEFAULT_PERMISSIONS.permissionMedicationStatus,
    permissionAppointments: parsed.data.permissionAppointments ?? DEFAULT_PERMISSIONS.permissionAppointments,
    permissionDeliveryStatus: parsed.data.permissionDeliveryStatus ?? DEFAULT_PERMISSIONS.permissionDeliveryStatus,
    permissionDocuments: parsed.data.permissionDocuments ?? DEFAULT_PERMISSIONS.permissionDocuments,
    permissionFullRecords: parsed.data.permissionFullRecords ?? DEFAULT_PERMISSIONS.permissionFullRecords,
    tokenHash,
  });

  const appUrl = process.env.APP_URL || "http://localhost:3001";
  const inviteLink = `${appUrl}/care-circle/accept?token=${token}`;
  const emailSent = await sendCareCircleInviteEmail(parsed.data.inviteEmail, parsed.data.name, patient.name, inviteLink, normalizeLang(patient.language)).catch(() => false);

  await logAudit({ actorUserId: patientUserId, action: "care_circle.invited", targetType: "care_circle_member", targetId: member.id });

  // The link is returned to the patient who is inviting, so they can send it
  // themselves (text, WhatsApp, in person) when email isn't available —
  // the honest alternative to saying "invitation sent" when it wasn't.
  res.status(201).json({ id: member.id, status: member.status, emailSent: !!emailSent, inviteLink });
});

router.get("/", requireAuth, requireRole("patient"), async (req, res) => {
  const patientUserId = (req as any).userId as string;
  const members = await storage.getCareCircleByPatient(patientUserId);
  res.json(members.map((m) => ({
    id: m.id,
    name: m.name,
    relationshipLabel: m.relationshipLabel,
    status: m.status,
    permissionMedicationStatus: m.permissionMedicationStatus,
    permissionAppointments: m.permissionAppointments,
    permissionDeliveryStatus: m.permissionDeliveryStatus,
    permissionDocuments: m.permissionDocuments,
    permissionFullRecords: m.permissionFullRecords,
    invitedAt: m.invitedAt,
    respondedAt: m.respondedAt,
  })));
});

router.patch("/:id/permissions", requireAuth, requireRole("patient"), async (req, res) => {
  const patientUserId = (req as any).userId as string;
  const parsed = permissionsSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ message: "Invalid permissions" });

  const member = await storage.getCareCircleMember(req.params.id);
  if (!member || member.patientUserId !== patientUserId) {
    return res.status(404).json({ message: "Care Circle member not found" });
  }
  const updated = await storage.updateCareCirclePermissions(member.id, parsed.data);
  await logAudit({ actorUserId: patientUserId, action: "care_circle.permissions_updated", targetType: "care_circle_member", targetId: member.id, metadata: parsed.data });
  res.json(updated);
});

router.delete("/:id", requireAuth, requireRole("patient"), async (req, res) => {
  const patientUserId = (req as any).userId as string;
  const member = await storage.getCareCircleMember(req.params.id);
  if (!member || member.patientUserId !== patientUserId) {
    return res.status(404).json({ message: "Care Circle member not found" });
  }
  const updated = await storage.revokeCareCircleMember(member.id);
  await logAudit({ actorUserId: patientUserId, action: "care_circle.revoked", targetType: "care_circle_member", targetId: member.id });
  res.json(updated);
});

// --- Invite acceptance (public until the token is redeemed) ---

router.get("/invitations/validate/:token", inviteRedeemLimiter, async (req, res) => {
  const tokenHash = hashToken(req.params.token);
  const member = await storage.getCareCircleMemberByTokenHash(tokenHash);
  if (!member || !isInviteLive(member)) {
    return res.status(404).json({ message: "This invite link is invalid or has already been used" });
  }
  const patient = await storage.getUser(member.patientUserId);
  // Tell the page whether this email already has a caregiver account, so
  // it asks for "your password" rather than "choose a password".
  const existing = await storage.getUserByEmail(member.inviteEmail);
  res.json({
    name: member.name,
    relationshipLabel: member.relationshipLabel,
    patientName: patient?.name || "your family member",
    hasAccount: !!existing,
  });
});

const acceptSchema = z.object({ password: z.string().min(8).max(200) });

router.post("/invitations/accept/:token", inviteRedeemLimiter, async (req, res) => {
  const parsed = acceptSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ message: "A password of at least 8 characters is required" });

  const tokenHash = hashToken(req.params.token);
  const member = await storage.getCareCircleMemberByTokenHash(tokenHash);
  if (!member || !isInviteLive(member)) {
    return res.status(404).json({ message: "This invite link is invalid, has expired, or has already been used" });
  }

  let user = await storage.getUserByEmail(member.inviteEmail);
  if (!user) {
    // A brand-new account gets the same password rules as everyone else.
    const weak = weakPasswordReason(parsed.data.password, { email: member.inviteEmail, name: member.name });
    if (weak) return res.status(400).json({ message: weak });
  }
  if (user) {
    // The link proves someone can read the invitee's inbox — not that they
    // own an account that already uses that address. Attaching to an
    // existing account therefore needs that account's own password, and only
    // a caregiver account can be attached (a doctor, admin or patient
    // account must never be turned into, or logged in as, a caregiver).
    const owns =
      user.role === "caregiver" && !user.deactivatedAt && (await bcrypt.compare(parsed.data.password, user.passwordHash));
    if (!owns) {
      return res.status(401).json({
        message:
          "An account with this email already exists. Enter that account's existing password, or ask for the invitation to be sent to a different email address.",
      });
    }
  } else {
    const passwordHash = await bcrypt.hash(parsed.data.password, 10);
    user = await storage.createUser({
      name: member.name,
      email: member.inviteEmail,
      passwordHash,
      role: "caregiver",
      state: null,
      phone: null,
      deactivatedAt: null,
      emailVerifiedAt: null,
    });
  }

  await storage.acceptCareCircleInvite(member.id, user.id);
  await logAudit({ actorUserId: user.id, action: "care_circle.accepted", targetType: "care_circle_member", targetId: member.id });

  const deviceId = await createDeviceForLogin(user.id, req);
  const token = signToken(user.id, user.role, deviceId);
  res.json({ token, user: { id: user.id, name: user.name, email: user.email, role: user.role, state: user.state } });
});

// --- Caregiver-facing view ---

router.get("/caregiver/patients", requireAuth, requireRole("caregiver"), async (req, res) => {
  const caregiverUserId = (req as any).userId as string;
  const memberships = await storage.getCareCircleByCaregiver(caregiverUserId);
  const results = await Promise.all(
    memberships.map(async (m) => {
      const patient = await storage.getUser(m.patientUserId);
      return {
        careCircleMemberId: m.id,
        patientUserId: m.patientUserId,
        patientName: patient?.name || "Patient",
        relationshipLabel: m.relationshipLabel,
        permissions: {
          medicationStatus: m.permissionMedicationStatus,
          appointments: m.permissionAppointments,
          deliveryStatus: m.permissionDeliveryStatus,
          documents: m.permissionDocuments,
          fullRecords: m.permissionFullRecords,
        },
      };
    }),
  );
  res.json(results);
});

async function getAuthorizedMembership(caregiverUserId: string, patientUserId: string) {
  const memberships = await storage.getCareCircleByCaregiver(caregiverUserId);
  return memberships.find((m) => m.patientUserId === patientUserId) || null;
}

// A strictly permission-scoped read of one patient — every field is
// conditional on the exact grant the patient made, never "everything
// unless denied". "Not confirmed" language only; this never claims to
// know whether a dose was actually taken.
router.get("/caregiver/patients/:patientUserId/overview", requireAuth, requireRole("caregiver"), async (req, res) => {
  const caregiverUserId = (req as any).userId as string;
  const membership = await getAuthorizedMembership(caregiverUserId, req.params.patientUserId);
  if (!membership) return res.status(404).json({ message: "You don't have access to this patient" });

  const patient = await storage.getUser(req.params.patientUserId);
  const overview: Record<string, unknown> = {
    patientName: patient?.name || "Patient",
    relationshipLabel: membership.relationshipLabel,
    permissions: {
      medicationStatus: membership.permissionMedicationStatus,
      appointments: membership.permissionAppointments,
      deliveryStatus: membership.permissionDeliveryStatus,
      documents: membership.permissionDocuments,
      fullRecords: membership.permissionFullRecords,
    },
  };

  if (membership.permissionMedicationStatus) {
    const medications = await storage.getMedicationsByPatient(req.params.patientUserId);
    // The *patient's* day, not the caregiver's and not UTC.
    const tz = await patientTimezoneById(req.params.patientUserId);
    const todayKey = dateKeyInZone(new Date(), tz);
    const logs = await storage.getMedicationLogsByPatientAndDate(req.params.patientUserId, todayKey);
    const logBySlot = new Map(logs.map((l) => [`${l.medicationId}:${l.doseTime}`, l.status]));
    const nowHm = clockInZone(new Date(), tz);
    overview.todaysMedicationStatus = medications
      .filter((m) => isMedicationActiveOn(m, todayKey, tz))
      .flatMap((m) =>
        m.scheduleTimes.map((time) => {
          const status = logBySlot.get(`${m.id}:${time}`);
          const overdue = !status && time < nowHm;
          return { medicationName: m.name, time, status: status || (overdue ? "not_confirmed" : "upcoming") };
        }),
      );
  }

  if (membership.permissionAppointments) {
    const appointments = await storage.getAppointmentsByPatient(req.params.patientUserId);
    const upcoming = appointments.filter((a) => a.status === "requested" || a.status === "confirmed");
    overview.upcomingAppointments = await Promise.all(
      upcoming.map(async (a) => {
        const doctor = await storage.getDoctorProfile(a.doctorProfileId);
        return { type: a.type, scheduledAt: a.scheduledAt, status: a.status, doctorName: doctor?.name || "doctor" };
      }),
    );
  }

  if (membership.permissionDeliveryStatus) {
    const orders = await storage.getPharmacyOrdersByPatient(req.params.patientUserId);
    overview.pharmacyOrders = await Promise.all(
      orders.map(async (o) => {
        const prescription = await storage.getPrescription(o.prescriptionId);
        return { medicationName: prescription?.medicationName || "medication", status: o.status, fulfillmentType: o.fulfillmentType };
      }),
    );
  }

  if (membership.permissionDocuments) {
    const docs = await storage.getDocumentsByPatient(req.params.patientUserId);
    overview.documents = docs.map((d) => ({ title: d.title, category: d.category, createdAt: d.createdAt }));
  }

  await logAuditStrict({ actorUserId: caregiverUserId, action: "care_circle.viewed_patient", targetType: "user", targetId: req.params.patientUserId });

  res.json(overview);
});

export default router;
