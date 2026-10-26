import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { newSession, registerDoctorViaApi, approveViaApi, uniqueEmail } from "./helpers";

const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

test("an approved clinician's licence check is recorded with how it was done, and a reviewer can renew or suspend it", async ({ page, browser }) => {
  const name = `Dr. Ledger ${Math.random().toString(36).slice(2, 7)}`;
  const { applicationId } = await registerDoctorViaApi(page, name, uniqueEmail("ledger"));
  await approveViaApi(browser, applicationId);

  const admin = await newSession(browser, "admin@avela.dev");
  await admin.page.goto("/admin/credentials");
  await expect(admin.page.getByRole("heading", { level: 1 })).toHaveText("Licence checks");
  const row = admin.page.getByRole("listitem").filter({ hasText: name }).filter({ hasText: "Licence number" });
  await expect(row).toContainText("Checked");
  await expect(row).toContainText("I read the licence document");

  await row.getByRole("button", { name: /Renew/ }).click();
  const dialog = admin.page.getByRole("dialog");
  await dialog.getByLabel("How was the licence checked?").selectOption("registry_lookup");
  await dialog.getByLabel("What did you check?").fill("Register entry renewed to next year.");
  await dialog.getByRole("button", { name: "Save the check" }).click();
  await expect(admin.page.getByText("Check recorded").first()).toBeVisible();
  await expect(row).toContainText("public register");

  await row.getByRole("button", { name: /Suspend/ }).click();
  await admin.page.getByRole("dialog").getByLabel(/./).first().fill("Board notice received.");
  await admin.page.getByRole("dialog").getByRole("button", { name: "Yes, suspend" }).click();
  await expect(admin.page.getByText("Licence suspended").first()).toBeVisible();
  await expect(row).toContainText("Suspended");
  await admin.context.close();
});

for (const locale of ["en", "ar"] as const) {
  test(`the licence checks screen has no serious accessibility violations (${locale})`, async ({ browser }) => {
    const admin = await newSession(browser, "admin@avela.dev");
    await admin.page.addInitScript((l) => localStorage.setItem("pdapp_locale", l), locale);
    await admin.page.goto("/admin/credentials");
    await admin.page.waitForLoadState("networkidle");
    await expect(admin.page.locator("html")).toHaveAttribute("dir", locale === "ar" ? "rtl" : "ltr");
    const results = await new AxeBuilder({ page: admin.page }).withTags(TAGS).analyze();
    expect(results.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => v.id)).toEqual([]);
    // The language choice is saved on the shared administrator account: put it back so later specs see English.
    await admin.page.request.patch("/api/auth/me/preferences", { headers: { "X-Avela-Client": "web" }, data: { language: "en" } });
    await admin.context.close();
  });
}
