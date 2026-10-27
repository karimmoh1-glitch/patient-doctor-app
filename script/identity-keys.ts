/**
 * The signing key that lets the database verify who an application transaction is for (migration 0025, docs/IDENTITY_BOUNDARY.md).
 * Run with the OWNER connection, from a trusted shell. No command prints a key.
 *
 *   npm run identity:key -- generate [--kid=k2] [--out=<file>] [--no-register]
 *                                                                 create a new key: register it in the database and write the value the
 *                                                                 application needs (IDENTITY_KEY) to a private file (mode 600).
 *                                                                 --no-register only writes the file (the database does not have the tables yet)
 *   npm run identity:key -- register --from=<file>               register a key generated with --no-register
 *   npm run identity:key -- status                               which keys exist, which are retired, and whether enforcement is on
 *   npm run identity:key -- retire --kid=k1                      stop accepting a key (do this only after the application uses a newer one)
 *   npm run identity:enforce -- on|off                           honour only signed assertions (on) or also the old plain settings (off)
 *
 * Rotation: generate a new key (the database now accepts both), set IDENTITY_KEY_ID/IDENTITY_KEY on the host to the new one and redeploy,
 * confirm requests work, then retire the old key.
 */
import "dotenv/config";
import "./asOperator";
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { pool } from "../server/db";
import { registerIdentityKey, setIdentityEnforcement } from "./lib/identityKeys";

const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);

async function main() {
  const command = process.argv.slice(2).find((a) => !a.startsWith("--"));
  if (command === "generate") {
    const kid = arg("kid") ?? `k${new Date().toISOString().slice(0, 10).replace(/-/g, "")}`;
    if (!/^[a-z0-9_-]{1,32}$/.test(kid)) throw new Error("--kid must be 1-32 characters of a-z, 0-9, _ or -.");
    const register = !process.argv.includes("--no-register");
    if (register) {
      const exists = await pool.query("SELECT 1 FROM app_identity_keys WHERE kid = $1", [kid]);
      if (exists.rowCount) throw new Error(`A key called ${kid} already exists. Nothing was changed.`);
    }
    const key = crypto.randomBytes(32);
    const out = arg("out") ?? path.join(os.homedir(), ".avela-secrets", `identity-${kid}`);
    fs.mkdirSync(path.dirname(out), { recursive: true, mode: 0o700 });
    // Write the file first, with restrictive permissions from the start; register in the database only if that worked.
    fs.writeFileSync(out, `IDENTITY_KEY_ID=${kid}\nIDENTITY_KEY=${key.toString("base64")}\n`, { mode: 0o600, flag: "wx" });
    if (register) {
      await registerIdentityKey(pool, { kid, key });
      await pool.query("INSERT INTO audit_logs (action, target_type, metadata) VALUES ('identity.key_registered', 'system', $1)", [JSON.stringify({ kid, operator: process.env.USER ?? "unknown" })]);
      console.log(`Registered key ${kid} in the database. The value the application needs was written to ${out} (mode 600; not shown).`);
    } else {
      console.log(`Wrote key ${kid} to ${out} (mode 600; not shown). It is NOT registered in the database yet: after the migrations, run \`npm run identity:key -- register --from=${out}\`.`);
    }
    console.log("Next: set IDENTITY_KEY_ID and IDENTITY_KEY on the host from that file (npx vercel env add NAME production --sensitive < file-with-just-the-value), deploy, verify, then `npm run identity:enforce -- on`.");
  } else if (command === "register") {
    const from = arg("from");
    if (!from) throw new Error("--from=<file written by generate> is required");
    const text = fs.readFileSync(from, "utf8");
    const kid = /^IDENTITY_KEY_ID=(.+)$/m.exec(text)?.[1]?.trim();
    const value = /^IDENTITY_KEY=(.+)$/m.exec(text)?.[1]?.trim();
    if (!kid || !value) throw new Error("That file does not hold IDENTITY_KEY_ID and IDENTITY_KEY.");
    const key = Buffer.from(value, "base64");
    if (key.length !== 32) throw new Error("IDENTITY_KEY must be 32 random bytes, base64 encoded.");
    await registerIdentityKey(pool, { kid, key });
    await pool.query("INSERT INTO audit_logs (action, target_type, metadata) VALUES ('identity.key_registered', 'system', $1)", [JSON.stringify({ kid, operator: process.env.USER ?? "unknown" })]);
    console.log(`Registered key ${kid} in the database.`);
  } else if (command === "retire") {
    const kid = arg("kid");
    if (!kid) throw new Error("--kid=<id> is required");
    const live = await pool.query("SELECT count(*)::int AS n FROM app_identity_keys WHERE retired_at IS NULL AND kid <> $1", [kid]);
    if (live.rows[0].n === 0) throw new Error("That is the only active key: retiring it would leave the database accepting no assertion at all.");
    const r = await pool.query("UPDATE app_identity_keys SET retired_at = now() WHERE kid = $1 AND retired_at IS NULL", [kid]);
    if (!r.rowCount) throw new Error("No active key with that id.");
    await pool.query("INSERT INTO audit_logs (action, target_type, metadata) VALUES ('identity.key_retired', 'system', $1)", [JSON.stringify({ kid, operator: process.env.USER ?? "unknown" })]);
    console.log(`Retired ${kid}.`);
  } else if (command === "enforce") {
    const mode = process.argv.slice(2).filter((a) => !a.startsWith("--"))[1];
    if (mode !== "on" && mode !== "off") throw new Error("Say `on` or `off`.");
    const keys = await pool.query("SELECT count(*)::int AS n FROM app_identity_keys WHERE retired_at IS NULL");
    if (mode === "on" && keys.rows[0].n === 0) throw new Error("No active key is registered: enforcing now would make every request anonymous.");
    await setIdentityEnforcement(pool, mode === "on");
    await pool.query("INSERT INTO audit_logs (action, target_type, metadata) VALUES ('identity.enforcement', 'system', $1)", [JSON.stringify({ mode, operator: process.env.USER ?? "unknown" })]);
    console.log(`Identity enforcement is now ${mode}.`);
  } else {
    const { rows } = await pool.query("SELECT kid, created_at, retired_at FROM app_identity_keys ORDER BY created_at");
    const cfg = (await pool.query("SELECT enforce, max_ttl_seconds FROM app_identity_config")).rows[0];
    console.log(`Enforcement: ${cfg?.enforce ? "ON (only signed assertions are honoured)" : "OFF (plain settings are still honoured: roll-out/rollback state)"}; accepted lifetime ${cfg?.max_ttl_seconds}s`);
    for (const r of rows) console.log(`  ${r.kid}  created ${new Date(r.created_at).toISOString()}  ${r.retired_at ? `retired ${new Date(r.retired_at).toISOString()}` : "active"}`);
    if (!rows.length) console.log("  (no keys registered)");
  }
}

main().catch((e) => { console.error(e.message); process.exitCode = 1; }).finally(() => pool.end());
