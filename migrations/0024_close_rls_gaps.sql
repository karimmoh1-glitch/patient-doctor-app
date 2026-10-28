-- Closes the twelve tables that sat outside row-level security, and tightens who may run the database's functions.
--
--   users                      identity, contact details, account state, the emergency profile
--   doctor_applications        a clinician's licence details while they are being reviewed
--   doctor_profiles            the directory entry (phone and licence number are not public)
--   doctor_availability        a clinician's published weekly windows
--   audit_logs                 who read whose records (already append-only)
--   prescription_events        a prescription's history (already append-only)
--   pharmacies                 reference data, no personal information
--   job_runs, job_run_history  the scheduler's own bookkeeping
--   reminder_deliveries        which reminder was sent when, and whether it worked
--   rate_limit_hits            counters keyed by a one-way hash
--   schema_migrations          the structure's history (the application role has no privilege on it at all)
--
-- Like migration 0014 it changes nothing for a connection that is the table owner (exempt by design). It takes effect for
-- the restricted application role, which production has used since 2026-10-26. It is idempotent, adds no column and
-- rewrites no row; the only objects created are functions, policies, triggers and one view, so backing out is
-- ops/rollback/0024_close_rls_gaps.down.sql (outside migrations/, so the runner never applies it).
--
-- What each table's policy says, and why, is written next to it and summarised in docs/DATABASE_ACCESS_AUDIT.md.

-- ---------------------------------------------------------------------------
-- 1. Questions the policies ask. SECURITY DEFINER with a fixed search_path, so a policy can look at another table
--    without that table's own policy getting in the way (and recursing).
-- ---------------------------------------------------------------------------

-- A caregiver's membership is 'active' once they accept (invited | active | revoked, shared/models/careCircle.ts). Migration 0014's
-- helper tested for 'accepted', a value no row ever holds, so row-level security never recognised a real caregiver and every
-- caregiver read came back empty (its tests inserted the wrong value by hand). Corrected here.
CREATE OR REPLACE FUNCTION app_is_caregiver_of(patient text) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1 FROM care_circle_members m
     WHERE m.patient_user_id = patient AND m.caregiver_user_id = app_user_id() AND m.status = 'active'
  )
$$;

-- Is the signed-in person an administrator whose account is live?
CREATE OR REPLACE FUNCTION app_is_admin() RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM users u WHERE u.id = app_user_id() AND u.role = 'admin' AND u.deactivated_at IS NULL)
$$;

-- May the signed-in person see this person's account row? Themself, the two sides of a doctor-patient connection, the
-- two sides of a care-circle invitation, and colleagues in the same organization. Nobody else.
CREATE OR REPLACE FUNCTION app_can_see_user(target text) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT target = app_user_id()
      -- a doctor sees the patient who asked them, or is connected to them
      OR EXISTS (SELECT 1 FROM pairing_requests pr JOIN doctor_profiles dp ON dp.id = pr.doctor_profile_id
                  WHERE pr.patient_user_id = target AND pr.status IN ('requested', 'accepted')
                    AND dp.user_id = app_user_id() AND dp.active)
      -- a patient sees the doctors they asked, whatever came of it
      OR EXISTS (SELECT 1 FROM pairing_requests pr JOIN doctor_profiles dp ON dp.id = pr.doctor_profile_id
                  WHERE pr.patient_user_id = app_user_id() AND dp.user_id = target)
      -- a caregiver sees the patient they accepted; a patient sees the caregivers they invited
      OR EXISTS (SELECT 1 FROM care_circle_members m
                  WHERE (m.patient_user_id = target AND m.caregiver_user_id = app_user_id() AND m.status = 'active')
                     OR (m.caregiver_user_id = target AND m.patient_user_id = app_user_id()))
      -- colleagues
      OR EXISTS (SELECT 1 FROM org_memberships a JOIN org_memberships b ON b.org_id = a.org_id
                  WHERE a.user_id = app_user_id() AND a.status = 'active' AND b.user_id = target AND b.status = 'active')
