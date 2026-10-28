-- D-03c: the signed identity now names WHO is acting, not only which part of the server. Until now the `staff`, `review` and `mfa` scopes limited the tables and
-- commands a code path could use, but inside those tables the database could not tell which organization, applicant or account the acting person may touch:
-- that was decided in application code before the scope was entered. After this migration, for the paths below, the database checks it too.
--
--   * A system assertion may carry an ACTOR: `v1.<kid>.system.<scope>~<actorId>.<exp>.<mac>`. The actor is part of the signed text, so it cannot be added, changed
--     or removed without the key. Only the scopes below accept one; a user assertion never carries one.
--   * orgmember (new)  organization functions that already hold an `OrgAccess` capability: the actor must be an ACTIVE MEMBER of the organization a row belongs to,
--                      and for patient data the patient must be one the actor may see (accepted connection, a clinician of that organization, staff-visible or the
--                      actor's own patient). A bug that passed the wrong organization id can no longer read or change another organization's staff, tasks, notes,
--                      invitations or audit entries, nor a patient outside the actor's organizations.
--   * mfa              second-factor rows: the actor must be the account holder. An administrator's reset is the function app_reset_mfa, which requires an active
--                      administrator as the verified actor and never lets them read a secret.
--   * review           administrators' decisions: the actor must be an active administrator (a clinician's own credential summary stays readable: it is shown to patients).
--   * The public sign-in scope (`auth`) loses its direct access to the second-factor tables: all of that now goes through `mfa` with a verified actor.
--   * `staff` stays for the functions that act for a person with only their own id or a single-use token (docs/LAUNCH_GATES.md lists them).
--
-- What this does NOT do: the permission MATRIX (which role may invite, change roles, write notes) is still code; the database checks membership and visibility,
-- not the role. The actor is set ONCE by the authentication step (a session, or a signed challenge in the sign-in steps) and carried through scope changes; a
-- function cannot name its own actor. Nothing reads or changes a row of application data.

-- 1. The verifier understands the actor and the new scope.
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
  who text;
BEGIN
  SELECT enforce, max_ttl_seconds, allow_server_scope INTO cfg FROM app_identity_config LIMIT 1;
  IF tok IS NULL OR tok = '' THEN
    IF NOT COALESCE(cfg.enforce, true) THEN
      IF current_setting('app.system', true) = 'on' AND COALESCE(cfg.allow_server_scope, true) THEN RETURN 'system'; END IF;
      IF COALESCE(current_setting('app.user_id', true), '') <> '' THEN RETURN 'user:' || current_setting('app.user_id', true); END IF;
    END IF;
    RETURN '';
  END IF;

  IF tok !~ '^v1\.[a-z0-9_-]{1,32}\.(user|system)\.[A-Za-z0-9_-]{1,64}(~[A-Za-z0-9_-]{1,64})?\.[0-9]{1,12}\.[A-Za-z0-9_-]{43}$' THEN RETURN ''; END IF;
  parts := string_to_array(tok, '.');
  who := parts[4];
  -- A person is never asserted with an actor.
  IF parts[3] = 'user' AND position('~' IN who) > 0 THEN RETURN ''; END IF;
  IF parts[3] = 'system' THEN
    -- A system assertion names one of the known scopes; anything else, however validly signed, is nobody. Only three scopes carry an actor.
    IF split_part(who, '~', 1) NOT IN ('server', 'auth', 'invite', 'session', 'scheduler', 'webhook', 'ratelimit', 'staff', 'review', 'mfa', 'notify', 'contact', 'audit', 'blocks', 'ops', 'mail', 'pairing', 'verify', 'orgmember') THEN RETURN ''; END IF;
    IF position('~' IN who) > 0 AND split_part(who, '~', 1) NOT IN ('orgmember', 'review', 'mfa') THEN RETURN ''; END IF;
    IF split_part(who, '~', 1) = 'server' AND NOT COALESCE(cfg.allow_server_scope, true) THEN RETURN ''; END IF;
  END IF;
  exp_s := parts[5]::bigint;
  IF exp_s < now_s OR exp_s > now_s + COALESCE(cfg.max_ttl_seconds, 300) THEN RETURN ''; END IF;

  SELECT ipad, opad INTO k FROM app_identity_keys WHERE kid = parts[2] AND retired_at IS NULL;
  IF NOT FOUND THEN RETURN ''; END IF;
  msg := convert_to('avela-identity-v1' || chr(10) || parts[2] || chr(10) || parts[3] || chr(10) || who || chr(10) || parts[5], 'UTF8');
  expected := translate(rtrim(replace(encode(sha256(k.opad || sha256(k.ipad || msg)), 'base64'), chr(10), ''), '='), '+/', '-_');
  IF sha256(convert_to(expected, 'UTF8')) <> sha256(convert_to(parts[6], 'UTF8')) THEN RETURN ''; END IF;
  IF parts[3] = 'user' THEN RETURN 'user:' || who; END IF;
  RETURN CASE WHEN who = 'server' THEN 'system' ELSE 'system:' || who END;
