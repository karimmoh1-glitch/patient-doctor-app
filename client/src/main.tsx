import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";
import { applyStoredTextSize } from "./hooks/use-text-size";

applyStoredTextSize();

createRoot(document.getElementById("root")!).render(<App />);
