import { test, expect } from "@playwright/test";
import { signInAs } from "./helpers";

test.describe("language", () => {
  test("switching to Spanish changes navigation, emergency and help text, and the page language", async ({ page }) => {
    await signInAs(page, "patient@avela.dev");
    await expect(page.locator("html")).toHaveAttribute("lang", "en");

    await page.getByRole("button", { name: "Settings" }).click();
    await page.getByLabel("Language").selectOption("es");
    await page.keyboard.press("Escape");

    await expect(page.locator("html")).toHaveAttribute("lang", "es");
    await expect(page.getByRole("link", { name: "Emergencia", exact: true })).toBeVisible();
    await expect(page.getByRole("navigation", { name: "Principal" }).first()).toBeVisible();

    await page.goto("/help");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Ayuda");
    await expect(page.getByText("Es una emergencia")).toBeVisible();

    // The choice is remembered on this device.
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("lang", "es");
  });

  test("the sign-in screens keep the emergency strip in the chosen language", async ({ page }) => {
    await page.goto("/login");
    await page.evaluate(() => localStorage.setItem("pdapp_locale", "es"));
    await page.reload();
    await expect(page.getByText("¿Tiene una emergencia?")).toBeVisible();
  });
});
