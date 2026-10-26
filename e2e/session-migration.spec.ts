import { test, expect } from "@playwright/test";
import { PASSWORD, answerCodeIfAsked } from "./helpers";

// Before sessions lived in an HttpOnly cookie, the app kept the session token in localStorage. Someone
// who is already signed in when this version arrives must not be signed out, and the old token must
// not stay where a script can read it.
test.describe("moving an existing sign-in onto the cookie", () => {
  test("keeps the person signed in, and removes the token from storage", async ({ page }) => {
    const api = await page.request.post("/api/auth/login", { data: { email: "patient@avela.dev", password: PASSWORD } });
    const { token, user } = await api.json();
    await page.goto("/login");
    await page.evaluate(([t, u]) => localStorage.setItem("pdapp_auth", JSON.stringify({ token: t, user: u })), [token, user]);

    await page.goto("/");
    await expect(page.getByRole("heading", { name: /Good (morning|afternoon|evening)/ })).toBeVisible();

    expect(await page.evaluate(() => localStorage.getItem("pdapp_auth"))).toBeNull(); // the token is gone from script reach
    expect(await page.evaluate(() => localStorage.getItem("pdapp_user"))).toContain("patient@avela.dev");
    expect(await page.evaluate(() => document.cookie)).not.toContain("avela_session"); // and the cookie is invisible to script
    const cookie = (await page.context().cookies()).find((c) => /avela_session/.test(c.name));
    expect(cookie?.httpOnly).toBe(true);

    // The screens keep working on the cookie alone.
    await page.goto("/appointments");
    await expect(page.getByRole("heading", { name: "Appointments" })).toBeVisible();
  });

  test("signs out cleanly when the old token is no longer valid", async ({ page }) => {
    await page.goto("/login");
    await page.evaluate(() => localStorage.setItem("pdapp_auth", JSON.stringify({ token: "expired.or.revoked", user: { id: "x", name: "Old", email: "old@example.com", role: "patient", state: "CA" } })));
    await page.goto("/appointments");
    await expect(page).toHaveURL(/\/login/);
    expect(await page.evaluate(() => localStorage.getItem("pdapp_auth"))).toBeNull();
    expect(await page.evaluate(() => localStorage.getItem("pdapp_user"))).toBeNull();
  });

  test("a stored profile without a live session is signed out with the usual explanation", async ({ page }) => {
    await page.goto("/login");
    await page.evaluate(() => localStorage.setItem("pdapp_user", JSON.stringify({ id: "x", name: "Ghost", email: "ghost@example.com", role: "patient", state: "CA" })));
    await page.goto("/appointments");
    await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
    await expect(page.getByRole("status").filter({ hasText: "You were signed out" })).toBeVisible();
  });
});

test.describe("signing out when the server cannot be reached", () => {
  test("is finished as soon as the app is back online, so no live session outlives it", async ({ page, context }) => {
    const { signInAs } = await import("./helpers");
    await signInAs(page, "patient@avela.dev");
    const live = async () => (await context.cookies()).filter((c) => /avela_session/.test(c.name) && c.value).length;
    expect(await live()).toBe(1);

    await context.setOffline(true);
    await page.getByRole("button", { name: "Settings" }).click();
    await page.getByRole("button", { name: "Sign out", exact: true }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Yes, sign me out" }).click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Healthcare, closer to you.");
    // The screen is signed out at once, but the server never heard: the browser still holds the cookie, and says so.
    expect(await live()).toBe(1);
    expect(await page.evaluate(() => localStorage.getItem("pdapp_logout_pending"))).toBe("1");

    await context.setOffline(false);
    await page.reload();
    await expect.poll(live, { timeout: 10_000 }).toBe(0);
    await expect.poll(() => page.evaluate(() => localStorage.getItem("pdapp_logout_pending"))).toBeNull();
  });

  test("a new sign-in is not ended by an older sign-out that was waiting", async ({ page, context }) => {
    const { signInAs } = await import("./helpers");
    await signInAs(page, "patient@avela.dev");
    await context.setOffline(true);
    await page.getByRole("button", { name: "Settings" }).click();
    await page.getByRole("button", { name: "Sign out", exact: true }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Yes, sign me out" }).click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Healthcare, closer to you.");
    await context.setOffline(false);

    await page.goto("/login");
    await page.getByLabel("Email address").fill("doctor@avela.dev");
    await page.getByLabel("Password", { exact: true }).fill("DemoPass123!");
    await page.getByRole("button", { name: "Sign in" }).click();
    await answerCodeIfAsked(page, "doctor@avela.dev");
    await expect(page).not.toHaveURL(/\/login/);
    expect(await page.evaluate(() => localStorage.getItem("pdapp_logout_pending"))).toBeNull();
    await page.reload();
    await expect(page.getByRole("navigation", { name: "Main" }).filter({ visible: true }).first()).toBeVisible(); // still signed in
  });
});
