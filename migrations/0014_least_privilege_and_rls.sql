-- Database-level protection that does not depend on the application remembering to check.
--
--  1. A restricted role, avela_app, for the running application: it can read and write rows, and
--     nothing else. It cannot create, alter or drop anything, truncate, switch off triggers, or
--     change the append-only records (the audit log and prescription history).
--  2. Row-level security on the tables that hold a person's health information, so even a query
--     with a missing WHERE clause returns only what the signed-in person is allowed to see.
--
-- NOTHING CHANGES FOR A DEPLOYMENT THAT STILL CONNECTS AS THE TABLE OWNER. The owner (and any
-- superuser) is exempt from row-level security by design. These protections apply once the
-- application connects as a member of avela_app (APP_DATABASE_URL) with DB_ENFORCE_RLS=on. The
-- rollout is staged in docs/SECURITY.md. This migration is safe to apply to a live database and
-- to re-apply.
--
-- Who is asking arrives as two session settings the application sets before each statement:
--   app.user_id  the signed-in person's id (empty when nobody is)
--   app.system   'on' for background work and the few steps that must happen before anyone is
--                signed in
-- With neither set, every policy below is false: nothing is visible and nothing can be written.

-- ---------------------------------------------------------------------------
-- 1. The restricted role. NOLOGIN: the operator creates a login role that is a member of it
--    (npm run db:create-app-role), so no password ever appears in a migration.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'avela_app') THEN
    BEGIN
      CREATE ROLE avela_app NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
    EXCEPTION WHEN insufficient_privilege THEN
      RAISE NOTICE 'Could not create role avela_app (insufficient privilege): row-level security policies are still installed.';
    END;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 2. Who is asking. SECURITY DEFINER so a policy can look at relationship tables without
--    triggering those tables' own policies (which would recurse).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app_user_id() RETURNS text
  LANGUAGE sql STABLE AS $$ SELECT NULLIF(current_setting('app.user_id', true), '') $$;

CREATE OR REPLACE FUNCTION app_is_system() RETURNS boolean
  LANGUAGE sql STABLE AS $$ SELECT COALESCE(current_setting('app.system', true), '') = 'on' $$;

-- The profile ids of the signed-in person if they are an active (approved, not suspended) doctor.
CREATE OR REPLACE FUNCTION app_my_doctor_profiles() RETURNS SETOF text
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT dp.id FROM doctor_profiles dp WHERE dp.user_id = app_user_id() AND dp.active
$$;

-- Is the signed-in person a doctor with an accepted connection to this patient?
CREATE OR REPLACE FUNCTION app_is_connected_doctor(patient text) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1 FROM pairing_requests pr
     WHERE pr.patient_user_id = patient AND pr.status = 'accepted'
       AND pr.doctor_profile_id IN (SELECT app_my_doctor_profiles())
  )
$$;

-- Is the signed-in person an accepted caregiver of this patient?
CREATE OR REPLACE FUNCTION app_is_caregiver_of(patient text) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1 FROM care_circle_members m
     WHERE m.patient_user_id = patient AND m.caregiver_user_id = app_user_id() AND m.status = 'accepted'
  )
$$;

-- Is the signed-in person one of the two parties to this doctor-patient connection?
CREATE OR REPLACE FUNCTION app_in_pairing(pairing text) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1 FROM pairing_requests pr
     WHERE pr.id = pairing
       AND (pr.patient_user_id = app_user_id() OR pr.doctor_profile_id IN (SELECT app_my_doctor_profiles()))
  )
$$;

-- Has a patient attached this symptom report to a request addressed to the signed-in doctor?
-- A doctor sees what the patient chose to send with a request even before accepting it.
CREATE OR REPLACE FUNCTION app_doctor_has_report(report text) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1 FROM pairing_requests pr
     WHERE pr.symptom_report_id = report AND pr.status IN ('requested', 'accepted')
       AND pr.doctor_profile_id IN (SELECT app_my_doctor_profiles())
  )
$$;