END $$;

-- The scope of a system identity without its actor ('server' for the unrestricted one), or NULL for a person or nobody.
CREATE OR REPLACE FUNCTION app_verified_scope() RETURNS text
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT CASE WHEN i = 'system' THEN 'server' WHEN i LIKE 'system:%' THEN split_part(substr(i, 8), '~', 1) END FROM (SELECT avela_identity_check() AS i) s
$$;
-- The verified actor of a system identity, or NULL (nobody, a person, or a scope asserted without one).
CREATE OR REPLACE FUNCTION app_actor() RETURNS text
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT nullif(CASE WHEN i LIKE 'system:%~%' THEN split_part(substr(i, 8), '~', 2) END, '') FROM (SELECT avela_identity_check() AS i) s
$$;

-- 2. What the actor is, answered from the tables with the definer's rights (a policy on org_memberships must not need to read org_memberships).
CREATE OR REPLACE FUNCTION app_actor_is_admin() RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT COALESCE(EXISTS (SELECT 1 FROM users u WHERE u.id = (SELECT app_actor()) AND u.role = 'admin' AND u.deactivated_at IS NULL), false)
$$;
CREATE OR REPLACE FUNCTION app_actor_in_org(org text) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT COALESCE(EXISTS (SELECT 1 FROM org_memberships m WHERE m.org_id = org AND m.user_id = (SELECT app_actor()) AND m.status = 'active'), false)
$$;
CREATE OR REPLACE FUNCTION app_actor_shares_org(person text) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT COALESCE(EXISTS (SELECT 1 FROM org_memberships a JOIN org_memberships b ON b.org_id = a.org_id AND b.status = 'active'
                           WHERE a.user_id = (SELECT app_actor()) AND a.status = 'active' AND b.user_id = person), false)
$$;
-- May the actor see this connection (and so this patient, this visit, this clinician's profile)? The rule server/services/orgs.ts scopeFor() states in code:
-- the connection is accepted and belongs to a clinician of an organization the actor is an active member of (a member with the clinician role, or an owner or
-- administrator who is themself an approved doctor); a clinician actor sees only their own connections, every other role sees those the patient made visible to staff.
CREATE OR REPLACE FUNCTION app_actor_sees_visit(patient text, profile text) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT COALESCE(EXISTS (
    SELECT 1
      FROM pairing_requests pr
      JOIN doctor_profiles dp ON dp.id = pr.doctor_profile_id
      JOIN org_memberships cm ON cm.user_id = dp.user_id AND cm.status = 'active'
      JOIN users cu ON cu.id = cm.user_id
      JOIN org_memberships am ON am.org_id = cm.org_id AND am.user_id = (SELECT app_actor()) AND am.status = 'active'
     WHERE pr.status = 'accepted'
       AND (cm.role = 'clinician' OR (cm.role IN ('owner', 'admin') AND cu.role = 'doctor'))
       AND ((am.role <> 'clinician' AND pr.org_staff_visible) OR (am.role = 'clinician' AND cm.user_id = am.user_id))
       AND (patient IS NULL OR pr.patient_user_id = patient)
       AND (profile IS NULL OR pr.doctor_profile_id = profile)), false)
$$;
-- A clinician profile of the actor's organizations (the actor's own, if the actor is a clinician).
CREATE OR REPLACE FUNCTION app_actor_sees_profile(profile text) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT COALESCE(EXISTS (
    SELECT 1
      FROM doctor_profiles dp
      JOIN org_memberships cm ON cm.user_id = dp.user_id AND cm.status = 'active'
      JOIN users cu ON cu.id = cm.user_id
      JOIN org_memberships am ON am.org_id = cm.org_id AND am.user_id = (SELECT app_actor()) AND am.status = 'active'
     WHERE dp.id = profile
       AND (cm.role = 'clinician' OR (cm.role IN ('owner', 'admin') AND cu.role = 'doctor'))
       AND (am.role <> 'clinician' OR cm.user_id = am.user_id)), false)
$$;

-- 3. The two lookups the organization functions use.
CREATE OR REPLACE FUNCTION app_account_id_by_email(by_email text) RETURNS text
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  found text;
BEGIN
  -- Does an account with this address exist, and which? (invitations to organizations). No hash, no other column. An organization member may ask; so may the
  -- invitation flow. The actor of an `orgmember` request must belong to some organization.
  IF NOT (app_system_in('staff', 'invite') OR (app_verified_scope() = 'orgmember' AND EXISTS (SELECT 1 FROM org_memberships m WHERE m.user_id = (SELECT app_actor()) AND m.status = 'active'))) THEN RETURN NULL; END IF;
  SELECT u.id INTO found FROM users u WHERE lower(u.email) = lower(btrim(by_email));
  RETURN found;
