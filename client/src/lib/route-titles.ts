import { useEffect } from "react";
import { getLocale, translate, useI18n, type MessageKey } from "@/lib/i18n";

// Human page names, used for the browser tab/title (WCAG 2.4.2) and so a
// screen reader announces where you've landed after each navigation.
// Each entry maps a route prefix to a translation key.
const TITLES: [prefix: string, key: MessageKey][] = [
  ["/care-circle/accept", "routetitle.careCircleAccept"],
  ["/care-circle", "routetitle.careCircle"],
  ["/care-team", "routetitle.careTeam"],
  ["/appointments", "nav.appointments"],
  ["/my-health", "routetitle.myHealth"],
  ["/medications", "routetitle.medications"],
  ["/prescriptions", "routetitle.prescriptions"],
  ["/pharmacy", "routetitle.pharmacy"],
  ["/timeline", "routetitle.timeline"],
  ["/documents", "routetitle.documents"],
  ["/handoff", "routetitle.handoff"],
  ["/assistant", "routetitle.assistant"],
  ["/profile", "routetitle.profile"],
  ["/messages", "routetitle.messages"],
  ["/chat", "routetitle.chat"],
  ["/symptoms", "home.findDoctor"],
  ["/match-results", "routetitle.matchResults"],
  ["/doctors", "home.findDoctor"],
  ["/help", "top.help"],
  ["/sos", "top.emergency"],
  ["/login", "routetitle.login"],
  ["/signup", "routetitle.signup"],
  ["/forgot-password", "forgotpw.title"],
  ["/reset-password", "resetpw.title"],
  ["/apply-as-doctor", "routetitle.apply"],
  ["/doctor/requests", "nav.d.requests"],
  ["/doctor/patients", "nav.d.patients"],
  ["/doctor/appointments", "nav.d.appointments"],
  ["/doctor/availability", "nav.d.hours"],
  ["/doctor", "nav.d.home"],
  ["/caregiver", "nav.caregiver"],
  ["/admin", "nav.admin"],
];

/** The page name for a path, in the language currently chosen. */
export function titleForPath(path: string): string {
  if (path === "/") return translate(getLocale(), "nav.home");
  const hit = TITLES.find(([prefix]) => path === prefix || path.startsWith(prefix + "/"));
  return translate(getLocale(), hit ? hit[1] : "notfound.title");
}

/** "Page name · Avela" in the current language. */
export function documentTitle(path: string): string {
  return `${titleForPath(path)} · ${translate(getLocale(), "brand.name")}`;
}

/** Keeps document.title in step with the route AND the chosen language. Call from inside <I18nProvider>. */
export function useDocumentTitle(path: string): void {
  const { locale, t } = useI18n();
  useEffect(() => {
    document.title = documentTitle(path);
    // `t` changes when the language or its dictionary finishes loading.
  }, [path, locale, t]);
}
