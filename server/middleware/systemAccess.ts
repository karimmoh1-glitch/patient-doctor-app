import type { NextFunction, Request, Response } from "express";
import { runAsSystem } from "../dbContext";
import type { SystemScope } from "../identity";

/**
 * For the few endpoints that must work before anyone is signed in (sign-in, sign-up, password reset, accepting an invitation, the
 * scheduler, the e-mail webhook). Everything downstream runs with SYSTEM access to the database, limited to the SCOPE named here:
 * the database lets each scope touch only the tables that entry point needs (migration 0028), so a flaw in one of these handlers
 * cannot be turned into a read of a patient's records. A scope is mandatory: there is no unscoped form.
 */
export function systemAccess(scope: Exclude<SystemScope, "server">) {
  const middleware = (_req: Request, _res: Response, next: NextFunction) => {
    runAsSystem(() => next(), scope);
  };
  // Tests enumerate the routes and check every one names a scope.
  return Object.assign(middleware, { systemScope: scope });
}
