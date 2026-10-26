/**
 * Emergency information, by country the PERSON says they are in (never guessed from their language, their address or their device).
 *
 * Nothing here is invented. Each country lists the numbers, the sources they were taken from and when, and what could not be
 * confirmed. A number is shown to the public in a production deployment only after a PERSON has reviewed it against the
 * sources (see `reviewedBy`, or EMERGENCY_DATA_REVIEWED_BY in the environment); until then Avela says it has no reviewed
 * information and tells the person to use their local emergency number. To change a number, edit this file and have it
 * reviewed: no other code changes.
 *
 * Avela is not an emergency service and calling from the app does not contact anyone: the phone dials the number.
 */
export type CountryCode = "EG" | "US";
export const SUPPORTED_COUNTRIES: CountryCode[] = ["EG", "US"];

export type ServiceKind = "all" | "ambulance" | "police" | "fire";
export interface EmergencyService { kind: ServiceKind; number: string }
export interface EmergencySource { title: string; url: string; checkedOn: string; official: "government" | "government_compilation" }
export interface CountryEmergency {
  services: EmergencyService[];
  /** The one number the interface offers first for a medical emergency. */
  primary: ServiceKind;
  sources: EmergencySource[];
  /** Keys of the plain-language notes about what could and could not be confirmed (translated in the interface). */
  caveats: string[];
  /** The person who compared these numbers with the sources. Null until someone has. */
  reviewedBy: string | null;
  reviewedOn: string | null;
}

export const EMERGENCY_DATA_VERSION = "2026-10-26";

export const EMERGENCY: Record<CountryCode, CountryEmergency> = {
  US: {
    services: [{ kind: "all", number: "911" }],
    primary: "all",
    sources: [
      { title: "Federal Communications Commission: 911 and E911 Services", url: "https://www.fcc.gov/general/9-1-1-and-e9-1-1-services", checkedOn: "2026-10-26", official: "government" },
      { title: "911.gov: Frequently asked questions about calling 911", url: "https://www.911.gov/calling-911/frequently-asked-questions/", checkedOn: "2026-10-26", official: "government" },
    ],
    caveats: ["emi.caveat.US.1", "emi.caveat.US.2"],
    reviewedBy: null,
    reviewedOn: null,
  },
  EG: {
    services: [
      { kind: "ambulance", number: "123" },
      { kind: "police", number: "122" },
      { kind: "fire", number: "180" },
    ],
    primary: "ambulance",
    sources: [
      { title: "CIA World Factbook, Egypt: travel facts (compiled from U.S. Department of State travel information)", url: "https://www.cia.gov/the-world-factbook/countries/egypt/travel-facts", checkedOn: "2026-10-26", official: "government_compilation" },
    ],
    caveats: ["emi.caveat.EG.1", "emi.caveat.EG.2"],
    reviewedBy: null,
    reviewedOn: null,
  },
};

export const isCountry = (v: unknown): v is CountryCode => v === "EG" || v === "US";
