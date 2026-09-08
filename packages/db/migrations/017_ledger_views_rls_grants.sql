-- ═══════════════════════════════════════════════════════════════════════════
-- LEDGER VIEWS, ROW-LEVEL SECURITY, ATTRIBUTION AND GRANTS.
--
-- Everything that depends on the whole ledger existing is here, defined once.
--
-- WHY THE VIEWS MOVED. In V2 the nine views were scattered across four
-- migrations and `current_transactions` was written three times — created, then
-- CREATE OR REPLACE'd twice as its dependencies landed. Defining each once, in
-- final form, after every table exists removes that churn entirely.
--
-- THE ORDERING OBLIGATION, DISCHARGED. Four of these views are referenced from
-- INSIDE PL/pgSQL function bodies created in 013-016:
--   reconciliation_case_current_state   (013, 014)
--   active_account_resolutions          (014)
--   active_document_verification_events (015)
-- PL/pgSQL resolves relation names at EXECUTION time, not at CREATE FUNCTION
-- time, so those functions may be created before the views. The only hazard is
-- a trigger FIRING before this file runs, and 013-016 are pure DDL: no INSERT
-- into any ledger table, and the tables are empty when 014's ADD COLUMN ...
-- DEFAULT rewrites run. The assertion at the foot of this file re-checks that
-- all nine exist once it has finished.
--
-- SECURITY MODEL, IN ONE SENTENCE: a caller-set GUC SELECTS a workspace, and
-- `session_user` — checked against the grant table by the SECURITY DEFINER
-- functions in 012 — AUTHORIZES it. Neither alone is sufficient, and a policy
-- that compared against the GUC alone would be no protection at all.
-- ═══════════════════════════════════════════════════════════════════════════

-- ─────────────────────────────────────────────────────────────────────────────
-- 0. ROLE STATE. Named, never assumed.
--
-- The runner enters as ai_capital_owner. Section 4 switches to the identity
-- authority to create a SECURITY DEFINER function; sections 5 onward switch
-- BACK EXPLICITLY. `RESET ROLE` is not used anywhere in this file, because it
-- returns to session_user (ai_capital_migrator during a migration), not to the
-- role that was active before the switch — SET ROLE is not a stack. See
-- tests/unit/migration-role-state.test.ts, which walks this file as a state
-- machine and fails if any privileged statement becomes reachable as migrator.
-- ─────────────────────────────────────────────────────────────────────────────
SET LOCAL ROLE ai_capital_owner;

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Physical document storage, separated from evidentiary observation.
--
-- Deduplication belongs on the BYTES. It must not be a unique constraint on the
-- observations, because a broker legitimately re-sending the same confirmation
-- is two facts, and collapsing them would destroy audit evidence. Duplicates
-- surface as a `duplicate_document` reconciliation case instead.
--
-- Nothing in this foundation reads, writes or serves a file: only the metadata
-- and the relative object key are stored, and their validation is tested.
-- Filesystem activation and HTTP delivery are a later, separately authorized
-- gate.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE investment_ledger.document_blobs (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id   UUID NOT NULL REFERENCES identity.workspaces(id),
  actor_principal_id UUID NOT NULL REFERENCES identity.principals(id),
  content_sha256 TEXT NOT NULL CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
  byte_size      BIGINT NOT NULL CHECK (byte_size >= 0),
  -- RELATIVE key, exactly three components:
  --     '<workspace uuid>/<platform dir>/<filename>'
  -- Never absolute, never client-visible.
  --
  -- THE '..' CLAIM USED TO BE FALSE. The comment here said "'..' is
  -- unrepresentable" while the pattern's third component, `[A-Za-z0-9._-]`,
  -- accepted a filename of exactly `.` or `..` — so `<ws>/statements/..` passed
  -- both this CHECK and the workspace trigger. The shape alone cannot express
  -- it: the character class must keep dots, because real filenames have
  -- extensions, and "any string of these characters EXCEPT two particular
  -- strings" is not a character class. So the two rules are stated separately —
  -- the pattern fixes the SHAPE, the CHECK below excludes the two traversal
  -- names. Components 1 and 2 need no such guard: a uuid cannot be `.` or `..`,
  -- and `[a-z0-9_]+` admits no dot at all.
  object_key     TEXT NOT NULL
                 CHECK (object_key ~ '^[0-9a-f-]{36}/[a-z0-9_]+/[A-Za-z0-9._-]{1,200}$')
                 CONSTRAINT document_blobs_object_key_no_traversal
                 CHECK (split_part(object_key, '/', 3) NOT IN ('.', '..')),
  recorded_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Deduplication INSIDE a workspace only. A global index on the hash would be
  -- an existence oracle: one tenant could test whether another holds a file.
  UNIQUE (workspace_id, content_sha256),
  UNIQUE (workspace_id, id)
);

CREATE FUNCTION investment_ledger.assert_object_key_workspace() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF split_part(NEW.object_key, '/', 1) <> NEW.workspace_id::text THEN
    RAISE EXCEPTION 'object_key must begin with its own workspace id';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER object_key_is_workspace_scoped
BEFORE INSERT ON investment_ledger.document_blobs
FOR EACH ROW EXECUTE FUNCTION investment_ledger.assert_object_key_workspace();

CREATE TRIGGER reject_mutation
BEFORE UPDATE OR DELETE ON investment_ledger.document_blobs
FOR EACH ROW EXECUTE FUNCTION investment_ledger.reject_economic_mutation();

-- BOTH guards, not one. 016 installs `reject_mutation` AND `reject_truncate` on
-- every table that existed when it ran, and asserts the pair is present on all
-- of them. `document_blobs` is created HERE, after that assertion, so it has to
-- install its own — and an earlier draft installed only the UPDATE/DELETE half,
-- leaving the single newest table as the one place TRUNCATE was ungoverned.
-- No runtime role holds TRUNCATE, so this is defence in depth; but the whole
-- point of a guard installed uniformly is that nobody has to check whether the
-- privilege happens to be granted today.
CREATE TRIGGER reject_truncate
BEFORE TRUNCATE ON investment_ledger.document_blobs
FOR EACH STATEMENT EXECUTE FUNCTION investment_ledger.reject_economic_mutation();

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. The nine views, in final form.
--
-- security_invoker=true throughout: the server is PostgreSQL 17 and the feature
-- needs >= 15. Without it a view runs with the DEFINER's rights, and the safety
-- of the whole arrangement would rest on FORCE RLS being present on every base
-- table rather than on the obvious reading of the code.
--
-- security_barrier=true only where the view's OWN predicate is doing security
-- work, because the barrier costs optimisation freedom. The other five sit
-- above RLS-protected tables with purely business-logic predicates.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE VIEW investment_ledger.active_account_resolutions
WITH (security_invoker = true) AS
SELECT r.*
  FROM investment_ledger.account_resolutions r
 WHERE NOT EXISTS (
   SELECT 1 FROM investment_ledger.account_resolutions s WHERE s.supersedes_id = r.id
 );

CREATE VIEW investment_ledger.active_document_verification_events
WITH (security_invoker = true) AS
SELECT e.*
  FROM investment_ledger.document_verification_events e
 WHERE NOT EXISTS (
   SELECT 1 FROM investment_ledger.document_verification_events s
    WHERE s.supersedes_id = e.id
 );

CREATE VIEW investment_ledger.current_document_verification
WITH (security_invoker = true, security_barrier = true) AS
SELECT v.id                  AS variant_id,
       v.workspace_id,
       v.logical_document_id,
       v.variant_kind,
       v.observed_path,
       CASE
         WHEN e.event_kind = 'verified'  THEN 'verified'
         WHEN e.event_kind = 'failed'    THEN 'failed'
         ELSE 'unverified'
       END                   AS verification_state,
       CASE WHEN e.event_kind = 'verified' THEN e.content_sha256 ELSE NULL END AS content_sha256,
       e.id                  AS verification_event_id,
       e.actor_principal_id  AS verified_by,
       e.observed_at         AS verified_at,
       e.reason              AS verification_reason
  FROM investment_ledger.document_file_variants v
  LEFT JOIN investment_ledger.active_document_verification_events e
         ON e.variant_id = v.id AND e.workspace_id = v.workspace_id;

