import { test, expect } from "@playwright/test";
import { signInAs, newSession, signUpPatient, uniqueEmail, NEW_PASSWORD, WEB } from "./helpers";

test.describe("when things go wrong, the patient is told the truth and can recover", () => {
  test("going offline shows a clear message and a way back — never a blank screen", async ({ page, context }) => {
    await signInAs(page, "patient@avela.dev");
    await expect(page.getByRole("heading", { name: /Good (morning|afternoon|evening)/ })).toBeVisible();

    await context.setOffline(true);

    // A screen that has never been opened needs the network (its code + its data).
    await page.getByRole("navigation", { name: "Main" }).filter({ visible: true }).getByRole("link", { name: /Health/ }).click();
    await expect(page.getByText(/couldn't load this page|offline|No connection/i).first()).toBeVisible();

    await context.setOffline(false);
    await page.getByRole("button", { name: /try again|reload/i }).first().click();
    await expect(page.getByRole("heading", { name: "My health" })).toBeVisible();
  });

  test("a failed data request on an already-open screen offers 'Try again' and recovers", async ({ page, context }) => {
    await signInAs(page, "patient@avela.dev");
    await page.goto("/my-health");
    await expect(page.getByRole("heading", { name: "My health" })).toBeVisible();
    await page.getByRole("link", { name: /Documents/ }).click();
    await expect(page.getByRole("heading", { name: "Documents", level: 1 })).toBeVisible();
    await page.getByRole("link", { name: /^Home$/ }).first().click();

    await context.setOffline(true);
    await page.getByRole("navigation", { name: "Main" }).filter({ visible: true }).getByRole("link", { name: /Doctors/ }).click();
    await expect(page.getByRole("alert").filter({ hasText: /offline|reach the server/i })).toBeVisible();

    await context.setOffline(false);
    await page.getByRole("button", { name: "Try again" }).click();
    await expect(page.getByRole("heading", { name: "My doctors" })).toBeVisible();
    await expect(page.getByText("Dr. Emily Chen").first()).toBeVisible();
  });

  test("a session that ended elsewhere sends the person to sign in, with a plain explanation", async ({ page, browser }) => {
    await signInAs(page, "patient@avela.dev");
    await expect(page.getByRole("heading", { name: /Good (morning|afternoon|evening)/ })).toBeVisible();

    // Signed out from another device (which holds a copy of this session's cookie).
    const cookie = (await page.context().cookies()).find((c) => /avela_session/.test(c.name))!;
    const other = await browser.newContext();
    const res = await other.request.post("/api/auth/logout", { headers: { Cookie: `${cookie.name}=${cookie.value}`, ...WEB }, baseURL: "http://localhost:3101" });
    expect(res.ok()).toBeTruthy();
    await other.close();

    await page.getByRole("navigation", { name: "Main" }).filter({ visible: true }).getByRole("link", { name: /Visits|Appointments/ }).click();
    await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
    await expect(page.getByRole("status").filter({ hasText: "You were signed out" })).toBeVisible();
  });

  test("signing out on a shared phone leaves nothing of the previous person on screen", async ({ page }) => {
    await signInAs(page, "patient@avela.dev");
    await page.goto("/appointments");
    await expect(page.getByText("Two-week follow-up on headaches")).toBeVisible();

    await page.getByRole("button", { name: "Settings" }).click();
    await page.getByRole("button", { name: "Sign out", exact: true }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Yes, sign me out" }).click();
    await expect(page.getByRole("link", { name: "Create an account" }).first()).toBeVisible();

    // The next person on the same device.
    await signUpPatient(page, "Dolores Nwosu", uniqueEmail("dolores"));
    await page.goto("/appointments");
    await expect(page.getByRole("heading", { name: "Appointments" })).toBeVisible();
    await expect(page.getByText("Two-week follow-up on headaches")).toHaveCount(0);
    await expect(page.getByText("Dr. Emily Chen")).toHaveCount(0);
    const stored = await page.evaluate(() => localStorage.getItem("pdapp_user"));
    expect(stored).not.toContain("Margaret");
  });
});

test.describe("large text", () => {
  for (const size of ["large", "xlarge"] as const) {
    test(`at "${size}" text the main screens do not overflow and the key actions stay reachable`, async ({ page }) => {
      await page.addInitScript((s) => localStorage.setItem("pdapp_text_size", s), size);
      await signInAs(page, "patient@avela.dev");
      for (const path of ["/", "/appointments", "/my-health", "/care-team", "/help"]) {
        await page.goto(path);
        await page.waitForLoadState("networkidle");
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        expect(overflow, `${path} scrolls sideways at ${size} text`).toBeLessThanOrEqual(1);
        // Emergency and the four destinations are still on screen.
        await expect(page.getByRole("link", { name: /emergency/i }).first()).toBeVisible();
        const nav = page.getByRole("navigation", { name: "Main" }).filter({ visible: true });
        await expect(nav.getByRole("link")).toHaveCount(4);
        for (const link of await nav.getByRole("link").all()) {
          const box = await link.boundingBox();
          expect(box && box.x >= 0 && box.x + box.width <= (page.viewportSize()?.width ?? 0) + 1, `${path} nav item cut off`).toBeTruthy();
        }
      }
    });
  }

  test("the text size setting is available to a first-time visitor's account and sticks", async ({ page }) => {
    await signInAs(page, "patient@avela.dev");
    await page.getByRole("button", { name: "Settings" }).click();
    await page.getByRole("radio", { name: /Extra large/ }).click();
    const px = await page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).fontSize));
    expect(px).toBeGreaterThan(22);
    await page.reload();
    expect(await page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).fontSize))).toBeGreaterThan(22);
  });
});

