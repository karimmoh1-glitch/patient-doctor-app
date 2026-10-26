import { test, expect, type Browser, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { newSession, signUpPatient, uniqueEmail, WEB } from "./helpers";

const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

/** A new patient, connected to the fixture doctor Dr. Emily Chen, through the same requests the app makes. */
async function connectedPair(page: Page, browser: Browser, name: string) {
  await signUpPatient(page, name, uniqueEmail("msg"));
  const emily = (await (await page.request.get("/api/doctors")).json()).find((d: any) => d.name === "Dr. Emily Chen");
  const pairing = await (await page.request.post("/api/pairings", { headers: WEB, data: { doctorProfileId: emily.id } })).json();
  const doctor = await newSession(browser, "doctor@avela.dev");
  const accepted = await doctor.page.request.patch(`/api/pairings/${pairing.id}/accept`, { headers: { Authorization: `Bearer ${doctor.session.token}` } });
  expect(accepted.ok()).toBeTruthy();
  return { pairingId: pairing.id as string, doctor, name };
}

async function send(page: Page, text: string) {
  await page.getByLabel("Your message").fill(text);
  await page.getByRole("button", { name: "Send" }).click();
}

test("a sent message shows only what is true: sent, then delivered, then read", async ({ page, browser }) => {
  const { pairingId, doctor, name } = await connectedPair(page, browser, "Ingrid Message");
  await page.goto(`/chat/${pairingId}?with=${encodeURIComponent("Dr. Emily Chen")}`);
  await send(page, "Is the new tablet safe with food?");
  const mine = page.getByRole("log").locator("div", { hasText: "Is the new tablet safe with food?" }).last();
  await expect(mine).toBeVisible();
  // The server has it. Nobody has opened it: no claim of delivery or reading.
  await expect(page.getByRole("log").getByText("Delivered")).toHaveCount(0);
  await expect(page.getByRole("log").getByText("Read", { exact: true })).toHaveCount(0);

  // The doctor's app opens the conversation, which is what "delivered" and "read" mean.
  await doctor.page.goto(`/chat/${pairingId}?with=${encodeURIComponent(name)}`);
  await expect(doctor.page.getByText("Is the new tablet safe with food?")).toBeVisible();
  await expect(async () => {
    await page.reload();
    await expect(page.getByRole("log").getByText("Is the new tablet safe with food?")).toBeVisible();
    await expect(page.getByRole("log").getByText("Read", { exact: true })).toHaveCount(1, { timeout: 2_000 });
  }).toPass({ timeout: 25_000 });
  await doctor.context.close();
});

test("a message retried after the reply was lost is sent once", async ({ page, browser }) => {
  const { pairingId, doctor } = await connectedPair(page, browser, "Rosa Retry");
  await page.goto(`/chat/${pairingId}?with=${encodeURIComponent("Dr. Emily Chen")}`);

  // The request reaches the server and is stored, but the answer never gets back: the worst case for duplicates.
  let lost = false;
  await page.route(`**/api/pairings/${pairingId}/messages`, async (route) => {
    if (route.request().method() === "POST" && !lost) {
      lost = true;
      await route.fetch();
      await route.abort("connectionreset");
      return;
    }
    await route.continue();
  });
  await send(page, "Please call me about the results");
  await expect(page.getByRole("alert").filter({ hasText: /not sent|couldn't|failed/i }).first()).toBeVisible();
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByRole("alert")).toHaveCount(0);

  const thread = await (await doctor.page.request.get(`/api/pairings/${pairingId}/messages`, { headers: { Authorization: `Bearer ${doctor.session.token}` } })).json();
  expect(thread.filter((m: any) => m.body === "Please call me about the results")).toHaveLength(1);
  await expect(page.getByRole("log").getByText("Please call me about the results")).toHaveCount(1);
  await doctor.context.close();
});

test("the inbox shows what is unread, search stays in my conversations, and opening clears the count", async ({ page, browser }) => {
  const { pairingId, doctor, name } = await connectedPair(page, browser, "Ulla Unread");
  await doctor.page.request.post(`/api/pairings/${pairingId}/messages`, { headers: { Authorization: `Bearer ${doctor.session.token}` }, data: { body: "Your zebrafish results are ready" } });

  await page.goto("/messages");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Messages");
  await expect(page.getByText("1 new")).toBeVisible();
  await expect(page.getByRole("status").filter({ hasText: "Unread messages: 1" })).toBeVisible();

  await page.getByRole("searchbox", { name: "Search your messages" }).fill("zebrafish");
  await expect(page.getByRole("link", { name: /zebrafish/ }).first()).toBeVisible();
  await page.getByRole("searchbox", { name: "Search your messages" }).fill("this appears in nobody's conversation");
  await expect(page.getByText("No messages found.")).toBeVisible();

  await page.getByRole("link", { name: /Dr\. Emily Chen/ }).first().click();
  await expect(page.getByText("Your zebrafish results are ready")).toBeVisible();
  await page.goto("/messages");
  await expect(page.getByText("You have read everything.")).toBeVisible();

  // The doctor's own inbox, with the patient who just wrote.
  await page.goto(`/chat/${pairingId}?with=${encodeURIComponent("Dr. Emily Chen")}`);
  await send(page, "Thank you doctor");
  await doctor.page.goto("/doctor/messages");
  await expect(doctor.page.getByRole("link", { name: new RegExp(name) })).toBeVisible();
  await doctor.context.close();
});

test("a person can report a message, choosing whether the reviewer sees its text, and can block", async ({ page, browser }) => {
  const { pairingId, doctor } = await connectedPair(page, browser, "Berta Block");
  await doctor.page.request.post(`/api/pairings/${pairingId}/messages`, { headers: { Authorization: `Bearer ${doctor.session.token}` }, data: { body: "A remark that crosses a line" } });
  await page.goto(`/chat/${pairingId}?with=${encodeURIComponent("Dr. Emily Chen")}`);
  await expect(page.getByText("A remark that crosses a line")).toBeVisible();

  await page.getByRole("button", { name: "Report" }).first().click();
  await page.getByLabel("What is wrong?").selectOption("harassment");
  await page.getByLabel("Include the text of this message so the reviewer can read it").check();
  await page.getByRole("button", { name: "Send report" }).click();
  await expect(page.getByText("Report sent. A person on the Avela team will review it.").first()).toBeVisible();

  const admin = await newSession(browser, "admin@avela.dev");
  const reports = await (await admin.page.request.get("/api/admin/message-reports")).json();
  const mine = reports.find((r: any) => r.sharedText === "A remark that crosses a line");
  expect(mine?.reason).toBe("harassment");
  await admin.context.close();

  await page.getByRole("button", { name: "Block and end conversation" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Yes, block" }).click();
  await expect(page).toHaveURL(/\/messages$/);
  const after = await doctor.page.request.post(`/api/pairings/${pairingId}/messages`, { headers: { Authorization: `Bearer ${doctor.session.token}` }, data: { body: "Are you there?" } });
  expect(after.status()).toBe(403);
  await doctor.context.close();
});

for (const locale of ["en", "ar"] as const) {
  test(`the inbox and a conversation have no serious accessibility violations (${locale})`, async ({ page, browser }) => {
    const { pairingId, doctor } = await connectedPair(page, browser, `Axe ${locale}`);
    await doctor.page.request.post(`/api/pairings/${pairingId}/messages`, { headers: { Authorization: `Bearer ${doctor.session.token}` }, data: { body: "Hello from the doctor" } });
    await doctor.context.close();
    await page.addInitScript((l) => localStorage.setItem("pdapp_locale", l), locale);
    for (const path of ["/messages", `/chat/${pairingId}?with=${encodeURIComponent("Dr. Emily Chen")}`]) {
      await page.goto(path);
      await page.waitForLoadState("networkidle");
      await expect(page.locator("html")).toHaveAttribute("dir", locale === "ar" ? "rtl" : "ltr");
      const results = await new AxeBuilder({ page }).withTags(TAGS).analyze();
      const blocking = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
      expect(blocking.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).slice(0, 2).join(" | ")}`), `${path} (${locale})`).toEqual([]);
    }
  });
}
