import { expect, type Browser, type Page } from "@playwright/test";

// The seeded demo accounts' password, for signing in to them. It is on the list of passwords Avela refuses for NEW accounts.
export const PASSWORD = "DemoPass123!";
// What test-created accounts use.
export const NEW_PASSWORD = "seven green umbrellas";

/** What the web app sends with every request. Needed for a cookie-authenticated change made from a test. */
export const WEB = { "X-Avela-Client": "web" };

/**
 * Signs in the way the app does: a session cookie in the browser (HttpOnly, so no script can read it) and the
 * profile summary in storage. A second, token-mode sign-in is also made so a test can call the API as this
 * person from another context (`session.token`, a separate device).
 */
export async function signInAs(page: Page, email: string, password = PASSWORD) {
  const api = await page.request.post("/api/auth/login", { data: { email, password } });
  expect(api.ok(), `login for ${email}`).toBeTruthy();
  const body = await api.json();
  const web = await page.request.post("/api/auth/login", { headers: WEB, data: { email, password } });
  expect(web.ok(), `web login for ${email}`).toBeTruthy();
  const { user } = await web.json();
  await page.goto("/login");
  await page.evaluate((u) => localStorage.setItem("pdapp_user", JSON.stringify(u)), user);
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

/** The short welcome shown right after patient sign-up: every step is optional. */
export async function finishWelcome(page: Page) {
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Welcome");
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("button", { name: "Skip for now" }).click();
  await page.getByRole("button", { name: "Go to my home screen" }).click();
}

export async function signUpPatient(page: Page, name: string, email: string, state = "CA") {
  await page.goto("/signup");
  await page.getByLabel("Your name").fill(name);
  await page.getByLabel("Email address").fill(email);
  await page.getByLabel("State where you live").selectOption(state);
  await page.getByLabel("Choose a password", { exact: true }).fill(NEW_PASSWORD);
  await page.getByRole("button", { name: "Create my account" }).click();
  await finishWelcome(page);
  await expect(page.getByRole("heading", { level: 1 })).toContainText(name.split(" ")[0]);
}

const COMPLETE_APPLICATION = {
  displayName: "", professionalRole: "physician", specialty: "Dermatology", state: "CA", licenseNumber: "E2E-1",
  licensingBody: "Medical Board of California", languages: ["en", "ar"], modalities: ["phone", "messaging"], phone: "+1 555 000 4444",
};

/** Registers a doctor and sends a complete application, all through the API. Returns the application id. */
export async function registerDoctorViaApi(page: Page, name: string, email: string, overrides: Record<string, unknown> = {}) {
  const reg = await page.request.post("/api/doctors/register", { data: { name, email, password: NEW_PASSWORD } });
  expect(reg.status()).toBe(201);
  const token = (await reg.json()).token as string; // API sign-up (no X-Avela-Client), so the token is in the body
  const headers = { Authorization: `Bearer ${token}` };
  const save = await page.request.put("/api/doctors/me/application", { headers, data: { ...COMPLETE_APPLICATION, displayName: name, ...overrides } });
  expect(save.status()).toBe(200);
  const sub = await page.request.post("/api/doctors/me/application/submit", { headers });
  expect(sub.status()).toBe(200);
  return { applicationId: (await sub.json()).id as string, token };
}

/** An administrator approves an application, through the API. */
export async function approveViaApi(browser: Browser, applicationId: string) {
  const admin = await newSession(browser, "admin@avela.dev");
  const res = await admin.page.request.post(`/api/admin/doctor-applications/${applicationId}/approve`, { headers: { Authorization: `Bearer ${admin.session.token}` } });
  expect(res.ok()).toBeTruthy();
  await admin.context.close();
}
