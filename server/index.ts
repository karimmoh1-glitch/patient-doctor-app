import "dotenv/config";
// Must be imported before any router is created: it patches Express's
// route-registration methods so a rejected promise from an async handler
// reaches the error-handling middleware below via next(err), instead of
// becoming an unhandled rejection that crashes the whole process (Express
// 4 does not do this natively — every async route handler in this app is
// otherwise a single-request-input crash vector for the entire server).
import "express-async-errors";
import express, { type Request, Response, NextFunction } from "express";
import helmet from "helmet";
import { registerRoutes } from "./routes";
import { serveStatic } from "./static";
import { createServer } from "http";

const app = express();
const httpServer = createServer(app);
const isProduction = process.env.NODE_ENV === "production";

if (isProduction) {
  app.set("trust proxy", 1);
}

// CSP is only enforced in production: the dev server injects inline
// scripts for Vite's HMR/React-refresh runtime, which a CSP would block.
app.use(
  helmet({
    contentSecurityPolicy: isProduction
      ? {
          directives: {
            defaultSrc: ["'self'"],
            scriptSrc: ["'self'"],
            styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
            fontSrc: ["'self'", "https://fonts.gstatic.com"],
            imgSrc: ["'self'", "data:", "https:"],
            connectSrc: ["'self'"],
            objectSrc: ["'none'"],
            baseUri: ["'self'"],
            frameAncestors: ["'self'"],
            upgradeInsecureRequests: [],
          },
        }
      : false,
    crossOriginEmbedderPolicy: false,
  }),
);

app.use(express.json());
app.use(express.urlencoded({ extended: false }));

export function log(message: string, source = "express") {
  const formattedTime = new Date().toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });

  console.log(`${formattedTime} [${source}] ${message}`);
}

// Fields that must never reach a plaintext server log — symptom text and
// phone numbers are PHI/PII. This app must not do the naive thing of
// logging full response bodies unconditionally.
const REDACTED_RESPONSE_FIELDS = new Set(["symptomText", "phone", "email", "body"]);

function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      out[key] = REDACTED_RESPONSE_FIELDS.has(key) ? "[redacted]" : redact(val);
    }
    return out;
  }
  return value;
}

app.use((req, res, next) => {
  const start = Date.now();
  const path = req.path;
  let capturedJsonResponse: Record<string, any> | undefined = undefined;

  const originalResJson = res.json;
  res.json = function (bodyJson, ...args) {
    capturedJsonResponse = bodyJson;
    return originalResJson.apply(res, [bodyJson, ...args]);
  };

  res.on("finish", () => {
    const duration = Date.now() - start;
    if (path.startsWith("/api")) {
      let logLine = `${req.method} ${path} ${res.statusCode} in ${duration}ms`;
      if (capturedJsonResponse) {
        logLine += ` :: ${JSON.stringify(redact(capturedJsonResponse))}`;
      }

      log(logLine);
    }
  });

  next();
});

(async () => {
  await registerRoutes(httpServer, app);

  app.use((err: any, _req: Request, res: Response, next: NextFunction) => {
    // Multer's own upload-limit errors (e.g. LIMIT_FILE_SIZE) bypass any
    // route-level try/catch entirely — they're raised by its middleware
    // before the route handler runs — so without this they'd fall through
    // as a generic 500 instead of a message the client can act on.
    if (err?.name === "MulterError") {
      console.error("Upload rejected:", err);
      return res.status(400).json({ message: "File is too large or invalid" });
    }

    const status = err.status || err.statusCode || 500;
    const message = status < 500 && err.message ? err.message : "Internal Server Error";

    console.error("Internal Server Error:", err);

    if (res.headersSent) {
      return next(err);
    }

    return res.status(status).json({ message });
  });

  if (process.env.NODE_ENV === "production") {
    serveStatic(app);
  } else {
    const { setupVite } = await import("./vite");
    await setupVite(httpServer, app);

    const fspath = await import("path");
    const fsmod = await import("fs");
    const { nanoid } = await import("nanoid");

    // Fallback for root and other non-API routes that Vite might miss in
    // some Express versions.
    app.get("*", async (req, res, next) => {
      if (req.path.startsWith("/api") || req.path.startsWith("/@") || req.path.includes(".")) {
        return next();
      }
      try {
        const clientTemplate = fspath.resolve(import.meta.dirname, "..", "client", "index.html");
        let template = await fsmod.promises.readFile(clientTemplate, "utf-8");
        template = template.replace(
          `<head>`,
          `<head><script type="module">
import RefreshRuntime from "/@react-refresh"
RefreshRuntime.injectIntoGlobalHook(window)
window.$RefreshReg$ = () => {}
window.$RefreshSig$ = () => (type) => type
window.__vite_plugin_react_preamble_installed__ = true
</script>`
        );
        template = template.replace(`src="/src/main.tsx"`, `src="/src/main.tsx?v=${nanoid()}"`);
        res.status(200).set({ "Content-Type": "text/html" }).end(template);
      } catch (e) {
        next(e);
      }
    });
  }

  const port = parseInt(process.env.PORT || "3001", 10);
  httpServer.listen(
    {
      port,
      host: "0.0.0.0",
    },
    () => {
      log(`serving on port ${port}`);
    },
  );
})();
