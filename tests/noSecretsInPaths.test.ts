import { describe, it, expect } from "vitest";
import { ROUTER_MOUNTS } from "../server/routes";

// A request path is written to every request log on the way, the host's included, so no route may take a secret in it. Single-use tokens, codes and
// reset links travel in the request body or in a URL fragment (which a browser never sends).
describe("no secret travels in a URL path", () => {
  it("has no route parameter named like a token, code, secret or key", () => {
    const offenders: string[] = [];
    for (const [prefix, router] of ROUTER_MOUNTS) {
      for (const layer of (router as any).stack ?? []) {
        const path: string | undefined = layer.route?.path;
        if (path && /:(token|code|secret|key|password|otp)\b/i.test(path)) offenders.push(`${prefix}${path}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
