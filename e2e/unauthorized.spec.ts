import { test, expect } from "@playwright/test";
import { signInAs, uniqueEmail, NEW_PASSWORD, registerDoctorAccountViaApi } from "./helpers";

// In a real browser: each kind of account types the address of a screen that is
// not theirs. They must land somewhere of their own, never on the screen, and
// the matching API calls must refuse them too (that half is in tests/).
const CASES: [label: string, email: string, password: string | undefined, paths: string[], landsOn: RegExp][] = [
  ["a patient", "patient@avela.dev", undefined, ["/doctor", "/doctor/patients", "/doctor/availability", "/admin", "/admin/activity", "/caregiver"], /^\/$/],
  ["a caregiver", "caregiver@avela.dev", undefined, ["/appointments", "/medications", "/prescriptions", "/doctor", "/admin", "/notifications"], /^\/$/],
  ["an administrator", "admin@avela.dev", undefined, ["/appointments", "/medications", "/doctor", "/doctor/patients", "/caregiver", "/notifications"], /^\/$/],
  ["an approved doctor", "doctor@avela.dev", undefined, ["/appointments", "/medications", "/prescriptions", "/admin", "/admin/activity", "/caregiver"], /^\/$/],
];

for (const [label, email, password, paths, landsOn] of CASES) {
  test(`${label} typing the address of a screen that isn't theirs ends up on their own home`, async ({ page }) => {
    await signInAs(page, email, password);
    for (const path of paths) {
      await page.goto(path);
      await page.waitForLoadState("networkidle");
      expect(new URL(page.url()).pathname, `${label} at ${path}`).toMatch(landsOn);
    }
  });
}

test("a doctor who has not been approved can reach only their own application", async ({ page }) => {
  const email = uniqueEmail("pendingui");
  await registerDoctorAccountViaApi(page, "Dr. Not Yet", email);
  await signInAs(page, email, NEW_PASSWORD);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Your application");

  for (const path of ["/doctor/requests", "/doctor/patients", "/doctor/appointments", "/doctor/availability", "/doctor/profile", "/notifications", "/doctor/patients/anything"]) {
    await page.goto(path);
    await page.waitForLoadState("networkidle");
    expect(new URL(page.url()).pathname, path).toMatch(/^\/(doctor\/application)?$/);
    // None of the clinical workspace is on screen: only the application.
    for (const clinical of ["Needs your attention", "Pending requests", "Active patients", "Today's appointments"]) {
      await expect(page.getByText(clinical)).toHaveCount(0);
    }
  }
  for (const path of ["/appointments", "/medications", "/admin"]) {
    await page.goto(path);
    await page.waitForLoadState("networkidle");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Your application");
  }
});