$$;

-- An administrator reviews clinicians, organization owners and other administrators, and the people who reported a
-- message. Patients' account rows stay out of reach otherwise.
CREATE OR REPLACE FUNCTION app_admin_may_see_user(target text, target_role text) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT app_is_admin() AND (
    target_role <> 'patient'
    OR EXISTS (SELECT 1 FROM message_reports r WHERE r.reporter_user_id = target)
    OR EXISTS (SELECT 1 FROM org_memberships m WHERE m.user_id = target AND m.status = 'active')
  )
$$;

-- Is this doctor profile one a patient may be offered (active, able to answer, licence not lapsed)?
CREATE OR REPLACE FUNCTION app_is_listed_doctor(profile text) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM doctor_profiles dp WHERE dp.id = profile AND dp.active AND dp.user_id IS NOT NULL
                   AND (dp.credential_expires_at > now() OR (dp.credential_expires_at IS NULL AND dp.source <> 'application')))
$$;

-- Has the signed-in person (or a patient whose care circle they are in) a connection, in any state, with this doctor?
CREATE OR REPLACE FUNCTION app_has_pairing_with_profile(profile text) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM pairing_requests pr
                  WHERE pr.doctor_profile_id = profile
                    AND (pr.patient_user_id = app_user_id() OR app_is_caregiver_of(pr.patient_user_id)))
$$;

-- Is the signed-in person a restricted (non-owner, non-superuser) database session? The guards below bind the
-- application role only; the operator who owns the tables must still be able to run maintenance.
CREATE OR REPLACE FUNCTION app_restricted_session() RETURNS boolean
  LANGUAGE sql STABLE AS $$
  SELECT NOT EXISTS (SELECT 1 FROM pg_roles r WHERE r.rolname = current_user AND (r.rolsuper OR r.rolbypassrls))
     AND current_user IS DISTINCT FROM (SELECT t.tableowner FROM pg_tables t WHERE t.schemaname = 'public' AND t.tablename = 'users')
$$;

-- ---------------------------------------------------------------------------
-- 2. The public doctor directory, as a view. Anyone may search it (it is a public page), so it exposes only what the
--    page shows: never the phone number (revealed on an accepted connection), licence or registry numbers, or who verified
--    the profile. A view runs with its owner's rights, which is what lets the policies below keep doctor_profiles itself
--    private. `is_fixture` is computed here because the application, with no right to read other people's accounts, could not.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW doctor_directory WITH (security_barrier = true) AS
SELECT dp.id, dp.user_id, dp.name, dp.specialty, dp.state, dp.bio, dp.active, dp.source, dp.timezone, dp.languages,
       dp.modalities, dp.clinic, dp.qualifications, dp.years_experience, dp.licensing_body, dp.professional_role,
       dp.verified_at, dp.credential_expires_at, dp.created_at,
       EXISTS (SELECT 1 FROM users u WHERE u.id = dp.user_id AND u.is_demo) AS is_fixture
  FROM doctor_profiles dp
 WHERE dp.active AND dp.user_id IS NOT NULL
   AND (dp.credential_expires_at > now() OR (dp.credential_expires_at IS NULL AND dp.source <> 'application'));

-- ---------------------------------------------------------------------------
-- 3. Guards that hold even when a route forgets to check. A row policy cannot say "this column may not change", a
--    trigger can. They bind the restricted application role only.
-- ---------------------------------------------------------------------------

-- users: nobody becomes an administrator, changes role, becomes (or stops being) a fixture account, or changes the address
-- an account is reached by, through the application. The administrator is created by the operator (npm run admin:create).
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
DROP TRIGGER IF EXISTS users_guard ON users;
CREATE TRIGGER users_guard BEFORE INSERT OR UPDATE ON users FOR EACH ROW EXECUTE FUNCTION avela_users_guard();

