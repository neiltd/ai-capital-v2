-- ═══════════════════════════════════════════════════════════════════════════
-- IDENTITY SECURITY — RLS on the identity schema, and the authorization
-- functions every tenant policy calls.
--
-- THE CENTRAL RULE THIS FILE ENCODES:
--
--     A caller-set GUC SELECTS context. It never AUTHORIZES it.
--
-- `app.workspace_id` names a candidate workspace. Whether the caller may act
-- there is decided from `session_user` — the role that authenticated at connect
-- time — against the grant table. A caller who issues
-- `SET LOCAL app.workspace_id = '<someone else>'` and then INSERTs gets an
-- exception, not a row, because the two are checked against each other.
--
-- WHY `session_user` AND NOT `current_user`. Inside a SECURITY DEFINER function
-- PostgreSQL sets `current_user` to the FUNCTION OWNER. A `db_role =
-- current_user` check would therefore compare the authority role against
-- itself and identify nobody. `session_user` is unaffected by definer entry AND
-- by SET ROLE; the only statement that rewrites it, SET SESSION AUTHORIZATION,
-- requires superuser, and no runtime role is one. Runtime roles additionally
-- hold zero role memberships, so `SET ROLE` to another service login is not
-- available to them at all.
--
-- WHY A DEDICATED OWNER FOR THESE FUNCTIONS. The identity tables carry FORCE
-- ROW LEVEL SECURITY, which removes the table owner's implicit exemption. A
-- definer function owned by `ai_capital_owner` would therefore hit default-deny
-- and return zero rows — silently, which is the worst possible failure here.
-- The functions are instead owned by `ai_capital_identity_authority`, which has
-- narrow column-level SELECT plus explicit policies naming it, and which is
-- NOLOGIN, NOBYPASSRLS, owns no table, and loses CREATE at lockdown.
-- ═══════════════════════════════════════════════════════════════════════════

-- ─────────────────────────────────────────────────────────────────────────────
-- 0. ROLE STATE. Say it, do not assume it.
--
-- The runner enters this file with `SET LOCAL ROLE ai_capital_owner`, so the
-- statement below is redundant TODAY. It is here because the rest of the file
-- switches roles, and `RESET ROLE` does NOT mean "go back to the previous
-- role" — SET ROLE is not a stack. RESET ROLE returns to `session_user`, which
-- during a migration is `ai_capital_migrator`: a role that owns nothing and
-- (deliberately) does not inherit ownership, since its memberships are granted
-- WITH INHERIT FALSE. Every owner-only statement here therefore names its role
-- explicitly, and 012_identity_security's role state is asserted statically by
-- tests/unit/migration-role-state.test.ts.
-- ─────────────────────────────────────────────────────────────────────────────
SET LOCAL ROLE ai_capital_owner;

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. RLS on every identity table.
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE identity.principals               ENABLE ROW LEVEL SECURITY;
ALTER TABLE identity.principals               FORCE  ROW LEVEL SECURITY;
ALTER TABLE identity.users                    ENABLE ROW LEVEL SECURITY;
ALTER TABLE identity.users                    FORCE  ROW LEVEL SECURITY;
ALTER TABLE identity.service_principals       ENABLE ROW LEVEL SECURITY;
ALTER TABLE identity.service_principals       FORCE  ROW LEVEL SECURITY;
ALTER TABLE identity.service_principal_roles  ENABLE ROW LEVEL SECURITY;
ALTER TABLE identity.service_principal_roles  FORCE  ROW LEVEL SECURITY;
ALTER TABLE identity.external_identities      ENABLE ROW LEVEL SECURITY;
ALTER TABLE identity.external_identities      FORCE  ROW LEVEL SECURITY;
ALTER TABLE identity.workspaces               ENABLE ROW LEVEL SECURITY;
ALTER TABLE identity.workspaces               FORCE  ROW LEVEL SECURITY;
ALTER TABLE identity.workspace_memberships    ENABLE ROW LEVEL SECURITY;
ALTER TABLE identity.workspace_memberships    FORCE  ROW LEVEL SECURITY;
ALTER TABLE identity.workspace_service_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE identity.workspace_service_grants FORCE  ROW LEVEL SECURITY;

