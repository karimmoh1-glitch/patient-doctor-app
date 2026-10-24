/**
 * Integration boundary for live video consultations.
 *
 * Avela does NOT have video calling today. This file is where it plugs in
 * once a provider is chosen, contracted and configured — and until then it
 * reports truthfully that video is unavailable, so no screen shows a "Join
 * video" button that goes nowhere.
 *
 * To add a provider (Daily, Twilio Video, Zoom SDK, LiveKit, ...):
 *   1. Implement VideoProvider below in its own file under server/services/video/.
 *   2. Register it in PROVIDERS under the name used by the VIDEO_PROVIDER env var.
 *   3. Sign the provider's BAA/data-processing agreement BEFORE enabling it for
 *      real patients — video of a consultation is health information.
 *   4. Add credentials to the host's environment (never the repo or the browser).
 * See docs/INTEGRATIONS.md for the checklist, costs and privacy implications.
 */
export interface VideoRoom {
  /** URL the participant opens to join. Single-use, short-lived, specific to one person. */
  joinUrl: string;
  expiresAt: Date;
}

export interface VideoProvider {
  readonly name: string;
  /** Creates (or reuses) the room for an appointment and returns a join link for ONE participant. */
  joinRoom(input: { appointmentId: string; participantUserId: string; participantName: string; startsAt: Date; endsAt: Date }): Promise<VideoRoom>;
}

const PROVIDERS: Record<string, () => VideoProvider> = {
  // Intentionally empty: no provider has been implemented or tested.
};

export function getVideoProvider(): VideoProvider | null {
  const name = process.env.VIDEO_PROVIDER;
  if (!name) return null;
  const make = PROVIDERS[name];
  if (!make) {
    // Misconfiguration must be loud, never a silent "video works".
    console.error(`[VIDEO] VIDEO_PROVIDER="${name}" is set but no such provider is implemented. Video is disabled.`);
    return null;
  }
  return make();
}

export function videoAvailable(): boolean {
  return getVideoProvider() !== null;
}
