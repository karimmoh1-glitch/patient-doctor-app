import { useState, useCallback, useEffect } from "react";
import { parseErrorMessage } from "@/lib/api-error";
import { queryClient, SESSION_EXPIRED_EVENT } from "@/lib/queryClient";
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

interface AuthState {
  token: string;
  user: AuthUser;
}

export function useAuth() {
  const [auth, setAuth] = useState<AuthState | null>(() => {
    try {
      const stored = localStorage.getItem("pdapp_auth");
      const parsed = stored ? JSON.parse(stored) : null;
      return parsed?.token && parsed?.user ? parsed : null;
    } catch {
      // Corrupt or inaccessible storage: start signed out instead of white-screening.
      return null;
    }
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
    if (auth) {
      localStorage.setItem("pdapp_auth", JSON.stringify(auth));
    } else {
      localStorage.removeItem("pdapp_auth");
    }
  }, [auth]);

  const persistAuth = useCallback((state: AuthState) => {
    // Never let the previous person's cached screens show for the next one.
    queryClient.clear();
    localStorage.setItem("pdapp_auth", JSON.stringify(state));
    setAuth(state);
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    const res = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    if (!res.ok) {
      throw new Error(await parseErrorMessage(res, "Login failed"));
    }
    const data = await res.json();
    const state: AuthState = { token: data.token, user: data.user };
    persistAuth(state);
    return state.user;
  }, [persistAuth]);

  const demoLogin = useCallback(async (role: "patient" | "doctor") => {
    const res = await fetch("/api/auth/demo-login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role }),
    });
    if (!res.ok) throw new Error(await parseErrorMessage(res, "Demo sign-in isn't available"));
    const data = await res.json();
    persistAuth({ token: data.token, user: data.user });
  }, [persistAuth]);

  const signup = useCallback(async (fields: { name: string; email: string; password: string; state: string; phone?: string; language: string }) => {
    const res = await fetch("/api/auth/signup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(fields),
    });
    if (!res.ok) {
      throw new Error(await parseErrorMessage(res, "Signup failed"));
    }
    const data = await res.json();
    const authState: AuthState = { token: data.token, user: data.user };
    persistAuth(authState);
    return authState.user;
  }, [persistAuth]);

  // A doctor gets an account straight away but no clinical access until an
  // administrator approves their application.
  const registerDoctor = useCallback(async (fields: { name: string; email: string; password: string; language: string }) => {
    const res = await fetch("/api/doctors/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(fields),
    });
    if (!res.ok) {
      throw new Error(await parseErrorMessage(res, "Registration failed"));
    }
    const data = await res.json();
    persistAuth({ token: data.token, user: data.user });
    return data.user as AuthUser;
  }, [persistAuth]);

  // Re-reads who the server says this person is: how a doctor learns they were
  // approved (or suspended) without signing out and back in.
  const refreshUser = useCallback(async () => {
    const stored = localStorage.getItem("pdapp_auth");
    const token = stored ? JSON.parse(stored)?.token : null;
    if (!token) return;
    const res = await fetch("/api/auth/me", { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) return;
    const user = (await res.json()) as AuthUser;
    setAuth((current) => (current ? { ...current, user: { ...current.user, ...user } } : current));
  }, []);

  const acceptCareCircleInvite = useCallback(async (inviteToken: string, password: string) => {
    const res = await fetch(`/api/care-circle/invitations/accept/${inviteToken}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    });
    if (!res.ok) {
      throw new Error(await parseErrorMessage(res, "Couldn't accept invitation"));
    }
    const data = await res.json();
    const state: AuthState = { token: data.token, user: data.user };
    persistAuth(state);
    return state.user;
  }, [persistAuth]);

  const signOut = useCallback(() => {
    // Best-effort: revoke the device server-side so the token can't be
    // reused after sign-out. Local sign-out proceeds regardless — a
    // failed revoke shouldn't trap the user in a logged-in UI.
    if (auth?.token) {
      fetch("/api/auth/logout", {
        method: "POST",
        headers: { Authorization: `Bearer ${auth.token}` },
      }).catch(() => {});
    }
    queryClient.clear();
    setAuth(null);
    localStorage.removeItem("pdapp_auth");
  }, [auth]);

  return {
    user: auth?.user ?? null,
    token: auth?.token ?? null,
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
