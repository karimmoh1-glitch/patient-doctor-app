import { canSendPhiToAiProvider } from "../config";
import { dateKeyInZone, patientTimezoneById } from "../lib/localTime";
import OpenAI from "openai";
import { storage } from "../storage";

// ---------------------------------------------------------------------------
// The AI Health Navigator: a healthcare INFORMATION AND ORGANIZATION
// assistant, not an AI doctor. It only ever reasons over the patient's own
// authorized application data (gathered below) — it never diagnoses,
// prescribes, changes medications, or claims certainty about a medical
// condition. Urgent-sounding symptoms are redirected to real emergency care.
// ---------------------------------------------------------------------------

export interface PatientContext {
  patientName: string;
  upcomingAppointments: { doctorName: string; type: string; scheduledAt: string; status: string }[];
  activeMedications: { name: string; instructions: string; scheduleTimes: string[] }[];
  todaysDoses: { medicationName: string; time: string; status: string }[];
  activePrescriptions: { medicationName: string; instructions: string; refillsRemaining: number }[];
  openFollowUps: { title: string; detail: string | null; dueDate: string | null }[];
  recentDoctorInstructions: { doctorName: string; followUpInstructions: string; date: string }[];
  careTeam: { doctorName: string; specialty: string; relationshipLabel: string }[];
}

async function todayKeyFor(patientUserId: string): Promise<string> {
  return dateKeyInZone(new Date(), await patientTimezoneById(patientUserId));
}

export async function gatherPatientContext(patientUserId: string): Promise<PatientContext> {
  const user = await storage.getUser(patientUserId);
  const [appointments, medications, prescriptions, followUps, pairings, todayLogs] = await Promise.all([
    storage.getAppointmentsByPatient(patientUserId),
    storage.getMedicationsByPatient(patientUserId),
    storage.getPrescriptionsByPatient(patientUserId),
    storage.getFollowUpTasksByPatient(patientUserId),
    storage.getAcceptedPairingsByPatient(patientUserId),
    storage.getMedicationLogsByPatientAndDate(patientUserId, await todayKeyFor(patientUserId)),
  ]);

  const doctorCache = new Map<string, { name: string; specialty: string }>();
  async function doctor(id: string) {
    if (!doctorCache.has(id)) {
      const d = await storage.getDoctorProfile(id);
      doctorCache.set(id, { name: d?.name || "your doctor", specialty: d?.specialty || "" });
    }
    return doctorCache.get(id)!;
  }

  const upcomingAppointments = [];
  for (const a of appointments) {
    if (a.status === "requested" || a.status === "confirmed") {
      const d = await doctor(a.doctorProfileId);
      upcomingAppointments.push({ doctorName: d.name, type: a.type, scheduledAt: (a.scheduledAt as unknown as Date).toISOString(), status: a.status });
    }
  }
  upcomingAppointments.sort((a, b) => new Date(a.scheduledAt).getTime() - new Date(b.scheduledAt).getTime());

  const activeMedications = medications
    .filter((m) => m.active)
    .map((m) => ({ name: m.name, instructions: m.instructions, scheduleTimes: m.scheduleTimes }));

  const logBySlot = new Map(todayLogs.map((l) => [`${l.medicationId}:${l.doseTime}`, l.status]));
  const todaysDoses = medications
    .filter((m) => m.active)
    .flatMap((m) => m.scheduleTimes.map((time) => ({ medicationName: m.name, time, status: logBySlot.get(`${m.id}:${time}`) || "upcoming" })))
    .sort((a, b) => a.time.localeCompare(b.time));

  const activePrescriptions = prescriptions
    .filter((p) => p.status === "active")
    .map((p) => ({ medicationName: p.medicationName, instructions: p.instructions, refillsRemaining: p.refillsAllowed - p.refillsUsed }));

  const openFollowUps = followUps
    .filter((f) => f.status === "open")
    .map((f) => ({ title: f.title, detail: f.detail, dueDate: f.dueDate ? (f.dueDate as unknown as Date).toISOString() : null }));

  const recentDoctorInstructions = [];
  for (const a of appointments) {
    if (a.status === "completed" && a.followUpInstructions) {
      const d = await doctor(a.doctorProfileId);
      recentDoctorInstructions.push({ doctorName: d.name, followUpInstructions: a.followUpInstructions, date: (a.scheduledAt as unknown as Date).toISOString() });
    }
  }

  const careTeam = [];
  for (const p of pairings) {
    const d = await doctor(p.doctorProfileId);
    careTeam.push({ doctorName: d.name, specialty: d.specialty, relationshipLabel: p.relationshipLabel || d.specialty });
  }

  return {
    patientName: user?.name || "there",
    upcomingAppointments,
    activeMedications,
    todaysDoses,
    activePrescriptions,
    openFollowUps,
    recentDoctorInstructions,
    careTeam,
  };
}

