// Vercel serverless entry. The whole Express API runs as one function; the
// built client is served by Vercel's CDN from dist/public (see vercel.json).
// The app is built once per warm instance and reused across invocations.
import "dotenv/config";
import type { IncomingMessage, ServerResponse } from "http";
import { createApiApp } from "./app";

let appPromise: ReturnType<typeof createApiApp> | null = null;

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  if (!appPromise) appPromise = createApiApp();
  const { app } = await appPromise;
  return (app as unknown as (req: IncomingMessage, res: ServerResponse) => void)(req, res);
}
