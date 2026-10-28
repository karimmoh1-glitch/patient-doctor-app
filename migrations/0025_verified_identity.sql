-- Makes "who is asking" something the database VERIFIES instead of something the application SAYS.
--
-- Until now the application told the database who a request was for by writing two plain session settings (app.user_id, app.system),
-- and every policy believed them. Anyone able to run SQL as the application's database role could write those settings too, so the
-- policies could be made to see any person, or the server itself. Worse, the settings lived on the CONNECTION: behind a connection
-- pooler in transaction mode (which production uses: Neon's PgBouncer) a connection is shared between clients, and a measured test
-- against production's pooler showed one client's setting being read back by others. Both problems are closed here:
--
--   * the application presents a short-lived SIGNED assertion (server/identity.ts), set for one TRANSACTION only (set_config(..., true)),
--     so nothing survives to be inherited by the next user of a pooled connection;
--   * avela_identity_check() verifies the signature against a key held in a table the application role cannot read, and the policy
--     helpers app_user_id() / app_is_system() use ONLY its answer. An unsigned, expired, tampered or wrongly keyed assertion means "nobody".
--
-- ROLL-OUT SWITCH. app_identity_config.enforce starts FALSE: a database that has no key yet, or an application release that still writes
-- plain settings, keeps working exactly as before (plain settings are honoured only while enforce is false, and a PRESENT-but-invalid
-- assertion is never honoured even then). The operator registers the key, deploys the matching application, checks it, and only then turns
-- enforcement on (npm run identity:enforce). Turning it off again is the recovery step. verify:production fails until it is on.
--
-- HMAC is computed with the built-in sha256 from two pre-XORed key blocks (RFC 2104), so no extension is needed and the key itself is
-- never stored. Nothing here reads or changes a row of application data.

CREATE TABLE IF NOT EXISTS app_identity_keys (
  kid text PRIMARY KEY CHECK (kid ~ '^[a-z0-9_-]{1,32}$'),
  ipad bytea NOT NULL CHECK (length(ipad) = 64),
  opad bytea NOT NULL CHECK (length(opad) = 64),
  created_at timestamptz NOT NULL DEFAULT now(),
  retired_at timestamptz
);
CREATE TABLE IF NOT EXISTS app_identity_config (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  enforce boolean NOT NULL DEFAULT false,
  max_ttl_seconds integer NOT NULL DEFAULT 300 CHECK (max_ttl_seconds BETWEEN 5 AND 3600),
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO app_identity_config (singleton) VALUES (true) ON CONFLICT DO NOTHING;
-- Row-level security on and NO policy: only the owner (and the definer functions below, which run as the owner) can touch these.
ALTER TABLE app_identity_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_identity_config ENABLE ROW LEVEL SECURITY;

-- The verification. 'user:<id>', 'system', or '' (nobody). Never raises: a malformed assertion is simply nobody.
CREATE OR REPLACE FUNCTION avela_identity_check() RETURNS text
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  tok text := current_setting('app.assertion', true);
  cfg record;
  parts text[];
  k record;
  now_s bigint := extract(epoch FROM now())::bigint;
  exp_s bigint;
  msg bytea;
  expected text;
BEGIN
  SELECT enforce, max_ttl_seconds INTO cfg FROM app_identity_config LIMIT 1;
  IF tok IS NULL OR tok = '' THEN
    -- No assertion. Only while enforcement is off are the old plain settings honoured (roll-out and rollback).
    IF NOT COALESCE(cfg.enforce, true) THEN
      IF current_setting('app.system', true) = 'on' THEN RETURN 'system'; END IF;
      IF COALESCE(current_setting('app.user_id', true), '') <> '' THEN RETURN 'user:' || current_setting('app.user_id', true); END IF;
    END IF;
    RETURN '';
  END IF;

  -- One shape test for the whole value, then split: a malformed assertion is simply nobody.
  IF tok !~ '^v1\.[a-z0-9_-]{1,32}\.(user|system)\.[A-Za-z0-9_-]{1,64}\.[0-9]{1,12}\.[A-Za-z0-9_-]{43}$' THEN RETURN ''; END IF;
  parts := string_to_array(tok, '.');
  IF parts[3] = 'system' AND parts[4] <> '-' THEN RETURN ''; END IF;
  exp_s := parts[5]::bigint;
  IF exp_s < now_s OR exp_s > now_s + COALESCE(cfg.max_ttl_seconds, 300) THEN RETURN ''; END IF;

  SELECT ipad, opad INTO k FROM app_identity_keys WHERE kid = parts[2] AND retired_at IS NULL;
  IF NOT FOUND THEN RETURN ''; END IF;
  msg := convert_to('avela-identity-v1' || chr(10) || parts[2] || chr(10) || parts[3] || chr(10) || parts[4] || chr(10) || parts[5], 'UTF8');
  expected := translate(rtrim(replace(encode(sha256(k.opad || sha256(k.ipad || msg)), 'base64'), chr(10), ''), '='), '+/', '-_');
  -- Compare digests of the two values, so how long the comparison takes says nothing about how much of a guess was right.
  IF sha256(convert_to(expected, 'UTF8')) <> sha256(convert_to(parts[6], 'UTF8')) THEN RETURN ''; END IF;
  RETURN CASE parts[3] WHEN 'system' THEN 'system' ELSE 'user:' || parts[4] END;
END $$;

CREATE OR REPLACE FUNCTION app_verified_user() RETURNS text
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT CASE WHEN i LIKE 'user:%' THEN substr(i, 6) END FROM (SELECT avela_identity_check() AS i) s
$$;
CREATE OR REPLACE FUNCTION app_verified_system() RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT avela_identity_check() = 'system'
$$;

-- The helpers every policy already uses now answer only from the verified identity. The scalar sub-selects let the planner evaluate
-- each once per statement instead of once per row.
CREATE OR REPLACE FUNCTION app_user_id() RETURNS text LANGUAGE sql STABLE AS $$ SELECT (SELECT app_verified_user()) $$;
CREATE OR REPLACE FUNCTION app_is_system() RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT COALESCE((SELECT app_verified_system()), false) $$;


-- COST. A policy is evaluated for every row a statement examines, and the helpers below call app_user_id() for each. Verifying a signature
-- is a few dozen microseconds, so a helper that verified once per scanned row of ANOTHER table (a lookup inside a lookup) multiplied that into
-- milliseconds per row. Each definer helper now asks for the identity once per call, as a scalar sub-select the planner evaluates a single time.
-- (Behaviour is unchanged: these are the 0014/0020/0023/0024 definitions with app_user_id() replaced by (SELECT app_user_id()).)
CREATE OR REPLACE FUNCTION app_can_see_user(target text)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT target = (SELECT app_user_id())
      -- a doctor sees the patient who asked them, or is connected to them
      OR EXISTS (SELECT 1 FROM pairing_requests pr JOIN doctor_profiles dp ON dp.id = pr.doctor_profile_id
                  WHERE pr.patient_user_id = target AND pr.status IN ('requested', 'accepted')
                    AND dp.user_id = (SELECT app_user_id()) AND dp.active)
      -- a patient sees the doctors they asked, whatever came of it
      OR EXISTS (SELECT 1 FROM pairing_requests pr JOIN doctor_profiles dp ON dp.id = pr.doctor_profile_id
                  WHERE pr.patient_user_id = (SELECT app_user_id()) AND dp.user_id = target)
      -- a caregiver sees the patient they accepted; a patient sees the caregivers they invited
      OR EXISTS (SELECT 1 FROM care_circle_members m
                  WHERE (m.patient_user_id = target AND m.caregiver_user_id = (SELECT app_user_id()) AND m.status = 'active')
                     OR (m.caregiver_user_id = target AND m.patient_user_id = (SELECT app_user_id())))
      -- colleagues
      OR EXISTS (SELECT 1 FROM org_memberships a JOIN org_memberships b ON b.org_id = a.org_id
                  WHERE a.user_id = (SELECT app_user_id()) AND a.status = 'active' AND b.user_id = target AND b.status = 'active')
$function$;

CREATE OR REPLACE FUNCTION app_has_pairing_with_profile(profile text)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT EXISTS (SELECT 1 FROM pairing_requests pr
                  WHERE pr.doctor_profile_id = profile
                    AND (pr.patient_user_id = (SELECT app_user_id()) OR app_is_caregiver_of(pr.patient_user_id)))
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
       AND (pr.patient_user_id = (SELECT app_user_id()) OR pr.doctor_profile_id IN (SELECT app_my_doctor_profiles()))
  )
$function$;

CREATE OR REPLACE FUNCTION app_is_admin()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT EXISTS (SELECT 1 FROM users u WHERE u.id = (SELECT app_user_id()) AND u.role = 'admin' AND u.deactivated_at IS NULL)
$function$;

CREATE OR REPLACE FUNCTION app_is_caregiver_of(patient text)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT EXISTS (
    SELECT 1 FROM care_circle_members m
     WHERE m.patient_user_id = patient AND m.caregiver_user_id = (SELECT app_user_id()) AND m.status = 'active'
  )
$function$;

CREATE OR REPLACE FUNCTION app_is_org_member(org text)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT EXISTS (SELECT 1 FROM org_memberships m WHERE m.org_id = org AND m.user_id = (SELECT app_user_id()) AND m.status = 'active')
$function$;

CREATE OR REPLACE FUNCTION app_my_doctor_profiles()
 RETURNS SETOF text
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT dp.id FROM doctor_profiles dp WHERE dp.user_id = (SELECT app_user_id()) AND dp.active
$function$;

-- The identity tables are the owner's alone, whatever the grant function does elsewhere.
CREATE OR REPLACE FUNCTION avela_apply_grants() RETURNS void
  LANGUAGE plpgsql AS $$
DECLARE
  f record;
BEGIN
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
  REVOKE CREATE ON SCHEMA public FROM avela_app;
  REVOKE TRUNCATE, REFERENCES, TRIGGER ON ALL TABLES IN SCHEMA public FROM avela_app;
  REVOKE ALL ON schema_migrations FROM avela_app;
  REVOKE ALL ON app_identity_keys, app_identity_config FROM avela_app;
  REVOKE UPDATE, DELETE ON audit_logs, prescription_events FROM avela_app;
  REVOKE DELETE ON users FROM avela_app;
  REVOKE INSERT, UPDATE, DELETE ON pharmacies FROM avela_app;
  IF to_regclass('public.doctor_directory') IS NOT NULL THEN
    REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON doctor_directory FROM avela_app;
  END IF;
END $$;

SELECT avela_apply_grants();