-- Relocated from 015, where it sat after the view had been moved out into this
-- file. COMMENT ON resolves its target immediately, so it belongs with the
-- CREATE VIEW and nowhere earlier.
COMMENT ON VIEW investment_ledger.current_document_verification IS
  'Authoritative verification state per file variant. Supersedes the frozen '
  'document_file_variants.verification_status column, which records only the '
  'state at first observation and cannot change because the table is append-only.';

CREATE VIEW investment_ledger.current_import_batches
WITH (security_invoker = true, security_barrier = true) AS
SELECT b.*
  FROM investment_ledger.import_batches b
 WHERE NOT EXISTS (
   SELECT 1 FROM investment_ledger.import_batches s
    WHERE s.changed_from_batch = b.id
      AND s.series_key = b.series_key
      AND s.workspace_id = b.workspace_id
 );

CREATE VIEW investment_ledger.current_transactions
WITH (security_invoker = true, security_barrier = true) AS
SELECT t.*
  FROM investment_ledger.transactions t
 WHERE (
    t.import_row_id IS NULL
    OR EXISTS (
      SELECT 1
        FROM investment_ledger.raw_import_rows r
        JOIN investment_ledger.current_import_batches cb
          ON cb.id = r.batch_id AND cb.workspace_id = r.workspace_id
       WHERE r.id = t.import_row_id AND r.workspace_id = t.workspace_id
    )
  )
   AND t.correction_role IS DISTINCT FROM 'reversal'
   AND NOT EXISTS (
     SELECT 1 FROM investment_ledger.transactions c
      WHERE c.correction_of_id = t.id
        AND c.workspace_id = t.workspace_id
        AND c.correction_role = 'reversal'
   );

CREATE VIEW investment_ledger.economic_amount_components
WITH (security_invoker = true) AS
SELECT a.* FROM investment_ledger.transaction_amount_components a
JOIN investment_ledger.current_transactions t
  ON t.id = a.transaction_id AND t.workspace_id = a.workspace_id
WHERE a.counting_role = 'economic';

-- THE ONE VIEW THAT COULD STRUCTURALLY CROSS TENANTS.
--
-- Its recursive walk follows account_resolutions, and in V2 a placeholder such
-- as `Bualuang:UNRESOLVED_ACCOUNT` was ONE ROW shared by every operator, so the
-- recursion could resolve one person's account into another's. Two independent
-- fixes: `UNIQUE (workspace_id, account_key)` in 013 un-shares the placeholder,
-- and the workspace is carried explicitly through every step below rather than
-- being left to row-level security alone.
CREATE VIEW investment_ledger.effective_accounts
WITH (security_invoker = true, security_barrier = true) AS
WITH RECURSIVE chain(workspace_id, account_id, effective_account_id, depth) AS (
  SELECT a.workspace_id, a.id, a.id, 0
    FROM investment_ledger.accounts a
  UNION ALL
  SELECT c.workspace_id, c.account_id, r.resolved_account_id, c.depth + 1
    FROM chain c
    JOIN investment_ledger.active_account_resolutions r
      ON r.placeholder_account_id = c.effective_account_id
     AND r.workspace_id = c.workspace_id            -- explicit, not implied
     AND r.resolution_kind = 'resolve'
   WHERE c.depth < 32
)
SELECT DISTINCT ON (workspace_id, account_id)
       workspace_id, account_id, effective_account_id, depth AS resolution_depth
  FROM chain
 ORDER BY workspace_id, account_id, depth DESC;

CREATE VIEW investment_ledger.reconciliation_case_current_state
WITH (security_invoker = true) AS
SELECT c.id AS case_id, c.workspace_id, c.case_key, c.case_type,
       CASE e.event_type
         WHEN 'OPEN' THEN 'open' WHEN 'MATCH' THEN 'matched'
         WHEN 'FLAG_MISMATCH' THEN 'mismatch' WHEN 'REQUEST_REVIEW' THEN 'review'
         WHEN 'RESOLVE' THEN 'resolved' WHEN 'DISMISS' THEN 'dismissed'
         WHEN 'REOPEN' THEN 'open'
       END AS state,
       e.id AS last_event_id, e.occurred_at AS changed_at
  FROM investment_ledger.reconciliation_cases c
  LEFT JOIN LATERAL (
    SELECT * FROM investment_ledger.reconciliation_case_events e0
     WHERE e0.case_id = c.id AND e0.workspace_id = c.workspace_id
     ORDER BY e0.id DESC LIMIT 1
  ) e ON true;

CREATE VIEW investment_ledger.transaction_effective_accounts
WITH (security_invoker = true) AS
SELECT t.id                    AS transaction_id,
       t.workspace_id,
       t.account_id            AS recorded_account_id,
       e.effective_account_id,
       (e.resolution_depth > 0) AS was_resolved,
       e.resolution_depth
  FROM investment_ledger.current_transactions t
  JOIN investment_ledger.effective_accounts e
    ON e.account_id = t.account_id AND e.workspace_id = t.workspace_id;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Attribution triggers. The ALLOWED CAPABILITY SET is per table, passed as
--    trigger arguments — `transactions` legitimately accepts archive-import OR
--    manual-entry, and one fixed capability could not express that.
--
--    EVERY tenant table gets one. A table that carries workspace_id and
--    actor_principal_id but no trigger would accept a row attributing an action
--    to a principal who never took it, which is exactly the guarantee the
--    column was added to provide. tests/unit/tenant-attribution-matrix.test.ts
--    checks the three — column, foreign key, trigger — as one set.
-- ─────────────────────────────────────────────────────────────────────────────

-- THE NARROW CHANGED-ARCHIVE PATH.
--
-- The contradiction this resolves: an archive import that supersedes a prior
-- batch must RAISE a `changed_archive` case so a human reviews the difference,
-- and a case with no opening event is invisible. But the importer holds only
-- `archive-import`, and reconciliation history is `reconciliation`'s to write.
--
-- The wrong fixes were: grant the importer `reconciliation` (it could then
-- RESOLVE its own flag — the importer marking its own homework), or let the
-- CLI request both capabilities (same thing, spelled differently).
--
-- The rule instead: a caller holding only `archive-import` may insert exactly
-- one event — 'OPEN', on a case of type `changed_archive`, in ITS OWN
-- workspace, where that case has no events yet. Everything else on this table,
-- including a second OPEN, MATCH, FLAG_MISMATCH, REQUEST_REVIEW, RESOLVE,
-- DISMISS and REOPEN, still requires `reconciliation`. So an importer can raise
-- the flag and can never lower it.
--
-- SECURITY INVOKER, deliberately. It runs as the importer, so the lookups below
-- are themselves filtered by that role's RLS policies: a case in another
-- workspace is not merely rejected, it is not visible, and the `IS DISTINCT
-- FROM` branch below closes the not-visible case with the same error.
--
-- The "no events yet" test is a read, so two concurrent transactions could both
-- pass it. 013's partial unique index `uq_reconciliation_case_events_open` is
-- what actually makes at-most-one-OPEN true; this trigger is the readable rule
-- and the source of the useful error message.
CREATE FUNCTION investment_ledger.assert_reconciliation_event_scope() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, investment_ledger, identity
AS $$
DECLARE v_case_type text;
BEGIN
  -- Full reconciliation authority: every transition is permitted.
  IF identity.service_has_workspace_capability(
       NEW.workspace_id, 'reconciliation'::identity.service_capability) THEN
    RETURN NEW;
  END IF;

  IF NOT identity.service_has_workspace_capability(
           NEW.workspace_id, 'archive-import'::identity.service_capability) THEN
    RAISE EXCEPTION
      'writing reconciliation history in workspace % requires the reconciliation capability',
      NEW.workspace_id USING ERRCODE = '42501';
  END IF;

  IF NEW.event_type <> 'OPEN' THEN
    RAISE EXCEPTION
      'archive-import may author only the opening event of a changed_archive case, not %',
      NEW.event_type USING ERRCODE = '42501';
  END IF;

  SELECT case_type INTO v_case_type
    FROM investment_ledger.reconciliation_cases
   WHERE id = NEW.case_id AND workspace_id = NEW.workspace_id;

  IF v_case_type IS DISTINCT FROM 'changed_archive' THEN
    RAISE EXCEPTION
      'archive-import may open only changed_archive cases; case % is %',
      NEW.case_id, coalesce(v_case_type, '<not visible in this workspace>')
      USING ERRCODE = '42501';
  END IF;

  PERFORM 1 FROM investment_ledger.reconciliation_case_events
   WHERE case_id = NEW.case_id AND workspace_id = NEW.workspace_id;
  IF FOUND THEN
    RAISE EXCEPTION
      'case % already has reconciliation events; archive-import may author only the initial one',
      NEW.case_id USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END $$;

