-- Doctor onboarding and verification.
--
-- A doctor now has an account from the moment they register (so they can finish
-- their profile and see where their application stands), but no doctor profile
-- exists, and no clinical access is granted, until an administrator approves.
-- Status lives on doctor_applications: incomplete | pending | needs_info |
-- approved | rejected | suspended.

ALTER TABLE users ADD COLUMN IF NOT EXISTS language varchar NOT NULL DEFAULT 'en';

ALTER TABLE doctor_applications ADD COLUMN IF NOT EXISTS user_id varchar REFERENCES users(id);
ALTER TABLE doctor_applications ADD COLUMN IF NOT EXISTS display_name text;
ALTER TABLE doctor_applications ADD COLUMN IF NOT EXISTS professional_role varchar;
ALTER TABLE doctor_applications ADD COLUMN IF NOT EXISTS licensing_body text;
ALTER TABLE doctor_applications ADD COLUMN IF NOT EXISTS qualifications text;
ALTER TABLE doctor_applications ADD COLUMN IF NOT EXISTS languages jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE doctor_applications ADD COLUMN IF NOT EXISTS years_experience integer;
ALTER TABLE doctor_applications ADD COLUMN IF NOT EXISTS clinic text;
ALTER TABLE doctor_applications ADD COLUMN IF NOT EXISTS modalities jsonb NOT NULL DEFAULT '["phone"]'::jsonb;
ALTER TABLE doctor_applications ADD COLUMN IF NOT EXISTS info_request text;
ALTER TABLE doctor_applications ADD COLUMN IF NOT EXISTS submitted_at timestamp;

-- A half-finished registration has no licence, specialty or phone yet, and the
-- password now lives only on the user row.
ALTER TABLE doctor_applications ALTER COLUMN password_hash DROP NOT NULL;
ALTER TABLE doctor_applications ALTER COLUMN license_number DROP NOT NULL;
ALTER TABLE doctor_applications ALTER COLUMN licensed_states DROP NOT NULL;
ALTER TABLE doctor_applications ALTER COLUMN specialty DROP NOT NULL;
ALTER TABLE doctor_applications ALTER COLUMN phone DROP NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_doctor_applications_user
  ON doctor_applications (user_id) WHERE user_id IS NOT NULL;

ALTER TABLE doctor_profiles ADD COLUMN IF NOT EXISTS languages jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE doctor_profiles ADD COLUMN IF NOT EXISTS modalities jsonb NOT NULL DEFAULT '["phone"]'::jsonb;
ALTER TABLE doctor_profiles ADD COLUMN IF NOT EXISTS clinic text;
ALTER TABLE doctor_profiles ADD COLUMN IF NOT EXISTS qualifications text;
ALTER TABLE doctor_profiles ADD COLUMN IF NOT EXISTS years_experience integer;
ALTER TABLE doctor_profiles ADD COLUMN IF NOT EXISTS licensing_body text;
ALTER TABLE doctor_profiles ADD COLUMN IF NOT EXISTS professional_role varchar;
-- Set only when an administrator approved this profile. A profile without it
-- (a seeded demonstration doctor) must never be described as reviewed.
ALTER TABLE doctor_profiles ADD COLUMN IF NOT EXISTS verified_at timestamp;
ALTER TABLE doctor_profiles ADD COLUMN IF NOT EXISTS verified_by_user_id varchar REFERENCES users(id);

UPDATE doctor_profiles SET verified_at = created_at WHERE source = 'application' AND verified_at IS NULL;
-- Link existing approved applications to their users.
UPDATE doctor_applications a SET user_id = u.id
  FROM users u WHERE a.user_id IS NULL AND a.status = 'approved' AND lower(u.email) = lower(a.email);
