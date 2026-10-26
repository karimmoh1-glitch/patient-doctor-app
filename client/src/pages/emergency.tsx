import { Siren } from "lucide-react";
import EmergencyInfo from "@/components/emergency-info";
import { useI18n } from "@/lib/i18n";

/** Open to everyone, signed in or not: nobody should need an account to be told whom to call. */
export default function EmergencyPage() {
  const { t } = useI18n();
  return (
    <div className="mx-auto max-w-2xl space-y-6 p-4">
      <h1 className="flex items-center gap-3 text-3xl font-semibold text-destructive"><Siren className="h-8 w-8" aria-hidden="true" /> {t("emi.title")}</h1>
      <EmergencyInfo />
    </div>
  );
}
