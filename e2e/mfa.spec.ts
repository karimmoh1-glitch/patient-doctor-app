import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { NEW_PASSWORD, PASSWORD, completeAuthenticatorSetup, uniqueEmail, registerDoctorAccountViaApi } from "./helpers";
import { codeFor } from "./mfa";

const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

async function scan(page: Page, label: string) {
  await page.waitForLoadState("networkidle");
  const results = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  const blocking = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(blocking.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).slice(0, 2).join(" | ")}`), label).toEqual([]);
}

async function passwordStep(page: Page, email: string, password = PASSWORD) {
  await page.goto("/login");
  await page.getByLabel("Email address").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Enter your sign-in code");
}

test.describe("the sign-in code screen", () => {
  test("is asked of a clinician and an administrator after the password, never of a patient", async ({ page }) => {
    await passwordStep(page, "doctor@avela.dev");
    await expect(page.getByText("Account: doctor@avela.dev")).toBeVisible();
    await expect(page.getByLabel("Six-digit code")).toHaveAttribute("autocomplete", "one-time-code");
    await expect(page.getByLabel("Six-digit code")).toHaveAttribute("inputmode", "numeric");
    // Nothing of the signed-in app is reachable yet.
    await page.goto("/doctor");
    await expect(page).toHaveURL(/\/login/);

    await page.goto("/login");
    await page.getByLabel("Email address").fill("patient@avela.dev");
    await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page).not.toHaveURL(/\/login/);
    await expect(page.getByRole("heading", { name: "Enter your sign-in code" })).toHaveCount(0);
  });

  test("says plainly when a code is wrong, keeps the person on the screen, and accepts the right one", async ({ page }) => {
    await passwordStep(page, "admin@avela.dev");
    await page.getByLabel("Six-digit code").fill("000000");
    await page.getByRole("button", { name: "Continue" }).click();
    await expect(page.getByRole("alert")).toContainText("That code isn't right");
    await expect(page.getByLabel("Six-digit code")).toHaveAttribute("aria-invalid", "true");
    await page.getByLabel("Six-digit code").fill(codeFor("admin@avela.dev"));
    await page.getByRole("button", { name: "Continue" }).click();
    await expect(page.getByRole("heading", { level: 1 }).first()).toContainText("Doctor applications");
  });

  test("lets someone without their phone use a recovery code, once", async ({ page, browser }) => {
    // A brand-new clinician, set up through the screens, who keeps one recovery code.
    const email = uniqueEmail("recov");
    await page.goto("/join/doctor");
    await page.getByLabel("Your full name").fill("Dr. Rae Covery");
    await page.getByLabel("Email address").fill(email);
    await page.getByLabel("Choose a password", { exact: true }).fill(NEW_PASSWORD);
    await page.getByRole("button", { name: "Create my doctor account" }).click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Set up your sign-in code");
    const secretText = (await page.getByTestId("mfa-secret").innerText()).replace(/\s/g, "");
    expect(secretText).toMatch(/^[A-Z2-7]{32}$/);
    await completeAuthenticatorSetupWithCodes(page, email, secretText);
  });
});

/** Like completeAuthenticatorSetup, but returns the recovery codes it saw, and uses one to sign in afterwards. */
async function completeAuthenticatorSetupWithCodes(page: Page, email: string, secret: string) {
  const { rememberSecret } = await import("./mfa");
  rememberSecret(email, secret);
  await page.getByLabel("3. Type the six-digit code the app now shows.").fill(codeFor(email));
  await page.getByRole("button", { name: "Finish setting up" }).click();
  const items = page.getByTestId("recovery-codes").getByRole("listitem");
  await expect(items).toHaveCount(10);
  const first = (await items.first().innerText()).trim();
  await page.getByLabel("I have saved these codes").check();
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Your application");

  // Sign out, then sign in again with the recovery code instead of the app.
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Yes, sign me out" }).click();
  await passwordStep(page, email, NEW_PASSWORD);
  await page.getByRole("button", { name: "Use a recovery code instead" }).click();
  await page.getByLabel("Recovery code").fill(first.toLowerCase());
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Your application");

  // That code is spent: the same one does not work again.
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Yes, sign me out" }).click();
  await passwordStep(page, email, NEW_PASSWORD);
  await page.getByRole("button", { name: "Use a recovery code instead" }).click();
  await page.getByLabel("Recovery code").fill(first);
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("alert")).toContainText("That code isn't right");
}

test.describe("accessibility and right-to-left", () => {
  for (const locale of ["en", "ar"] as const) {
    test(`the code screen and the first-time setup screen have no serious violations (${locale})`, async ({ page }) => {
      // Reach each screen in English (the forms are the same), then switch the language on the screen itself.
      const toArabic = async () => {
        if (locale !== "ar") return;
        await page.getByRole("radio", { name: "العربية" }).first().click();
        await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
      };
      await passwordStep(page, "doctor@avela.dev");
      await toArabic();
      await expect(page.locator("#mfa-title")).toBeVisible();
      await scan(page, `code screen (${locale})`);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow, "no sideways scrolling").toBeLessThanOrEqual(1);
      await expect(page.getByLabel(locale === "ar" ? "الرمز المكوّن من ستة أرقام" : "Six-digit code")).toHaveAttribute("dir", "ltr"); // digits stay left-to-right

      // First-time setup.
      const email = uniqueEmail(`a11y${locale}`);
      await page.goto("/join/doctor");
      await page.evaluate(() => localStorage.removeItem("pdapp_locale"));
      await page.reload();
      await page.getByLabel("Your full name").fill("Dr. A11y Check");
      await page.getByLabel("Email address").fill(email);
      await page.getByLabel("Choose a password", { exact: true }).fill(NEW_PASSWORD);
      await page.getByRole("button", { name: "Create my doctor account" }).click();
      await expect(page.getByTestId("mfa-secret")).toBeVisible();
      await toArabic();
      await scan(page, `setup screen (${locale})`);
      // The key stays left-to-right and readable inside a right-to-left page.
      await expect(page.getByTestId("mfa-secret")).toHaveAttribute("dir", "ltr");
    });
  }
});

test("an administrator can reset a clinician's sign-in code, which signs them out and asks them to set up again", async ({ page, browser }) => {
  const email = uniqueEmail("lost");
  const token = await registerDoctorAccountViaApi(page, "Dr. Lost Phone", email);
  expect((await page.request.get("/api/auth/me", { headers: { Authorization: `Bearer ${token}` } })).status()).toBe(200);

  const admin = await browser.newContext();
  const ap = await admin.newPage();
  const { signInAs } = await import("./helpers");
  await signInAs(ap, "admin@avela.dev");
  const apps = await (await ap.request.get("/api/admin/doctor-applications?status=incomplete")).json();
  const me = apps.applications.find((a: any) => a.email === email);
  expect(me?.userId).toBeTruthy();
  const reset = await ap.request.post(`/api/admin/users/${me.userId}/mfa-reset`, { headers: { "X-Avela-Client": "web" } });
  expect(reset.status()).toBe(200);
  await admin.close();

  expect((await page.request.get("/api/auth/me", { headers: { Authorization: `Bearer ${token}` } })).status()).toBe(401);
  await page.goto("/login");
  await page.getByLabel("Email address").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(NEW_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await completeAuthenticatorSetup(page, email);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Your application");
});