const SYSTEM_PROMPT = `You are the Avela Health Navigator, an in-app assistant that helps a patient understand and organize their OWN healthcare information inside this demo app.

Strict rules:
- You are an information/organization assistant, not a doctor. Never diagnose, never suggest a diagnosis, never recommend a specific medication or dosage, and never say you're changing a medication or appointment.
- Only state facts that appear in the CONTEXT block below. If something isn't in the context, say you don't have that information rather than guessing.
- Clearly distinguish facts from your own explanation. When you explain or simplify something, make clear that's your explanation, not new medical information.
- If the patient describes anything that sounds urgent or like a medical emergency (e.g. chest pain, difficulty breathing, severe bleeding, thoughts of self-harm), tell them clearly to contact emergency services (911 in the US) or use the app's SOS page, rather than trying to help further.
- This is a hackathon demo app with fictional/demo data. Keep responses concise, warm, and useful — a few sentences or a short list, not an essay.`;

function formatContext(ctx: PatientContext): string {
  const lines: string[] = [`Patient: ${ctx.patientName}`];
  lines.push(
    ctx.upcomingAppointments.length
      ? `Upcoming appointments: ${ctx.upcomingAppointments.map((a) => `${a.type} with ${a.doctorName} on ${new Date(a.scheduledAt).toLocaleString()} (${a.status})`).join("; ")}`
      : "Upcoming appointments: none scheduled.",
  );
  lines.push(
    ctx.activeMedications.length
      ? `Active medications: ${ctx.activeMedications.map((m) => `${m.name} (${m.instructions}), scheduled at ${m.scheduleTimes.join(", ")}`).join("; ")}`
      : "Active medications: none currently tracked.",
  );
  lines.push(
    ctx.todaysDoses.length
      ? `Today's doses: ${ctx.todaysDoses.map((d) => `${d.medicationName} at ${d.time} — ${d.status}`).join("; ")}`
      : "Today's doses: none scheduled today.",
  );
  lines.push(
    ctx.activePrescriptions.length
      ? `Active prescriptions: ${ctx.activePrescriptions.map((p) => `${p.medicationName} (${p.refillsRemaining} refills remaining)`).join("; ")}`
      : "Active prescriptions: none active.",
  );
  lines.push(
    ctx.openFollowUps.length
      ? `Open follow-up tasks: ${ctx.openFollowUps.map((f) => `${f.title}${f.dueDate ? ` (due ${new Date(f.dueDate).toLocaleDateString()})` : ""}`).join("; ")}`
      : "Open follow-up tasks: none.",
  );
  lines.push(
    ctx.recentDoctorInstructions.length
      ? `Recent doctor instructions: ${ctx.recentDoctorInstructions.map((r) => `${r.doctorName} said: "${r.followUpInstructions}"`).join("; ")}`
      : "Recent doctor instructions: none recorded.",
  );
  lines.push(
    ctx.careTeam.length
      ? `Care team: ${ctx.careTeam.map((c) => `${c.doctorName} (${c.relationshipLabel})`).join("; ")}`
      : "Care team: not connected with any doctors yet.",
  );
  return lines.join("\n");
}

