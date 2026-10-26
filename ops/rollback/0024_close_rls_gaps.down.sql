-- Backs out migration 0024. NOT part of the migration runner (it lives outside migrations/). Run it by hand, as the database OWNER,
-- only together with rolling the application back to a release that predates 0024 (for example 704b7df): that code reads
-- doctor_profiles and users directly and expects no row-level security on them.
--
--   psql "$OWNER_DATABASE_URL" -v ON_ERROR_STOP=1 -f ops/rollback/0024_close_rls_gaps.down.sql
--
-- It removes the policies, triggers, view and helper functions 0024 added, turns row-level security back off on the twelve tables
-- (it does not touch the 19 + 10 that 0014..0023 protected), restores the function-privilege defaults, and forgets that 0024 ran so
-- the migration can be applied again. No row of data is read, changed or removed. Restoring avela_apply_grants() to the
-- version from migration 0014 keeps the runner's grant step from re-applying 0024's narrower grants.
BEGIN;

DROP TRIGGER IF EXISTS users_guard ON users;
DROP TRIGGER IF EXISTS doctor_profiles_guard ON doctor_profiles;
DROP TRIGGER IF EXISTS doctor_applications_guard ON doctor_applications;
DROP TRIGGER IF EXISTS pairing_requests_parties ON pairing_requests;
DROP TRIGGER IF EXISTS appointments_parties ON appointments;
DROP TRIGGER IF EXISTS follow_up_tasks_parties ON follow_up_tasks;

DO $$
DECLARE
  t text;
BEGIN
  FOR t IN SELECT unnest(ARRAY[
    'users', 'doctor_applications', 'doctor_profiles', 'doctor_availability', 'audit_logs', 'prescription_events',
    'pharmacies', 'job_runs', 'job_run_history', 'reminder_deliveries', 'rate_limit_hits', 'schema_migrations'
  ]) LOOP
    EXECUTE (SELECT COALESCE(string_agg(format('DROP POLICY %I ON %I', polname, t), '; '), 'SELECT 1')
               FROM pg_policy WHERE polrelid = format('public.%I', t)::regclass AND polname LIKE 'avela\_%');
    EXECUTE format('ALTER TABLE %I DISABLE ROW LEVEL SECURITY', t);
  END LOOP;
END $$;

-- Notifications go back to "anyone signed in may leave one for anyone" (the 0014 policy).
DROP POLICY IF EXISTS avela_notifications_insert ON notifications;
CREATE POLICY avela_notifications_insert ON notifications FOR INSERT WITH CHECK (app_is_system() OR app_user_id() IS NOT NULL);

DROP VIEW IF EXISTS doctor_directory;
DROP FUNCTION IF EXISTS avela_users_guard();
DROP FUNCTION IF EXISTS avela_doctor_profiles_guard();
DROP FUNCTION IF EXISTS avela_doctor_applications_guard();
DROP FUNCTION IF EXISTS avela_parties_immutable();
DROP FUNCTION IF EXISTS app_restricted_session();
DROP FUNCTION IF EXISTS app_has_pairing_with_profile(text);
DROP FUNCTION IF EXISTS app_is_listed_doctor(text);
DROP FUNCTION IF EXISTS app_admin_may_see_user(text, text);
DROP FUNCTION IF EXISTS app_can_see_user(text);
DROP FUNCTION IF EXISTS app_is_admin();

-- app_is_caregiver_of() as migration 0014 defined it (including its 'accepted' status, which no caregiver row ever holds).
CREATE OR REPLACE FUNCTION app_is_caregiver_of(patient text) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1 FROM care_circle_members m
     WHERE m.patient_user_id = patient AND m.caregiver_user_id = app_user_id() AND m.status = 'accepted'
  )
$$;

-- avela_apply_grants() exactly as migration 0014 defined it (copied verbatim so a structure fingerprint matches).
CREATE OR REPLACE FUNCTION avela_apply_grants() RETURNS void
  LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'avela_app') THEN
    RETURN;
  END IF;
  GRANT USAGE ON SCHEMA public TO avela_app;
  GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO avela_app;
  GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO avela_app;
  GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO avela_app;
  -- Never: changing the structure, emptying a table, or touching what records the schema's own history.
  REVOKE CREATE ON SCHEMA public FROM avela_app;
  REVOKE TRUNCATE, REFERENCES, TRIGGER ON ALL TABLES IN SCHEMA public FROM avela_app;
  REVOKE ALL ON schema_migrations FROM avela_app;
  -- Append-only records: the privilege itself forbids edits, in addition to the triggers.
  REVOKE UPDATE, DELETE ON audit_logs, prescription_events FROM avela_app;
END $$;

ALTER DEFAULT PRIVILEGES GRANT EXECUTE ON FUNCTIONS TO PUBLIC;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO PUBLIC;
GRANT DELETE ON users TO avela_app;
GRANT INSERT, UPDATE, DELETE ON pharmacies TO avela_app;

DELETE FROM schema_migrations WHERE name = '0024_close_rls_gaps.sql';
COMMIT;
