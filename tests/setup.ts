// Runs before every test file. Its single most important job is making
// it structurally impossible for the test suite to touch a real database:
// tests create and mutate users, appointments and PHI-shaped rows freely.
process.env.NODE_ENV = "test";
// Fixture accounts sign in many times inside one 30-second authenticator step; real deployments never allow a code twice (refused in production).
process.env.MFA_ALLOW_CODE_REUSE = "1";
process.env.JWT_SECRET = "test-only-secret-not-used-anywhere-else";
process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL || "postgresql://karimmohamed@localhost:5432/patient_doctor_app_test";

// The test database never needs its commits to survive a power cut, so every test connection asks the
// server not to wait for the disk (synchronous_commit=off). Without this, a busy disk (a build, an
// indexer, a backup) made single COMMITs take seconds and whole runs 10-15x slower; measured and
// reproduced under deliberate disk load, see docs/TESTING.md. This is applied only here, never to the app.
import { appRoleUrl, fastCommitUrl } from "./fastCommit";
import { devIdentityKey } from "../server/identity";
process.env.DATABASE_URL = fastCommitUrl(process.env.DATABASE_URL);
// `npm run test:rls`: the whole suite again, but the application connects as the restricted role with
// row-level security enforced, exactly as it would in production once APP_DATABASE_URL is set.
if (process.env.TEST_AS_APP_ROLE === "1") {
  process.env.APP_DATABASE_URL = appRoleUrl(process.env.DATABASE_URL);
  process.env.DB_ENFORCE_RLS = "on";
  // Some tests flip NODE_ENV to "production" to see how the server behaves there; production never falls back to the development
  // key, so the (publicly known) test key is configured explicitly, as a real deployment would configure its own.
  const dev = devIdentityKey();
  process.env.IDENTITY_KEY_ID = dev.kid;
  process.env.IDENTITY_KEY = dev.key.toString("base64");
}

const dbName = new URL(process.env.DATABASE_URL).pathname.replace(/^\//, "");
if (!dbName.endsWith("_test")) {
  throw new Error(
    `Refusing to run tests against database "${dbName}": the name must end in "_test". ` +
      "Set TEST_DATABASE_URL to a dedicated test database.",
  );
}

// Never send real email or call real providers from tests.
delete process.env.RESEND_API_KEY;
delete process.env.OPENAI_API_KEY;
delete process.env.STT_PROVIDER;

// Optional diagnostics (see tests/stallProbe.ts).
if (process.env.STALL_PROBE) await import("./stallProbe");
