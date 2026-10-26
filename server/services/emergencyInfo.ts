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

/**
 * A country counts as reviewed only when a person has said so for THIS version of the data and for THAT country:
 *   EMERGENCY_DATA_REVIEWED_BY        their name
 *   EMERGENCY_DATA_REVIEWED_VERSION   must equal EMERGENCY_DATA_VERSION (so editing a number un-reviews it)
 *   EMERGENCY_DATA_REVIEWED_COUNTRIES comma-separated, e.g. "US" or "US,EG" (reviewing one country vouches for no other)
 */
export function reviewerFor(code: CountryCode, env: NodeJS.ProcessEnv = process.env): string | null {
  const fromFile = EMERGENCY[code].reviewedBy;
  if (fromFile) return fromFile;
  const by = (env.EMERGENCY_DATA_REVIEWED_BY ?? "").trim();
  if (!by || (env.EMERGENCY_DATA_REVIEWED_VERSION ?? "").trim() !== EMERGENCY_DATA_VERSION) return null;
  const countries = (env.EMERGENCY_DATA_REVIEWED_COUNTRIES ?? "").split(",").map((c) => c.trim().toUpperCase());
  return countries.includes(code) ? by : null;
}

/** Anything that is not clearly a development or test run is treated as production (fail closed). */
export const isProductionLike = (env: NodeJS.ProcessEnv) => env.NODE_ENV !== "development" && env.NODE_ENV !== "test";

export function publicEmergency(env: NodeJS.ProcessEnv = process.env) {
  const production = isProductionLike(env);
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
