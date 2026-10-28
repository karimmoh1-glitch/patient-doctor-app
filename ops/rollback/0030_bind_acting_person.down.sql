-- Backs out migration 0030 (the acting person in the signed identity). NOT part of the migration runner. Run by hand as the database OWNER, and only
-- together with redeploying an application release from before it (one that does not sign an actor and does not use the orgmember scope):
--   psql "$OWNER_DATABASE_URL" -v ON_ERROR_STOP=1 -f ops/rollback/0030_bind_acting_person.down.sql
-- Drops the orgmember policies, returns the mfa and review policies to the scope alone, gives the sign-in scope back its second-factor access, restores the
-- 0029 functions and drops the new helpers. No application data is read or changed.
BEGIN;

DO $$
DECLARE
  b record;
  clause text;
BEGIN
  FOR b IN SELECT tablename AS tbl, policyname AS pol FROM pg_policies WHERE schemaname = 'public' AND policyname LIKE 'avela\_scope\_%\_orgmember\_%' LOOP
    EXECUTE format('DROP POLICY %I ON %I', b.pol, b.tbl);
  END LOOP;

  FOR b IN SELECT * FROM (VALUES
  ('user_mfa', 'mfa', 'SELECT'),
  ('user_mfa', 'mfa', 'INSERT'),
  ('user_mfa', 'mfa', 'UPDATE'),
  ('user_mfa', 'mfa', 'DELETE'),
  ('mfa_recovery_codes', 'mfa', 'SELECT'),
  ('mfa_recovery_codes', 'mfa', 'INSERT'),
  ('mfa_recovery_codes', 'mfa', 'UPDATE'),
  ('mfa_recovery_codes', 'mfa', 'DELETE'),
  ('user_devices', 'mfa', 'SELECT'),
  ('user_devices', 'mfa', 'UPDATE'),
  ('audit_logs', 'review', 'SELECT'),
  ('audit_logs', 'review', 'INSERT'),
  ('credential_events', 'review', 'SELECT'),
  ('credential_events', 'review', 'INSERT'),
  ('doctor_applications', 'review', 'SELECT'),
  ('doctor_applications', 'review', 'UPDATE'),
  ('doctor_credentials', 'review', 'INSERT'),
  ('doctor_credentials', 'review', 'UPDATE'),
  ('doctor_profiles', 'review', 'SELECT'),
  ('doctor_profiles', 'review', 'INSERT'),
  ('doctor_profiles', 'review', 'UPDATE'),
  ('message_reports', 'review', 'SELECT'),
  ('message_reports', 'review', 'UPDATE'),
  ('organizations', 'review', 'SELECT'),
  ('organizations', 'review', 'UPDATE'),
  ('user_devices', 'review', 'SELECT'),
  ('user_devices', 'review', 'UPDATE'),
  ('users', 'review', 'SELECT'),
  ('users', 'review', 'UPDATE')
  ) v(tbl, scope, cmd) LOOP
    clause := format('app_verified_scope() = %L', b.scope);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', 'avela_scope_' || b.tbl || '_' || b.scope || '_' || lower(b.cmd), b.tbl);
    IF b.cmd IN ('SELECT', 'DELETE') THEN
      EXECUTE format('CREATE POLICY %I ON %I AS PERMISSIVE FOR %s USING (%s)', 'avela_scope_' || b.tbl || '_' || b.scope || '_' || lower(b.cmd), b.tbl, b.cmd, clause);
    ELSIF b.cmd = 'INSERT' THEN
      EXECUTE format('CREATE POLICY %I ON %I AS PERMISSIVE FOR INSERT WITH CHECK (%s)', 'avela_scope_' || b.tbl || '_' || b.scope || '_' || lower(b.cmd), b.tbl, clause);
    ELSE
      EXECUTE format('CREATE POLICY %I ON %I AS PERMISSIVE FOR UPDATE USING (%s) WITH CHECK (%s)', 'avela_scope_' || b.tbl || '_' || b.scope || '_' || lower(b.cmd), b.tbl, clause, clause);
    END IF;
  END LOOP;

  -- 0028 gave the sign-in scope all four commands on the two second-factor tables; give them back.
  FOR b IN SELECT t.tbl, c.cmd FROM (VALUES ('user_mfa'), ('mfa_recovery_codes')) t(tbl), (VALUES ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE')) c(cmd) LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', 'avela_scope_' || b.tbl || '_' || lower(b.cmd), b.tbl);
    IF b.cmd IN ('SELECT', 'DELETE') THEN
      EXECUTE format('CREATE POLICY %I ON %I AS PERMISSIVE FOR %s USING (app_system_in(''auth''))', 'avela_scope_' || b.tbl || '_' || lower(b.cmd), b.tbl, b.cmd);
    ELSIF b.cmd = 'INSERT' THEN
      EXECUTE format('CREATE POLICY %I ON %I AS PERMISSIVE FOR INSERT WITH CHECK (app_system_in(''auth''))', 'avela_scope_' || b.tbl || '_' || lower(b.cmd), b.tbl);
    ELSE
      EXECUTE format('CREATE POLICY %I ON %I AS PERMISSIVE FOR UPDATE USING (app_system_in(''auth'')) WITH CHECK (app_system_in(''auth''))', 'avela_scope_' || b.tbl || '_' || lower(b.cmd), b.tbl);
    END IF;
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION avela_identity_check() RETURNS text
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  tok text := current_setting('app.assertion', true);
  cfg record;
  parts text[];
  k record;
  now_s bigint := extract(epoch FROM now())::bigint;
  exp_s bigint;
  msg bytea;
  expected text;
