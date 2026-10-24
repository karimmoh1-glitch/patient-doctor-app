import { Router } from "express";
import { storage } from "../storage";
import { requireAuth, requireRole } from "../middleware/auth";

const router = Router();

type Kind = "access" | "change";

// Plain-language sentences for the events a person should be able to see
// about their own information. `access` = someone else looked at it;
// `change` = a decision about sharing, made by them (or a connection event).
const LABELS: Record<string, { kind: Kind; text: (actor: string) => string }> = {
  "doctor.viewed_paired_patient": { kind: "access", text: (a) => `${a} read what you wrote when you asked for help` },
  "doctor.viewed_shared_records": { kind: "access", text: (a) => `${a} looked at the records you chose to share with them` },
  "document.viewed": { kind: "access", text: (a) => `${a} opened one of your documents` },
  "care_circle.viewed_patient": { kind: "access", text: (a) => `${a} looked at your Care Circle page` },

  "pairing.requested": { kind: "change", text: () => "You asked a doctor to see you" },
  "pairing.accepted": { kind: "change", text: (a) => `${a} accepted you as a patient` },
  "pairing.declined": { kind: "change", text: (a) => `${a} declined your request` },
  "pairing.cancelled": { kind: "change", text: () => "You cancelled a request to a doctor" },
  "pairing.ended": { kind: "change", text: () => "You stopped sharing with a doctor" },
  "sharing_grant.updated": { kind: "change", text: () => "You changed what a doctor can see" },
  "sharing_grant.revoked": { kind: "change", text: () => "You took back extra access from a doctor" },
  "care_circle.invited": { kind: "change", text: () => "You invited someone to your Care Circle" },
  "care_circle.accepted": { kind: "change", text: (a) => `${a} joined your Care Circle` },
  "care_circle.permissions_updated": { kind: "change", text: () => "You changed what someone in your Care Circle can see" },
  "care_circle.revoked": { kind: "change", text: () => "You removed someone from your Care Circle" },
  "document.uploaded": { kind: "change", text: () => "You saved a document" },
  "document.deleted": { kind: "change", text: () => "You deleted a document" },
  "emergency_profile.updated": { kind: "change", text: () => "You updated your emergency information" },
};

// "Who has looked at my information, and what have I changed?" A direct
// indexed query on the person the event concerns — not a filter over the
// latest events of everyone, so nothing silently drops off a busy system.
router.get("/", requireAuth, requireRole("patient"), async (req, res) => {
  const patientUserId = (req as any).userId as string;
  const logs = await storage.getAuditLogsForSubject(patientUserId, 300);

  const nameCache = new Map<string, string>();
  async function actorName(id: string | null): Promise<string> {
    if (!id) return "Someone";
    if (id === patientUserId) return "You";
    if (!nameCache.has(id)) {
      const user = await storage.getUser(id);
      let name = user?.name || "Someone";
      if (user?.role === "doctor") name = (await storage.getDoctorProfileByUserId(user.id))?.name || name;
      nameCache.set(id, name);
    }
    return nameCache.get(id)!;
  }

  const entries: { id: string; kind: Kind; text: string; createdAt: Date | null }[] = [];
  for (const log of logs) {
    const label = LABELS[log.action];
    if (!label) continue;
    // Opening your own document isn't "access" by someone else.
    if (log.action === "document.viewed" && log.actorUserId === patientUserId) continue;
    entries.push({ id: log.id, kind: label.kind, text: label.text(await actorName(log.actorUserId)), createdAt: log.createdAt });
    if (entries.length >= 100) break;
  }

  res.json(entries);
});

export default router;
