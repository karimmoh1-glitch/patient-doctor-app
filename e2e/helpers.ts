import { expect, type Browser, type Page } from "@playwright/test";

export const PASSWORD = "DemoPass123!";

/** Signs in through the API and stores the session the way the app itself does. */
export async function signInAs(page: Page, email: string, password = PASSWORD) {
  const res = await page.request.post("/api/auth/login", { data: { email, password } });
  expect(res.ok(), `login for ${email}`).toBeTruthy();
  const body = await res.json();
  await page.goto("/login");
  await page.evaluate(
    ([token, user]) => localStorage.setItem("pdapp_auth", JSON.stringify({ token, user })),
    [body.token, body.user] as const,
  );
  await page.goto("/");
  return body as { token: string; user: { id: string; name: string; role: string } };
}

export async function newSession(browser: Browser, email: string, viewport = { width: 1280, height: 900 }) {
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  const session = await signInAs(page, email);
  return { context, page, session };
}

export function uniqueEmail(prefix: string) {
  return `${prefix}-${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}@e2e.example`;
}

export async function signUpPatient(page: Page, name: string, email: string, state = "CA") {
  await page.goto("/signup");
  await page.getByLabel("Your name").fill(name);
  await page.getByLabel("Email address").fill(email);
  await page.getByLabel("State where you live").selectOption(state);
  await page.getByLabel("Choose a password", { exact: true }).fill(PASSWORD);
  await page.getByRole("button", { name: "Create my account" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toContainText(name.split(" ")[0]);
}
