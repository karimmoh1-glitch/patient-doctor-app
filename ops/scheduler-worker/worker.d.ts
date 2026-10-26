export function callAvela(
  env: { AVELA_URL?: string; CRON_SECRET?: string },
  opts?: { fetchImpl?: typeof fetch; sleep?: (ms: number) => Promise<void> },
): Promise<{ ok: true; status: number; attempt: number }>;
export function notifyFailure(env: { FAILURE_WEBHOOK_URL?: string }, err: { status?: number }, opts?: { fetchImpl?: typeof fetch }): Promise<void>;
declare const worker: {
  scheduled(event: unknown, env: Record<string, string | undefined>, ctx: { waitUntil(p: Promise<unknown>): void }): Promise<void>;
  fetch(): Promise<Response>;
};
export default worker;
