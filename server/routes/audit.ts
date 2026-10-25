import { Router } from "express";
import { storage } from "../storage";
import { requireAuth, requireRole } from "../middleware/auth";
import { normalizeLang, st, type TextKey } from "../services/serverText";

const router = Router();

type Kind = "access" | "change";

// Plain-language sentences for the events a person should be able to see
// about their own information. `access` = someone else looked at it;
// `change` = a decision about sharing, made by them (or a connection event).
// The wording lives in services/serverText.ts so it follows the person's language.
const LABELS: Record<string, { kind: Kind; key: TextKey }> = {
  "doctor.viewed_paired_patient": { kind: "access", key: "audit.doctor.viewed_paired_patient" },
  "doctor.viewed_shared_records": { kind: "access", key: "audit.doctor.viewed_shared_records" },
  "document.viewed": { kind: "access", key: "audit.document.viewed" },
  "care_circle.viewed_patient": { kind: "access", key: "audit.care_circle.viewed_patient" },
  "pairing.requested": { kind: "change", key: "audit.pairing.requested" },
  "pairing.accepted": { kind: "change", key: "audit.pairing.accepted" },
  "pairing.declined": { kind: "change", key: "audit.pairing.declined" },
  "pairing.cancelled": { kind: "change", key: "audit.pairing.cancelled" },
  "pairing.ended": { kind: "change", key: "audit.pairing.ended" },
  "sharing_grant.updated": { kind: "change", key: "audit.sharing_grant.updated" },
  "sharing_grant.revoked": { kind: "change", key: "audit.sharing_grant.revoked" },
  "care_circle.invited": { kind: "change", key: "audit.care_circle.invited" },
  "care_circle.accepted": { kind: "change", key: "audit.care_circle.accepted" },
  "care_circle.permissions_updated": { kind: "change", key: "audit.care_circle.permissions_updated" },
  "care_circle.revoked": { kind: "change", key: "audit.care_circle.revoked" },
  "document.uploaded": { kind: "change", key: "audit.document.uploaded" },
  "document.deleted": { kind: "change", key: "audit.document.deleted" },
  "emergency_profile.updated": { kind: "change", key: "audit.emergency_profile.updated" },
};

// "Who has looked at my information, and what have I changed?" A direct
// indexed query on the person the event concerns — not a filter over the
// latest events of everyone, so nothing silently drops off a busy system.
router.get("/", requireAuth, requireRole("patient"), async (req, res) => {
  const patientUserId = (req as any).userId as string;
  const lang = normalizeLang((await storage.getUser(patientUserId))?.language);
  const logs = await storage.getAuditLogsForSubject(patientUserId, 300);

  const nameCache = new Map<string, string>();
  async function actorName(id: string | null): Promise<string> {
    if (!id) return st(lang, "someone");
    if (id === patientUserId) return st(lang, "you");
    if (!nameCache.has(id)) {
      const user = await storage.getUser(id);
      let name = user?.name || st(lang, "someone");
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
    entries.push({ id: log.id, kind: label.kind, text: st(lang, label.key, { a: await actorName(log.actorUserId) }), createdAt: log.createdAt });
    if (entries.length >= 100) break;
  }

  res.json(entries);
});

export default router;
