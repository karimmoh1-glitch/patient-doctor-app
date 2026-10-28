import { Router } from "express";
import { z } from "zod";
import { storage } from "../storage";
import { requireAuth, requireRole } from "../middleware/auth";
import { matchDoctors } from "../services/matchingService";
import { logAudit } from "../services/auditService";

const router = Router();

const createReportSchema = z.object({
  symptomText: z.string().min(3).max(4000),
  inputMethod: z.enum(["typed", "voice"]),
  transcriptionProvider: z.string().optional(),
});

router.post("/", requireAuth, requireRole("patient"), async (req, res) => {
  const parsed = createReportSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: parsed.error.issues[0]?.message || "Invalid symptom report" });
  }
  const userId = (req as any).userId as string;
  const user = await storage.getUserPrivate(userId);
  if (!user?.state) {
    return res.status(400).json({ message: "Set your state before submitting symptoms" });
  }

  const report = await storage.createSymptomReport({
    patientUserId: userId,
    state: user.state,
    symptomText: parsed.data.symptomText,
    inputMethod: parsed.data.inputMethod,
    transcriptionProvider: parsed.data.transcriptionProvider || null,
  });

  await logAudit({ actorUserId: userId, action: "symptom_report.created", targetType: "symptom_report", targetId: report.id });

  res.status(201).json({ id: report.id, state: report.state });
});

router.get("/:id/matches", requireAuth, requireRole("patient"), async (req, res) => {
  const userId = (req as any).userId as string;
  const report = await storage.getSymptomReport(req.params.id);
  if (!report || report.patientUserId !== userId) {
    return res.status(404).json({ message: "Symptom report not found" });
  }

  const candidates = (await storage.getActiveDoctorProfiles()).filter((d) => !!d.userId);
  const matches = matchDoctors(candidates, report.state, report.symptomText);

  await logAudit({ actorUserId: userId, action: "match_results.viewed", targetType: "symptom_report", targetId: report.id });

  res.json(
    matches.map((m) => ({
      doctorProfileId: m.doctor.id,
      name: m.doctor.name,
      specialty: m.doctor.specialty,
      state: m.doctor.state,
      bio: m.doctor.bio,
      score: m.score,
      matchedKeywords: m.matchedKeywords,
    })),
  );
});

export default router;