CREATE TRIGGER actor_is_authorized BEFORE INSERT ON investment_ledger.accounts
  FOR EACH ROW EXECUTE FUNCTION identity.assert_actor_authorized('archive-import','manual-entry');
CREATE TRIGGER actor_is_authorized BEFORE INSERT ON investment_ledger.instrument_aliases
  FOR EACH ROW EXECUTE FUNCTION identity.assert_actor_authorized('archive-import','manual-entry');
CREATE TRIGGER actor_is_authorized BEFORE INSERT ON investment_ledger.transaction_groups
  FOR EACH ROW EXECUTE FUNCTION identity.assert_actor_authorized('archive-import','manual-entry');
CREATE TRIGGER actor_is_authorized BEFORE INSERT ON investment_ledger.import_batches
  FOR EACH ROW EXECUTE FUNCTION identity.assert_actor_authorized('archive-import');
CREATE TRIGGER actor_is_authorized BEFORE INSERT ON investment_ledger.raw_import_rows
  FOR EACH ROW EXECUTE FUNCTION identity.assert_actor_authorized('archive-import');
CREATE TRIGGER actor_is_authorized BEFORE INSERT ON investment_ledger.document_file_variants
  FOR EACH ROW EXECUTE FUNCTION identity.assert_actor_authorized('archive-import');
CREATE TRIGGER actor_is_authorized BEFORE INSERT ON investment_ledger.document_extractions
  FOR EACH ROW EXECUTE FUNCTION identity.assert_actor_authorized('archive-import');
CREATE TRIGGER actor_is_authorized BEFORE INSERT ON investment_ledger.logical_documents
  FOR EACH ROW EXECUTE FUNCTION identity.assert_actor_authorized('archive-import');
CREATE TRIGGER actor_is_authorized BEFORE INSERT ON investment_ledger.document_blobs
  FOR EACH ROW EXECUTE FUNCTION identity.assert_actor_authorized('archive-import');
CREATE TRIGGER actor_is_authorized BEFORE INSERT ON investment_ledger.validation_findings
  FOR EACH ROW EXECUTE FUNCTION identity.assert_actor_authorized('archive-import');
CREATE TRIGGER actor_is_authorized BEFORE INSERT ON investment_ledger.transactions
  FOR EACH ROW EXECUTE FUNCTION identity.assert_actor_authorized('archive-import','manual-entry');
CREATE TRIGGER actor_is_authorized BEFORE INSERT ON investment_ledger.transaction_amount_components
  FOR EACH ROW EXECUTE FUNCTION identity.assert_actor_authorized('archive-import','manual-entry');
CREATE TRIGGER actor_is_authorized BEFORE INSERT ON investment_ledger.transaction_document_links
  FOR EACH ROW EXECUTE FUNCTION identity.assert_actor_authorized('archive-import','manual-entry');
CREATE TRIGGER actor_is_authorized BEFORE INSERT ON investment_ledger.reconciliation_cases
  FOR EACH ROW EXECUTE FUNCTION identity.assert_actor_authorized('archive-import','reconciliation');
-- archive-import is admitted HERE only so the scope trigger below can decide.
-- Alphabetical order is firing order for BEFORE ROW triggers, and
-- `actor_is_authorized` sorts before `reconciliation_event_scope`, so identity
-- is settled before scope is judged.
CREATE TRIGGER actor_is_authorized BEFORE INSERT ON investment_ledger.reconciliation_case_events
  FOR EACH ROW EXECUTE FUNCTION identity.assert_actor_authorized('archive-import','reconciliation');
CREATE TRIGGER reconciliation_event_scope BEFORE INSERT ON investment_ledger.reconciliation_case_events
  FOR EACH ROW EXECUTE FUNCTION investment_ledger.assert_reconciliation_event_scope();
CREATE TRIGGER actor_is_authorized BEFORE INSERT ON investment_ledger.account_resolutions
  FOR EACH ROW EXECUTE FUNCTION identity.assert_actor_authorized('reconciliation');
CREATE TRIGGER actor_is_authorized BEFORE INSERT ON investment_ledger.document_verification_events
  FOR EACH ROW EXECUTE FUNCTION identity.assert_actor_authorized('document-verification');

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. The instrument resolver.
--
-- `instruments` is global and no runtime role may INSERT into it, but the
-- importer must be able to introduce a security it has never seen. This
-- function is the only path, and it reproduces V2's canonical keys EXACTLY —
-- including the fee form `FEE:<BROKER WITH SPACES AS UNDERSCORES>`, which a
-- currency/exchange/symbol resolver could not produce. `Binance TH` must still
-- map to `FEE:BINANCE_TH`.
-- ─────────────────────────────────────────────────────────────────────────────
-- THE BLANKET FUNCTION REVOKE RUNS HERE, AND THE POSITION IS THE WHOLE POINT.
--
-- PostgreSQL grants EXECUTE to PUBLIC on every new function, so the schema
-- needs a sweep. It must happen while current_user is ai_capital_owner AND
-- BEFORE the authority creates the resolver below, because:
--
--   * a REVOKE on a function you do not own is refused, and
--   * `ON ALL FUNCTIONS IN SCHEMA` is a loop over every function in the schema,
--     so one un-owned function fails the whole statement.
--
-- Section 6 used to hold this line. By then the schema contained
-- `resolve_or_create_instrument`, owned by ai_capital_identity_authority and —
-- crucially — already carrying an EXPLICIT ACL from its own revoke and grant.
-- A function still at DEFAULT (NULL) ACL only produces `WARNING: no privileges
-- could be revoked`; one with an explicit ACL is a hard failure:
--
--     ERROR: permission denied for function resolve_or_create_instrument
--
-- Every owner-owned function in this schema exists by now — 013-016's, plus
-- section 1's `assert_object_key_workspace` and section 3's
-- `assert_reconciliation_event_scope` — so the sweep is complete. The resolver
-- is not swept and does not need to be: it issues its own owner-issued
-- `REVOKE ALL ... FROM PUBLIC` the moment it is created, three statements
-- below. No final ACL is weakened; only the order changes.
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA investment_ledger FROM PUBLIC;

-- TWO GRANTS, WITH DIFFERENT LIFETIMES, AND THE DIFFERENCE IS LOAD-BEARING.
--
--   USAGE  is PERMANENT. `resolve_or_create_instrument` is SECURITY DEFINER and
--          therefore executes as ai_capital_identity_authority. Resolving the
--          name `investment_ledger.instruments` inside its body requires USAGE
--          on this schema FOR THE FUNCTION OWNER, at every call, forever. An
--          earlier draft granted only CREATE — enough to define the function,
--          and not enough to ever run it: every call would have raised 42501
--          "permission denied for schema investment_ledger", and it would have
--          done so only after lockdown, on a database nobody could re-migrate.
--          ops/bootstrap/090 already SAYS "USAGE is retained"; until now there
--          was no USAGE to retain.
--
--   CREATE is TEMPORARY, for the CREATE FUNCTION below only, and is revoked by
--          ops/bootstrap/090_post_migration_lockdown.sql. The authority must
--          create the function itself so that it OWNS it: `ALTER FUNCTION ...
--          OWNER TO` would require the owner role to be a member of the
--          authority, which is exactly the path into the authority that this
--          design refuses to open.
--
-- The lifecycle is asserted statically by
-- tests/unit/ledger-static-contracts.test.ts, which checks that 017 grants
-- both, that 090 revokes CREATE, and that 090 revokes USAGE from nobody.
GRANT USAGE  ON SCHEMA investment_ledger TO ai_capital_identity_authority;
GRANT CREATE ON SCHEMA investment_ledger TO ai_capital_identity_authority;

