import { test, expect } from "@playwright/test";
import { newSession, signUpPatient, uniqueEmail, WEB } from "./helpers";

test.describe("an older patient's first week", () => {
  test("creates an account and lands on a home screen that says what to do next", async ({ page }) => {
    await signUpPatient(page, "Eleanor Whitfield", uniqueEmail("eleanor"));

    // The three questions the home screen must answer.
    await expect(page.getByRole("heading", { name: "Your next visit" })).toBeVisible();
    await expect(page.getByRole("link", { name: /find a doctor/i }).first()).toBeVisible();
    await expect(page.getByRole("heading", { name: "Need help?" })).toBeVisible();

    // Emergency and Help are on screen without scrolling or opening a menu.
    await expect(page.getByRole("link", { name: /emergency/i }).first()).toBeVisible();
    await expect(page.getByRole("link", { name: /^help$/i })).toBeVisible();

    // Exactly four places to go, each with a visible label.
    const nav = page.getByRole("navigation", { name: "Main" }).filter({ visible: true });
    await expect(nav.getByRole("link")).toHaveCount(4);
  });

  test("finds a doctor, gets accepted, books a real time, changes it, then cancels after a confirmation", async ({ page, browser }) => {
    test.setTimeout(150_000);
    const name = "Walter Okafor";
    await signUpPatient(page, name, uniqueEmail("walter"));

    // --- Find a doctor ---
    await page.getByRole("link", { name: /find a doctor/i }).first().click();
    await expect(page.getByRole("heading", { name: "What do you need help with?" })).toBeVisible();
    await page.getByLabel("Describe it here").fill("I have a cough and a fever and I feel very tired");
    await page.getByRole("button", { name: "Show me doctors" }).click();

    await expect(page.getByRole("heading", { name: "Doctors in your state" })).toBeVisible();
    const emily = page.locator("div", { has: page.getByText("Dr. Emily Chen") }).filter({ has: page.getByRole("button", { name: "Ask this doctor to see me" }) }).last();
    await expect(emily.getByText(/Shown because you wrote/)).toContainText("cough");
    await emily.getByRole("button", { name: "Ask this doctor to see me" }).click();
    await expect(page.getByText(/They decide whether to accept/)).toBeVisible();

    // The patient is told the truth: it is pending, not "connected".
    await page.goto("/care-team");
    await expect(page.getByText("This doctor hasn't answered yet")).toBeVisible();

    // --- The doctor accepts, in a separate session ---
    const doctor = await newSession(browser, "doctor@avela.dev");
    await doctor.page.goto("/doctor/requests");
    const request = doctor.page.locator("div", { hasText: name }).filter({ has: doctor.page.getByRole("button", { name: "Accept" }) }).last();
    await request.getByRole("button", { name: "View symptoms" }).click();
    await expect(request.getByText(/cough and a fever/)).toBeVisible();
    await request.getByRole("button", { name: "Accept" }).click();
    await expect(doctor.page.getByText("No pending requests").or(doctor.page.locator("div", { hasText: name }).filter({ hasText: "Connected" }).first()).first()).toBeVisible();

    // --- Patient books a real slot ---
    await page.reload();
    await expect(page.getByRole("link", { name: /call/i }).first()).toBeVisible();
    await page.goto("/appointments");
    await page.getByRole("button", { name: "Book a visit" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("heading", { name: "Book a visit" })).toBeVisible();

    // Not today: how many times are left today depends on the hour the suite runs, so use a later day that is always complete.
    await dialog.getByRole("radiogroup", { name: "Choose a day" }).getByRole("radio").nth(1).click();
    const slot = dialog.getByRole("radiogroup", { name: /times on/i }).getByRole("radio").nth(2);
    await slot.click();
    await expect(slot).toHaveAttribute("aria-checked", "true");
    await dialog.getByLabel("What is the visit about?").fill("My cough is not going away");
    await dialog.getByRole("button", { name: "Request this time" }).click();

    await expect(page.getByText(/still needs to confirm/).first()).toBeVisible();
    const card = page.locator("div", { hasText: "My cough is not going away" }).filter({ has: page.getByRole("button", { name: "Change time" }) }).last();
    await expect(card.getByText("Waiting for the doctor to confirm this time.")).toBeVisible();

    // --- Doctor confirms ---
    await doctor.page.goto("/doctor/patients");
    await doctor.page.getByText(name).locator("xpath=ancestor::div[.//a][1]").getByRole("link", { name: /Open/ }).click();
    await doctor.page.getByRole("button", { name: "Confirm" }).first().click();
    await expect(doctor.page.getByRole("button", { name: "Confirm" })).toHaveCount(0);

    await page.reload();
    await expect(page.getByText("The doctor has confirmed this time.").first()).toBeVisible();

    // --- Change the time: the doctor must reconfirm, and the patient is told so ---
    await page.getByRole("button", { name: "Change time" }).click();
    const reschedule = page.getByRole("dialog");
    await expect(reschedule.getByRole("heading", { name: "Change the time" })).toBeVisible();
    await reschedule.getByRole("radiogroup", { name: "Choose a day" }).getByRole("radio").nth(2).click();
    await reschedule.getByRole("radiogroup", { name: /times on/i }).getByRole("radio").nth(5).click();
    await reschedule.getByRole("button", { name: "Request this new time" }).click();
    await expect(page.getByText("Waiting for the doctor to confirm this time.")).toBeVisible();

    // --- Cancel: asks first; "keep" really keeps it ---
    await page.getByRole("button", { name: "Cancel visit" }).click();
    const confirm = page.getByRole("alertdialog");
    await expect(confirm.getByRole("heading", { name: "Cancel this appointment?" })).toBeVisible();
    await confirm.getByRole("button", { name: "No, keep my visit" }).click();
    await expect(page.getByRole("button", { name: "Cancel visit" })).toBeVisible();

    await page.getByRole("button", { name: "Cancel visit" }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Yes, cancel it" }).click();
    await expect(page.getByText("Appointment cancelled").first()).toBeVisible();
    await expect(page.getByRole("heading", { name: "Earlier" })).toBeVisible();

    await doctor.context.close();
  });

  test("can stop sharing with a doctor, and the doctor loses access straight away", async ({ page, browser }) => {
    const name = "Ines Marchetti";
    await signUpPatient(page, name, uniqueEmail("ines"));
    const res = await page.request.get("/api/doctors");
    const emily = (await res.json()).find((d: any) => d.name === "Dr. Emily Chen");
    const pairing = await page.request.post("/api/pairings", { headers: WEB, data: { doctorProfileId: emily.id } });
    expect(pairing.status()).toBe(201);

    const doctor = await newSession(browser, "doctor@avela.dev");
    await doctor.page.goto("/doctor/requests");
    const row = doctor.page.locator("div", { hasText: name }).filter({ has: doctor.page.getByRole("button", { name: "Accept" }) }).last();
    await row.getByRole("button", { name: "Accept" }).click();

    await page.goto("/care-team");
    await page.getByRole("button", { name: /Stop sharing with this doctor/ }).first().click();
    const dialog = page.getByRole("alertdialog");
    await expect(dialog).toContainText("will no longer be able to message you");
    await dialog.getByRole("button", { name: "Yes, stop sharing" }).click();
    await expect(page.getByText("Sharing stopped").first()).toBeVisible();

    const pairingId = (await pairing.json()).id;
    const doctorToken = doctor.session.token;
    const msgs = await doctor.page.request.get(`/api/pairings/${pairingId}/messages`, { headers: { Authorization: `Bearer ${doctorToken}` } });
    expect(msgs.status()).toBe(403);
    await doctor.context.close();
  });
});