test.describe("getting human help", () => {
  test("a patient can find the help page from any screen, and it says exactly what is and isn't staffed", async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem("avela.country", "US")); // the person's own choice of country
    await signInAs(page, "patient@avela.dev");
    await page.goto("/my-health");
    await page.getByRole("link", { name: /^help$/i }).click();
    await expect(page.getByRole("heading", { name: "Help", level: 1 })).toBeVisible();
    await expect(page.getByRole("link", { name: /Call 911 now/ })).toBeVisible();
    // No support number is configured in this environment, and the page must not invent one.
    await expect(page.getByText(/has not set up a support phone line or email yet/)).toBeVisible();
    await expect(page.getByRole("link", { name: /tel:|Call support/ })).toHaveCount(0);
    await expect(page.getByText(/not watched around the clock|aren't watched around the clock/)).toBeVisible();
  });
});

test.describe("account controls in Settings", () => {
  test("sign out everywhere really ends the other session, and closing an account asks for the password again", async ({ page, browser }) => {
    const email = uniqueEmail("controls");
    await signUpPatient(page, "Nadia Controls", email);
    // The session is an HttpOnly cookie: no script on the page can see it, and nothing credential-like is in storage.
    expect(await page.evaluate(() => document.cookie)).not.toContain("avela_session");
    expect(await page.evaluate(() => localStorage.getItem("pdapp_auth"))).toBeNull();
    const cookie = (await page.context().cookies()).find((c) => /avela_session/.test(c.name))!;
    expect(cookie.httpOnly).toBe(true);
    expect(cookie.sameSite).toBe("Strict");
    const stolen = { Cookie: `${cookie.name}=${cookie.value}` }; // what an attacker with a copy of the cookie would send

    // The same person is signed in on a second device.
    const other = await browser.newContext();
    const second = await other.newPage();
    const login = await second.request.post("/api/auth/login", { data: { email, password: NEW_PASSWORD } });
    const secondToken = (await login.json()).token as string;
    expect((await second.request.get("/api/auth/me", { headers: { Authorization: `Bearer ${secondToken}` } })).status()).toBe(200);

    await page.getByRole("button", { name: "Settings" }).click();
    await page.getByRole("button", { name: "Sign out of all devices" }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Yes, sign out everywhere" }).click();
    await expect(page.getByRole("link", { name: "Create an account" }).first()).toBeVisible();
    expect((await second.request.get("/api/auth/me", { headers: { Authorization: `Bearer ${secondToken}` } })).status()).toBe(401);
    expect((await second.request.get("/api/auth/me", { headers: stolen })).status()).toBe(401); // a copied cookie is dead too
    await other.close();

    // Closing an account: a wrong password changes nothing.
    await page.goto("/login");
    await page.getByLabel("Email address").fill(email);
    await page.getByLabel("Password", { exact: true }).fill(NEW_PASSWORD);
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.getByRole("button", { name: "Settings" }).click();
    await page.getByRole("button", { name: "Close my account" }).click();
    await page.getByLabel("Type your password to confirm").fill("not my password");
    await page.getByRole("button", { name: "Yes, close my account" }).click();
    await expect(page.getByText("That password isn't right.")).toBeVisible();
    await page.getByLabel("Type your password to confirm").fill(NEW_PASSWORD);
    await page.getByRole("button", { name: "Yes, close my account" }).click();
    await expect(page.getByRole("link", { name: "Create an account" }).first()).toBeVisible();
    const again = await page.request.post("/api/auth/login", { data: { email, password: NEW_PASSWORD } });
    expect(again.status()).toBe(401);
  });
});

test.describe("emergency information", () => {
  test("a visitor who has not said which country they are in is shown no number, and is asked", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("link", { name: "Choose your country for emergency numbers" })).toBeVisible();
    await expect(page.locator('a[href^="tel:"]')).toHaveCount(0);
    await expect(page.getByText("911")).toHaveCount(0);
    await expect(page.getByText("123")).toHaveCount(0);
  });

  test("the number depends on the country the person chooses, not on their language, with no sign-in", async ({ page }) => {
    await page.goto("/emergency");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Emergency information");
    await expect(page.getByText("Avela is not an emergency service")).toBeVisible();
    await page.getByRole("button", { name: "United States" }).click();
    await expect(page.getByRole("link", { name: /Police, fire and ambulance: 911/ })).toHaveAttribute("href", "tel:911");
    await expect(page.getByRole("link", { name: /Call 911/ }).first()).toHaveAttribute("href", "tel:911");

    // Arabic text, still the United States: an Arabic reader in America gets American numbers.
    await page.getByRole("radio", { name: "العربية" }).first().click();
    await expect(page.getByRole("button", { name: "الولايات المتحدة" })).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByRole("link", { name: /911/ }).first()).toHaveAttribute("href", "tel:911");

    // Egypt, in English: three services, each its own number.
    await page.getByRole("radio", { name: "English" }).first().click();
    await page.getByRole("button", { name: "Egypt" }).click();
    await expect(page.getByRole("link", { name: /Ambulance: 123/ })).toHaveAttribute("href", "tel:123");
    await expect(page.getByRole("link", { name: /Police: 122/ })).toHaveAttribute("href", "tel:122");
    await expect(page.getByRole("link", { name: /Fire: 180/ })).toHaveAttribute("href", "tel:180");
    await expect(page.getByRole("link", { name: /911/ })).toHaveCount(0);
    // Where the numbers come from, and what could not be confirmed, are one tap away.
    await page.getByText("Where these numbers come from").click();
    await expect(page.getByRole("link", { name: /CIA World Factbook/ })).toBeVisible();
    await expect(page.getByText(/No page published by the Egyptian government/)).toBeVisible();
  });

  test("where numbers have not been reviewed by a person, none is shown and the person is told to use their local number", async ({ page }) => {
    await page.route("**/api/config", async (route) => {
      const res = await route.fetch();
      const body = await res.json();
      await route.fulfill({ response: res, json: { ...body, emergency: { ...body.emergency, countries: { EG: { ...body.emergency.countries.EG, reviewed: false, services: null }, US: { ...body.emergency.countries.US, reviewed: false, services: null } } } } });
    });
    await page.goto("/emergency");
    await page.getByRole("button", { name: "Egypt" }).click();
    await expect(page.getByText("has not yet had the emergency numbers for this country reviewed")).toBeVisible();
    await expect(page.locator('a[href^="tel:"]')).toHaveCount(0);
  });
});
