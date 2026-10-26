import type { NextFunction, Request, Response } from "express";
import { runAsSystem } from "../dbContext";

/**
 * For the few endpoints that must work before anyone is signed in (sign-in, sign-up, password reset,
 * accepting an invitation, the scheduler). Everything downstream runs with system access to the
 * database. It is named here, route by route, so that it is a decision somebody made rather than a
 * default: a handler that forgets to say who it acts as gets no data at all.
 */
export function systemAccess(_req: Request, _res: Response, next: NextFunction) {
  runAsSystem(() => next());
}
