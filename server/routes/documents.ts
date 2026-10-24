import { Router } from "express";
import path from "path";
import fs from "fs";
import crypto from "crypto";
import multer from "multer";
import { z } from "zod";
import { storage } from "../storage";
import { requireAuth, requireRole } from "../middleware/auth";
import { logAudit, logAuditStrict } from "../services/auditService";

const router = Router();

// Resolved from the working directory rather than __dirname/import.meta.dirname:
// dev runs as ESM (tsx, no __dirname) and the production server is bundled
// to CJS (see script/build.ts, no import.meta.dirname) — cwd is the one
// thing both have in common, and both `npm run dev` and `npm start` are
// always invoked from the project root.
const UPLOAD_DIR = path.resolve(process.cwd(), "uploads", "documents");

// Saved files need a disk that survives restarts. Serverless hosts (Vercel)
// have none, so there the file part of "save a document" is switched off and
// reported as such by /api/config, rather than accepting files that would
// silently vanish. Titles and notes still save.
export const DOCUMENT_UPLOADS_ENABLED: boolean = (() => {
  if (process.env.VERCEL) return false;
  try {
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
    return true;
  } catch {
    return false;
  }
})();

// The stored extension — and therefore the Content-Type the file is later
// served with — comes from this table, never from the uploader's filename.
// (A client-chosen name like "report.html" must never be served as HTML.)
const ALLOWED_TYPES: Record<string, string> = {
  "application/pdf": ".pdf",
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp",
  "text/plain": ".txt",
};
const CONTENT_TYPE_BY_EXT: Record<string, string> = {
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".txt": "text/plain; charset=utf-8",
};
const MAX_DOCUMENTS_PER_PATIENT = 200;

function badRequest(message: string) {
  return Object.assign(new Error(message), { status: 400 });
}

// The declared MIME type is just a claim from the client; confirm the bytes
// actually look like that kind of file before keeping it.
function matchesSignature(buf: Buffer, mime: string): boolean {
  switch (mime) {
    case "application/pdf":
      return buf.subarray(0, 5).toString("latin1") === "%PDF-";
    case "image/png":
      return buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    case "image/jpeg":
      return buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
    case "image/webp":
      return buf.subarray(0, 4).toString("latin1") === "RIFF" && buf.subarray(8, 12).toString("latin1") === "WEBP";
    case "text/plain":
      return !buf.includes(0);
    default:
      return false;
  }
}

const upload = multer({
  storage: DOCUMENT_UPLOADS_ENABLED
    ? multer.diskStorage({
        destination: UPLOAD_DIR,
        filename: (_req, file, cb) => {
          cb(null, `${crypto.randomUUID()}${ALLOWED_TYPES[file.mimetype] ?? ""}`);
        },
      })
    : multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    if (!ALLOWED_TYPES[file.mimetype]) {
      return cb(badRequest("That file type isn't supported. Please upload a PDF, PNG, JPEG, WebP or plain-text file."));
    }
    cb(null, true);
  },
});

const CATEGORIES = ["Lab Result", "Imaging", "Visit Summary", "Insurance", "Other"] as const;

router.get("/", requireAuth, requireRole("patient"), async (req, res) => {
  const patientUserId = (req as any).userId as string;
  const list = await storage.getDocumentsByPatient(patientUserId);
  res.json(list.map((d) => ({ ...d, filePath: undefined, hasFile: !!d.filePath })));
});

const metaSchema = z.object({
  title: z.string().trim().min(1).max(200),
  category: z.enum(CATEGORIES).optional(),
  notes: z.string().trim().max(1000).optional(),
});

