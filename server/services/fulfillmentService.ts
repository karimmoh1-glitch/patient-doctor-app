import type { Pharmacy } from "@shared/schema";

// Rural access intelligence: don't assume every patient has the same
// fulfillment options. A local pharmacy a few miles away and a nationwide
// mail-order pharmacy are fundamentally different trade-offs (speed vs.
// reach), and the patient should see both, ranked by what's actually
// practical for them — not a flat list of every pharmacy in the state.
// Deliberately simple/deterministic (no ML, no external logistics API) so
// every number shown is explainable back to the patient, same philosophy
// as matchingService.ts's doctor ranking.

export interface FulfillmentOption {
  pharmacyId: string;
  pharmacyName: string;
  fulfillmentType: "pickup" | "delivery";
  label: string; // "Home Delivery" | "Mail-Order Delivery" | "Pickup"
  etaText: string;
  feeText: string;
  distanceMiles: number | null;
  badge: "Fastest" | "Most convenient" | "Lowest cost" | "Best for rural areas" | null;
}

function deliveryEta(distanceMiles: number | null): string {
  if (distanceMiles === null) return "3–5 business days";
  if (distanceMiles <= 5) return "Today";
  if (distanceMiles <= 15) return "Tomorrow";
  return "2–3 days";
}

function deliveryFee(distanceMiles: number | null): string {
  if (distanceMiles === null) return "$1.99 demo shipping";
  if (distanceMiles <= 5) return "$2.99 demo delivery fee";
  return "$4.99 demo delivery fee";
}

function pickupEta(distanceMiles: number | null): string {
  if (distanceMiles === null) return "Ready in 2–3 days";
  if (distanceMiles <= 10) return "Ready today";
  return "Ready tomorrow";
}

export function buildFulfillmentOptions(pharmacies: Pharmacy[]): FulfillmentOption[] {
  const local = pharmacies.filter((p) => !p.isMailOrder);
  const mailOrder = pharmacies.find((p) => p.isMailOrder);

  const options: FulfillmentOption[] = [];

  const deliveryCandidates = local.filter((p) => p.deliveryAvailable).sort((a, b) => (a.distanceMiles ?? 999) - (b.distanceMiles ?? 999));
  const nearestDelivery = deliveryCandidates[0];
  if (nearestDelivery) {
    options.push({
      pharmacyId: nearestDelivery.id,
      pharmacyName: nearestDelivery.name,
      fulfillmentType: "delivery",
      label: "Home Delivery",
      etaText: deliveryEta(nearestDelivery.distanceMiles),
      feeText: deliveryFee(nearestDelivery.distanceMiles),
      distanceMiles: nearestDelivery.distanceMiles,
      // No travel required — the practical default for anyone who finds
      // getting to a pharmacy difficult, which is the whole point of this
      // product's target user.
      badge: "Most convenient",
    });
  }

  const pickupCandidates = local.filter((p) => p.pickupAvailable).sort((a, b) => (a.distanceMiles ?? 999) - (b.distanceMiles ?? 999));
  const nearestPickup = pickupCandidates[0];
  if (nearestPickup) {
    options.push({
      pharmacyId: nearestPickup.id,
      pharmacyName: nearestPickup.name,
      fulfillmentType: "pickup",
      label: "Pickup",
      etaText: pickupEta(nearestPickup.distanceMiles),
      feeText: "No fee",
      distanceMiles: nearestPickup.distanceMiles,
      badge: nearestPickup.distanceMiles !== null && nearestPickup.distanceMiles <= 10 ? "Fastest" : null,
    });
  }

  // Always offered — the fallback that makes the product work the same
  // whether the patient lives next to a pharmacy or an hour from one.
  if (mailOrder) {
    const noLocalOption = local.length === 0 || !nearestDelivery;
    options.push({
      pharmacyId: mailOrder.id,
      pharmacyName: mailOrder.name,
      fulfillmentType: "delivery",
      label: "Mail-Order Delivery",
      etaText: deliveryEta(null),
      feeText: deliveryFee(null),
      distanceMiles: null,
      badge: noLocalOption ? "Best for rural areas" : "Lowest cost",
    });
  }

  return options;
}
