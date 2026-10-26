import request from "supertest";
import type { Express } from "express";
import crypto from "crypto";
import { createApiApp } from "../server/app";

let cached: Express | null = null;

export async function getApp(): Promise<Express> {
  if (!cached) cached = (await createApiApp()).app;
  return cached;
}

export const PASSWORD = "CorrectHorse-9";

export function uniqueEmail(prefix: string): string {
  return `${prefix}-${crypto.randomBytes(5).toString("hex")}@test.example`;
}

export interface TestUser {
  id: string;
  email: string;
  token: string;
}

export async function signupPatient(overrides: Partial<{ name: string; state: string }> = {}): Promise<TestUser> {
  const app = await getApp();
  const email = uniqueEmail("patient");
  const res = await request(app)
    .post("/api/auth/signup")
    .send({ name: overrides.name ?? "Test Patient", email, password: PASSWORD, state: overrides.state ?? "CA" });
  if (res.status !== 201) throw new Error(`signup failed: ${res.status} ${JSON.stringify(res.body)}`);
  return { id: res.body.user.id, email, token: res.body.token };
}

export function auth(token: string): { Authorization: string } {
  return { Authorization: `Bearer ${token}` };
}

import bcrypt from "bcryptjs";
import { storage } from "../server/storage";
import { totp } from "../server/lib/totp";

const TEST_HASH = bcrypt.hashSync(PASSWORD, 4);

// Clinicians and administrators sign in with a second factor. The suite does it through the REAL endpoints (set up an
// authenticator on first sign-in, then answer with a current code), keeping each account's secret for next time.
const authenticatorSecrets = new Map<string, string>(); // email -> secret
export const authenticatorSecretFor = (email: string) => authenticatorSecrets.get(email.toLowerCase());

/** Finishes a password sign-in that asked for a second factor; returns the final session response body. */
export async function completeSecondFactor(body: any, email: string, extra: Record<string, string> = {}): Promise<any> {
  if (!body?.mfa) return body;
  const app = await getApp();
  const key = email.toLowerCase();
  if (body.mfa === "setup") {
    const setup = await request(app).post("/api/auth/mfa/setup").set(extra).send({ challenge: body.challenge });
    if (setup.status !== 200) throw new Error(`mfa setup failed: ${setup.status} ${JSON.stringify(setup.body)}`);
    authenticatorSecrets.set(key, setup.body.secret);
    const enabled = await request(app).post("/api/auth/mfa/enable").set(extra).send({ challenge: body.challenge, code: totp(setup.body.secret) });
    if (enabled.status !== 200) throw new Error(`mfa enable failed: ${enabled.status} ${JSON.stringify(enabled.body)}`);
    return enabled.body;
  }
  const secret = authenticatorSecrets.get(key);
  if (!secret) throw new Error(`no authenticator secret known for ${email}`);
  const verified = await request(app).post("/api/auth/mfa/verify").set(extra).send({ challenge: body.challenge, code: totp(secret) });
  if (verified.status !== 200) throw new Error(`mfa verify failed: ${verified.status} ${JSON.stringify(verified.body)}`);
  return verified.body;
}

/** Signs in with the password and, if asked, the second factor. Returns the whole session response. */
export async function signIn(email: string, password = PASSWORD, extra: Record<string, string> = {}): Promise<any> {
  const app = await getApp();
  const res = await request(app).post("/api/auth/login").set(extra).send({ email, password });
  if (res.status !== 200) throw new Error(`login failed: ${res.status} ${JSON.stringify(res.body)}`);
  return completeSecondFactor(res.body, email, extra);
}

async function login(email: string): Promise<string> {
  return (await signIn(email)).token;
}

export interface TestDoctor extends TestUser {
  profileId: string;
}

export async function createDoctor(opts: { state?: string; specialty?: string; name?: string } = {}): Promise<TestDoctor> {
  const email = uniqueEmail("doctor");
  const user = await storage.createUser({
    name: opts.name ?? "Dr. Test",
    email,
    passwordHash: TEST_HASH,
    role: "doctor",
    state: opts.state ?? "CA",
    phone: null,
    deactivatedAt: null,
    emailVerifiedAt: null,
  });
  const profile = await storage.createDoctorProfile({
    userId: user.id,
    name: opts.name ?? "Dr. Test",
    specialty: opts.specialty ?? "Family Medicine",
    state: opts.state ?? "CA",
    licenseNumber: "TEST-1",
    npiNumber: null,
    phone: "+15550001111",
    bio: null,
    active: true,
    source: "seed",
  });
  return { id: user.id, email, token: await login(email), profileId: profile.id };
}

