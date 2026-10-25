import { LOCALES, useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/**
 * A two-button language choice that is always visible (no hidden menu), reads
 * each language in its own script, and tells assistive technology which one
 * is active. Changing it re-renders the whole app, including text direction.
 */
export default function LanguageSwitcher({ className, tone = "light" }: { className?: string; tone?: "light" | "plain" }) {
  const { locale, setLocale, t } = useI18n();
  return (
    <div role="radiogroup" aria-label={t("settings.language")} className={cn("inline-flex rounded-full border-2 border-input p-0.5", tone === "light" && "bg-card", className)}>
      {LOCALES.map((l) => (
        <button
          key={l.code}
          type="button"
          role="radio"
          aria-checked={locale === l.code}
          lang={l.code}
          dir={l.dir}
          onClick={() => setLocale(l.code)}
          className={cn(
            "min-h-10 rounded-full px-4 text-base font-semibold transition-colors",
            locale === l.code ? "bg-primary text-primary-foreground" : "text-foreground hover:bg-secondary",
          )}
        >
          {l.label}
        </button>
      ))}
    </div>
  );
}