SET LOCAL ROLE ai_capital_identity_authority;

CREATE FUNCTION investment_ledger.resolve_or_create_instrument(
  p_side text, p_broker text, p_currency text, p_exchange text, p_asset text,
  p_workspace uuid
) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, investment_ledger, identity
AS $$
DECLARE v_key text; v_type text; v_name text; v_id uuid;
BEGIN
  -- Capability proven from session_user against the EXPLICIT workspace
  -- argument. The any-of form is required: a throwing single check would abort
  -- before the second capability could be considered.
  PERFORM identity.authorize_service_workspace_any(
            p_workspace,
            ARRAY['archive-import','manual-entry']::identity.service_capability[]);

  IF p_side NOT IN ('BUY','SELL','SUB','RED','SWITCH_IN','SWITCH_OUT','FEE') THEN
    RAISE EXCEPTION 'unsupported side %', p_side;
  END IF;

  IF p_side = 'FEE' THEN
    -- V2: `FEE:${row.broker.toUpperCase().replace(/\s+/g,'_')}` — note there is
    -- deliberately no trim, so V2's treatment of surrounding whitespace as
    -- underscores is reproduced rather than "improved".
    v_key  := 'FEE:' || regexp_replace(upper(p_broker), '\s+', '_', 'g');
    v_type := 'fee';
    v_name := p_broker || ' fees';
  ELSE
    v_key  := upper(btrim(p_currency)) || ':'
           || coalesce(nullif(upper(btrim(p_exchange)), ''), 'NO_EXCHANGE') || ':'
           || upper(btrim(p_asset));
    v_type := CASE WHEN p_side IN ('SUB','SWITCH_IN','SWITCH_OUT','RED')
                   THEN 'fund' ELSE 'equity' END;
    v_name := p_asset;
  END IF;

  IF v_key IS NULL OR btrim(v_key) = '' OR length(v_key) > 200 THEN
    RAISE EXCEPTION 'invalid canonical key';
  END IF;

  SELECT id INTO v_id FROM investment_ledger.instruments WHERE canonical_key = v_key;
  IF v_id IS NOT NULL THEN RETURN v_id; END IF;

  INSERT INTO investment_ledger.instruments (canonical_key, display_name, instrument_type)
  VALUES (v_key, v_name, v_type)
  ON CONFLICT (canonical_key) DO NOTHING
  RETURNING id INTO v_id;
  IF v_id IS NULL THEN            -- lost the race; the other writer's row stands
    SELECT id INTO v_id FROM investment_ledger.instruments WHERE canonical_key = v_key;
  END IF;
  RETURN v_id;
END $$;

