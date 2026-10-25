// Languages a clinician can list. Shown to patients in their own script so
// someone who reads Arabic recognises "العربية" without needing English.
export const CLINICIAN_LANGUAGES = [
  { code: "en", english: "English", native: "English" },
  { code: "ar", english: "Arabic", native: "العربية" },
  { code: "es", english: "Spanish", native: "Español" },
  { code: "fr", english: "French", native: "Français" },
  { code: "ur", english: "Urdu", native: "اردو" },
  { code: "fa", english: "Persian", native: "فارسی" },
  { code: "tr", english: "Turkish", native: "Türkçe" },
  { code: "so", english: "Somali", native: "Soomaali" },
  { code: "hi", english: "Hindi", native: "हिन्दी" },
  { code: "bn", english: "Bengali", native: "বাংলা" },
  { code: "zh", english: "Chinese", native: "中文" },
  { code: "ru", english: "Russian", native: "Русский" },
  { code: "pt", english: "Portuguese", native: "Português" },
  { code: "de", english: "German", native: "Deutsch" },
  { code: "vi", english: "Vietnamese", native: "Tiếng Việt" },
  { code: "ko", english: "Korean", native: "한국어" },
  { code: "tl", english: "Tagalog", native: "Tagalog" },
  { code: "he", english: "Hebrew", native: "עברית" },
] as const;

export const LANGUAGE_CODES = CLINICIAN_LANGUAGES.map((l) => l.code) as readonly string[] as readonly [string, ...string[]];

// How a clinician can be reached. Video is deliberately absent: it is not an
// operational capability yet, so it cannot be offered or filtered on.
export const MODALITIES = ["phone", "messaging", "in_person"] as const;
export type Modality = (typeof MODALITIES)[number];

export const PROFESSIONAL_ROLES = ["physician", "nurse_practitioner", "physician_assistant", "other_clinician"] as const;
export type ProfessionalRole = (typeof PROFESSIONAL_ROLES)[number];

// Where an application stands. Only "approved" confers clinical access.
export const DOCTOR_STATUSES = ["incomplete", "pending", "needs_info", "approved", "rejected", "suspended"] as const;
export type DoctorStatus = (typeof DOCTOR_STATUSES)[number];
