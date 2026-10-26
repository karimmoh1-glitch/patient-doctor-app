// Runs before every test file. Its single most important job is making
// it structurally impossible for the test suite to touch a real database:
// tests create and mutate users, appointments and PHI-shaped rows freely.
process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "test-only-secret-not-used-anywhere-else";
process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL || "postgresql://karimmohamed@localhost:5432/patient_doctor_app_test";

// The test database never needs its commits to survive a power cut, so every test connection asks the
// server not to wait for the disk (synchronous_commit=off). Without this, a busy disk (a build, an
// indexer, a backup) made single COMMITs take seconds and whole runs 10-15x slower; measured and
// reproduced under deliberate disk load, see docs/TESTING.md. This is applied only here, never to the app.
import { fastCommitUrl } from "./fastCommit";
process.env.DATABASE_URL = fastCommitUrl(process.env.DATABASE_URL);

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
