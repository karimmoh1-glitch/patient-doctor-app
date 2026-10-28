import { useQuery } from "@tanstack/react-query";

export interface AppConfig {
  /** Emergency numbers by country, with their sources. In production, numbers appear only once a person has reviewed them. */
  emergency: {
    version: string;
    countries: Record<"EG" | "US", {
      code: "EG" | "US"; reviewed: boolean; services: { kind: "all" | "ambulance" | "police" | "fire"; number: string }[] | null; primary: string;
      sources: { title: string; url: string; checkedOn: string; official: string }[]; caveats: string[]; reviewedBy: string | null; reviewedOn: string | null;
    }>;
  };
  /** Set by the host on a test deployment; shown on every screen. */
  environmentNotice: string | null;
  features: { email: boolean; videoVisits: boolean; documentUploads: boolean; smsReminders: boolean; liveSupportChat: boolean };
  support: { phone: string | null; email: string | null; hours: string | null };
}

/** What this deployment can genuinely do. Until it loads, assume nothing is available. */
export function useAppConfig() {
  const { data } = useQuery<AppConfig>({ queryKey: ["/api/config"], staleTime: 5 * 60_000 });
  return data ?? null;
}
