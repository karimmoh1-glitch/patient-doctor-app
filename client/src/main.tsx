import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";
import { applyStoredTextSize } from "./hooks/use-text-size";
import { detectInitialLocale, loadLocale } from "./lib/i18n";
import { migrateLegacySession } from "./lib/session";

applyStoredTextSize();

// Fetch the person's saved language first, so an Arabic reader never sees a
// flash of English (and the page direction is right from the first paint).
const root = createRoot(document.getElementById("root")!);
// Move a browser that still holds a session token in storage onto the cookie before anything asks the server for data.
Promise.all([loadLocale(detectInitialLocale()), migrateLegacySession()]).finally(() => root.render(<App />));
