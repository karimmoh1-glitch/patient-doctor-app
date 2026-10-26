import { defineConfig, devices } from "@playwright/test";

// Drives a DEPLOYED Avela exactly as a visitor's browser would. It never types a
// password: the signed-in checks use the one-tap demo buttons, which exist only
// on a demonstration deployment (and are a failure to find on a real one), and it
// only reads. Usage:
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
