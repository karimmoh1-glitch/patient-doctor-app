import { useAppConfig } from "@/hooks/use-app-config";
import { useI18n } from "@/lib/i18n";

/**
 * The emergency number is a decision about where this deployment operates, so it is configuration with NO default
 * (server variable EMERGENCY_NUMBER, served by /api/config). Until it is set, every emergency control says "your local
 * emergency number" and offers no dial link, rather than assuming one country's number.
 */
export function useEmergency(): { label: string; tel: string | null } {
  const config = useAppConfig();
  const { t } = useI18n();
  const number = config?.emergencyNumber?.trim() || null;
  return {
    label: number ?? t("emergency.local"),
    tel: number ? `tel:${number.replace(/[^\d+]/g, "")}` : null,
  };
}
