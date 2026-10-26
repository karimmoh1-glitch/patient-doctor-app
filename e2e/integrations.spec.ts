import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { newSession } from "./helpers";

const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

test("the integrations screen says what is not set up or not built, and proves nothing it cannot", async ({ browser }) => {
  const admin = await newSession(browser, "admin@avela.dev");
  await admin.page.goto("/admin/integrations");
  await expect(admin.page.getByRole("heading", { level: 1 })).toHaveText("Integrations");
  // A development database has no provider keys: none of these may read as working.
  await expect(admin.page.getByRole("heading", { name: "E-mail sending" })).toBeVisible();
  await expect(admin.page.getByText("Verified", { exact: true })).toHaveCount(0);
  await expect(admin.page.getByText("Not available").first()).toBeVisible();
  await expect(admin.page.getByRole("listitem").filter({ hasText: "Video visits" })).toContainText("Not available");
  await expect(admin.page.getByRole("link", { name: "Integrations" })).toBeVisible();
  await admin.context.close();
});

for (const locale of ["en", "ar"] as const) {
  test(`the integrations screen has no serious accessibility violations (${locale})`, async ({ browser }) => {
    const admin = await newSession(browser, "admin@avela.dev");
    await admin.page.addInitScript((l) => localStorage.setItem("pdapp_locale", l), locale);
    await admin.page.goto("/admin/integrations");
    await admin.page.waitForLoadState("networkidle");
    await expect(admin.page.locator("html")).toHaveAttribute("dir", locale === "ar" ? "rtl" : "ltr");
    const results = await new AxeBuilder({ page: admin.page }).withTags(TAGS).analyze();
    expect(results.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => v.id)).toEqual([]);
    await admin.context.close();
  });
}
