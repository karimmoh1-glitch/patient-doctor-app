import crypto from "crypto";
import { MemoryStore, type ClientRateLimitInfo, type Options, type Store } from "express-rate-limit";
import { pool } from "../db";
import { runAsSystem } from "../dbContext";

// The counters belong to the server alone (row-level security gives nobody else any access), and the limiter runs before
// anyone is signed in, so every statement here says so explicitly.
const q = (text: string, params?: unknown[]) => runAsSystem(() => pool.query(text, params), "ratelimit");

/**
 * A rate-limit store in Postgres, so the limit holds across every server
 * instance (Vercel starts as many as it likes; each keeps its own memory).
 *
 * - One atomic upsert per hit, timed by the database's clock so instances with
 *   skewed clocks still agree on when a window ends.
 * - Keys are hashed with the limiter's name, so no address or e-mail is stored.
 * - If the database cannot be reached the limiter degrades to a per-instance
 *   memory counter instead of failing the request (and logs the kind of error,
 *   at most once a minute). A limiter that locked everyone out whenever the
 *   database blinked would be a self-inflicted outage.
 */
export class PgRateLimitStore implements Store {
  private windowMs = 60_000;
  private readonly fallback = new MemoryStore();
  private lastWarn = 0;
  localKeys = false;

  constructor(private readonly name: string) {}

  init(options: Options) {
    this.windowMs = options.windowMs;
    this.fallback.init(options);
  }

  private key(raw: string) {
    return crypto.createHash("sha256").update(`${this.name}\u0000${raw}`).digest("hex");
  }

  private warn(err: any) {
    const now = Date.now();
    if (now - this.lastWarn < 60_000) return;
    this.lastWarn = now;
    console.error("[rate-limit] shared store unavailable, using this instance's memory:", err?.code || err?.name || "Error");
  }

  async increment(raw: string): Promise<ClientRateLimitInfo> {
    try {
      const { rows } = await q(
        `INSERT INTO rate_limit_hits AS r (key, hits, reset_at)
         VALUES ($1, 1, now() + make_interval(secs => $2))
         ON CONFLICT (key) DO UPDATE SET
           hits = CASE WHEN r.reset_at <= now() THEN 1 ELSE r.hits + 1 END,
           reset_at = CASE WHEN r.reset_at <= now() THEN now() + make_interval(secs => $2) ELSE r.reset_at END
         RETURNING hits, reset_at`,
        [this.key(raw), this.windowMs / 1000],
      );
      // Housekeeping on roughly one hit in 200, never awaited.
      if (Math.random() < 0.005) {
        q("DELETE FROM rate_limit_hits WHERE reset_at < now() - interval '1 hour'").catch(() => {});
      }
      return { totalHits: rows[0].hits as number, resetTime: new Date(rows[0].reset_at) };
    } catch (err) {
      this.warn(err);
      return this.fallback.increment(raw);
    }
  }

  async decrement(raw: string): Promise<void> {
    try {
      await q("UPDATE rate_limit_hits SET hits = GREATEST(hits - 1, 0) WHERE key = $1", [this.key(raw)]);
    } catch (err) {
      this.warn(err);
      await this.fallback.decrement(raw);
    }
  }

  async resetKey(raw: string): Promise<void> {
    try {
      await q("DELETE FROM rate_limit_hits WHERE key = $1", [this.key(raw)]);
    } catch (err) {
      this.warn(err);
    }
    await this.fallback.resetKey(raw);
  }
}
