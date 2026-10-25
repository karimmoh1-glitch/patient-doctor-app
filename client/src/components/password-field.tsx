import { useState } from "react";
import { Input } from "@/components/ui/input";
import { useI18n } from "@/lib/i18n";

/** A password input with a "Show password" checkbox — typing blind on a phone is how people get locked out. */
export default function PasswordField({
  id, value, onChange, autoComplete, describedBy, invalid, minLength,
}: {
  id: string; value: string; onChange: (v: string) => void; autoComplete: "current-password" | "new-password";
  describedBy?: string; invalid?: boolean; minLength?: number;
}) {
  const { t } = useI18n();
  const [visible, setVisible] = useState(false);
  return (
    <div className="space-y-2">
      <Input
        id={id}
        type={visible ? "text" : "password"}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        autoComplete={autoComplete}
        aria-describedby={describedBy}
        aria-invalid={invalid || undefined}
        minLength={minLength}
        required
      />
      <label className="flex min-h-11 cursor-pointer items-center gap-3 text-base">
        <input type="checkbox" className="h-6 w-6" checked={visible} onChange={(e) => setVisible(e.target.checked)} />
        {t("pwfield.show")}
      </label>
    </div>
  );
}
