/**
 * Creates an administrator account (it never changes an existing one).
 * There is no public way to become an administrator, so this is how the first
 * one is provisioned, from a trusted shell:
 *
 *   ADMIN_EMAIL=you@example.org ADMIN_NAME="Your Name" ADMIN_PASSWORD='…' npm run admin:create
 *
 * The password is read from the environment so it never lands in shell history
 * as an argument or in a repository file.
 */
import "dotenv/config";
import "./asOperator";
import bcrypt from "bcryptjs";
import { pool } from "../server/db";
import { storage } from "../server/storage";

async function main() {
  const email = process.env.ADMIN_EMAIL?.trim().toLowerCase();
  const name = process.env.ADMIN_NAME?.trim();
  const password = process.env.ADMIN_PASSWORD;
  if (!email || !name || !password) throw new Error("Set ADMIN_EMAIL, ADMIN_NAME and ADMIN_PASSWORD.");
  if (password.length < 12) throw new Error("ADMIN_PASSWORD must be at least 12 characters.");
  if (await storage.getUserByEmail(email)) throw new Error("An account with that email already exists. Nothing was changed.");

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
