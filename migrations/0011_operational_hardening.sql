-- Operational hardening: demo isolation, reminder retries and monitoring, data
-- requests, and database-level protection for records that must never be edited.

-- 1. Demo accounts are marked. When demo mode is off the server refuses to sign
--    them in or honour their sessions, so well-known demo passwords can never
--    open anything in a real deployment even if the accounts were seeded there.
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_demo boolean NOT NULL DEFAULT false;
UPDATE users SET is_demo = true
 WHERE lower(email) IN ('admin@avela.dev', 'patient@avela.dev', 'doctor@avela.dev', 'caregiver@avela.dev');

-- 2. Reminder delivery: count attempts so a failed send can be retried a bounded
--    number of times, and record when each run last succeeded.
ALTER TABLE reminder_deliveries ADD COLUMN IF NOT EXISTS attempts integer NOT NULL DEFAULT 1;
ALTER TABLE reminder_deliveries ADD COLUMN IF NOT EXISTS updated_at timestamp NOT NULL DEFAULT now();
ALTER TABLE job_runs ADD COLUMN IF NOT EXISTS last_success_at timestamptz;
ALTER TABLE job_runs ADD COLUMN IF NOT EXISTS last_error varchar;
ALTER TABLE job_runs ADD COLUMN IF NOT EXISTS consecutive_failures integer NOT NULL DEFAULT 0;
UPDATE job_runs SET last_success_at = last_run_at WHERE last_success_at IS NULL;

-- 3. A person's requests about their own data (a copy of it, or its removal).
--    Removal is carried out by an operator with a script, so there must be a
--    durable record that someone asked.
CREATE TABLE IF NOT EXISTS data_requests (
  id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id varchar NOT NULL REFERENCES users(id),
  kind varchar NOT NULL,                        -- export | deletion
  status varchar NOT NULL DEFAULT 'open',       -- open | done
  created_at timestamp NOT NULL DEFAULT now(),
  completed_at timestamp
);
CREATE INDEX IF NOT EXISTS idx_data_requests_open ON data_requests (status, created_at);

-- 4. Append-only records. The application never updates or deletes these, and
--    now the database refuses to, whatever code or hand-typed SQL tries.
CREATE OR REPLACE FUNCTION avela_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: % is not allowed', TG_TABLE_NAME, TG_OP USING ERRCODE = '42501';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS audit_logs_append_only ON audit_logs;
CREATE TRIGGER audit_logs_append_only BEFORE UPDATE OR DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION avela_append_only();
DROP TRIGGER IF EXISTS prescription_events_append_only ON prescription_events;
CREATE TRIGGER prescription_events_append_only BEFORE UPDATE OR DELETE ON prescription_events
  FOR EACH ROW EXECUTE FUNCTION avela_append_only();

-- 5. An authorized prescription is frozen. Only its status may move forward
--    (active -> completed | expired | cancelled), its refill counter may count
--    up to the allowance, and its transmission field may be set by a future
--    pharmacy integration. Drafts stay editable; only drafts may be deleted.
CREATE OR REPLACE FUNCTION avela_prescription_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'draft' THEN
      RAISE EXCEPTION 'An authorized prescription cannot be deleted' USING ERRCODE = '42501';
    END IF;
    RETURN OLD;
  END IF;

  IF OLD.status = 'draft' THEN
    RETURN NEW;
  END IF;

  IF NEW.status = 'draft' THEN
    RAISE EXCEPTION 'An authorized prescription cannot go back to a draft' USING ERRCODE = '42501';
  END IF;
  IF OLD.status IN ('cancelled', 'completed', 'expired') AND NEW.status <> OLD.status THEN
    RAISE EXCEPTION 'A % prescription cannot change status again', OLD.status USING ERRCODE = '42501';
  END IF;
  IF ROW(NEW.pairing_request_id, NEW.patient_user_id, NEW.doctor_profile_id, NEW.appointment_id,
         NEW.medication_name, NEW.active_ingredient, NEW.strength, NEW.formulation, NEW.dose, NEW.route,
         NEW.frequency_per_day, NEW.duration_days, NEW.quantity, NEW.refills_allowed,
         NEW.instructions, NEW.warnings, NEW.notes, NEW.start_date, NEW.end_date,
         NEW.issued_at, NEW.authorized_at, NEW.authorized_by_user_id)
     IS DISTINCT FROM
     ROW(OLD.pairing_request_id, OLD.patient_user_id, OLD.doctor_profile_id, OLD.appointment_id,
         OLD.medication_name, OLD.active_ingredient, OLD.strength, OLD.formulation, OLD.dose, OLD.route,
         OLD.frequency_per_day, OLD.duration_days, OLD.quantity, OLD.refills_allowed,
         OLD.instructions, OLD.warnings, OLD.notes, OLD.start_date, OLD.end_date,
         OLD.issued_at, OLD.authorized_at, OLD.authorized_by_user_id) THEN
    RAISE EXCEPTION 'An authorized prescription cannot be edited' USING ERRCODE = '42501';
  END IF;
  IF NEW.refills_used < OLD.refills_used OR NEW.refills_used > NEW.refills_allowed THEN
    RAISE EXCEPTION 'Refills used can only count up to the number allowed' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS prescriptions_guard ON prescriptions;
CREATE TRIGGER prescriptions_guard BEFORE UPDATE OR DELETE ON prescriptions
  FOR EACH ROW EXECUTE FUNCTION avela_prescription_guard();
