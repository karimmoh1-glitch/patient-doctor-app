import type { Page } from "@playwright/test";
import { test, expect } from "./diagnostics";

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

test.describe("nothing on the deployed site is fabricated or simulated", () => {
  test("has no demo sign-in, no demo banner and no published credentials", async ({ page, request }) => {
    await page.goto("/login");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Sign in");
    await expect(page.getByRole("button", { name: /demo/i })).toHaveCount(0);
    const text = (await page.locator("body").innerText()).toLowerCase();
    for (const forbidden of ["demonstration", "made-up", "fictional", "demopass", "patient@avela.dev"]) expect(text, forbidden).not.toContain(forbidden);

    expect((await request.post("/api/auth/demo-login", { data: { role: "patient" } })).status()).not.toBe(200);
    expect((await request.get("/api/config")).ok()).toBe(true);
    const config = await (await request.get("/api/config")).json();
    expect(config).not.toHaveProperty("demoMode");
  });

  test("lists no provider that cannot answer, and says so honestly when the directory is empty", async ({ page, request }) => {
    const list = await (await request.get("/api/doctors")).json();
    expect(Array.isArray(list)).toBe(true);
    for (const d of list) expect(d).not.toHaveProperty("isDemoProfile");
    await page.goto("/find-doctors");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Find a doctor");
    if (list.length === 0) {
      await expect(page.getByText(/no doctors|no one|not found|nobody/i).first()).toBeVisible();
    } else {
      await expect(page.getByRole("heading", { level: 2 }).first()).toBeVisible();
    }
  });

  test("offers none of the capabilities that were removed or are not connected", async ({ request }) => {
    for (const [method, path] of [["get", "/api/pharmacy/pharmacies"], ["post", "/api/pharmacy/orders"], ["post", "/api/health-summary/share"], ["post", "/api/ai/chat"], ["post", "/api/speech/transcribe"]] as const) {
      const res = await (request as any)[method](path, { data: {} });
      expect([401, 404], `${method} ${path}`).toContain(res.status());
    }
    const { features } = await (await request.get("/api/config")).json();
    expect(features.videoVisits).toBe(false); // no video provider is connected, so none is offered
    expect(features.smsReminders).toBe(false);
    expect(features.liveSupportChat).toBe(false);
  });

  test("reports reminder delivery honestly, and the two public views agree", async ({ request }) => {
    const { features } = await (await request.get("/api/config")).json();
    const monitor = await request.get("/api/health/scheduler");
    const body = await monitor.json();
    console.log(`reminderDelivery = ${features.reminderDelivery}; monitor ${monitor.status()} ${body.status}`);
    expect(["active", "stale", "failing", "not_configured"]).toContain(features.reminderDelivery);
    expect(body.status).toBe(features.reminderDelivery);
    expect(monitor.status()).toBe(features.reminderDelivery === "active" ? 200 : 503);
  });

  test("keeps an anonymous visitor out of every private interface", async ({ request }) => {
    for (const path of ["/api/auth/me", "/api/appointments", "/api/prescriptions", "/api/pairings", "/api/notifications", "/api/admin/audit", "/api/me/export"]) {
      expect((await request.get(path)).status(), path).toBe(401);
    }
  });
});
