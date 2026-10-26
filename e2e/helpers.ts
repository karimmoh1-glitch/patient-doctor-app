import { expect, type Browser, type Page } from "@playwright/test";
import { codeFor, rememberSecret } from "./mfa";

// The development fixtures' password (e2e database only; production refuses these accounts). It is on the list of passwords Avela refuses for NEW accounts.
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
  let body = await api.json();
  // Clinicians and administrators answer the second factor, through the real endpoint.
  if (body.mfa === "verify") {
    const verified = await page.request.post("/api/auth/mfa/verify", { data: { challenge: body.challenge, code: codeFor(email) } });
    expect(verified.ok(), `second factor for ${email}`).toBeTruthy();
    body = await verified.json();
  }
  expect(body.token, `a session for ${email}`).toBeTruthy();
  // The browser itself holds the session as the HttpOnly cookie: exchange the token once, exactly as the app does for an older session.
  const adopted = await page.request.post("/api/auth/session", { headers: { ...WEB, Authorization: `Bearer ${body.token}` } });
  expect(adopted.ok(), `cookie session for ${email}`).toBeTruthy();
  const { user } = await adopted.json();
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

/** After a password is submitted in the browser: if the code screen appears (clinicians, administrators), answer it. */
export async function answerCodeIfAsked(page: Page, email: string) {
  const codeStep = page.getByRole("heading", { name: "Enter your sign-in code" });
  await expect.poll(async () => (await codeStep.isVisible()) || !/\/login/.test(page.url()), { timeout: 15_000 }).toBe(true);
  if (await codeStep.isVisible()) {
    await page.getByLabel("Six-digit code").fill(codeFor(email));
    await page.getByRole("button", { name: "Continue" }).click();
  }
}

/** On the first-time setup screen: read the key shown, answer with a code, save the recovery codes, continue. */
export async function completeAuthenticatorSetup(page: Page, email: string) {
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Set up your sign-in code");
  await expect(page.getByTestId("mfa-secret")).toBeVisible();
  const secret = (await page.getByTestId("mfa-secret").innerText()).replace(/\s/g, "");
  rememberSecret(email, secret);
  await page.getByLabel("3. Type the six-digit code the app now shows.").fill(codeFor(email));
  await page.getByRole("button", { name: "Finish setting up" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Save your recovery codes");
  await expect(page.getByTestId("recovery-codes").getByRole("listitem")).toHaveCount(10);
  await page.getByLabel("I have saved these codes").check();
  await page.getByRole("button", { name: "Continue" }).click();
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
/** Registers a clinician account and sets up their authenticator, all through the API. No application yet. Returns a session token. */
export async function registerDoctorAccountViaApi(page: Page, name: string, email: string) {
  const reg = await page.request.post("/api/doctors/register", { data: { name, email, password: NEW_PASSWORD } });
  expect(reg.status()).toBe(201);
  // A clinician must set up the second factor before any session exists: do that through the real endpoints.
  const challenge = (await reg.json()).challenge as string;
  const setup = await (await page.request.post("/api/auth/mfa/setup", { data: { challenge } })).json();
  rememberSecret(email, setup.secret);
  const enabled = await page.request.post("/api/auth/mfa/enable", { data: { challenge, code: codeFor(email) } });
  expect(enabled.ok()).toBeTruthy();
  return (await enabled.json()).token as string;
}

export async function registerDoctorViaApi(page: Page, name: string, email: string, overrides: Record<string, unknown> = {}) {
  const token = await registerDoctorAccountViaApi(page, name, email);
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
