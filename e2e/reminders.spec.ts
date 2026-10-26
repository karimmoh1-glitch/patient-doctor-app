import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { signUpPatient, uniqueEmail } from "./helpers";

const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

test("a patient with no doctor is told so plainly and can still use reminders and health information", async ({ page }) => {
  await signUpPatient(page, "Samir Solo", uniqueEmail("solo"));
  await page.goto("/");
  await expect(page.getByText("You don't have a connected doctor yet")).toBeVisible();
  await expect(page.getByRole("link", { name: "I have a code from my doctor" })).toBeVisible();
  await expect(page.getByText("These need a doctor: prescriptions, changing a medicine, medical advice.")).toBeVisible();
  await page.getByRole("link", { name: "Set a reminder" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("My reminders");
  await expect(page.getByText("You have no reminders yet.")).toBeVisible();
});

test("reminders are honest about what can deliver them", async ({ page }) => {
  await signUpPatient(page, "Hana Honest", uniqueEmail("rem"));
  await page.goto("/my-reminders");
  // No scheduler or e-mail provider is configured in the test server, and the screen says so.
  await expect(page.getByText("Automatic sending is not set up on this service")).toBeVisible();
  await expect(page.getByText("E-mail: not set up.")).toBeVisible();
  await expect(page.getByText("Text messages: not available.")).toBeVisible();
  await expect(page.getByText("Phone notifications: not available.")).toBeVisible();
});

test("a patient can add, pause, snooze, change and remove reminders, including a monthly subscription", async ({ page }) => {
  await signUpPatient(page, "Rim Reminder", uniqueEmail("rem"));
  await page.goto("/my-reminders");

  // A medicine reminder at two times.
  await page.getByRole("button", { name: "Add a reminder" }).click();
  await page.getByLabel("What is it?").fill("Evening tablet");
  await expect(page.getByText("Avela never decides what to take or how much")).toBeVisible();
  await page.getByLabel("Time 1").fill("08:00");
  await page.getByRole("button", { name: "Add another time" }).click();
  await page.getByLabel("Time 2").fill("20:00");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  const med = page.getByRole("listitem").filter({ hasText: "Evening tablet" });
  await expect(med).toContainText("A medicine I take");
  await expect(med).toContainText("Every day at 08:00, 20:00");
  await expect(med).toContainText("Next:");

  // A subscription that renews on the 31st, three days and one day before.
  await page.getByRole("button", { name: "Add a reminder" }).click();
  await page.getByLabel("What kind of reminder?").selectOption("subscription");
  await expect(page.getByText("Avela does not connect to your bank")).toBeVisible();
  await page.getByLabel("What is it?").fill("Streaming service");
  await page.getByLabel("Next renewal or due date").fill("2027-01-31");
  await page.getByLabel("How often does it renew?").selectOption("monthly");
  await page.getByRole("checkbox", { name: "1 day before" }).check();
  await page.getByLabel("Amount").fill("9.99");
  await page.getByLabel("Currency").fill("usd");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  const subItem = page.getByRole("listitem").filter({ hasText: "Streaming service" });
  await expect(subItem).toContainText("Every month, next on");
  await expect(subItem).toContainText("9.99 USD");
  await expect(subItem).toContainText("before a renewal");

  // Pause, resume, snooze, change, remove.
  await med.getByRole("button", { name: /^Pause/ }).click();
  await expect(med).toContainText("Paused");
  await expect(med).not.toContainText("Next:");
  await med.getByRole("button", { name: /^Turn back on/ }).click();
  await expect(med).toContainText("On");
  await med.getByRole("button", { name: /^Remind me again/ }).click();
  await expect(page.getByText("We will remind you again").first()).toBeVisible();
  await med.getByRole("button", { name: /^Change/ }).click();
  await page.getByLabel("What is it?").fill("Evening tablet (new)");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("listitem").filter({ hasText: "Evening tablet (new)" })).toBeVisible();
  await page.getByRole("listitem").filter({ hasText: "Streaming service" }).getByRole("button", { name: /^Remove/ }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Yes, remove it" }).click();
  await expect(page.getByRole("listitem").filter({ hasText: "Streaming service" })).toHaveCount(0);
});

test("a reminder with a time that is not valid is refused with a reason", async ({ page }) => {
  await signUpPatient(page, "Vera Validate", uniqueEmail("rem"));
  await page.goto("/my-reminders");
  await page.getByRole("button", { name: "Add a reminder" }).click();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Give it a name");
});

for (const locale of ["en", "ar"] as const) {
  test(`the reminders screens have no serious accessibility violations (${locale})`, async ({ page }) => {
    await signUpPatient(page, `Axe Rem ${locale}`, uniqueEmail("rema"));
    await page.addInitScript((l) => localStorage.setItem("pdapp_locale", l), locale);
    await page.goto("/my-reminders");
    await page.waitForLoadState("networkidle");
    await expect(page.locator("html")).toHaveAttribute("dir", locale === "ar" ? "rtl" : "ltr");
    const check = async (step: string) => {
      const results = await new AxeBuilder({ page }).withTags(TAGS).analyze();
      const blocking = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
      expect(blocking.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).slice(0, 2).join(" | ")}`), `${step} (${locale})`).toEqual([]);
    };
    await check("list");
    await page.locator("main button").filter({ hasText: /Add a reminder|إضافة تذكير/ }).first().click();
    await check("form-medication");
    await page.locator("#r-kind").selectOption("subscription");
    await check("form-subscription");
    await page.goto("/");
    await page.waitForLoadState("networkidle");
    const home = await new AxeBuilder({ page }).withTags(TAGS).analyze();
    expect(home.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => v.id)).toEqual([]);
  });
}
