import { test, expect, type Browser, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { newSession, signUpPatient, uniqueEmail, WEB } from "./helpers";

const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

async function connectedPair(page: Page, browser: Browser, name: string) {
  await signUpPatient(page, name, uniqueEmail("hp"));
  const emily = (await (await page.request.get("/api/doctors")).json()).find((d: any) => d.name === "Dr. Emily Chen");
  const pairing = await (await page.request.post("/api/pairings", { headers: WEB, data: { doctorProfileId: emily.id } })).json();
  const doctor = await newSession(browser, "doctor@avela.dev");
  const accepted = await doctor.page.request.patch(`/api/pairings/${pairing.id}/accept`, { headers: { Authorization: `Bearer ${doctor.session.token}` } });
  expect(accepted.ok()).toBeTruthy();
  return { doctor, doctorProfileId: emily.id as string };
}

async function giveConsent(page: Page) {
  const need = await (await page.request.get("/api/health-profile/consent")).json();
  const res = await page.request.post("/api/health-profile/consent", { headers: WEB, data: { version: need.requiredVersion } });
  expect(res.ok()).toBeTruthy();
}

test("a patient can fill in, skip and correct their health information, and an empty list never means 'none'", async ({ page }) => {
  await signUpPatient(page, "Hala Healthfile", uniqueEmail("hp"));
  await page.goto("/health-profile");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("My health information");
  await expect(page.getByText("Nothing here is required")).toBeVisible();

  // Medical parts ask for permission first, in plain language, and a person can say no for now.
  await page.getByRole("link", { name: /Allergies/ }).click();
  await expect(page.getByRole("heading", { name: "Your permission to store this" })).toBeVisible();
  await expect(page.getByRole("button", { name: "I'm done with this part" })).toBeDisabled();
  await page.getByLabel("I understand this and agree").check();
  await page.getByRole("button", { name: "Save my permission" }).click();
  await expect(page.getByText("Allergies: not recorded yet")).toBeVisible();
  await expect(page.getByText("An empty list does not mean you have no allergies")).toBeVisible();

  // Add an allergy: it is marked as the patient's own, not checked by a doctor.
  await page.getByRole("button", { name: "Add an allergy" }).click();
  await page.getByLabel("What are you allergic to?").fill("Penicillin");
  await page.getByLabel("What happens?").fill("Rash");
  await page.getByLabel("How bad is it?").selectOption("moderate");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  const item = page.getByRole("listitem").filter({ hasText: "Penicillin" });
  await expect(item).toContainText("You reported this");
  await expect(item).toContainText("Not checked by a doctor");
  await expect(page.getByText("Allergies: you listed some")).toBeVisible();

  // Changing it keeps history; removing the only one returns to "not recorded", not "none".
  await item.getByRole("button", { name: /Change/ }).click();
  await page.getByLabel("What happens?").fill("Hives");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  const changed = page.getByRole("listitem").filter({ hasText: "Penicillin" });
  await expect(changed).toContainText("Hives");
  await expect(changed).toContainText("Corrected");
  await changed.getByRole("button", { name: /History/ }).click();
  await expect(changed.getByText(/Replaced by a newer version|Added/).first()).toBeVisible();
  await changed.getByRole("button", { name: /Remove/ }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Yes, remove" }).click();
  await expect(page.getByText("Allergies: not recorded yet")).toBeVisible();

  // "No known allergies" is something the patient says, and is labelled that way.
  await page.getByRole("button", { name: "I have no known allergies" }).click();
  await expect(page.getByText("Allergies: you said you have none that you know of")).toBeVisible();
  await expect(page.getByText("A doctor has not reviewed this.")).toBeVisible();

  // Skipping a part records nothing.
  await page.getByRole("button", { name: "Skip this part for now" }).click();
  await expect(page).toHaveURL(/\/health-profile$/);
  await expect(page.getByRole("link", { name: /Allergies/ })).toContainText("Skipped for now");
  await page.getByRole("link", { name: /Medicines you take/ }).click();
  await expect(page.getByText("This is a list in your own words")).toBeVisible();
  await expect(page.getByText("No medicines listed.")).toBeVisible();
});

test("a doctor the patient allows can help, is named on what they add, and loses access when the patient stops it", async ({ page, browser }) => {
  const { doctor, doctorProfileId } = await connectedPair(page, browser, "Mona Assisted");
  await giveConsent(page);

  // Without permission the doctor sees no one.
  await doctor.page.goto("/doctor/assist");
  await expect(doctor.page.getByText("No patient has asked for your help")).toBeVisible();

  await page.goto("/health-profile/review");
  await page.getByLabel("Which doctor?").selectOption({ label: "Dr. Emily Chen" });
  await page.getByRole("button", { name: "Allow this doctor" }).click();
  await expect(page.getByText("The doctor can now help you").first()).toBeVisible();
  void doctorProfileId;

  await doctor.page.reload();
  await doctor.page.getByRole("link", { name: /Mona Assisted/ }).click();
  await expect(doctor.page.getByRole("heading", { level: 1 })).toContainText("Mona Assisted");
  await doctor.page.getByRole("button", { name: "Add an allergy" }).first().click();
  await doctor.page.getByLabel("What are you allergic to?").fill("Latex");
  await doctor.page.getByRole("button", { name: "Save", exact: true }).click();
  const row = doctor.page.getByRole("listitem").filter({ hasText: "Latex" });
  await expect(row).toContainText("Added by");
  await row.getByRole("button", { name: /Mark as checked/ }).click();
  await expect(row).toContainText("Checked by");

  // The patient sees who added it and that it was checked, and cannot quietly delete it.
  await page.goto("/health-profile/allergies");
  const mine = page.getByRole("listitem").filter({ hasText: "Latex" });
  await expect(mine).toContainText("Checked by");
  await expect(mine.getByRole("button", { name: /^Remove/ })).toHaveCount(0);
  await mine.getByRole("button", { name: /Ask for a correction/ }).click();
  await page.getByRole("dialog").getByLabel("What should be corrected?").fill("I am not allergic to latex.");
  await page.getByRole("dialog").getByRole("button", { name: "Send" }).click();
  await expect(mine).toContainText("You asked for a correction");

  // The doctor sees the objection; stopping the help ends their access.
  await doctor.page.reload();
  await expect(doctor.page.getByRole("listitem").filter({ hasText: "Latex" })).toContainText("The patient asks for a correction");
  await page.goto("/health-profile/review");
  await page.getByRole("button", { name: /^Stop/ }).first().click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Yes, stop" }).click();
  await expect(page.getByText("You stopped it")).toBeVisible();
  await doctor.page.goto("/doctor/assist");
  await expect(doctor.page.getByText("No patient has asked for your help")).toBeVisible();
  await doctor.context.close();
});

for (const locale of ["en", "ar"] as const) {
  test(`the health information screens have no serious accessibility violations (${locale})`, async ({ page }) => {
    await signUpPatient(page, `Axe Health ${locale}`, uniqueEmail("hpa"));
    await giveConsent(page);
    await page.addInitScript((l) => localStorage.setItem("pdapp_locale", l), locale);
    for (const path of ["/health-profile", "/health-profile/basic", "/health-profile/allergies", "/health-profile/medications", "/health-profile/history", "/health-profile/preferences", "/health-profile/review"]) {
      await page.goto(path);
      await page.waitForLoadState("networkidle");
      await expect(page.locator("html")).toHaveAttribute("dir", locale === "ar" ? "rtl" : "ltr");
      const results = await new AxeBuilder({ page }).withTags(TAGS).analyze();
      const blocking = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
      expect(blocking.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).slice(0, 2).join(" | ")}`), `${path} (${locale})`).toEqual([]);
    }
  });
}
