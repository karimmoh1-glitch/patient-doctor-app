// Must be imported before any router is created: it patches Express's
// route-registration methods so a rejected promise from an async handler
// reaches the error-handling middleware below via next(err), instead of
// becoming an unhandled rejection that crashes the whole process (Express
// 4 does not do this natively — every async route handler in this app is
// otherwise a single-request-input crash vector for the entire server).
import { assertProductionConfig } from "./config";
import "express-async-errors";
import express, { type Express, type Request, Response, NextFunction } from "express";
import helmet from "helmet";
import { createServer, type Server } from "http";
import { registerRoutes } from "./routes";
import { schedulerSnapshot } from "./services/reminderService";
import { makeLimiter } from "./middleware/rateLimit";

const schedulerMonitorLimiter = makeLimiter({ windowMs: 60_000, limit: 60, message: "Too many checks." });

const isProduction = process.env.NODE_ENV === "production";
const isTest = process.env.NODE_ENV === "test";

export function log(message: string, source = "express") {
  if (isTest) return;
  const formattedTime = new Date().toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });

  console.log(`${formattedTime} [${source}] ${message}`);
}

// Request logs record only method, path, status and duration — never a
// request or response body. A deny-list of "sensitive field names" can never
// be complete (a new field, or a nested one, silently leaks), and bodies here
// include session tokens, symptom text, messages, medications and documents.
export function formatRequestLog(method: string, path: string, status: number, durationMs: number): string {
  return `${method} ${path} ${status} in ${durationMs}ms`;
}

// Database driver errors embed the failing query *and its parameter values*
// (which can be PHI) in their message, so only the error class, code and
// stack frames are logged — not the message text.
export function describeErrorForLog(err: any): string {
  const name = err?.name || "Error";
  const code = err?.code || err?.cause?.code;
  const frames = String(err?.stack || "").split("\n").filter((l) => l.trim().startsWith("at ")).slice(0, 8).join("\n");
  return `${name}${code ? ` [${code}]` : ""}\n${frames}`;
}

// Builds the API portion of the server (security headers, body parsing,
// request logging, all /api routes, and the error handler) with no
// listener and no frontend serving, so integration tests can drive it
// directly through supertest. server/index.ts layers the Vite dev
// middleware / static production serving and the actual listen() on top.
export async function createApiApp(): Promise<{ app: Express; httpServer: Server }> {
  assertProductionConfig();
  const app = express();
  const httpServer = createServer(app);

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
              styleSrc: ["'self'", "'unsafe-inline'"],
              fontSrc: ["'self'"],
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

  // An explicit, small cap on JSON bodies. Every validated input is bounded by
  // this, which is what limits the memory-exhaustion advisory affecting the
  // installed zod 3.x (fixed only in the breaking zod 4 line) — see docs/AUDIT.md.
  // Liveness only: answers without touching the database, so a load balancer
  // can tell "process is up" apart from "database is slow".
  app.get("/api/health", (_req, res) => res.json({ ok: true, commit: process.env.BUILD_COMMIT ?? null, builtAt: process.env.BUILD_TIME ?? null }));
  // For an external uptime monitor: 200 only while the reminder scheduler is really running, 503 otherwise
  // (not configured, stale, or its latest run failed). Reveals a status word and an age, nothing else.
  app.get("/api/health/scheduler", schedulerMonitorLimiter, async (_req, res) => {
    try {
      const { status, minutesSinceSuccess } = await schedulerSnapshot();
      res.status(status === "active" ? 200 : 503).json({ status, minutesSinceSuccess });
    } catch {
      res.status(503).json({ status: "unknown", minutesSinceSuccess: null });
    }
  });

  app.use(express.json({ limit: "100kb" }));
  app.use(express.urlencoded({ extended: false }));

  app.use((req, res, next) => {
    const start = Date.now();
    res.on("finish", () => {
      if (req.path.startsWith("/api")) {
        log(formatRequestLog(req.method, req.path, res.statusCode, Date.now() - start));
      }
    });
    next();
  });

  await registerRoutes(httpServer, app);

  app.use((err: any, _req: Request, res: Response, next: NextFunction) => {
    // Multer's own upload-limit errors (e.g. LIMIT_FILE_SIZE) bypass any
    // route-level try/catch entirely — they're raised by its middleware
    // before the route handler runs — so without this they'd fall through
    // as a generic 500 instead of a message the client can act on.
    if (err?.name === "MulterError") {
      console.error("Upload rejected:", describeErrorForLog(err));
      return res.status(400).json({ message: "File is too large or invalid" });
    }

    const status = err.status || err.statusCode || 500;
    const message = status < 500 && err.message ? err.message : "Internal Server Error";

    if (!isTest || process.env.LOG_TEST_ERRORS) console.error("Internal Server Error:", describeErrorForLog(err));

    if (res.headersSent) {
      return next(err);
    }

    return res.status(status).json({ message });
  });

  return { app, httpServer };
}