router.post("/", requireAuth, requireRole("patient"), upload.single("file"), async (req, res) => {
  const parsed = metaSchema.safeParse(req.body);
  if (!parsed.success) {
    if (req.file) fs.unlink(req.file.path, () => {});
    return res.status(400).json({ message: parsed.error.errors[0]?.message || "A title is required" });
  }
  const userId = (req as any).userId as string;

  if (req.file && !DOCUMENT_UPLOADS_ENABLED) {
    return res.status(503).json({ message: "Saving files isn't available on this service yet. You can still save the title and your notes." });
  }

  if (req.file) {
    const head = Buffer.alloc(512);
    const fd = fs.openSync(req.file.path, "r");
    const bytesRead = fs.readSync(fd, head, 0, 512, 0);
    fs.closeSync(fd);
    if (!matchesSignature(head.subarray(0, bytesRead), req.file.mimetype)) {
      fs.unlink(req.file.path, () => {});
      return res.status(400).json({ message: "That file doesn't look like the type it claims to be, so it wasn't saved." });
    }
  }

  const existing = await storage.getDocumentsByPatient(userId);
  if (existing.length >= MAX_DOCUMENTS_PER_PATIENT) {
    if (req.file) fs.unlink(req.file.path, () => {});
    return res.status(409).json({ message: "You've reached the limit for saved documents. Please remove some before adding more." });
  }

  const document = await storage.createDocument({
    patientUserId: userId,
    uploadedByUserId: userId,
    title: parsed.data.title,
    category: parsed.data.category || "Other",
    // Display name only (never used to build a path); stripped of any path
    // components and control characters.
    fileName: req.file ? path.basename(req.file.originalname).replace(/[\u0000-\u001f"\\/]/g, "_").slice(0, 200) : null,
    filePath: req.file ? path.basename(req.file.path) : null,
    notes: parsed.data.notes || null,
  });

  await logAudit({ actorUserId: userId, action: "document.uploaded", targetType: "document", targetId: document.id });

  res.status(201).json({ ...document, filePath: undefined, hasFile: !!document.filePath });
});

router.get("/:id/file", requireAuth, async (req, res) => {
  const userId = (req as any).userId as string;
  const role = (req as any).userRole as string;
  const document = await storage.getDocument(req.params.id);
  if (!document || !document.filePath) return res.status(404).json({ message: "Document not found" });

  let authorized = document.patientUserId === userId;
  if (!authorized && role === "doctor") {
    const doctorProfile = await storage.getDoctorProfileByUserId(userId);
    if (doctorProfile) {
      // A grant only counts while the doctor is still connected to the patient.
      const connections = await storage.getAcceptedPairingsByPatient(document.patientUserId);
      const stillConnected = connections.some((c) => c.doctorProfileId === doctorProfile.id);
      const grant = stillConnected ? await storage.getActiveSharingGrantFor(document.patientUserId, doctorProfile.id) : undefined;
      authorized = !!(grant && (grant.shareDocuments || grant.shareFullHistory));
    }
  }
  if (!authorized) return res.status(404).json({ message: "Document not found" });

  await logAuditStrict({ actorUserId: userId, action: "document.viewed", targetType: "document", targetId: document.id });

  const filePath = path.join(UPLOAD_DIR, path.basename(document.filePath));
  const contentType = CONTENT_TYPE_BY_EXT[path.extname(document.filePath)] ?? "application/octet-stream";
  res.sendFile(filePath, {
    headers: {
      "Content-Type": contentType,
      "X-Content-Type-Options": "nosniff",
      // A downloaded/previewed document must never be able to run script in
      // this app's origin, whatever it contains.
      "Content-Security-Policy": "sandbox; default-src 'none'",
      "Cache-Control": "private, no-store",
    },
  }, (err) => {
    if (err && !res.headersSent) res.status(404).json({ message: "File not found" });
  });
});

// A person can always remove their own document. The record and the stored
// file are both deleted (not hidden), and any doctor's access to it ends with it.
router.delete("/:id", requireAuth, requireRole("patient"), async (req, res) => {
  const userId = (req as any).userId as string;
  const document = await storage.getDocument(req.params.id);
  if (!document || document.patientUserId !== userId) {
    return res.status(404).json({ message: "Document not found" });
  }
  await storage.deleteDocument(document.id);
  if (document.filePath) {
    fs.unlink(path.join(UPLOAD_DIR, path.basename(document.filePath)), () => {});
  }
  await logAudit({ actorUserId: userId, action: "document.deleted", targetType: "document", targetId: document.id, subjectUserId: document.patientUserId });
  res.json({ ok: true });
});

export default router;
