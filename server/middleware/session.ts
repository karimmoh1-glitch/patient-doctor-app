import type { Request, Response } from "express";

/**
 * Browser sessions live in an HttpOnly cookie, not in script-readable storage.
 *
 * Why: a page script (an injected one, a compromised dependency) can read
 * localStorage and send the token anywhere, and the stolen token works from any
 * machine until it expires. A cookie marked HttpOnly cannot be read by script at
 * all. The web app opts in with the header `X-Avela-Client: web`; every other
 * caller (the test suite, scripts, a future mobile app) keeps using a bearer
 * token in the Authorization header, which is never ambient and so needs no CSRF
 * defence.
 *
 * Because browsers attach cookies on their own, a cookie-authenticated request
 * that changes anything must prove it came from our own pages:
 *   1. the cookie is SameSite=Strict (not sent with any cross-site request), and
 *   2. the request carries the custom header `X-Avela-Client: web`, which a
 *      cross-site page cannot add without a CORS preflight we never grant, and
 *   3. if the browser sent an Origin, it must be this site's own host.
 */

export const CLIENT_HEADER = "x-avela-client";
const SESSION_MAX_AGE_MS = 24 * 60 * 60 * 1000; // the same 24 h the token itself lasts
const PLAIN_NAME = "avela_session";
const SECURE_NAME = "__Host-avela_session";

export function isWebClient(req: Request): boolean {
  return req.get(CLIENT_HEADER)?.toLowerCase() === "web";
}

function isHttps(req: Request): boolean {
  return req.secure || req.get("x-forwarded-proto")?.split(",")[0].trim() === "https" || process.env.NODE_ENV === "production";
}

function cookieName(req: Request): string {
  return isHttps(req) ? SECURE_NAME : PLAIN_NAME;
}

export function setSessionCookie(req: Request, res: Response, token: string): void {
  const secure = isHttps(req);
  const attrs = [`${cookieName(req)}=${token}`, "Path=/", "HttpOnly", "SameSite=Strict", `Max-Age=${Math.floor(SESSION_MAX_AGE_MS / 1000)}`];
  if (secure) attrs.push("Secure"); // required by the __Host- prefix
  appendCookie(res, attrs.join("; "));
}

export function clearSessionCookie(req: Request, res: Response): void {
  const attrs = [`${cookieName(req)}=`, "Path=/", "HttpOnly", "SameSite=Strict", "Max-Age=0", "Expires=Thu, 01 Jan 1970 00:00:00 GMT"];
  if (isHttps(req)) attrs.push("Secure");
  appendCookie(res, attrs.join("; "));
}

function appendCookie(res: Response, value: string) {
  const existing = res.getHeader("Set-Cookie");
  res.setHeader("Set-Cookie", existing ? [...(Array.isArray(existing) ? existing : [String(existing)]), value] : value);
}

/** The session token from the request's cookies, if any. Only the name this deployment sets is honoured. */
export function readSessionCookie(req: Request): string | null {
  const header = req.headers.cookie;
  if (!header) return null;
  const wanted = cookieName(req);
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === wanted) {
      const value = part.slice(eq + 1).trim();
      return value || null;
    }
  }
  return null;
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** Whether a cookie-authenticated request may proceed. Reads are always allowed (they change nothing). */
export function cookieRequestAllowed(req: Request): boolean {
  if (SAFE_METHODS.has(req.method)) return true;
  if (!isWebClient(req)) return false;
  const origin = req.get("origin");
  if (origin) {
    let host: string;
    try {
      host = new URL(origin).host;
    } catch {
      return false;
    }
    const mine = req.get("x-forwarded-host")?.split(",")[0].trim() || req.get("host");
    if (host !== mine) return false;
  }
  return true;
}
