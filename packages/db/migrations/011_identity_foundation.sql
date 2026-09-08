-- ═══════════════════════════════════════════════════════════════════════════
-- IDENTITY FOUNDATION — principals, workspaces, memberships, service grants.
--
-- WHY THIS EXISTS AND WHY IT IS FIRST. Every financial row in this database is
-- about to acquire a `workspace_id` that REFERENCES identity.workspaces. A
-- foreign key cannot point at a table that does not exist, so identity must be
-- created before the ledger. An earlier draft numbered the ledger first and the
-- identity schema afterwards; that ordering cannot be applied to a fresh
-- database at all, which is why the whole post-010 range was renumbered.
--
-- OWNERSHIP. Every object here is created under `SET LOCAL ROLE
-- ai_capital_owner`, supplied by the migration runner via MIGRATION_OWNER_ROLE.
-- `ai_capital_owner` is NOLOGIN, so no credential can act as the owner; that
-- matters because FORCE ROW LEVEL SECURITY binds the table owner, and an owner
-- with a password would be a way around every policy in this schema.
--
-- THE MODEL. A `principal` is anything that can act: a human, or a service. The
-- two are DISJOINT specialisations, pinned by a generated `kind` column and a
-- composite foreign key, so "a user row pointing at a service principal" is not
-- merely discouraged — it is unrepresentable. That is what lets one immutable
-- `actor_principal_id` column attribute every audit row without inventing fake
-- user accounts for the importer or the scheduler.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE SCHEMA identity;

COMMENT ON SCHEMA identity IS
  'Principals, workspaces and capability grants. No financial data lives here.';

-- ─────────────────────────────────────────────────────────────────────────────
-- Principals: the supertype.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE identity.principals (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kind          TEXT NOT NULL CHECK (kind IN ('human','service')),
  display_name  TEXT NOT NULL CHECK (length(btrim(display_name)) > 0),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  disabled_at   TIMESTAMPTZ,
  -- The anchor every kind-pinned foreign key below targets. Redundant with the
  -- primary key on its own, and load-bearing in combination with `kind`.
  UNIQUE (id, kind)
);

CREATE TABLE identity.users (
  principal_id  UUID PRIMARY KEY REFERENCES identity.principals(id),
  kind          TEXT NOT NULL GENERATED ALWAYS AS ('human') STORED,
  -- CONTACT ONLY, and deliberately nullable with no unique constraint.
  -- Identity is (issuer, subject); an email address is a mutable attribute of a
  -- person, not a name for them, and using it as a key is how account takeover
  -- by address reassignment happens.
  email         TEXT,
  FOREIGN KEY (principal_id, kind) REFERENCES identity.principals(id, kind)
);

CREATE TABLE identity.service_principals (
  principal_id  UUID PRIMARY KEY REFERENCES identity.principals(id),
  kind          TEXT NOT NULL GENERATED ALWAYS AS ('service') STORED,
  -- namespace:name — e.g. 'importer:archive', 'operator:grant-admin'.
  service_key   TEXT NOT NULL UNIQUE
                CHECK (service_key ~ '^[a-z][a-z0-9-]*:[a-z][a-z0-9-]*$'),
  FOREIGN KEY (principal_id, kind) REFERENCES identity.principals(id, kind)
);

