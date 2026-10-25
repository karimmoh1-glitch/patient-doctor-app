import { Label } from "@/components/ui/label";
import { useI18n } from "@/lib/i18n";

/**
 * One consistent way to lay out a form control: a visible label (never just a
 * placeholder), optional plain-language hint, and an error that is announced
 * and tied to the control. The control is rendered through `children` so it
 * receives the right aria attributes.
 */
export function Field({
  id, label, hint, error, optional, children,
}: {
  id: string;
  label: React.ReactNode;
  hint?: React.ReactNode;
  error?: string | null;
  optional?: boolean;
  children: (aria: { id: string; "aria-describedby"?: string; "aria-invalid"?: true }) => React.ReactNode;
}) {
  const { t } = useI18n();
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(" ") || undefined;
  return (
    <div className="space-y-2">
      <Label htmlFor={id} className="text-base font-semibold">
        {label}
        {optional && <span className="ms-2 font-normal text-muted-foreground">{t("common.optional")}</span>}
      </Label>
      {children({ id, "aria-describedby": describedBy, "aria-invalid": error ? true : undefined })}
      {hint && <p id={hintId} className="text-base text-muted-foreground">{hint}</p>}
      {error && <p id={errorId} role="alert" className="font-medium text-destructive">{error}</p>}
    </div>
  );
}

/** A group of related checkboxes (languages, ways to be seen) with one legend. */
export function CheckGroup<T extends string>({
  legend, hint, error, options, value, onChange,
}: {
  legend: string;
  hint?: string;
  error?: string | null;
  options: { value: T; label: string; lang?: string }[];
  value: T[];
  onChange: (next: T[]) => void;
}) {
  return (
    <fieldset className="space-y-2" aria-describedby={error ? "group-error" : undefined}>
      <legend className="text-base font-semibold">{legend}</legend>
      {hint && <p className="text-base text-muted-foreground">{hint}</p>}
      <div className="grid gap-x-4 sm:grid-cols-2">
        {options.map((o) => (
          <label key={o.value} className="flex min-h-12 cursor-pointer items-center gap-3 text-base">
            <input
              type="checkbox"
              className="h-6 w-6 shrink-0 accent-[#0E5A4F]"
              checked={value.includes(o.value)}
              onChange={(e) => onChange(e.target.checked ? [...value, o.value] : value.filter((v) => v !== o.value))}
            />
            <span lang={o.lang}>{o.label}</span>
          </label>
        ))}
      </div>
      {error && <p id="group-error" role="alert" className="font-medium text-destructive">{error}</p>}
    </fieldset>
  );
}
