import { test as base, expect } from "@playwright/test";

/**
 * A failed live check must say WHAT failed, not be waved away as "flaky". After any failure this attaches, per test:
 *  - every request the page made that failed or answered 4xx/5xx or took over 5 s: method, path (no query string, no
 *    headers, no body), status, milliseconds, the host's request id (x-vercel-id) and the browser's failure text;
 *  - a probe of the deployment's own /api/health and of a neutral control host, with timings, taken straight after;
 *  - a verdict: "client-network" (the browser reported a network change or a lost connection, or the control host was
 *    also unreachable), "server" (a 5xx was returned, or the health probe failed while the control host answered),
 *    or "unclassified". Only a verdict of "server" or "unclassified" is a reason to suspect the deployment.
 * Nothing here records a cookie, a token or a page body.
 */
type Seen = { method: string; path: string; status: number | null; ms: number; requestId: string | null; failure: string | null };

const CLIENT_NETWORK = /ERR_NETWORK_CHANGED|ERR_INTERNET_DISCONNECTED|ERR_NAME_NOT_RESOLVED|ERR_NETWORK_IO_SUSPENDED|ERR_CONNECTION_RESET|ERR_ADDRESS_UNREACHABLE/;

async function probe(url: string): Promise<{ url: string; status: number | null; ms: number; requestId: string | null; error: string | null }> {
  const started = Date.now();
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8_000) });
    return { url: new URL(url).origin + new URL(url).pathname, status: res.status, ms: Date.now() - started, requestId: res.headers.get("x-vercel-id"), error: null };
  } catch (e) {
    return { url: new URL(url).origin + new URL(url).pathname, status: null, ms: Date.now() - started, requestId: null, error: String((e as Error).message || e).slice(0, 120) };
  }
}

export const test = base.extend<{ evidence: void }>({
  evidence: [
    async ({ page }, use, testInfo) => {
      const seen: Seen[] = [];
      const started = new Map<unknown, number>();
      page.on("request", (r) => started.set(r, Date.now()));
      page.on("response", (r) => {
        const u = new URL(r.url());
        seen.push({ method: r.request().method(), path: u.pathname, status: r.status(), ms: Date.now() - (started.get(r.request()) ?? Date.now()), requestId: r.headers()["x-vercel-id"] ?? null, failure: null });
      });
      page.on("requestfailed", (r) => {
        const u = new URL(r.url());
        seen.push({ method: r.method(), path: u.pathname, status: null, ms: Date.now() - (started.get(r) ?? Date.now()), requestId: null, failure: r.failure()?.errorText ?? "failed" });
      });
      await use();
      if (testInfo.status === testInfo.expectedStatus) return;
      const notable = seen.filter((s) => s.failure || (s.status !== null && s.status >= 400) || s.ms > 5_000);
      const base = testInfo.project.use.baseURL ?? process.env.LIVE_URL ?? "";
      const health = base ? await probe(new URL("/api/health", base).toString()) : null;
      const control = await probe("https://www.cloudflare.com/cdn-cgi/trace");
      const sawClientNetwork = notable.some((s) => s.failure && CLIENT_NETWORK.test(s.failure)) || (!!control.error && !!health?.error);
      const sawServer = notable.some((s) => s.status !== null && s.status >= 500) || (!!health?.error && !control.error) || (health?.status !== null && (health?.status ?? 0) >= 500);
      const verdict = sawServer ? "server" : sawClientNetwork ? "client-network" : "unclassified";
      await testInfo.attach("failure-evidence.json", {
        body: JSON.stringify({ test: testInfo.title, project: testInfo.project.name, retry: testInfo.retry, verdict, health, control, notableRequests: notable.slice(0, 40) }, null, 2),
        contentType: "application/json",
      });
      console.log(`EVIDENCE [${testInfo.project.name}] ${testInfo.title.slice(0, 70)} => ${verdict}; health ${health?.status ?? health?.error} in ${health?.ms}ms (${health?.requestId ?? "no id"}); control ${control.status ?? control.error}; ${notable.length} notable request(s)`);
    },
    { auto: true },
  ],
});

export { expect };