END $$;

CREATE OR REPLACE FUNCTION app_user_contacts(ids text[])
  RETURNS TABLE (id varchar, name text, email varchar, language varchar, email_verified_at timestamp)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NOT (app_system_in('scheduler', 'invite', 'contact', 'staff') OR app_verified_scope() = 'orgmember') THEN RETURN; END IF;
  -- An organization member is told the addresses of people in their own organizations only.
  RETURN QUERY SELECT u.id, u.name, u.email, u.language, u.email_verified_at FROM users u
                WHERE u.id = ANY (ids) AND (app_verified_scope() <> 'orgmember' OR u.id = (SELECT app_actor()) OR (SELECT app_actor_shares_org(u.id)));
END $$;

-- Is the CALLER the restricted application role? Inside a SECURITY DEFINER function current_user is the function's owner, so the caller is read from
-- the session: the login role, or the role set with SET ROLE (how the test suite connects).
CREATE OR REPLACE FUNCTION app_caller_restricted() RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT NOT EXISTS (SELECT 1 FROM pg_roles r WHERE r.rolname = c.who AND (r.rolsuper OR r.rolbypassrls))
     AND c.who IS DISTINCT FROM (SELECT t.tableowner FROM pg_tables t WHERE t.schemaname = 'public' AND t.tablename = 'users')
    FROM (SELECT COALESCE(NULLIF(current_setting('role', true), 'none'), session_user) AS who) c
$$;

-- An administrator removing someone's second factor (and ending that person's sessions): the one thing the actor is not the account holder for.
CREATE OR REPLACE FUNCTION app_reset_mfa(target text) RETURNS void
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  -- The restricted role must present a verified administrator as the actor (or, while identity enforcement is off during a roll-out, the plain server
  -- identity, exactly as every other policy treats it). An owner or maintenance connection, which row-level security does not bind, is unchanged.
  IF app_caller_restricted() AND NOT app_is_system() AND NOT (app_verified_scope() IS NOT DISTINCT FROM 'mfa' AND app_actor_is_admin()) THEN
    RAISE EXCEPTION 'only an administrator may reset a second factor' USING ERRCODE = '42501';
  END IF;
  DELETE FROM mfa_recovery_codes WHERE user_id = target;
  DELETE FROM user_mfa WHERE user_id = target;
  UPDATE user_devices SET revoked_at = now() WHERE user_id = target AND revoked_at IS NULL;
END $$;

