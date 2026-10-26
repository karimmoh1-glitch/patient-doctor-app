import { Router } from "express";
import { isDemoMode } from "../config";
import { z } from "zod";
import { storage } from "../storage";
import { requireAuth, requireRole } from "../middleware/auth";
import { logAudit } from "../services/auditService";
import { buildFulfillmentOptions } from "../services/fulfillmentService";

const router = Router();

// DEMO fulfillment simulation only — never a real pharmacy order. See
// README for the explicit "DEMO PHARMACY INTEGRATION" framing.
const PICKUP_SEQUENCE = ["received", "processing", "preparing", "ready_for_pickup", "picked_up"] as const;
const DELIVERY_SEQUENCE = ["received", "processing", "preparing", "out_for_delivery", "delivered"] as const;

function sequenceFor(fulfillmentType: string): readonly string[] {
  return fulfillmentType === "delivery" ? DELIVERY_SEQUENCE : PICKUP_SEQUENCE;
}

router.get("/pharmacies", requireAuth, requireRole("patient"), async (_req, res) => {
  const pharmacies = await storage.getAllPharmacies();
  res.json(pharmacies);
});

// Rural access intelligence: a ranked, small set of practical fulfillment
// options (not every pharmacy in the state) — home delivery from the
// nearest pharmacy that offers it, pickup from the nearest that offers it,
// and a nationwide mail-order option that's always available.
router.get("/fulfillment-options", requireAuth, requireRole("patient"), async (req, res) => {
  const userId = (req as any).userId as string;
  const user = await storage.getUser(userId);
  const allPharmacies = await storage.getAllPharmacies();
  const relevant = allPharmacies.filter((p) => p.isMailOrder || p.state === user?.state);
  res.json(buildFulfillmentOptions(relevant));
});

const createOrderSchema = z.object({
  prescriptionId: z.string().min(1),
  pharmacyId: z.string().min(1),
  fulfillmentType: z.enum(["pickup", "delivery"]),
  deliveryAddress: z.string().trim().max(300).optional(),
});

router.post("/orders", requireAuth, requireRole("patient"), async (req, res) => {
  // There is no real pharmacy connection behind this. Outside demo mode it is
  // refused outright rather than pretending an order was placed.
  if (!isDemoMode()) {
    return res.status(501).json({ message: "Ordering from a pharmacy isn't available in this service yet. Please ask your doctor's office how to get your prescription filled." });
  }
  const parsed = createOrderSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: parsed.error.issues[0]?.message || "Invalid pharmacy order" });
  }
  const userId = (req as any).userId as string;

  const prescription = await storage.getPrescription(parsed.data.prescriptionId);
  if (!prescription || prescription.patientUserId !== userId) {
    return res.status(404).json({ message: "Prescription not found" });
  }
  if (prescription.status !== "active") {
    return res.status(409).json({ message: "Only active prescriptions can be sent to a pharmacy" });
  }
  const pharmacy = await storage.getPharmacy(parsed.data.pharmacyId);
  if (!pharmacy) return res.status(404).json({ message: "Pharmacy not found" });
  if (parsed.data.fulfillmentType === "delivery" && !pharmacy.deliveryAvailable) {
    return res.status(400).json({ message: "This pharmacy doesn't offer delivery" });
  }
  if (parsed.data.fulfillmentType === "pickup" && !pharmacy.pickupAvailable) {
    return res.status(400).json({ message: "This pharmacy doesn't offer pickup" });
  }
  const existing = await storage.getPharmacyOrderByPrescriptionId(prescription.id);
  if (existing) {
    return res.status(409).json({ message: "This prescription already has a pharmacy order" });
  }
  if (parsed.data.fulfillmentType === "delivery" && !parsed.data.deliveryAddress) {
    return res.status(400).json({ message: "A delivery address is required" });
  }

  const now = new Date().toISOString();
  let order;
  try {
    order = await storage.createPharmacyOrder({
      prescriptionId: prescription.id,
      patientUserId: userId,
      pharmacyId: pharmacy.id,
      fulfillmentType: parsed.data.fulfillmentType,
      deliveryAddress: parsed.data.deliveryAddress || null,
      statusHistory: [{ status: "received", at: now }],
    });
  } catch (err: any) {
    // A simultaneous request created the order between our check and insert.
    if (err?.code === "23505" || err?.cause?.code === "23505") {
      return res.status(409).json({ message: "This prescription already has a pharmacy order" });
    }
    throw err;
  }

  await logAudit({ actorUserId: userId, action: "pharmacy_order.created", targetType: "pharmacy_order", targetId: order.id });

  res.status(201).json(order);
});

router.get("/orders", requireAuth, requireRole("patient"), async (req, res) => {
  const userId = (req as any).userId as string;
  const orders = await storage.getPharmacyOrdersByPatient(userId);
  const results = await Promise.all(
    orders.map(async (o) => {
      const [prescription, pharmacy] = await Promise.all([
        storage.getPrescription(o.prescriptionId),
        storage.getPharmacy(o.pharmacyId),
      ]);
      return {
        ...o,
        medicationName: prescription?.medicationName || "Medication",
        pharmacy: pharmacy ? { id: pharmacy.id, name: pharmacy.name, address: pharmacy.address } : null,
      };
    }),
  );
  res.json(results);
});

// Demo-only control that steps an order to its next fulfillment status, so
// the full "Processing -> ... -> Delivered" arc is visible in one sitting
// without waiting on a real courier.
router.post("/orders/:id/advance", requireAuth, requireRole("patient"), async (req, res) => {
  // This control fakes a courier. In a real deployment a patient must never
  // be able to mark their own order "delivered" — it only exists in demo mode.
  if (!isDemoMode()) return res.status(404).json({ message: "Not found" });
  const userId = (req as any).userId as string;
  const order = await storage.getPharmacyOrder(req.params.id);
  if (!order || order.patientUserId !== userId) {
    return res.status(404).json({ message: "Order not found" });
  }
  const sequence = sequenceFor(order.fulfillmentType);
  const currentIndex = sequence.indexOf(order.status);
  if (currentIndex === -1 || currentIndex === sequence.length - 1) {
    return res.status(409).json({ message: "This order is already at its final status" });
  }
  const nextStatus = sequence[currentIndex + 1];
  const statusHistory = [...order.statusHistory, { status: nextStatus, at: new Date().toISOString() }];
  const updated = await storage.advancePharmacyOrderStatus(order.id, nextStatus, statusHistory);

  await logAudit({ actorUserId: userId, action: "pharmacy_order.advanced", targetType: "pharmacy_order", targetId: order.id, metadata: { status: nextStatus } });

  res.json(updated);
});

export default router;
