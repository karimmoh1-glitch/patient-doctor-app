import { useCallback, useState } from "react";

export type TextSize = "normal" | "large" | "xlarge";
const KEY = "pdapp_text_size";
const VALID: TextSize[] = ["normal", "large", "xlarge"];

function read(): TextSize {
  try {
    const v = localStorage.getItem(KEY) as TextSize | null;
    return v && VALID.includes(v) ? v : "normal";
  } catch {
    return "normal";
  }
}

function apply(size: TextSize) {
  if (size === "normal") document.documentElement.removeAttribute("data-text-size");
  else document.documentElement.setAttribute("data-text-size", size);
}

/** Call once before first render so there is no flash of small text. */
export function applyStoredTextSize() {
  apply(read());
}

export function useTextSize() {
  const [size, setSizeState] = useState<TextSize>(read);
  const setSize = useCallback((next: TextSize) => {
    try {
      localStorage.setItem(KEY, next);
    } catch {
      // Private browsing / storage disabled: the choice still applies for this visit.
    }
    apply(next);
    setSizeState(next);
  }, []);
  return { size, setSize };
}
