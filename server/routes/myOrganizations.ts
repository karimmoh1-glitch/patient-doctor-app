import { Router } from "express";
import { z } from "zod";
import { requireAuth, requireRole } from "../middleware/auth";
import * as orgs from "../services/orgs";

/** The patient's side: which organizations' staff can see their name and appointment times, and the switch to turn that off per connection. */
const router = Router();
const patientOnly = [requireAuth, requireRole("patient")] as const;

router.get("/", ...patientOnly, async (req, res) => res.json(await orgs.organizationsSeeingPatient((req as any).userId)));

router.put("/:pairingId", ...patientOnly, async (req, res, next) => {
  try {
    const parsed = z.object({ visible: z.boolean() }).strict().safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: "Choose yes or no" });
    await orgs.setStaffVisibility((req as any).userId, req.params.pairingId, parsed.data.visible);
    res.json({ ok: true });
  } catch (err) {
    if (err instanceof orgs.OrgError) return res.status(err.status).json({ message: err.message });
    next(err);
  }
});

export default router;
