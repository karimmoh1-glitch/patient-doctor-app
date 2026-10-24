import { Router } from "express";
import { z } from "zod";
import { storage } from "../storage";
import { requireAuth, requireRole } from "../middleware/auth";
import { logAudit } from "../services/auditService";

const router = Router();

router.get("/", requireAuth, requireRole("patient"), async (req, res) => {
  const userId = (req as any).userId as string;
  const user = await storage.getUser(userId);
  if (!user) return res.status(404).json({ message: "Account not found" });
  res.json({
    emergencyContactName: user.emergencyContactName,
    emergencyContactPhone: user.emergencyContactPhone,
    allergiesText: user.allergiesText,
    emergencyNotes: user.emergencyNotes,
  });
});

const updateSchema = z.object({
  emergencyContactName: z.string().trim().max(200).optional(),
  emergencyContactPhone: z.string().trim().max(30).optional(),
  allergiesText: z.string().trim().max(1000).optional(),
  emergencyNotes: z.string().trim().max(1000).optional(),
});

router.put("/", requireAuth, requireRole("patient"), async (req, res) => {
  const userId = (req as any).userId as string;
  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ message: "Invalid emergency profile" });

  const updated = await storage.updateEmergencyProfile(userId, {
    emergencyContactName: parsed.data.emergencyContactName || null,
    emergencyContactPhone: parsed.data.emergencyContactPhone || null,
    allergiesText: parsed.data.allergiesText || null,
    emergencyNotes: parsed.data.emergencyNotes || null,
  });
  await logAudit({ actorUserId: userId, action: "emergency_profile.updated", targetType: "user", targetId: userId });
  res.json({
    emergencyContactName: updated?.emergencyContactName ?? null,
    emergencyContactPhone: updated?.emergencyContactPhone ?? null,
    allergiesText: updated?.allergiesText ?? null,
    emergencyNotes: updated?.emergencyNotes ?? null,
  });
});

export default router;
