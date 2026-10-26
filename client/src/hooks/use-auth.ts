import { useState, useCallback, useEffect } from "react";
import { parseErrorMessage } from "@/lib/api-error";
import { queryClient, SESSION_EXPIRED_EVENT } from "@/lib/queryClient";
import { CLIENT_HEADERS, clearPendingLogout, readStoredUser, requestLogout, retryPendingLogout, storeUser } from "@/lib/session";
import type { DoctorStatus } from "@shared/languages";

export const SESSION_NOTICE_KEY = "pdapp_session_notice";

export interface AuthUser {
  id: string;
  name: string;
  email: string;
  role: "patient" | "doctor" | "admin" | "caregiver";
  state: string | null;
  /** Interface language the person chose (en | ar). */
  language?: string;
  /** Doctors only: only "approved" unlocks the clinical workspace. */
  doctorStatus?: DoctorStatus;
}

const JSON_HEADERS = { "Content-Type": "application/json", ...CLIENT_HEADERS };

/**
 * Who is signed in. The session itself is an HttpOnly cookie that only the server can read or
 * write; this hook holds just the person's profile summary, so screens can render at once.
 */
export function useAuth() {
  const [auth, setAuth] = useState<AuthUser | null>(() => {
    const stored = readStoredUser<AuthUser>();
    return stored?.id && stored?.role ? stored : null;
  });

  // The server said our token is no longer valid (expired, signed out
  // elsewhere, password reset, account deactivated). Say so — don't leave the
  // person staring at screens that silently fail to load.
  useEffect(() => {
    function onExpired() {
      try {
        sessionStorage.setItem(SESSION_NOTICE_KEY, "expired");
      } catch {
        // Notice is a courtesy; ignore storage failures.
      }
      queryClient.clear();
      setAuth(null);
    }
    window.addEventListener(SESSION_EXPIRED_EVENT, onExpired);
    return () => window.removeEventListener(SESSION_EXPIRED_EVENT, onExpired);
  }, []);

  useEffect(() => {
    storeUser(auth);
  }, [auth]);

  // A sign-out that could not reach the server (offline, tab closed) is finished as soon as it can be.
  useEffect(() => {
    void retryPendingLogout();
    const onOnline = () => void retryPendingLogout();
    window.addEventListener("online", onOnline);
    return () => window.removeEventListener("online", onOnline);
  }, []);

  const persistAuth = useCallback((user: AuthUser) => {
    // Never let the previous person's cached screens show for the next one.
    queryClient.clear();
    clearPendingLogout();
    storeUser(user);
    setAuth(user);
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    const res = await fetch("/api/auth/login", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ email, password }),
    });
    if (!res.ok) {
      throw new Error(await parseErrorMessage(res, "Login failed"));
    }
    const data = await res.json();
    persistAuth(data.user);
    return data.user as AuthUser;
  }, [persistAuth]);

  const demoLogin = useCallback(async (role: "patient" | "doctor") => {
    const res = await fetch("/api/auth/demo-login", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ role }),
    });
    if (!res.ok) throw new Error(await parseErrorMessage(res, "Demo sign-in isn't available"));
    const data = await res.json();
    persistAuth(data.user);
  }, [persistAuth]);

  const signup = useCallback(async (fields: { name: string; email: string; password: string; state: string; phone?: string; language: string }) => {
    const res = await fetch("/api/auth/signup", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify(fields),
    });
    if (!res.ok) {
      throw new Error(await parseErrorMessage(res, "Signup failed"));
    }
    const data = await res.json();
    persistAuth(data.user);
    return data.user as AuthUser;
  }, [persistAuth]);

  // A doctor gets an account straight away but no clinical access until an
  // administrator approves their application.
  const registerDoctor = useCallback(async (fields: { name: string; email: string; password: string; language: string }) => {
    const res = await fetch("/api/doctors/register", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify(fields),
    });
    if (!res.ok) {
      throw new Error(await parseErrorMessage(res, "Registration failed"));
    }
    const data = await res.json();
    persistAuth(data.user);
    return data.user as AuthUser;
  }, [persistAuth]);

  // Re-reads who the server says this person is: how a doctor learns they were
  // approved (or suspended) without signing out and back in.
  const refreshUser = useCallback(async () => {
    const res = await fetch("/api/auth/me", { headers: CLIENT_HEADERS });
    if (!res.ok) return;
    const user = (await res.json()) as AuthUser;
    setAuth((current) => (current ? { ...current, ...user } : current));
  }, []);

  const acceptCareCircleInvite = useCallback(async (inviteToken: string, password: string) => {
    const res = await fetch(`/api/care-circle/invitations/accept/${inviteToken}`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ password }),
    });
    if (!res.ok) {
      throw new Error(await parseErrorMessage(res, "Couldn't accept invitation"));
    }
    const data = await res.json();
    persistAuth(data.user);
    return data.user as AuthUser;
  }, [persistAuth]);

  const signOut = useCallback(() => {
    // End the session on the server (which also clears the cookie, and makes a copied cookie useless).
    // The screen does not wait for the answer; if the request is lost it is retried (see requestLogout).
    void requestLogout();
    queryClient.clear();
    setAuth(null);
    storeUser(null);
  }, []);

  return {
    user: auth,
    isAuthenticated: !!auth,
    login,
    demoLogin,
    signup,
    registerDoctor,
    refreshUser,
    acceptCareCircleInvite,
    signOut,
  };
}
