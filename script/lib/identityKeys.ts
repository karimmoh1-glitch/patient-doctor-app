import { hmacPads, type IdentityKey } from "../../server/identity";

type Queryable = { query(sql: string, params?: unknown[]): Promise<{ rows: any[]; rowCount?: number | null }> };

/** Stores a signing key's pad blocks in the database (owner connection only) so it can verify assertions signed with that key. */
export async function registerIdentityKey(db: Queryable, k: IdentityKey): Promise<void> {
  const { ipad, opad } = hmacPads(k.key);
  await db.query(
    `INSERT INTO app_identity_keys (kid, ipad, opad) VALUES ($1, $2, $3)
     ON CONFLICT (kid) DO UPDATE SET ipad = EXCLUDED.ipad, opad = EXCLUDED.opad, retired_at = NULL`,
    [k.kid, ipad, opad],
  );
}

export async function setIdentityEnforcement(db: Queryable, on: boolean): Promise<void> {
  await db.query("INSERT INTO app_identity_config (singleton, enforce) VALUES (true, $1) ON CONFLICT (singleton) DO UPDATE SET enforce = EXCLUDED.enforce, updated_at = now()", [on]);
}
