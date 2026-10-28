/**
 * Many synthetic users, interleaved, against a DEPLOYED TEST SITE (the real hosting platform and the real database pooler). Every response must be about
 * the requester and nobody else: the identity of each request, the contents of each person's list, and a read of someone else's record.
 *
 *   npx tsx ops/http-isolation.ts https://<test site>
 *
 * It creates 12 synthetic patients (addresses @staging.invalid) and a document each on the target, so it refuses any site whose /api/config carries no
 * environment notice (how a test deployment announces itself). Prints counts only. Exit code 1 if any response was about someone else.
 */
import crypto from "node:crypto";
const BASE = (process.argv[2] ?? "").replace(/\/$/, "");
if (!/^https:\/\//.test(BASE)) { console.error("usage: npx tsx ops/http-isolation.ts https://<test site>"); process.exit(2); }
{
  const cfg = await fetch(BASE + "/api/config").then((r) => r.json()).catch(() => null);
  if (!cfg?.environmentNotice) { console.error("Refusing: this site does not announce itself as a test site. Nothing was created."); process.exit(2); }
}
const K = 12, ROUNDS = 125, WIDTH = 12;
const rnd = crypto.randomBytes(3).toString("hex");
const J = { "content-type": "application/json" };
const users: any[] = [];
const stats = { requests: 0, wrongIdentity: 0, leakedDocs: 0, crossAccountAllowed: 0, serverErrors: 0, other: [] as string[] };
const lat: number[] = [];
const call = async (path: string, o: any = {}) => { const t = Date.now(); const r = await fetch(BASE + path, o); lat.push(Date.now() - t); stats.requests++; if (r.status >= 500) stats.serverErrors++; return r; };

for (let i = 0; i < K; i++) {
  const password = crypto.randomBytes(12).toString("base64url") + "aZ9";
  const email = `iso-${rnd}-${i}@staging.invalid`;
  const r = await fetch(BASE + "/api/auth/signup", { method: "POST", headers: J, body: JSON.stringify({ name: `Isolation Tester ${rnd}-${i} (synthetic)`, email, password, state: "CA" }) });
  if (r.status !== 201) { console.log(`signup ${i} failed: ${r.status} ${(await r.text()).slice(0, 120)}`); process.exit(1); }
  const { token, user } = await r.json();
  const auth = { authorization: `Bearer ${token}` };
  const d = await fetch(BASE + "/api/documents", { method: "POST", headers: { ...J, ...auth }, body: JSON.stringify({ title: `iso-${rnd}-${i}`, notes: `private note of ${i}` }) });
  if (d.status >= 300) { console.log(`doc ${i} failed: ${d.status}`); process.exit(1); }
  users.push({ i, id: user.id, token, auth, email, password, docId: (await d.json()).id });
}
console.log(`created ${K} synthetic patients with one private document each`);

const one = async (u: any, kind: number) => {
  if (kind === 0) { const r = await call("/api/auth/me", { headers: u.auth }); const b = await r.json(); if (r.status !== 200 || b.id !== u.id && b.user?.id !== u.id) { stats.wrongIdentity++; stats.other.push(`me ${u.i} -> ${r.status}`); } }
  else if (kind === 1) { const r = await call("/api/documents", { headers: u.auth }); const b = await r.json(); if (r.status !== 200 || !Array.isArray(b)) { stats.other.push(`docs ${u.i} -> ${r.status}`); return; } if (b.some((x) => x.title !== `iso-${rnd}-${u.i}`)) stats.leakedDocs++; if (!b.some((x) => x.id === u.docId)) stats.other.push(`own doc missing for ${u.i}`); }
  else if (kind === 2) { const v = users[(u.i + 1 + Math.floor(Math.random() * (K - 1))) % K]; const r = await call(`/api/documents/${v.docId}`, { headers: u.auth }); if (r.status === 200) { const t = await r.text(); if (t.includes(`iso-${rnd}-${v.i}`)) stats.crossAccountAllowed++; } }
  else { const r = await call("/api/doctors"); if (r.status !== 200) stats.other.push(`anon doctors -> ${r.status}`); }
};
const t0 = Date.now();
for (let round = 0; round < ROUNDS; round++) {
  await Promise.all(Array.from({ length: WIDTH }, (_, w) => one(users[(round * 5 + w) % K], (round + w) % 4)));
}
// logout invalidates only that session
const lo = await call("/api/auth/logout", { method: "POST", headers: users[0].auth });
const after = await call("/api/auth/me", { headers: users[0].auth });
const still = await call("/api/auth/me", { headers: users[1].auth });
lat.sort((a, b) => a - b);
const p = (q: number) => lat[Math.min(lat.length - 1, Math.floor(q * lat.length))];
console.log(`${stats.requests} requests in ${((Date.now() - t0) / 1000).toFixed(1)}s | wrong identity ${stats.wrongIdentity} | another's document leaked into a list ${stats.leakedDocs} | cross-account read allowed ${stats.crossAccountAllowed} | 5xx ${stats.serverErrors}`);
console.log(`logout ${lo.status}; the logged-out token then gets ${after.status}; another user's token still gets ${still.status}`);
console.log(`client-side latency ms (my network included): p50 ${p(0.5)} p95 ${p(0.95)} max ${lat[lat.length - 1]}`);
if (stats.other.length) console.log("other notes:", stats.other.slice(0, 5));
process.exit(stats.wrongIdentity || stats.leakedDocs || stats.crossAccountAllowed ? 1 : 0);
