import { useState } from "react";
import { Link, useLocation } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import PageHeader from "@/components/page-header";
import StepProgress from "@/components/step-progress";
import { Field } from "@/components/form-field";
import { useTextSize, type TextSize } from "@/hooks/use-text-size";
import { apiRequest } from "@/lib/queryClient";
import { useI18n, type MessageKey } from "@/lib/i18n";
import { cn } from "@/lib/utils";

const SIZES: { value: TextSize; key: MessageKey; sample: string }[] = [
  { value: "normal", key: "settings.size.normal", sample: "text-xl" },
  { value: "large", key: "settings.size.large", sample: "text-3xl" },
  { value: "xlarge", key: "settings.size.xlarge", sample: "text-4xl" },
];

// A short, skippable welcome right after sign-up. Nothing here is required;
// every choice can be changed later in Settings or My Health.
export default function Welcome({ name }: { name: string }) {
  const { t } = useI18n();
  const [, setLocation] = useLocation();
  const queryClient = useQueryClient();
  const { size, setSize } = useTextSize();
  const [step, setStep] = useState(0);
  const [contactName, setContactName] = useState("");
  const [contactPhone, setContactPhone] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function saveContact() {
    if (!contactName.trim() && !contactPhone.trim()) return setStep(2);
    setSaving(true);
    setError(null);
    try {
      await apiRequest("PUT", "/api/emergency-profile", { emergencyContactName: contactName.trim() || null, emergencyContactPhone: contactPhone.trim() || null, allergiesText: null, emergencyNotes: null });
      queryClient.invalidateQueries({ queryKey: ["/api/emergency-profile"] });
      setStep(2);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  const steps = [t("welcome.step.comfort"), t("welcome.step.emergency"), t("welcome.step.doctor")];
  return (
    <div className="mx-auto max-w-2xl space-y-8">
      <StepProgress steps={steps} current={step} />
      {step === 0 && (
        <section aria-labelledby="w0" className="space-y-6">
          <PageHeader title={t("welcome.title", { name: name.split(" ")[0] })} description={t("welcome.comfort.intro")} />
          <div role="radiogroup" aria-label={t("settings.textSize")} className="grid grid-cols-3 gap-3">
            {SIZES.map((o) => (
              <button key={o.value} type="button" role="radio" aria-checked={size === o.value} onClick={() => setSize(o.value)}
                className={cn("flex min-h-24 flex-col items-center justify-center rounded-2xl border-2 px-2 py-3", size === o.value ? "border-primary bg-primary text-primary-foreground" : "border-input bg-card hover:bg-secondary")}>
                <span className={cn("font-semibold leading-none", o.sample)} aria-hidden="true">Aa</span>
                <span className="mt-2 text-base">{t(o.key)}</span>
              </button>
            ))}
          </div>
          <div className="flex flex-wrap gap-3">
            <Button size="lg" onClick={() => setStep(1)}>{t("common.continue")}</Button>
          </div>
        </section>
      )}
      {step === 1 && (
        <section aria-labelledby="w1" className="space-y-6">
          <PageHeader title={t("welcome.emergency.title")} description={t("welcome.emergency.why")} />
          <div className="space-y-5">
            <Field id="wc-name" label={t("welcome.emergency.name")} optional>{(a) => <Input {...a} autoComplete="off" value={contactName} onChange={(e) => setContactName(e.target.value)} />}</Field>
            <Field id="wc-phone" label={t("welcome.emergency.phone")} optional>{(a) => <Input {...a} type="tel" dir="ltr" autoComplete="off" value={contactPhone} onChange={(e) => setContactPhone(e.target.value)} />}</Field>
            {error && <p role="alert" className="font-medium text-destructive">{error}</p>}
          </div>
          <div className="flex flex-wrap gap-3">
            <Button size="lg" onClick={saveContact} disabled={saving}>{saving ? t("common.saving") : t("common.continue")}</Button>
            <Button size="lg" variant="outline" onClick={() => setStep(2)}>{t("welcome.skip")}</Button>
          </div>
        </section>
      )}
      {step === 2 && (
        <section aria-labelledby="w2" className="space-y-6">
          <PageHeader title={t("welcome.doctor.title")} description={t("welcome.doctor.body")} />
          <div className="flex flex-col gap-3 sm:flex-row">
            <Button asChild size="lg"><Link href="/symptoms">{t("welcome.doctor.describe")}</Link></Button>
            <Button asChild size="lg" variant="outline"><Link href="/doctors">{t("welcome.doctor.browse")}</Link></Button>
          </div>
          <Button asChild size="lg" variant="outline"><Link href="/health-profile">{t("welcome.healthInfo")}</Link></Button>
          <Button variant="ghost" size="lg" onClick={() => setLocation("/")}>{t("welcome.later")}</Button>
          <p className="text-base text-muted-foreground">{t("welcome.settings")}</p>
        </section>
      )}
    </div>
  );
}
