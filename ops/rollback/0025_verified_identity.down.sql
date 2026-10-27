-- Backs out migration 0025 (verified identity). NOT part of the migration runner. Run by hand as the database OWNER, and only together with
-- redeploying an application release that writes the plain app.user_id / app.system settings (for example the 0024 candidate before
-- the identity work). Simpler and safer first step if the only problem is that requests are being rejected: `npm run identity:enforce -- off`,
-- which keeps everything in place and honours the old plain settings again.
--
--   psql "$OWNER_DATABASE_URL" -v ON_ERROR_STOP=1 -f ops/rollback/0025_verified_identity.down.sql
--
-- No application row is read or changed. After it, `app_user_id()` and `app_is_system()` again believe the plain session settings.
BEGIN;

CREATE OR REPLACE FUNCTION app_user_id() RETURNS text
  LANGUAGE sql STABLE AS $$ SELECT NULLIF(current_setting('app.user_id', true), '') $$;
CREATE OR REPLACE FUNCTION app_is_system() RETURNS boolean
  LANGUAGE sql STABLE AS $$ SELECT COALESCE(current_setting('app.system', true), '') = 'on' $$;

DROP FUNCTION IF EXISTS app_verified_user();
DROP FUNCTION IF EXISTS app_verified_system();
DROP FUNCTION IF EXISTS avela_identity_check();
DROP TABLE IF EXISTS app_identity_config;
DROP TABLE IF EXISTS app_identity_keys;

-- The helpers as 0014/0020/0023/0024 defined them (without the once-per-call identity sub-select).
CREATE OR REPLACE FUNCTION app_can_see_user(target text)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT target = app_user_id()
      -- a doctor sees the patient who asked them, or is connected to them
      OR EXISTS (SELECT 1 FROM pairing_requests pr JOIN doctor_profiles dp ON dp.id = pr.doctor_profile_id
                  WHERE pr.patient_user_id = target AND pr.status IN ('requested', 'accepted')
                    AND dp.user_id = app_user_id() AND dp.active)
      -- a patient sees the doctors they asked, whatever came of it
      OR EXISTS (SELECT 1 FROM pairing_requests pr JOIN doctor_profiles dp ON dp.id = pr.doctor_profile_id
                  WHERE pr.patient_user_id = app_user_id() AND dp.user_id = target)
      -- a caregiver sees the patient they accepted; a patient sees the caregivers they invited
      OR EXISTS (SELECT 1 FROM care_circle_members m
                  WHERE (m.patient_user_id = target AND m.caregiver_user_id = app_user_id() AND m.status = 'active')
                     OR (m.caregiver_user_id = target AND m.patient_user_id = app_user_id()))
      -- colleagues
      OR EXISTS (SELECT 1 FROM org_memberships a JOIN org_memberships b ON b.org_id = a.org_id
                  WHERE a.user_id = app_user_id() AND a.status = 'active' AND b.user_id = target AND b.status = 'active')
$function$;

CREATE OR REPLACE FUNCTION app_has_pairing_with_profile(profile text)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT EXISTS (SELECT 1 FROM pairing_requests pr
                  WHERE pr.doctor_profile_id = profile
                    AND (pr.patient_user_id = app_user_id() OR app_is_caregiver_of(pr.patient_user_id)))
$function$;

CREATE OR REPLACE FUNCTION app_in_pairing(pairing text)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT EXISTS (
    SELECT 1 FROM pairing_requests pr
     WHERE pr.id = pairing
       AND (pr.patient_user_id = app_user_id() OR pr.doctor_profile_id IN (SELECT app_my_doctor_profiles()))
  )
$function$;

CREATE OR REPLACE FUNCTION app_is_admin()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT EXISTS (SELECT 1 FROM users u WHERE u.id = app_user_id() AND u.role = 'admin' AND u.deactivated_at IS NULL)
$function$;

CREATE OR REPLACE FUNCTION app_is_caregiver_of(patient text)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT EXISTS (
    SELECT 1 FROM care_circle_members m
     WHERE m.patient_user_id = patient AND m.caregiver_user_id = app_user_id() AND m.status = 'active'
  )
$function$;

CREATE OR REPLACE FUNCTION app_is_org_member(org text)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT EXISTS (SELECT 1 FROM org_memberships m WHERE m.org_id = org AND m.user_id = app_user_id() AND m.status = 'active')
$function$;

CREATE OR REPLACE FUNCTION app_my_doctor_profiles()
 RETURNS SETOF text
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT dp.id FROM doctor_profiles dp WHERE dp.user_id = app_user_id() AND dp.active
$function$;

-- avela_apply_grants() as migration 0024 defined it.
CREATE OR REPLACE FUNCTION avela_apply_grants() RETURNS void
  LANGUAGE plpgsql AS $$
DECLARE
  f record;
BEGIN
  -- Functions are executable by PUBLIC unless said otherwise. Say otherwise, whether or not the role exists yet.
  FOR f IN SELECT p.oid::regprocedure AS sig, p.proname FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.prokind = 'f'
                AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e') LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f.sig);
  END LOOP;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'avela_app') THEN
    RETURN;
  END IF;
  GRANT USAGE ON SCHEMA public TO avela_app;
  GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO avela_app;
  GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO avela_app;
  FOR f IN SELECT p.oid::regprocedure AS sig, p.proname FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.prokind = 'f'
                AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e') LOOP
    IF f.proname LIKE 'app\_%' THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO avela_app', f.sig);
    ELSE
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM avela_app', f.sig);
    END IF;
  END LOOP;
  -- Never: changing the structure, emptying a table, or touching what records the schema's own history.
  REVOKE CREATE ON SCHEMA public FROM avela_app;
  REVOKE TRUNCATE, REFERENCES, TRIGGER ON ALL TABLES IN SCHEMA public FROM avela_app;
  REVOKE ALL ON schema_migrations FROM avela_app;
  -- Append-only records: the privilege itself forbids edits, in addition to the triggers.
  REVOKE UPDATE, DELETE ON audit_logs, prescription_events FROM avela_app;
  -- People are not deleted by the application (erasure is the operator's job), and reference data is not edited by it.
  REVOKE DELETE ON users FROM avela_app;
  REVOKE INSERT, UPDATE, DELETE ON pharmacies FROM avela_app;
  -- A simple view can be written through, with its OWNER's rights (which skip row-level security). The directory is read-only.
  IF to_regclass('public.doctor_directory') IS NOT NULL THEN
    REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON doctor_directory FROM avela_app;
  END IF;
END $$;

SELECT avela_apply_grants();
DELETE FROM schema_migrations WHERE name = '0025_verified_identity.sql';
COMMIT;
