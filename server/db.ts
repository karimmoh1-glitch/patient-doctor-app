import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "@shared/schema";
import { currentIdentity, enforcementEnabled } from "./dbContext";
import { identityKey, signAssertion, type IdentityKey } from "./identity";

// Runtime queries use APP_DATABASE_URL (a restricted role, see docs/SECURITY.md) when it is set. The OWNER connection
// (OWNER_DATABASE_URL, else DATABASE_URL) owns the tables and is for migrations and operator scripts; it is the fallback
// only where no restricted role is configured (development, tests, and a production deployment under a named exception).
const connectionString = process.env.APP_DATABASE_URL || process.env.OWNER_DATABASE_URL || process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL must be set.");
}

/**
 * A pool that, when DB_ENFORCE_RLS=on, tells the database who each TRANSACTION is for, with a signed assertion (server/identity.ts) that
 * the database verifies (migration 0025).
 *
 * Why per transaction and not per connection: production reaches Postgres through a connection pooler in transaction mode, where the
 * server connection behind a client changes between statements. A setting written on the "connection" is then read back by other
 * clients (measured against production's pooler: 26 of 200 reads returned another client's value) or not at all. A transaction-local
 * setting (set_config(..., true)) lives exactly as long as one transaction and nothing can inherit it.
 *
 *   - a single statement outside a transaction runs as BEGIN + assertion, the statement, COMMIT (the assertion needs no further round trip);
 *   - inside an explicit transaction (Drizzle's db.transaction) the assertion is set right after BEGIN, and re-set if the code switches
 *     identity part way through;
 *   - with nobody established nothing is asserted: the database then sees no one, whatever else the connection carries.
 * The identity is read from the async context when the statement is issued, not when the connection was handed out, so a lazily awaited
 * query always carries the identity of the code awaiting it.
 */
type Tracked = pg.PoolClient & { __avela?: { inTx: boolean; asserted: string } };

const BEGIN = /^\s*(begin|start\s+transaction)\b/i;
const END = /^\s*(commit|end|rollback|abort)\b(?!\s+(to|prepared))/i;
const TOKEN = /^[A-Za-z0-9._-]+$/;

function identityKeyOf(id: ReturnType<typeof currentIdentity>): string {
  return id?.system ? `system:${id.scope ?? "server"}` : id?.userId ? `user:${id.userId}` : "none";
}

export function assertionSql(token: string | null): string {
  if (token !== null && !TOKEN.test(token)) throw new Error("malformed identity assertion");
  return `SELECT set_config('app.assertion', '${token ?? ""}', true)`;
}

export function wrapClient(client: Tracked, key: IdentityKey): Tracked {
  if (client.__avela) return client;
  const state = { inTx: false, asserted: "none" };
  client.__avela = state;
  const raw = client.query.bind(client) as (...a: any[]) => any;

  const run = async (args: any[], text: string): Promise<any> => {
    const id = currentIdentity();
    const want = identityKeyOf(id);
    const token = want === "none" ? null : signAssertion(id, key);
    if (BEGIN.test(text)) {
      const result = await raw(...args);
      state.inTx = true;
      // Always set it, even to "nobody": a setting left on this connection for the whole session (by anything that could run SQL on it)
      // must not decide who a later transaction is for.
      await raw(assertionSql(token));
      state.asserted = want;
      return result;
    }
    if (END.test(text)) {
      try {
        return await raw(...args);
      } finally {
        state.inTx = false;
        state.asserted = "none";
      }
    }
    if (state.inTx) {
      if (want !== state.asserted) {
        await raw(assertionSql(token));
        state.asserted = want;
      }
      return raw(...args);
    }
    await raw(`BEGIN; ${assertionSql(token)}`);
    try {
      const result = await raw(...args);
      await raw("COMMIT");
      return result;
    } catch (err) {
      await raw("ROLLBACK").catch(() => {});
      throw err;
    }
  };

  (client as any).query = (...args: any[]) => {
    const first = args[0];
    // Cursors, COPY streams and the like carry their own protocol: leave them alone (the application uses none).
    if (first && typeof first === "object" && typeof first.submit === "function") return raw(...args);
    const cb = typeof args[args.length - 1] === "function" ? args.pop() : null;
    const text = typeof first === "string" ? first : String(first?.text ?? "");
    const promise = run(args, text);
    if (cb) {
      promise.then((r) => cb(null, r), (e) => cb(e));
      return undefined;
    }
    return promise;
  };
  return client;
}

class ContextPool extends pg.Pool {
  private checked: Promise<void> | null = null;

  // pg-pool's own query() goes through connect(), and so does Drizzle for transactions.
  connect(cb?: any): any {
    if (!enforcementEnabled()) return (super.connect as any)(cb);
    const run = async (): Promise<pg.PoolClient> => {
      const client = (await (super.connect as any)()) as Tracked;
      try {
        await (this.checked ??= this.assertReady(client));
        return wrapClient(client, requireIdentityKey());
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
   * Row-level security only protects anything if the connection is NOT the table owner, a superuser, or a role that bypasses it, and only
   * if the database recognises this application's signing key. Turning enforcement on otherwise would give a false sense of safety (or an
   * application that sees nobody), so refuse to serve a single request.
   */
  private async assertReady(client: pg.PoolClient): Promise<void> {
    const { rows } = await client.query(
      `SELECT r.rolsuper OR r.rolbypassrls AS bypass,
              EXISTS (SELECT 1 FROM pg_tables t WHERE t.schemaname = 'public' AND t.tablename = 'users' AND t.tableowner = current_user) AS owner,
              current_user AS who
         FROM pg_roles r WHERE r.rolname = current_user`,
    );
    const fail = (message: string, log: string): never => {
      this.checked = Promise.reject(new Error(message));
      this.checked.catch(() => {});
      console.error(log);
      throw new Error(message);
    };
    if (rows[0]?.bypass || rows[0]?.owner) {
      fail("database role can bypass row-level security", "[db] DB_ENFORCE_RLS=on needs a role that is not the table owner, a superuser or BYPASSRLS (see docs/SECURITY.md). Refusing to serve.");
    }
    // The database must accept an assertion signed with THIS key; otherwise every request would silently be "nobody".
    const probe = signAssertion({ userId: "identity-probe" }, requireIdentityKey())!;
    await client.query(`BEGIN; ${assertionSql(probe)}`);
    let seen: string | null = null;
    try {
      seen = ((await client.query("SELECT app_user_id() AS id")).rows[0]?.id as string | null) ?? null;
    } catch {
      seen = null;
    } finally {
      await client.query("ROLLBACK").catch(() => {});
    }
    if (seen !== "identity-probe") {
      fail("the database does not recognise this server's identity key", "[db] The database did not accept the identity assertion this server signed (key not registered, retired, or a migration is missing). Register it with `npm run identity:key` (docs/IDENTITY_BOUNDARY.md). Refusing to serve.");
    }
  }
}

function requireIdentityKey(): IdentityKey {
  const k = identityKey();
  if (!k) throw new Error("IDENTITY_KEY_ID and IDENTITY_KEY must be set when DB_ENFORCE_RLS=on.");
  return k;
}

export const pool: pg.Pool = new ContextPool({
  connectionString,
  // Each serverless instance holds its own pool; keep it small so many warm
  // instances cannot exhaust the database's connection limit.
  max: process.env.VERCEL ? 3 : 10,
});

export const db = drizzle(pool, { schema });
