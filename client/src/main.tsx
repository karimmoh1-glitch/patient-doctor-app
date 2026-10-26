import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";
import { applyStoredTextSize } from "./hooks/use-text-size";
import { detectInitialLocale, loadLocale } from "./lib/i18n";
import { migrateLegacySession, retryPendingLogout } from "./lib/session";

applyStoredTextSize();

// Fetch the person's saved language first, so an Arabic reader never sees a
// flash of English (and the page direction is right from the first paint).
const root = createRoot(document.getElementById("root")!);
// Move a browser that still holds a session token in storage onto the cookie before anything asks the server for data.
// A sign-out that never reached the server is finished first, so no live session outlives it (bounded, so it never blocks the page).
const withinTwoSeconds = (p: Promise<unknown>) => Promise.race([p, new Promise((r) => setTimeout(r, 2000))]);
Promise.all([loadLocale(detectInitialLocale()), migrateLegacySession(), withinTwoSeconds(retryPendingLogout())]).finally(() => root.render(<App />));
