import { useQuery } from "@tanstack/react-query";

export interface AppConfig {
  /** Set by the operator for the deployment's jurisdiction; null until then. */
  emergencyNumber: string | null;
  features: { email: boolean; videoVisits: boolean; documentUploads: boolean; smsReminders: boolean; liveSupportChat: boolean };
  support: { phone: string | null; email: string | null; hours: string | null };
}

/** What this deployment can genuinely do. Until it loads, assume nothing is available. */
export function useAppConfig() {
  const { data } = useQuery<AppConfig>({ queryKey: ["/api/config"], staleTime: 5 * 60_000 });
  return data ?? null;
}
