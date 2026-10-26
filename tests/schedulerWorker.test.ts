import { describe, it, expect, vi } from "vitest";
import worker, { callAvela, notifyFailure } from "../ops/scheduler-worker/worker.js";

// The Worker runs on Cloudflare, not here, but its logic is plain and is tested here with a stand-in
// network. Nothing in this file contacts any real service.
const env = { AVELA_URL: "https://avela.example.test/", CRON_SECRET: "worker-test-secret-value" };
const noSleep = async () => {};
const respond = (status: number) => ({ status, ok: status >= 200 && status < 300 }) as Response;

describe("the external scheduler", () => {
  it("calls the endpoint once, with the bearer secret and its name, and no double slash in the address", async () => {
    const fetchImpl = vi.fn(async () => respond(200));
    const out = await callAvela(env, { fetchImpl: fetchImpl as any, sleep: noSleep });
    expect(out).toMatchObject({ ok: true, status: 200, attempt: 1 });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://avela.example.test/api/cron/reminders");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer worker-test-secret-value");
    expect((init.headers as Record<string, string>)["X-Avela-Scheduler"]).toBe("cloudflare-worker");
    expect(init.redirect).toBe("error"); // never follow a redirect with the secret attached
  });

  it("treats 'already running' (202) as success", async () => {
    const fetchImpl = vi.fn(async () => respond(202));
    expect((await callAvela(env, { fetchImpl: fetchImpl as any, sleep: noSleep })).status).toBe(202);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("retries a server error and a network error, then succeeds", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(respond(500))
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(respond(200));
    const out = await callAvela(env, { fetchImpl: fetchImpl as any, sleep: noSleep });
    expect(out.attempt).toBe(3);
  });

  it("gives up after three attempts and fails loudly, without putting the secret in the error", async () => {
    const fetchImpl = vi.fn(async () => respond(500));
    const err = await callAvela(env, { fetchImpl: fetchImpl as any, sleep: noSleep }).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.status).toBe(500);
    expect(err.message).not.toContain("worker-test-secret-value");
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("does not hammer the endpoint with a secret it already rejected", async () => {
    for (const status of [401, 503]) {
      const fetchImpl = vi.fn(async () => respond(status));
      await expect(callAvela(env, { fetchImpl: fetchImpl as any, sleep: noSleep })).rejects.toMatchObject({ status });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    }
  });

  it("refuses to run unconfigured instead of calling a wrong address", async () => {
    const fetchImpl = vi.fn();
    await expect(callAvela({ AVELA_URL: env.AVELA_URL }, { fetchImpl: fetchImpl as any })).rejects.toThrow(/must both be configured/);
    await expect(callAvela({ CRON_SECRET: env.CRON_SECRET }, { fetchImpl: fetchImpl as any })).rejects.toThrow(/must both be configured/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("waits between attempts rather than retrying instantly", async () => {
    const waits: number[] = [];
    const fetchImpl = vi.fn(async () => respond(500));
    await callAvela(env, { fetchImpl: fetchImpl as any, sleep: async (ms) => void waits.push(ms) }).catch(() => {});
    expect(waits.length).toBe(2);
    expect(waits.every((ms) => ms > 0)).toBe(true);
  });

  it("tells a failure webhook, if one is configured, and survives the webhook being down", async () => {
    const calls: { url: string; body: string }[] = [];
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => { calls.push({ url, body: String(init.body) }); return respond(200); });
    await notifyFailure({ FAILURE_WEBHOOK_URL: "https://hooks.example.test/x" }, { status: 500 }, { fetchImpl: fetchImpl as any });
    expect(calls).toHaveLength(1);
    expect(JSON.parse(calls[0].body)).toMatchObject({ event: "scheduler_failed", status: 500 });
    expect(calls[0].body).not.toContain("secret");

    await expect(notifyFailure({ FAILURE_WEBHOOK_URL: "https://hooks.example.test/x" }, {}, { fetchImpl: (async () => { throw new Error("down"); }) as any })).resolves.toBeUndefined();
    const none = vi.fn();
    await notifyFailure({}, {}, { fetchImpl: none as any });
    expect(none).not.toHaveBeenCalled();
  });

  it("answers any web request with 404 and does nothing", async () => {
    const res = await worker.fetch();
    expect(res.status).toBe(404);
  });
});
