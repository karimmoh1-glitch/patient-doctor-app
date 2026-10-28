import { defineConfig, devices } from "@playwright/test";
import { appRoleUrl } from "./tests/fastCommit";

// Runs the BUILT application (`npm run build` first) exactly as it ships:
// NODE_ENV=production, the production CSP, static bundle served from
// dist/public. The dev-server suite cannot catch bundling or CSP failures
// (a circular chunk split once produced a blank page in production only).
export const PROD_PORT = 3102;
// Key for the stored authenticator secrets in the smoke run (32 bytes, base64): the seed and the server must agree on it.
export const PROD_SMOKE_MFA_KEY = Buffer.alloc(32, 9).toString("base64");
// The signing key a production-mode server needs with the restricted role. Not the development key: a production server refuses that one.
export const PROD_SMOKE_IDENTITY = { kid: "prodsmoke", key: Buffer.alloc(32, 11) };
export const PROD_DB = process.env.PROD_SMOKE_DATABASE_URL || "postgresql://karimmohamed@localhost:5432/patient_doctor_app_prodsmoke_test";

export default defineConfig({
  testDir: "e2e-prod",
  globalSetup: "./e2e-prod/global-setup.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 45_000,
  expect: { timeout: 8_000 },
  reporter: [["list"]],
  use: { baseURL: `http://localhost:${PROD_PORT}`, trace: "retain-on-failure", screenshot: "only-on-failure" },
  projects: [
    { name: "phone", use: { ...devices["Pixel 5"] } },
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
  ],
  webServer: {
    command: "node dist/index.cjs",
    port: PROD_PORT,
    reuseExistingServer: false,
    timeout: 60_000,
    env: {
      NODE_ENV: "production",
      PORT: String(PROD_PORT),
      // A production-safe configuration, as a real deployment must have it (server/config.ts refuses to start otherwise):
      // the owner connection for migrations, the restricted role for requests with row-level security enforced.
      DATABASE_URL: PROD_DB,
      APP_DATABASE_URL: appRoleUrl(PROD_DB),
      DB_ENFORCE_RLS: "on",
      JWT_SECRET: "prod-smoke-only-secret-that-is-long-enough-to-pass",
      APP_URL: "https://smoke.avela.invalid",
      EMERGENCY_DATA_REVIEWED_BY: "Production smoke reviewer", EMERGENCY_DATA_REVIEWED_VERSION: "2026-10-26", EMERGENCY_DATA_REVIEWED_COUNTRIES: "US,EG",
      MFA_ENCRYPTION_KEY: PROD_SMOKE_MFA_KEY,
      IDENTITY_KEY_ID: PROD_SMOKE_IDENTITY.kid,
      IDENTITY_KEY: PROD_SMOKE_IDENTITY.key.toString("base64"),
    },
  },
});
