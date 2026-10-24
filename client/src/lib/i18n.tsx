import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";

/**
 * Interface translations.
 *
 * - English is the source of truth and the fallback: a key missing from
 *   another language shows the English text, never a blank or a raw key.
 * - Only interface wording (navigation, buttons, emergency and help text) is
 *   translated here. Anything a DOCTOR wrote — notes, instructions,
 *   prescriptions — is never machine-translated and shown as if verified.
 * - The non-English dictionaries below are first drafts. They must be
 *   reviewed by a fluent speaker (and, for the emergency/help wording, a
 *   clinician) before launch in that language. See docs/SAFETY_AND_COMPLIANCE.md.
 */
export type Locale = "en" | "es";

export const LOCALES: { code: Locale; label: string; note?: string; dir: "ltr" | "rtl" }[] = [
  { code: "en", label: "English", dir: "ltr" },
  { code: "es", label: "Español", note: "translation awaiting review", dir: "ltr" },
];

const en = {
  "nav.home": "Home",
  "nav.doctors": "My Doctors",
  "nav.doctors.short": "Doctors",
  "nav.appointments": "Appointments",
  "nav.appointments.short": "Visits",
  "nav.health": "My Health",
  "nav.health.short": "Health",
  "nav.main": "Main",
  "skip": "Skip to main content",
  "top.emergency": "Emergency",
  "top.help": "Help",
  "top.settings": "Settings",
  "demo.banner": "Demonstration site: please use made-up information only. Do not enter real health details.",
  "settings.title": "Settings",
  "settings.signedInAs": "Signed in as {name}.",
  "settings.textSize": "Text size",
  "settings.size.normal": "Standard",
  "settings.size.large": "Large",
  "settings.size.xlarge": "Extra large",
  "settings.language": "Language",
  "settings.simple": "Simple screen",
  "settings.simpleHelp": "A calmer home screen with five big buttons.",
  "settings.signOut": "Sign out",
  "settings.signOut.title": "Sign out of Avela?",
  "settings.signOut.body": "You'll need your email and password to get back in. If you're on a shared phone or computer, signing out keeps your information private.",
  "settings.signOut.yes": "Yes, sign me out",
  "settings.signOut.no": "No, stay signed in",
  "emergency.question": "Having an emergency?",
  "emergency.call": "Call {number}",
  "emergency.callNow": "Call {number} now",
  "public.footer": "Avela helps you find a doctor and keep track of your care. It is not an emergency service and it does not give medical advice.",
  "public.doctorLink": "Are you a doctor? Apply to join",
  "home.next": "Your next visit",
  "home.todo": "What to do today",
  "home.help": "Need help?",
  "home.findDoctor": "Find a doctor",
  "home.book": "Book a visit",
  "home.nothing": "Nothing needs your attention right now.",
  "home.contactDoctor": "Contact one of my doctors",
  "home.contactDoctor.detail": "Call or send a message",
  "home.usingHelp": "Help with using Avela",
  "home.emergencyButton": "Emergency: call {number}",
  "greeting.morning": "Good morning",
  "greeting.afternoon": "Good afternoon",
  "greeting.evening": "Good evening",
  "help.title": "Help",
  "help.intro": "Choose what fits. You never have to figure this out alone.",
  "help.emergency.title": "It's an emergency",
  "help.emergency.body": "Chest pain, trouble breathing, a stroke, heavy bleeding, or you think someone's life is in danger. Avela is not an emergency service and no one here is watching for urgent messages.",
  "help.more": "More emergency options",
  "help.support.none": "This service has not set up a support phone line or email yet, so there is no one to call here. If you are stuck, ask a family member or your doctor's office to help you, or message your doctor below.",
  "help.message.title": "Ask your doctor a question",
  "help.message.body": "For things that aren't urgent. Doctors answer when they can — it can take a day or more, and messages are not watched around the clock.",
  "help.message.button": "My messages",
} as const;

export type Key = keyof typeof en;

