/**
 * What the browser remembers about being signed in, and what it deliberately does not.
 *
 * The credential is an HttpOnly cookie the server sets: no script on the page can read it, so
 * no script can copy it. Storage keeps only a profile summary of the signed-in person (name,
 * role, language ...) so the right screens can appear at once on reload, with no flash of the
 * signed-out site. It carries no secret, and the server decides what the cookie may do.
 */

export const USER_KEY = "pdapp_user";
/** The old key, which used to hold the session token itself. Only ever read to be migrated away. */
const LEGACY_KEY = "pdapp_auth";

/** Sent on every request: names the web app (the server then uses the cookie) and defeats cross-site forgery. */
export const CLIENT_HEADERS: Record<string, string> = { "X-Avela-Client": "web" };

export function readStoredUser<T = unknown>(): T | null {
  try {
    const stored = localStorage.getItem(USER_KEY);
    return stored ? (JSON.parse(stored) as T) : null;
  } catch {
    return null; // corrupt or blocked storage: start signed out instead of white-screening
  }
}

export function storeUser(user: unknown | null): void {
  try {
    if (user) localStorage.setItem(USER_KEY, JSON.stringify(user));
    else localStorage.removeItem(USER_KEY);
  } catch {
    // Nothing to do: the cookie still works; the next load just asks the server who this is.
  }
}

export function hasStoredSession(): boolean {
  return readStoredUser() !== null;
}

/**
 * One-time move for a browser that signed in before sessions lived in a cookie: trade the old
 * stored token for a cookie, then delete the token from storage. Runs before the app renders so
 * no request goes out without a session. A dead token just signs the person out, as it would have.
 */
export async function migrateLegacySession(): Promise<void> {
  let legacy: { token?: string; user?: unknown } | null = null;
  try {
    const stored = localStorage.getItem(LEGACY_KEY);
    legacy = stored ? JSON.parse(stored) : null;
  } catch {
    legacy = null;
  }
  if (!legacy) return;
  const remove = () => {
    try {
      localStorage.removeItem(LEGACY_KEY);
    } catch {
      // ignore
    }
  };
  if (!legacy.token) return remove();
  try {
    const res = await fetch("/api/auth/session", { method: "POST", headers: { ...CLIENT_HEADERS, Authorization: `Bearer ${legacy.token}` } });
    if (res.ok) {
      const { user } = await res.json();
      storeUser(user);
      remove(); // the token is gone from script-readable storage for good
    } else if (res.status === 401 || res.status === 400) {
      storeUser(null);
      remove();
    }
    // Any other answer (server down): keep it and try again next load.
  } catch {
    // Offline: keep it and try again next load.
  }
}