-- ─────────────────────────────────────────────────────────────────────────────
-- The login binding. This is what makes `session_user` meaningful.
--
-- A SECURITY DEFINER function cannot use `current_user` to identify its caller:
-- on entry PostgreSQL sets `current_user` to the FUNCTION OWNER, so such a
-- check would compare the authority role against itself. `session_user` is the
-- role that authenticated at connect time; it survives both SET ROLE and
-- definer entry, and only SET SESSION AUTHORIZATION rewrites it — which
-- requires superuser, and no runtime role is one.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE identity.service_principal_roles (
  principal_id  UUID PRIMARY KEY REFERENCES identity.service_principals(principal_id),
  db_role       NAME NOT NULL UNIQUE,
  bound_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE identity.service_principal_roles IS
  'One PostgreSQL login <-> one service principal, both directions unique. '
  'Read via session_user, never current_user.';

-- Present so that the OIDC gate (G1) needs no lower-numbered migration later.
-- Nothing in this foundation reads it; no OIDC code exists yet.
CREATE TABLE identity.external_identities (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES identity.users(principal_id),
  issuer      TEXT NOT NULL CHECK (length(btrim(issuer)) > 0),
  subject     TEXT NOT NULL CHECK (length(btrim(subject)) > 0),
  linked_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at  TIMESTAMPTZ,
  UNIQUE (issuer, subject)
);

-- ─────────────────────────────────────────────────────────────────────────────
-- Workspaces and human membership.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE identity.workspaces (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug          TEXT NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
  display_name  TEXT NOT NULL CHECK (length(btrim(display_name)) > 0),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  archived_at   TIMESTAMPTZ
);

CREATE TABLE identity.workspace_memberships (
  workspace_id   UUID NOT NULL REFERENCES identity.workspaces(id),
  principal_id   UUID NOT NULL REFERENCES identity.principals(id),
  principal_kind TEXT NOT NULL GENERATED ALWAYS AS ('human') STORED,
  role           TEXT NOT NULL DEFAULT 'owner' CHECK (role IN ('owner')),
  granted_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  granted_by     UUID NOT NULL REFERENCES identity.principals(id),
  revoked_at     TIMESTAMPTZ,
  PRIMARY KEY (workspace_id, principal_id),
  -- Pins kind='human'. A service principal inserted here yields (id,'human'),
  -- which matches no row in principals(id, kind): foreign-key violation.
  FOREIGN KEY (principal_id, principal_kind)
    REFERENCES identity.principals(id, kind)
);

CREATE INDEX idx_workspace_memberships_principal
  ON identity.workspace_memberships (principal_id) WHERE revoked_at IS NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- Service capabilities, with a temporal history that cannot be rewritten.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TYPE identity.service_capability AS ENUM (
  'archive-import',
  'manual-entry',
  'reconciliation',
  'document-verification',
  'ledger-read'
);

CREATE TABLE identity.workspace_service_grants (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id   UUID NOT NULL REFERENCES identity.workspaces(id),
  principal_id   UUID NOT NULL REFERENCES identity.principals(id),
  principal_kind TEXT NOT NULL GENERATED ALWAYS AS ('service') STORED,
  capability     identity.service_capability NOT NULL,

  valid_from     TIMESTAMPTZ NOT NULL,   -- may be in the future: a scheduled grant
  valid_until    TIMESTAMPTZ,            -- NULL = open-ended

  -- TWO DISTINCT TERMINATION EVENTS, never conflated:
  --   cancelled_at — set only BEFORE valid_from. The grant never took effect,
  --                  so its effective range is EMPTY. Nothing is backdated to
  --                  satisfy a range constraint.
  --   revoked_at   — set only AT/AFTER valid_from. Truncates the interval to
  --                  the one the grant genuinely had.
  cancelled_at   TIMESTAMPTZ,
  revoked_at     TIMESTAMPTZ,
  termination_reason TEXT CHECK (termination_reason IS NULL
                                 OR length(btrim(termination_reason)) > 0),
  terminated_by  UUID REFERENCES identity.principals(id),

  granted_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  granted_by     UUID NOT NULL REFERENCES identity.principals(id),

  -- The interval the grant ACTUALLY had. Revocation shrinks it; cancellation
  -- empties it. Generated and stored, so it is recomputed on every update and
  -- can be indexed by the exclusion constraint below.
  effective_range TSTZRANGE GENERATED ALWAYS AS (
    CASE WHEN cancelled_at IS NOT NULL THEN 'empty'::tstzrange
         ELSE tstzrange(
                valid_from,
                LEAST(COALESCE(valid_until, 'infinity'::timestamptz),
                      COALESCE(revoked_at,  'infinity'::timestamptz)),
                '[)')
    END
  ) STORED,

  FOREIGN KEY (principal_id, principal_kind)
    REFERENCES identity.principals(id, kind),        -- pins kind='service'

  CHECK (valid_until IS NULL OR valid_until > valid_from),
  CHECK (cancelled_at IS NULL OR revoked_at IS NULL),          -- mutually exclusive
  CHECK (cancelled_at IS NULL OR cancelled_at <  valid_from),  -- cancel = pre-activation
  CHECK (revoked_at   IS NULL OR revoked_at  >= valid_from),   -- revoke = post-activation
  CHECK ((cancelled_at IS NOT NULL) = isempty(effective_range)),
  CHECK (((cancelled_at IS NOT NULL) OR (revoked_at IS NOT NULL))
         = (termination_reason IS NOT NULL AND terminated_by IS NOT NULL)),

  -- Over ALL rows, terminated or not, so a re-grant cannot overlap a HISTORICAL
  -- interval. An earlier draft carried `WHERE revoked_at IS NULL`, which let a
  -- new grant silently overlap the period a revoked one really held. Empty
  -- ranges overlap nothing, so cancelled rows never block a replacement.
  EXCLUDE USING gist (
    workspace_id WITH =, principal_id WITH =, capability WITH =,
    effective_range WITH &&
  )
);

CREATE INDEX idx_workspace_service_grants_lookup
  ON identity.workspace_service_grants (principal_id, capability, workspace_id);

COMMENT ON COLUMN identity.workspace_service_grants.effective_range IS
  'Generated. Cancellation empties it; revocation truncates it. Never widened.';

-- ─────────────────────────────────────────────────────────────────────────────
-- Termination is ONE-WAY. Enforced by trigger so it holds even against the
-- authority role that owns the transition function.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE FUNCTION identity.grant_termination_is_one_way() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.cancelled_at IS NOT NULL AND NEW.cancelled_at IS DISTINCT FROM OLD.cancelled_at THEN
    RAISE EXCEPTION 'cancelled_at is immutable once set';
  END IF;
  IF OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at THEN
    RAISE EXCEPTION 'revoked_at is immutable once set';
  END IF;
  IF OLD.termination_reason IS NOT NULL
     AND NEW.termination_reason IS DISTINCT FROM OLD.termination_reason THEN
    RAISE EXCEPTION 'termination_reason is immutable once set';
  END IF;
  IF OLD.terminated_by IS NOT NULL AND NEW.terminated_by IS DISTINCT FROM OLD.terminated_by THEN
    RAISE EXCEPTION 'terminated_by is immutable once set';
  END IF;
  IF NEW.cancelled_at IS NOT NULL AND NEW.revoked_at IS NOT NULL THEN
    RAISE EXCEPTION 'cancellation and revocation are mutually exclusive';
  END IF;
  IF (OLD.workspace_id, OLD.principal_id, OLD.capability, OLD.valid_from, OLD.valid_until)
     IS DISTINCT FROM
     (NEW.workspace_id, NEW.principal_id, NEW.capability, NEW.valid_from, NEW.valid_until) THEN
    RAISE EXCEPTION 'only termination fields may change on a grant';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER grant_termination_one_way
BEFORE UPDATE ON identity.workspace_service_grants
FOR EACH ROW EXECUTE FUNCTION identity.grant_termination_is_one_way();

CREATE FUNCTION identity.reject_identity_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'identity records are append-only: % on %.%',
    TG_OP, TG_TABLE_SCHEMA, TG_TABLE_NAME;
END $$;

CREATE TRIGGER reject_mutation
BEFORE UPDATE OR DELETE ON identity.service_principal_roles
FOR EACH ROW EXECUTE FUNCTION identity.reject_identity_mutation();

-- ─────────────────────────────────────────────────────────────────────────────
-- Schema USAGE. Granted only after the schema exists — an earlier draft placed
-- these in database bootstrap, which runs before `CREATE SCHEMA identity` and
-- therefore could not have worked.
--
-- No runtime role receives any TABLE privilege in this schema. Every read goes
-- through the SECURITY DEFINER functions in 012.
-- ─────────────────────────────────────────────────────────────────────────────
GRANT USAGE ON SCHEMA identity
  TO ai_capital_identity_authority,
     ai_capital_importer,
     ai_capital_agent,
     ai_capital_operator;

-- Temporary: the authority role must create its own functions in 012 so that
-- they are OWNED by it (ALTER FUNCTION ... OWNER TO would need the reverse
-- membership, handing the owner a path into the authority role). Revoked by
-- ops/bootstrap/090_post_migration_lockdown.sql.
GRANT CREATE ON SCHEMA identity TO ai_capital_identity_authority;

REVOKE ALL ON ALL TABLES    IN SCHEMA identity FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA identity FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA identity FROM PUBLIC;
