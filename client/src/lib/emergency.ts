import { useSyncExternalStore } from "react";
import { useAppConfig } from "@/hooks/use-app-config";
import { useI18n } from "@/lib/i18n";
import { isCountry, type CountryCode, type EmergencyService } from "@shared/emergency";

/**
 * Emergency numbers depend on which country the PERSON says they are in: never on their language (an Arabic reader may be in
 * either country), their address or their device. The choice is kept on this device, so nobody has to sign in to make it, and a
 * signed-in person's saved country is used when they have not chosen one here.
 */
const KEY = "avela.country";
let accountCountry: CountryCode | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

function stored(): CountryCode | null {
  try {
    const v = localStorage.getItem(KEY);
    return isCountry(v) ? v : null;
  } catch {
    return null;
  }
}

export function setAccountCountry(c: string | null | undefined) {
  const next = isCountry(c) ? c : null;
  if (next !== accountCountry) {
    accountCountry = next;
    emit();
  }
}

export function chooseCountry(c: CountryCode | null) {
  try {
    if (c) localStorage.setItem(KEY, c);
    else localStorage.removeItem(KEY);
  } catch { /* the choice just is not remembered */ }
  emit();
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};
const snapshot = () => `${stored() ?? ""}|${accountCountry ?? ""}`;

export interface EmergencyView {
  country: CountryCode | null;
  /** The number to offer first, or null when no reviewed number is known for this person's country. */
  label: string;
  tel: string | null;
  services: EmergencyService[] | null;
  /** Whether a person has reviewed this country's numbers (always shown to the reader). */
  reviewed: boolean;
  needsCountry: boolean;
}

export function useEmergency(): EmergencyView {
  const config = useAppConfig();
  const { t } = useI18n();
  const snap = useSyncExternalStore(subscribe, snapshot, () => "|");
  const [chosen, account] = snap.split("|");
  const country = (isCountry(chosen) ? chosen : isCountry(account) ? account : null) as CountryCode | null;
  const data = country ? config?.emergency?.countries?.[country] : undefined;
  const services = data?.services ?? null;
  const first = services?.find((s) => s.kind === data?.primary) ?? services?.[0] ?? null;
  return {
    country,
    label: first?.number ?? t("emergency.local"),
    tel: first ? `tel:${first.number.replace(/[^\d+]/g, "")}` : null,
    services,
    reviewed: !!data?.reviewed,
    needsCountry: !country,
  };
}