-- The authority's reads. Without these the definer functions default-deny.
CREATE POLICY authority_read ON identity.principals
  FOR SELECT TO ai_capital_identity_authority USING (disabled_at IS NULL);
CREATE POLICY authority_read ON identity.service_principals
  FOR SELECT TO ai_capital_identity_authority USING (true);
CREATE POLICY authority_read ON identity.service_principal_roles
  FOR SELECT TO ai_capital_identity_authority USING (true);
CREATE POLICY authority_read ON identity.workspaces
  FOR SELECT TO ai_capital_identity_authority USING (archived_at IS NULL);
CREATE POLICY authority_read ON identity.workspace_memberships
  FOR SELECT TO ai_capital_identity_authority USING (revoked_at IS NULL);

-- DELIBERATELY `USING (true)`, not an active-only predicate.
--
-- Grant administration must be able to CANCEL a grant that has not started yet,
-- and to see one already terminated. An `effective_range @> now()` policy here
-- would hide exactly those rows and make cancellation impossible — a defect in
-- an earlier draft. The capability functions below apply the time predicate in
-- their own WHERE clause, so this policy does not widen what a service can
-- prove about itself.
CREATE POLICY authority_read ON identity.workspace_service_grants
  FOR SELECT TO ai_capital_identity_authority USING (true);
CREATE POLICY authority_terminate ON identity.workspace_service_grants
  FOR UPDATE TO ai_capital_identity_authority USING (true) WITH CHECK (true);

-- `users` and `external_identities` get NO policy for any role in this
-- foundation: nothing reads them until the OIDC gate (G1).

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Column-level privileges for the authority. Column-level, not table-level,
--    so a future function cannot quietly read more than these.
-- ─────────────────────────────────────────────────────────────────────────────
GRANT SELECT (id, kind, disabled_at)
  ON identity.principals               TO ai_capital_identity_authority;
GRANT SELECT (principal_id, service_key)
  ON identity.service_principals       TO ai_capital_identity_authority;
GRANT SELECT (principal_id, db_role)
  ON identity.service_principal_roles  TO ai_capital_identity_authority;
GRANT SELECT (id, slug, archived_at)
  ON identity.workspaces               TO ai_capital_identity_authority;
GRANT SELECT (workspace_id, principal_id, role, revoked_at)
  ON identity.workspace_memberships    TO ai_capital_identity_authority;
GRANT SELECT (id, workspace_id, principal_id, capability, valid_from, valid_until,
              cancelled_at, revoked_at, effective_range,
              termination_reason, terminated_by)
  ON identity.workspace_service_grants TO ai_capital_identity_authority;
-- Only the four termination columns are writable, and only by the authority.
GRANT UPDATE (cancelled_at, revoked_at, termination_reason, terminated_by)
  ON identity.workspace_service_grants TO ai_capital_identity_authority;

-- ═══════════════════════════════════════════════════════════════════════════
-- 3. The functions. Created AS the authority role so that they are owned by it.
-- ═══════════════════════════════════════════════════════════════════════════
SET LOCAL ROLE ai_capital_identity_authority;

-- Which service principal is this LOGIN? NULL when unbound or disabled.
CREATE FUNCTION identity.current_service_principal() RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, identity
AS $$
  SELECT r.principal_id
    FROM identity.service_principal_roles r
    JOIN identity.principals p ON p.id = r.principal_id AND p.disabled_at IS NULL
   WHERE r.db_role = session_user;
$$;

