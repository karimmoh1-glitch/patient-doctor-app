import { defineConfig, devices } from "@playwright/test";
import { appRoleUrl } from "./tests/fastCommit";

// Runs the BUILT application (`npm run build` first) exactly as it ships:
// NODE_ENV=production, the production CSP, static bundle served from
// dist/public. The dev-server suite cannot catch bundling or CSP failures
// (a circular chunk split once produced a blank page in production only).
export const PROD_PORT = 3102;
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
      EMERGENCY_NUMBER: "911",
    },
  },
});