-- STILL THE AUTHORITY. `resolve_or_create_instrument` is owned by
-- ai_capital_identity_authority, and only a function's owner may REVOKE the
-- default PUBLIC EXECUTE or grant it onward. An earlier draft issued
-- `RESET ROLE;` at this point on the belief that it restored ai_capital_owner.
-- It restores session_user — ai_capital_migrator — whose authority membership
-- is WITH INHERIT FALSE, so both statements below would have raised 42501 and
-- rolled the migration back, leaving the function EXECUTABLE BY PUBLIC in every
-- draft where the failure was not fatal.
REVOKE ALL ON FUNCTION investment_ledger.resolve_or_create_instrument(
  text, text, text, text, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION investment_ledger.resolve_or_create_instrument(
  text, text, text, text, text, uuid) TO ai_capital_importer;

-- Back to the owner EXPLICITLY. Everything from here to the end of the file —
-- grants on owner-owned tables, RLS policies, schema-wide revokes, default
-- privileges and the closing assertions — is owner-only.
SET LOCAL ROLE ai_capital_owner;

-- The authority needs to read and insert the global table from inside that
-- function. `instruments` carries no RLS, so no policy is required for it.
GRANT SELECT (id, canonical_key, display_name, instrument_type)
  ON investment_ledger.instruments TO ai_capital_identity_authority;
GRANT INSERT (canonical_key, display_name, instrument_type)
  ON investment_ledger.instruments TO ai_capital_identity_authority;

-- THE SECOND RUNTIME FUNCTION GRANT, and the fresh gate is why it exists.
--
-- `enforce_correction_integrity()` is a DEFERRABLE INITIALLY DEFERRED CONSTRAINT
-- TRIGGER function. Firing a trigger checks no EXECUTE privilege at all, so the
-- blanket revoke above left it working — but its body does
--
--     PERFORM investment_ledger.validate_correction_group(gid);
--
-- and THAT is an ordinary function invocation, which checks EXECUTE against the
-- role that caused the trigger to fire. After the sweep, the validator's ACL was
-- `ai_capital_owner=X/ai_capital_owner` and no runtime role could execute it, so
-- every correction group written by ai_capital_importer died at
-- SET CONSTRAINTS / COMMIT with
--
--     ERROR: permission denied for function validate_correction_group  (42501)
--
-- reaching the trigger and then being refused BEFORE the correction-integrity
-- rule could run. It failed closed — no bad data — but corrections were
-- unusable and the guarantee was never delivered. The 2026-09-07 fresh
-- PostgreSQL gate reproduced it exactly.
--
-- WHY THIS GRANT AND NOT SOMETHING ELSE. Marking either function
-- SECURITY DEFINER would fix the symptom and destroy the property that matters:
-- the validator's reads of `transactions` and `transaction_amount_components`
-- would then run as the owner, escaping the caller's RLS, and a correction
-- group could be validated against rows in workspaces the caller cannot see.
-- The validator stays SECURITY INVOKER, so its reads remain bound to the
-- importer's active `app.workspace_id` and the same policies as every other
-- read it makes. Granting EXECUTE to PUBLIC, or to the agent, app, operator or
-- migrator, would hand the validator to roles that can never legitimately reach
-- it: only a role that may INSERT a correction transaction can cause the
-- trigger to fire, and `ai_capital_importer` is the only such login.
-- `enforce_correction_integrity()` itself is granted to NOBODY — a trigger
-- needs no EXECUTE, and granting it would let a runtime role call the trigger
-- body directly, outside any trigger context.
--
-- So: exactly one function, exactly one role, no change of security context.
GRANT EXECUTE ON FUNCTION investment_ledger.validate_correction_group(UUID)
  TO ai_capital_importer;

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. Row-level security on every tenant table.
--
-- `instruments` is deliberately excluded: it is global reference data.
--
-- NOTE ON UPDATE. Migration 016 documents why the UPDATE privilege cannot be
-- revoked: PostgreSQL charges `SELECT ... FOR UPDATE` row locking against it,
-- and the ledger's concurrency tests depend on locking. So the privilege stays,
-- and `WITH CHECK (false)` on the policy permits no actual write.
--
-- WHICH DENIAL IS OBSERVED, stated in the order the server uses. For an
-- ordinary UPDATE of a row the caller can see, PostgreSQL evaluates the UPDATE
-- policy's USING clause, fires BEFORE ROW triggers, and only then applies
-- WITH CHECK to the proposed row. `reject_economic_mutation` is a BEFORE UPDATE
-- trigger, so it raises first and the caller observes its P0001 — not the
-- policy's 42501. Both denials are real and independent; the trigger is simply
-- the one reached first, and WITH CHECK (false) is the backstop that would
-- refuse the write if the trigger were ever dropped.
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  t            text;
  select_caps  text;
  insert_caps  text;
  lock_caps    text;
  tenant_tables CONSTANT text[] := ARRAY[
    'accounts','instrument_aliases','import_batches','raw_import_rows',
    'logical_documents','document_file_variants','document_extractions',
    'document_blobs','document_verification_events','transaction_groups',
    'transactions','transaction_amount_components','transaction_document_links',
    'validation_findings','reconciliation_cases','reconciliation_case_events',
    'account_resolutions'
  ];
BEGIN
  FOREACH t IN ARRAY tenant_tables LOOP
    EXECUTE format('ALTER TABLE investment_ledger.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE investment_ledger.%I FORCE  ROW LEVEL SECURITY', t);

    -- ── CAPABILITIES ARE PER OPERATION, NOT PER TABLE. ────────────────────
    --
    -- An earlier version derived ONE set per table and used it for SELECT,
    -- INSERT and the locking UPDATE alike. That is wrong in both directions,
    -- and the disposable-cluster gate proved it: three BEFORE INSERT trigger
    -- functions take `SELECT ... FOR UPDATE` on a table OTHER than the one
    -- being written, under the capability of the WRITE they are validating:
    --
    --   validate_account_resolution()          locks accounts
    --                                          fires under `reconciliation`
    --   validate_document_verification_event() locks document_file_variants
    --                                          fires under `document-verification`
    --   validate_reconciliation_event()        locks reconciliation_cases
    --                                          fires under archive-import|reconciliation
    --
    -- PostgreSQL charges a row lock to the UPDATE privilege AND evaluates the
    -- UPDATE policy's USING clause as well as the SELECT policy's — so a lock
    -- is gated by two policies. With one shared set, `reconciliation` could not
    -- lock an account and `document-verification` could not lock a variant, and
    -- the real workflows failed.
    --
    -- The fix must NOT be to widen the shared set: that would hand
    -- `reconciliation` the right to INSERT accounts and `document-verification`
    -- the right to INSERT file variants. Reading a row and creating one are
    -- different authorities, so they get different sets. Only the two tables
    -- that are locked from another table's trigger diverge; the other fifteen
    -- keep one set expressed three times, which is deliberate — a future
    -- divergence should be written down, not inferred.
    select_caps := CASE t
      -- Locked by validate_account_resolution() under `reconciliation`, which
      -- must be able to READ the account it is resolving. It must NOT be able
      -- to create one — see insert_caps.
      WHEN 'accounts'                     THEN '''archive-import'',''manual-entry'',''reconciliation'''
      -- Locked by validate_document_verification_event() under
      -- `document-verification`, which must read the variant it verifies.
      WHEN 'document_file_variants'       THEN '''archive-import'',''document-verification'''
      WHEN 'instrument_aliases'           THEN '''archive-import'',''manual-entry'''
      WHEN 'transaction_groups'           THEN '''archive-import'',''manual-entry'''
      WHEN 'transactions'                 THEN '''archive-import'',''manual-entry'''
      WHEN 'transaction_amount_components' THEN '''archive-import'',''manual-entry'''
      WHEN 'transaction_document_links'   THEN '''archive-import'',''manual-entry'''
      -- Locked by validate_reconciliation_event(); its trigger already fires
      -- under exactly this pair, so no widening is needed. Verified, not assumed.
      WHEN 'reconciliation_cases'         THEN '''archive-import'',''reconciliation'''
      WHEN 'reconciliation_case_events'   THEN '''archive-import'',''reconciliation'''
      WHEN 'account_resolutions'          THEN '''reconciliation'''
      WHEN 'document_verification_events' THEN '''document-verification'''
      ELSE '''archive-import'''
    END;

    insert_caps := CASE t
      -- accounts and document_file_variants: the CREATION authority, which is
      -- deliberately NARROWER than the read authority above.
      WHEN 'accounts'                     THEN '''archive-import'',''manual-entry'''
      WHEN 'document_file_variants'       THEN '''archive-import'''
      WHEN 'instrument_aliases'           THEN '''archive-import'',''manual-entry'''
      WHEN 'transaction_groups'           THEN '''archive-import'',''manual-entry'''
      WHEN 'transactions'                 THEN '''archive-import'',''manual-entry'''
      WHEN 'transaction_amount_components' THEN '''archive-import'',''manual-entry'''
      WHEN 'transaction_document_links'   THEN '''archive-import'',''manual-entry'''
      WHEN 'reconciliation_cases'         THEN '''archive-import'',''reconciliation'''
      -- Coarse here; `assert_reconciliation_event_scope` (section 3) narrows
      -- archive-import to exactly one event — the initial OPEN of a
      -- changed_archive case. That carve-out is unchanged.
      WHEN 'reconciliation_case_events'   THEN '''archive-import'',''reconciliation'''
      WHEN 'account_resolutions'          THEN '''reconciliation'''
      WHEN 'document_verification_events' THEN '''document-verification'''
      ELSE '''archive-import'''
    END;

    -- Locking follows READING: a lock is a read that blocks writers, and every
    -- caller that may see a row may serialise against it.
    lock_caps := select_caps;

    -- ── THE PREDICATE. ───────────────────────────────────────────────────
    --
    -- Two facts must hold, and the ORDER IN WHICH THEY ARE PROVEN IS PART OF
    -- THE CONTRACT:
    --
    --   1. the selected workspace is AUTHORIZED here  (the grant table as the
    --      authority, resolved from session_user)
    --   2. the row belongs to the SELECTED workspace  (the GUC as a selector)
    --
    -- ROUND 5 GOT THE FACTS RIGHT AND THE ORDER WRONG. It wrote them as a
    -- top-level conjunction, `workspace_id = guc AND authorize(...) IS NOT
    -- NULL`. SQL does not promise which side of an AND runs first, and the
    -- 2026-09-06 gate proved the consequence on a live cluster: for a row in
    -- another workspace the comparison is false, PostgreSQL skips the second
    -- conjunct, and the THROWING authorizer is never called. Same principal,
    -- same workspace, same capability, two different answers —
    --     direct call     -> ERROR: service principal holds none of {…}
    --     through the AND -> 0 rows, no error
    -- Isolation held; the fail-LOUD contract did not.
    --
    -- SO THE ORDER IS EXPRESSED STRUCTURALLY, NOT BY OPERAND POSITION.
    -- Reversing the AND would fix nothing: operand evaluation order is not a
    -- documented contract, and a future planner change could silently undo it.
    -- A `CASE` is different — PostgreSQL documents that a WHEN condition is
    -- evaluated before its THEN result, and that a THEN branch is not evaluated
    -- at all unless its condition held. `workspace_id` therefore appears ONLY
    -- inside THEN, and is unreachable until the authorizer has already
    -- returned. The documented exception to CASE ordering is constant folding
    -- during planning, which cannot apply here (`current_setting` and the
    -- authorizer are both STABLE, not IMMUTABLE, and neither is foldable) — and
    -- would in any case evaluate the authorizer EARLIER, never later.
    --
    -- WHAT THIS DOES AND DOES NOT GUARANTEE, stated exactly. The guarantee is
    -- per SCANNED ROW: whenever PostgreSQL evaluates this policy against a row,
    -- authorization is proven first, so an unauthorized selected workspace
    -- raises 42501 rather than returning an empty set. It is NOT a claim that
    -- the predicate raises on a relation for which no rows are evaluated — an
    -- empty table, or a scan pruned away, evaluates no qual at all and can
    -- still yield zero rows silently. That residual case is covered elsewhere:
    -- the normal service entrypoints (packages/db/src/workspace-context.ts)
    -- call the authorizer EXPLICITLY before touching data, so a caller never
    -- reaches a ledger relation on unauthorized context in the first place.
    -- RLS is the backstop for that call being skipped, not the only check.
    --
    -- The function's principal-return contract is consumed by
    -- packages/db/src/workspace-context.ts (it derives `app.principal_id` from
    -- it) and by the tenancy fixtures, so the function is NOT changed. It never
    -- returns NULL: it returns a principal or raises. `ELSE false` is therefore
    -- unreachable in practice and is kept so the expression is total rather
    -- than NULL-valued.
    --
    -- Fail-closed on bad context: an absent GUC makes the argument NULL and the
    -- authorizer raises 'no workspace selected'; a malformed one fails the uuid
    -- cast. Another workspace's row survives authorization and is then hidden
    -- by the THEN comparison — cross-workspace hiding is unchanged.
    EXECUTE format($f$
      CREATE POLICY importer_read ON investment_ledger.%I
        FOR SELECT TO ai_capital_importer
        USING (CASE
                 WHEN identity.authorize_service_workspace_any(
                        nullif(current_setting('app.workspace_id', true), '')::uuid,
                        ARRAY[%s]::identity.service_capability[]) IS NOT NULL
                 THEN workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
                 ELSE false
               END)
    $f$, t, select_caps);

    EXECUTE format($f$
      CREATE POLICY importer_insert ON investment_ledger.%I
        FOR INSERT TO ai_capital_importer
        WITH CHECK (CASE
                      WHEN identity.authorize_service_workspace_any(
                             nullif(current_setting('app.workspace_id', true), '')::uuid,
                             ARRAY[%s]::identity.service_capability[]) IS NOT NULL
                      THEN workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
                      ELSE false
                    END)
    $f$, t, insert_caps);

    -- LOCKING ONLY. `WITH CHECK (false)` permits no real UPDATE. It is not,
    -- however, what an ordinary UPDATE hits first: BEFORE ROW triggers run
    -- after this policy's USING clause and before its WITH CHECK, so the
    -- append-only trigger raises P0001 ahead of it. WITH CHECK (false) is the
    -- independent backstop, not the front line. A bare `SELECT ... FOR UPDATE`
    -- modifies no row, so WITH CHECK is never evaluated for it at all — which
    -- is exactly why a lock can be permitted while an update cannot.
    EXECUTE format($f$
      CREATE POLICY importer_lock_only ON investment_ledger.%I
        FOR UPDATE TO ai_capital_importer
        USING (CASE
                 WHEN identity.authorize_service_workspace_any(
                        nullif(current_setting('app.workspace_id', true), '')::uuid,
                        ARRAY[%s]::identity.service_capability[]) IS NOT NULL
                 THEN workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
                 ELSE false
               END)
        WITH CHECK (false)
    $f$, t, lock_caps);
  END LOOP;

  -- NO POLICY FOR ai_capital_agent, ANYWHERE.
  --
  -- An earlier version gave the agent an `agent_read` SELECT policy on ten
  -- tables. It is gone, and its grants with it. The role stays exactly what
  -- ops/roles/000_cluster_roles.sql defines — a LOGIN with no memberships and
  -- no write authority — and it receives NO investment_ledger access in this
  -- foundation.
  --
  -- WHY, in one sentence: with `transactions` withheld (it exposes superseded,
  -- reversed and corrected rows with nothing distinguishing them from current
  -- holdings), none of the remaining tables carries standalone analytical
  -- value, and three of them — import_batches, transaction_groups,
  -- document-bearing tables — expose filename-derived or free-text evidence to
  -- the one role whose boundary forbids source-document paths.
  --
  -- Analytical access is DEFERRED until a capability-coherent current-state
  -- projection exists. `ledger-read` therefore has no consumer in this
  -- foundation and remains in the enum for that future.
END $$;

-- No FOR DELETE policy exists on any table, so RLS denies deletion even where a
-- privilege were somehow granted. 016 revokes DELETE and TRUNCATE as well.

-- ─────────────────────────────────────────────────────────────────────────────
-- 6. Grants. Table-specific and role-specific; no blanket ON ALL TABLES.
--
-- `ai_capital_app` appears NOWHERE. Human runtime authority is deferred to the
-- OIDC gate: with no session mechanism there is no trustworthy way to derive a
-- workspace for a person, and a SELECT policy keyed on a bare GUC would be
-- exactly the unauthenticated pattern this design rejects.
-- ─────────────────────────────────────────────────────────────────────────────
-- ai_capital_agent is absent from here on. It receives no schema USAGE, no
-- table grant, no view grant and no policy in investment_ledger — see the note
-- at the foot of section 5.
GRANT USAGE ON SCHEMA investment_ledger TO ai_capital_importer;

REVOKE ALL ON ALL TABLES    IN SCHEMA investment_ledger FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA investment_ledger FROM PUBLIC;
-- The matching REVOKE for FUNCTIONS is NOT here. It runs in section 4, before
-- the authority creates `resolve_or_create_instrument` — see the note there.

DO $$
DECLARE t text;
BEGIN
  -- Importer: SELECT, INSERT and the locking-only UPDATE on every tenant table.
  FOREACH t IN ARRAY ARRAY[
    'accounts','instrument_aliases','import_batches','raw_import_rows',
    'logical_documents','document_file_variants','document_extractions',
    'document_blobs','document_verification_events','transaction_groups',
    'transactions','transaction_amount_components','transaction_document_links',
    'validation_findings','reconciliation_cases','reconciliation_case_events',
    'account_resolutions'
  ] LOOP
    EXECUTE format(
      'GRANT SELECT, INSERT, UPDATE ON investment_ledger.%I TO ai_capital_importer', t);
  END LOOP;
END $$;

-- The global table: readable by the importer, writable by nobody. The agent is
-- omitted with every other ledger grant.
GRANT SELECT ON investment_ledger.instruments TO ai_capital_importer;

-- ── VIEWS. FOUR GRANTS, FIVE WITHHOLDINGS, EACH NAMED. ────────────────────
--
-- These are `security_invoker` views, so a caller needs privileges on the view
-- AND a working privilege/RLS path through every table and nested view beneath
-- it. A grant is therefore only issued where a TRACED consumer exists and the
-- whole dependency chain is reachable with the capability that consumer holds.
-- No blanket ON ALL TABLES / ON ALL VIEWS: each line names its view.

-- publishArchive reads this to find the head of a series before superseding it
-- (packages/investment-ledger/src/publish.ts). Reads import_batches only, under
-- archive-import — coherent.
GRANT SELECT ON investment_ledger.current_import_batches TO ai_capital_importer;

-- Read by validate_reconciliation_event() (013, replaced in 014), the BEFORE
-- INSERT trigger on reconciliation_case_events. That function is SECURITY
-- INVOKER, so it runs as the WRITER: without this grant every reconciliation
-- event — including the archive-import changed-archive OPEN — fails.
GRANT SELECT ON investment_ledger.reconciliation_case_current_state TO ai_capital_importer;

-- Read by validate_account_resolution() (014), the BEFORE INSERT trigger on
-- account_resolutions, under `reconciliation`. Same invoker reasoning.
GRANT SELECT ON investment_ledger.active_account_resolutions TO ai_capital_importer;

-- Read by validate_document_verification_event() (015), the BEFORE INSERT
-- trigger on document_verification_events, under `document-verification`.
GRANT SELECT ON investment_ledger.active_document_verification_events TO ai_capital_importer;

-- WITHHELD FROM EVERY RUNTIME ROLE, with the reason for each:
--
--   current_transactions
--     NO CONSUMER, and a RAW-EVIDENCE DEPENDENCY: its EXISTS clause reads
--     raw_import_rows, so any role granted it needs a path into the raw import
--     evidence. Nothing in production selects from it today.
--
--   economic_amount_components
--     NO CONSUMER. Inherits current_transactions' raw-evidence dependency.
--
--   transaction_effective_accounts
--     NO CONSUMER, and CAPABILITY-INCOHERENT: it needs archive-import (or
--     manual-entry) for current_transactions AND reconciliation for
--     effective_accounts. No single principal in this design is meant to hold
--     that union, so a grant would produce 42501 at query time, not rows.
--
--   effective_accounts
--     NO CONSUMER, and CAPABILITY-INCOHERENT for the same reason: accounts
--     (archive-import|manual-entry) joined to active_account_resolutions
--     (reconciliation).
--
--   current_document_verification
--     NO CONSUMER, CAPABILITY-INCOHERENT (archive-import for
--     document_file_variants AND document-verification for the events), and it
--     exposes SENSITIVE PATH/EVIDENCE data — observed_path, content checksums
--     and verification reasons.
--
-- The DEFERRED ANALYTICAL PROJECTION that would let an analysis role read
-- current holdings without touching raw import evidence is explicitly out of
-- scope here; until it exists, no role reads a transaction projection.

-- The one sequence in this schema (reconciliation_case_events.id is BIGSERIAL).
-- USAGE permits nextval and not setval, which is the minimum an INSERT needs.
GRANT USAGE ON SEQUENCE investment_ledger.reconciliation_case_events_id_seq
  TO ai_capital_importer;

ALTER DEFAULT PRIVILEGES FOR ROLE ai_capital_owner IN SCHEMA investment_ledger
  REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

-- ─────────────────────────────────────────────────────────────────────────────
-- 7. Assertions. These are the ordering obligations discharged as checks rather
--    than as prose, so a future edit that breaks them fails the migration.
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n FROM pg_views WHERE schemaname = 'investment_ledger';
  IF n <> 9 THEN
    RAISE EXCEPTION 'expected 9 ledger views, found %', n;
  END IF;

  SELECT count(*) INTO n
    FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
   WHERE ns.nspname = 'investment_ledger' AND c.relkind = 'v'
     AND NOT (c.reloptions @> ARRAY['security_invoker=true']);
  IF n <> 0 THEN
    RAISE EXCEPTION '% ledger view(s) are missing security_invoker=true', n;
  END IF;

  SELECT count(*) INTO n
    FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
   WHERE ns.nspname = 'investment_ledger' AND c.relkind = 'r'
     AND c.relname <> 'instruments'
     AND NOT (c.relrowsecurity AND c.relforcerowsecurity);
  IF n <> 0 THEN
    RAISE EXCEPTION '% tenant table(s) lack ENABLE+FORCE row level security', n;
  END IF;

  -- COMPLETE ATTRIBUTION, asserted rather than trusted. Every tenant table
  -- carries workspace_id AND actor_principal_id, both NOT NULL. Stated as a
  -- catalogue query so adding a table without them fails the migration instead
  -- of quietly creating an unattributable audit surface.
  SELECT count(*) INTO n
    FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
   WHERE ns.nspname = 'investment_ledger' AND c.relkind = 'r'
     AND c.relname <> 'instruments'
     AND NOT EXISTS (
       SELECT 1 FROM pg_attribute a
        WHERE a.attrelid = c.oid AND a.attname = 'workspace_id'
          AND a.attnum > 0 AND NOT a.attisdropped AND a.attnotnull);
  IF n <> 0 THEN
    RAISE EXCEPTION '% tenant table(s) lack a NOT NULL workspace_id', n;
  END IF;

  SELECT count(*) INTO n
    FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
   WHERE ns.nspname = 'investment_ledger' AND c.relkind = 'r'
     AND c.relname <> 'instruments'
     AND NOT EXISTS (
       SELECT 1 FROM pg_attribute a
        WHERE a.attrelid = c.oid AND a.attname = 'actor_principal_id'
          AND a.attnum > 0 AND NOT a.attisdropped AND a.attnotnull);
  IF n <> 0 THEN
    RAISE EXCEPTION '% tenant table(s) lack a NOT NULL actor_principal_id', n;
  END IF;

  -- The column is a claim; the foreign key and the trigger are what make it
  -- true. Without the FK the column can name a principal that does not exist;
  -- without the trigger it can name one who did not act.
  SELECT count(*) INTO n
    FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
   WHERE ns.nspname = 'investment_ledger' AND c.relkind = 'r'
     AND c.relname <> 'instruments'
     AND NOT EXISTS (
       SELECT 1
         FROM pg_constraint k
         JOIN pg_attribute a
           ON a.attrelid = c.oid AND a.attnum = ANY (k.conkey)
        WHERE k.conrelid = c.oid AND k.contype = 'f'
          AND k.confrelid = 'identity.principals'::regclass
          AND a.attname = 'actor_principal_id');
  IF n <> 0 THEN
    RAISE EXCEPTION '% tenant table(s) do not key actor_principal_id to identity.principals', n;
  END IF;

  SELECT count(*) INTO n
    FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
   WHERE ns.nspname = 'investment_ledger' AND c.relkind = 'r'
     AND c.relname <> 'instruments'
     AND NOT EXISTS (
       SELECT 1 FROM pg_trigger g
        WHERE g.tgrelid = c.oid AND NOT g.tgisinternal
          AND g.tgname = 'actor_is_authorized');
  IF n <> 0 THEN
    RAISE EXCEPTION '% tenant table(s) have no actor_is_authorized trigger', n;
  END IF;

  -- 016 asserted both append-only guards over the tables that existed then.
  -- `document_blobs` did not, so the pair is re-asserted here over ALL of them.
  SELECT count(*) INTO n
    FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
   WHERE ns.nspname = 'investment_ledger' AND c.relkind = 'r'
     AND NOT (
       EXISTS (SELECT 1 FROM pg_trigger g WHERE g.tgrelid = c.oid
                 AND g.tgname = 'reject_mutation' AND NOT g.tgisinternal)
       AND
       EXISTS (SELECT 1 FROM pg_trigger g WHERE g.tgrelid = c.oid
                 AND g.tgname = 'reject_truncate' AND NOT g.tgisinternal));
  IF n <> 0 THEN
    RAISE EXCEPTION '% ledger table(s) are missing an append-only guard', n;
  END IF;

  -- EXACTLY THREE POLICIES PER TENANT TABLE, ALL NAMING THE IMPORTER.
  -- Catches both a missing policy (default-deny, which reads as "isolation
  -- works" until someone "fixes" the empty result set) and a resurrected agent
  -- policy.
  SELECT count(*) INTO n
    FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
   WHERE ns.nspname = 'investment_ledger' AND c.relkind = 'r'
     AND c.relname <> 'instruments'
     AND (SELECT count(*) FROM pg_policy p WHERE p.polrelid = c.oid) <> 3;
  IF n <> 0 THEN
    RAISE EXCEPTION '% tenant table(s) do not carry exactly three policies', n;
  END IF;

  SELECT count(*) INTO n
    FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid
    JOIN pg_namespace ns ON ns.oid = c.relnamespace
   WHERE ns.nspname = 'investment_ledger'
     AND 'ai_capital_agent'::regrole = ANY (p.polroles);
  IF n <> 0 THEN
    RAISE EXCEPTION '% ledger policy(ies) name ai_capital_agent; it must have none', n;
  END IF;

  -- EVERY POLICY NAMES EXACTLY ONE ROLE, AND THAT ROLE IS THE IMPORTER.
  --
  -- Naming the agent is only the case we happen to have fixed. A policy with
  -- TWO roles, or one naming the app, the operator, the migrator or a role
  -- invented later, would be just as wrong and the previous assertion said
  -- nothing about it. PUBLIC is the sharpest of these: `polroles` for a policy
  -- written without a TO clause contains OID 0, which means EVERY role — so a
  -- dropped `TO ai_capital_importer` would silently open all seventeen tables
  -- to anyone with a table grant.
  SELECT count(*) INTO n
    FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid
    JOIN pg_namespace ns ON ns.oid = c.relnamespace
   WHERE ns.nspname = 'investment_ledger'
     AND (cardinality(p.polroles) <> 1
          OR p.polroles[1] <> 'ai_capital_importer'::regrole);
  IF n <> 0 THEN
    RAISE EXCEPTION
      '% ledger policy(ies) do not name exactly ai_capital_importer (PUBLIC is oid 0)', n;
  END IF;

  -- AUTHORIZATION IS PROVEN BEFORE THE ROW IS COMPARED.
  --
  -- The 2026-09-06 gate found the top-level conjunction
  --     workspace_id = <guc> AND authorize_service_workspace_any(...) IS NOT NULL
  -- silently skipping the throwing authorizer whenever the comparison was
  -- false. Source review cannot catch a regression here on its own — the
  -- policies are built by format() in a loop above — so the SHAPE is asserted
  -- against what the catalogue actually stored.
  --
  -- The test is positional rather than a regex over the whole expression, so
  -- it does not depend on how pg_get_expr happens to indent or parenthesise.
  -- Four landmarks must appear in this order:
  --     CASE ... authorize_service_workspace_any ... THEN ... workspace_id
  --
  -- LOCATING THE ROW COLUMN IS THE SUBTLE PART, and Round 6 got it wrong. A
  -- bare `strpos(e, 'workspace_id')` does not find the column: the deparsed
  -- expression names the GUC first, inside the literal 'app.workspace_id' that
  -- is the authorizer's own argument. That literal sits in the WHEN condition,
  -- so `THEN < workspace_id` was false for the CORRECT policy and this
  -- assertion would have rejected it — failing the migration on a good tree.
  -- (The authorizer's name is not itself a hazard today: it ends
  -- `workspace_any`, not `workspace_id`. It is masked anyway, so a future
  -- rename cannot quietly reintroduce the problem.)
  --
  -- Both non-column occurrences are therefore masked before the column is
  -- located, with replacements of the SAME LENGTH so every offset in the masked
  -- string still lines up with the original — that is what lets the four
  -- positions be compared against each other. Masking by exact name, rather
  -- than skipping occurrences by regex, keeps it obvious which two things are
  -- excluded and why.
  --
  -- `~` and `strpos` are used deliberately in preference to `regexp_instr`,
  -- which would raise this chain's floor to PostgreSQL 15 for a check that
  -- needs nothing newer than 8.x. Nothing else in migrations 001-017 requires
  -- it, and a version floor is not a thing to introduce as a side effect.
  --
  -- Each clause below rejects a specific wrong shape:
  --   * no CASE at all           -> a top-level AND, in either operand order,
  --                                 which is precisely the gate's defect;
  --   * authorizer before CASE   -> the call is outside the CASE;
  --   * column before the
  --     authorizer               -> the row is compared first;
  --   * column before THEN       -> the row is tested in the WHEN condition,
  --                                 so the comparison decides whether the
  --                                 authorizer runs;
  --   * no `workspace_id =` at
  --     a token boundary         -> the branch never compares the row at all.
  SELECT count(*) INTO n
    FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid
    JOIN pg_namespace ns ON ns.oid = c.relnamespace
    CROSS JOIN LATERAL (
      SELECT coalesce(pg_get_expr(p.polqual, p.polrelid),
                      pg_get_expr(p.polwithcheck, p.polrelid)) AS e
    ) x
    CROSS JOIN LATERAL (
      -- Length-preserving masks: 31 characters for the authorizer's name, 16
      -- for the GUC name, matching the text each replaces exactly.
      SELECT replace(replace(x.e,
               'authorize_service_workspace_any',
               'zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz'),
               'app.workspace_id',
               'zzzzzzzzzzzzzzzz') AS masked
    ) k
   WHERE ns.nspname = 'investment_ledger'
     AND NOT (
           -- the masks really are length-preserving; if that ever stops being
           -- true the position comparisons below are meaningless, so it is
           -- checked rather than assumed ...
           length(k.masked) = length(x.e)
           -- ... every landmark is present ...
       AND strpos(x.e, 'CASE') > 0
       AND strpos(x.e, 'THEN') > 0
       AND strpos(x.e, 'authorize_service_workspace_any') > 0
       AND strpos(k.masked, 'workspace_id') > 0
           -- ... the surviving occurrence really is a comparison of the row
           -- column, at a token boundary rather than a substring of something
           -- larger ...
       AND k.masked ~ '(^|[^._[:alnum:]])workspace_id[[:space:]]*='
           -- ... the CASE opens before the authorizer, so the authorizer sits
           -- in the WHEN condition rather than in a branch ...
       AND strpos(x.e, 'CASE') < strpos(x.e, 'authorize_service_workspace_any')
           -- ... the authorizer is proven before the row column is named ...
       AND strpos(x.e, 'authorize_service_workspace_any') < strpos(k.masked, 'workspace_id')
           -- ... and that column lies past a THEN, i.e. in a result branch, not
           -- in the condition that decides whether to authorize.
       AND strpos(x.e, 'THEN') < strpos(k.masked, 'workspace_id'));
  IF n <> 0 THEN
    RAISE EXCEPTION
      '% ledger policy(ies) can short-circuit past authorization: the expression is not a CASE that authorizes before comparing workspace_id', n;
  END IF;

  -- NAME AND COMMAND AGREE, PER TABLE.
  --   importer_read       -> SELECT ('r')
  --   importer_insert     -> INSERT ('a')
  --   importer_lock_only  -> UPDATE ('w')
  -- A policy whose name says one thing and whose polcmd says another is a
  -- reviewer's trap: `importer_lock_only` created FOR ALL would grant real
  -- update authority under a name promising the opposite.
  SELECT count(*) INTO n
    FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid
    JOIN pg_namespace ns ON ns.oid = c.relnamespace
   WHERE ns.nspname = 'investment_ledger'
     AND p.polcmd <> CASE p.polname
                       WHEN 'importer_read'      THEN 'r'
                       WHEN 'importer_insert'    THEN 'a'
                       WHEN 'importer_lock_only' THEN 'w'
                       ELSE '?'
                     END;
  IF n <> 0 THEN
    RAISE EXCEPTION '% ledger policy(ies) have an unexpected name/command pairing', n;
  END IF;

  -- And each tenant table carries all three names — not three policies of one
  -- kind, which the count-of-three check alone would accept.
  SELECT count(*) INTO n
    FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
   WHERE ns.nspname = 'investment_ledger' AND c.relkind = 'r'
     AND c.relname <> 'instruments'
     AND NOT (EXISTS (SELECT 1 FROM pg_policy p
                       WHERE p.polrelid = c.oid AND p.polname = 'importer_read')
          AND EXISTS (SELECT 1 FROM pg_policy p
                       WHERE p.polrelid = c.oid AND p.polname = 'importer_insert')
          AND EXISTS (SELECT 1 FROM pg_policy p
                       WHERE p.polrelid = c.oid AND p.polname = 'importer_lock_only'));
  IF n <> 0 THEN
    RAISE EXCEPTION '% tenant table(s) are missing one of the three named policies', n;
  END IF;

  -- NO POLICY MAY COMPARE A WORKSPACE TO THE AUTHORIZER'S RETURN VALUE.
  -- That was the defect the database gate found: the function returns the
  -- PRINCIPAL id, so `workspace_id = authorize_...(...)` is always false.
  SELECT count(*) INTO n
    FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid
    JOIN pg_namespace ns ON ns.oid = c.relnamespace
   WHERE ns.nspname = 'investment_ledger'
     AND (coalesce(pg_get_expr(p.polqual, p.polrelid), '')
          || coalesce(pg_get_expr(p.polwithcheck, p.polrelid), ''))
         ~ 'workspace_id = identity\.authorize_service_workspace';
  IF n <> 0 THEN
    RAISE EXCEPTION
      '% policy(ies) compare workspace_id to the authorizer''s principal-id return', n;
  END IF;

  -- ai_capital_agent HOLDS NOTHING IN THIS SCHEMA.
  IF has_schema_privilege('ai_capital_agent', 'investment_ledger', 'USAGE') THEN
    RAISE EXCEPTION 'ai_capital_agent still holds USAGE on investment_ledger';
  END IF;
  SELECT count(*) INTO n
    FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
   WHERE ns.nspname = 'investment_ledger' AND c.relkind IN ('r','v')
     AND (has_table_privilege('ai_capital_agent', c.oid, 'SELECT')
       OR has_table_privilege('ai_capital_agent', c.oid, 'INSERT')
       OR has_table_privilege('ai_capital_agent', c.oid, 'UPDATE')
       OR has_table_privilege('ai_capital_agent', c.oid, 'DELETE'));
  IF n <> 0 THEN
    RAISE EXCEPTION 'ai_capital_agent holds privileges on % ledger relation(s)', n;
  END IF;

  -- FOUR VIEWS GRANTED TO THE IMPORTER, FIVE GRANTED TO NOBODY.
  SELECT count(*) INTO n
    FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
   WHERE ns.nspname = 'investment_ledger' AND c.relkind = 'v'
     AND has_table_privilege('ai_capital_importer', c.oid, 'SELECT');
  IF n <> 4 THEN
    RAISE EXCEPTION 'expected the importer to read exactly 4 views, found %', n;
  END IF;

  -- The withheld five must be readable by no runtime role at all.
  SELECT count(*) INTO n
    FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace,
         LATERAL (VALUES ('ai_capital_importer'),('ai_capital_agent'),
                         ('ai_capital_app'),('ai_capital_operator'),
                         ('ai_capital_migrator')) AS r(rolname)
   WHERE ns.nspname = 'investment_ledger' AND c.relkind = 'v'
     AND c.relname IN ('current_transactions','economic_amount_components',
                       'effective_accounts','transaction_effective_accounts',
                       'current_document_verification')
     AND has_table_privilege(r.rolname, c.oid, 'SELECT');
  IF n <> 0 THEN
    RAISE EXCEPTION '% withheld view grant(s) exist', n;
  END IF;

  -- The definer function's schema access, checked at the moment it is created
  -- rather than discovered at the first call after lockdown.
  IF NOT has_schema_privilege('ai_capital_identity_authority',
                              'investment_ledger', 'USAGE') THEN
    RAISE EXCEPTION
      'the identity authority holds no USAGE on investment_ledger, so '
      'resolve_or_create_instrument could be created but never executed';
  END IF;
END $$;
