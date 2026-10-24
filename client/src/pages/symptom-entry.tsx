import { useState } from "react";
import { useLocation } from "wouter";
import { Phone } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import SymptomVoiceInput from "@/components/symptom-voice-input";
import { apiRequest } from "@/lib/queryClient";
import { EMERGENCY_NUMBER, EMERGENCY_TEL } from "@/lib/emergency";

export default function SymptomEntry() {
  const [, setLocation] = useLocation();
  const [symptomText, setSymptomText] = useState("");
  const [inputMethod, setInputMethod] = useState<"typed" | "voice">("typed");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function handleTranscribed(text: string) {
    setSymptomText((prev) => (prev ? `${prev} ${text}` : text));
    setInputMethod("voice");
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (symptomText.trim().length < 3) {
      setError("Please tell us a little about what you need help with.");
      return;
    }
    setSubmitting(true);
    try {
      const res = await apiRequest("POST", "/api/symptom-reports", { symptomText, inputMethod });
      const data = await res.json();
      setLocation(`/match-results/${data.id}`);
    } catch (err: any) {
      setError(err.message || "We couldn't send that. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <section aria-labelledby="urgent" className="rounded-xl border-2 border-destructive bg-card p-4">
        <h2 id="urgent" className="text-lg font-semibold">Is this an emergency?</h2>
        <p className="mt-1">
          If you have chest pain, trouble breathing, signs of a stroke (a drooping face, a weak arm, trouble speaking), heavy bleeding, or you may hurt yourself, do not use this page. Call now.
        </p>
        <Button asChild variant="destructive" size="lg" className="mt-3 w-full sm:w-auto">
          <a href={EMERGENCY_TEL}><Phone aria-hidden="true" /> Call {EMERGENCY_NUMBER}</a>
        </Button>
      </section>

      <div>
        <h1 className="text-3xl font-semibold">What do you need help with?</h1>
        <p className="mt-1 text-lg text-muted-foreground">
          Tell us in your own words. We'll show you doctors in your state, starting with those whose work fits best.
        </p>
      </div>

      <form onSubmit={handleSubmit} className="space-y-4" noValidate>
        <div className="space-y-2">
          <Label htmlFor="symptoms" className="text-base">Describe it here</Label>
          <Textarea
            id="symptoms"
            value={symptomText}
            onChange={(e) => {
              setSymptomText(e.target.value);
              setInputMethod("typed");
            }}
            placeholder="For example: I've had a sore throat and a fever for two days."
            rows={6}
            aria-describedby="symptoms-help symptoms-error"
            aria-invalid={error ? true : undefined}
          />
          <p id="symptoms-help" className="text-muted-foreground">
            Nothing is sent until you press the button. The doctors you choose to contact will be able to read what you write here.
          </p>
        </div>
        <SymptomVoiceInput onTranscribed={handleTranscribed} />
        <div id="symptoms-error" aria-live="assertive">
          {error && <p role="alert" className="rounded-lg border-2 border-destructive p-3 font-medium text-destructive">{error}</p>}
        </div>
        <Button type="submit" size="lg" className="w-full sm:w-auto" disabled={submitting}>
          {submitting ? "Finding doctors…" : "Show me doctors"}
        </Button>
      </form>

      <p className="text-muted-foreground">
        This is not medical advice. Choosing a doctor here does not mean anyone has looked at your symptoms yet.
      </p>
    </div>
  );
}
