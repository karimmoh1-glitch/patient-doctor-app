-- Backs out migration 0026 (private account columns). NOT part of the migration runner. Run by hand as the database OWNER, and only together
-- with redeploying an application release from before the column split (it selects the private columns of `users` directly):
--   psql "$OWNER_DATABASE_URL" -v ON_ERROR_STOP=1 -f ops/rollback/0026_private_account_columns.down.sql
-- No data is read or changed.
BEGIN;
DROP FUNCTION IF EXISTS app_user_private(text);
DROP FUNCTION IF EXISTS app_user_credentials(text);
DROP FUNCTION IF EXISTS app_user_credentials_by_id(text);
DROP FUNCTION IF EXISTS app_user_contacts(text[]);

-- avela_apply_grants() as migration 0025 defined it (table-level SELECT on users).
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
GRANT SELECT ON users TO avela_app;
DELETE FROM schema_migrations WHERE name = '0026_private_account_columns.sql';
COMMIT;