-- NON-THROWING predicate. Returning false rather than raising is what makes an
-- "either of these capabilities" test expressible: a throwing check aborts the
-- statement at the first miss, so `authorize(a) IS NULL AND authorize(b) IS NULL`
-- can never evaluate its second operand. That was a real defect in an earlier
-- draft; this function is the fix.
CREATE FUNCTION identity.service_has_workspace_capability(
  p_workspace uuid, p_capability identity.service_capability
) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, identity
AS $$
  SELECT EXISTS (
    SELECT 1
      FROM identity.workspace_service_grants g
      JOIN identity.workspaces w ON w.id = g.workspace_id AND w.archived_at IS NULL
     WHERE g.workspace_id = p_workspace
       AND g.principal_id = identity.current_service_principal()
       AND g.capability   = p_capability
       AND g.effective_range @> now());
$$;

-- THROWING, any-of. The predicate used by every tenant RLS policy.
--
-- It takes the workspace as an ARGUMENT rather than reading the GUC itself, so
-- there is no ordering dependency: the helper can authorize BEFORE it publishes
-- context. Distinguishing an unbound login (42501, one message) from a missing
-- capability (42501, another) is deliberate — both are refusals, and neither
-- reveals whether the workspace exists.
CREATE FUNCTION identity.authorize_service_workspace_any(
  p_workspace uuid, p_capabilities identity.service_capability[]
) RETURNS uuid
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, identity
AS $$
DECLARE v_principal uuid; v_cap identity.service_capability;
BEGIN
  IF p_workspace IS NULL THEN
    RAISE EXCEPTION 'no workspace selected' USING ERRCODE = '42501';
  END IF;
  v_principal := identity.current_service_principal();
  IF v_principal IS NULL THEN
    RAISE EXCEPTION 'login % is not bound to an enabled service principal', session_user
      USING ERRCODE = '42501';
  END IF;
  IF p_capabilities IS NULL OR cardinality(p_capabilities) = 0 THEN
    RAISE EXCEPTION 'no capability requested' USING ERRCODE = '42501';
  END IF;
  FOREACH v_cap IN ARRAY p_capabilities LOOP
    IF identity.service_has_workspace_capability(p_workspace, v_cap) THEN
      RETURN v_principal;
    END IF;
  END LOOP;
  RAISE EXCEPTION 'service principal holds none of % in workspace %',
    p_capabilities, p_workspace USING ERRCODE = '42501';
END $$;

CREATE FUNCTION identity.authorize_service_workspace(
  p_workspace uuid, p_capability identity.service_capability
) RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, identity
AS $$
  SELECT identity.authorize_service_workspace_any(p_workspace, ARRAY[p_capability]);
$$;

-- Slug convenience for operators. Authorizes BEFORE it resolves, so an
-- unentitled slug and a nonexistent slug both return no row — indistinguishable,
-- and therefore not an enumeration oracle.
CREATE FUNCTION identity.resolve_workspace_for_capability(
  p_slug text, p_capability identity.service_capability
) RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, identity
AS $$
  SELECT w.id
    FROM identity.workspaces w
    JOIN identity.workspace_service_grants g ON g.workspace_id = w.id
   WHERE w.slug = p_slug
     AND w.archived_at IS NULL
     AND g.principal_id = identity.current_service_principal()
     AND g.capability   = p_capability
     AND g.effective_range @> now();
$$;