const es: Partial<Record<Key, string>> = {
  "nav.home": "Inicio",
  "nav.doctors": "Mis médicos",
  "nav.doctors.short": "Médicos",
  "nav.appointments": "Citas",
  "nav.appointments.short": "Citas",
  "nav.health": "Mi salud",
  "nav.health.short": "Salud",
  "nav.main": "Principal",
  "skip": "Saltar al contenido principal",
  "top.emergency": "Emergencia",
  "top.help": "Ayuda",
  "top.settings": "Ajustes",
  "demo.banner": "Sitio de demostración: use solo información inventada. No escriba datos de salud reales.",
  "settings.title": "Ajustes",
  "settings.signedInAs": "Sesión iniciada como {name}.",
  "settings.textSize": "Tamaño del texto",
  "settings.size.normal": "Normal",
  "settings.size.large": "Grande",
  "settings.size.xlarge": "Muy grande",
  "settings.language": "Idioma",
  "settings.simple": "Pantalla sencilla",
  "settings.simpleHelp": "Una pantalla de inicio más tranquila con cinco botones grandes.",
  "settings.signOut": "Cerrar sesión",
  "settings.signOut.title": "¿Cerrar sesión en Avela?",
  "settings.signOut.body": "Necesitará su correo y su contraseña para volver a entrar. Si usa un teléfono o computadora compartidos, cerrar la sesión protege su información.",
  "settings.signOut.yes": "Sí, cerrar mi sesión",
  "settings.signOut.no": "No, seguir con la sesión",
  "emergency.question": "¿Tiene una emergencia?",
  "emergency.call": "Llamar al {number}",
  "emergency.callNow": "Llamar al {number} ahora",
  "public.footer": "Avela le ayuda a encontrar un médico y a llevar el control de su atención. No es un servicio de emergencias y no da consejos médicos.",
  "public.doctorLink": "¿Es usted médico? Solicite unirse",
  "home.next": "Su próxima cita",
  "home.todo": "Qué hacer hoy",
  "home.help": "¿Necesita ayuda?",
  "home.findDoctor": "Buscar un médico",
  "home.book": "Pedir una cita",
  "home.nothing": "Nada necesita su atención en este momento.",
  "home.contactDoctor": "Comunicarme con uno de mis médicos",
  "home.contactDoctor.detail": "Llamar o enviar un mensaje",
  "home.usingHelp": "Ayuda para usar Avela",
  "home.emergencyButton": "Emergencia: llamar al {number}",
  "greeting.morning": "Buenos días",
  "greeting.afternoon": "Buenas tardes",
  "greeting.evening": "Buenas noches",
  "help.title": "Ayuda",
  "help.intro": "Elija lo que le convenga. No tiene que resolverlo solo.",
  "help.emergency.title": "Es una emergencia",
  "help.emergency.body": "Dolor de pecho, dificultad para respirar, señales de derrame cerebral, sangrado fuerte, o cree que la vida de alguien está en peligro. Avela no es un servicio de emergencias y nadie aquí vigila los mensajes urgentes.",
  "help.more": "Más opciones de emergencia",
  "help.support.none": "Este servicio todavía no tiene una línea de teléfono ni un correo de ayuda, así que no hay a quién llamar aquí. Si tiene dificultades, pida ayuda a un familiar o al consultorio de su médico, o escríbale a su médico abajo.",
  "help.message.title": "Hacerle una pregunta a su médico",
  "help.message.body": "Para cosas que no son urgentes. Los médicos responden cuando pueden, a veces después de un día o más, y los mensajes no se vigilan las 24 horas.",
  "help.message.button": "Mis mensajes",
};

const DICTIONARIES: Record<Locale, Partial<Record<Key, string>>> = { en, es };

const STORAGE_KEY = "pdapp_locale";

export function translate(locale: Locale, key: Key, vars?: Record<string, string | number>): string {
  const template = DICTIONARIES[locale][key] ?? en[key];
  return vars ? template.replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? `{${k}}`)) : template;
}

function detectInitial(): Locale {
  try {
    const stored = localStorage.getItem(STORAGE_KEY) as Locale | null;
    if (stored && LOCALES.some((l) => l.code === stored)) return stored;
    const browser = (navigator.language || "en").slice(0, 2).toLowerCase();
    return LOCALES.find((l) => l.code === browser)?.code ?? "en";
  } catch {
    return "en";
  }
}

// Read by non-React code (date formatting) so everything follows the chosen language.
let currentLocale: Locale = "en";
export function getLocale(): Locale {
  return currentLocale;
}

interface I18n {
  locale: Locale;
  setLocale: (l: Locale) => void;
  t: (key: Key, vars?: Record<string, string | number>) => string;
}

const Ctx = createContext<I18n | null>(null);

export function I18nProvider({ children }: { children: React.ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(detectInitial);
  // Set during render, not in an effect, so date and greeting helpers called
  // while rendering this very pass already use the chosen language.
  currentLocale = locale;

  useEffect(() => {
    const meta = LOCALES.find((l) => l.code === locale)!;
    document.documentElement.lang = locale;
    document.documentElement.dir = meta.dir;
  }, [locale]);

  const setLocale = useCallback((l: Locale) => {
    try {
      localStorage.setItem(STORAGE_KEY, l);
    } catch {
      // Applies for this visit even if it can't be remembered.
    }
    setLocaleState(l);
  }, []);

  const value = useMemo<I18n>(() => ({ locale, setLocale, t: (key, vars) => translate(locale, key, vars) }), [locale, setLocale]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useI18n(): I18n {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useI18n must be used inside <I18nProvider>");
  return ctx;
}
