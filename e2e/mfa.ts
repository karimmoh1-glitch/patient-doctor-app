import { totp } from "../server/lib/totp";
import { FIXTURE_MFA_SECRET } from "../script/fixtures";

// Authenticator secrets for accounts the browser tests create (a fixture account uses the shared, public test secret).
const created = new Map<string, string>();

export const rememberSecret = (email: string, secret: string) => void created.set(email.toLowerCase(), secret);
export const secretFor = (email: string) => created.get(email.toLowerCase()) ?? FIXTURE_MFA_SECRET;
export const codeFor = (email: string) => totp(secretFor(email));
export const codeForSecret = (secret: string) => totp(secret);
