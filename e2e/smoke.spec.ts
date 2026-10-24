import { test, expect } from "@playwright/test";

test("the landing page tells a visitor what to do and where to get emergency help", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Find a doctor");
  await expect(page.getByRole("link", { name: /call 911/i })).toBeVisible();
  await expect(page.getByRole("link", { name: "Create an account" })).toBeVisible();
});
