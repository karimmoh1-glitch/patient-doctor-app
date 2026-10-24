import { Router } from "express";
import { z } from "zod";
import { makeLimiter } from "../middleware/rateLimit";
import { storage } from "../storage";
import { requireAuth, requireRole } from "../middleware/auth";
import { chat, explainSimply } from "../services/aiService";
import { logAudit } from "../services/auditService";

const router = Router();

const chatLimiter = makeLimiter({
  windowMs: 60 * 1000,
  limit: 20,
  message: "Too many messages. Please slow down.",
});

router.get("/messages", requireAuth, requireRole("patient"), async (req, res) => {
  const userId = (req as any).userId as string;
  const messages = await storage.getAiMessagesByUser(userId);
  res.json(messages);
});

const chatSchema = z.object({ message: z.string().trim().min(1).max(2000) });

router.post("/chat", requireAuth, requireRole("patient"), chatLimiter, async (req, res) => {
  const userId = (req as any).userId as string;
  const parsed = chatSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ message: "A message is required" });

  await storage.createAiMessage({ userId, role: "user", content: parsed.data.message });

  const result = await chat(userId, parsed.data.message);

  const assistantMessage = await storage.createAiMessage({ userId, role: "assistant", content: result.reply });

  await logAudit({ actorUserId: userId, action: "ai.chat", targetType: "user", targetId: userId, metadata: { usedAi: result.usedAi } });

  res.json({ id: assistantMessage.id, reply: result.reply, usedAi: result.usedAi, createdAt: assistantMessage.createdAt });
});

const explainSchema = z.object({ text: z.string().trim().min(1).max(2000) });

router.post("/explain-simply", requireAuth, requireRole("patient"), chatLimiter, async (req, res) => {
  const userId = (req as any).userId as string;
  const parsed = explainSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ message: "Text to explain is required" });

  const result = await explainSimply(parsed.data.text);
  await logAudit({ actorUserId: userId, action: "ai.explain_simply", metadata: { usedAi: result.usedAi } });
  res.json(result);
});

export default router;
