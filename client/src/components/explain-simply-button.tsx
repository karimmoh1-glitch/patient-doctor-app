import { useState } from "react";
import { Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";

// Restates a doctor's own words in plainer language (POST /api/ai/explain-simply).
// The wording it produces has NOT been reviewed by the doctor, so it is always
// shown as a convenience beside the original, never in place of it, and says so.
export default function ExplainSimplyButton({ text }: { text: string }) {
  const { toast } = useToast();
  const [explanation, setExplanation] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function explain() {
    setLoading(true);
    try {
      const res = await apiRequest("POST", "/api/ai/explain-simply", { text });
      const data = await res.json();
      setExplanation(data.explanation);
    } catch (err: any) {
      toast({ title: "We couldn't make this simpler", description: err.message, variant: "destructive" });
    } finally {
      setLoading(false);
    }
  }

  if (explanation) {
    return (
      <div className="mt-3 rounded-xl border-2 border-input bg-card p-4" role="region" aria-label="Simpler wording">
        <p className="flex items-center gap-2 text-base font-semibold"><Sparkles className="h-4 w-4 text-primary" aria-hidden="true" /> The same thing, in simpler words</p>
        <p className="mt-2 whitespace-pre-wrap text-lg">{explanation}</p>
        <p className="mt-2 text-muted-foreground">Your doctor has not checked these simpler words. If anything is unclear, or different from what you were told, ask your doctor.</p>
      </div>
    );
  }

  return (
    <Button variant="outline" className="mt-3" disabled={loading} onClick={explain}>
      <Sparkles aria-hidden="true" /> {loading ? "Working on it…" : "Say this in simpler words"}
    </Button>
  );
}
