import type { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import crypto from "crypto";
import { storage } from "../storage";
import { isDemoMode } from "../config";

// The insecure fallback secret is only ever allowed in an explicit local
// development or test run. Any other environment — including one where
// NODE_ENV was simply forgotten — refuses to start without a real secret,
// because a known secret lets anyone forge a valid login for any user.
const isLocalDevOrTest = process.env.NODE_ENV === "development" || process.env.NODE_ENV === "test";
if (!isLocalDevOrTest && !process.env.JWT_SECRET) {
  throw new Error(
    "JWT_SECRET must be set. Refusing to start with a known, insecure default secret — anyone could forge valid auth tokens.",
  );
}

const JWT_SECRET = process.env.JWT_SECRET || "dev-secret-change-me";
const JWT_EXPIRY = "24h";

export function signToken(userId: string, role: string, deviceId: string): string {
  return jwt.sign({ userId, role, deviceId }, JWT_SECRET, { expiresIn: JWT_EXPIRY });
}

// Coarse, display-only parsing — never used for security decisions.
// Device identity/trust is entirely the server-generated deviceId below.
function parseUserAgent(ua: string | undefined): { platform: string; browser: string } {
  const s = ua || "";
  let platform = "Unknown";
  if (/iPhone|iPad|iPod/.test(s)) platform = "iOS";
  else if (/Android/.test(s)) platform = "Android";
  else if (/Mac OS X/.test(s)) platform = "macOS";
  else if (/Windows/.test(s)) platform = "Windows";
  else if (/Linux/.test(s)) platform = "Linux";

  let browser = "Unknown";
  if (/Edg\//.test(s)) browser = "Edge";
  else if (/OPR\//.test(s)) browser = "Opera";
  else if (/Chrome\//.test(s)) browser = "Chrome";
  else if (/CriOS\//.test(s)) browser = "Chrome";
  else if (/Firefox\//.test(s)) browser = "Firefox";
  else if (/Safari\//.test(s)) browser = "Safari";

  return { platform, browser };
}

// Mints a new device record for a freshly-issued session. The returned
// deviceId is a random server-generated token embedded in the JWT — never
// derived from the User-Agent, which is only parsed here for a
// human-readable label.
export async function createDeviceForLogin(userId: string, req: Request): Promise<string> {
  const deviceId = crypto.randomBytes(24).toString("hex");
  const { platform, browser } = parseUserAgent(req.headers["user-agent"]);
  await storage.createUserDevice({
    userId,
    deviceId,
    name: `${browser} on ${platform}`,
    platform,
    browser,
    revokedAt: null,
  });
  return deviceId;
}

export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ message: "Authentication required" });
  }
  try {
    const token = authHeader.split(" ")[1];
    const decoded = jwt.verify(token, JWT_SECRET) as { userId: string; role: string; deviceId?: string };

    // Every token this server issues carries a deviceId, so a token without
    // one — or whose device record no longer exists — can't be a live session.
    if (!decoded.deviceId) {
      return res.status(401).json({ message: "Invalid or expired token" });
    }
    const device = await storage.getUserDeviceByDeviceId(decoded.deviceId);
    if (!device || device.userId !== decoded.userId || device.revokedAt) {
      return res.status(401).json({ message: "Your session has ended. Please sign in again." });
    }
    storage.touchUserDevice(decoded.deviceId).catch(() => {});

    // Checked on every request, not just at login, so deactivating a user
    // mid-session cuts their access immediately.
    const user = await storage.getUser(decoded.userId);
    if (!user || user.deactivatedAt) {
      return res.status(401).json({ message: "This account has been deactivated" });
    }
    // Sessions of seeded demo accounts end the moment demo mode is switched off.
    if (user.isDemo && !isDemoMode()) {
      return res.status(401).json({ message: "Your session has ended. Please sign in again." });
    }

    // Role comes from this live lookup, not the JWT claim — the claim is
    // a snapshot from whenever the token was issued and never updates.
    (req as any).userId = decoded.userId;
    (req as any).userRole = user.role;
    (req as any).deviceId = decoded.deviceId || null;
    next();
  } catch {
    return res.status(401).json({ message: "Invalid or expired token" });
  }
}

export function requireRole(...roles: string[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    const role = (req as any).userRole;
    if (!roles.includes(role)) {
      return res.status(403).json({ message: "Access denied" });
    }
    next();
  };
}
