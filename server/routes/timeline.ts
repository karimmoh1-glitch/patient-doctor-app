import { Router } from "express";
import { storage } from "../storage";
import { requireAuth, requireRole } from "../middleware/auth";

const router = Router();

interface TimelineEvent {
  date: string; // ISO timestamp, used for sorting
  kind: "appointment" | "prescription" | "medication" | "pharmacy" | "document" | "message" | "follow_up";
  title: string;
  subtitle?: string;
  link?: string;
}

// Aggregates events live from their owning tables rather than maintaining a
// separate materialized timeline table — one source of truth per event
// type, no sync bugs between "the record" and "the timeline entry for it".
async function buildTimeline(patientUserId: string): Promise<TimelineEvent[]> {
  const [appointments, prescriptions, medications, pharmacyOrders, documents, followUps, pairings] = await Promise.all([
    storage.getAppointmentsByPatient(patientUserId),
    storage.getPrescriptionsByPatient(patientUserId),
    storage.getMedicationsByPatient(patientUserId),
    storage.getPharmacyOrdersByPatient(patientUserId),
    storage.getDocumentsByPatient(patientUserId),
    storage.getFollowUpTasksByPatient(patientUserId),
    storage.getAcceptedPairingsByPatient(patientUserId),
  ]);

  const doctorNameCache = new Map<string, string>();
  async function doctorName(id: string): Promise<string> {
    if (!doctorNameCache.has(id)) {
      const d = await storage.getDoctorProfile(id);
      doctorNameCache.set(id, d?.name || "your doctor");
    }
    return doctorNameCache.get(id)!;
  }

  const events: TimelineEvent[] = [];

  for (const a of appointments) {
    const name = await doctorName(a.doctorProfileId);
    events.push({
      date: (a.createdAt || a.scheduledAt) as unknown as string,
      kind: "appointment",
      title:
        a.status === "completed" ? `Appointment with ${name} completed`
        : a.status === "confirmed" ? `Appointment confirmed with ${name}`
        : a.status === "cancelled" ? `Appointment with ${name} cancelled`
        : `Appointment requested with ${name}`,
      subtitle: `${a.type} · ${new Date(a.scheduledAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}`,
      link: `/appointments/${a.id}`,
    });
    if (a.status === "completed" && a.doctorNotes) {
      events.push({
        date: a.scheduledAt as unknown as string,
        kind: "appointment",
        title: `Visit summary from ${name}`,
        subtitle: a.followUpInstructions ? "Follow-up instructions included" : undefined,
        link: `/appointments/${a.id}`,
      });
    }
  }

  for (const p of prescriptions) {
    const name = await doctorName(p.doctorProfileId);
    events.push({
      date: p.createdAt as unknown as string,
      kind: "prescription",
      title: `New prescription: ${p.medicationName}`,
      subtitle: `Prescribed by ${name} (demo)`,
      link: "/prescriptions",
    });
  }

  for (const m of medications) {
    events.push({
      date: m.createdAt as unknown as string,
      kind: "medication",
      title: `Started tracking ${m.name}`,
      subtitle: `${m.scheduleTimes.length}x daily`,
      link: "/medications",
    });
  }

  for (const o of pharmacyOrders) {
    for (const h of o.statusHistory) {
      events.push({
        date: h.at,
        kind: "pharmacy",
        title: `Pharmacy order ${h.status.replace(/_/g, " ")}`,
        subtitle: o.fulfillmentType === "delivery" ? "Home delivery (demo)" : "Pickup (demo)",
        link: "/pharmacy",
      });
    }
  }

  for (const d of documents) {
    events.push({
      date: d.createdAt as unknown as string,
      kind: "document",
      title: `Document added: ${d.title}`,
      subtitle: d.category,
      link: "/documents",
    });
  }

  for (const f of followUps) {
    events.push({
      date: f.createdAt as unknown as string,
      kind: "follow_up",
      title: f.title,
      subtitle: f.status === "done" ? "Completed" : "Follow-up task",
      link: "/follow-ups",
    });
  }

  for (const p of pairings) {
    if (p.respondedAt) {
      const name = await doctorName(p.doctorProfileId);
      events.push({
        date: p.respondedAt as unknown as string,
        kind: "message",
        title: `Connected with ${name}`,
        subtitle: "Added to your care team",
        link: "/care-team",
      });
    }
  }

  return events
    .filter((e) => !!e.date)
    .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
}

router.get("/", requireAuth, requireRole("patient"), async (req, res) => {
  const patientUserId = (req as any).userId as string;
  const events = await buildTimeline(patientUserId);

  const since = typeof req.query.since === "string" ? new Date(req.query.since) : null;
  if (since && !isNaN(since.getTime())) {
    return res.json(events.filter((e) => new Date(e.date).getTime() > since.getTime()));
  }
  res.json(events);
});

export default router;
