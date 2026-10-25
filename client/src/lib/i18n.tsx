import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { DICTIONARIES, LOCALES, en, type Dictionary, type Key, type Locale } from "@/locales";

/**
 * Interface translations.
 *
 * - English is the source of truth and the fallback: a key missing from
 *   another language shows the English text, never a blank or a raw key.
 * - Only interface wording is translated. Anything a DOCTOR wrote (notes,
 *   instructions, prescriptions) is never machine-translated.
 * - Non-English dictionaries load on demand; English readers never download
 *   them. Strings live in client/src/locales/<language>/<area>.ts.
 * - Plurals: define `key_one`, `key_other` (and `_two`, `_few`, `_many`,
 *   `_zero` where the language needs them) and call t("key", { count }).
 */
export type { Key, Locale };
export { LOCALES };

export const LOCALE_STORAGE_KEY = "pdapp_locale";

type PluralSuffix = "zero" | "one" | "two" | "few" | "many" | "other";
type PluralBase<K extends string> = K extends `${infer B}_${PluralSuffix}` ? B : never;
export type MessageKey = Key | PluralBase<Key>;
type Vars = Record<string, string | number>;

const loaded: Partial<Record<Locale, Dictionary>> = { en };

function lookup(locale: Locale, key: string, vars?: Vars): string {
  const dict = loaded[locale] ?? {};
  const candidates: string[] = [];
  if (vars && typeof vars.count === "number") {
    const rule = new Intl.PluralRules(locale).select(vars.count);
    candidates.push(`${key}_${rule}`, `${key}_other`);
  }
  candidates.push(key);
  for (const k of candidates) {
    const hit = (dict as Record<string, string | undefined>)[k] ?? (en as Record<string, string | undefined>)[k];
    if (hit !== undefined) return hit;
  }
  return key;
}

export function translate(locale: Locale, key: MessageKey, vars?: Vars): string {
  const template = lookup(locale, key, vars);
  return vars ? template.replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? `{${k}}`)) : template;
}

/** Fetches a language's dictionary if it isn't loaded yet. */
export async function loadLocale(locale: Locale): Promise<void> {
  if (loaded[locale]) return;
  try {
    loaded[locale] = await DICTIONARIES[locale]();
  } catch {
    // Offline or a failed chunk: the app keeps working in English.
  }
}

export function detectInitialLocale(): Locale {
  try {
    const stored = localStorage.getItem(LOCALE_STORAGE_KEY) as Locale | null;
    if (stored && LOCALES.some((l) => l.code === stored)) return stored;
    const browser = (navigator.language || "en").slice(0, 2).toLowerCase();
    return LOCALES.find((l) => l.code === browser)?.code ?? "en";
  } catch {
    return "en";
  }
}

export function hasChosenLocale(): boolean {
  try {
    return !!localStorage.getItem(LOCALE_STORAGE_KEY);
  } catch {
    return false;
  }
}

// Read by non-React code (date formatting) so everything follows the chosen language.
let currentLocale: Locale = "en";
export function getLocale(): Locale {
  return currentLocale;
}
/** BCP 47 tag used for Intl formatting of dates, times and numbers. */
export function getIntlLocale(): string {
  return LOCALES.find((l) => l.code === currentLocale)?.intl ?? "en-US";
}

interface I18n {
  locale: Locale;
  dir: "ltr" | "rtl";
  setLocale: (l: Locale) => void;
  t: (key: MessageKey, vars?: Vars) => string;
}

const Ctx = createContext<I18n | null>(null);

function applyToDocument(locale: Locale) {
  const meta = LOCALES.find((l) => l.code === locale)!;
  document.documentElement.lang = locale;
  document.documentElement.dir = meta.dir;
}

export function I18nProvider({ children }: { children: React.ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(detectInitialLocale);
  // Bumped when a dictionary finishes loading so text re-renders in the new language.
  const [, setVersion] = useState(0);
  // Set during render, not in an effect, so date and greeting helpers called
  // while rendering this very pass already use the chosen language.
  currentLocale = locale;

  useEffect(() => {
    applyToDocument(locale);
    if (!loaded[locale]) {
      let cancelled = false;
      loadLocale(locale).then(() => !cancelled && setVersion((v) => v + 1));
      return () => {
        cancelled = true;
      };
    }
  }, [locale]);

  const setLocale = useCallback((l: Locale) => {
    try {
      localStorage.setItem(LOCALE_STORAGE_KEY, l);
    } catch {
      // Applies for this visit even if it can't be remembered.
    }
    window.dispatchEvent(new CustomEvent("avela:locale", { detail: l }));
    setLocaleState(l);
  }, []);

  const value = useMemo<I18n>(
    () => ({ locale, dir: LOCALES.find((l) => l.code === locale)!.dir, setLocale, t: (key, vars) => translate(locale, key, vars) }),
    // `loaded` mutates outside React, so the identity changes with locale and version.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [locale, setLocale, loaded[locale]],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useI18n(): I18n {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useI18n must be used inside <I18nProvider>");
  return ctx;
}
