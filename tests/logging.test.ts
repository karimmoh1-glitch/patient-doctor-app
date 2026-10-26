import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";

function files(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(path.join(dir, e.name)) : e.name.endsWith(".ts") ? [path.join(dir, e.name)] : []));
}

// Logs go to a hosting provider's dashboard. They must carry counts and error
// kinds, never an error's message or body (which can quote a query, a request,
// or a person's words) and never a raw error object.
describe("server logging", () => {
  const source = files(path.resolve(__dirname, "../server")).filter((f) => !f.endsWith("vite.ts"));

  it("never logs a raw error object or an error's message", () => {
    const offenders: string[] = [];
    for (const file of source) {
      fs.readFileSync(file, "utf8").split("\n").forEach((line, i) => {
        if (!/console\.(log|error|warn|info)\(/.test(line)) return;
        if (/\b(err|error|e)\)\s*;?\s*$/.test(line) || /\.message\b/.test(line)) offenders.push(`${path.relative(process.cwd(), file)}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(offenders).toEqual([]);
  });

  it("writes request logs without bodies, tokens or query strings", async () => {
    const { formatRequestLog } = await import("../server/app");
    const line = formatRequestLog("GET", "/api/documents/abc/file", 200, 12);
    expect(line).toBe("GET /api/documents/abc/file 200 in 12ms");
    // A path carrying a secret in its query is logged without it, by construction: only the path is ever passed.
    expect(formatRequestLog("POST", "/api/auth/login", 401, 5)).not.toMatch(/password|token|@/i);
  });
});
