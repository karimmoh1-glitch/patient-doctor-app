-- Reminders a person sets for themselves, with or without a doctor: medicines they list themselves, appointments, tasks, bills and
-- subscription renewals. Separate from medication_reminders, which belong to a clinician-authorised prescription.
--
-- A reminder is a nudge, not a record: nothing here says a dose was taken or a bill was paid, charges nothing, cancels nothing,
-- and changes no medical instruction. Delivery is per occurrence and per channel, recorded once under a unique key.

CREATE TABLE IF NOT EXISTS personal_reminders (
  id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_user_id varchar NOT NULL REFERENCES users(id),
  kind varchar NOT NULL CHECK (kind IN ('medication','appointment','task','bill','subscription','other')),
  title varchar(120) NOT NULL,
  notes text,
  -- Repeating or one-time schedule (everything except bills and subscriptions)
  recurrence varchar CHECK (recurrence IN ('once','daily','weekly','monthly','yearly')),
  times jsonb NOT NULL DEFAULT '["09:00"]'::jsonb,
  weekdays jsonb NOT NULL DEFAULT '[0,1,2,3,4,5,6]'::jsonb,
  anchor_date varchar,                       -- YYYY-MM-DD in `timezone`
  start_date varchar,
  end_date varchar,
  timezone varchar NOT NULL,
  -- Bills and subscriptions
  renewal_date varchar,
  renewal_interval varchar CHECK (renewal_interval IN ('weekly','monthly','quarterly','yearly')),
  offsets_days jsonb NOT NULL DEFAULT '[3]'::jsonb,
  cancel_by_date varchar,
  amount_minor bigint CHECK (amount_minor IS NULL OR amount_minor >= 0),
  currency varchar(3) CHECK (currency IS NULL OR currency ~ '^[A-Z]{3}$'),
  -- A medicine the person listed in their health information (never a prescription)
  health_entry_id varchar REFERENCES health_entries(id),
  status varchar NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','cancelled')),
  email_enabled boolean NOT NULL DEFAULT false,
  show_title_in_email boolean NOT NULL DEFAULT false,
  quiet_start varchar,
  quiet_end varchar,
  snoozed_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT personal_reminder_shape CHECK (
    (kind IN ('bill','subscription') AND renewal_date IS NOT NULL)
    OR (kind NOT IN ('bill','subscription') AND recurrence IS NOT NULL AND anchor_date IS NOT NULL)
  )
);
CREATE INDEX IF NOT EXISTS personal_reminders_patient_idx ON personal_reminders (patient_user_id, status);

CREATE TABLE IF NOT EXISTS personal_reminder_deliveries (
  id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  reminder_id varchar NOT NULL REFERENCES personal_reminders(id) ON DELETE CASCADE,
  due_at timestamptz NOT NULL,
  channel varchar NOT NULL CHECK (channel IN ('in_app','email')),
  -- in_app: 'sent' means a notice was placed in the person's Avela inbox.
  -- email:  'sent' means the e-mail provider ACCEPTED the message; 'suppressed' means quiet hours held it back for good.
  status varchar NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','failed','suppressed')),
  occurrence varchar NOT NULL DEFAULT 'due',  -- due | renewal | cancel_by
  offset_days integer,
  error_code varchar,
  attempts integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (reminder_id, due_at, channel)
);

ALTER TABLE personal_reminders ENABLE ROW LEVEL SECURITY;
ALTER TABLE personal_reminder_deliveries ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS avela_personal_reminders ON personal_reminders;
DROP POLICY IF EXISTS avela_personal_reminder_deliveries ON personal_reminder_deliveries;
-- Private to the person who set them. No doctor, caregiver or administrator reads these through the application.
CREATE POLICY avela_personal_reminders ON personal_reminders FOR ALL USING (app_owns(patient_user_id)) WITH CHECK (app_owns(patient_user_id));
CREATE POLICY avela_personal_reminder_deliveries ON personal_reminder_deliveries FOR ALL
  USING (EXISTS (SELECT 1 FROM personal_reminders r WHERE r.id = reminder_id AND app_owns(r.patient_user_id)))
  WITH CHECK (EXISTS (SELECT 1 FROM personal_reminders r WHERE r.id = reminder_id AND app_owns(r.patient_user_id)));

SELECT avela_apply_grants();
