import { Router } from "express";
import { storage } from "../storage";
import { requireAuth, requireRole } from "../middleware/auth";
import { normalizeLang, st, stDateTime, stWord } from "../services/serverText";
import { patientTimezoneById } from "../lib/localTime";

const router = Router();

interface TimelineEvent {
  date: string; // ISO timestamp, used for sorting
  kind: "appointment" | "prescription" | "medication" | "document" | "message" | "follow_up";
  title: string;
  subtitle?: string;
  link?: string;
}

// Aggregates events live from their owning tables rather than maintaining a
// separate materialized timeline table — one source of truth per event
// type, no sync bugs between "the record" and "the timeline entry for it".
async function buildTimeline(patientUserId: string): Promise<TimelineEvent[]> {
  const lang = normalizeLang((await storage.getUser(patientUserId))?.language);
  const zone = await patientTimezoneById(patientUserId);
  const [appointments, prescriptions, medications, documents, followUps, pairings] = await Promise.all([
    storage.getAppointmentsByPatient(patientUserId),
    storage.getPrescriptionsByPatient(patientUserId),
    storage.getMedicationsByPatient(patientUserId),
    storage.getDocumentsByPatient(patientUserId),
    storage.getFollowUpTasksByPatient(patientUserId),
    storage.getAcceptedPairingsByPatient(patientUserId),
  ]);

  const doctorNameCache = new Map<string, string>();
  async function doctorName(id: string): Promise<string> {
    if (!doctorNameCache.has(id)) {
      const d = await storage.getDoctorProfile(id);
      doctorNameCache.set(id, d?.name || st(lang, "yourDoctor"));
    }
    return doctorNameCache.get(id)!;
  }

  const events: TimelineEvent[] = [];

  for (const a of appointments) {
    const name = await doctorName(a.doctorProfileId);
    events.push({
      date: (a.createdAt || a.scheduledAt) as unknown as string,
      kind: "appointment",
      title: st(lang, a.status === "completed" ? "tl.appt.completed" : a.status === "confirmed" ? "tl.appt.confirmed" : a.status === "cancelled" ? "tl.appt.cancelled" : "tl.appt.requested", { name }),
      subtitle: `${stWord(lang, "type", a.type)} · ${stDateTime(lang, a.scheduledAt, zone)}`,
      link: `/appointments/${a.id}`,
    });
    if (a.status === "completed" && a.doctorNotes) {
      events.push({
        date: a.scheduledAt as unknown as string,
        kind: "appointment",
        title: st(lang, "tl.visitSummary", { name }),
        subtitle: a.followUpInstructions ? st(lang, "tl.followUpIncluded") : undefined,
        link: `/appointments/${a.id}`,
      });
    }
  }

  for (const p of prescriptions) {
    const name = await doctorName(p.doctorProfileId);
    events.push({
      date: p.createdAt as unknown as string,
      kind: "prescription",
      title: st(lang, "tl.rx.new", { med: p.medicationName }),
      subtitle: st(lang, "tl.rx.by", { name }),
      link: "/prescriptions",
    });
  }

  for (const m of medications) {
    events.push({
      date: m.createdAt as unknown as string,
      kind: "medication",
      title: st(lang, "tl.med.started", { med: m.name }),
      subtitle: st(lang, "tl.med.daily", { count: m.scheduleTimes.length }),
      link: "/medications",
    });
  }

  for (const d of documents) {
    events.push({
      date: d.createdAt as unknown as string,
      kind: "document",
      title: st(lang, "tl.doc.added", { title: d.title }),
      subtitle: stWord(lang, "cat", d.category),
      link: "/documents",
    });
  }

  for (const f of followUps) {
    events.push({
      date: f.createdAt as unknown as string,
      kind: "follow_up",
      title: f.title,
      subtitle: f.status === "done" ? st(lang, "tl.followUp.done") : st(lang, "tl.followUp.task"),
      link: "/follow-ups",
    });
  }

  for (const p of pairings) {
    if (p.respondedAt) {
      const name = await doctorName(p.doctorProfileId);
      events.push({
        date: p.respondedAt as unknown as string,
        kind: "message",
        title: st(lang, "tl.connected", { name }),
        subtitle: st(lang, "tl.careTeam"),
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
