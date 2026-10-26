import { defineConfig, devices } from "@playwright/test";
import { appRoleUrl } from "./tests/fastCommit";

export const E2E_PORT = 3101;
// The seed and the server must agree on the key that protects stored authenticator secrets.
export const E2E_MFA_KEY = Buffer.alloc(32, 5).toString("base64");
export const E2E_DB = process.env.E2E_DATABASE_URL || "postgresql://karimmohamed@localhost:5432/patient_doctor_app_e2e_test";

export default defineConfig({
  testDir: "e2e",
  globalSetup: "./e2e/global-setup.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 45_000,
  expect: { timeout: 8_000 },
  reporter: [["list"]],
  use: {
    baseURL: `http://localhost:${E2E_PORT}`,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    // The primary experience: a mid-range phone, which is what most of our
    // patients will use.
    { name: "phone", use: { ...devices["Pixel 5"] }, testIgnore: /desktop\.spec\.ts/ },
    { name: "desktop", use: { ...devices["Desktop Chrome"] }, testMatch: /desktop\.spec\.ts/ },
  ],
  webServer: {
    command: "npx tsx server/index.ts",
    port: E2E_PORT,
    reuseExistingServer: false,
    timeout: 60_000,
    env: {
      NODE_ENV: "development",
      PORT: String(E2E_PORT),
      DATABASE_URL: E2E_DB,
      // `npm run test:e2e:rls`: the server runs as the restricted database role with row-level security
      // enforced, as it would in production. Seeding and migrations still use DATABASE_URL (the owner).
      ...(process.env.E2E_AS_APP_ROLE === "1" ? { APP_DATABASE_URL: appRoleUrl(E2E_DB), DB_ENFORCE_RLS: "on" } : {}),
      JWT_SECRET: "e2e-only-secret",
      E2E_DISABLE_RATE_LIMITS: "true",
      MFA_ENCRYPTION_KEY: E2E_MFA_KEY,
      MFA_ALLOW_CODE_REUSE: "1", // fixture accounts sign in many times inside one 30-second step; refused by a production server
    },
  },
});
