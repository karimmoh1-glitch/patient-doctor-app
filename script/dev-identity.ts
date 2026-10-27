/** Makes a LOCAL database (name ending _test or _dev) accept the publicly known development identity key and enforce signed identities. Local use only. */
import "dotenv/config";
import { prepareLocalIdentity } from "./lib/devIdentity";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL must be set.");
prepareLocalIdentity(process.env.DATABASE_URL).then(
  () => console.log("Local identity key registered and enforcement on."),
  (e) => { console.error(e.message); process.exitCode = 1; },
);
