// Avela reminder scheduler: a Cloudflare Worker with a Cron Trigger.
//
// Why this exists: GitHub Actions `schedule` is best-effort (delayed or skipped under
// load) and Vercel's free plan runs a cron at most once a day. A Cloudflare Cron Trigger
// fires every minute on the free plan and has no such caveat. This Worker's only job is
// to call Avela's authenticated endpoint on time, retry briefly, and fail LOUDLY, so the
// failure is visible in Cloudflare and (optionally) in a webhook, never silent.
//
// Secrets (set with `wrangler secret put`, never committed):
//   CRON_SECRET   the value of the host's CRON_SECRET_CLOUDFLARE (not CRON_SECRET: only that secret is recorded as the dependable scheduler)
// Variables (wrangler.toml [vars], not secret):
//   AVELA_URL     e.g. https://avela-taupe.vercel.app
// Optional secret:
//   FAILURE_WEBHOOK_URL   an https endpoint that is POSTed {"event":"scheduler_failed","attempts":n,"status":n}
//                         after the last attempt fails (Slack-compatible incoming webhooks accept this shape via "text").

const ATTEMPTS = 3;
const ATTEMPT_TIMEOUT_MS = 25_000; // Avela's own time budget is 20 s; the function limit is 30 s.
const BACKOFF_MS = [0, 4_000, 10_000];

/** Calls the reminder endpoint, retrying a failed attempt. Resolves with a summary; rejects only after the last attempt. */
export async function callAvela(env, { fetchImpl = fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  if (!env.AVELA_URL || !env.CRON_SECRET) {
    throw new Error("AVELA_URL and CRON_SECRET must both be configured");
  }
  // The secret travels in a header: never to anything but https.
  if (!/^https:\/\//i.test(String(env.AVELA_URL))) throw new Error("AVELA_URL must be an https address");
  const url = `${String(env.AVELA_URL).replace(/\/+$/, "")}/api/cron/reminders`;
  let lastStatus = 0;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    if (BACKOFF_MS[attempt - 1]) await sleep(BACKOFF_MS[attempt - 1]);
    try {
      const res = await fetchImpl(url, {
        method: "GET",
        headers: { Authorization: `Bearer ${env.CRON_SECRET}`, "X-Avela-Scheduler": "cloudflare-worker" },
        signal: AbortSignal.timeout(ATTEMPT_TIMEOUT_MS),
        redirect: "error",
      });
      lastStatus = res.status;
      // 200: ran. 202: another run was already in progress (fine: someone else is doing the work).
      if (res.status === 200 || res.status === 202) return { ok: true, status: res.status, attempt };
      // A wrong or missing secret will not fix itself on retry.
      if (res.status === 401 || res.status === 503) break;
    } catch {
      lastStatus = 0; // network error or timeout
    }
  }
  const failure = new Error(`Avela reminder call failed (last status ${lastStatus || "no response"})`);
  failure.status = lastStatus;
  throw failure;
}

async function notifyFailure(env, err, { fetchImpl = fetch } = {}) {
  if (!env.FAILURE_WEBHOOK_URL) return;
  try {
    await fetchImpl(env.FAILURE_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ event: "scheduler_failed", status: err.status ?? 0, text: "Avela reminder scheduler failed" }),
      signal: AbortSignal.timeout(5_000),
    });
  } catch {
    // The webhook is a courtesy; the failed invocation is already recorded by Cloudflare.
  }
}

export default {
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(
      callAvela(env).catch(async (err) => {
        await notifyFailure(env, err);
        throw err; // marks the invocation as failed in Cloudflare
      }),
    );
  },
  // No public behaviour: a request to the Worker's URL reveals nothing and triggers nothing.
  async fetch() {
    return new Response("Not found", { status: 404 });
  },
};

export { notifyFailure };
