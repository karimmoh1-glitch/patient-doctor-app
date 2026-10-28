/**
 * The product journeys, end to end, against a DEPLOYED TEST SITE with synthetic accounts:
 * sign-up, sign-in, doctor discovery, a connection request and its acceptance, messaging, booking a visit, an invitation code, ending a
 * connection (with the explicit choice about booked visits), the password-recovery request, and sign-out; plus a few things that must be refused.
 *
 *   npx tsx ops/staging-journeys.ts https://<test site> --accounts=<the file seed:staging wrote> --state=<a private directory>
 *
 * It CREATES accounts and records on the target, so it refuses any site whose /api/config does not carry an environment notice (that is how a test
 * deployment says it is one). It uses the clinician `doctor.delta@staging.invalid`: on first use it sets up that account's second factor itself and
 * keeps the authenticator secret in --state (mode 600), so keep that account out of testers' hands. Nothing secret is printed.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { totp } from "../server/lib/totp";

const BASE = (process.argv[2] ?? "").replace(/\/$/, "");
const arg = (n: string) => process.argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3);
const accountsFile = arg("accounts");
const stateDir = arg("state");
if (!/^https:\/\//.test(BASE) || !accountsFile || !stateDir) {
  console.error("usage: npx tsx ops/staging-journeys.ts https://<test site> --accounts=<file> --state=<private dir>");
  process.exit(2);
}

const J = { "content-type": "application/json" };
type Res = { status: number; body: any };
const api = async (method: string, p: string, token?: string, body?: unknown): Promise<Res> => {
  const r = await fetch(BASE + p, { method, headers: { ...J, ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let parsed: any = text;
  try { parsed = JSON.parse(text); } catch { /* not JSON */ }
  return { status: r.status, body: parsed };
};

