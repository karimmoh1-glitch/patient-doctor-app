import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";

// Row-level security rests on the application telling the database who is asking (docs/SECURITY.md, "Limits"). Anyone who could
// run arbitrary SQL as the application's role could tell it anything, so the one thing that must never happen is request data
// reaching a SQL string. This fails the build if server code builds SQL by interpolation or concatenation, or uses sql.raw.

const files = (dir: string): string[] =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(path.join(dir, e.name)) : e.name.endsWith(".ts") ? [path.join(dir, e.name)] : []));
const server = files(path.resolve(__dirname, "../server"));

describe("server code never builds SQL from strings", () => {
  it("passes every value as a parameter (no interpolated template, no concatenation, no sql.raw)", () => {
    const offences: string[] = [];
    for (const file of server) {
      const src = fs.readFileSync(file, "utf8");
      const rel = path.relative(path.resolve(__dirname, ".."), file);
      // pool.query(`... ${x} ...`)  /  client.query(`...${x}`)  /  db.execute(`...${x}`) with a plain (non-sql-tagged) template
      // The one deliberate exception: the identity assertion in server/db.ts is inlined (one round trip instead of two). It can only ever
      // contain [A-Za-z0-9._-] (assertionSql and signAssertion both refuse anything else; tests/identityBoundary.test.ts proves it).
      const allowed = (m: string) => rel === path.join("server", "db.ts") && /^BEGIN; \$\{assertionSql\(\w+\)\}$/.test(m);
      for (const m of src.matchAll(/\.(?:query|execute)\(\s*`([^`]*)`/g)) if (/\$\{/.test(m[1]) && !allowed(m[1])) offences.push(`${rel}: interpolated template in a query call`);
      // .query("..." + x)
      for (const m of src.matchAll(/\.(?:query|execute)\(\s*(?:"[^"]*"|'[^']*')\s*\+/g)) offences.push(`${rel}: concatenated query string (${m[0].slice(0, 40)})`);
      if (/\bsql\s*\.\s*raw\s*\(|\bsqlOp\s*\.\s*raw\s*\(/.test(src)) offences.push(`${rel}: sql.raw`);
    }
    expect(offences).toEqual([]);
  });
});
