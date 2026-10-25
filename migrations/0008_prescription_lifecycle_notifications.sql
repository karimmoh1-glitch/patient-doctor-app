-- Prescription lifecycle, an append-only history, and in-app notifications.
--
-- A prescription is created as a draft by the doctor of record and becomes
-- visible to the patient only when that doctor explicitly authorizes it.
-- Status "active" is the authorized state (kept so existing data and code keep
-- working); "draft" is new; "completed" and "cancelled" are unchanged;
-- "expired" is set when the end date passes.

ALTER TABLE prescriptions ADD COLUMN IF NOT EXISTS active_ingredient text;
ALTER TABLE prescriptions ADD COLUMN IF NOT EXISTS strength text;
ALTER TABLE prescriptions ADD COLUMN IF NOT EXISTS formulation text;
ALTER TABLE prescriptions ADD COLUMN IF NOT EXISTS dose text;
ALTER TABLE prescriptions ADD COLUMN IF NOT EXISTS route text;
ALTER TABLE prescriptions ADD COLUMN IF NOT EXISTS warnings text;
ALTER TABLE prescriptions ADD COLUMN IF NOT EXISTS issued_at timestamp;
ALTER TABLE prescriptions ADD COLUMN IF NOT EXISTS authorized_at timestamp;
ALTER TABLE prescriptions ADD COLUMN IF NOT EXISTS authorized_by_user_id varchar REFERENCES users(id);
-- Whether the prescription was sent to a pharmacy. Avela has no pharmacy or
-- e-prescribing integration, so this stays "not_sent"; it exists so the
-- interface can state that truthfully and a real integration has a place to
-- record confirmed transmission.
ALTER TABLE prescriptions ADD COLUMN IF NOT EXISTS transmission varchar NOT NULL DEFAULT 'not_sent';

-- Prescriptions that already existed were created and shown as active.
UPDATE prescriptions p
   SET authorized_at = COALESCE(p.created_at, now()),
       issued_at = COALESCE(p.created_at, now()),
       authorized_by_user_id = d.user_id
  FROM doctor_profiles d
 WHERE d.id = p.doctor_profile_id AND p.authorized_at IS NULL AND p.status <> 'draft';

CREATE TABLE IF NOT EXISTS prescription_events (
  id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  prescription_id varchar NOT NULL REFERENCES prescriptions(id),
  actor_user_id varchar REFERENCES users(id),
  event varchar NOT NULL,
  created_at timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_prescription_events_rx ON prescription_events (prescription_id, created_at);

-- In-app notifications. The row stores a kind and small parameters, never
-- free text, so the wording is chosen in the reader's language when shown and
-- nothing sensitive is copied into a second table.
CREATE TABLE IF NOT EXISTS notifications (
  id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id varchar NOT NULL REFERENCES users(id),
  kind varchar NOT NULL,
  params jsonb NOT NULL DEFAULT '{}'::jsonb,
  link varchar,
  created_at timestamp NOT NULL DEFAULT now(),
  read_at timestamp
);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications (user_id, created_at DESC);
