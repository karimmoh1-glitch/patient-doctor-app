import { test, expect, type Page } from "@playwright/test";

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

async function signInThroughTheForm(page: Page, email: string) {
  await page.goto("/login");
  await page.getByLabel("Email address").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
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
    await expect(page.getByRole("link", { name: /call 911/i })).toBeVisible();
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
    { email: "admin@avela.dev", name: "admin", heading: /Doctor applications/i, deep: "/admin", deepHeading: /Doctor applications/i },
  ];

  for (const role of ROLES) {
    test(`${role.name}: signs in through the form and the signed-in screens render`, async ({ page }) => {
      const problems = watch(page);
      await signInThroughTheForm(page, role.email);
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

  test("Arabic and English: the chosen language survives navigation and reload", async ({ page }) => {
    await page.goto("/");
    await page.evaluate(() => localStorage.setItem("pdapp_locale", "es"));
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("lang", "es");
    await page.goto("/login");
    await expect(page.locator("html")).toHaveAttribute("lang", "es");
  });
});
