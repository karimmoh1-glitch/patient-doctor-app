-- Backs out migration 0027 (connection-end semantics). NOT part of the migration runner. Run by hand as the database OWNER:
--   psql "$OWNER_DATABASE_URL" -v ON_ERROR_STOP=1 -f ops/rollback/0027_connection_end_semantics.down.sql
-- Restores the policies and the account-visibility helper as they were after 0025/0026. No data is read or changed.
BEGIN;
DROP POLICY IF EXISTS avela_messages_select ON messages;
DROP POLICY IF EXISTS avela_messages_insert ON messages;
DROP POLICY IF EXISTS avela_messages_update ON messages;
CREATE POLICY avela_messages_select ON messages FOR SELECT USING (app_is_system() OR app_in_pairing(pairing_request_id));
CREATE POLICY avela_messages_insert ON messages FOR INSERT
  WITH CHECK (app_is_system() OR (sender_user_id = app_user_id() AND app_in_pairing(pairing_request_id)));
CREATE POLICY avela_messages_update ON messages FOR UPDATE
  USING (app_is_system() OR (app_in_pairing(pairing_request_id) AND sender_user_id <> app_user_id()))
  WITH CHECK (app_is_system() OR (app_in_pairing(pairing_request_id) AND sender_user_id <> app_user_id()));
DROP POLICY IF EXISTS avela_follow_up_tasks_select ON follow_up_tasks;
DROP POLICY IF EXISTS avela_follow_up_tasks_update ON follow_up_tasks;
CREATE POLICY avela_follow_up_tasks_select ON follow_up_tasks FOR SELECT
  USING (app_can_read_patient(patient_user_id) OR doctor_profile_id IN (SELECT app_my_doctor_profiles()));
CREATE POLICY avela_follow_up_tasks_update ON follow_up_tasks FOR UPDATE
  USING (app_can_write_patient(patient_user_id) OR doctor_profile_id IN (SELECT app_my_doctor_profiles()))
  WITH CHECK (app_can_write_patient(patient_user_id) OR doctor_profile_id IN (SELECT app_my_doctor_profiles()));
DROP POLICY IF EXISTS avela_appointments_update ON appointments;
CREATE POLICY avela_appointments_update ON appointments FOR UPDATE
  USING (app_can_write_patient(patient_user_id) OR doctor_profile_id IN (SELECT app_my_doctor_profiles()))
  WITH CHECK (app_can_write_patient(patient_user_id) OR doctor_profile_id IN (SELECT app_my_doctor_profiles()));
CREATE OR REPLACE FUNCTION app_can_see_user(target text) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT target = (SELECT app_user_id())
      -- a doctor sees the patient who asked them, or is connected to them
      OR EXISTS (SELECT 1 FROM pairing_requests pr JOIN doctor_profiles dp ON dp.id = pr.doctor_profile_id
                  WHERE pr.patient_user_id = target AND pr.status IN ('requested', 'accepted')
                    AND dp.user_id = (SELECT app_user_id()) AND dp.active)
      -- a patient sees the doctors they asked, whatever came of it
      OR EXISTS (SELECT 1 FROM pairing_requests pr JOIN doctor_profiles dp ON dp.id = pr.doctor_profile_id
                  WHERE pr.patient_user_id = (SELECT app_user_id()) AND dp.user_id = target)
      -- a caregiver sees the patient they accepted; a patient sees the caregivers they invited
      OR EXISTS (SELECT 1 FROM care_circle_members m
                  WHERE (m.patient_user_id = target AND m.caregiver_user_id = (SELECT app_user_id()) AND m.status = 'active')
                     OR (m.caregiver_user_id = target AND m.patient_user_id = (SELECT app_user_id())))
      -- colleagues
      OR EXISTS (SELECT 1 FROM org_memberships a JOIN org_memberships b ON b.org_id = a.org_id
                  WHERE a.user_id = (SELECT app_user_id()) AND a.status = 'active' AND b.user_id = target AND b.status = 'active')
$$;
DROP FUNCTION IF EXISTS app_may_read_conversation(text);
DROP FUNCTION IF EXISTS app_may_write_conversation(text);
SELECT avela_apply_grants();
DELETE FROM schema_migrations WHERE name = '0027_connection_end_semantics.sql';
COMMIT;
