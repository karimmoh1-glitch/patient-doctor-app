import { useState } from "react";
import { Mic, Square, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useMediaRecorder } from "@/hooks/use-media-recorder";
import { useAppConfig } from "@/hooks/use-app-config";
import { CLIENT_HEADERS } from "@/lib/session";
import { useI18n } from "@/lib/i18n";

// Captures audio in the browser and uploads it to the server for transcription
// (never transcribed in the browser, so no speech-provider key reaches the
// client). The transcript always comes back into the text box for the person
// to read and correct; nothing is submitted automatically.
//
// It is only shown when voice is genuinely available. Today that means demo
// mode, where the "transcript" is a fixed sample sentence — said so plainly,
// because inserting made-up text into someone's symptom description without
// saying so would be dangerous.
export default function SymptomVoiceInput({ onTranscribed }: { onTranscribed: (text: string) => void }) {
  const { t } = useI18n();
  const config = useAppConfig();
  const { isRecording, error, start, stop } = useMediaRecorder();
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);

  if (!config?.features.voiceInput) return null;

  async function handleStop() {
    const blob = await stop();
    if (!blob) return;
    setIsTranscribing(true);
    setUploadError(null);
    try {
      const formData = new FormData();
      formData.append("audio", blob, "symptom.webm");
      const res = await fetch("/api/speech/transcribe", { method: "POST", headers: CLIENT_HEADERS, body: formData });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.message || t("pt.voice.failed"));
      }
      const data = await res.json();
      onTranscribed(data.text);
    } catch (err: any) {
      setUploadError(err.message || t("pt.voice.failedType"));
    } finally {
      setIsTranscribing(false);
    }
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-3">
        {!isRecording ? (
          <Button type="button" variant="outline" onClick={start} disabled={isTranscribing}>
            <Mic aria-hidden="true" /> {t("pt.voice.start")}
          </Button>
        ) : (
          <Button type="button" variant="destructive" onClick={handleStop}>
            <Square aria-hidden="true" /> {t("pt.voice.stop")}
          </Button>
        )}
        <span role="status" aria-live="polite" className="text-muted-foreground">
          {isRecording && t("pt.voice.listening")}
          {isTranscribing && (
            <span className="inline-flex items-center gap-2">
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> {t("pt.voice.turning")}
            </span>
          )}
        </span>
      </div>
      {config.features.voiceInputIsDemo && (
        <p className="text-muted-foreground">
          <strong>{t("pt.voice.demoLead")}</strong> {t("pt.voice.demoBody")}
        </p>
      )}
      {(error || uploadError) && <p role="alert" className="font-medium text-destructive">{error || uploadError}</p>}
    </div>
  );
}