-- 4. The policies. A table, a scope, a command and the extra condition. Every one is ANDed with the scope itself, so removing 0030 returns each to the scope alone.
CREATE TEMP TABLE bound (tbl text NOT NULL, scope text NOT NULL, cmd text NOT NULL, cond text NOT NULL) ON COMMIT DROP;
INSERT INTO bound VALUES
  -- members of an organization, acting under their own verified identity
  ('organizations',  'orgmember', 'SELECT', 'app_actor_in_org(id)'),
  ('organizations',  'orgmember', 'UPDATE', 'app_actor_in_org(id)'),
  ('org_memberships','orgmember', 'SELECT', 'app_actor_in_org(org_id) OR user_id = (SELECT app_actor())'),
  ('org_memberships','orgmember', 'UPDATE', 'app_actor_in_org(org_id)'),
  ('org_invitations','orgmember', 'SELECT', 'app_actor_in_org(org_id)'),
  ('org_invitations','orgmember', 'INSERT', 'app_actor_in_org(org_id)'),
  ('org_invitations','orgmember', 'UPDATE', 'app_actor_in_org(org_id)'),
  ('org_notes',      'orgmember', 'SELECT', 'app_actor_in_org(org_id) AND app_actor_sees_visit(patient_user_id, NULL)'),
  ('org_notes',      'orgmember', 'INSERT', 'app_actor_in_org(org_id) AND app_actor_sees_visit(patient_user_id, NULL)'),
  ('org_tasks',      'orgmember', 'SELECT', 'app_actor_in_org(org_id)'),
  ('org_tasks',      'orgmember', 'INSERT', 'app_actor_in_org(org_id) AND app_actor_sees_visit(patient_user_id, NULL)'),
  ('org_tasks',      'orgmember', 'UPDATE', 'app_actor_in_org(org_id)'),
  ('audit_logs',     'orgmember', 'SELECT', 'app_actor_in_org(metadata->>''orgId'')'),
  ('audit_logs',     'orgmember', 'INSERT', 'actor_user_id = (SELECT app_actor())'),
  ('appointments',   'orgmember', 'SELECT', 'app_actor_sees_visit(patient_user_id, doctor_profile_id)'),
  ('pairing_requests','orgmember','SELECT', 'app_actor_sees_visit(patient_user_id, doctor_profile_id)'),
  ('doctor_profiles','orgmember', 'SELECT', 'app_actor_sees_profile(id)'),
  ('users',          'orgmember', 'SELECT', 'id = (SELECT app_actor()) OR app_actor_sees_visit(id, NULL) OR app_actor_shares_org(id)'),
  -- second factor: the account holder only (an administrator's reset goes through app_reset_mfa, which checks the actor is an administrator and never lets them read a secret)
  ('user_mfa',           'mfa', 'SELECT', 'user_id = (SELECT app_actor())'),
  ('user_mfa',           'mfa', 'INSERT', 'user_id = (SELECT app_actor())'),
  ('user_mfa',           'mfa', 'UPDATE', 'user_id = (SELECT app_actor())'),
  ('user_mfa',           'mfa', 'DELETE', 'user_id = (SELECT app_actor())'),
  ('mfa_recovery_codes', 'mfa', 'SELECT', 'user_id = (SELECT app_actor())'),
  ('mfa_recovery_codes', 'mfa', 'INSERT', 'user_id = (SELECT app_actor())'),
  ('mfa_recovery_codes', 'mfa', 'UPDATE', 'user_id = (SELECT app_actor())'),
  ('mfa_recovery_codes', 'mfa', 'DELETE', 'user_id = (SELECT app_actor())'),
  ('user_devices',       'mfa', 'SELECT', 'user_id = (SELECT app_actor())'),
  ('user_devices',       'mfa', 'UPDATE', 'user_id = (SELECT app_actor())'),
  -- administrators' decisions
  ('audit_logs',          'review', 'SELECT', 'app_actor_is_admin()'),
  ('audit_logs',          'review', 'INSERT', 'app_actor_is_admin()'),
  ('credential_events',   'review', 'SELECT', 'app_actor_is_admin()'),
  ('credential_events',   'review', 'INSERT', 'app_actor_is_admin()'),
  ('doctor_applications', 'review', 'SELECT', 'app_actor_is_admin()'),
  ('doctor_applications', 'review', 'UPDATE', 'app_actor_is_admin()'),
  ('doctor_credentials',  'review', 'INSERT', 'app_actor_is_admin()'),
  ('doctor_credentials',  'review', 'UPDATE', 'app_actor_is_admin()'),
  ('doctor_profiles',     'review', 'SELECT', 'app_actor_is_admin()'),
  ('doctor_profiles',     'review', 'INSERT', 'app_actor_is_admin()'),
  ('doctor_profiles',     'review', 'UPDATE', 'app_actor_is_admin()'),
  ('message_reports',     'review', 'SELECT', 'app_actor_is_admin()'),
  ('message_reports',     'review', 'UPDATE', 'app_actor_is_admin()'),
  ('organizations',       'review', 'SELECT', 'app_actor_is_admin()'),
  ('organizations',       'review', 'UPDATE', 'app_actor_is_admin()'),
  ('user_devices',        'review', 'SELECT', 'app_actor_is_admin()'),
  ('user_devices',        'review', 'UPDATE', 'app_actor_is_admin()'),
  ('users',               'review', 'SELECT', 'app_actor_is_admin()'),
  ('users',               'review', 'UPDATE', 'app_actor_is_admin()');

DO $$
DECLARE
  b record;
  pname text;
  clause text;
BEGIN
  -- The public sign-in scope no longer reaches the second-factor tables directly (0028 gave it all four commands).
  FOR b IN SELECT t.tbl, c.cmd FROM (VALUES ('user_mfa'), ('mfa_recovery_codes')) t(tbl), (VALUES ('select'), ('insert'), ('update'), ('delete')) c(cmd) LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', 'avela_scope_' || b.tbl || '_' || b.cmd, b.tbl);
  END LOOP;

  FOR b IN SELECT * FROM bound LOOP
    pname := 'avela_scope_' || b.tbl || '_' || b.scope || '_' || lower(b.cmd);
    clause := format('app_verified_scope() = %L AND (%s)', b.scope, b.cond);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', pname, b.tbl);
    IF b.cmd IN ('SELECT', 'DELETE') THEN
      EXECUTE format('CREATE POLICY %I ON %I AS PERMISSIVE FOR %s USING (%s)', pname, b.tbl, b.cmd, clause);
    ELSIF b.cmd = 'INSERT' THEN
      EXECUTE format('CREATE POLICY %I ON %I AS PERMISSIVE FOR INSERT WITH CHECK (%s)', pname, b.tbl, clause);
    ELSE
      EXECUTE format('CREATE POLICY %I ON %I AS PERMISSIVE FOR UPDATE USING (%s) WITH CHECK (%s)', pname, b.tbl, clause, clause);
    END IF;
  END LOOP;
END $$;

SELECT avela_apply_grants();
