/**
 * After rotating a credential, proves the OLD one no longer works. Prints verdicts only, never a value.
 *
 *   OLD_OWNER_DATABASE_URL=… OLD_APP_DATABASE_URL=… OLD_CRON_SECRET=… LIVE_URL=https://… npm run rotation:verify
 *   (give only the ones that were rotated; read them from your private notes, not from the shell history)
 *
 * PASS only for an explicit authentication failure. A network error (a blocked port, a timeout) is INCONCLUSIVE, not a pass: run this from a
 * network that can reach the database. Exit code 1 if any old credential still works.
 */
import "dotenv/config";
import pg from "pg";

let stillWorks = 0;
let inconclusive = 0;

async function database(label: string, url: string | undefined) {
  if (!url) return console.log(`SKIP  ${label} (not given)`);
  const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 10_000 });
  try {
    await client.connect();
    await client.end();
    stillWorks++;
    console.log(`FAIL  ${label}: the OLD credential still connects`);
  } catch (e: any) {
    if (e?.code === "28P01" || e?.code === "28000" || /password authentication failed|authentication failed/i.test(String(e?.message))) console.log(`PASS  ${label}: the old credential is rejected`);
    else {
      inconclusive++;
      console.log(`INCONCLUSIVE  ${label}: could not reach the database (${e?.code ?? e?.name ?? "error"}); this is not evidence the credential is dead`);
    }
  }
}

async function cron(secret: string | undefined, live: string) {
  if (!secret) return console.log("SKIP  scheduler secret (not given)");
  try {
    const res = await fetch(`${live}/api/cron/reminders`, { headers: { Authorization: `Bearer ${secret}` } });
    if (res.status === 401) console.log("PASS  scheduler: the old secret is refused (401)");
    else {
      stillWorks++;
      console.log(`FAIL  scheduler: the old secret got status ${res.status} (anything but 401 means it is still accepted, or the endpoint is not configured)`);
    }
  } catch {
    inconclusive++;
    console.log("INCONCLUSIVE  scheduler: the site could not be reached");
  }
}

async function session(token: string | undefined, live: string) {
  if (!token) return console.log("SKIP  old session token (not given)");
  const res = await fetch(`${live}/api/auth/me`, { headers: { Authorization: `Bearer ${token}` } }).catch(() => null);
  if (!res) { inconclusive++; return console.log("INCONCLUSIVE  session: the site could not be reached"); }
  if (res.status === 401) console.log("PASS  session: the old token is refused (401)");
  else { stillWorks++; console.log(`FAIL  session: the old token got status ${res.status}`); }
}

(async () => {
  const live = (process.env.LIVE_URL ?? "").replace(/\/$/, "");
  await database("old owner database credential", process.env.OLD_OWNER_DATABASE_URL);
  await database("old runtime database credential", process.env.OLD_APP_DATABASE_URL);
  if (live) {
    await cron(process.env.OLD_CRON_SECRET, live);
    await session(process.env.OLD_SESSION_TOKEN, live);
  } else if (process.env.OLD_CRON_SECRET || process.env.OLD_SESSION_TOKEN) console.log("SKIP  scheduler and session checks need LIVE_URL");
  console.log(stillWorks ? `\n${stillWorks} old credential(s) STILL WORK.` : inconclusive ? `\nNothing old still works, but ${inconclusive} check(s) were inconclusive.` : "\nEvery old credential given is dead.");
  process.exit(stillWorks ? 1 : 0);
})();