let pass = 0;
const failures: string[] = [];
const step = (name: string, ok: boolean, detail = "") => {
  if (ok) pass++;
  else failures.push(`${name} ${detail}`);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : ` ${detail}`}`);
};

async function main() {
  const cfg = await api("GET", "/api/config");
  if (cfg.status !== 200 || !cfg.body?.environmentNotice) {
    console.error("Refusing: this site does not announce itself as a test site (/api/config has no environmentNotice). Nothing was created.");
    process.exit(2);
  }
  console.log(`Target announces: "${cfg.body.environmentNotice}"`);
  const accounts = Object.fromEntries(
    fs.readFileSync(accountsFile!, "utf8").split("\n").filter((l) => l && !l.startsWith("#")).map((l) => { const [, email, pw] = l.trim().split(/\s+/); return [email, pw]; }),
  );
  fs.mkdirSync(stateDir!, { recursive: true, mode: 0o700 });

  const run = crypto.randomBytes(3).toString("hex");
  const pw = () => crypto.randomBytes(12).toString("base64url") + "aZ9";
  const mkPatient = async (label: string) => {
    const email = `journey-${run}-${label}@staging.invalid`;
    const password = pw();
    const r = await api("POST", "/api/auth/signup", undefined, { name: `Journey ${label} ${run} (synthetic)`, email, password, state: "CA" });
    return { email, password, signup: r, token: r.body?.token as string, id: r.body?.user?.id as string };
  };

  // --- 1. sign-up, sign-in, sign-out, and what is refused
  const alice = await mkPatient("alice");
  step("sign-up creates a patient and signs them in", alice.signup.status === 201 && !!alice.token);
  const dup = await api("POST", "/api/auth/signup", undefined, { name: "x y", email: alice.email, password: pw(), state: "CA" });
  step("sign-up with an address already used is refused", dup.status === 409);
  const weak = await api("POST", "/api/auth/signup", undefined, { name: "Weak Pw", email: `journey-${run}-weak@staging.invalid`, password: "password", state: "CA" });
  step("a weak password is refused", weak.status === 400);
  const bad = await api("POST", "/api/auth/login", undefined, { email: alice.email, password: "not the password at all" });
  step("a wrong password is refused with the same generic answer", bad.status === 401);
  const login = await api("POST", "/api/auth/login", undefined, { email: alice.email, password: alice.password });
  step("sign-in with the right password works", login.status === 200 && !!login.body?.token);
  const t = login.body.token as string;
  step("a signed-out visitor cannot read a patient's data", (await api("GET", "/api/pairings")).status === 401);
  step("a patient cannot reach clinician endpoints", [401, 403].includes((await api("GET", "/api/pairings/doctor", t)).status));

  // --- 2. discovery
  const dir = await api("GET", "/api/doctors");
  const delta = Array.isArray(dir.body) ? dir.body.find((d: any) => /Delta/.test(d.name)) : null;
  step("the directory lists clinicians without signing in", dir.status === 200 && Array.isArray(dir.body) && dir.body.length >= 1, `(status ${dir.status})`);
  step("a directory entry carries no private contact details", !!delta && !("phone" in delta) && !("licenseNumber" in delta) && !("email" in delta));
  if (!delta) { console.log("cannot continue without the directory entry"); return finish(); }

  // --- 3. the clinician signs in (setting up the authenticator once) and the connection is made
  const dEmail = "doctor.delta@staging.invalid";
  const secretFile = path.join(stateDir!, "delta-authenticator");
  const first = await api("POST", "/api/auth/login", undefined, { email: dEmail, password: accounts[dEmail] });
  let doctorToken = "";
  if (first.body?.mfa === "setup") {
    const setup = await api("POST", "/api/auth/mfa/setup", undefined, { challenge: first.body.challenge });
    fs.writeFileSync(secretFile, setup.body.secret, { mode: 0o600 });
    const enabled = await api("POST", "/api/auth/mfa/enable", undefined, { challenge: first.body.challenge, code: totp(setup.body.secret) });
    doctorToken = enabled.body?.token ?? "";
    step("a clinician is made to set up a second factor at first sign-in, and recovery codes are issued", enabled.status === 200 && Array.isArray(enabled.body?.recoveryCodes) && enabled.body.recoveryCodes.length > 0);
  } else if (first.body?.mfa === "verify") {
    const verified = await api("POST", "/api/auth/mfa/verify", undefined, { challenge: first.body.challenge, code: totp(fs.readFileSync(secretFile, "utf8").trim()) });
    doctorToken = verified.body?.token ?? "";
    step("a clinician with a second factor must answer it, and does", verified.status === 200 && !!doctorToken);
  } else step("clinician sign-in answers with a second-factor step", false, `(${first.status})`);
  if (!doctorToken) return finish();
  const wrongCode = await api("POST", "/api/auth/login", undefined, { email: dEmail, password: accounts[dEmail] });
  if (wrongCode.body?.mfa === "verify") {
    const r = await api("POST", "/api/auth/mfa/verify", undefined, { challenge: wrongCode.body.challenge, code: "000000" });
    step("a wrong second-factor code is refused", r.status === 401);
  }

  const pair = await api("POST", "/api/pairings", t, { doctorProfileId: delta.id });
  step("a patient can ask a clinician to connect", pair.status === 201 && !!pair.body?.id, `(${pair.status})`);
  const pairingId = pair.body?.id as string;
  const early = await api("POST", `/api/pairings/${pairingId}/messages`, t, { body: "hello before accepting" });
  step("messaging is refused until the clinician accepts", early.status === 403);
  const queue = await api("GET", "/api/pairings/doctor", doctorToken);
  step("the clinician sees the request", queue.status === 200 && JSON.stringify(queue.body).includes(pairingId));
  const acc = await api("PATCH", `/api/pairings/${pairingId}/accept`, doctorToken);
  step("the clinician accepts", acc.status === 200, `(${acc.status})`);

  // --- 4. messaging
  const m1 = await api("POST", `/api/pairings/${pairingId}/messages`, t, { body: "Hello doctor, this is a synthetic test message." });
  step("the patient sends a message", m1.status === 201 || m1.status === 200, `(${m1.status})`);
  const m2 = await api("POST", `/api/pairings/${pairingId}/messages`, doctorToken, { body: "Hello, this is a synthetic reply." });
  step("the clinician replies", m2.status === 201 || m2.status === 200, `(${m2.status})`);
  const thread = await api("GET", `/api/pairings/${pairingId}/messages`, t);
  step("the patient reads both messages", thread.status === 200 && JSON.stringify(thread.body).includes("synthetic reply") && JSON.stringify(thread.body).includes("synthetic test message"));
  const outsider = await mkPatient("mallory");
  const peek = await api("GET", `/api/pairings/${pairingId}/messages`, outsider.token);
  step("a third person cannot read the conversation", peek.status === 404 || peek.status === 403);

  // --- 5. booking
  const slots = await api("GET", `/api/appointments/slots?pairingRequestId=${pairingId}&days=14`, t);
  const slot = slots.body?.slots?.[0];
  step("open times are offered for a connected clinician", slots.status === 200 && !!slot, `(${slots.status})`);
  const book = await api("POST", "/api/appointments", t, { pairingRequestId: pairingId, type: "Phone Call", reason: "Synthetic test visit", scheduledAt: slot });
  step("a visit can be booked", book.status === 201, `(${book.status} ${JSON.stringify(book.body).slice(0, 80)})`);
  const again = await api("POST", "/api/appointments", outsider.token, { pairingRequestId: pairingId, type: "Phone Call", reason: "Synthetic hijack attempt", scheduledAt: slot });
  step("an unconnected person cannot book through someone else's connection", again.status === 404 || again.status === 403);
  const conf = await api("PATCH", `/api/appointments/${book.body?.id}/confirm`, doctorToken);
  step("the clinician confirms the visit", conf.status === 200, `(${conf.status})`);

  // --- 6. invitation redemption (a clinician's code, redeemed by a second patient)
  const bob = await mkPatient("bob");
  const inv = await api("POST", "/api/pairing-invitations", doctorToken);
  step("a clinician can create an invitation code", inv.status === 201 && !!inv.body?.code);
  const prev = await api("POST", "/api/pairing-invitations/preview", bob.token, { code: inv.body?.code });
  step("the patient can look at who a code is from before agreeing", prev.status === 200);
  const noConfirm = await api("POST", "/api/pairing-invitations/accept", bob.token, { code: inv.body?.code });
  step("redeeming needs an explicit yes", noConfirm.status === 400);
  const redeem = await api("POST", "/api/pairing-invitations/accept", bob.token, { code: inv.body?.code, confirm: true });
  step("the code connects the patient", redeem.status === 201 || redeem.status === 200, `(${redeem.status})`);
  const reuse = await api("POST", "/api/pairing-invitations/accept", outsider.token, { code: inv.body?.code, confirm: true });
  step("the same code cannot be used by someone else", reuse.status >= 400);

  // --- 7. ending a connection
  const endNoChoice = await api("PATCH", `/api/pairings/${pairingId}/end`, t, {});
  step("ending with a booked visit requires an explicit choice", endNoChoice.status === 409 && endNoChoice.body?.code === "decide_upcoming_visits", `(${endNoChoice.status})`);
  const end = await api("PATCH", `/api/pairings/${pairingId}/end`, t, { upcomingVisits: "cancel" });
  step("ending with 'cancel the visits' succeeds", end.status === 200, `(${end.status})`);
  const after = await api("POST", `/api/pairings/${pairingId}/messages`, t, { body: "after the end" });
  step("messaging stops once the connection has ended", after.status === 403 || after.status === 404);
  const visit = await api("GET", `/api/appointments/${book.body?.id}`, t);
  step("the booked visit was cancelled by that choice", visit.status === 200 && /cancel/i.test(JSON.stringify(visit.body.status ?? visit.body)));

  // --- 8. password recovery, as far as a test site without e-mail can go
  const known = await api("POST", "/api/auth/forgot-password", undefined, { email: alice.email });
  const unknown = await api("POST", "/api/auth/forgot-password", undefined, { email: `nobody-${run}@staging.invalid` });
  step("asking for a reset answers the same for a known and an unknown address", known.status === unknown.status && JSON.stringify(known.body) === JSON.stringify(unknown.body), `(${known.status}/${unknown.status})`);
  const badToken = await api("POST", "/api/auth/reset-password", undefined, { token: "x".repeat(40), password: pw() });
  step("a made-up reset link is refused", badToken.status >= 400 && badToken.status < 500);

  // --- 9. sign-out
  const out = await api("POST", "/api/auth/logout", t);
  step("sign-out works", out.status === 200);
  step("the signed-out session no longer works", (await api("GET", "/api/auth/me", t)).status === 401);
  step("another person's session is unaffected", (await api("GET", "/api/auth/me", bob.token)).status === 200);

  console.log(`\nSynthetic accounts left on the test site: journey-${run}-{alice,bob,mallory}@staging.invalid (passwords not kept)`);
  finish();
}

function finish() {
  console.log(`\n${pass} passed, ${failures.length} failed`);
  if (failures.length) console.log(failures.map((f) => `  - ${f}`).join("\n"));
  process.exit(failures.length ? 1 : 0);
}

main().catch((e) => {
  console.error(`journeys failed: ${String(e?.message ?? e)}`);
  process.exit(1);
});