-- When are these doctors already booked? Booking and the public doctor directory must know, for every
-- patient, which times are taken; they must NOT see whose visit it is. This returns only the doctor, the
-- start and the length, which is exactly what a free/busy view shows and nothing a visit record holds.
CREATE OR REPLACE FUNCTION app_busy_intervals(doctors text[], window_start timestamp, window_end timestamp, exclude_id text DEFAULT NULL)
  RETURNS TABLE (doctor_profile_id text, scheduled_at timestamp, duration_minutes integer)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT a.doctor_profile_id::text, a.scheduled_at, a.duration_minutes
    FROM appointments a
   WHERE a.doctor_profile_id = ANY (doctors)
     AND a.status IN ('requested', 'confirmed')
     AND a.scheduled_at < window_end
     AND a.scheduled_at + (a.duration_minutes * interval '1 minute') > window_start
     AND (exclude_id IS NULL OR a.id <> exclude_id)
$$;

-- May the signed-in person READ this patient's records? The patient, a doctor connected to them, or
-- a caregiver they invited. (The application narrows this further by what was shared.)
CREATE OR REPLACE FUNCTION app_can_read_patient(patient text) RETURNS boolean
  LANGUAGE sql STABLE AS $$
  SELECT app_is_system() OR patient = app_user_id() OR app_is_connected_doctor(patient) OR app_is_caregiver_of(patient)
$$;

-- May they CHANGE this patient's records? The patient, or a doctor connected to them. Never a caregiver.
CREATE OR REPLACE FUNCTION app_can_write_patient(patient text) RETURNS boolean
  LANGUAGE sql STABLE AS $$
  SELECT app_is_system() OR patient = app_user_id() OR app_is_connected_doctor(patient)
$$;

-- Owned by this person (or system).
CREATE OR REPLACE FUNCTION app_owns(owner_id text) RETURNS boolean
  LANGUAGE sql STABLE AS $$ SELECT app_is_system() OR owner_id = app_user_id() $$;

-- ---------------------------------------------------------------------------
-- 3. Policies. Each table: row-level security on, then explicit policies. Re-applying drops and
--    recreates them, so the file always describes the truth.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  t text;
BEGIN
  FOR t IN SELECT unnest(ARRAY[
    'notifications','ai_messages','data_requests','user_devices','password_reset_tokens','email_verification_tokens',
    'medications','medication_logs','medication_reminders','symptom_reports','documents','pharmacy_orders','follow_up_tasks',
    'appointments','prescriptions','sharing_grants','pairing_requests','messages','care_circle_members'
  ]) LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    -- Drop every policy this migration owns on the table (named avela_*), then recreate below.
    EXECUTE (SELECT COALESCE(string_agg(format('DROP POLICY %I ON %I', polname, t), '; '), 'SELECT 1')
               FROM pg_policy WHERE polrelid = format('public.%I', t)::regclass AND polname LIKE 'avela\_%');
  END LOOP;
END $$;

-- Owner-only tables ---------------------------------------------------------------------------
-- Notifications: you read and clear only your own, but anyone signed in may leave one for another
-- person (the doctor is told about a request, the patient about a prescription).
CREATE POLICY avela_notifications_select ON notifications FOR SELECT USING (app_owns(user_id));
CREATE POLICY avela_notifications_update ON notifications FOR UPDATE USING (app_owns(user_id)) WITH CHECK (app_owns(user_id));
CREATE POLICY avela_notifications_delete ON notifications FOR DELETE USING (app_owns(user_id));
CREATE POLICY avela_notifications_insert ON notifications FOR INSERT WITH CHECK (app_is_system() OR app_user_id() IS NOT NULL);

CREATE POLICY avela_ai_messages ON ai_messages FOR ALL USING (app_owns(user_id)) WITH CHECK (app_owns(user_id));
CREATE POLICY avela_data_requests ON data_requests FOR ALL USING (app_owns(user_id)) WITH CHECK (app_owns(user_id));
CREATE POLICY avela_user_devices ON user_devices FOR ALL USING (app_owns(user_id)) WITH CHECK (app_owns(user_id));

