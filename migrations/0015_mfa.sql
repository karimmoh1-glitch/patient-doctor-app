-- Multi-factor sign-in for clinicians and administrators.
--
-- user_mfa holds the authenticator secret ENCRYPTED (AES-256-GCM, key from the environment, bound to the user id), whether
-- enrolment is finished, the last time-step accepted (a code seen once can never be replayed), and a failure counter with a
-- lock-out. mfa_recovery_codes holds one-way hashes of single-use recovery codes. Only the server's authentication code, with
-- system access, ever touches either table: no person's own request can read them.

CREATE TABLE IF NOT EXISTS user_mfa (
  user_id varchar PRIMARY KEY REFERENCES users(id),
  secret_ciphertext text NOT NULL,
  pending boolean NOT NULL DEFAULT true,          -- true until the first correct code proves the app was set up
  enabled_at timestamptz,
  last_used_step bigint NOT NULL DEFAULT 0,
  failed_attempts integer NOT NULL DEFAULT 0,
  locked_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS mfa_recovery_codes (
  id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id varchar NOT NULL REFERENCES users(id),
  code_hash varchar NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS mfa_recovery_codes_user_idx ON mfa_recovery_codes (user_id);

ALTER TABLE user_mfa ENABLE ROW LEVEL SECURITY;
ALTER TABLE mfa_recovery_codes ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS avela_user_mfa ON user_mfa;
DROP POLICY IF EXISTS avela_mfa_recovery_codes ON mfa_recovery_codes;
CREATE POLICY avela_user_mfa ON user_mfa FOR ALL USING (app_is_system()) WITH CHECK (app_is_system());
CREATE POLICY avela_mfa_recovery_codes ON mfa_recovery_codes FOR ALL USING (app_is_system()) WITH CHECK (app_is_system());

SELECT avela_apply_grants();
