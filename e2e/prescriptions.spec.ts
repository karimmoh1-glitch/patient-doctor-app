import { test, expect } from "@playwright/test";
import { newSession } from "./helpers";

test.describe("prescriptions and reminders", () => {
  test("a prescription is a draft until the doctor authorizes it; then the patient sees it, sets a reminder, and Avela is honest about what it does not do", async ({ browser }) => {
    test.setTimeout(150_000);
    const doctor = await newSession(browser, "doctor@avela.dev");
    const patient = await newSession(browser, "patient@avela.dev");
    const med = `E2E Cetirizine ${Date.now().toString(36)}`;

    const dh = { Authorization: `Bearer ${doctor.session.token}` };
    const pairings = await (await doctor.page.request.get("/api/pairings/doctor", { headers: dh })).json();
    const margaret = pairings.find((p: any) => p.patientName === "Margaret Johnson" && p.status === "accepted");

    // The doctor writes a draft.
    await doctor.page.goto(`/doctor/patients/${margaret.id}`);
    await doctor.page.getByRole("tab", { name: "Prescriptions" }).click();
    await doctor.page.getByRole("button", { name: "New prescription" }).click();
    await doctor.page.getByLabel("Medication name").fill(med);
    await doctor.page.getByLabel("Dose each time").fill("1 tablet");
    await doctor.page.getByLabel("Instructions for the patient").fill("Take one tablet by mouth once a day.");
    await doctor.page.getByRole("button", { name: "Save draft" }).click();
    const card = doctor.page.locator("div", { has: doctor.page.getByText(med, { exact: true }) }).filter({ has: doctor.page.getByRole("button", { name: "Review and authorize" }) }).last();
    await expect(card).toContainText("Draft");
    await expect(card).toContainText("the patient can't see this yet");

    // The patient cannot see it, anywhere.
    await patient.page.goto("/prescriptions");
    await expect(patient.page.getByRole("heading", { level: 1 })).toHaveText("Prescriptions");
    await expect(patient.page.getByText(med)).toHaveCount(0);

    // Authorizing needs a deliberate confirmation that says what it means.
    await card.getByRole("button", { name: "Review and authorize" }).click();
    const dialog = doctor.page.getByRole("alertdialog");
    await expect(dialog).toContainText("can't be edited");
    await expect(dialog).toContainText("not sent to a pharmacy");
    await dialog.getByRole("button", { name: "Yes, I have reviewed it. Authorize" }).click();
    await expect(doctor.page.getByText("Prescription authorized")).toBeVisible();

    // Now the patient sees it: authorized, by whom, and plainly NOT sent to a pharmacy.
    await patient.page.reload();
    const rx = patient.page.getByRole("listitem").filter({ hasText: med });
    await expect(rx).toContainText("Authorized");
    await expect(rx).toContainText("Authorized by Dr. Emily Chen");
    await expect(patient.page.getByText(/not been sent to any pharmacy/).first()).toBeVisible();

    // They add it to their medicines and set a reminder.
    await rx.getByRole("button", { name: /Add to today's medicines/ }).click();
    await patient.page.goto("/medications");
    const medCard = patient.page.locator("section", { has: patient.page.getByRole("heading", { name: "All my medicines" }) }).getByRole("listitem").filter({ hasText: med }).first();
    await expect(medCard).toContainText("No reminder set");
    await medCard.getByRole("button", { name: /Set a reminder/ }).click();
    await medCard.getByLabel("Reminder time 1").fill("07:30");
    await medCard.getByRole("button", { name: "Save", exact: true }).click();
    await expect(patient.page.getByText("Reminder saved")).toBeVisible();
    await expect(medCard).toContainText("Reminders are on");
    await expect(medCard).toContainText("7:30");
    // The medicine's name is not shown in reminders unless the patient asks.
    await medCard.getByRole("button", { name: /Change reminder/ }).click();
    await expect(medCard.getByLabel("Show the medicine's name in the reminder")).not.toBeChecked();
    await medCard.getByRole("button", { name: "Cancel" }).click();

    // Honest about delivery: nothing in this test environment is scheduling reminders.
    await expect(patient.page.getByText(/Automatic reminders aren't switched on/)).toBeVisible();

    // The patient was told in-app, without the medicine's name in the notification.
    await patient.page.goto("/notifications");
    await expect(patient.page.getByText("Dr. Emily Chen authorized a new prescription for you").first()).toBeVisible();
    await expect(patient.page.getByText(med)).toHaveCount(0);

    // Cancelling moves it to Past, and tells the patient.
    await doctor.page.reload();
    await doctor.page.getByRole("tab", { name: "Prescriptions" }).click();
    const authorized = doctor.page.locator("div", { has: doctor.page.getByText(med, { exact: true }) }).filter({ has: doctor.page.getByRole("button", { name: "Cancel prescription" }) }).last();
    await authorized.getByRole("button", { name: "Cancel prescription" }).click();
    await doctor.page.getByRole("alertdialog").getByRole("button", { name: "Yes, cancel it" }).click();
    await patient.page.goto("/prescriptions");
    const past = patient.page.locator("section", { has: patient.page.getByRole("heading", { name: "Past" }) });
    await expect(past).toContainText(med);
    await expect(past).toContainText("Cancelled");
    await doctor.context.close();
    await patient.context.close();
  });

  test("a controlled substance cannot be recorded in Avela", async ({ browser }) => {
    const doctor = await newSession(browser, "doctor@avela.dev");
    const dh = { Authorization: `Bearer ${doctor.session.token}` };
    const pairings = await (await doctor.page.request.get("/api/pairings/doctor", { headers: dh })).json();
    const margaret = pairings.find((p: any) => p.patientName === "Margaret Johnson" && p.status === "accepted");
    await doctor.page.goto(`/doctor/patients/${margaret.id}`);
    await doctor.page.getByRole("tab", { name: "Prescriptions" }).click();
    await doctor.page.getByRole("button", { name: "New prescription" }).click();
    await doctor.page.getByLabel("Medication name").fill("Controlled test");
    await doctor.page.getByLabel("Dose each time").fill("1");
    await doctor.page.getByLabel("Instructions for the patient").fill("As directed");
    await doctor.page.getByLabel("Is this a controlled substance?").selectOption("yes");
    await doctor.page.getByRole("button", { name: "Save draft" }).click();
    await expect(doctor.page.getByText(/Controlled substances can't be recorded in Avela/).first()).toBeVisible();
    await doctor.context.close();
  });
});
