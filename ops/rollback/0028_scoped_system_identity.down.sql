-- Backs out migration 0028 (scoped system identity). NOT part of the migration runner. Run by hand as the database OWNER, and only together with
-- redeploying an application release from before scoped system identities (it signs unscoped system assertions, which this restores the meaning of):
--   psql "$OWNER_DATABASE_URL" -v ON_ERROR_STOP=1 -f ops/rollback/0028_scoped_system_identity.down.sql
-- Drops the avela_scope_* policies 0028 added (the existing policies were never edited), then restores the earlier functions. No application data is read or changed.
BEGIN;

DO $$
DECLARE
  b record;
BEGIN
  FOR b IN SELECT tablename AS tbl, policyname AS pol FROM pg_policies WHERE schemaname = 'public' AND policyname LIKE 'avela\_scope\_%' LOOP
    EXECUTE format('DROP POLICY %I ON %I', b.pol, b.tbl);
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
  SELECT enforce, max_ttl_seconds INTO cfg FROM app_identity_config LIMIT 1;
  IF tok IS NULL OR tok = '' THEN
    -- No assertion. Only while enforcement is off are the old plain settings honoured (roll-out and rollback).
    IF NOT COALESCE(cfg.enforce, true) THEN
      IF current_setting('app.system', true) = 'on' THEN RETURN 'system'; END IF;
      IF COALESCE(current_setting('app.user_id', true), '') <> '' THEN RETURN 'user:' || current_setting('app.user_id', true); END IF;
    END IF;
    RETURN '';
  END IF;

  -- One shape test for the whole value, then split: a malformed assertion is simply nobody.
  IF tok !~ '^v1\.[a-z0-9_-]{1,32}\.(user|system)\.[A-Za-z0-9_-]{1,64}\.[0-9]{1,12}\.[A-Za-z0-9_-]{43}$' THEN RETURN ''; END IF;
  parts := string_to_array(tok, '.');
  IF parts[3] = 'system' AND parts[4] <> '-' THEN RETURN ''; END IF;
  exp_s := parts[5]::bigint;
  IF exp_s < now_s OR exp_s > now_s + COALESCE(cfg.max_ttl_seconds, 300) THEN RETURN ''; END IF;

  SELECT ipad, opad INTO k FROM app_identity_keys WHERE kid = parts[2] AND retired_at IS NULL;
  IF NOT FOUND THEN RETURN ''; END IF;
  msg := convert_to('avela-identity-v1' || chr(10) || parts[2] || chr(10) || parts[3] || chr(10) || parts[4] || chr(10) || parts[5], 'UTF8');
  expected := translate(rtrim(replace(encode(sha256(k.opad || sha256(k.ipad || msg)), 'base64'), chr(10), ''), '='), '+/', '-_');
  -- Compare digests of the two values, so how long the comparison takes says nothing about how much of a guess was right.
  IF sha256(convert_to(expected, 'UTF8')) <> sha256(convert_to(parts[6], 'UTF8')) THEN RETURN ''; END IF;
  RETURN CASE parts[3] WHEN 'system' THEN 'system' ELSE 'user:' || parts[4] END;
END $$;

CREATE OR REPLACE FUNCTION app_verified_system() RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT avela_identity_check() = 'system'
$$;

CREATE OR REPLACE FUNCTION app_user_credentials(by_email text)
  RETURNS TABLE (
    id varchar, name text, email varchar, password_hash varchar, role varchar, state varchar, phone varchar, language varchar,
    read_receipts boolean, is_demo boolean, timezone varchar, country varchar, created_at timestamp, deactivated_at timestamp,
    email_verified_at timestamp)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NOT app_is_system() THEN RETURN; END IF;
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
  -- COALESCE: with nobody established `target = app_user_id()` is NULL, and NOT NULL is NULL, which would NOT stop the function.
  IF NOT COALESCE(app_is_system() OR target = app_user_id(), false) THEN RETURN; END IF;
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
  IF NOT COALESCE(app_is_system() OR target = app_user_id(), false) THEN RETURN; END IF;
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
  IF NOT app_is_system() THEN RETURN; END IF;
  RETURN QUERY SELECT u.id, u.name, u.email, u.language, u.email_verified_at FROM users u WHERE u.id = ANY (ids);
END $$;

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
  IF NEW.email_verified_at IS DISTINCT FROM OLD.email_verified_at AND NOT app_is_system() THEN
    RAISE EXCEPTION 'users: email verification is recorded by the server only' USING ERRCODE = '42501';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id THEN RAISE EXCEPTION 'users: id cannot change' USING ERRCODE = '42501'; END IF;
  RETURN NEW;
END $$;

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

DROP FUNCTION IF EXISTS app_system_in(text[]);
DROP FUNCTION IF EXISTS app_verified_scope();

SELECT avela_apply_grants();
DELETE FROM schema_migrations WHERE name = '0028_scoped_system_identity.sql';
COMMIT;
