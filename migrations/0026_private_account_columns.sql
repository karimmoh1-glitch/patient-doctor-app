-- Separates WHO a person is from everything private about them, in the database, so that being allowed to see an account's row (a connected
-- doctor, a caregiver, a colleague on the same organization's staff) no longer means being able to read its password hash, e-mail address,
-- phone number, date of birth or emergency profile.
--
-- Row-level security decides WHICH rows; it cannot hide columns. So the application's database role loses SELECT on most columns of `users`:
-- it keeps the ten that identify a person (id, name, role, language, time zone, read-receipt choice, fixture flag, created/deactivated/
-- confirmed dates) and nothing else. Everything private is read through SECURITY DEFINER functions that check who is asking:
--
--   app_user_private(id)           the person's own account (no password hash), or the server's. NOT a connected clinician, a clinician with
--                                  an assist grant, a caregiver, an administrator or staff: none of the product's flows reads another
--                                  person's private account columns, so none is allowed to (a clinician helping with a profile reads the
--                                  profile entries, which have their own policies)
--   app_user_credentials(email)    the whole row including the password hash: for the server's sign-in and recovery steps only
--   app_user_credentials_by_id(id) the same for one person: the server, or that person (changing their own password)
--   app_user_contacts(ids)         name, language and e-mail address of the people the server must write to (reminders, notices): the server only
--
-- Writing the private columns still works as before (INSERT and UPDATE keep their privileges and the row policies and guard triggers of
-- migration 0024 still apply); only READING them is closed. No row of data is read or changed.

CREATE OR REPLACE FUNCTION app_user_private(target text)
  RETURNS TABLE (
    id varchar, name text, email varchar, role varchar, state varchar, phone varchar, language varchar, read_receipts boolean, is_demo boolean,
    timezone varchar, emergency_contact_name text, emergency_contact_phone varchar, allergies_text text, emergency_notes text,
    emergency_contact_relationship text, country varchar, date_of_birth text, preferred_name text, contact_method varchar,
    accessibility_notes text, care_preferences jsonb, created_at timestamp, deactivated_at timestamp, email_verified_at timestamp)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  -- COALESCE: with nobody established `target = app_user_id()` is NULL, and NOT NULL is NULL, which would NOT stop the function.
  IF NOT COALESCE(app_is_system() OR target = app_user_id(), false) THEN RETURN; END IF;
  RETURN QUERY
    SELECT u.id, u.name, u.email, u.role, u.state, u.phone, u.language, u.read_receipts, u.is_demo, u.timezone,
           u.emergency_contact_name, u.emergency_contact_phone, u.allergies_text, u.emergency_notes, u.emergency_contact_relationship,
           u.country, u.date_of_birth::text, u.preferred_name, u.contact_method, u.accessibility_notes, u.care_preferences,
           u.created_at, u.deactivated_at, u.email_verified_at
      FROM users u WHERE u.id = target;
END $$;

CREATE OR REPLACE FUNCTION app_user_credentials(by_email text)
  RETURNS TABLE (
    id varchar, name text, email varchar, password_hash varchar, role varchar, state varchar, phone varchar, language varchar,
    read_receipts boolean, is_demo boolean, timezone varchar, country varchar, created_at timestamp, deactivated_at timestamp,
    email_verified_at timestamp)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NOT app_is_system() THEN RETURN; END IF;
  RETURN QUERY
    SELECT u.id, u.name, u.email, u.password_hash, u.role, u.state, u.phone, u.language, u.read_receipts, u.is_demo, u.timezone, u.country,
           u.created_at, u.deactivated_at, u.email_verified_at
      FROM users u WHERE lower(u.email) = lower(btrim(by_email));
END $$;

CREATE OR REPLACE FUNCTION app_user_credentials_by_id(target text)
  RETURNS TABLE (
    id varchar, name text, email varchar, password_hash varchar, role varchar, state varchar, phone varchar, language varchar,
    read_receipts boolean, is_demo boolean, timezone varchar, country varchar, created_at timestamp, deactivated_at timestamp,
    email_verified_at timestamp)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  -- COALESCE: with nobody established `target = app_user_id()` is NULL, and NOT NULL is NULL, which would NOT stop the function.
  IF NOT COALESCE(app_is_system() OR target = app_user_id(), false) THEN RETURN; END IF;
  RETURN QUERY
    SELECT u.id, u.name, u.email, u.password_hash, u.role, u.state, u.phone, u.language, u.read_receipts, u.is_demo, u.timezone, u.country,
           u.created_at, u.deactivated_at, u.email_verified_at
      FROM users u WHERE u.id = target;
END $$;

CREATE OR REPLACE FUNCTION app_user_contacts(ids text[])
  RETURNS TABLE (id varchar, name text, email varchar, language varchar, email_verified_at timestamp)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NOT app_is_system() THEN RETURN; END IF;
  RETURN QUERY SELECT u.id, u.name, u.email, u.language, u.email_verified_at FROM users u WHERE u.id = ANY (ids);
END $$;

-- Privileges: re-stated in the function the migration runner re-applies after every migration, as 0014/0024/0025 did.
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
  -- Only what identifies a person may be READ from an account row; the rest comes through the app_user_* functions. (A table-level SELECT
  -- covers every column, so it is withdrawn and the ten public columns are granted one by one.)
  REVOKE SELECT ON users FROM avela_app;
  GRANT SELECT (id, name, role, language, read_receipts, is_demo, timezone, created_at, deactivated_at, email_verified_at) ON users TO avela_app;
END $$;

SELECT avela_apply_grants();