-- doctor_profiles: a clinician edits how they are described and how to reach them, never whether they are active, verified,
-- licensed or who they are. Approval, suspension and reinstatement are the server's (system) or an administrator's.
CREATE OR REPLACE FUNCTION avela_doctor_profiles_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT app_restricted_session() OR app_is_system() OR app_is_admin() THEN RETURN NEW; END IF;
  IF (to_jsonb(NEW) - ARRAY['bio', 'languages', 'modalities', 'clinic', 'phone', 'timezone'])
     IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['bio', 'languages', 'modalities', 'clinic', 'phone', 'timezone']) THEN
    RAISE EXCEPTION 'doctor_profiles: only the description and contact details may be edited by the clinician' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS doctor_profiles_guard ON doctor_profiles;
CREATE TRIGGER doctor_profiles_guard BEFORE UPDATE ON doctor_profiles FOR EACH ROW EXECUTE FUNCTION avela_doctor_profiles_guard();

-- doctor_applications: an applicant writes their own details and submits them; only the server or an administrator decides.
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
DROP TRIGGER IF EXISTS doctor_applications_guard ON doctor_applications;
CREATE TRIGGER doctor_applications_guard BEFORE UPDATE ON doctor_applications FOR EACH ROW EXECUTE FUNCTION avela_doctor_applications_guard();

-- The two parties to a connection, a visit or a follow-up never change. The policies let EITHER party update the row, and a
-- clinician's update check ("it is still my profile") would stay true if they re-pointed the row at some other patient: the
-- row would then be visible to, and attributed to, a stranger. A person is added to a record by creating a new one.
CREATE OR REPLACE FUNCTION avela_parties_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  c text;
BEGIN
  IF NOT app_restricted_session() THEN RETURN NEW; END IF;
  FOREACH c IN ARRAY TG_ARGV LOOP
    IF (to_jsonb(NEW) -> c) IS DISTINCT FROM (to_jsonb(OLD) -> c) THEN
      RAISE EXCEPTION '%: % cannot be changed once the record exists', TG_TABLE_NAME, c USING ERRCODE = '42501';
    END IF;
  END LOOP;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS pairing_requests_parties ON pairing_requests;
CREATE TRIGGER pairing_requests_parties BEFORE UPDATE ON pairing_requests FOR EACH ROW
  EXECUTE FUNCTION avela_parties_immutable('patient_user_id', 'doctor_profile_id');
DROP TRIGGER IF EXISTS appointments_parties ON appointments;
CREATE TRIGGER appointments_parties BEFORE UPDATE ON appointments FOR EACH ROW
  EXECUTE FUNCTION avela_parties_immutable('patient_user_id', 'doctor_profile_id', 'pairing_request_id');
DROP TRIGGER IF EXISTS follow_up_tasks_parties ON follow_up_tasks;
CREATE TRIGGER follow_up_tasks_parties BEFORE UPDATE ON follow_up_tasks FOR EACH ROW
  EXECUTE FUNCTION avela_parties_immutable('patient_user_id', 'doctor_profile_id');

-- ---------------------------------------------------------------------------
-- 4. Policies. Each table: row-level security on, then explicit policies. Re-applying drops and recreates them.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  t text;
BEGIN
  FOR t IN SELECT unnest(ARRAY[
    'users', 'doctor_applications', 'doctor_profiles', 'doctor_availability', 'audit_logs', 'prescription_events',
    'pharmacies', 'job_runs', 'job_run_history', 'reminder_deliveries', 'rate_limit_hits', 'schema_migrations'
  ]) LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE (SELECT COALESCE(string_agg(format('DROP POLICY %I ON %I', polname, t), '; '), 'SELECT 1')
               FROM pg_policy WHERE polrelid = format('public.%I', t)::regclass AND polname LIKE 'avela\_%');
  END LOOP;
END $$;