let warnedAiNotConfirmed = false;

function getClient(): OpenAI | null {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;
  // Everything sent here is built from a patient's own records (medications,
  // appointments, doctor instructions). Having an API key is not a legal
  // basis to send it to a third party, so the operator must confirm one.
  if (!canSendPhiToAiProvider()) {
    if (!warnedAiNotConfirmed && process.env.NODE_ENV !== "test") {
      warnedAiNotConfirmed = true;
      console.error(
        "[AI] OPENAI_API_KEY is set but AI_PHI_PROCESSING_CONFIRMED is not \"true\" — patient data will NOT be sent to OpenAI; using the built-in fallback.",
      );
    }
    return null;
  }
  return new OpenAI({ apiKey });
}

// Deterministic fallback used whenever no OPENAI_API_KEY is configured, so
// the assistant is still genuinely useful (grounded in real app data)
// without any external dependency.
function ruleBasedReply(message: string, ctx: PatientContext): string {
  const m = message.toLowerCase();

  const urgent = ["chest pain", "can't breathe", "cannot breathe", "suicide", "self-harm", "severe bleeding", "911"];
  if (urgent.some((u) => m.includes(u))) {
    return "If this is a medical emergency, please call 911 (US) or your local emergency number right away, or use the SOS page in this app. I'm not able to help with urgent symptoms — please contact emergency care.";
  }

  // Checked before the generic "appointment"/"visit" branch below, since
  // phrases like "since my last visit" or "what's changed" would otherwise
  // be misread as a plain "when's my appointment" question — the specific,
  // multi-word intents need to win over a single loose keyword match.
  if (m.includes("summar") || m.includes("changed") || m.includes("since my last") || m.includes("since last")) {
    const parts = [
      ctx.upcomingAppointments.length ? `${ctx.upcomingAppointments.length} upcoming appointment(s)` : null,
      ctx.activeMedications.length ? `${ctx.activeMedications.length} tracked medication(s)` : null,
      ctx.openFollowUps.length ? `${ctx.openFollowUps.length} open follow-up task(s)` : null,
    ].filter(Boolean);
    return parts.length ? `Here's where things stand: ${parts.join(", ")}.` : "Your healthcare activity is quiet right now — nothing outstanding.";
  }

  if (m.includes("question")) {
    if (!ctx.upcomingAppointments.length) {
      return "You don't have an upcoming appointment yet, but once you book one, you can jot down questions right on that appointment's page and I'll help you think them through.";
    }
    const next = ctx.upcomingAppointments[0];
    return `For your ${next.type.toLowerCase()} with ${next.doctorName}, it can help to ask: how things have changed since your last visit, whether your current medications are still the right fit, and anything about your daily routine you're unsure how to manage. You can save these directly on the appointment's "Prepare for my appointment" page so ${next.doctorName} sees them too.`;
  }

  if (m.includes("medication") || m.includes("taking") || m.includes("meds")) {
    if (!ctx.activeMedications.length) return "You don't have any medications being tracked right now.";
    return `You're currently tracking ${ctx.activeMedications.length} medication${ctx.activeMedications.length > 1 ? "s" : ""}: ${ctx.activeMedications.map((m2) => m2.name).join(", ")}.`;
  }

  if (m.includes("appointment") || m.includes("visit")) {
    if (!ctx.upcomingAppointments.length) return "You don't have any upcoming appointments scheduled.";
    const next = ctx.upcomingAppointments[0];
    return `Your next appointment is a ${next.type.toLowerCase()} with ${next.doctorName} on ${new Date(next.scheduledAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })} (currently ${next.status}).`;
  }

  if (m.includes("follow") || m.includes("instruction") || m.includes("told me")) {
    if (ctx.recentDoctorInstructions.length) {
      const r = ctx.recentDoctorInstructions[0];
      return `${r.doctorName} said: "${r.followUpInstructions}"`;
    }
    if (ctx.openFollowUps.length) {
      return `You have ${ctx.openFollowUps.length} open follow-up task${ctx.openFollowUps.length > 1 ? "s" : ""}: ${ctx.openFollowUps.map((f) => f.title).join(", ")}.`;
    }
    return "You don't have any recorded follow-up instructions right now.";
  }

  if (m.includes("today") || m.includes("dose") || m.includes("reminder")) {
    const upcoming = ctx.todaysDoses.filter((d) => d.status === "upcoming");
    if (!ctx.todaysDoses.length) return "You don't have any medication doses scheduled today.";
    return `You have ${upcoming.length} of ${ctx.todaysDoses.length} scheduled dose${ctx.todaysDoses.length > 1 ? "s" : ""} remaining today.`;
  }

  return "I can help with things like your medications, next appointment, recent doctor instructions, and follow-up tasks — ask me about any of those, or say \"summarize my recent activity\".";
}

