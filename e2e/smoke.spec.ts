import { test, expect } from "@playwright/test";

test("the landing page tells a visitor what Avela is, who it is for, and where to get emergency help", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Healthcare, closer to you.");
  // No number is assumed: the visitor is asked which country they are in, and nothing is dialled until they say.
  await expect(page.getByRole("link", { name: "Choose your country for emergency numbers" })).toBeVisible();
  const main = page.getByRole("main");
  await expect(main.getByRole("link", { name: "Find a Doctor", exact: true })).toBeVisible();
  await expect(main.getByRole("link", { name: "Join as a Doctor", exact: true })).toBeVisible();
  // Both languages are offered up front.
  await expect(page.getByRole("radio", { name: "English" }).first()).toBeVisible();
  await expect(page.getByRole("radio", { name: "العربية" }).first()).toBeVisible();
  // The two kinds of account are two clear paths.
  await expect(page.getByRole("link", { name: /I'm a Patient/ })).toBeVisible();
  await expect(page.getByRole("link", { name: /I'm a Doctor/ })).toBeVisible();
});

test("browsing doctors needs no account, and connecting says so up front", async ({ page }) => {
  await page.goto("/find-doctors");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Find a doctor");
  await expect(page.getByText(/without an account/).first()).toBeVisible();
  await expect(page.getByRole("heading", { level: 2, name: "Dr. Emily Chen" })).toBeVisible();
  await expect(page.getByRole("link", { name: /Create an account to connect/ }).first()).toBeVisible();
  // Filtering is real: nobody in the fixture list speaks Klingon, but several speak Arabic.
  await page.getByLabel("Language spoken").selectOption("ar");
  await expect(page.getByRole("heading", { level: 2, name: "Dr. Emily Chen" })).toHaveCount(0);
  await expect(page.getByRole("heading", { level: 2, name: "Dr. Fatima Malik" })).toBeVisible();
});

test("every public page names itself in the browser tab, in English and in Arabic", async ({ page }) => {
  const titles: [string, string, string][] = [
    ["/find-doctors", "Find a doctor · Avela", "ابحث عن طبيب · أفيلا"],
    ["/join/doctor", "Apply as a doctor · Avela", "التقديم كطبيب · أفيلا"],
    ["/privacy", "Privacy · Avela", "الخصوصية · أفيلا"],
    ["/get-started", "Get started · Avela", "ابدأ · أفيلا"],
  ];
  for (const [path, en, ar] of titles) {
    await page.goto(path);
    await page.evaluate(() => localStorage.setItem("pdapp_locale", "en"));
    await page.reload();
    await expect(page).toHaveTitle(en);
    await page.evaluate(() => localStorage.setItem("pdapp_locale", "ar"));
    await page.reload();
    await expect(page).toHaveTitle(ar);
    await page.evaluate(() => localStorage.setItem("pdapp_locale", "en"));
  }
});
