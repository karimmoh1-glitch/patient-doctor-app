import { useState, useCallback, useEffect } from "react";
import { parseErrorMessage } from "@/lib/api-error";

export interface AuthUser {
  id: string;
  name: string;
  email: string;
  role: "patient" | "doctor" | "admin";
  state: string | null;
}

interface AuthState {
  token: string;
  user: AuthUser;
}

export function useAuth() {
  const [auth, setAuth] = useState<AuthState | null>(() => {
    const stored = localStorage.getItem("pdapp_auth");
    return stored ? JSON.parse(stored) : null;
  });

  useEffect(() => {
    if (auth) {
      localStorage.setItem("pdapp_auth", JSON.stringify(auth));
    } else {
      localStorage.removeItem("pdapp_auth");
    }
  }, [auth]);

  const persistAuth = useCallback((state: AuthState) => {
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

  const signup = useCallback(async (name: string, email: string, password: string, state: string, phone?: string) => {
    const res = await fetch("/api/auth/signup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, email, password, state, phone }),
    });
    if (!res.ok) {
      throw new Error(await parseErrorMessage(res, "Signup failed"));
    }
    const data = await res.json();
    const authState: AuthState = { token: data.token, user: data.user };
    persistAuth(authState);
    return authState.user;
  }, [persistAuth]);

  const signOut = useCallback(() => {
    setAuth(null);
    localStorage.removeItem("pdapp_auth");
  }, []);

  return {
    user: auth?.user ?? null,
    token: auth?.token ?? null,
    isAuthenticated: !!auth,
    login,
    signup,
    signOut,
  };
}
