import { test, expect, type Page } from "@playwright/test";

function watch(page: Page) {
  const problems: string[] = [];
  page.on("pageerror", (e) => problems.push(`uncaught: ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource.*(401|403)/.test(m.text())) problems.push(`console: ${m.text()}`); });
  page.on("response", (r) => {
    const u = new URL(r.url());
    if (u.origin === new URL(page.url() || r.url()).origin && r.status() >= 500) problems.push(`${r.status()} ${u.pathname}`);
    if (u.origin === new URL(page.url() || r.url()).origin && r.status() === 404 && !u.pathname.startsWith("/api/")) problems.push(`404 ${u.pathname}`);
  });
  return problems;
}

async function demoSignIn(page: Page, who: "patient" | "doctor") {
  await page.goto("/login");
  await page.getByRole("button", { name: who === "patient" ? "Demo patient" : "Demo doctor" }).click();
  await expect(page).not.toHaveURL(/\/login/);
}

test.describe("the deployed build", () => {
  test("is the commit that was meant to ship, and says what it is", async ({ request }) => {
    const v = await (await request.get("/version.json")).json();
    const h = await (await request.get("/api/health")).json();
    expect(h.ok).toBe(true);
    expect(v.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(h.commit).toBe(v.commit); // the API and the pages come from the same build
    if (process.env.EXPECTED_COMMIT) expect(v.commit).toBe(process.env.EXPECTED_COMMIT);
  });

  test("serves the landing page, registration and sign-in, and survives a reload on each", async ({ page }) => {
    const problems = watch(page);
    for (const [path, heading] of [["/", "Healthcare, closer to you."], ["/get-started", "How would you like to use Avela?"], ["/signup", "Create your account"], ["/join/doctor", "Apply as a doctor"], ["/login", "Sign in"], ["/find-doctors", "Find a doctor"], ["/privacy", "Privacy"]] as const) {
      await page.goto(path);
      await expect(page.getByRole("heading", { level: 1 })).toHaveText(heading);
      await page.reload();
      await expect(page.getByRole("heading", { level: 1 })).toHaveText(heading);
    }
    expect(problems).toEqual([]);
  });

  test("turns right-to-left in Arabic and keeps it across navigation and reload", async ({ page }) => {
    const problems = watch(page);
    await page.goto("/");
    await page.getByRole("radio", { name: "العربية" }).first().click();
    await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
    for (const path of ["/find-doctors", "/signup", "/login"]) {
      await page.goto(path);
      await expect(page.locator("html")).toHaveAttribute("lang", "ar");
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow, `${path} overflows in Arabic`).toBeLessThanOrEqual(1);
    }
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
    expect(problems).toEqual([]);
  });

  test("sends a signed-out visitor away from private screens, and shows no private data", async ({ page, request }) => {
    for (const path of ["/appointments", "/medications", "/prescriptions", "/doctor", "/admin"]) {
      await page.goto(path);
      await expect(page).toHaveURL(/\/login/);
    }
    for (const path of ["/api/appointments", "/api/prescriptions", "/api/me/export", "/api/admin/audit", "/api/pairings/doctor", "/api/reminders"]) {
      expect((await request.get(path)).status(), path).toBe(401);
    }
  });
});

test.describe("a patient, signed in through the demo button", () => {
  test("sees their own screens render, and is kept out of everyone else's", async ({ page }) => {
    const problems = watch(page);
    await demoSignIn(page, "patient");
    await expect(page.getByRole("heading", { level: 1 })).toContainText(/Good (morning|afternoon|evening), Margaret/);
    for (const path of ["/appointments", "/medications", "/prescriptions", "/my-health", "/doctors", "/notifications", "/profile", "/help", "/care-team"]) {
      await page.goto(path);
      await page.reload();
      await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible();
      await expect(page.locator("#main")).not.toBeEmpty();
    }
    // The server, not the page, refuses what a patient may not do.
    // Reads are authenticated by the browser's own HttpOnly cookie.
    const h = {};
    for (const path of ["/api/admin/audit", "/api/admin/reminders/status", "/api/pairings/doctor", "/api/prescriptions/doctor", "/api/doctors/me/profile"]) {
      expect((await page.request.get(path, { headers: h })).status(), path).toBe(403);
    }
    // And by address in the browser.
    await page.goto("/doctor/patients");
    await expect(page).not.toHaveURL(/\/doctor\/patients/);
    expect(problems).toEqual([]);
  });

  test("can switch language from Settings and the whole signed-in app follows", async ({ page }) => {
    await demoSignIn(page, "patient");
    await page.getByRole("button", { name: "Settings" }).click();
    await page.getByLabel("Language").selectOption("ar");
    await page.keyboard.press("Escape");
    await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
    await page.goto("/prescriptions");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("الوصفات الطبية");
    // Put the shared demo account back, so the next visitor sees English.
    await page.getByRole("button", { name: "الإعدادات" }).click();
    await page.getByLabel("اللغة").selectOption("en");
    await page.keyboard.press("Escape");
    await expect(page.locator("html")).toHaveAttribute("lang", "en");
  });

  test("signs out and leaves nothing behind", async ({ page }) => {
    await demoSignIn(page, "patient");
    await page.getByRole("button", { name: "Settings" }).click();
    await page.getByRole("button", { name: "Sign out", exact: true }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Yes, sign me out" }).click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Healthcare, closer to you.");
    expect(await page.evaluate(() => localStorage.getItem("pdapp_user"))).toBeNull();
    expect(await page.evaluate(() => localStorage.getItem("pdapp_auth"))).toBeNull();
    // The sign-out request is what clears the HttpOnly cookie; the screen does not wait for it, so give it a moment.
    await expect.poll(async () => (await page.context().cookies()).filter((c) => /avela_session/.test(c.name) && c.value).length, { timeout: 10_000 }).toBe(0);
    await page.goto("/appointments");
    await expect(page).toHaveURL(/\/login/);
  });
});

test.describe("a doctor, signed in through the demo button", () => {
  test("sees the clinical workspace, opens a patient, and cannot reach patient-only or admin screens", async ({ page }) => {
    const problems = watch(page);
    await demoSignIn(page, "doctor");
    await expect(page.getByRole("heading", { level: 1 })).toContainText(/Dr\. Chen/);
    for (const path of ["/doctor/requests", "/doctor/patients", "/doctor/appointments", "/doctor/availability", "/doctor/profile", "/notifications"]) {
      await page.goto(path);
      await page.reload();
      await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible();
    }
    const h = {};
    const pairings = await (await page.request.get("/api/pairings/doctor", { headers: h })).json();
    const margaret = pairings.find((p: any) => p.patientName === "Margaret Johnson" && p.status === "accepted");
    await page.goto(`/doctor/patients/${margaret.id}`);
    await page.getByRole("tab", { name: "Prescriptions" }).click();
    await page.getByRole("button", { name: "New prescription" }).click(); // opened and left: nothing is saved
    await expect(page.getByRole("dialog").getByText(/not sent to any pharmacy/)).toBeVisible();
    await page.keyboard.press("Escape");

    for (const path of ["/api/admin/doctor-applications", "/api/me/export", "/api/medications", "/api/prescriptions"]) {
      expect((await page.request.get(path, { headers: h })).status(), path).toBe(403);
    }
    await page.goto("/admin");
    await expect(page).not.toHaveURL(/\/admin/);
    expect(problems).toEqual([]);
  });
});

test("reminder delivery status is reported honestly", async ({ request }) => {
  const cfg = await (await request.get("/api/config")).json();
  // Whatever the value, it must be one of the four true statements.
  expect(["active", "stale", "failing", "not_configured"]).toContain(cfg.features.reminderDelivery);
  console.log(`reminderDelivery = ${cfg.features.reminderDelivery}`);
});
