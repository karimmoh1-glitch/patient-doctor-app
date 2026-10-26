import type { ComponentType } from "react";
import { Button } from "@/components/ui/button";
import { useEmergency } from "@/lib/emergency";
import { useI18n, type MessageKey } from "@/lib/i18n";

/**
 * A "call the emergency number" button, only when a number is configured for this deployment. Without one it is plain
 * text telling the person to use their local emergency number: never a button that goes nowhere.
 */
export default function EmergencyAction({
  messageKey,
  icon: Icon,
  className,
  size = "lg",
  iconClassName,
}: {
  messageKey: MessageKey;
  icon: ComponentType<{ className?: string; "aria-hidden"?: "true" }>;
  className?: string;
  size?: "default" | "sm" | "lg";
  iconClassName?: string;
}) {
  const { label, tel } = useEmergency();
  const { t } = useI18n();
  if (!tel) return <p className="text-lg font-semibold">{t(messageKey, { number: label })}</p>;
  return (
    <Button asChild variant="destructive" size={size} className={className}>
      <a href={tel}><Icon className={iconClassName} aria-hidden="true" /> {t(messageKey, { number: label })}</a>
    </Button>
  );
}
