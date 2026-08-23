// Server-side transcription of symptom-description audio. Raw audio of a
// health symptom description is PHI, and the browser-native Web Speech
// API sends that audio to Google/Apple/Microsoft servers with no BAA
// available — so it is deliberately never used anywhere in this app, even
// for the dev fallback below (a pattern that could otherwise get
// copy-pasted into a production code path later).
//
// Production requires a HIPAA-eligible provider (e.g. AWS Transcribe
// Medical) under a signed BAA — a legal/organizational prerequisite, not
// something this code can complete on its own. See README for the
// non-code compliance follow-ups this depends on.
//
// Audio is transcribed in memory only and never written to disk or the
// database, to minimize the PHI storage surface.

const STT_PROVIDER = process.env.STT_PROVIDER;

export async function transcribe(audioBuffer: Buffer, mimeType: string): Promise<string> {
  // Checked per-call, not at module load: an unconfigured STT_PROVIDER
  // must disable only this one endpoint, never take down the whole server
  // (chat, matching, everything else) just because voice input isn't set
  // up yet. Refusing to silently fall back to a non-BAA transcription
  // service for PHI-bearing audio still holds — it just fails the request
  // that needs it, not the process.
  if (process.env.NODE_ENV === "production" && !STT_PROVIDER) {
    throw new Error(
      "STT_PROVIDER must be set in production before voice symptom input can be used.",
    );
  }

  if (!STT_PROVIDER) {
    // Dev-only mock — zero network calls, clearly logged so it's never
    // mistaken for a real transcription result.
    console.log(`[MOCK STT] Transcribing ${audioBuffer.length} bytes (${mimeType}) with no configured provider.`);
    return "[MOCK STT] Please describe your symptoms — voice transcription is not configured in this environment.";
  }

  if (STT_PROVIDER === "aws-transcribe-medical") {
    throw new Error(
      "STT_PROVIDER=aws-transcribe-medical is selected but the AWS Transcribe Medical " +
      "integration has not been implemented yet. Wire it up here using AWS_ACCESS_KEY_ID / " +
      "AWS_SECRET_ACCESS_KEY / AWS_REGION once a BAA is in place with AWS.",
    );
  }

  throw new Error(`Unknown STT_PROVIDER: ${STT_PROVIDER}`);
}
