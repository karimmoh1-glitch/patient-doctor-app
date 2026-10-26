import { useState } from "react";
import { useLocation } from "wouter";
import { Phone } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { apiRequest } from "@/lib/queryClient";
import { EMERGENCY_NUMBER, EMERGENCY_TEL } from "@/lib/emergency";
import { useI18n } from "@/lib/i18n";

export default function SymptomEntry() {
  const { t } = useI18n();
  const [, setLocation] = useLocation();
  const [symptomText, setSymptomText] = useState("");
  const [inputMethod, setInputMethod] = useState<"typed" | "voice">("typed");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (symptomText.trim().length < 3) {
      setError(t("pt.symptom.errShort"));
      return;
    }
    setSubmitting(true);
    try {
      const res = await apiRequest("POST", "/api/symptom-reports", { symptomText, inputMethod });
      const data = await res.json();
      setLocation(`/match-results/${data.id}`);
    } catch (err: any) {
      setError(err.message || t("pt.symptom.errSend"));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <section aria-labelledby="urgent" className="rounded-xl border-2 border-destructive bg-card p-4">
        <h2 id="urgent" className="text-lg font-semibold">{t("pt.symptom.emergencyTitle")}</h2>
        <p className="mt-1">
          {t("pt.symptom.emergencyBody")}
        </p>
        <Button asChild variant="destructive" size="lg" className="mt-3 w-full sm:w-auto">
          <a href={EMERGENCY_TEL}><Phone aria-hidden="true" /> {t("emergency.call", { number: EMERGENCY_NUMBER })}</a>
        </Button>
      </section>

      <div>
        <h1 className="text-3xl font-semibold">{t("pt.symptom.title")}</h1>
        <p className="mt-1 text-lg text-muted-foreground">
          {t("pt.symptom.intro")}
        </p>
      </div>

      <form onSubmit={handleSubmit} className="space-y-4" noValidate>
        <div className="space-y-2">
          <Label htmlFor="symptoms" className="text-base">{t("pt.symptom.label")}</Label>
          <Textarea
            id="symptoms"
            value={symptomText}
            onChange={(e) => {
              setSymptomText(e.target.value);
              setInputMethod("typed");
            }}
            placeholder={t("pt.symptom.placeholder")}
            rows={6}
            aria-describedby="symptoms-help symptoms-error"
            aria-invalid={error ? true : undefined}
          />
          <p id="symptoms-help" className="text-muted-foreground">
            {t("pt.symptom.help")}
          </p>
        </div>
        <div id="symptoms-error" aria-live="assertive">
          {error && <p role="alert" className="rounded-lg border-2 border-destructive p-3 font-medium text-destructive">{error}</p>}
        </div>
        <Button type="submit" size="lg" className="w-full sm:w-auto" disabled={submitting}>
          {submitting ? t("pt.symptom.finding") : t("pt.symptom.submit")}
        </Button>
      </form>

      <p className="text-muted-foreground">
        {t("pt.symptom.disclaimer")}
      </p>
    </div>
  );
}
