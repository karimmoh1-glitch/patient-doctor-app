import common from "./common";
import landing from "./landing";
import auth from "./auth";
import patient from "./patient";
import health from "./health";
import doctor from "./doctor";
import admin from "./admin";
import rx from "./rx";
import onboarding from "./onboarding";
import shared from "./shared";
import labels from "./labels";
import directory from "./directory";
import legal from "./legal";
import mfa from "./mfa";
import msg from "./msg";
import integrations from "./integrations";

// English is the source of truth and the fallback: a key missing from another
// language shows the English text, never a blank or a raw key. Keep each key
// in exactly one namespace file (tests/i18n.test.ts enforces it).
export const en = { ...common, ...landing, ...auth, ...patient, ...health, ...doctor, ...admin, ...rx, ...onboarding, ...shared, ...labels, ...directory, ...legal, ...mfa, ...msg, ...integrations } as const;
