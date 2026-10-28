-- Narrows the last broad system capability. Until now every application path that acts for an already signed-in person but needs the
-- database's help (organization staff, administrators' decisions, multi-factor state, notices, counterpart e-mail addresses, block lists, the
-- operations screens, pairing invitations) used the unrestricted "server" scope. Each now has a scope of its own (server/identity.ts SYSTEM_SCOPES),
-- opened by added policies, command by command, to only the tables and operations its code uses (docs/SERVER_SCOPE_INVENTORY.md):
--
--   staff    organization staff, after the permission matrix      review   administrators' decisions on clinicians, credentials, reports, organizations
--   mfa      second-factor state                                  notify   in-app notices
--   contact  counterpart e-mail addresses (a function, no table)  audit    reading one record's audit trail after the route's own check
--   blocks   who blocked whom                                     ops      read-only counts for the operations screens
--   mail     the e-mail delivery ledger                           pairing  redeeming a clinician's pairing invitation
--   verify   the single-use e-mail confirmation link
--
-- With nothing in the application left on "server", the unrestricted scope can be switched OFF in the database
-- (npm run identity:enforce -- server-scope off): even code execution in the application could then no longer sign it. The switch defaults to
-- "allowed" so the roll-out order stays flexible. Two functions change with it: the account lookup that organization staff need no longer
-- releases a password hash (app_account_id_by_email returns an id only). Nothing reads or changes a row of application data.

ALTER TABLE app_identity_config ADD COLUMN IF NOT EXISTS allow_server_scope boolean NOT NULL DEFAULT true;

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

CREATE OR REPLACE FUNCTION app_user_private(target text)
  RETURNS TABLE (
    id varchar, name text, email varchar, role varchar, state varchar, phone varchar, language varchar, read_receipts boolean, is_demo boolean,
    timezone varchar, emergency_contact_name text, emergency_contact_phone varchar, allergies_text text, emergency_notes text,
    emergency_contact_relationship text, country varchar, date_of_birth text, preferred_name text, contact_method varchar,
    accessibility_notes text, care_preferences jsonb, created_at timestamp, deactivated_at timestamp, email_verified_at timestamp)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  -- COALESCE: with nobody established `target = app_user_id()` is NULL, and NOT NULL is NULL, which would NOT stop the function.
  IF NOT COALESCE(app_system_in('auth', 'invite', 'scheduler', 'contact') OR target = app_user_id(), false) THEN RETURN; END IF;
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
  IF NOT app_system_in('scheduler', 'invite', 'contact', 'staff') THEN RETURN; END IF;
  RETURN QUERY SELECT u.id, u.name, u.email, u.language, u.email_verified_at FROM users u WHERE u.id = ANY (ids);
END $$;

-- The two guard triggers that let the server (and an administrator) edit review fields now also let the review scope do so.
CREATE OR REPLACE FUNCTION avela_doctor_profiles_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT app_restricted_session() OR app_system_in('review') OR app_is_admin() THEN RETURN NEW; END IF;
  IF (to_jsonb(NEW) - ARRAY['bio', 'languages', 'modalities', 'clinic', 'phone', 'timezone'])
     IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['bio', 'languages', 'modalities', 'clinic', 'phone', 'timezone']) THEN
    RAISE EXCEPTION 'doctor_profiles: only the description and contact details may be edited by the clinician' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION avela_doctor_applications_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT app_restricted_session() OR app_system_in('review') OR app_is_admin() THEN RETURN NEW; END IF;
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

-- Which new scope may do which operation on which table (S select, I insert, U update, D delete). A command with no policy on the table stays
-- closed to everyone. One policy per table, scope and command, so removing a scope removes exactly its policies.
CREATE TEMP TABLE scope_matrix (tbl text NOT NULL, scope text NOT NULL, cmds text NOT NULL) ON COMMIT DROP;
INSERT INTO scope_matrix VALUES
  ('audit_logs', 'audit', 'S'),
  ('email_verification_tokens', 'verify', 'SI'),
  ('user_blocks', 'blocks', 'S'),
  ('email_deliveries', 'mail', 'SIU'),
  ('user_mfa', 'mfa', 'SIUD'),
  ('mfa_recovery_codes', 'mfa', 'SIUD'),
  ('user_devices', 'mfa', 'SU'),
  ('notifications', 'notify', 'SI'),
  ('doctor_profiles', 'ops', 'S'),
  ('email_deliveries', 'ops', 'S'),
  ('email_webhook_events', 'ops', 'S'),
  ('job_run_history', 'ops', 'S'),
  ('job_runs', 'ops', 'S'),
  ('medication_reminders', 'ops', 'S'),
  ('personal_reminder_deliveries', 'ops', 'S'),
  ('personal_reminders', 'ops', 'S'),
  ('users', 'ops', 'S'),
  ('doctor_profiles', 'pairing', 'S'),
  ('pairing_invitations', 'pairing', 'SU'),
  ('pairing_requests', 'pairing', 'SIU'),
  ('users', 'pairing', 'S'),
  ('audit_logs', 'review', 'SI'),
  ('credential_events', 'review', 'SI'),
  ('doctor_applications', 'review', 'SU'),
  ('doctor_credentials', 'review', 'SIU'),
  ('doctor_profiles', 'review', 'SIU'),
  ('message_reports', 'review', 'SU'),
  ('organizations', 'review', 'SU'),
  ('user_devices', 'review', 'SU'),
  ('users', 'review', 'SU'),
  ('appointments', 'staff', 'S'),
  ('audit_logs', 'staff', 'SI'),
  ('doctor_profiles', 'staff', 'S'),
  ('notifications', 'staff', 'SI'),
  ('org_invitations', 'staff', 'SIU'),
  ('org_memberships', 'staff', 'SIU'),
  ('org_notes', 'staff', 'SI'),
  ('org_tasks', 'staff', 'SIU'),
  ('organizations', 'staff', 'SIU'),
  ('pairing_requests', 'staff', 'SU'),
  ('users', 'staff', 'S');

DO $$
DECLARE
  m record;
  c text;
  have text[];
  pname text;
  clause text;
  letter text;
BEGIN
  FOR m IN SELECT tbl, scope, cmds FROM scope_matrix LOOP
    SELECT array_agg(DISTINCT x) INTO have FROM (
      SELECT unnest(CASE WHEN pp.cmd = 'ALL' THEN ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE'] ELSE ARRAY[pp.cmd::text] END) AS x
        FROM pg_policies pp WHERE pp.schemaname = 'public' AND pp.tablename = m.tbl AND pp.policyname NOT LIKE 'avela\_scope\_%'
    ) s;
    IF have IS NULL THEN RAISE EXCEPTION 'scope matrix names %, which has no policy', m.tbl; END IF;
    clause := format('app_verified_scope() = %L', m.scope);
    FOREACH c IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE'] LOOP
      letter := CASE c WHEN 'SELECT' THEN 'S' WHEN 'INSERT' THEN 'I' WHEN 'UPDATE' THEN 'U' ELSE 'D' END;
      CONTINUE WHEN position(letter IN m.cmds) = 0;
      IF NOT (c = ANY (have)) THEN RAISE EXCEPTION 'scope matrix asks for % on %, which no policy covers', c, m.tbl; END IF;
      pname := 'avela_scope_' || m.tbl || '_' || m.scope || '_' || lower(c);
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

SELECT avela_apply_grants();
