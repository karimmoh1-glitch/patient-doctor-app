import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "@shared/schema";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL must be set.");
}

export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  // Each serverless instance holds its own pool; keep it small so many warm
  // instances cannot exhaust the database's connection limit.
  max: process.env.VERCEL ? 3 : 10,
});

export const db = drizzle(pool, { schema });
