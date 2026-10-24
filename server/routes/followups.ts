import { Router } from "express";
import { z } from "zod";
import { storage } from "../storage";
import { requireAuth, requireRole } from "../middleware/auth";

const router = Router();

router.get("/", requireAuth, requireRole("patient"), async (req, res) => {
  const patientUserId = (req as any).userId as string;
  const tasks = await storage.getFollowUpTasksByPatient(patientUserId);
  res.json(tasks);
});

const createSchema = z.object({
  title: z.string().trim().min(1).max(200),
  detail: z.string().trim().max(1000).optional(),
  dueDate: z.string().datetime().optional(),
});

router.post("/", requireAuth, requireRole("patient"), async (req, res) => {
  const patientUserId = (req as any).userId as string;
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ message: "A title is required" });

  const task = await storage.createFollowUpTask({
    patientUserId,
    appointmentId: null,
    doctorProfileId: null,
    title: parsed.data.title,
    detail: parsed.data.detail || null,
    dueDate: parsed.data.dueDate ? new Date(parsed.data.dueDate) : null,
    sourceType: "manual",
  });
  res.status(201).json(task);
});

router.patch("/:id/status", requireAuth, requireRole("patient"), async (req, res) => {
  const patientUserId = (req as any).userId as string;
  const parsed = z.object({ status: z.enum(["open", "done"]) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ message: "Invalid status" });

  const tasks = await storage.getFollowUpTasksByPatient(patientUserId);
  const task = tasks.find((t) => t.id === req.params.id);
  if (!task) return res.status(404).json({ message: "Task not found" });

  const updated = await storage.setFollowUpTaskStatus(task.id, parsed.data.status);
  res.json(updated);
});

export default router;
