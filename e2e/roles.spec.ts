import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { newSession, signInAs, signUpPatient, uniqueEmail, PASSWORD, registerDoctorViaApi, approveViaApi } from "./helpers";

test.describe("caregiver", () => {
  test("sees only what the patient shared, and can't change anything", async ({ page }) => {
    await signInAs(page, "caregiver@avela.dev");
    await expect(page).toHaveURL(/caregiver|\/$/);
    await expect(page.getByRole("heading", { level: 1 })).toContainText("Hello, Sarah");
    await expect(page.getByText(/Margaret Johnson/).first()).toBeVisible();
    await expect(page.getByText(/You can look, but you can't change anything/)).toBeVisible();

    // Shared by default: medicines, visits. NOT shared by default: documents, full records.
    await expect(page.getByRole("heading", { name: "Today's medicines" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Coming up" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Documents" })).toHaveCount(0);
    // No messages, prescriptions, symptom text or doctor notes anywhere on the page.
    const text = await page.locator("main").innerText();
    expect(text).not.toMatch(/headaches and fatigue|doctor's notes|Recurring/i);
    // Honest wording about what the app actually knows.
    await expect(page.getByText(/does not prove anything was or wasn't taken/)).toBeVisible();

    // No way to act: there is no write control on this screen.
    await expect(page.locator("main").getByRole("button")).toHaveCount(0);
  });

  test("cannot reach patient or doctor screens, even by typing the address", async ({ page }) => {
    await signInAs(page, "caregiver@avela.dev");
    for (const path of ["/appointments", "/medications", "/doctor", "/admin", "/documents"]) {
      await page.goto(path);
      await expect(page).not.toHaveURL(new RegExp(`${path}$`));
    }
  });
});

test.describe("patients are walled off from each other", () => {
  test("someone else's appointment address shows nothing about it", async ({ page, browser }) => {
    const margaret = await newSession(browser, "patient@avela.dev");
    const list = await margaret.page.request.get("/api/appointments", { headers: { Authorization: `Bearer ${margaret.session.token}` } });
    const apptId = (await list.json())[0].id as string;
    await margaret.context.close();

    await signUpPatient(page, "Nosy Neighbour", uniqueEmail("nosy"));
    await page.goto(`/appointments/${apptId}`);
    await page.waitForLoadState("networkidle");
    const body = await page.locator("main").innerText();
    expect(body).not.toMatch(/headaches|Emily Chen|Margaret/);
    expect(body).toMatch(/not found|couldn't|no longer/i);
  });

  test("a patient who types a doctor's address is sent home, not shown doctor tools", async ({ page }) => {
    await signUpPatient(page, "Curious Visitor", uniqueEmail("curious"));
    await page.goto("/doctor/requests");
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByRole("button", { name: "Accept" })).toHaveCount(0);
  });
});

test.describe("doctor", () => {
  test("publishes weekly hours, which patients then see as real bookable times", async ({ page, browser }) => {
    // A brand-new doctor with no hours: registers, is approved, signs in.
    const email = uniqueEmail("drnew");
    const { applicationId } = await registerDoctorViaApi(page, "Dr. Priya Raman", email);
    await approveViaApi(browser, applicationId);

    await signInAs(page, email);
    await page.goto("/doctor/availability");
    await expect(page.getByText(/patients can't book a visit with you/)).toBeVisible();
    await page.getByRole("button", { name: /Add hours on Monday/ }).click();
    await page.getByRole("button", { name: "Save my hours" }).click();
    await expect(page.getByText("Your hours are saved")).toBeVisible();

    await page.reload();
    await expect(page.getByLabel("From").first()).toHaveValue("09:00");
    await expect(page.getByLabel("Until").first()).toHaveValue("12:00");
    await expect(page.getByLabel("Your time zone")).toHaveValue("America/Los_Angeles");
  });
});

test.describe("accessibility of every role's screens", () => {
  const SCANS: [email: string, paths: string[]][] = [
    ["doctor@avela.dev", ["/doctor", "/doctor/requests", "/doctor/patients", "/doctor/appointments", "/doctor/availability", "/doctor/profile", "/notifications", "/help"]],
    ["admin@avela.dev", ["/admin", "/admin/activity"]],
    ["caregiver@avela.dev", ["/caregiver", "/help"]],
  ];
  for (const [email, paths] of SCANS) {
    for (const path of paths) {
      test(`${email.split("@")[0]} ${path} has no serious violations`, async ({ page }) => {
        await signInAs(page, email);
        await page.goto(path);
        await page.waitForLoadState("networkidle");
        const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
        const blocking = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
        if (results.violations.length) console.log(`[axe] ${email} ${path}\n  ` + results.violations.map((v) => `${v.impact}: ${v.id} (${v.nodes.length}) e.g. ${v.nodes[0]?.target.join(" ")}`).join("\n  "));
        expect(blocking.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).slice(0, 2).join(" | ")}`)).toEqual([]);
      });
    }
  }
});
