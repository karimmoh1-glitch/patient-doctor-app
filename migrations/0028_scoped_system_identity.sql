-- Narrows "system": the identity the server uses for work that happens before anyone is signed in (sign-in, sign-up, password reset,
-- invitations, the e-mail webhook, the scheduler) or on behalf of the whole service.
--
-- Until now there was exactly one system identity and every policy that said `app_is_system()` accepted it, so a flaw in ANY of those
-- entry points (an injection in the sign-in route, say) would have run with the power to read every patient's medicines, messages and visits.
-- Now the assertion names a SCOPE (server/identity.ts, SYSTEM_SCOPES) and the database lets each scope touch only the tables its job needs:
--
--   auth       sign-in, sign-up, password reset, e-mail confirmation, second factor, clinician registration
--   invite     redeeming a care-circle or organization invitation (creates an account, attaches it)
--   session    the lookup that turns a session token into a person (one device row, one account row)
--   scheduler  the reminder run: reminders and their deliveries, notices, the job ledger
--   webhook    the e-mail provider's delivery reports
--   ratelimit  the shared rate-limit counters
--   server     the old, unrestricted system identity. Code that acts for an already-authenticated person with its own permission check
--              (organization staff services, administrators' decisions, background clean-up) and tests use it; nothing reachable without
--              signing in does.
--
-- `app_is_system()` now means "scope server" only, so anything this migration does not open to a narrower scope stays closed to it (fail
-- closed). Narrow scopes are opened with ADDITIONAL permissive policies (avela_scope_<table>_<command>), one per command the server scope
-- already had on that table; the existing policies are not edited, so the rollback is simply dropping the added ones and restores the structure
-- exactly. Nothing reads or changes a row of application data.

-- 1. The verifier returns the scope: 'system' (the unrestricted server scope) or 'system:<scope>'.
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
  SELECT enforce, max_ttl_seconds INTO cfg FROM app_identity_config LIMIT 1;
  IF tok IS NULL OR tok = '' THEN
    -- No assertion. Only while enforcement is off are the old plain settings honoured (roll-out and rollback).
    IF NOT COALESCE(cfg.enforce, true) THEN
      IF current_setting('app.system', true) = 'on' THEN RETURN 'system'; END IF;
      IF COALESCE(current_setting('app.user_id', true), '') <> '' THEN RETURN 'user:' || current_setting('app.user_id', true); END IF;
    END IF;
    RETURN '';
  END IF;

  IF tok !~ '^v1\.[a-z0-9_-]{1,32}\.(user|system)\.[A-Za-z0-9_-]{1,64}\.[0-9]{1,12}\.[A-Za-z0-9_-]{43}$' THEN RETURN ''; END IF;
  parts := string_to_array(tok, '.');
  -- A system assertion names one of the known scopes; anything else, however validly signed, is nobody.
  IF parts[3] = 'system' AND parts[4] NOT IN ('server', 'auth', 'invite', 'session', 'scheduler', 'webhook', 'ratelimit') THEN RETURN ''; END IF;
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

-- The unrestricted scope only: what every policy that says app_is_system() has always meant, now strictly narrower than "any system".
CREATE OR REPLACE FUNCTION app_verified_system() RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT avela_identity_check() = 'system'
$$;
-- The scope of a system identity ('server' for the unrestricted one), or NULL for a person or nobody.
CREATE OR REPLACE FUNCTION app_verified_scope() RETURNS text
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT CASE WHEN i = 'system' THEN 'server' WHEN i LIKE 'system:%' THEN substr(i, 8) END FROM (SELECT avela_identity_check() AS i) s
$$;
-- Is the identity the unrestricted server, or one of the named scopes?
CREATE OR REPLACE FUNCTION app_system_in(VARIADIC scopes text[]) RETURNS boolean
  LANGUAGE sql STABLE AS $$ SELECT COALESCE((SELECT app_verified_scope()) = ANY (array_append(scopes, 'server'::text)), false) $$;

-- 2. Which scope may touch which table. A scope absent from a table's entry cannot read or write it at all.
CREATE TEMP TABLE scope_matrix (tbl text NOT NULL, scope text NOT NULL) ON COMMIT DROP;
INSERT INTO scope_matrix VALUES
  -- sign-in, sign-up, recovery, second factor, clinician registration
  ('users', 'auth'), ('user_devices', 'auth'), ('password_reset_tokens', 'auth'), ('email_verification_tokens', 'auth'),
  ('user_mfa', 'auth'), ('mfa_recovery_codes', 'auth'), ('audit_logs', 'auth'), ('email_deliveries', 'auth'),
  ('doctor_applications', 'auth'),
  -- redeeming an invitation (creates or finds an account, attaches it to the inviter's care circle or organization)
  ('users', 'invite'), ('user_devices', 'invite'), ('audit_logs', 'invite'),
  ('care_circle_members', 'invite'), ('org_invitations', 'invite'), ('org_memberships', 'invite'), ('organizations', 'invite'),
  -- session lookup
  ('user_devices', 'session'), ('users', 'session'),
  -- the reminder run
  ('medication_reminders', 'scheduler'), ('medications', 'scheduler'), ('prescriptions', 'scheduler'),
  ('reminder_deliveries', 'scheduler'), ('notifications', 'scheduler'), ('appointments', 'scheduler'), ('personal_reminders', 'scheduler'),
  ('personal_reminder_deliveries', 'scheduler'), ('job_runs', 'scheduler'), ('job_run_history', 'scheduler'),
  ('email_deliveries', 'scheduler'), ('users', 'scheduler'),
  -- the e-mail provider's reports
  ('email_deliveries', 'webhook'), ('email_webhook_events', 'webhook'),
  -- shared rate-limit counters
  ('rate_limit_hits', 'ratelimit');

DO $$
DECLARE
  m record;
  c text;
  cmds text[];
  clause text;
  pname text;
BEGIN
  FOR m IN SELECT tbl, string_agg(quote_literal(scope), ', ' ORDER BY scope) AS scopes FROM scope_matrix GROUP BY tbl LOOP
    clause := 'app_system_in(' || m.scopes || ')';
    -- A narrower scope is given the commands that the table's existing policies cover at all (the server scope reaches them through
    -- app_is_system(), directly or inside a helper such as app_can_write_patient()); a command with no policy stays closed to everyone.
    -- (Our own earlier additions are not counted, so applying this twice changes nothing.)
    SELECT array_agg(DISTINCT x) INTO cmds FROM (
      SELECT unnest(CASE WHEN pp.cmd = 'ALL' THEN ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE'] ELSE ARRAY[pp.cmd::text] END) AS x
        FROM pg_policies pp
       WHERE pp.schemaname = 'public' AND pp.tablename = m.tbl AND pp.policyname NOT LIKE 'avela\_scope\_%'
    ) s;
    IF cmds IS NULL THEN RAISE EXCEPTION 'scope matrix names %, which has no policy', m.tbl; END IF;
    FOREACH c IN ARRAY cmds LOOP
      pname := 'avela_scope_' || m.tbl || '_' || lower(c);
      EXECUTE format('DROP POLICY IF EXISTS %I ON %I', pname, m.tbl);
      IF c = 'SELECT' OR c = 'DELETE' THEN
        EXECUTE format('CREATE POLICY %I ON %I AS PERMISSIVE FOR %s USING (%s)', pname, m.tbl, c, clause);
      ELSIF c = 'INSERT' THEN
        EXECUTE format('CREATE POLICY %I ON %I AS PERMISSIVE FOR INSERT WITH CHECK (%s)', pname, m.tbl, clause);
      ELSE
        EXECUTE format('CREATE POLICY %I ON %I AS PERMISSIVE FOR UPDATE USING (%s) WITH CHECK (%s)', pname, m.tbl, clause, clause);
      END IF;
    END LOOP;
  END LOOP;
END $$;

-- 3. The account functions and the guard that mention app_is_system() name the scopes that really need them.
CREATE OR REPLACE FUNCTION app_user_credentials(by_email text)
  RETURNS TABLE (
    id varchar, name text, email varchar, password_hash varchar, role varchar, state varchar, phone varchar, language varchar,
    read_receipts boolean, is_demo boolean, timezone varchar, country varchar, created_at timestamp, deactivated_at timestamp,
    email_verified_at timestamp)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  -- Sign-in, recovery and invitation checks: the only callers that look an account up by address.
  IF NOT app_system_in('auth', 'invite') THEN RETURN; END IF;
  RETURN QUERY
    SELECT u.id, u.name, u.email, u.password_hash, u.role, u.state, u.phone, u.language, u.read_receipts, u.is_demo, u.timezone, u.country,
           u.created_at, u.deactivated_at, u.email_verified_at
      FROM users u WHERE lower(u.email) = lower(btrim(by_email));
END $$;

CREATE OR REPLACE FUNCTION app_user_credentials_by_id(target text)
  RETURNS TABLE (
    id varchar, name text, email varchar, password_hash varchar, role varchar, state varchar, phone varchar, language varchar,
    read_receipts boolean, is_demo boolean, timezone varchar, country varchar, created_at timestamp, deactivated_at timestamp,
    email_verified_at timestamp)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NOT COALESCE(app_system_in('auth') OR target = app_user_id(), false) THEN RETURN; END IF;
  RETURN QUERY
    SELECT u.id, u.name, u.email, u.password_hash, u.role, u.state, u.phone, u.language, u.read_receipts, u.is_demo, u.timezone, u.country,
           u.created_at, u.deactivated_at, u.email_verified_at
      FROM users u WHERE u.id = target;
END $$;

CREATE OR REPLACE FUNCTION app_user_private(target text)
  RETURNS TABLE (
    id varchar, name text, email varchar, role varchar, state varchar, phone varchar, language varchar, read_receipts boolean, is_demo boolean,
    timezone varchar, emergency_contact_name text, emergency_contact_phone varchar, allergies_text text, emergency_notes text,
    emergency_contact_relationship text, country varchar, date_of_birth text, preferred_name text, contact_method varchar,
    accessibility_notes text, care_preferences jsonb, created_at timestamp, deactivated_at timestamp, email_verified_at timestamp)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  -- COALESCE: with nobody established `target = app_user_id()` is NULL, and NOT NULL is NULL, which would NOT stop the function.
  IF NOT COALESCE(app_system_in('auth', 'invite', 'scheduler') OR target = app_user_id(), false) THEN RETURN; END IF;
  RETURN QUERY
    SELECT u.id, u.name, u.email, u.role, u.state, u.phone, u.language, u.read_receipts, u.is_demo, u.timezone,
           u.emergency_contact_name, u.emergency_contact_phone, u.allergies_text, u.emergency_notes, u.emergency_contact_relationship,
           u.country, u.date_of_birth::text, u.preferred_name, u.contact_method, u.accessibility_notes, u.care_preferences,
           u.created_at, u.deactivated_at, u.email_verified_at
      FROM users u WHERE u.id = target;
END $$;

CREATE OR REPLACE FUNCTION app_user_contacts(ids text[])
  RETURNS TABLE (id varchar, name text, email varchar, language varchar, email_verified_at timestamp)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NOT app_system_in('scheduler', 'invite') THEN RETURN; END IF;
  RETURN QUERY SELECT u.id, u.name, u.email, u.language, u.email_verified_at FROM users u WHERE u.id = ANY (ids);
END $$;

-- e-mail confirmation is the one change to the account row a narrow scope may make (sign-in's confirmation link).
CREATE OR REPLACE FUNCTION avela_users_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT app_restricted_session() THEN RETURN NEW; END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.role NOT IN ('patient', 'doctor', 'caregiver', 'staff') THEN
      RAISE EXCEPTION 'users: role % cannot be created by the application', NEW.role USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.role IS DISTINCT FROM OLD.role THEN RAISE EXCEPTION 'users: role cannot be changed by the application' USING ERRCODE = '42501'; END IF;
  IF NEW.is_demo IS DISTINCT FROM OLD.is_demo THEN RAISE EXCEPTION 'users: is_demo cannot be changed by the application' USING ERRCODE = '42501'; END IF;
  IF lower(NEW.email) IS DISTINCT FROM lower(OLD.email) THEN RAISE EXCEPTION 'users: email cannot be changed by the application' USING ERRCODE = '42501'; END IF;
  IF NEW.email_verified_at IS DISTINCT FROM OLD.email_verified_at AND NOT app_system_in('auth') THEN
    RAISE EXCEPTION 'users: email verification is recorded by the server only' USING ERRCODE = '42501';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id THEN RAISE EXCEPTION 'users: id cannot change' USING ERRCODE = '42501'; END IF;
  RETURN NEW;
END $$;

-- Privileges: the policy backup is the owner's alone, like the identity tables.
CREATE OR REPLACE FUNCTION avela_apply_grants() RETURNS void
  LANGUAGE plpgsql AS $$
DECLARE
  f record;
BEGIN
  FOR f IN SELECT p.oid::regprocedure AS sig, p.proname FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.prokind = 'f'
                AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e') LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f.sig);
  END LOOP;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'avela_app') THEN
    RETURN;
  END IF;
  GRANT USAGE ON SCHEMA public TO avela_app;
  GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO avela_app;
  GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO avela_app;
  FOR f IN SELECT p.oid::regprocedure AS sig, p.proname FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.prokind = 'f'
                AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e') LOOP
    IF f.proname LIKE 'app\_%' THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO avela_app', f.sig);
    ELSE
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM avela_app', f.sig);
    END IF;
  END LOOP;
  REVOKE CREATE ON SCHEMA public FROM avela_app;
  REVOKE TRUNCATE, REFERENCES, TRIGGER ON ALL TABLES IN SCHEMA public FROM avela_app;
  REVOKE ALL ON schema_migrations FROM avela_app;
  REVOKE ALL ON app_identity_keys, app_identity_config FROM avela_app;
  REVOKE UPDATE, DELETE ON audit_logs, prescription_events FROM avela_app;
  REVOKE DELETE ON users FROM avela_app;
  REVOKE INSERT, UPDATE, DELETE ON pharmacies FROM avela_app;
  IF to_regclass('public.doctor_directory') IS NOT NULL THEN
    REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON doctor_directory FROM avela_app;
  END IF;
  -- Only what identifies a person may be READ from an account row; the rest comes through the app_user_* functions. (A table-level SELECT
  -- covers every column, so it is withdrawn and the ten public columns are granted one by one.)
  REVOKE SELECT ON users FROM avela_app;
  GRANT SELECT (id, name, role, language, read_receipts, is_demo, timezone, created_at, deactivated_at, email_verified_at) ON users TO avela_app;
END $$;

SELECT avela_apply_grants();
