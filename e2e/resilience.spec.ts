import { test, expect } from "@playwright/test";
import { signInAs, newSession, signUpPatient, uniqueEmail } from "./helpers";

test.describe("when things go wrong, the patient is told the truth and can recover", () => {
  test("going offline shows a clear message and a way back — never a blank screen", async ({ page, context }) => {
    await signInAs(page, "patient@avela.dev");
    await expect(page.getByRole("heading", { name: /Good (morning|afternoon|evening)/ })).toBeVisible();

    await context.setOffline(true);

    // A screen that has never been opened needs the network (its code + its data).
    await page.getByRole("navigation", { name: "Main" }).filter({ visible: true }).getByRole("link", { name: /Health/ }).click();
    await expect(page.getByText(/couldn't load this page|offline|No connection/i).first()).toBeVisible();

    await context.setOffline(false);
    await page.getByRole("button", { name: /try again|reload/i }).first().click();
    await expect(page.getByRole("heading", { name: "My health" })).toBeVisible();
  });

  test("a failed data request on an already-open screen offers 'Try again' and recovers", async ({ page, context }) => {
    await signInAs(page, "patient@avela.dev");
    await page.goto("/my-health");
    await expect(page.getByRole("heading", { name: "My health" })).toBeVisible();
    await page.getByRole("link", { name: /Documents/ }).click();
    await expect(page.getByRole("heading", { name: "Documents", level: 1 })).toBeVisible();
    await page.getByRole("link", { name: /^Home$/ }).first().click();

    await context.setOffline(true);
    await page.getByRole("navigation", { name: "Main" }).filter({ visible: true }).getByRole("link", { name: /Doctors/ }).click();
    await expect(page.getByRole("alert").filter({ hasText: /offline|reach the server/i })).toBeVisible();

    await context.setOffline(false);
    await page.getByRole("button", { name: "Try again" }).click();
    await expect(page.getByRole("heading", { name: "My doctors" })).toBeVisible();
    await expect(page.getByText("Dr. Emily Chen").first()).toBeVisible();
  });

  test("a session that ended elsewhere sends the person to sign in, with a plain explanation", async ({ page, browser }) => {
    const { token } = await signInAs(page, "patient@avela.dev");
    await expect(page.getByRole("heading", { name: /Good (morning|afternoon|evening)/ })).toBeVisible();

    // Signed out from another device.
    const other = await browser.newContext();
    const res = await other.request.post("/api/auth/logout", { headers: { Authorization: `Bearer ${token}` }, baseURL: "http://localhost:3101" });
    expect(res.ok()).toBeTruthy();
    await other.close();

    await page.getByRole("navigation", { name: "Main" }).filter({ visible: true }).getByRole("link", { name: /Visits|Appointments/ }).click();
    await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
    await expect(page.getByRole("status").filter({ hasText: "You were signed out" })).toBeVisible();
  });

  test("signing out on a shared phone leaves nothing of the previous person on screen", async ({ page }) => {
    await signInAs(page, "patient@avela.dev");
    await page.goto("/appointments");
    await expect(page.getByText("Two-week follow-up on headaches")).toBeVisible();

    await page.getByRole("button", { name: "Settings" }).click();
    await page.getByRole("button", { name: "Sign out" }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Yes, sign me out" }).click();
    await expect(page.getByRole("link", { name: "Create an account" })).toBeVisible();

    // The next person on the same device.
    await signUpPatient(page, "Dolores Nwosu", uniqueEmail("dolores"));
    await page.goto("/appointments");
    await expect(page.getByRole("heading", { name: "Appointments" })).toBeVisible();
    await expect(page.getByText("Two-week follow-up on headaches")).toHaveCount(0);
    await expect(page.getByText("Dr. Emily Chen")).toHaveCount(0);
    const stored = await page.evaluate(() => localStorage.getItem("pdapp_auth"));
    expect(stored).not.toContain("Margaret");
  });
});

test.describe("large text", () => {
  for (const size of ["large", "xlarge"] as const) {
    test(`at "${size}" text the main screens do not overflow and the key actions stay reachable`, async ({ page }) => {
      await page.addInitScript((s) => localStorage.setItem("pdapp_text_size", s), size);
      await signInAs(page, "patient@avela.dev");
      for (const path of ["/", "/appointments", "/my-health", "/care-team", "/help"]) {
        await page.goto(path);
        await page.waitForLoadState("networkidle");
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        expect(overflow, `${path} scrolls sideways at ${size} text`).toBeLessThanOrEqual(1);
        // Emergency and the four destinations are still on screen.
        await expect(page.getByRole("link", { name: /emergency/i }).first()).toBeVisible();
        const nav = page.getByRole("navigation", { name: "Main" }).filter({ visible: true });
        await expect(nav.getByRole("link")).toHaveCount(4);
        for (const link of await nav.getByRole("link").all()) {
          const box = await link.boundingBox();
          expect(box && box.x >= 0 && box.x + box.width <= (page.viewportSize()?.width ?? 0) + 1, `${path} nav item cut off`).toBeTruthy();
        }
      }
    });
  }

  test("the text size setting is available to a first-time visitor's account and sticks", async ({ page }) => {
    await signInAs(page, "patient@avela.dev");
    await page.getByRole("button", { name: "Settings" }).click();
    await page.getByRole("radio", { name: /Extra large/ }).click();
    const px = await page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).fontSize));
    expect(px).toBeGreaterThan(22);
    await page.reload();
    expect(await page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).fontSize))).toBeGreaterThan(22);
  });
});

test.describe("getting human help", () => {
  test("a patient can find the help page from any screen, and it says exactly what is and isn't staffed", async ({ page }) => {
    await signInAs(page, "patient@avela.dev");
    await page.goto("/my-health");
    await page.getByRole("link", { name: /^help$/i }).click();
    await expect(page.getByRole("heading", { name: "Help", level: 1 })).toBeVisible();
    await expect(page.getByRole("link", { name: /Call 911 now/ })).toBeVisible();
    // No support number is configured in this environment, and the page must not invent one.
    await expect(page.getByText(/has not set up a support phone line or email yet/)).toBeVisible();
    await expect(page.getByRole("link", { name: /tel:|Call support/ })).toHaveCount(0);
    await expect(page.getByText(/not watched around the clock|aren't watched around the clock/)).toBeVisible();
  });
});
