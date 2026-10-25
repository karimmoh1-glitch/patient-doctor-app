import { Check } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/**
 * "Step 2 of 4" with the steps named. Done steps carry a tick AND the word
 * "done" for screen readers, so progress never relies on colour alone.
 */
export default function StepProgress({ steps, current }: { steps: string[]; current: number }) {
  const { t } = useI18n();
  return (
    <nav aria-label={t("onb.progress")}>
      <p className="mb-3 text-base font-semibold text-primary">{t("onb.stepOf", { current: current + 1, total: steps.length })}</p>
      <ol className="flex flex-wrap gap-x-5 gap-y-2">
        {steps.map((label, i) => {
          const done = i < current;
          const active = i === current;
          return (
            <li key={label} aria-current={active ? "step" : undefined} className={cn("flex items-center gap-2 text-base", active ? "font-semibold text-foreground" : "text-muted-foreground")}>
              <span className={cn("flex h-7 w-7 items-center justify-center rounded-full border-2 text-sm font-bold", done ? "border-primary bg-primary text-primary-foreground" : active ? "border-primary text-primary" : "border-input")}>
                {done ? <Check className="h-4 w-4" aria-hidden="true" /> : i + 1}
              </span>
              <span>{label}</span>
              {done && <span className="sr-only">{t("onb.done")}</span>}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
