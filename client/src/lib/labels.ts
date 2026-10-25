import { SPECIALTIES } from "@shared/specialties";
import { CLINICIAN_LANGUAGES } from "@shared/languages";
import type { MessageKey } from "@/lib/i18n";

// Stored values (what the server and database use) stay in English; these map
// them to translation keys for display, so a specialty or a role reads
// naturally in the viewer's language.
const SPECIALTY_KEYS: Record<(typeof SPECIALTIES)[number], MessageKey> = {
  "Family Medicine": "specialty.family_medicine",
  "Internal Medicine": "specialty.internal_medicine",
  Pediatrics: "specialty.pediatrics",
  Dermatology: "specialty.dermatology",
  Cardiology: "specialty.cardiology",
  Psychiatry: "specialty.psychiatry",
  Orthopedics: "specialty.orthopedics",
  "ENT (Ear, Nose & Throat)": "specialty.ent",
  Gastroenterology: "specialty.gastroenterology",
  "OB/GYN": "specialty.obgyn",
  "Urgent Care": "specialty.urgent_care",
  Endocrinology: "specialty.endocrinology",
};

type T = (key: MessageKey) => string;

export function specialtyLabel(t: T, value: string): string {
  const key = (SPECIALTY_KEYS as Record<string, MessageKey>)[value];
  return key ? t(key) : value;
}
export const modalityLabel = (t: T, value: string) => t(`modality.${value}` as MessageKey);
export const roleLabel = (t: T, value: string) => t(`role.${value}` as MessageKey);
/** A language's own name, in its own script (never translated). */
export function languageName(code: string): string {
  return CLINICIAN_LANGUAGES.find((l) => l.code === code)?.native ?? code;
}

const APPOINTMENT_TYPE_KEYS: Record<string, MessageKey> = {
  "Video Visit": "pt.apptType.video",
  "Phone Call": "pt.apptType.phone",
  "In-Person": "pt.apptType.inPerson",
};
/** The reader's-language name for a stored appointment type; an unknown type shows as stored. */
export function appointmentTypeLabel(t: T, type: string): string {
  const key = APPOINTMENT_TYPE_KEYS[type];
  return key ? t(key) : type;
}
