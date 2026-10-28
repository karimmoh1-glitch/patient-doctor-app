-- Backs out migration 0029 (narrow server scope). NOT part of the migration runner. Run by hand as the database OWNER, and only together with
-- redeploying an application release from before it (one that still uses the unrestricted "server" scope):
--   psql "$OWNER_DATABASE_URL" -v ON_ERROR_STOP=1 -f ops/rollback/0029_narrow_server_scope.down.sql
-- Drops the policies 0029 added, restores the 0028 functions, drops the new lookup function and the switch. No application data is read or changed.
BEGIN;

DO $$
DECLARE
  b record;
BEGIN
  FOR b IN SELECT tablename AS tbl, policyname AS pol FROM pg_policies
            WHERE schemaname = 'public' AND policyname LIKE 'avela\_scope\_%'
              AND coalesce(qual, '') || coalesce(with_check, '') LIKE '%app_verified_scope() = %' LOOP
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

CREATE OR REPLACE FUNCTION avela_doctor_profiles_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT app_restricted_session() OR app_is_system() OR app_is_admin() THEN RETURN NEW; END IF;
  IF (to_jsonb(NEW) - ARRAY['bio', 'languages', 'modalities', 'clinic', 'phone', 'timezone'])
     IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['bio', 'languages', 'modalities', 'clinic', 'phone', 'timezone']) THEN
    RAISE EXCEPTION 'doctor_profiles: only the description and contact details may be edited by the clinician' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION avela_doctor_applications_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT app_restricted_session() OR app_is_system() OR app_is_admin() THEN RETURN NEW; END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (NEW.status = 'pending' AND OLD.status IN ('incomplete', 'needs_info')) THEN
    RAISE EXCEPTION 'doctor_applications: an applicant can only submit their application' USING ERRCODE = '42501';
  END IF;
  IF NEW.reviewer_notes IS DISTINCT FROM OLD.reviewer_notes OR NEW.reviewed_by_user_id IS DISTINCT FROM OLD.reviewed_by_user_id
     OR NEW.reviewed_at IS DISTINCT FROM OLD.reviewed_at
     OR (NEW.info_request IS DISTINCT FROM OLD.info_request AND NOT (NEW.status = 'pending' AND NEW.info_request IS NULL)) -- submitting answers the request
     OR NEW.user_id IS DISTINCT FROM OLD.user_id THEN
    RAISE EXCEPTION 'doctor_applications: review fields belong to the reviewer' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;

DROP FUNCTION IF EXISTS app_account_id_by_email(text);
ALTER TABLE app_identity_config DROP COLUMN IF EXISTS allow_server_scope;

DELETE FROM schema_migrations WHERE name = '0029_narrow_server_scope.sql';
COMMIT;
