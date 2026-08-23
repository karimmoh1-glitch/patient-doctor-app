import { useState } from "react";
import { useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import SymptomVoiceInput from "@/components/symptom-voice-input";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";

export default function SymptomEntry() {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const [symptomText, setSymptomText] = useState("");
  const [inputMethod, setInputMethod] = useState<"typed" | "voice">("typed");
  const [submitting, setSubmitting] = useState(false);

  function handleTranscribed(text: string) {
    setSymptomText((prev) => (prev ? `${prev} ${text}` : text));
    setInputMethod("voice");
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (symptomText.trim().length < 3) return;
    setSubmitting(true);
    try {
      const res = await apiRequest("POST", "/api/symptom-reports", { symptomText, inputMethod });
      const data = await res.json();
      setLocation(`/match-results/${data.id}`);
    } catch (err: any) {
      toast({ title: "Couldn't submit", description: err.message, variant: "destructive" });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">What's going on?</h1>
        <p className="text-muted-foreground">
          Describe your symptoms — by typing or speaking. We'll review it and match you with doctors in your state.
        </p>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>Describe your symptoms</CardTitle>
          <CardDescription>You can review and edit before submitting — nothing is sent until you click Continue.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <form onSubmit={handleSubmit} className="space-y-4">
            <Textarea
              value={symptomText}
              onChange={(e) => {
                setSymptomText(e.target.value);
                setInputMethod("typed");
              }}
              placeholder="e.g. I've had a sore throat and fever for two days…"
              rows={5}
              required
            />
            <SymptomVoiceInput onTranscribed={handleTranscribed} />
            <Button type="submit" disabled={submitting || symptomText.trim().length < 3}>
              {submitting ? "Finding doctors…" : "Continue"}
            </Button>
          </form>
        </CardContent>
      </Card>
      <p className="text-xs text-muted-foreground">
        MedConnect is not for medical emergencies. If this is an emergency, call 911 or go to your nearest
        emergency room.
      </p>
    </div>
  );
}