export async function createAdmin(): Promise<TestUser> {
  const email = uniqueEmail("admin");
  const user = await storage.createUser({
    name: "Test Admin",
    email,
    passwordHash: TEST_HASH,
    role: "admin",
    state: null,
    phone: null,
    deactivatedAt: null,
    emailVerifiedAt: null,
  });
  return { id: user.id, email, token: await login(email) };
}

export async function createCaregiverAccount(): Promise<TestUser> {
  const email = uniqueEmail("caregiver");
  const user = await storage.createUser({
    name: "Test Caregiver",
    email,
    passwordHash: TEST_HASH,
    role: "caregiver",
    state: null,
    phone: null,
    deactivatedAt: null,
    emailVerifiedAt: null,
  });
  return { id: user.id, email, token: await login(email) };
}

/** Patient requests a doctor (optionally with a symptom report), and the doctor accepts. */
export async function connect(patient: TestUser, doctor: TestDoctor, opts: { accept?: boolean } = {}) {
  const app = await getApp();
  const report = await request(app)
    .post("/api/symptom-reports")
    .set(auth(patient.token))
    .send({ symptomText: "I have had a persistent cough and mild fever", inputMethod: "typed" });
  if (report.status !== 201) throw new Error(`report failed: ${report.status} ${JSON.stringify(report.body)}`);
  const pairing = await request(app)
    .post("/api/pairings")
    .set(auth(patient.token))
    .send({ doctorProfileId: doctor.profileId, symptomReportId: report.body.id });
  if (pairing.status !== 201) throw new Error(`pairing failed: ${pairing.status} ${JSON.stringify(pairing.body)}`);
  if (opts.accept !== false) {
    const accepted = await request(app).patch(`/api/pairings/${pairing.body.id}/accept`).set(auth(doctor.token));
    if (accepted.status !== 200) throw new Error(`accept failed: ${accepted.status}`);
  }
  return { pairingId: pairing.body.id as string, symptomReportId: report.body.id as string };
}

/** A complete, valid prescription body; override fields as needed. */
export function prescriptionBody(pairingRequestId: string, overrides: Record<string, unknown> = {}) {
  return {
    pairingRequestId,
    medicationName: "Demo Tablet",
    dose: "1 tablet",
    route: "oral",
    frequencyPerDay: 1,
    instructions: "One daily with water",
    controlledSubstance: false,
    ...overrides,
  };
}

/** Drafts and then authorizes a prescription as the doctor; returns the authorized record. */
export async function issuePrescription(doctor: TestUser, pairingRequestId: string, overrides: Record<string, unknown> = {}) {
  const app = await getApp();
  const draft = await request(app).post("/api/prescriptions").set(auth(doctor.token)).send(prescriptionBody(pairingRequestId, overrides));
  if (draft.status !== 201) throw new Error(`draft failed: ${draft.status} ${JSON.stringify(draft.body)}`);
  const authorized = await request(app).post(`/api/prescriptions/${draft.body.id}/authorize`).set(auth(doctor.token)).send({ confirm: true });
  if (authorized.status !== 200) throw new Error(`authorize failed: ${authorized.status} ${JSON.stringify(authorized.body)}`);
  return authorized.body as { id: string; status: string; [k: string]: any };
}

/** What an administrator must supply to approve a clinician: how the licence was checked, what was seen, and its expiry. */
export const APPROVAL = {
  verification: {
    source: "document_review" as const,
    evidenceNote: "Licence certificate sighted; number matches the application.",
    expiresAt: new Date(Date.now() + 365 * 86_400_000).toISOString(),
  },
};

/** An organization staff account (its own kind of account, second factor like a clinician). Not yet a member of anything. */
export async function createStaff(name = "Test Staff"): Promise<TestUser> {
  const email = uniqueEmail("staff");
  const user = await storage.createUser({ name, email, passwordHash: TEST_HASH, role: "staff", state: null, phone: null, deactivatedAt: null, emailVerifiedAt: new Date() } as any);
  return { id: user.id, email, token: await login(email) };
}
