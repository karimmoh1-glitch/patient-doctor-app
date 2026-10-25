import { Link } from "wouter";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/**
 * The Avela mark: an open doorway (access, "closer to you") with a single
 * warm point inside it (the person being cared for).
 */
export function AvelaMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 64 64" className={cn("h-9 w-9 shrink-0", className)} aria-hidden="true" focusable="false">
      <rect width="64" height="64" rx="16" fill="currentColor" className="text-primary" />
      <path d="M17 47V33a15 15 0 0 1 30 0v14" fill="none" stroke="#FBFAF6" strokeWidth="6" strokeLinecap="round" />
      <circle cx="32" cy="35" r="5" fill="#E0A94F" />
    </svg>
  );
}

export default function Logo({ href = "/", className, textClassName, hideTextOnPhone = false }: { href?: string; className?: string; textClassName?: string; hideTextOnPhone?: boolean }) {
  const { t } = useI18n();
  return (
    <Link href={href} className={cn("inline-flex min-h-12 items-center gap-2.5 rounded-lg", className)} aria-label={t("brand.home")}>
      <AvelaMark />
      <span className={cn("font-display text-2xl font-semibold leading-none text-primary", hideTextOnPhone && "hidden sm:inline", textClassName)}>
        {t("brand.name")}
      </span>
    </Link>
  );
}
