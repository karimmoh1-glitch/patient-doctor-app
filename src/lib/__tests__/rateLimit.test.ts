import { describe, it, expect } from "vitest";
import { NextRequest } from "next/server";
import { rateLimit } from "../rateLimit";

function requestFrom(ip: string) {
  return new NextRequest("http://localhost/api/test", {
    headers: { "x-forwarded-for": ip },
  });
}

describe("rateLimit", () => {
  it("allows requests under the limit", () => {
    const req = requestFrom("1.2.3.4");
    for (let i = 0; i < 3; i++) {
      expect(rateLimit(req, "test-under", { limit: 3, windowMs: 60_000 }).allowed).toBe(true);
    }
  });

  it("blocks requests once the limit is exceeded", () => {
    const req = requestFrom("5.6.7.8");
    const routeKey = "test-block";
    for (let i = 0; i < 3; i++) {
      rateLimit(req, routeKey, { limit: 3, windowMs: 60_000 });
    }
    const result = rateLimit(req, routeKey, { limit: 3, windowMs: 60_000 });
    expect(result.allowed).toBe(false);
    expect(result.retryAfterSeconds).toBeGreaterThan(0);
  });

  it("tracks different IPs independently", () => {
    const routeKey = "test-independent";
    const reqA = requestFrom("9.9.9.9");
    const reqB = requestFrom("8.8.8.8");
    rateLimit(reqA, routeKey, { limit: 1, windowMs: 60_000 });
    const blockedA = rateLimit(reqA, routeKey, { limit: 1, windowMs: 60_000 });
    const allowedB = rateLimit(reqB, routeKey, { limit: 1, windowMs: 60_000 });
    expect(blockedA.allowed).toBe(false);
    expect(allowedB.allowed).toBe(true);
  });
});
