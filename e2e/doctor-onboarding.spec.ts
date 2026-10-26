import { test, expect } from "@playwright/test";
import { newSession, signInAs, uniqueEmail, NEW_PASSWORD, completeAuthenticatorSetup, registerDoctorViaApi, APPROVAL } from "./helpers";

test.describe("becoming a doctor on Avela", () => {
  test("registers, completes the application, waits for review, answers a request for more information, and is approved by a person", async ({ page, browser }) => {
    test.setTimeout(120_000);
    const email = uniqueEmail("drflow");
    const name = "Amira Haddad";

    // 1. A visitor chooses the doctor path and creates the account.
    await page.goto("/get-started");
    await page.getByRole("link", { name: /I'm a Doctor/ }).click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Apply as a doctor");
    await page.getByLabel("Your full name").fill(name);
    await page.getByLabel("Email address").fill(email);
    await page.getByLabel("Choose a password", { exact: true }).fill(NEW_PASSWORD);
    await page.getByRole("button", { name: "Create my doctor account" }).click();
    // The authenticator is set up before anything else (a clinician has no session without it).
    await completeAuthenticatorSetup(page, email);

    // 2. The account exists but is NOT a working doctor account: only the application is reachable.
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Your application");
    await expect(page.getByText("Step 2 of 4")).toBeVisible();
    await page.goto("/doctor/requests");
    await expect(page).toHaveURL(/\/doctor\/application/);
    const nav = page.getByRole("navigation", { name: "Main" }).filter({ visible: true });
    await expect(nav).toHaveCount(0); // a single place to be: no clinical navigation at all

    // 3. Professional details, with required fields enforced.
    await page.getByRole("button", { name: "Next" }).click();
    await expect(page.getByText("This is required").first()).toBeVisible();
    await page.getByLabel("Professional role").selectOption("physician");
    await page.getByLabel("Medical specialty").selectOption("Cardiology");
    await page.getByLabel("State where you are licensed to practise").selectOption("TX");
    await page.getByLabel("Licence or registration number").fill("TX-778899");
    await page.getByLabel("Issuing regulatory body").fill("Texas Medical Board");
    await page.getByRole("button", { name: "Next" }).click();

    // 4. Profile: languages, how patients reach you, phone.
    await expect(page.getByText("Step 3 of 4")).toBeVisible();
    await page.getByRole("button", { name: "Next" }).click();
    await expect(page.getByText("Choose at least one language.")).toBeVisible();
    await page.getByRole("checkbox", { name: "English" }).check();
    await page.getByRole("checkbox", { name: "العربية" }).check();
    await page.getByLabel("Phone number patients can call after you accept them").fill("+1 555 010 2030");
    await page.getByRole("button", { name: "Next" }).click();

    // 5. Review states plainly that nothing was verified by a register.
    await expect(page.getByText(/self-reported/)).toBeVisible();
    await page.getByRole("button", { name: "Send for review" }).click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Your application is being reviewed");

    // Still locked out of everything clinical, including the API.
    const blocked = await page.request.get("/api/pairings/doctor"); // authenticated by the browser's own cookie
    expect(blocked.status()).toBe(403);

    // 6. A reviewer opens the queue, sees the details, and asks for more.
    const admin = await newSession(browser, "admin@avela.dev");
    await admin.page.goto("/admin");
    const card = admin.page.getByRole("listitem").filter({ hasText: "Amira Haddad" }).filter({ hasText: "TX-778899" });
    await expect(card).toContainText("Texas Medical Board");
    await expect(card).toContainText("not check licence details against an official register");
    await card.getByRole("button", { name: /Ask for more information/ }).click();
    await admin.page.getByLabel("What do you need from them?").fill("Please add your NPI number or board certification.");
    await admin.page.getByRole("button", { name: "Send request" }).click();
    await expect(admin.page.getByRole("listitem").filter({ hasText: "TX-778899" })).toContainText("More information requested");

    // 7. The doctor sees the request, updates, and sends again.
    await page.goto("/doctor/application");
    await expect(page.getByText("The team asked for more information")).toBeVisible();
    await expect(page.getByText("Please add your NPI number or board certification.")).toBeVisible();
    await page.getByLabel(/NPI number/).fill("1234567890");
    await page.getByRole("button", { name: "Next" }).click();
    await page.getByRole("button", { name: "Next" }).click();
    await page.getByRole("button", { name: "Send for review" }).click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Your application is being reviewed");

    // 8. Approval by a person unlocks the clinician workspace, without signing out.
    await admin.page.goto("/admin");
    const again = admin.page.getByRole("listitem").filter({ hasText: "TX-778899" });
    await again.getByRole("button", { name: /^Approve/ }).click();
    const approveDialog = admin.page.getByRole("dialog");
    await approveDialog.getByLabel("What did you check?").fill("Register entry matched the name and number.");
    await approveDialog.getByRole("button", { name: "Yes, approve" }).click();
    await admin.context.close();

    await page.reload();
    await expect(page.getByRole("heading", { level: 1 })).toContainText(/Dr\. /);
    await expect(page.getByRole("navigation", { name: "Main" }).filter({ visible: true }).getByRole("link")).toHaveCount(6); // includes Messages
    await expect(page.getByRole("navigation", { name: "Main" }).filter({ visible: true }).getByRole("link", { name: "Messages" })).toBeVisible();

    // And patients can now find them, in their own language, with Avela's honest wording.
    await page.goto("/find-doctors");
    await page.getByText("More filters").click();
    await page.getByLabel("State", { exact: true }).selectOption("TX");
    await page.getByLabel("Language spoken").selectOption("ar");
    const listing = page.locator("li", { has: page.getByRole("heading", { level: 2, name: "Amira Haddad" }) });
    await expect(listing).toContainText("Reviewed by the Avela team");
    await expect(listing).toContainText("hasn't published any times yet");
  });

  test("an administrator can suspend an approved doctor, who is then signed out and locked out", async ({ page, browser }) => {
    const email = uniqueEmail("drsusp");
    const { applicationId, token } = await registerDoctorViaApi(page, "Dr. Susan Park", email, { professionalRole: "physician", specialty: "Dermatology", state: "CA", licenseNumber: "S-1", licensingBody: "Board", languages: ["en"], modalities: ["phone"], phone: "+15550001234" });
    const sub = { id: applicationId };
    const headers = { Authorization: `Bearer ${token}` };

    const admin = await newSession(browser, "admin@avela.dev");
    const ah = { Authorization: `Bearer ${admin.session.token}` };
    await admin.page.request.post(`/api/admin/doctor-applications/${sub.id}/approve`, { headers: ah, data: APPROVAL });
    await admin.page.goto("/admin");
    await admin.page.getByRole("radio", { name: /Approved/ }).click();
    const card = admin.page.getByRole("listitem").filter({ hasText: "S-1" });
    await card.getByRole("button", { name: /^Suspend/ }).click();
    await admin.page.getByLabel(/Reason/).fill("Credentials under investigation");
    await admin.page.getByRole("button", { name: "Suspend doctor" }).click();
    await expect(admin.page.getByText("Doctor suspended").first()).toBeVisible();
    await admin.context.close();

    const after = await page.request.get("/api/pairings/doctor", { headers });
    expect(after.status()).toBe(401);
    await signInAs(page, email, NEW_PASSWORD);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Your doctor account is suspended");
    await expect(page.getByText("Credentials under investigation")).toBeVisible();
  });
});
