import { useState } from "react";
import { Mic, Square, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useMediaRecorder } from "@/hooks/use-media-recorder";
import { apiRequest } from "@/lib/queryClient";

// Captures audio client-side via MediaRecorder and uploads it to the
// server for transcription — transcription never happens in the browser,
// so no speech-provider key ever reaches the client, and every
// transcription goes through the same audited API surface as everything
// else. The transcript is always shown back to the patient to review and
// edit; it never auto-submits.
export default function SymptomVoiceInput({ onTranscribed }: { onTranscribed: (text: string) => void }) {
  const { isRecording, error, start, stop } = useMediaRecorder();
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);

  async function handleStop() {
    const blob = await stop();
    if (!blob) return;
    setIsTranscribing(true);
    setUploadError(null);
    try {
      const formData = new FormData();
      formData.append("audio", blob, "symptom.webm");
      const headers: Record<string, string> = {};
      const stored = localStorage.getItem("pdapp_auth");
      if (stored) {
        const auth = JSON.parse(stored);
        headers.Authorization = `Bearer ${auth.token}`;
      }
      const res = await fetch("/api/speech/transcribe", {
        method: "POST",
        headers,
        body: formData,
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.message || "Transcription failed");
      }
      const data = await res.json();
      onTranscribed(data.text);
    } catch (err: any) {
      setUploadError(err.message || "Transcription failed. Please try typing instead.");
    } finally {
      setIsTranscribing(false);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        {!isRecording ? (
          <Button type="button" variant="outline" size="sm" onClick={start} disabled={isTranscribing}>
            <Mic /> Speak instead
          </Button>
        ) : (
          <Button type="button" variant="destructive" size="sm" onClick={handleStop}>
            <Square /> Stop recording
          </Button>
        )}
        {isTranscribing && (
          <span className="flex items-center gap-1.5 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Transcribing…
          </span>
        )}
      </div>
      {(error || uploadError) && <p className="text-sm text-destructive">{error || uploadError}</p>}
    </div>
  );
}
