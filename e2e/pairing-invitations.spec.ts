import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { newSession, signUpPatient, uniqueEmail, NEW_PASSWORD, finishWelcome } from "./helpers";

const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

test("a clinician shows a code, the patient checks who it is from, confirms, and only then is anything connected", async ({ page, browser }) => {
  await signUpPatient(page, "Rania Scanner", uniqueEmail("qr"));
  const doctor = await newSession(browser, "doctor@avela.dev");
  await doctor.page.goto("/doctor/connect");
  await expect(doctor.page.getByRole("heading", { level: 1 })).toHaveText("Connect a patient");
  await doctor.page.getByRole("button", { name: "Make a code" }).click();
  await expect(doctor.page.getByRole("img", { name: /QR code for connecting/ })).toBeVisible();
  const code = (await doctor.page.locator("p.text-4xl").innerText()).trim();
  expect(code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  await expect(doctor.page.getByText(/Stops working in/)).toBeVisible();

  // The patient types the short code (the camera path is the same server call).
  await page.goto("/connect");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Connect with a doctor");
  await page.getByLabel("Code from your doctor").fill(code.toLowerCase());
  await page.getByRole("button", { name: "Check this code" }).click();
  await expect(page.getByRole("heading", { name: "Dr. Emily Chen" })).toBeVisible();
  await expect(page.getByText("Avela has not recorded a licence check for this doctor.")).toBeVisible();
  await expect(page.getByText("Your health information stays private unless you choose to share it.")).toBeVisible();

  // Looking has connected nothing, and the clinician's screen still says "waiting".
  expect((await (await page.request.get("/api/pairings")).json()).filter((p: any) => p.status === "accepted")).toHaveLength(0);
  await expect(doctor.page.getByText("Waiting for the patient")).toBeVisible();

  await page.getByRole("button", { name: "Yes, connect me with Dr. Emily Chen" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toContainText("You are connected with Dr. Emily Chen");
  expect((await (await page.request.get("/api/pairings")).json()).filter((p: any) => p.status === "accepted")).toHaveLength(1);
  // The clinician's screen follows the server, not the patient's screen.
  await expect(doctor.page.getByText("Connected: Rania Scanner")).toBeVisible({ timeout: 15_000 });

  // The code cannot be used again.
  const other = await newSession(browser, "patient@avela.dev").catch(() => null);
  void other;
  await page.goto("/connect");
  await page.getByLabel("Code from your doctor").fill(code);
  await page.getByRole("button", { name: "Check this code" }).click();
  await expect(page.getByText("That code isn't valid or has expired.")).toBeVisible();
  await doctor.context.close();
});

test("a patient who declines is not connected, and the clinician can cancel an unused code", async ({ page, browser }) => {
  await signUpPatient(page, "Dalia Decliner", uniqueEmail("qr"));
  const doctor = await newSession(browser, "doctor@avela.dev");
  await doctor.page.goto("/doctor/connect");
  await doctor.page.getByRole("button", { name: "Make a code" }).click();
  const code = (await doctor.page.locator("p.text-4xl").innerText()).trim();

  await page.goto("/connect");
  await page.getByLabel("Code from your doctor").fill(code);
  await page.getByRole("button", { name: "Check this code" }).click();
  await page.getByRole("button", { name: "No, don't connect" }).click();
  await expect(page.getByText("Nothing was connected. The doctor was not told.")).toBeVisible();
  expect((await (await page.request.get("/api/pairings")).json()).filter((p: any) => p.status === "accepted")).toHaveLength(0);

  await doctor.page.getByRole("button", { name: "Cancel this code" }).click();
  await doctor.page.getByRole("alertdialog").getByRole("button", { name: "Yes, cancel it" }).click();
  await page.getByLabel("Code from your doctor").fill(code);
  await page.getByRole("button", { name: "Check this code" }).click();
  await expect(page.getByText("That code isn't valid or has expired.")).toBeVisible();
  await doctor.context.close();
});

test("when the network fails the clinician is told, and nothing is shown as a working code", async ({ browser }) => {
  const doctor = await newSession(browser, "doctor@avela.dev");
  await doctor.page.goto("/doctor/connect");
  await doctor.page.route("**/api/pairing-invitations", (route) => (route.request().method() === "POST" ? route.abort("connectionreset") : route.continue()));
  await doctor.page.getByRole("button", { name: "Make a code" }).click();
  await expect(doctor.page.getByRole("alert")).toBeVisible();
  await expect(doctor.page.getByRole("img", { name: /QR code/ })).toHaveCount(0);
  await doctor.context.close();
});

test("a patient who opens a code before signing in is brought back to it after signing in", async ({ page, browser }) => {
  const doctor = await newSession(browser, "doctor@avela.dev");
  const created = await (await doctor.page.request.post("/api/pairing-invitations", { headers: { Authorization: `Bearer ${doctor.session.token}` } })).json();
  const fragment = new URL(created.url).hash;
  await page.goto(`/connect${fragment}`);
  await expect(page.getByRole("link", { name: "Sign in" })).toBeVisible();
  // The token is not left in the address bar.
  expect(page.url()).not.toContain("#");
  // Sign up in the same tab: the kept code survives, and the person lands back on it instead of on the welcome page.
  await page.getByRole("link", { name: "Create an account" }).click();
  await page.getByLabel("Your name").fill("Layla Latecomer");
  await page.getByLabel("Email address").fill(uniqueEmail("qr"));
  await page.getByLabel("State where you live").selectOption("CA");
  await page.getByLabel("Choose a password", { exact: true }).fill(NEW_PASSWORD);
  await page.getByRole("button", { name: "Create my account" }).click();
  await finishWelcome(page);
  await expect(page.getByRole("heading", { name: "Dr. Emily Chen" })).toBeVisible();
  await doctor.context.close();
});

for (const locale of ["en", "ar"] as const) {
  test(`the connect screens have no serious accessibility violations (${locale})`, async ({ page, browser }) => {
    await signUpPatient(page, `Axe Connect ${locale}`, uniqueEmail("qra"));
    await page.addInitScript((l) => localStorage.setItem("pdapp_locale", l), locale);
    await page.goto("/connect");
    await page.waitForLoadState("networkidle");
    await expect(page.locator("html")).toHaveAttribute("dir", locale === "ar" ? "rtl" : "ltr");
    let results = await new AxeBuilder({ page }).withTags(TAGS).analyze();
    expect(results.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => v.id), `patient ${locale}`).toEqual([]);

    const doctor = await newSession(browser, "doctor@avela.dev");
    await doctor.page.addInitScript((l) => localStorage.setItem("pdapp_locale", l), locale);
    await doctor.page.goto("/doctor/connect");
    await doctor.page.getByRole("button").filter({ hasText: /Make|إنشاء/ }).first().click();
    await expect(doctor.page.getByRole("img")).toBeVisible();
    results = await new AxeBuilder({ page: doctor.page }).withTags(TAGS).analyze();
    expect(results.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => v.id), `doctor ${locale}`).toEqual([]);
    // Restore the shared clinician account's language for later specs.
    await doctor.page.request.patch("/api/auth/me/preferences", { headers: { "X-Avela-Client": "web", Authorization: `Bearer ${doctor.session.token}` }, data: { language: "en" } });
    await doctor.context.close();
  });
}
