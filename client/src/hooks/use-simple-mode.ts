import { useCallback, useEffect, useState } from "react";

const STORAGE_KEY = "pdapp_simple_mode";

export function useSimpleMode() {
  const [simpleMode, setSimpleModeState] = useState<boolean>(() => {
    try {
      return localStorage.getItem(STORAGE_KEY) === "true";
    } catch {
      return false;
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, String(simpleMode));
    } catch {
      // best-effort — a private-browsing tab shouldn't block the toggle from working
    }
  }, [simpleMode]);

  const setSimpleMode = useCallback((value: boolean) => setSimpleModeState(value), []);
  const toggle = useCallback(() => setSimpleModeState((v) => !v), []);

  return { simpleMode, setSimpleMode, toggle };
}
