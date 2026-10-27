-- What ending a patient-clinician connection means, enforced in the database as well as in the routes.
--
-- Chosen behaviour (docs/CONNECTION_END.md; for clinical and legal review, not decided by engineering alone):
--   * Ending a connection immediately removes the clinician's access to everything that depends on it: the conversation, the symptom
--     report, shared records, follow-up tasks, and the patient's account row. (Routes already refused these; the database now does too.)
--   * What the clinician AUTHORED or PROVIDED stays theirs, read-only in effect: prescriptions they wrote, and the visits they provide or
--     provided (time, reason, status, the patient's name). A visit that is still upcoming when the connection ends is handled explicitly by
--     the patient (cancel it, or keep it) and never silently; a kept visit stays workable by the clinician until it is over.
--   * The patient keeps their own complete history, including the ended conversation, read-only.
--
-- Changes: the message policies stop treating an ended connection like a live one for the clinician's side; follow-up tasks are visible to a
-- clinician only while connected; a clinician can change a visit only while it is still open; and the clinician sees the name of a patient
-- whose visit they provide (the visit record carries it), which the account-row policy previously allowed only through a live connection.
-- Nothing reads or changes a row of data.

-- Is the signed-in person a party to this connection WITH the right to read its conversation? The patient always; the clinician only while it is live.
CREATE OR REPLACE FUNCTION app_may_read_conversation(pairing text) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1 FROM pairing_requests pr
     WHERE pr.id = pairing
       AND (pr.patient_user_id = (SELECT app_user_id())
            OR (pr.status = 'accepted' AND pr.doctor_profile_id IN (SELECT app_my_doctor_profiles())))
  )
$$;

-- May the signed-in person add to, or mark, the conversation? Either party, only while the connection is live.
CREATE OR REPLACE FUNCTION app_may_write_conversation(pairing text) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1 FROM pairing_requests pr
     WHERE pr.id = pairing AND pr.status = 'accepted'
       AND (pr.patient_user_id = (SELECT app_user_id()) OR pr.doctor_profile_id IN (SELECT app_my_doctor_profiles()))
  )
$$;

DROP POLICY IF EXISTS avela_messages_select ON messages;
DROP POLICY IF EXISTS avela_messages_insert ON messages;
DROP POLICY IF EXISTS avela_messages_update ON messages;
CREATE POLICY avela_messages_select ON messages FOR SELECT USING (app_is_system() OR app_may_read_conversation(pairing_request_id));
CREATE POLICY avela_messages_insert ON messages FOR INSERT
  WITH CHECK (app_is_system() OR (sender_user_id = app_user_id() AND app_may_write_conversation(pairing_request_id)));
CREATE POLICY avela_messages_update ON messages FOR UPDATE
  USING (app_is_system() OR (app_may_write_conversation(pairing_request_id) AND sender_user_id <> app_user_id()))
  WITH CHECK (app_is_system() OR (app_may_write_conversation(pairing_request_id) AND sender_user_id <> app_user_id()));

-- Follow-up tasks: visible and changeable by a clinician only through a live connection (the patient's own list is always theirs).
DROP POLICY IF EXISTS avela_follow_up_tasks_select ON follow_up_tasks;
DROP POLICY IF EXISTS avela_follow_up_tasks_update ON follow_up_tasks;
CREATE POLICY avela_follow_up_tasks_select ON follow_up_tasks FOR SELECT USING (app_can_read_patient(patient_user_id));
CREATE POLICY avela_follow_up_tasks_update ON follow_up_tasks FOR UPDATE
  USING (app_can_write_patient(patient_user_id)) WITH CHECK (app_can_write_patient(patient_user_id));

-- Visits: a clinician provides, and keeps the record of, the visits they provide; they may CHANGE one only while it is open (or through a live connection).
DROP POLICY IF EXISTS avela_appointments_update ON appointments;
CREATE POLICY avela_appointments_update ON appointments FOR UPDATE
  USING (app_can_write_patient(patient_user_id) OR (doctor_profile_id IN (SELECT app_my_doctor_profiles()) AND status IN ('requested', 'confirmed')))
  WITH CHECK (app_can_write_patient(patient_user_id) OR doctor_profile_id IN (SELECT app_my_doctor_profiles()));

-- The account row of a patient whose visit the signed-in clinician provides (booked or past): the visit record carries the name.
CREATE OR REPLACE FUNCTION app_can_see_user(target text) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT target = (SELECT app_user_id())
      -- a doctor sees the patient who asked them, or is connected to them
      OR EXISTS (SELECT 1 FROM pairing_requests pr JOIN doctor_profiles dp ON dp.id = pr.doctor_profile_id
                  WHERE pr.patient_user_id = target AND pr.status IN ('requested', 'accepted')
                    AND dp.user_id = (SELECT app_user_id()) AND dp.active)
      -- …or whose visit they provide, whether or not the connection has since ended
      OR EXISTS (SELECT 1 FROM appointments a WHERE a.patient_user_id = target AND a.doctor_profile_id IN (SELECT app_my_doctor_profiles()))
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

SELECT avela_apply_grants();
