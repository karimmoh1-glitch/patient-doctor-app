import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { newSession, signUpPatient, uniqueEmail, completeAuthenticatorSetup, WEB } from "./helpers";

const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

test("a clinician starts an organization, invites a coordinator, and the coordinator sees only what the patient allows", async ({ page, browser }) => {
  const orgName = `Nile Clinic ${Math.random().toString(36).slice(2, 7)}`;
  const doctor = await newSession(browser, "doctor@avela.dev");
  await doctor.page.goto("/org");
  await expect(doctor.page.getByRole("heading", { level: 1 })).toHaveText("Organization");
  await doctor.page.getByLabel("Name", { exact: true }).fill(orgName);
  await doctor.page.getByRole("button", { name: "Start the organization" }).click();
  await expect(doctor.page.getByRole("heading", { level: 1 })).toHaveText(orgName);
  await expect(doctor.page.getByText("Not verified. No Avela reviewer has checked this organization yet.")).toBeVisible();

  // Invite a coordinator. E-mail is not set up in tests, and the screen says so and shows the link once.
  await doctor.page.getByRole("link", { name: "Staff", exact: true }).click();
  const coordEmail = uniqueEmail("coord");
  await doctor.page.getByLabel("Their e-mail address").fill(coordEmail);
  await doctor.page.getByLabel("Their role").selectOption("coordinator");
  await doctor.page.getByRole("button", { name: "Create the invitation" }).click();
  await expect(doctor.page.getByText("No e-mail was sent. Give them this link yourself.")).toBeVisible();
  const link = (await doctor.page.locator("p.break-all").innerText()).trim();
  expect(link).toMatch(/\/join-team#[A-Za-z0-9_-]{40,}$/);

  // A patient connected to this doctor.
  await signUpPatient(page, "Dina Patient", uniqueEmail("orgp"));
  const emily = (await (await page.request.get("/api/doctors")).json()).find((d: any) => d.name === "Dr. Emily Chen");
  const pairing = await (await page.request.post("/api/pairings", { headers: WEB, data: { doctorProfileId: emily.id } })).json();
  await doctor.page.request.patch(`/api/pairings/${pairing.id}/accept`, { headers: { Authorization: `Bearer ${doctor.session.token}` } });

  // The coordinator opens the link, creates their account and sets up a sign-in code.
  const staffCtx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const staff = await staffCtx.newPage();
  await staff.goto(link.replace(/^https?:\/\/[^/]+/, ""));
  await expect(staff.getByRole("heading", { name: new RegExp(`${orgName} invited you`) })).toBeVisible();
  await expect(staff.getByText("does not give access to any patient's health records")).toBeVisible();
  expect(staff.url()).not.toContain("#");
  await staff.getByLabel("Your full name").or(staff.getByLabel(/name/i).first()).fill("Nour Coordinator");
  await staff.locator("#team-password").fill("seven green umbrellas");
  await staff.getByRole("button", { name: "Create my account" }).click();
  await completeAuthenticatorSetup(staff, coordEmail);
  await expect(staff.getByRole("heading", { level: 1 })).toHaveText(orgName);

  // What the coordinator can and cannot see.
  await expect(staff.getByRole("link", { name: "Patients" })).toBeVisible();
  await expect(staff.getByRole("link", { name: "Settings" })).toHaveCount(0);
  await expect(staff.getByRole("link", { name: "Activity" })).toHaveCount(0);
  await staff.getByRole("link", { name: "Patients" }).click();
  await expect(staff.getByRole("heading", { name: "Dina Patient" })).toBeVisible();
  await expect(staff.getByText("You see their name, not their health information.")).toBeVisible();

  await staff.getByRole("link", { name: "Tasks", exact: true }).click();
  await staff.getByLabel("About which patient?").selectOption({ label: "Dina Patient" });
  await staff.getByLabel("What needs doing?").fill("Send the registration forms");
  await staff.getByLabel("Due on").fill("2020-01-01");
  await staff.getByRole("button", { name: "Add the task" }).click();
  const task = staff.getByRole("listitem").filter({ hasText: "Send the registration forms" });
  await expect(task).toContainText("Overdue");
  await task.getByRole("button", { name: /^Mark as done/ }).click();
  await expect(staff.getByRole("listitem").filter({ hasText: "Send the registration forms" })).toHaveCount(0);

  // The patient is told, and turns it off: the coordinator then sees nobody.
  await page.goto("/profile");
  await expect(page.getByRole("heading", { name: "Who can see that I am a patient" })).toBeVisible();
  const row = page.getByRole("listitem").filter({ hasText: orgName });
  await expect(row).toContainText("Staff can see my name and appointment times");
  await row.getByRole("switch").click();
  await expect(row).toContainText("Only my doctor sees me");
  await staff.goto(staff.url().replace(/\/tasks.*$/, "/patients"));
  await expect(staff.getByRole("heading", { name: "Margaret Johnson" })).toBeVisible(); // another patient who allows it
  await expect(staff.getByRole("heading", { name: "Dina Patient" })).toHaveCount(0);

  await staffCtx.close();
  await doctor.context.close();
});

for (const locale of ["en", "ar"] as const) {
  test(`the organization screens have no serious accessibility violations (${locale})`, async ({ browser }) => {
    const doctor = await newSession(browser, "doctor@avela.dev");
    await doctor.page.addInitScript((l) => localStorage.setItem("pdapp_locale", l), locale);
    const token = { Authorization: `Bearer ${doctor.session.token}` };
    const mine = await (await doctor.page.request.get("/api/orgs", { headers: token })).json();
    const orgId = mine[0]?.id ?? (await (await doctor.page.request.post("/api/orgs", { headers: token, data: { name: "Axe Clinic", kind: "clinic", country: "US" } })).json()).id;
    for (const section of ["dashboard", "patients", "appointments", "tasks", "staff", "audit", "settings"]) {
      await doctor.page.goto(`/org/${orgId}/${section}`);
      await doctor.page.waitForLoadState("networkidle");
      await expect(doctor.page.locator("html")).toHaveAttribute("dir", locale === "ar" ? "rtl" : "ltr");
      const results = await new AxeBuilder({ page: doctor.page }).withTags(TAGS).analyze();
      const blocking = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
      expect(blocking.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).slice(0, 2).join(" | ")}`), `${section} (${locale})`).toEqual([]);
    }
    await doctor.page.request.patch("/api/auth/me/preferences", { headers: { ...token, "X-Avela-Client": "web" }, data: { language: "en" } });
    await doctor.context.close();
  });
}
