import { test, expect } from "@playwright/test";
import { signInAs } from "./helpers";

// Saving a language to the shared fixture patient's account is part of what is
// being tested, so put it back afterwards for every other test.
test.afterEach(async ({ request }) => {
  const login = await request.post("/api/auth/login", { data: { email: "patient@avela.dev", password: "DemoPass123!" } });
  const { token } = await login.json();
  await request.patch("/api/auth/me/preferences", { headers: { Authorization: `Bearer ${token}` }, data: { language: "en" } });
});

test.describe("Arabic and right-to-left", () => {
  test("switching to Arabic changes the language, direction, navigation, emergency and help text, and is remembered", async ({ page }) => {
    await signInAs(page, "patient@avela.dev");
    await expect(page.locator("html")).toHaveAttribute("lang", "en");
    await expect(page.locator("html")).toHaveAttribute("dir", "ltr");

    await page.getByRole("button", { name: "Settings" }).click();
    await page.getByLabel("Language").selectOption("ar");
    await page.keyboard.press("Escape");

    await expect(page.locator("html")).toHaveAttribute("lang", "ar");
    await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
    await expect(page.getByRole("link", { name: "الطوارئ", exact: true })).toBeVisible();
    await expect(page.getByRole("navigation", { name: "القائمة الرئيسية" }).first()).toBeVisible();

    await page.goto("/help");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("المساعدة");
    await expect(page.getByText("إنها حالة طارئة")).toBeVisible();

    // The choice is remembered on this device and saved to the account.
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("lang", "ar");
    const me = await page.request.get("/api/auth/me");
    expect((await me.json()).language).toBe("ar");
  });

  test("the sign-in screens keep the emergency strip in the chosen language", async ({ page }) => {
    await page.goto("/login");
    await page.evaluate(() => localStorage.setItem("pdapp_locale", "ar"));
    await page.reload();
    await expect(page.getByText("هل لديك حالة طارئة؟")).toBeVisible();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("تسجيل الدخول");
  });

  test("the whole signed-in app reads right-to-left with nothing spilling off the screen", async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem("pdapp_locale", "ar"));
    await signInAs(page, "patient@avela.dev");
    for (const path of ["/", "/appointments", "/medications", "/prescriptions", "/care-team", "/my-health", "/doctors", "/notifications", "/profile", "/documents"]) {
      await page.goto(path);
      await page.waitForLoadState("networkidle");
      await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow, `${path} overflows horizontally in Arabic`).toBeLessThanOrEqual(1);
      // The page's own heading is Arabic, not left in English.
      const h1 = await page.getByRole("heading", { level: 1 }).first().innerText();
      expect(h1, `${path} heading`).toMatch(/[\u0600-\u06FF]/);
    }
    // The main navigation sits on the reading-start side (the right) in RTL.
    await page.goto("/");
    const box = await page.getByRole("navigation", { name: "القائمة الرئيسية" }).filter({ visible: true }).first().boundingBox();
    const viewport = page.viewportSize()!;
    if (viewport.width >= 768) expect(box!.x).toBeGreaterThan(viewport.width / 2);
  });

  test("doctors can be found by the language they speak, shown in that language's own script", async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem("pdapp_locale", "ar"));
    await page.goto("/find-doctors");
    await page.getByLabel("اللغة المستخدمة").selectOption("ar");
    const card = page.getByRole("heading", { level: 2, name: "Dr. Fatima Malik" });
    await expect(card).toBeVisible();
    await expect(page.locator("li", { has: card }).getByText("العربية")).toBeVisible();
  });
});
