import rateLimit, { ipKeyGenerator, type Options } from "express-rate-limit";
import type { Request } from "express";

/**
 * Rate limits are skipped in the automated test suite (which signs up dozens
 * of users from one address) and in the browser end-to-end run, which sets
 * E2E_DISABLE_RATE_LIMITS. Neither switch can take effect in production.
 * A test that wants to exercise a limiter sets TEST_RATE_LIMITS=on.
 */
function shouldSkip(): boolean {
  if (process.env.NODE_ENV === "production") return false;
  if (process.env.NODE_ENV === "test") return process.env.TEST_RATE_LIMITS !== "on";
  return process.env.E2E_DISABLE_RATE_LIMITS === "true";
}

export function makeLimiter(opts: {
  windowMs: number;
  limit: number;
  message: string;
  /** Only count responses that were errors (e.g. failed logins). */
  failuresOnly?: boolean;
  keyGenerator?: Options["keyGenerator"];
}) {
  return rateLimit({
    windowMs: opts.windowMs,
    limit: opts.limit,
    standardHeaders: true,
    legacyHeaders: false,
    message: { message: opts.message },
    skipSuccessfulRequests: opts.failuresOnly ?? false,
    keyGenerator: opts.keyGenerator,
    skip: shouldSkip,
  });
}

/** Key by the email being attacked, so guessing one account's password is capped no matter how many addresses it comes from. */
export function emailKey(req: Request): string {
  const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";
  return email ? `acct:${email}` : `ip:${ipKeyGenerator(req.ip ?? "")}`;
}

/** Key by the signed-in user (requireAuth must run first), for endpoints that notify other people. */
export function userKey(req: Request): string {
  return `user:${(req as any).userId ?? ipKeyGenerator(req.ip ?? "")}`;
}