-- Single-use secrets: only background/pre-sign-in code ever touches these.
CREATE POLICY avela_password_reset_tokens ON password_reset_tokens FOR ALL USING (app_is_system()) WITH CHECK (app_is_system());
CREATE POLICY avela_email_verification_tokens ON email_verification_tokens FOR ALL USING (app_is_system()) WITH CHECK (app_is_system());

-- A patient's own records: readable by the patient, a connected doctor, an invited caregiver;
-- changeable by the patient or a connected doctor ----------------------------------------------
CREATE POLICY avela_medications_select ON medications FOR SELECT USING (app_can_read_patient(patient_user_id));
CREATE POLICY avela_medications_write ON medications FOR ALL USING (app_can_write_patient(patient_user_id)) WITH CHECK (app_can_write_patient(patient_user_id));

CREATE POLICY avela_medication_logs_select ON medication_logs FOR SELECT USING (app_can_read_patient(patient_user_id));
CREATE POLICY avela_medication_logs_write ON medication_logs FOR ALL USING (app_can_write_patient(patient_user_id)) WITH CHECK (app_can_write_patient(patient_user_id));

CREATE POLICY avela_medication_reminders_select ON medication_reminders FOR SELECT USING (app_can_read_patient(patient_user_id));
CREATE POLICY avela_medication_reminders_write ON medication_reminders FOR ALL USING (app_can_write_patient(patient_user_id)) WITH CHECK (app_can_write_patient(patient_user_id));

CREATE POLICY avela_symptom_reports_select ON symptom_reports FOR SELECT USING (app_can_read_patient(patient_user_id) OR app_doctor_has_report(id));
CREATE POLICY avela_symptom_reports_write ON symptom_reports FOR ALL USING (app_can_write_patient(patient_user_id)) WITH CHECK (app_can_write_patient(patient_user_id));

CREATE POLICY avela_documents_select ON documents FOR SELECT USING (app_can_read_patient(patient_user_id));
CREATE POLICY avela_documents_write ON documents FOR ALL USING (app_can_write_patient(patient_user_id)) WITH CHECK (app_can_write_patient(patient_user_id));

CREATE POLICY avela_pharmacy_orders_select ON pharmacy_orders FOR SELECT USING (app_can_read_patient(patient_user_id));
CREATE POLICY avela_pharmacy_orders_write ON pharmacy_orders FOR ALL USING (app_can_write_patient(patient_user_id)) WITH CHECK (app_can_write_patient(patient_user_id));

-- Follow-up tasks and appointments also belong to the doctor who owns them. A doctor can change their
-- own records for an earlier patient, but can only CREATE one for a patient they are connected to.
CREATE POLICY avela_follow_up_tasks_select ON follow_up_tasks FOR SELECT
  USING (app_can_read_patient(patient_user_id) OR doctor_profile_id IN (SELECT app_my_doctor_profiles()));
CREATE POLICY avela_follow_up_tasks_insert ON follow_up_tasks FOR INSERT WITH CHECK (app_can_write_patient(patient_user_id));
CREATE POLICY avela_follow_up_tasks_update ON follow_up_tasks FOR UPDATE
  USING (app_can_write_patient(patient_user_id) OR doctor_profile_id IN (SELECT app_my_doctor_profiles()))
  WITH CHECK (app_can_write_patient(patient_user_id) OR doctor_profile_id IN (SELECT app_my_doctor_profiles()));
CREATE POLICY avela_follow_up_tasks_delete ON follow_up_tasks FOR DELETE USING (app_can_write_patient(patient_user_id));

CREATE POLICY avela_appointments_select ON appointments FOR SELECT
  USING (app_can_read_patient(patient_user_id) OR doctor_profile_id IN (SELECT app_my_doctor_profiles()));
CREATE POLICY avela_appointments_insert ON appointments FOR INSERT WITH CHECK (app_can_write_patient(patient_user_id));
CREATE POLICY avela_appointments_update ON appointments FOR UPDATE
  USING (app_can_write_patient(patient_user_id) OR doctor_profile_id IN (SELECT app_my_doctor_profiles()))
  WITH CHECK (app_can_write_patient(patient_user_id) OR doctor_profile_id IN (SELECT app_my_doctor_profiles()));
