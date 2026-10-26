import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "@shared/schema";
import { currentIdentity, enforcementEnabled } from "./dbContext";

// Runtime queries use APP_DATABASE_URL (a restricted role, see docs/SECURITY.md) when it is set. The OWNER connection
// (OWNER_DATABASE_URL, else DATABASE_URL) owns the tables and is for migrations and operator scripts; it is the fallback
// only where no restricted role is configured (development, tests, and a production deployment under a named exception).
const connectionString = process.env.APP_DATABASE_URL || process.env.OWNER_DATABASE_URL || process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL must be set.");
}

type Tagged = pg.PoolClient & { __avelaIdentity?: string };

/**
 * A pool that, when DB_ENFORCE_RLS=on, tells the database who each statement is for. The identity is
 * written to the connection's session settings (app.user_id / app.system) before it is handed out,
 * and only when it differs from what that connection already holds, so a run of queries for the same
 * person costs one extra round trip, not one per query. Every checkout sets it, so a connection can
 * never carry the previous person's identity into the next request.
 */
class ContextPool extends pg.Pool {
  private checked: Promise<void> | null = null;

  // pg-pool's own query() goes through connect(), and so does Drizzle for transactions.
  connect(cb?: any): any {
    if (!enforcementEnabled()) return (super.connect as any)(cb);
    const run = async (): Promise<pg.PoolClient> => {
      const client = (await (super.connect as any)()) as Tagged;
      try {
        await (this.checked ??= this.assertRestrictedRole(client));
        const id = currentIdentity();
        const want = id?.system ? "system" : id?.userId ? `user:${id.userId}` : "none";
        if (client.__avelaIdentity !== want) {
          await client.query("SELECT set_config('app.user_id', $1, false), set_config('app.system', $2, false)", [id?.userId ?? "", id?.system ? "on" : ""]);
          client.__avelaIdentity = want;
        }
        return client;
      } catch (err) {
        client.release(err as Error);
        throw err;
      }
    };
    if (typeof cb === "function") {
      run().then((c) => cb(undefined, c, (e?: Error | boolean) => c.release(e as any)), (e) => cb(e));
      return undefined;
    }
    return run();
  }

  /**
   * Row-level security only protects anything if the connection is NOT the table owner, a superuser,
   * or a role that bypasses it. Turning enforcement on while connected as one of those would give a
   * false sense of safety, so refuse to serve a single request.
   */
  private async assertRestrictedRole(client: pg.PoolClient): Promise<void> {
    const { rows } = await client.query(
      `SELECT r.rolsuper OR r.rolbypassrls AS bypass,
              EXISTS (SELECT 1 FROM pg_tables t WHERE t.schemaname = 'public' AND t.tablename = 'users' AND t.tableowner = current_user) AS owner,
              current_user AS who
         FROM pg_roles r WHERE r.rolname = current_user`,
    );
    if (rows[0]?.bypass || rows[0]?.owner) {
      this.checked = Promise.reject(new Error("DB_ENFORCE_RLS is on but the database role can bypass row-level security"));
      this.checked.catch(() => {});
      console.error("[db] DB_ENFORCE_RLS=on needs a role that is not the table owner, a superuser or BYPASSRLS (see docs/SECURITY.md). Refusing to serve.");
      throw new Error("database role can bypass row-level security");
    }
  }
}

export const pool: pg.Pool = new ContextPool({
  connectionString,
  // Each serverless instance holds its own pool; keep it small so many warm
  // instances cannot exhaust the database's connection limit.
  max: process.env.VERCEL ? 3 : 10,
});

export const db = drizzle(pool, { schema });
