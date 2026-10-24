// The emergency number is configuration, not a hardcoded assumption about
// where every user is. The app currently serves US states only, so the
// default is 911; a deployment for another country sets VITE_EMERGENCY_NUMBER
// at build time and every emergency control follows.
export const EMERGENCY_NUMBER: string = (import.meta.env.VITE_EMERGENCY_NUMBER as string | undefined)?.trim() || "911";
export const EMERGENCY_TEL = `tel:${EMERGENCY_NUMBER.replace(/[^\d+]/g, "")}`;
