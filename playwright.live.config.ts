import { defineConfig, devices } from "@playwright/test";

// Drives a DEPLOYED Avela exactly as a visitor's browser would. It never types a
// password, never creates an account, and only reads: signed-in behaviour is verified
// against a scratch database by the production-build smoke test, not on the live site
// (a test account on a real deployment would be a record it could not clean up). Usage:
//   LIVE_URL=https://avela-taupe.vercel.app EXPECTED_COMMIT=$(git rev-parse HEAD) npm run test:live
const url = process.env.LIVE_URL;
if (!url) throw new Error("Set LIVE_URL to the deployment to check.");

export default defineConfig({
  testDir: "e2e-live",
  fullyParallel: false,
  workers: 1,
  retries: 1, // a cold serverless start can be slow once; a real failure fails twice
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: [["list"]],
  use: { baseURL: url, trace: "retain-on-failure", screenshot: "only-on-failure" },
  projects: [
    { name: "phone", use: { ...devices["Pixel 5"] } },
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
  ],
});
