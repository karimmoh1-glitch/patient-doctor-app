-- Medication reminders and the record of delivering them.
--
-- A reminder is the patient's own wish to be nudged at certain local times for
-- a medicine they track. The authorized prescription stays the source of truth
-- for what to take; a reminder never changes a dose or a schedule.

CREATE TABLE IF NOT EXISTS medication_reminders (
  id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_user_id varchar NOT NULL REFERENCES users(id),
  medication_id varchar NOT NULL REFERENCES medications(id),
  times jsonb NOT NULL,                                   -- ["08:00","20:00"], local wall-clock
  weekdays jsonb NOT NULL DEFAULT '[0,1,2,3,4,5,6]'::jsonb, -- 0 = Sunday
  timezone varchar NOT NULL,
  start_date varchar NOT NULL,                            -- YYYY-MM-DD in `timezone`
  end_date varchar,
  enabled boolean NOT NULL DEFAULT true,
  email_enabled boolean NOT NULL DEFAULT false,
  -- Off by default: a lock screen or a shared device should not reveal what
  -- someone takes.
  show_medication_name boolean NOT NULL DEFAULT false,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_medication_reminders_one_per_medication ON medication_reminders (medication_id);
CREATE INDEX IF NOT EXISTS idx_medication_reminders_patient ON medication_reminders (patient_user_id);

-- One row per (reminder, due instant, channel). The unique key is what makes
-- delivery safe to retry: two overlapping scheduler runs cannot both send.
CREATE TABLE IF NOT EXISTS reminder_deliveries (
  id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  reminder_id varchar NOT NULL REFERENCES medication_reminders(id) ON DELETE CASCADE,
  due_at timestamptz NOT NULL,
  channel varchar NOT NULL,                               -- in_app | email
  status varchar NOT NULL DEFAULT 'pending',              -- pending | sent | failed
  error_code varchar,
  created_at timestamp NOT NULL DEFAULT now(),
  sent_at timestamp
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_reminder_deliveries_once ON reminder_deliveries (reminder_id, due_at, channel);

-- When each background job last ran, so the interface can say honestly whether
-- automatic delivery is actually happening.
CREATE TABLE IF NOT EXISTS job_runs (
  job varchar PRIMARY KEY,
  last_run_at timestamptz NOT NULL,
  last_result jsonb NOT NULL DEFAULT '{}'::jsonb
);
