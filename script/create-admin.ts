/**
 * Creates an administrator account (it never changes an existing one).
 * There is no public way to become an administrator: no endpoint creates one, and the database refuses the application's own
 * role the administrator role. This is how the first one is provisioned, from a trusted shell, with the OWNER connection:
 *
 *   ADMIN_EMAIL=you@example.org ADMIN_NAME="Your Name" npm run admin:create
 *
 * The password is asked for at the terminal (typed twice, not echoed), so it never lands in shell history, a process listing or a
 * file. An automated run may supply ADMIN_PASSWORD in the environment instead; do not type that inline in an interactive shell.
 * The second factor is set up by the administrator at their first sign-in. An audit entry records who ran this, where and when
 * (no password, no e-mail address).
 */
import "dotenv/config";
import "./asOperator";
import bcrypt from "bcryptjs";
import { pool } from "../server/db";
import { storage } from "../server/storage";
import { weakPasswordReason } from "../server/lib/password";
import { promptNewSecret } from "./prompt";

async function main() {
  const email = process.env.ADMIN_EMAIL?.trim().toLowerCase();
  const name = process.env.ADMIN_NAME?.trim();
  if (!email || !name) throw new Error("Set ADMIN_EMAIL and ADMIN_NAME.");
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error("ADMIN_EMAIL is not an e-mail address.");
  if (await storage.getUserByEmail(email)) throw new Error("An account with that email already exists. Nothing was changed.");
  const password = process.env.ADMIN_PASSWORD ?? (await promptNewSecret("Password for the new administrator (12+ characters)"));
  if (password.length < 12) throw new Error("The password must be at least 12 characters.");
  const weak = weakPasswordReason(password, { email, name });
  if (weak) throw new Error(weak);

  const created = await storage.createUser({
    name,
    email,
    passwordHash: await bcrypt.hash(password, 12),
    role: "admin",
    state: null,
    phone: null,
    deactivatedAt: null,
    emailVerifiedAt: null,
  });
  // Who made this account, from where, and when: an administrator appearing without a record would be indistinguishable
  // from a planted one. No password, e-mail or secret goes into the entry.
  await pool.query(
    "INSERT INTO audit_logs (action, target_type, target_id, subject_user_id, metadata) VALUES ('admin.bootstrapped', 'user', $1, $1, $2)",
    [created.id, JSON.stringify({ operator: process.env.USER ?? "unknown", host: process.env.HOSTNAME ?? "unknown", via: "npm run admin:create" })],
  );
  console.log(`Administrator created: ${email}. The second factor is set up at the first sign-in.`);
}

main()
  .catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
