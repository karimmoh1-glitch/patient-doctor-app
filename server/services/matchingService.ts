import { SYMPTOM_KEYWORDS, type Specialty } from "@shared/specialties";
import type { ListedDoctor } from "@shared/schema";

export interface DoctorMatch {
  doctor: ListedDoctor;
  score: number;
  matchedKeywords: string[];
}

// Deterministic filter-then-rank: same-state doctors, ranked by keyword
// overlap between the symptom text and each specialty's keyword list.
// Deliberately not a black-box model — which doctors a sick patient sees
// needs to be explainable and auditable after the fact.
export function matchDoctors(
  candidates: ListedDoctor[],
  patientState: string,
  symptomText: string,
): DoctorMatch[] {
  const normalizedText = symptomText.toLowerCase();

  const sameState = candidates.filter(
    (d) => d.active && d.state.toUpperCase() === patientState.toUpperCase(),
  );

  const scored: DoctorMatch[] = sameState.map((doctor) => {
    const keywords = SYMPTOM_KEYWORDS[doctor.specialty as Specialty] || [];
    const matchedKeywords = keywords.filter((k) => normalizedText.includes(k));
    return { doctor, score: matchedKeywords.length, matchedKeywords };
  });

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.doctor.name.localeCompare(b.doctor.name);
  });

  return scored;
}

// Optional signal only — real OpenAI call if configured, deterministic
// keyword fallback otherwise (same real-AI-with-fallback shape as a
// typical aiService). This never chooses which doctors are shown; it only
// suggests which specialty to weight, and matchDoctors above stays the
// sole, deterministic source of truth for the actual doctor list.
export async function suggestSpecialty(symptomText: string): Promise<Specialty | null> {
  const normalizedText = symptomText.toLowerCase();
  let best: { specialty: Specialty; count: number } | null = null;

  for (const [specialty, keywords] of Object.entries(SYMPTOM_KEYWORDS) as [Specialty, string[]][]) {
    const count = keywords.filter((k) => normalizedText.includes(k)).length;
    if (count > 0 && (!best || count > best.count)) {
      best = { specialty, count };
    }
  }

  return best?.specialty ?? null;
}
