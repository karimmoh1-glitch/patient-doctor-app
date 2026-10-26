-- A patient's own health information, with provenance.
--
-- Principles that the structure enforces:
--   * "No known allergies" is something a person (or a clinician) SAYS, recorded with who said it and when. An empty list is
--     "not collected", never "none".
--   * Every item says who entered it (patient, or a clinician helping) and whether a clinician has verified it. Patient-reported
--     information is never presented as verified.
--   * Nothing is overwritten: an amendment adds a new row that supersedes the old one; a removal marks the row withdrawn; every
--     step is an append-only event.
--   * A clinician can read or enter a patient's profile only under a grant the patient made, naming that clinician, with an
--     expiry, revocable at any time. A connection alone is not enough.

ALTER TABLE users ADD COLUMN IF NOT EXISTS date_of_birth date;
ALTER TABLE users ADD COLUMN IF NOT EXISTS country varchar(2);
ALTER TABLE users ADD COLUMN IF NOT EXISTS preferred_name text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS contact_method varchar;
ALTER TABLE users ADD COLUMN IF NOT EXISTS accessibility_notes text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS emergency_contact_relationship text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS care_preferences jsonb NOT NULL DEFAULT '{}'::jsonb;
DO $$ BEGIN
  ALTER TABLE users ADD CONSTRAINT users_country_supported CHECK (country IS NULL OR country IN ('EG','US'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE users ADD CONSTRAINT users_contact_method_valid CHECK (contact_method IS NULL OR contact_method IN ('email','phone','in_app'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS onboarding_sections (
  patient_user_id varchar NOT NULL REFERENCES users(id),
  section varchar NOT NULL CHECK (section IN ('basic','allergies','medications','history','preferences','review')),
  status varchar NOT NULL DEFAULT 'in_progress' CHECK (status IN ('in_progress','complete','skipped')),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (patient_user_id, section)
);

-- What is KNOWN about allergies, as an explicit statement. No row = not collected.
CREATE TABLE IF NOT EXISTS allergy_statements (
  patient_user_id varchar PRIMARY KEY REFERENCES users(id),
  state varchar NOT NULL CHECK (state IN ('has_known','none_known','unknown')),
  stated_by_user_id varchar NOT NULL REFERENCES users(id),
  stated_by_role varchar NOT NULL CHECK (stated_by_role IN ('patient','doctor')),
  stated_at timestamptz NOT NULL DEFAULT now(),
  reviewed_by_user_id varchar REFERENCES users(id),   -- a clinician who reviewed the whole statement
  reviewed_at timestamptz
);

CREATE TABLE IF NOT EXISTS health_entries (
  id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_user_id varchar NOT NULL REFERENCES users(id),
  kind varchar NOT NULL CHECK (kind IN ('allergy','medication','condition','procedure','provider','need')),
  data jsonb NOT NULL,
  source varchar NOT NULL CHECK (source IN ('patient_reported','clinician_entered')),
  status varchar NOT NULL DEFAULT 'active' CHECK (status IN ('active','superseded','withdrawn')),
  entered_by_user_id varchar NOT NULL REFERENCES users(id),
  entered_by_role varchar NOT NULL CHECK (entered_by_role IN ('patient','doctor')),
  verified_by_user_id varchar REFERENCES users(id),
  verified_at timestamptz,
  disputed_at timestamptz,
  dispute_note text,
  supersedes_id varchar REFERENCES health_entries(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS health_entries_patient_idx ON health_entries (patient_user_id, kind, status);

CREATE TABLE IF NOT EXISTS health_entry_events (
  id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  entry_id varchar NOT NULL REFERENCES health_entries(id),
  action varchar NOT NULL CHECK (action IN ('created','amended','withdrawn','verified','disputed')),
  actor_user_id varchar NOT NULL REFERENCES users(id),
  actor_role varchar NOT NULL,
  data jsonb,
  note text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS health_entry_events_entry_idx ON health_entry_events (entry_id, created_at);

-- Append-only, with one exception: erasing a closed account may blank what the event carried (never who, what or when).
CREATE OR REPLACE FUNCTION avela_health_events_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.data IS NULL AND NEW.note IS NOT DISTINCT FROM '[erased]'
     AND NEW.entry_id = OLD.entry_id AND NEW.action = OLD.action AND NEW.actor_user_id = OLD.actor_user_id AND NEW.created_at = OLD.created_at THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'health_entry_events is append-only';
END $$;
DROP TRIGGER IF EXISTS health_entry_events_guard ON health_entry_events;
CREATE TRIGGER health_entry_events_guard BEFORE UPDATE OR DELETE ON health_entry_events FOR EACH ROW EXECUTE FUNCTION avela_health_events_guard();

-- The stored data of an entry cannot be edited in place, only superseded (status and verification fields may change).
CREATE OR REPLACE FUNCTION avela_health_entry_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'health entries are never deleted'; END IF;
  -- The one exception: erasing a closed account replaces what a patient wrote with a tombstone.
  IF NEW.data = '{"erased": true}'::jsonb AND NEW.kind = OLD.kind AND NEW.patient_user_id = OLD.patient_user_id AND NEW.source = OLD.source THEN
    RETURN NEW;
  END IF;
  IF NEW.data IS DISTINCT FROM OLD.data OR NEW.kind <> OLD.kind OR NEW.patient_user_id <> OLD.patient_user_id
     OR NEW.source <> OLD.source OR NEW.entered_by_user_id <> OLD.entered_by_user_id THEN
    RAISE EXCEPTION 'a health entry cannot be edited in place: amend it';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS health_entries_guard ON health_entries;
CREATE TRIGGER health_entries_guard BEFORE UPDATE OR DELETE ON health_entries FOR EACH ROW EXECUTE FUNCTION avela_health_entry_guard();

-- Consent, by purpose, with the wording version the person saw.
CREATE TABLE IF NOT EXISTS patient_consents (
  id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_user_id varchar NOT NULL REFERENCES users(id),
  purpose varchar NOT NULL CHECK (purpose IN ('health_profile_storage')),
  version varchar NOT NULL,
  granted_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz
);
CREATE INDEX IF NOT EXISTS patient_consents_patient_idx ON patient_consents (patient_user_id, purpose, granted_at);

-- A patient lets one clinician (with an accepted connection) help fill in or review their profile, for a limited time.
CREATE TABLE IF NOT EXISTS assist_grants (
  id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_user_id varchar NOT NULL REFERENCES users(id),
  doctor_profile_id varchar NOT NULL REFERENCES doctor_profiles(id),
  granted_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz
);
CREATE INDEX IF NOT EXISTS assist_grants_patient_idx ON assist_grants (patient_user_id, doctor_profile_id);

-- Is the signed-in person a clinician the patient has authorised right now, who is still approved and still connected?
CREATE OR REPLACE FUNCTION app_has_assist_grant(patient text) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1 FROM assist_grants g
     WHERE g.patient_user_id = patient AND g.revoked_at IS NULL AND g.expires_at > now()
       AND g.doctor_profile_id IN (SELECT app_my_doctor_profiles())
       AND EXISTS (SELECT 1 FROM pairing_requests pr WHERE pr.patient_user_id = patient AND pr.doctor_profile_id = g.doctor_profile_id AND pr.status = 'accepted')
  )
$$;

CREATE OR REPLACE FUNCTION app_can_see_profile(patient text) RETURNS boolean
  LANGUAGE sql STABLE AS $$ SELECT app_is_system() OR patient = app_user_id() OR app_has_assist_grant(patient) $$;

ALTER TABLE onboarding_sections ENABLE ROW LEVEL SECURITY;
ALTER TABLE allergy_statements ENABLE ROW LEVEL SECURITY;
ALTER TABLE health_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE health_entry_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE patient_consents ENABLE ROW LEVEL SECURITY;
ALTER TABLE assist_grants ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS avela_onboarding_sections ON onboarding_sections;
DROP POLICY IF EXISTS avela_allergy_statements ON allergy_statements;
DROP POLICY IF EXISTS avela_health_entries ON health_entries;
DROP POLICY IF EXISTS avela_health_entry_events_select ON health_entry_events;
DROP POLICY IF EXISTS avela_health_entry_events_insert ON health_entry_events;
DROP POLICY IF EXISTS avela_patient_consents ON patient_consents;
DROP POLICY IF EXISTS avela_patient_consents_assist ON patient_consents;
DROP POLICY IF EXISTS avela_assist_grants_patient ON assist_grants;
DROP POLICY IF EXISTS avela_assist_grants_doctor ON assist_grants;

CREATE POLICY avela_onboarding_sections ON onboarding_sections FOR ALL USING (app_owns(patient_user_id)) WITH CHECK (app_owns(patient_user_id));
CREATE POLICY avela_allergy_statements ON allergy_statements FOR ALL USING (app_can_see_profile(patient_user_id)) WITH CHECK (app_can_see_profile(patient_user_id));
CREATE POLICY avela_health_entries ON health_entries FOR ALL USING (app_can_see_profile(patient_user_id)) WITH CHECK (app_can_see_profile(patient_user_id));
CREATE POLICY avela_health_entry_events_select ON health_entry_events FOR SELECT
  USING (EXISTS (SELECT 1 FROM health_entries e WHERE e.id = entry_id AND app_can_see_profile(e.patient_user_id)));
CREATE POLICY avela_health_entry_events_insert ON health_entry_events FOR INSERT
  WITH CHECK (EXISTS (SELECT 1 FROM health_entries e WHERE e.id = entry_id AND app_can_see_profile(e.patient_user_id)));
CREATE POLICY avela_patient_consents ON patient_consents FOR ALL USING (app_owns(patient_user_id)) WITH CHECK (app_owns(patient_user_id));
-- A clinician with a live grant must be able to confirm the patient's consent is in force before writing anything.
CREATE POLICY avela_patient_consents_assist ON patient_consents FOR SELECT USING (app_has_assist_grant(patient_user_id));
CREATE POLICY avela_assist_grants_patient ON assist_grants FOR ALL USING (app_owns(patient_user_id)) WITH CHECK (app_owns(patient_user_id));
CREATE POLICY avela_assist_grants_doctor ON assist_grants FOR SELECT USING (doctor_profile_id IN (SELECT app_my_doctor_profiles()));

-- Legacy free-text allergy note: keep what the patient wrote, as a patient-reported entry, without interpreting it.
INSERT INTO health_entries (patient_user_id, kind, data, source, entered_by_user_id, entered_by_role)
SELECT u.id, 'allergy', jsonb_build_object('substance', left(u.allergies_text, 200), 'notes', 'Written earlier as free text; not reviewed.'), 'patient_reported', u.id, 'patient'
  FROM users u
 WHERE u.role = 'patient' AND u.allergies_text IS NOT NULL AND btrim(u.allergies_text) <> ''
   AND NOT EXISTS (SELECT 1 FROM health_entries e WHERE e.patient_user_id = u.id AND e.kind = 'allergy');

INSERT INTO health_entry_events (entry_id, action, actor_user_id, actor_role)
SELECT e.id, 'created', e.entered_by_user_id, e.entered_by_role FROM health_entries e
 WHERE NOT EXISTS (SELECT 1 FROM health_entry_events v WHERE v.entry_id = e.id);

SELECT avela_apply_grants();
