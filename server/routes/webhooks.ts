import express, { Router } from "express";
import { applyWebhookEvent, verifyWebhookSignature, webhookSecretConfigured } from "../services/emailDeliveries";
import { systemAccess } from "../middleware/systemAccess";

/**
 * Provider callbacks. The body is read raw (the signature is over the exact bytes), and nothing is trusted until the
 * signature, made with a secret only the provider and we know, verifies and the timestamp is recent. A request that fails
 * either test learns nothing: the same bare 401 whatever was wrong.
 */
const router = Router();

router.post("/resend", systemAccess("webhook"), express.raw({ type: "*/*", limit: "100kb" }), async (req, res) => {
  if (!webhookSecretConfigured()) return res.status(503).json({ message: "Not configured" });
  const raw: Buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.from("");
  if (!verifyWebhookSignature(raw, req.headers)) return res.status(401).json({ message: "Invalid signature" });
  let payload: unknown;
  try {
    payload = JSON.parse(raw.toString("utf8"));
  } catch {
    return res.status(400).json({ message: "Invalid body" });
  }
  const eventId = String(req.headers["svix-id"]);
  const outcome = await applyWebhookEvent(eventId, payload);
  res.json({ ok: true, outcome });
});

export default router;