-- Audit attribution. The allowed capability SET is a variadic trigger argument,
-- fixed per table in 017 — `transactions` legitimately accepts archive-import
-- OR manual-entry, and a single fixed capability could not express that.
--
-- Two things are checked, not one: the row's actor must BE the calling
-- principal (so nobody can attribute an action to someone else), and that
-- principal must hold one of the table's allowed capabilities in that workspace
-- (so archive-import cannot author a reconciliation event).
CREATE FUNCTION identity.assert_actor_authorized() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, identity
AS $$
DECLARE v_kind text; v_caller uuid; v_ok boolean := false; v_cap text;
BEGIN
  SELECT kind INTO v_kind
    FROM identity.principals
   WHERE id = NEW.actor_principal_id AND disabled_at IS NULL;
  IF v_kind IS NULL THEN
    RAISE EXCEPTION 'actor % is not an enabled principal', NEW.actor_principal_id
      USING ERRCODE = '42501';
  END IF;

  IF v_kind = 'human' THEN
    -- Unreachable in this foundation: no human context mechanism exists until
    -- G1. Written now so the trigger does not need editing when it arrives.
    PERFORM 1 FROM identity.workspace_memberships
      WHERE workspace_id = NEW.workspace_id
        AND principal_id = NEW.actor_principal_id
        AND revoked_at IS NULL;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'actor is not a member of workspace %', NEW.workspace_id
        USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;

  v_caller := identity.current_service_principal();
  IF v_caller IS NULL OR v_caller <> NEW.actor_principal_id THEN
    RAISE EXCEPTION 'actor % is not the calling service principal',
      NEW.actor_principal_id USING ERRCODE = '42501';
  END IF;

  FOREACH v_cap IN ARRAY TG_ARGV LOOP
    IF identity.service_has_workspace_capability(
         NEW.workspace_id, v_cap::identity.service_capability) THEN
      v_ok := true;
      EXIT;
    END IF;
  END LOOP;
  IF NOT v_ok THEN
    RAISE EXCEPTION 'calling service holds none of % in workspace %',
      TG_ARGV, NEW.workspace_id USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;

-- Grant administration. Reads TARGETED COLUMNS, never SELECT *, because the
-- authority's grant is column-level and a whole-row read would fail.
CREATE FUNCTION identity.terminate_service_grant(
  p_grant uuid, p_kind text, p_reason text
) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, identity
AS $$
DECLARE
  v_valid_from timestamptz;
  v_cancelled  timestamptz;
  v_revoked    timestamptz;
  v_actor      uuid;
BEGIN
  v_actor := identity.current_service_principal();
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'login % is not bound to an enabled principal', session_user
      USING ERRCODE = '42501';
  END IF;
  IF p_reason IS NULL OR btrim(p_reason) = '' THEN
    RAISE EXCEPTION 'a termination reason is required' USING ERRCODE = '22023';
  END IF;

  SELECT g.valid_from, g.cancelled_at, g.revoked_at
    INTO v_valid_from, v_cancelled, v_revoked
    FROM identity.workspace_service_grants g
   WHERE g.id = p_grant
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such grant %', p_grant USING ERRCODE = '42704';
  END IF;
  IF v_cancelled IS NOT NULL OR v_revoked IS NOT NULL THEN
    RAISE EXCEPTION 'grant % is already terminated', p_grant USING ERRCODE = '23514';
  END IF;

  IF p_kind = 'cancel' THEN
    IF now() >= v_valid_from THEN
      RAISE EXCEPTION 'grant % is already active; use revoke', p_grant
        USING ERRCODE = '23514';
    END IF;
    UPDATE identity.workspace_service_grants
       SET cancelled_at = now(),
           termination_reason = btrim(p_reason),
           terminated_by = v_actor
     WHERE id = p_grant;

  ELSIF p_kind = 'revoke' THEN
    IF now() < v_valid_from THEN
      RAISE EXCEPTION 'grant % is not yet active; use cancel', p_grant
        USING ERRCODE = '23514';
    END IF;
    UPDATE identity.workspace_service_grants
       SET revoked_at = now(),
           termination_reason = btrim(p_reason),
           terminated_by = v_actor
     WHERE id = p_grant;

  ELSE
    RAISE EXCEPTION 'kind must be cancel or revoke, got %', p_kind
      USING ERRCODE = '22023';
  END IF;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. EXECUTE privileges. PostgreSQL grants EXECUTE to PUBLIC by default, so the
