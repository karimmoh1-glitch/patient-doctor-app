import { storage } from "../storage";

export interface AuditParams {
  actorUserId: string | null;
  action: string;
  targetType?: string;
  targetId?: string;
  /** Whose information the event concerns. Worked out from the target when omitted. */
  subjectUserId?: string | null;
  metadata?: Record<string, unknown>;
}

// Whose record is it? Almost every audited target belongs to exactly one
// patient, so resolving it here means each call site (and any added later)
// is automatically searchable from that patient's own access log.
async function resolveSubject(p: AuditParams): Promise<string | null> {
  if (p.subjectUserId !== undefined) return p.subjectUserId;
  if (!p.targetId) return null;
  switch (p.targetType) {
    case "user": return p.targetId;
    case "symptom_report": return (await storage.getSymptomReport(p.targetId))?.patientUserId ?? null;
    case "document": return (await storage.getDocument(p.targetId))?.patientUserId ?? null;
    case "appointment": return (await storage.getAppointment(p.targetId))?.patientUserId ?? null;
    case "prescription": return (await storage.getPrescription(p.targetId))?.patientUserId ?? null;
    case "pairing_request": return (await storage.getPairingRequest(p.targetId))?.patientUserId ?? null;
    case "care_circle_member": return (await storage.getCareCircleMember(p.targetId))?.patientUserId ?? null;
    case "pharmacy_order": return (await storage.getPharmacyOrder(p.targetId))?.patientUserId ?? null;
    default: return null;
  }
}

async function write(params: AuditParams): Promise<void> {
  const subjectUserId = (await resolveSubject(params)) ?? (params.targetType === "doctor_profile" || !params.targetType ? params.actorUserId : null);
  await storage.createAuditLog({
    actorUserId: params.actorUserId,
    subjectUserId,
    action: params.action,
    targetType: params.targetType || null,
    targetId: params.targetId || null,
    metadata: params.metadata || null,
  });
}

/** For events that merely describe what happened. A failure to record is logged but never breaks the request. */
export async function logAudit(params: AuditParams): Promise<void> {
  try {
    await write(params);
  } catch (err) {
    console.error("Failed to write audit log:", (err as Error)?.name);
  }
}

/**
 * For someone reading ANOTHER person's health information. The read must not
 * happen unless its record was saved: if this throws, the caller's request
 * fails and nothing is disclosed.
 */
export async function logAuditStrict(params: AuditParams): Promise<void> {
  await write(params);
}
