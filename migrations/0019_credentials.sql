-- Clinician credential verification.
--
-- A credential is a claim the clinician made (a licence or national provider number). It becomes "verified" only when an
-- administrator records HOW it was checked (the source), WHAT they saw (the evidence note) and WHEN it stops being valid.
-- Every change of status is an append-only event. A verified credential whose expiry has passed is "expired" whatever the
-- stored status says, and the clinician is no longer listed to patients.

CREATE TABLE IF NOT EXISTS doctor_credentials (
  id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id varchar NOT NULL REFERENCES doctor_applications(id),
  user_id varchar REFERENCES users(id),
  kind varchar NOT NULL CHECK (kind IN ('license','npi')),
  identifier varchar NOT NULL,
  jurisdiction varchar,
  issuer text,
  status varchar NOT NULL DEFAULT 'pending' CHECK (status IN ('submitted','pending','verified','rejected','suspended','expired')),
  source varchar CHECK (source IN ('document_review','registry_lookup','issuer_confirmation')),
  evidence_note text,
  reviewer_user_id varchar REFERENCES users(id),
  reviewed_at timestamptz,
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (application_id, kind),
  -- "verified" is never a bare word: it needs a source, evidence, a reviewer and a date.
  CONSTRAINT verified_needs_evidence CHECK (status <> 'verified' OR (source IS NOT NULL AND evidence_note IS NOT NULL AND reviewer_user_id IS NOT NULL AND reviewed_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS doctor_credentials_status_idx ON doctor_credentials (status, expires_at);

CREATE TABLE IF NOT EXISTS credential_events (
  id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  credential_id varchar NOT NULL REFERENCES doctor_credentials(id),
  from_status varchar,
  to_status varchar NOT NULL,
  actor_user_id varchar REFERENCES users(id),
  source varchar,
  note text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS credential_events_credential_idx ON credential_events (credential_id, created_at);

CREATE OR REPLACE FUNCTION avela_credential_event_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'credential_events is append-only';
END $$;
DROP TRIGGER IF EXISTS credential_events_guard ON credential_events;
CREATE TRIGGER credential_events_guard BEFORE UPDATE OR DELETE ON credential_events FOR EACH ROW EXECUTE FUNCTION avela_credential_event_guard();

-- The earliest expiry among the clinician's verified licences; listing stops when it passes.
ALTER TABLE doctor_profiles ADD COLUMN IF NOT EXISTS credential_expires_at timestamptz;

ALTER TABLE doctor_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE credential_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS avela_doctor_credentials_select ON doctor_credentials;
DROP POLICY IF EXISTS avela_doctor_credentials_system ON doctor_credentials;
DROP POLICY IF EXISTS avela_credential_events_system ON credential_events;
-- A clinician may read their own credentials' status; only the system (the review code) writes them.
CREATE POLICY avela_doctor_credentials_select ON doctor_credentials FOR SELECT USING (app_is_system() OR user_id = app_user_id());
CREATE POLICY avela_doctor_credentials_system ON doctor_credentials FOR ALL USING (app_is_system()) WITH CHECK (app_is_system());
CREATE POLICY avela_credential_events_system ON credential_events FOR ALL USING (app_is_system()) WITH CHECK (app_is_system());

SELECT avela_apply_grants();
