// Static, versioned in source rather than an admin-editable DB table —
// this is clinical-adjacent logic (it decides which doctors a sick
// patient sees) and should go through code review like anything else that
// changes matching behavior, not be silently edited from an admin UI with
// no review trail.

export const SPECIALTIES = [
  "Family Medicine",
  "Internal Medicine",
  "Pediatrics",
  "Dermatology",
  "Cardiology",
  "Psychiatry",
  "Orthopedics",
  "ENT (Ear, Nose & Throat)",
  "Gastroenterology",
  "OB/GYN",
  "Urgent Care",
  "Endocrinology",
] as const;

export type Specialty = (typeof SPECIALTIES)[number];

// Keyword -> specialty relevance. Used by matchingService.ts to rank
// same-state doctors by how well their specialty matches the patient's
// stated symptoms. Deliberately simple and explainable (substring/keyword
// overlap, not a black-box model) so a match can always be justified back
// to the patient and audited later.
export const SYMPTOM_KEYWORDS: Record<Specialty, string[]> = {
  "Family Medicine": ["checkup", "fever", "cold", "flu", "cough", "fatigue", "tired", "general"],
  "Internal Medicine": ["fatigue", "weight loss", "chronic", "diabetes", "blood pressure", "hypertension"],
  Pediatrics: ["child", "kid", "baby", "infant", "toddler"],
  Dermatology: ["rash", "skin", "acne", "itchy", "mole", "eczema", "hives"],
  Cardiology: ["chest pain", "heart", "palpitations", "shortness of breath", "irregular heartbeat"],
  Psychiatry: ["anxiety", "depression", "panic", "insomnia", "sleep", "stress", "mood"],
  Orthopedics: ["joint", "knee", "back pain", "fracture", "sprain", "shoulder", "hip"],
  "ENT (Ear, Nose & Throat)": ["ear", "sinus", "throat", "hearing", "nose", "sore throat", "tonsil"],
  Gastroenterology: ["stomach", "nausea", "vomiting", "diarrhea", "abdominal pain", "constipation", "heartburn", "reflux"],
  "OB/GYN": ["pregnancy", "pregnant", "menstrual", "period", "gynecological"],
  "Urgent Care": ["injury", "cut", "burn", "sprain", "sudden", "urgent"],
  Endocrinology: ["thyroid", "diabetes", "hormone", "blood sugar"],
};

export const US_STATES = [
  "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "FL", "GA",
  "HI", "ID", "IL", "IN", "IA", "KS", "KY", "LA", "ME", "MD",
  "MA", "MI", "MN", "MS", "MO", "MT", "NE", "NV", "NH", "NJ",
  "NM", "NY", "NC", "ND", "OH", "OK", "OR", "PA", "RI", "SC",
  "SD", "TN", "TX", "UT", "VT", "VA", "WA", "WV", "WI", "WY",
] as const;
