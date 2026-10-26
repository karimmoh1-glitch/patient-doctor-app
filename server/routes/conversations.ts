import { Router } from "express";
import { z } from "zod";
import { makeLimiter, userKey } from "../middleware/rateLimit";
import { requireAuth } from "../middleware/auth";
import { requirePatientOrApprovedDoctor } from "../middleware/doctor";
import { storage } from "../storage";
import { logAudit } from "../services/auditService";

const router = Router();
const guard = [requireAuth, requirePatientOrApprovedDoctor] as const;

const searchLimiter = makeLimiter({ windowMs: 60_000, limit: 20, keyGenerator: userKey, message: "Searching too quickly. Please wait a moment." });
const reportLimiter = makeLimiter({ windowMs: 60 * 60_000, limit: 10, keyGenerator: userKey, message: "You have sent several reports. Please wait before sending another." });

/** Every accepted connection the signed-in person is a party to, with who is on the other side. Never anyone else's. */
async function myConversations(req: any) {
  const userId = req.userId as string;
  if (req.userRole === "patient") {
    const pairings = (await storage.getPairingRequestsByPatient(userId)).filter((p) => p.status === "accepted");
    return Promise.all(
      pairings.map(async (p) => {
        const doctor = await storage.getDoctorProfile(p.doctorProfileId);
        return { pairing: p, name: doctor?.name ?? "", specialty: doctor?.specialty ?? null, counterpartUserId: doctor?.userId ?? null };
      }),
    );
  }
  const profile = req.doctorProfile as { id: string };
  const pairings = (await storage.getPairingRequestsByDoctorProfile(profile.id)).filter((p) => p.status === "accepted");
  return Promise.all(
    pairings.map(async (p) => {
      const patient = await storage.getUser(p.patientUserId);
      return { pairing: p, name: patient?.name ?? "", specialty: null as string | null, counterpartUserId: p.patientUserId };
    }),
  );
}

const snippet = (text: string, n = 90) => (text.length > n ? `${text.slice(0, n).trimEnd()}…` : text);

// The inbox: one row per conversation, newest activity first, with how many messages are unread.
router.get("/", ...guard, async (req, res) => {
  const userId = (req as any).userId as string;
  const mine = await myConversations(req);
  const stats = await storage.getConversationStats(mine.map((c) => c.pairing.id), userId);
  const rows = mine.map((c) => {
    const s = stats.get(c.pairing.id);
    return {
      pairingId: c.pairing.id,
      name: c.name,
      specialty: c.specialty,
      unread: s?.unread ?? 0,
      lastMessage: s?.lastAt ? { at: s.lastAt.toISOString(), fromMe: s.lastSenderUserId === userId, snippet: snippet(s.lastBody ?? "") } : null,
      sortKey: (s?.lastAt ?? c.pairing.respondedAt ?? c.pairing.requestedAt ?? new Date(0)).valueOf(),
    };
  });
  rows.sort((a, b) => b.sortKey - a.sortKey);
  res.json({ unreadTotal: rows.reduce((n, r) => n + r.unread, 0), conversations: rows.map(({ sortKey: _k, ...r }) => r) });
});

// Search inside the signed-in person's own conversations. The query never reaches anyone else's.
router.get("/search", ...guard, searchLimiter, async (req, res) => {
  const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
  if (q.length < 3 || q.length > 100) return res.status(400).json({ message: "Type at least 3 letters to search." });
  const mine = await myConversations(req);
  const byId = new Map(mine.map((c) => [c.pairing.id, c]));
  const hits = await storage.searchMessages(mine.map((c) => c.pairing.id), q, 25);
  const lower = q.toLowerCase();
  res.json(
    hits.map((h) => {
      const at = Math.max(0, h.body.toLowerCase().indexOf(lower) - 40);
      return { messageId: h.id, pairingId: h.pairingRequestId, name: byId.get(h.pairingRequestId)?.name ?? "", at: h.createdAt, excerpt: `${at > 0 ? "…" : ""}${h.body.slice(at, at + 140)}${h.body.length > at + 140 ? "…" : ""}`, fromMe: h.senderUserId === (req as any).userId };
    }),
  );
});

const reportSchema = z.object({
  reason: z.enum(["abuse", "harassment", "unsafe", "spam", "other"]),
  details: z.string().trim().max(1000).optional(),
  // Whether to attach the message text for the reviewer. Without it the reviewer sees only that a report was made.
  shareText: z.boolean().default(false),
});

router.post("/messages/:messageId/report", ...guard, reportLimiter, async (req, res) => {
  const userId = (req as any).userId as string;
  const parsed = reportSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ message: "Choose a reason for the report." });
  const message = await storage.getMessage(req.params.messageId);
  const mine = await myConversations(req);
  const conversation = mine.find((c) => c.pairing.id === message?.pairingRequestId);
  // Only a message from the OTHER person, in a conversation the reporter is part of.
  if (!message || !conversation || message.senderUserId === userId) return res.status(404).json({ message: "Message not found" });
  const report = await storage.createMessageReport({
    reporterUserId: userId,
    pairingRequestId: message.pairingRequestId,
    messageId: message.id,
    reason: parsed.data.reason,
    details: parsed.data.details || null,
    sharedText: parsed.data.shareText ? message.body : null,
  });
  await logAudit({ actorUserId: userId, action: "message.reported", targetType: "message_report", targetId: report.id, metadata: { reason: parsed.data.reason, textShared: parsed.data.shareText } });
  res.status(201).json({ id: report.id });
});

// Blocking ends the connection and stops the same two people connecting again. Either side may do it.
router.post("/:pairingId/block", ...guard, async (req, res) => {
  const userId = (req as any).userId as string;
  const mine = await myConversations(req);
  const conversation = mine.find((c) => c.pairing.id === req.params.pairingId);
  if (!conversation?.counterpartUserId) return res.status(404).json({ message: "Conversation not found" });
  await storage.blockUser(userId, conversation.counterpartUserId);
  await storage.transitionPairingStatus(conversation.pairing.id, ["accepted"], "ended");
  await logAudit({ actorUserId: userId, action: "user.blocked", targetType: "pairing_request", targetId: conversation.pairing.id, subjectUserId: conversation.counterpartUserId });
  res.json({ message: "Blocked. The conversation has ended and they can't contact you through Avela." });
});

export default router;