--    revoke is not optional — without it every function here would be callable
--    by every role in the cluster.
--
--    A function referenced by an RLS policy is executed as the QUERYING role,
--    so importer and agent need EXECUTE on the ones their policies call.
--
--    STILL ai_capital_identity_authority, ON PURPOSE. Every function above is
--    OWNED by the authority, and only a function's owner may REVOKE or GRANT on
--    it. An earlier draft issued `RESET ROLE;` here, believing it returned to
--    ai_capital_owner; it returns to session_user ai_capital_migrator, whose
--    membership in the authority is WITH INHERIT FALSE, so every statement in
--    this section would have failed with 42501 "must be owner of function" and
--    the whole migration would have rolled back.
-- ─────────────────────────────────────────────────────────────────────────────
REVOKE ALL ON FUNCTION identity.current_service_principal()                    FROM PUBLIC;
REVOKE ALL ON FUNCTION identity.service_has_workspace_capability(uuid, identity.service_capability) FROM PUBLIC;
REVOKE ALL ON FUNCTION identity.authorize_service_workspace_any(uuid, identity.service_capability[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION identity.authorize_service_workspace(uuid, identity.service_capability)     FROM PUBLIC;
REVOKE ALL ON FUNCTION identity.resolve_workspace_for_capability(text, identity.service_capability) FROM PUBLIC;
REVOKE ALL ON FUNCTION identity.assert_actor_authorized()                     FROM PUBLIC;
REVOKE ALL ON FUNCTION identity.terminate_service_grant(uuid, text, text)     FROM PUBLIC;

GRANT EXECUTE ON FUNCTION identity.current_service_principal()
  TO ai_capital_importer, ai_capital_agent, ai_capital_operator;
GRANT EXECUTE ON FUNCTION identity.service_has_workspace_capability(uuid, identity.service_capability)
  TO ai_capital_importer, ai_capital_agent;
GRANT EXECUTE ON FUNCTION identity.authorize_service_workspace_any(uuid, identity.service_capability[])
  TO ai_capital_importer, ai_capital_agent;
GRANT EXECUTE ON FUNCTION identity.authorize_service_workspace(uuid, identity.service_capability)
  TO ai_capital_importer, ai_capital_agent;
GRANT EXECUTE ON FUNCTION identity.resolve_workspace_for_capability(text, identity.service_capability)
  TO ai_capital_importer;
-- terminate_service_grant: the OPERATOR and nobody else.
GRANT EXECUTE ON FUNCTION identity.terminate_service_grant(uuid, text, text)
  TO ai_capital_operator;
-- assert_actor_authorized is a TRIGGER function. It is never CALLED directly —
-- firing a trigger checks no EXECUTE privilege at all — but CREATE TRIGGER
-- does, against the role issuing it, at creation time.
--
-- An earlier version granted it to nobody, on the reasoning that a trigger
-- function needs no callers. That is right about the runtime and wrong about
-- the DDL: 017 attaches seventeen `actor_is_authorized` triggers as
-- ai_capital_owner, and every one of them failed with
--
--     permission denied for function identity.assert_actor_authorized
--
-- so the whole migration rolled back. The grant below is issued HERE, while
-- current_user is still ai_capital_identity_authority — only a function's owner
-- may grant on it — and names ai_capital_owner alone: the role that creates the
-- triggers, and no LOGIN role, and not PUBLIC. Ownership and SECURITY DEFINER
-- are untouched, so the function still executes as the authority when it fires.
GRANT EXECUTE ON FUNCTION identity.assert_actor_authorized()
  TO ai_capital_owner;

-- Back to the owner EXPLICITLY — not via RESET ROLE. ALTER DEFAULT PRIVILEGES
-- FOR ROLE ai_capital_owner must be issued by that role (or a member that has
-- assumed it), and the authority is not one.
SET LOCAL ROLE ai_capital_owner;

ALTER DEFAULT PRIVILEGES FOR ROLE ai_capital_owner IN SCHEMA identity
  REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