BEGIN
  SELECT enforce, max_ttl_seconds, allow_server_scope INTO cfg FROM app_identity_config LIMIT 1;
  IF tok IS NULL OR tok = '' THEN
    -- No assertion. Only while enforcement is off are the old plain settings honoured (roll-out and rollback).
    IF NOT COALESCE(cfg.enforce, true) THEN
      IF current_setting('app.system', true) = 'on' AND COALESCE(cfg.allow_server_scope, true) THEN RETURN 'system'; END IF;
      IF COALESCE(current_setting('app.user_id', true), '') <> '' THEN RETURN 'user:' || current_setting('app.user_id', true); END IF;
    END IF;
    RETURN '';
  END IF;

  IF tok !~ '^v1\.[a-z0-9_-]{1,32}\.(user|system)\.[A-Za-z0-9_-]{1,64}\.[0-9]{1,12}\.[A-Za-z0-9_-]{43}$' THEN RETURN ''; END IF;
  parts := string_to_array(tok, '.');
  -- A system assertion names one of the known scopes; anything else, however validly signed, is nobody.
  IF parts[3] = 'system' AND parts[4] NOT IN ('server', 'auth', 'invite', 'session', 'scheduler', 'webhook', 'ratelimit', 'staff', 'review', 'mfa', 'notify', 'contact', 'audit', 'blocks', 'ops', 'mail', 'pairing', 'verify') THEN RETURN ''; END IF;
  -- The unrestricted scope can be switched off for good once nothing in the application needs it (npm run identity:enforce -- server-scope off).
  IF parts[3] = 'system' AND parts[4] = 'server' AND NOT COALESCE(cfg.allow_server_scope, true) THEN RETURN ''; END IF;
  exp_s := parts[5]::bigint;
  IF exp_s < now_s OR exp_s > now_s + COALESCE(cfg.max_ttl_seconds, 300) THEN RETURN ''; END IF;

  SELECT ipad, opad INTO k FROM app_identity_keys WHERE kid = parts[2] AND retired_at IS NULL;
  IF NOT FOUND THEN RETURN ''; END IF;
  msg := convert_to('avela-identity-v1' || chr(10) || parts[2] || chr(10) || parts[3] || chr(10) || parts[4] || chr(10) || parts[5], 'UTF8');
  expected := translate(rtrim(replace(encode(sha256(k.opad || sha256(k.ipad || msg)), 'base64'), chr(10), ''), '='), '+/', '-_');
  IF sha256(convert_to(expected, 'UTF8')) <> sha256(convert_to(parts[6], 'UTF8')) THEN RETURN ''; END IF;
  IF parts[3] = 'user' THEN RETURN 'user:' || parts[4]; END IF;
  RETURN CASE WHEN parts[4] = 'server' THEN 'system' ELSE 'system:' || parts[4] END;
END $$;

CREATE OR REPLACE FUNCTION app_verified_scope() RETURNS text
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT CASE WHEN i = 'system' THEN 'server' WHEN i LIKE 'system:%' THEN substr(i, 8) END FROM (SELECT avela_identity_check() AS i) s
$$;

CREATE OR REPLACE FUNCTION app_account_id_by_email(by_email text) RETURNS text
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  found text;
BEGIN
  -- Does an account with this address exist, and which? (invitations to organizations). No hash, no other column.
  IF NOT app_system_in('staff', 'invite') THEN RETURN NULL; END IF;
  SELECT u.id INTO found FROM users u WHERE lower(u.email) = lower(btrim(by_email));
  RETURN found;
END $$;

CREATE OR REPLACE FUNCTION app_user_contacts(ids text[])
  RETURNS TABLE (id varchar, name text, email varchar, language varchar, email_verified_at timestamp)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NOT app_system_in('scheduler', 'invite', 'contact', 'staff') THEN RETURN; END IF;
  RETURN QUERY SELECT u.id, u.name, u.email, u.language, u.email_verified_at FROM users u WHERE u.id = ANY (ids);
END $$;

DROP FUNCTION IF EXISTS app_reset_mfa(text);
DROP FUNCTION IF EXISTS app_caller_restricted();
DROP FUNCTION IF EXISTS app_actor_sees_profile(text);
DROP FUNCTION IF EXISTS app_actor_sees_visit(text, text);
DROP FUNCTION IF EXISTS app_actor_shares_org(text);
DROP FUNCTION IF EXISTS app_actor_in_org(text);
DROP FUNCTION IF EXISTS app_actor_is_admin();
DROP FUNCTION IF EXISTS app_actor();

DELETE FROM schema_migrations WHERE name = '0030_bind_acting_person.sql';
COMMIT;
