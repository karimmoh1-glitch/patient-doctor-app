import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { signInAs } from "./helpers";

// Scanning the demo patient in Arabic saves Arabic to that shared account; put it back.
test.afterEach(async ({ request }) => {
  const login = await request.post("/api/auth/login", { data: { email: "patient@avela.dev", password: "DemoPass123!" } });
  const { token } = await login.json();
  await request.patch("/api/auth/me/preferences", { headers: { Authorization: `Bearer ${token}` }, data: { language: "en" } });
});

const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

async function scan(page: import("@playwright/test").Page, label: string) {
  await page.waitForLoadState("networkidle");
  const results = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  const blocking = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  if (results.violations.length) console.log(`[axe] ${label}\n  ` + results.violations.map((v) => `${v.impact}: ${v.id} (${v.nodes.length}) e.g. ${v.nodes[0]?.target.join(" ")}`).join("\n  "));
  expect(blocking.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).slice(0, 2).join(" | ")}`), label).toEqual([]);
}

// Every screen a visitor can reach, in both languages. Axe also checks that
// the page declares the right language and that contrast holds in Arabic.
const PUBLIC = ["/", "/get-started", "/login", "/signup", "/join/doctor", "/find-doctors", "/about", "/privacy", "/terms", "/help", "/forgot-password"];

for (const locale of ["en", "ar"] as const) {
  for (const path of PUBLIC) {
    test(`${path} (${locale}) has no serious accessibility violations`, async ({ page }) => {
      await page.addInitScript((l) => localStorage.setItem("pdapp_locale", l), locale);
      await page.goto(path);
      await expect(page.locator("html")).toHaveAttribute("lang", locale);
      await scan(page, `${path} ${locale}`);
    });
  }
}

test.describe("signed-in screens added in this release", () => {
  for (const locale of ["en", "ar"] as const) {
    test(`patient screens (${locale})`, async ({ page }) => {
      await page.addInitScript((l) => localStorage.setItem("pdapp_locale", l), locale);
      await signInAs(page, "patient@avela.dev");
      for (const path of ["/", "/medications", "/prescriptions", "/doctors", "/notifications", "/welcome"]) {
        await page.goto(path);
        await scan(page, `patient ${path} ${locale}`);
      }
    });
  }
  test("doctor screens, including the prescription form", async ({ page }) => {
    await signInAs(page, "doctor@avela.dev");
    await page.goto("/doctor");
    await scan(page, "doctor home");
    const pairings = await (await page.request.get("/api/pairings/doctor", { headers: { Authorization: `Bearer ${await page.evaluate(() => JSON.parse(localStorage.getItem("pdapp_auth")!).token)}` } })).json();
    const margaret = pairings.find((p: any) => p.patientName === "Margaret Johnson" && p.status === "accepted");
    await page.goto(`/doctor/patients/${margaret.id}`);
    await page.getByRole("tab", { name: "Prescriptions" }).click();
    await page.getByRole("button", { name: "New prescription" }).click();
    // Wait for the dialog's fade-in to finish, or the scan measures half-transparent text.
    await expect(page.getByRole("dialog")).toHaveCSS("opacity", "1");
    await scan(page, "prescription form");
  });
});
