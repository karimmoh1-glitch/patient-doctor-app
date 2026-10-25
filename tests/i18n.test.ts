import { describe, it, expect } from "vitest";
import { translate } from "../client/src/lib/i18n";
import { en } from "../client/src/locales/en";
import { ar } from "../client/src/locales/ar";
import { LOCALES } from "../client/src/locales";
import common from "../client/src/locales/en/common";
import landing from "../client/src/locales/en/landing";
import auth from "../client/src/locales/en/auth";
import patient from "../client/src/locales/en/patient";
import health from "../client/src/locales/en/health";
import doctor from "../client/src/locales/en/doctor";
import admin from "../client/src/locales/en/admin";
import rx from "../client/src/locales/en/rx";
import onboarding from "../client/src/locales/en/onboarding";
import shared from "../client/src/locales/en/shared";
import labels from "../client/src/locales/en/labels";
import directory from "../client/src/locales/en/directory";
import legal from "../client/src/locales/en/legal";
import { loadLocale } from "../client/src/lib/i18n";

const placeholders = (s: string) => (s.match(/\{\w+\}/g) ?? []).sort().join(",");

describe("interface translations", () => {
  it("keeps each key in exactly one English namespace file", () => {
    const seen = new Map<string, string>();
    const files = { common, landing, auth, patient, health, doctor, admin, rx, onboarding, shared, labels, directory, legal };
    for (const [name, dict] of Object.entries(files)) {
      for (const key of Object.keys(dict)) {
        expect(seen.has(key), `"${key}" is defined in both ${seen.get(key)} and ${name}`).toBe(false);
        seen.set(key, name);
      }
    }
  });

  it("never has an empty English string", () => {
    for (const [key, text] of Object.entries(en)) expect((text as string).trim().length, key).toBeGreaterThan(0);
  });

  it("has no Arabic key that doesn't exist in English (a typo would silently never show)", () => {
    for (const key of Object.keys(ar)) expect(key in en, `ar has unknown key "${key}"`).toBe(true);
  });

  it("keeps every placeholder in every Arabic string", () => {
    for (const [key, text] of Object.entries(ar)) {
      const wanted = placeholders((en as Record<string, string>)[key]);
      const got = placeholders(text as string);
      // Arabic's "one", "two" and "zero" plural forms say the number in words ("إشعار واحد"), so they may omit {count}.
      const spelledOut = /_(zero|one|two)$/.test(key) && got === "" && wanted === "{count}";
      expect(spelledOut || got === wanted, `${key} changed its placeholders`).toBe(true);
    }
  });

  it("covers every key that is read at the top of every screen in Arabic", () => {
    const required = Object.keys(common);
    const missing = required.filter((k) => !(k in ar));
    expect(missing, `Arabic is missing common keys: ${missing.join(", ")}`).toEqual([]);
  });

  it("fills in values and falls back to English for anything untranslated", async () => {
    await loadLocale("ar");
    expect(translate("en", "emergency.call", { number: "911" })).toBe("Call 911");
    expect(translate("ar", "emergency.call", { number: "911" })).toBe("اتصل بـ 911");
    // A key the Arabic file lacks resolves to the English text, never blank or the raw key.
    const untranslated = Object.keys(en).find((k) => !(k in ar));
    if (untranslated) expect(translate("ar", untranslated as never)).toBe((en as Record<string, string>)[untranslated]);
  });

  it("chooses the right plural form for Arabic (zero, one, two, few, many)", async () => {
    await loadLocale("ar");
    const t = (n: number) => translate("ar", "top.notifications.unread" as never, { count: n });
    expect(t(0)).toContain("لا إشعارات");
    expect(t(1)).toContain("إشعار واحد");
    expect(t(2)).toContain("إشعاران");
    expect(t(5)).toContain("5 إشعارات");
    expect(t(11)).toContain("11 إشعارًا");
    expect(translate("en", "top.notifications.unread" as never, { count: 3 })).toBe("Notifications, 3 unread");
  });

  it("declares Arabic as right-to-left and English as left-to-right", () => {
    expect(LOCALES.find((l) => l.code === "ar")!.dir).toBe("rtl");
    expect(LOCALES.find((l) => l.code === "en")!.dir).toBe("ltr");
  });
});
