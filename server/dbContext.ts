import { AsyncLocalStorage } from "async_hooks";

/**
 * Who the database should believe is asking, carried alongside each request.
 *
 * With DB_ENFORCE_RLS=on every statement runs under that identity, and row-level security policies
 * in the database (migration 0014) decide what rows the identity may see or change. The application
 * still checks permissions in code; this is a second, independent check, so a missing check in one
 * route cannot expose another person's record.
 *
 * Three states, and the default is the safe one:
 *   user   - a signed-in person: only their own rows, plus what their relationship allows
 *   system - background work and the few steps that must happen before anyone is signed in
 *            (sign-in, sign-up, password reset, the reminder scheduler, administrators acting on others)
 *   none   - nothing established: the database returns nothing and refuses writes
 */
export interface DbIdentity {
  userId?: string;
  system?: boolean;
}

const store = new AsyncLocalStorage<DbIdentity>();

/**
 * In the test suite's "restricted role" mode (TEST_AS_APP_ROLE=1) the tests' own fixtures write rows
 * directly, so with nothing established they act as system. Requests still switch to the signed-in
 * person at the authentication step, and a test can force "nobody" with runAsNobody. Never in production.
 */
const testDefaultSystem = () => process.env.NODE_ENV === "test" && process.env.TEST_AS_APP_ROLE === "1";

export const currentIdentity = (): DbIdentity | undefined => store.getStore() ?? (testDefaultSystem() ? { system: true } : undefined);

/** For tests: nothing established at all (what a code path that forgot to say who it is would get). */
export const runAsNobody = <T>(fn: () => T): T => scoped({}, fn);

/**
 * Runs `fn` inside the identity. A database query built with Drizzle is lazy: it does not run until it is
 * awaited, which could be after `fn` has returned and the identity has been left behind (and then it would
 * run as whatever was ambient). So a lazy result is awaited here, inside the scope.
 */
function scoped<T>(identity: DbIdentity, fn: () => T): T {
  return store.run(identity, () => {
    const result = fn();
    if (result && typeof (result as { then?: unknown }).then === "function") return (async () => await result)() as T;
    return result;
  });
}

/** Runs `fn` (and everything it awaits) as this signed-in person. */
export const runAsUser = <T>(userId: string, fn: () => T): T => scoped({ userId }, fn);

/** Runs `fn` with system access. Use sparingly, around the smallest piece of work that needs it. */
export const runAsSystem = <T>(fn: () => T): T => scoped({ system: true }, fn);

/** Makes the rest of the current request this person. Called once, by the authentication step. */
export const enterUser = (userId: string): void => {
  store.enterWith({ userId });
};

export const enforcementEnabled = (): boolean => process.env.DB_ENFORCE_RLS === "on";
