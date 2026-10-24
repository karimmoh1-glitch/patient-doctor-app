import { Router } from "express";
import multer from "multer";
import { makeLimiter } from "../middleware/rateLimit";
import { requireAuth, requireRole } from "../middleware/auth";
import { transcribe } from "../services/speechService";

const router = Router();

// Audio is held in memory only for the duration of the request, never
// written to disk — minimizes the PHI storage surface for symptom audio.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 },
});

const speechLimiter = makeLimiter({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  message: "Too many transcription requests. Please try again later.",
});

router.post("/transcribe", requireAuth, requireRole("patient"), speechLimiter, upload.single("audio"), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ message: "No audio file provided" });
  }
  try {
    const text = await transcribe(req.file.buffer, req.file.mimetype);
    res.json({ text });
  } catch (err: any) {
    console.error("[SPEECH] Transcription failed:", err.message);
    res.status(500).json({ message: "Transcription failed. Please try typing instead." });
  }
});

export default router;