export async function chat(userId: string, message: string): Promise<{ reply: string; usedAi: boolean }> {
  const ctx = await gatherPatientContext(userId);
  const client = getClient();

  if (!client) {
    return { reply: ruleBasedReply(message, ctx), usedAi: false };
  }

  try {
    const history = await storage.getAiMessagesByUser(userId, 10);
    const completion = await client.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "system", content: `CONTEXT (facts from the patient's own data — the only source of truth for facts):\n${formatContext(ctx)}` },
        ...history.map((h) => ({ role: h.role as "user" | "assistant", content: h.content })),
        { role: "user", content: message },
      ],
      temperature: 0.4,
      max_tokens: 400,
    });
    const reply = completion.choices[0]?.message?.content?.trim();
    if (!reply) throw new Error("Empty completion");
    return { reply, usedAi: true };
  } catch (err) {
    console.error("[AI] OpenAI call failed, falling back to rule-based reply:", err);
    return { reply: ruleBasedReply(message, ctx), usedAi: false };
  }
}

const EXPLAIN_SIMPLY_PROMPT = `You restate a doctor's instruction in plain, simple language for a patient — you do not add, remove, or change any medical meaning. Keep it to one or two short sentences. Do not add new instructions, dosages, or advice that wasn't in the original text. If the text is already simple, you may return it close to as-is.`;

// A deterministic fallback: expands common medical shorthand and shortens
// sentences, without inventing anything not present in the source text.
function explainSimplyFallback(text: string): string {
  const replacements: [RegExp, string][] = [
    [/\bas directed\b/gi, "the way your doctor told you to"],
    [/\bas prescribed\b/gi, "the way your doctor prescribed it"],
    [/\bby mouth\b/gi, "by swallowing it"],
    [/\btwice daily\b/gi, "two times a day"],
    [/\bonce daily\b/gi, "one time a day"],
    [/\bwith food\b/gi, "with a meal"],
    [/\bp\.?r\.?n\.?\b/gi, "only when you need it"],
  ];
  let simplified = text;
  for (const [pattern, replacement] of replacements) {
    simplified = simplified.replace(pattern, replacement);
  }
  return simplified === text ? `In simple terms: ${text}` : simplified;
}

// Explain Simply: restates existing doctor-authored text in plain
// language. Never generates new medical content — the source text is
// always the ceiling of what can be said.
export async function explainSimply(text: string): Promise<{ explanation: string; usedAi: boolean }> {
  const client = getClient();
  if (!client) {
    return { explanation: explainSimplyFallback(text), usedAi: false };
  }
  try {
    const completion = await client.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: EXPLAIN_SIMPLY_PROMPT },
        { role: "user", content: text },
      ],
      temperature: 0.2,
      max_tokens: 150,
    });
    const explanation = completion.choices[0]?.message?.content?.trim();
    if (!explanation) throw new Error("Empty completion");
    return { explanation, usedAi: true };
  } catch (err) {
    console.error("[AI] Explain Simply call failed, falling back:", err);
    return { explanation: explainSimplyFallback(text), usedAi: false };
  }
}
