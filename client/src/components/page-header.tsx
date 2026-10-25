import { cn } from "@/lib/utils";

/**
 * The title block at the top of a page: one h1, an optional plain-language
 * description, and optional actions that wrap below on a phone. Using this
 * everywhere keeps every screen's hierarchy and spacing the same.
 */
export default function PageHeader({
  title,
  description,
  actions,
  eyebrow,
  className,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  eyebrow?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-wrap items-end justify-between gap-x-6 gap-y-4", className)}>
      <div className="min-w-0 max-w-2xl">
        {eyebrow && <p className="mb-1 text-base font-semibold text-primary">{eyebrow}</p>}
        <h1 className="font-display text-3xl font-semibold leading-tight md:text-4xl">{title}</h1>
        {description && <p className="mt-2 text-lg text-muted-foreground">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-3">{actions}</div>}
    </div>
  );
}
