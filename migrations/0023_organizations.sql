-- Organizations (clinics, hospitals, practices) and their staff.
--
-- Belonging to an organization gives NO access to any patient's records. It gives staff roles inside the organization (see
-- shared/permissions.ts) over what the organization itself holds (staff, tasks, notes) and a narrow, operational view of
-- patients who are connected to the organization's own clinicians and whom the patient has not hidden from staff: their name
-- and appointment times and status, nothing about why. Every other organization's patients are invisible.

CREATE TABLE IF NOT EXISTS organizations (
  id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  name varchar(160) NOT NULL,
  kind varchar NOT NULL CHECK (kind IN ('clinic','hospital','practice')),
  country varchar(2) NOT NULL CHECK (country IN ('EG','US')),
  contact_email varchar,
  contact_phone varchar,
  address text,
  -- 'unverified' until an Avela reviewer has recorded how the organization's existence and contact details were checked.
  status varchar NOT NULL DEFAULT 'unverified' CHECK (status IN ('unverified','verified','suspended')),
  verified_at timestamptz,
  verified_by_user_id varchar REFERENCES users(id),
  verification_source varchar CHECK (verification_source IN ('document_review','registry_lookup','issuer_confirmation')),
  verification_note text,
  created_by_user_id varchar NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT org_verified_has_evidence CHECK (status <> 'verified' OR (verified_at IS NOT NULL AND verified_by_user_id IS NOT NULL AND verification_source IS NOT NULL AND verification_note IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS org_memberships (
  id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id varchar NOT NULL REFERENCES organizations(id),
  user_id varchar NOT NULL REFERENCES users(id),
  role varchar NOT NULL CHECK (role IN ('owner','admin','clinician','coordinator','scheduler','auditor')),
  status varchar NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked')),
  invited_by_user_id varchar REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  revoked_by_user_id varchar REFERENCES users(id)
);
CREATE UNIQUE INDEX IF NOT EXISTS org_memberships_one_active ON org_memberships (org_id, user_id) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS org_memberships_user_idx ON org_memberships (user_id, status);

CREATE TABLE IF NOT EXISTS org_invitations (
  id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id varchar NOT NULL REFERENCES organizations(id),
  email varchar NOT NULL,
  role varchar NOT NULL CHECK (role IN ('owner','admin','clinician','coordinator','scheduler','auditor')),
  token_hash varchar NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  status varchar NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','revoked')),
  invited_by_user_id varchar NOT NULL REFERENCES users(id),
  accepted_by_user_id varchar REFERENCES users(id),
  accepted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS org_invitations_org_idx ON org_invitations (org_id, status);

CREATE TABLE IF NOT EXISTS org_tasks (
  id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id varchar NOT NULL REFERENCES organizations(id),
  patient_user_id varchar NOT NULL REFERENCES users(id),
  title varchar(200) NOT NULL,
  due_date varchar,                          -- YYYY-MM-DD
  status varchar NOT NULL DEFAULT 'open' CHECK (status IN ('open','done','cancelled')),
  assigned_to_user_id varchar REFERENCES users(id),
  created_by_user_id varchar NOT NULL REFERENCES users(id),
  completed_by_user_id varchar REFERENCES users(id),
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS org_tasks_org_idx ON org_tasks (org_id, status, due_date);

-- Internal notes: written by staff for staff. A patient is never shown them. Append-only.
CREATE TABLE IF NOT EXISTS org_notes (
  id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id varchar NOT NULL REFERENCES organizations(id),
  patient_user_id varchar NOT NULL REFERENCES users(id),
  body text NOT NULL,
  author_user_id varchar NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS org_notes_org_patient_idx ON org_notes (org_id, patient_user_id, created_at);

CREATE OR REPLACE FUNCTION avela_org_notes_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- Erasing a closed account may blank the text; nothing else changes.
  IF TG_OP = 'UPDATE' AND NEW.body = '[erased]' AND NEW.org_id = OLD.org_id AND NEW.patient_user_id = OLD.patient_user_id AND NEW.author_user_id = OLD.author_user_id THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'org_notes is append-only';
END $$;
DROP TRIGGER IF EXISTS org_notes_guard ON org_notes;
CREATE TRIGGER org_notes_guard BEFORE UPDATE OR DELETE ON org_notes FOR EACH ROW EXECUTE FUNCTION avela_org_notes_guard();

-- The patient decides, per connection, whether the clinician's organization staff may see their name and appointment times.
ALTER TABLE pairing_requests ADD COLUMN IF NOT EXISTS org_staff_visible boolean NOT NULL DEFAULT true;

-- Is the signed-in person an active member of this organization?
CREATE OR REPLACE FUNCTION app_is_org_member(org text) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM org_memberships m WHERE m.org_id = org AND m.user_id = app_user_id() AND m.status = 'active')
$$;

ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE org_memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE org_invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE org_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE org_notes ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS avela_organizations_member ON organizations;
DROP POLICY IF EXISTS avela_organizations_system ON organizations;
DROP POLICY IF EXISTS avela_org_memberships_member ON org_memberships;
DROP POLICY IF EXISTS avela_org_memberships_system ON org_memberships;
DROP POLICY IF EXISTS avela_org_invitations_system ON org_invitations;
DROP POLICY IF EXISTS avela_org_tasks_member ON org_tasks;
DROP POLICY IF EXISTS avela_org_tasks_system ON org_tasks;
DROP POLICY IF EXISTS avela_org_notes_member ON org_notes;
DROP POLICY IF EXISTS avela_org_notes_system ON org_notes;
-- Members may READ what belongs to their own organization; every change is made by the server after it has checked the permission matrix.
CREATE POLICY avela_organizations_member ON organizations FOR SELECT USING (app_is_org_member(id));
CREATE POLICY avela_organizations_system ON organizations FOR ALL USING (app_is_system()) WITH CHECK (app_is_system());
CREATE POLICY avela_org_memberships_member ON org_memberships FOR SELECT USING (user_id = app_user_id() OR app_is_org_member(org_id));
CREATE POLICY avela_org_memberships_system ON org_memberships FOR ALL USING (app_is_system()) WITH CHECK (app_is_system());
CREATE POLICY avela_org_invitations_system ON org_invitations FOR ALL USING (app_is_system()) WITH CHECK (app_is_system());
CREATE POLICY avela_org_tasks_member ON org_tasks FOR SELECT USING (app_is_org_member(org_id));
CREATE POLICY avela_org_tasks_system ON org_tasks FOR ALL USING (app_is_system()) WITH CHECK (app_is_system());
CREATE POLICY avela_org_notes_member ON org_notes FOR SELECT USING (app_is_org_member(org_id));
CREATE POLICY avela_org_notes_system ON org_notes FOR ALL USING (app_is_system()) WITH CHECK (app_is_system());

SELECT avela_apply_grants();
