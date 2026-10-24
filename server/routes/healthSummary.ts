import { Router } from "express";
import { z } from "zod";
import { requireAuth, requireRole } from "../middleware/auth";
import { logAudit } from "../services/auditService";

const router = Router();

// Health Handoff / "Prepare my health summary": the summary itself is
// assembled client-side from data the patient already has full access to
// (their own prescriptions, appointments, documents). This endpoint only
// records that a share happened — within this simulated environment, not
// to any real external provider — so it shows up in the audit trail.
const shareSchema = z.object({
  recipientLabel: z.string().trim().min(1).max(200),
  categories: z.array(z.string()).min(1),
});

router.post("/share", requireAuth, requireRole("patient"), async (req, res) => {
  const userId = (req as any).userId as string;
  const parsed = shareSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ message: "Invalid share request" });

  await logAudit({
    actorUserId: userId,
    action: "health_summary.shared",
    targetType: "user",
    targetId: userId,
    metadata: { recipientLabel: parsed.data.recipientLabel, categories: parsed.data.categories },
  });

  res.json({ message: `Summary shared with ${parsed.data.recipientLabel} (within this demo environment).` });
});

export default router;
