import pg from "pg";
import { devIdentityKey, type IdentityKey } from "../../server/identity";
import { registerIdentityKey, setIdentityEnforcement } from "./identityKeys";

/**
 * Makes a LOCAL database (tests, browser tests, development) accept the publicly known development key and enforce signed identities,
 * so the restricted-role runs exercise exactly the production path. Refuses any database whose name does not mark it as local.
 */
export async function prepareLocalIdentity(url: string, extra?: IdentityKey): Promise<void> {
  const name = new URL(url).pathname.replace(/^\//, "");
  if (!/_(test|dev)$/.test(name)) throw new Error(`Refusing to register the development identity key in "${name}".`);
  const pool = new pg.Pool({ connectionString: url, max: 1 });
  try {
    await registerIdentityKey(pool, devIdentityKey());
    if (extra) await registerIdentityKey(pool, extra);
    await setIdentityEnforcement(pool, true);
  } finally {
    await pool.end();
  }
}
