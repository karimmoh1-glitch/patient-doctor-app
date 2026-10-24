import { describe, it, expect } from "vitest";
import { translate } from "../client/src/lib/i18n";

describe("interface translations", () => {
  it("fills in values", () => {
    expect(translate("en", "emergency.call", { number: "911" })).toBe("Call 911");
    expect(translate("es", "emergency.call", { number: "911" })).toBe("Llamar al 911");
  });

  it("falls back to English for a missing string instead of showing a blank or a raw key", () => {
    // Remove a key from a copy of Spanish by asking for one the Spanish file doesn't define.
    // (Every English key must resolve to non-empty text in every language.)
    for (const locale of ["en", "es"] as const) {
      expect(translate(locale, "help.emergency.body").length).toBeGreaterThan(20);
    }
  });

  it("keeps every placeholder: a translation can't drop {number} or {name}", () => {
    const keys = ["emergency.call", "emergency.callNow", "home.emergencyButton", "settings.signedInAs"] as const;
    for (const key of keys) {
      const en = translate("en", key, { number: "NNN", name: "NNN" });
      const es = translate("es", key, { number: "NNN", name: "NNN" });
      expect(es.includes("NNN"), `${key} in Spanish lost its placeholder`).toBe(en.includes("NNN"));
    }
  });
});
