-- Connecting a patient and a clinician by a code the clinician shows (a QR code, or a short code typed by hand).
--
-- The code is only a way to find an invitation; it is not proof of a licence and it is not consent. The clinician creates the
-- invitation; the patient sees who it is from and confirms, and only then does a connection exist. Only HMAC hashes of the
-- token and of the short code are stored, so a copy of this table cannot be turned back into working codes. An invitation is
-- single-use, short-lived and revocable, and "accepted" is written in the same transaction that creates the connection.

CREATE TABLE IF NOT EXISTS pairing_invitations (
  id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  doctor_profile_id varchar NOT NULL REFERENCES doctor_profiles(id),
  created_by_user_id varchar NOT NULL REFERENCES users(id),
  token_hash varchar NOT NULL UNIQUE,
  code_hash varchar NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  status varchar NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','revoked')),
  accepted_by_user_id varchar REFERENCES users(id),
  accepted_at timestamptz,
  pairing_request_id varchar REFERENCES pairing_requests(id),
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT accepted_has_patient CHECK (status <> 'accepted' OR (accepted_by_user_id IS NOT NULL AND accepted_at IS NOT NULL AND pairing_request_id IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS pairing_invitations_doctor_idx ON pairing_invitations (doctor_profile_id, created_at DESC);

ALTER TABLE pairing_requests ADD COLUMN IF NOT EXISTS connected_via varchar NOT NULL DEFAULT 'request';
ALTER TABLE pairing_requests ADD COLUMN IF NOT EXISTS invitation_id varchar;
DO $$ BEGIN
  ALTER TABLE pairing_requests ADD CONSTRAINT pairing_connected_via_valid CHECK (connected_via IN ('request','invitation'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE pairing_invitations ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS avela_pairing_invitations_doctor ON pairing_invitations;
DROP POLICY IF EXISTS avela_pairing_invitations_system ON pairing_invitations;
-- A clinician sees and manages only their own invitations. A patient never reads this table directly: redeeming a code
-- is done by the server with system access, after it has checked who is asking.
CREATE POLICY avela_pairing_invitations_doctor ON pairing_invitations FOR ALL
  USING (doctor_profile_id IN (SELECT app_my_doctor_profiles())) WITH CHECK (doctor_profile_id IN (SELECT app_my_doctor_profiles()));
CREATE POLICY avela_pairing_invitations_system ON pairing_invitations FOR ALL USING (app_is_system()) WITH CHECK (app_is_system());

SELECT avela_apply_grants();
