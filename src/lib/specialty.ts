export const SPECIALTIES = [
  "General Practice",
  "Cardiology",
  "Dermatology",
  "Pediatrics",
  "Orthopedics",
  "Neurology",
  "Psychiatry",
  "Gastroenterology",
  "ENT (Ear, Nose & Throat)",
  "Pulmonology",
  "Gynecology",
  "Urology",
] as const;

const KEYWORD_MAP: { specialty: string; keywords: string[] }[] = [
  {
    specialty: "Cardiology",
    keywords: ["chest pain", "heart", "palpitation", "blood pressure", "cardiac"],
  },
  {
    specialty: "Dermatology",
    keywords: ["skin", "rash", "acne", "itch", "mole", "eczema"],
  },
  {
    specialty: "Pediatrics",
    keywords: ["child", "baby", "infant", "toddler", "kid"],
  },
  {
    specialty: "Orthopedics",
    keywords: ["bone", "joint", "fracture", "back pain", "knee", "shoulder", "sprain"],
  },
  {
    specialty: "Neurology",
    keywords: ["headache", "migraine", "dizziness", "seizure", "numbness", "tingling"],
  },
  {
    specialty: "Psychiatry",
    keywords: ["anxiety", "depression", "stress", "insomnia", "mood", "panic"],
  },
  {
    specialty: "Gastroenterology",
    keywords: ["stomach", "nausea", "vomit", "diarrhea", "abdominal", "digestion", "bloating"],
  },
  {
    specialty: "ENT (Ear, Nose & Throat)",
    keywords: ["ear", "throat", "sinus", "nose", "hearing", "sore throat"],
  },
  {
    specialty: "Pulmonology",
    keywords: ["cough", "breath", "asthma", "lung", "wheeze"],
  },
  {
    specialty: "Gynecology",
    keywords: ["period", "pregnan", "menstrual", "gynecolog"],
  },
  {
    specialty: "Urology",
    keywords: ["urinat", "bladder", "kidney stone", "prostate"],
  },
];

export function suggestSpecialty(symptoms: string): string {
  const text = symptoms.toLowerCase();
  for (const entry of KEYWORD_MAP) {
    if (entry.keywords.some((kw) => text.includes(kw))) {
      return entry.specialty;
    }
  }
  return "General Practice";
}