-- users: the account row. See app_can_see_user / app_admin_may_see_user. Only the server (sign-up) creates one, a person
-- changes only their own, and nothing in the application deletes one (erasure is an operator's job).
CREATE POLICY avela_users_select ON users FOR SELECT
  USING (app_is_system() OR app_can_see_user(id) OR app_admin_may_see_user(id, role));
CREATE POLICY avela_users_insert ON users FOR INSERT WITH CHECK (app_is_system());
CREATE POLICY avela_users_update ON users FOR UPDATE
  USING (app_is_system() OR id = app_user_id()) WITH CHECK (app_is_system() OR id = app_user_id());

-- doctor_applications: the applicant, an administrator, and the server.
CREATE POLICY avela_doctor_applications_select ON doctor_applications FOR SELECT
  USING (app_is_system() OR user_id = app_user_id() OR app_is_admin());
CREATE POLICY avela_doctor_applications_insert ON doctor_applications FOR INSERT
  WITH CHECK (app_is_system() OR user_id = app_user_id());
CREATE POLICY avela_doctor_applications_update ON doctor_applications FOR UPDATE
  USING (app_is_system() OR user_id = app_user_id() OR app_is_admin())
  WITH CHECK (app_is_system() OR user_id = app_user_id() OR app_is_admin());
CREATE POLICY avela_doctor_applications_delete ON doctor_applications FOR DELETE USING (app_is_system());

-- doctor_profiles: the clinician's own, an administrator's, and the profile of a doctor you have a connection with (in any
-- state). The public sees the directory view instead. Only the server creates or removes one.
CREATE POLICY avela_doctor_profiles_select ON doctor_profiles FOR SELECT
  USING (app_is_system() OR user_id = app_user_id() OR app_is_admin() OR app_has_pairing_with_profile(id));
CREATE POLICY avela_doctor_profiles_insert ON doctor_profiles FOR INSERT WITH CHECK (app_is_system());
CREATE POLICY avela_doctor_profiles_update ON doctor_profiles FOR UPDATE
  USING (app_is_system() OR app_is_admin() OR user_id = app_user_id())
  WITH CHECK (app_is_system() OR app_is_admin() OR user_id = app_user_id());
CREATE POLICY avela_doctor_profiles_delete ON doctor_profiles FOR DELETE USING (app_is_system());

-- doctor_availability: published windows are public for a listed doctor (the directory shows "next available" to anyone);
-- the clinician edits their own.
CREATE POLICY avela_doctor_availability_select ON doctor_availability FOR SELECT
  USING (app_is_system() OR doctor_profile_id IN (SELECT app_my_doctor_profiles()) OR app_is_listed_doctor(doctor_profile_id));
CREATE POLICY avela_doctor_availability_write ON doctor_availability FOR ALL
  USING (app_is_system() OR doctor_profile_id IN (SELECT app_my_doctor_profiles()))
  WITH CHECK (app_is_system() OR doctor_profile_id IN (SELECT app_my_doctor_profiles()));

-- audit_logs: you read what was done to your records and what you did; an administrator reads the log; anyone may add an
-- entry in their own name. (Append-only: no UPDATE or DELETE privilege, and the trigger from migration 0014.)
CREATE POLICY avela_audit_logs_select ON audit_logs FOR SELECT
  USING (app_is_system() OR subject_user_id = app_user_id() OR actor_user_id = app_user_id() OR app_is_admin());
CREATE POLICY avela_audit_logs_insert ON audit_logs FOR INSERT
  WITH CHECK (app_is_system() OR actor_user_id = app_user_id());

-- prescription_events: visible exactly when the prescription is (the subquery runs under the prescription policies).
CREATE POLICY avela_prescription_events_select ON prescription_events FOR SELECT
  USING (app_is_system() OR EXISTS (SELECT 1 FROM prescriptions p WHERE p.id = prescription_id));
CREATE POLICY avela_prescription_events_insert ON prescription_events FOR INSERT
  WITH CHECK (app_is_system() OR (actor_user_id = app_user_id() AND EXISTS (SELECT 1 FROM prescriptions p WHERE p.id = prescription_id)));

-- pharmacies: reference data with no personal information. Any signed-in person may read; only the operator maintains it.
CREATE POLICY avela_pharmacies_select ON pharmacies FOR SELECT USING (app_is_system() OR app_user_id() IS NOT NULL);

-- The scheduler's bookkeeping, the delivery ledger and the shared rate-limit counters are the server's alone. A patient reads
-- a reminder's delivery history only through the reminder they are allowed to see.
CREATE POLICY avela_job_runs ON job_runs FOR ALL USING (app_is_system()) WITH CHECK (app_is_system());
CREATE POLICY avela_job_run_history ON job_run_history FOR ALL USING (app_is_system()) WITH CHECK (app_is_system());
CREATE POLICY avela_rate_limit_hits ON rate_limit_hits FOR ALL USING (app_is_system()) WITH CHECK (app_is_system());
CREATE POLICY avela_reminder_deliveries_select ON reminder_deliveries FOR SELECT
  USING (app_is_system() OR EXISTS (SELECT 1 FROM medication_reminders r WHERE r.id = reminder_id));
CREATE POLICY avela_reminder_deliveries_write ON reminder_deliveries FOR ALL USING (app_is_system()) WITH CHECK (app_is_system());

-- notifications (policies from migration 0014): anyone signed in could leave a notice for ANY account, which is a way to put
-- words in front of a stranger. Narrowed to yourself and the people your relationships connect you to.
DROP POLICY IF EXISTS avela_notifications_insert ON notifications;
CREATE POLICY avela_notifications_insert ON notifications FOR INSERT
  WITH CHECK (app_is_system() OR user_id = app_user_id() OR app_can_see_user(user_id));

-- schema_migrations: row-level security on and no policy at all, over the missing privilege.

-- ---------------------------------------------------------------------------
-- 5. Privileges. Re-stated as the function the migration runner re-applies after every migration. New here:
--    * a person cannot be deleted by the application, nor can reference data be edited;
--    * functions are no longer executable by everybody (PUBLIC): the application role may call the policy helpers
--      (app_*) and nothing else, and the guard/trigger functions and avela_apply_grants() are not callable by it.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION avela_apply_grants() RETURNS void
  LANGUAGE plpgsql AS $$
DECLARE
  f record;
BEGIN
  -- Functions are executable by PUBLIC unless said otherwise. Say otherwise, whether or not the role exists yet.
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
  -- Never: changing the structure, emptying a table, or touching what records the schema's own history.
  REVOKE CREATE ON SCHEMA public FROM avela_app;
  REVOKE TRUNCATE, REFERENCES, TRIGGER ON ALL TABLES IN SCHEMA public FROM avela_app;
  REVOKE ALL ON schema_migrations FROM avela_app;
  -- Append-only records: the privilege itself forbids edits, in addition to the triggers.
  REVOKE UPDATE, DELETE ON audit_logs, prescription_events FROM avela_app;
  -- People are not deleted by the application (erasure is the operator's job), and reference data is not edited by it.
  REVOKE DELETE ON users FROM avela_app;
  REVOKE INSERT, UPDATE, DELETE ON pharmacies FROM avela_app;
  -- A simple view can be written through, with its OWNER's rights (which skip row-level security). The directory is read-only.
  IF to_regclass('public.doctor_directory') IS NOT NULL THEN
    REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON doctor_directory FROM avela_app;
  END IF;
END $$;

-- Functions created from here on are not executable by PUBLIC either, for the role that runs migrations. (Deliberately not
-- "IN SCHEMA public": the built-in default that gives PUBLIC execute is global, and a schema-level revoke cannot remove it.)
ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

SELECT avela_apply_grants();
