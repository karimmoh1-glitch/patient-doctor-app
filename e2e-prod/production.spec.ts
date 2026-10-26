import { test, expect, type Page } from "@playwright/test";
import { totp } from "../server/lib/totp";
import { FIXTURE_MFA_SECRET } from "../script/fixtures";

const PASSWORD = "DemoPass123!";

// Collects everything that should never happen on a healthy page.
function watch(page: Page) {
  const problems: string[] = [];
  page.on("pageerror", (e) => problems.push(`uncaught: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error") problems.push(`console: ${m.text()}`);
  });
  page.on("response", (r) => {
    const url = new URL(r.url());
    if (url.origin !== new URL(page.url() || r.url()).origin && !r.url().startsWith("http://localhost")) return;
    // 401/403 from deliberate probes are expected elsewhere; assets and pages must never fail.
    if (r.status() >= 400 && !url.pathname.startsWith("/api/")) problems.push(`${r.status()} ${url.pathname}`);
    if (r.status() >= 500) problems.push(`${r.status()} ${url.pathname}`);
  });
  return problems;
}

// A production server accepts an authenticator code once, ever. The two browser projects (phone, then desktop) sign the same
// accounts in, so each uses its own time-step: always newer than the other's, always inside the server's one-step tolerance.
async function signInThroughTheForm(page: Page, email: string, project: string) {
  await page.goto("/login");
  await page.getByLabel("Email address").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  // Doctors and administrators are asked for the code from their authenticator app.
  const codeStep = page.getByRole("heading", { name: "Enter your sign-in code" });
  // Either the app moved on (signed in) or the code screen appeared; the page shows neither for a moment while the request runs.
  await expect.poll(async () => (await codeStep.isVisible()) || !/\/login/.test(page.url()), { timeout: 15_000 }).toBe(true);
  if (await codeStep.isVisible()) {
    const offset = project === "phone" ? -1 : 1;
    await page.getByLabel("Six-digit code").fill(totp(FIXTURE_MFA_SECRET, Date.now() + offset * 30_000));
    await page.getByRole("button", { name: "Continue" }).click();
  }
}

test.describe("the built application", () => {
  test("landing page renders real content and every script chunk loads", async ({ page }) => {
    const problems = watch(page);
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expect(page.locator("#root")).not.toBeEmpty();
    const scripts = await page.evaluate(() => [...document.scripts].map((s) => s.src).filter(Boolean));
    expect(scripts.length).toBeGreaterThan(0);
    for (const src of scripts) {
      const res = await page.request.get(src);
      expect(res.status(), src).toBe(200);
    }
    await expect(page.getByRole("link", { name: "Choose your country for emergency numbers" })).toBeVisible();
    expect(problems).toEqual([]);
  });

  test("unknown and nested addresses fall back to the app, not a blank page or a server error", async ({ page }) => {
    const problems = watch(page);
    await page.goto("/definitely/not/a/page");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await page.goto("/login");
    await page.reload();
    await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
    expect(problems).toEqual([]);
  });

  const ROLES: { email: string; name: string; heading: RegExp; deep: string; deepHeading: RegExp }[] = [
    { email: "patient@avela.dev", name: "patient", heading: /Good (morning|afternoon|evening), Margaret/i, deep: "/appointments", deepHeading: /Appointments/i },
    { email: "doctor@avela.dev", name: "doctor", heading: /Good (morning|afternoon|evening), Dr\. Chen/i, deep: "/doctor/availability", deepHeading: /My hours/i },
    { email: "caregiver@avela.dev", name: "caregiver", heading: /Hello, Sarah/i, deep: "/caregiver", deepHeading: /Hello, Sarah/i },
    { email: "admin@avela.dev", name: "admin", heading: /Doctor applications/i, deep: "/admin/activity", deepHeading: /Activity/i },
  ];

  for (const role of ROLES) {
    test(`${role.name}: signs in through the form and the signed-in screens render`, async ({ page }, testInfo) => {
      const problems = watch(page);
      await signInThroughTheForm(page, role.email, testInfo.project.name);
      const h1 = page.getByRole("heading", { level: 1 }).first();
      await expect(page).not.toHaveURL(/\/login/);
      await expect(h1).toHaveText(role.heading);
      await expect(page.locator("#main")).not.toBeEmpty();

      // Direct navigation + refresh on a nested, authenticated route.
      await page.goto(role.deep);
      await page.reload();
      await expect(page.getByRole("heading", { level: 1 }).first()).toHaveText(role.deepHeading);
      expect(problems).toEqual([]);
    });
  }

  test("Arabic: the chosen language survives navigation and reload, and the page turns right-to-left", async ({ page }) => {
    const problems = watch(page);
    await page.goto("/");
    await page.getByRole("radio", { name: "العربية" }).first().click();
    await expect(page.locator("html")).toHaveAttribute("lang", "ar");
    await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("رعاية صحية، أقرب إليك.");
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
    await page.goto("/login");
    await expect(page.locator("html")).toHaveAttribute("lang", "ar");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("تسجيل الدخول");
    expect(problems).toEqual([]);
  });

  test("the self-hosted fonts load under the production content-security policy", async ({ page }) => {
    await page.goto("/");
    await page.evaluate(() => document.fonts.ready);
    const loaded = await page.evaluate(() => [...document.fonts].filter((f) => f.status === "loaded").map((f) => f.family));
    expect(loaded.join(",")).toContain("Fraunces");
    expect(loaded.join(",")).toContain("Figtree");
  });

  test("public pages render in production: doctor search, sign-up choice, privacy", async ({ page }) => {
    const problems = watch(page);
    await page.goto("/find-doctors");
    await expect(page.getByRole("heading", { level: 2, name: "Dr. Emily Chen" })).toBeVisible();
    await page.goto("/get-started");
    await expect(page.getByRole("link", { name: /I'm a Doctor/ })).toBeVisible();
    await page.goto("/privacy");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Privacy");
    expect(problems).toEqual([]);
  });

  test("a new doctor can register and reach only the application in the built app", async ({ page }) => {
    const problems = watch(page);
    const email = `prod-${Date.now().toString(36)}@e2e.example`;
    await page.goto("/join/doctor");
    await page.getByLabel("Your full name").fill("Dr. Prod Smoke");
    await page.getByLabel("Email address").fill(email);
    await page.getByLabel("Choose a password", { exact: true }).fill("seven green umbrellas");
    await page.getByRole("button", { name: "Create my doctor account" }).click();
    // A clinician sets up an authenticator before anything else: read the key from the page, answer with a code, save the recovery codes.
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Set up your sign-in code");
    await expect(page.getByTestId("mfa-secret")).toBeVisible();
    const secret = (await page.getByTestId("mfa-secret").innerText()).replace(/\s/g, "");
    expect(secret).toMatch(/^[A-Z2-7]{32}$/);
    await page.getByLabel("3. Type the six-digit code the app now shows.").fill(totp(secret));
    await page.getByRole("button", { name: "Finish setting up" }).click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Save your recovery codes");
    await expect(page.getByTestId("recovery-codes").getByRole("listitem")).toHaveCount(10);
    await page.getByLabel("I have saved these codes").check();
    await page.getByRole("button", { name: "Continue" }).click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Your application");
    await page.goto("/doctor/requests");
    await expect(page).toHaveURL(/\/doctor\/application/);
    expect(problems).toEqual([]);
  });
});

test.describe("a production server and fixture accounts", () => {
  test("refuses an account still marked as a fixture, and never lists its provider profile", async ({ page, request }) => {
    const login = await request.post("/api/auth/login", { data: { email: "fixture.doctor3@avela.dev", password: PASSWORD } });
    const wrong = await request.post("/api/auth/login", { data: { email: "fixture.doctor3@avela.dev", password: "not-the-password" } });
    expect(login.status()).toBe(401);
    expect(await login.json()).toEqual(await wrong.json());
    const names = (await (await request.get("/api/doctors")).json()).map((d: any) => d.name);
    expect(names.length).toBeGreaterThan(5); // the other, accepted accounts are listed
    expect(names).not.toContain("Dr. Priya Nair"); // the profile of fixture.doctor3
    await page.goto("/login");
    await expect(page.getByRole("button", { name: /demo/i })).toHaveCount(0);
    expect(await (await request.post("/api/auth/demo-login", { data: { role: "patient" } })).status()).not.toBe(200);
    expect(await (await request.get("/api/config")).json()).not.toHaveProperty("demoMode");
  });
});
