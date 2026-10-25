import { defineConfig, devices } from "@playwright/test";

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
      DATABASE_URL: PROD_DB,
      JWT_SECRET: "prod-smoke-only-secret",
      DEMO_MODE: "true",
      APP_URL: `http://localhost:${PROD_PORT}`,
    },
  },
});
