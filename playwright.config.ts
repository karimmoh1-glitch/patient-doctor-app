import { defineConfig, devices } from "@playwright/test";

export const E2E_PORT = 3101;
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
      JWT_SECRET: "e2e-only-secret",
      E2E_DISABLE_RATE_LIMITS: "true",
    },
  },
});
