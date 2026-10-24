-- Whose information an audit event concerns. Lets a person's access log be a
-- direct indexed query ("everything about ME") instead of a filter over the
-- most recent events of every user.
ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS subject_user_id varchar REFERENCES users(id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_subject_created ON audit_logs (subject_user_id, created_at DESC);

-- Best-effort backfill of existing history, so nobody's log goes blank.
UPDATE audit_logs a SET subject_user_id = r.patient_user_id
  FROM symptom_reports r WHERE a.subject_user_id IS NULL AND a.target_type = 'symptom_report' AND a.target_id = r.id;
UPDATE audit_logs a SET subject_user_id = d.patient_user_id
  FROM documents d WHERE a.subject_user_id IS NULL AND a.target_type = 'document' AND a.target_id = d.id;
UPDATE audit_logs a SET subject_user_id = ap.patient_user_id
  FROM appointments ap WHERE a.subject_user_id IS NULL AND a.target_type = 'appointment' AND a.target_id = ap.id;
UPDATE audit_logs a SET subject_user_id = p.patient_user_id
  FROM prescriptions p WHERE a.subject_user_id IS NULL AND a.target_type = 'prescription' AND a.target_id = p.id;
UPDATE audit_logs a SET subject_user_id = pr.patient_user_id
  FROM pairing_requests pr WHERE a.subject_user_id IS NULL AND a.target_type = 'pairing_request' AND a.target_id = pr.id;
UPDATE audit_logs a SET subject_user_id = c.patient_user_id
  FROM care_circle_members c WHERE a.subject_user_id IS NULL AND a.target_type = 'care_circle_member' AND a.target_id = c.id;
UPDATE audit_logs a SET subject_user_id = o.patient_user_id
  FROM pharmacy_orders o WHERE a.subject_user_id IS NULL AND a.target_type = 'pharmacy_order' AND a.target_id = o.id;
UPDATE audit_logs a SET subject_user_id = u.id
  FROM users u WHERE a.subject_user_id IS NULL AND a.target_type = 'user' AND a.target_id = u.id;
-- Self-service actions with no other target (sharing changes, AI use): the actor.
UPDATE audit_logs SET subject_user_id = actor_user_id
  WHERE subject_user_id IS NULL AND action LIKE ANY (ARRAY['sharing_grant.%', 'ai.%', 'medication.%', 'match_results.%']);