CREATE POLICY avela_appointments_delete ON appointments FOR DELETE USING (app_can_write_patient(patient_user_id));

-- Prescriptions: the patient (and a caregiver) never see a draft; the doctor of record or a
-- connected doctor does. Only the doctor of record writes; the patient may update (for example a
-- refill used), which the prescription triggers already confine to what is allowed after authorization.
CREATE POLICY avela_prescriptions_select ON prescriptions FOR SELECT
  USING (app_is_system()
      OR doctor_profile_id IN (SELECT app_my_doctor_profiles())
      OR app_is_connected_doctor(patient_user_id)
      OR (status <> 'draft' AND (patient_user_id = app_user_id() OR app_is_caregiver_of(patient_user_id))));
CREATE POLICY avela_prescriptions_insert ON prescriptions FOR INSERT
  WITH CHECK (app_is_system() OR (doctor_profile_id IN (SELECT app_my_doctor_profiles()) AND app_is_connected_doctor(patient_user_id)));
CREATE POLICY avela_prescriptions_update ON prescriptions FOR UPDATE
  USING (app_is_system() OR doctor_profile_id IN (SELECT app_my_doctor_profiles()) OR (status <> 'draft' AND patient_user_id = app_user_id()))
  WITH CHECK (app_is_system() OR doctor_profile_id IN (SELECT app_my_doctor_profiles()) OR (status <> 'draft' AND patient_user_id = app_user_id()));
CREATE POLICY avela_prescriptions_delete ON prescriptions FOR DELETE
  USING (app_is_system() OR doctor_profile_id IN (SELECT app_my_doctor_profiles()));

-- Sharing grants: the patient's decision; the doctor it names can see that it exists.
CREATE POLICY avela_sharing_grants_select ON sharing_grants FOR SELECT
  USING (app_owns(patient_user_id) OR shared_with_doctor_profile_id IN (SELECT app_my_doctor_profiles()));
CREATE POLICY avela_sharing_grants_write ON sharing_grants FOR ALL USING (app_owns(patient_user_id)) WITH CHECK (app_owns(patient_user_id));

-- Doctor-patient connections and their messages: the two parties only.
CREATE POLICY avela_pairing_requests_select ON pairing_requests FOR SELECT
  USING (app_owns(patient_user_id) OR doctor_profile_id IN (SELECT app_my_doctor_profiles()));
CREATE POLICY avela_pairing_requests_insert ON pairing_requests FOR INSERT WITH CHECK (app_owns(patient_user_id));
CREATE POLICY avela_pairing_requests_update ON pairing_requests FOR UPDATE
  USING (app_owns(patient_user_id) OR doctor_profile_id IN (SELECT app_my_doctor_profiles()))
  WITH CHECK (app_owns(patient_user_id) OR doctor_profile_id IN (SELECT app_my_doctor_profiles()));
CREATE POLICY avela_pairing_requests_delete ON pairing_requests FOR DELETE USING (app_is_system());

CREATE POLICY avela_messages_select ON messages FOR SELECT USING (app_is_system() OR app_in_pairing(pairing_request_id));
CREATE POLICY avela_messages_insert ON messages FOR INSERT
  WITH CHECK (app_is_system() OR (sender_user_id = app_user_id() AND app_in_pairing(pairing_request_id)));

-- Care circle: the patient who invited, and the caregiver once they accepted. Acceptance by an
-- invitation link happens before anyone is signed in (system).
CREATE POLICY avela_care_circle_select ON care_circle_members FOR SELECT
  USING (app_owns(patient_user_id) OR caregiver_user_id = app_user_id());
CREATE POLICY avela_care_circle_write ON care_circle_members FOR ALL USING (app_owns(patient_user_id)) WITH CHECK (app_owns(patient_user_id));

-- ---------------------------------------------------------------------------
-- 4. Privileges for avela_app. A function, so the migration runner can re-apply it after every
--    migration and a table added later is covered without anyone remembering.
-- ---------------------------------------------------------------------------
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

SELECT avela_apply_grants();
