import { Router } from "express";
import { z } from "zod";
import { storage } from "../storage";
import { requireAuth } from "../middleware/auth";

const router = Router();

// A person's own notifications only. The row holds a kind and small
// parameters; wording is chosen by the client in the reader's language.
router.get("/", requireAuth, async (req, res) => {
  const userId = (req as any).userId as string;
  const [items, unread] = await Promise.all([storage.getNotificationsForUser(userId, 50), storage.countUnreadNotifications(userId)]);
  res.json({
    unread,
    items: items.map((n) => ({ id: n.id, kind: n.kind, params: n.params, link: n.link, createdAt: n.createdAt, read: !!n.readAt })),
  });
});

router.get("/unread-count", requireAuth, async (req, res) => {
  res.json({ unread: await storage.countUnreadNotifications((req as any).userId as string) });
});

router.post("/read", requireAuth, async (req, res) => {
  const parsed = z.object({ ids: z.array(z.string()).max(100).optional() }).safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ message: "Invalid request" });
  await storage.markNotificationsRead((req as any).userId as string, parsed.data.ids);
  res.json({ ok: true });
});

export default router;
