import type { Key } from "../index";
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
import healthProfile from "./healthProfile";
import pairing from "./pairing";
import reminders from "./reminders";
import org from "./org";

// Arabic. Loaded on demand, so English readers never download it. Anything
// not translated yet falls back to English. These are first-draft translations
// that need review by a fluent speaker (and a clinician for medical wording)
// before anyone relies on them: see docs/SAFETY_AND_COMPLIANCE.md.
export const ar: Partial<Record<Key, string>> = { ...common, ...landing, ...auth, ...patient, ...health, ...doctor, ...admin, ...rx, ...onboarding, ...shared, ...labels, ...directory, ...legal, ...mfa, ...msg, ...integrations, ...healthProfile, ...pairing, ...reminders, ...org };
