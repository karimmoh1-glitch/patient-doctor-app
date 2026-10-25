import { en } from "./en";

export type Key = keyof typeof en;
export type Dictionary = Partial<Record<Key, string>>;
export type Locale = "en" | "ar";

export const LOCALES: { code: Locale; label: string; english: string; note?: string; dir: "ltr" | "rtl"; intl: string }[] = [
  { code: "en", label: "English", english: "English", dir: "ltr", intl: "en-US" },
  // Western digits (0-9) are kept for Arabic on purpose: dose times, phone
  // numbers and dates are read against English-labelled medicine packaging and
  // pharmacy systems, where mixing digit sets risks misreading.
  { code: "ar", label: "العربية", english: "Arabic", note: "translation awaiting review", dir: "rtl", intl: "ar-u-nu-latn" },
];

export const DICTIONARIES: Record<Locale, () => Promise<Dictionary>> = {
  en: async () => en,
  ar: () => import("./ar").then((m) => m.ar),
};

export { en };
