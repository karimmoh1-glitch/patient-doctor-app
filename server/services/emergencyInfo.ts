import { EMERGENCY, EMERGENCY_DATA_VERSION, SUPPORTED_COUNTRIES, type CountryCode, type EmergencyService, type EmergencySource } from "@shared/emergency";

/**
 * What the public emergency screens are told. In production a country's numbers are served only once a person has reviewed
 * them (data file `reviewedBy`, or EMERGENCY_DATA_REVIEWED_BY set by the operator who did the review); before that the
 * response says "not reviewed" and carries no number, and the interface tells people to use their local emergency number.
 * Outside production the numbers are served marked as unreviewed, so the screens can be built and tested.
 */
export interface PublicCountryEmergency {
  code: CountryCode;
  reviewed: boolean;
  /** Null in production until reviewed. */
  services: EmergencyService[] | null;
  primary: string;
  sources: EmergencySource[];
  caveats: string[];
  reviewedBy: string | null;
  reviewedOn: string | null;
}

export function reviewerFor(code: CountryCode, env: NodeJS.ProcessEnv = process.env): string | null {
  const fromFile = EMERGENCY[code].reviewedBy;
  const fromEnv = (env.EMERGENCY_DATA_REVIEWED_BY ?? "").trim();
  return fromFile || fromEnv || null;
}

export function publicEmergency(env: NodeJS.ProcessEnv = process.env) {
  const production = env.NODE_ENV === "production";
  const countries = {} as Record<CountryCode, PublicCountryEmergency>;
  for (const code of SUPPORTED_COUNTRIES) {
    const data = EMERGENCY[code];
    const reviewedBy = reviewerFor(code, env);
    const reviewed = !!reviewedBy;
    countries[code] = {
      code, reviewed, services: production && !reviewed ? null : data.services, primary: data.primary, sources: data.sources, caveats: data.caveats,
      reviewedBy, reviewedOn: data.reviewedOn,
    };
  }
  return { version: EMERGENCY_DATA_VERSION, countries };
}

/** For the launch checklist: every supported country has been reviewed by a person. */
export function emergencyDataReviewed(env: NodeJS.ProcessEnv = process.env): { ok: boolean; missing: CountryCode[] } {
  const missing = SUPPORTED_COUNTRIES.filter((c) => !reviewerFor(c, env));
  return { ok: missing.length === 0, missing };
}
