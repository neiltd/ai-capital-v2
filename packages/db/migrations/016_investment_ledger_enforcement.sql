-- Investment ledger Phase 1, enforcement.
--
-- 011, 012 and 013 are applied and are never edited. This migration is additive:
-- new triggers, one partial index, one NOT VALID check constraint, and a
-- narrow revoke. It grants nothing and rewrites no row.
--
-- Two database-enforcement gaps survived round 2's independent verification:
--
--   G1  TRUNCATE erased append-only evidence. 011 installs `reject_mutation` as
--       a `BEFORE UPDATE OR DELETE ... FOR EACH ROW` trigger, and row-level
--       triggers DO NOT FIRE FOR TRUNCATE. Reproduced directly: a table
--       carrying only that trigger refuses UPDATE and accepts
--       `TRUNCATE ... CASCADE`, leaving zero rows.
--
--   G2  A series could have several ROOT batches. The single-successor
--       constraint — today 015's `UNIQUE (workspace_id, changed_from_batch)`,
--       spelled `UNIQUE (changed_from_batch)` when this defect was found —
--       forbids two successors for one predecessor, but UNIQUE permits
--       unlimited NULLs, so any number of rows with
--       `changed_from_batch IS NULL` could share one series_key. Only the
--       TypeScript advisory lock prevented it; PostgreSQL did not.
--
-- ═════════════════════════════════════════════════════════════════════════════
-- THREAT MODEL — read this before citing any guarantee below.
--
-- WHAT IS ENFORCED. Ordinary UPDATE, DELETE and TRUNCATE against every ledger
-- table are rejected by TRIGGERS. Triggers fire for every principal, including
-- the table owner and including a superuser, so this is the guarantee that
-- actually holds in every topology.
--
-- WHAT IS NOT ENFORCED, AND MUST NOT BE CLAIMED:
--
--   * A TABLE OWNER can `ALTER TABLE ... DISABLE TRIGGER`, `DROP TRIGGER`, or
--     GRANT any privilege back to itself. No trigger and no ACL constrains the
--     owner of the object.
--
--   * A SUPERUSER bypasses every ACL check. `has_table_privilege` therefore
--     returns true for a superuser whatever the stored ACL says, which makes it
--     useless for proving that anyone is constrained. This file never uses it
--     for a negative claim, and neither should any test.
--
--   * The configured production migration user is `thanapold`
--     (DATABASE_URL=postgres://thanapold@localhost:5432/ai_capital, per
--     CLAUDE.md, scripts/run-alerts.sh and scripts/refresh-prices.sh), the
--     chain runs without SET ROLE, and that principal is reported to be a
--     superuser. On that topology the REVOKE below is INERT and the triggers
--     are the only protection. There are NOT two independent layers in
--     production; saying so would be false.
--
--   * PRODUCTION DEPLOYMENT REMAINS BLOCKED pending a separately approved
--     non-superuser runtime-writer role and grant design. This migration
--     deliberately creates no role and issues no GRANT.
-- ═════════════════════════════════════════════════════════════════════════════

-- ═════════════════════════════════════════════════════════════════════════════
-- G1a. TRUNCATE protection on every append-only table.
--
-- CLASSIFICATION. Every base table in investment_ledger is append-only evidence
-- or append-only history; there is no deliberately mutable reference data.
-- `accounts` and `instruments` look like reference data but are append-only by
-- design — which is exactly why 012 had to add `account_resolutions` as a
-- separate supersession chain instead of updating an account in place.
--
-- WHY EVERY TABLE, NOT JUST THE ROOTS. `TRUNCATE ... CASCADE` follows foreign
-- keys from the truncated table to the tables that REFERENCE it; it does not
-- reach a parent. Truncating an unguarded child therefore succeeds on its own,
-- which was confirmed rather than assumed. Completeness is the protection, so
-- the guard is applied from the catalogue and the migration then asserts that
-- no base table was missed.
--
-- The 011 function is reused deliberately: for a statement trigger TG_OP is
-- 'TRUNCATE', so the message stays in the one shape operators already know.
-- ═════════════════════════════════════════════════════════════════════════════

DO $$
DECLARE table_name TEXT; installed INTEGER := 0;
BEGIN
  FOR table_name IN
    SELECT c.relname
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'investment_ledger' AND c.relkind = 'r'
     ORDER BY c.relname
  LOOP
    EXECUTE format(
      'CREATE TRIGGER reject_truncate BEFORE TRUNCATE ON investment_ledger.%I '
      'FOR EACH STATEMENT EXECUTE FUNCTION investment_ledger.reject_economic_mutation()',
      table_name);
    installed := installed + 1;
  END LOOP;
  RAISE NOTICE 'investment ledger: TRUNCATE guard installed on % tables', installed;
END;
$$;

-- ═════════════════════════════════════════════════════════════════════════════
-- G1b. Remove DELETE and TRUNCATE from principals that have no use for them.
--
-- AUDIT. Every statement the ledger issues against investment_ledger is an
-- INSERT or a SELECT: fourteen INSERT targets and seven SELECT sources across
-- src/ and bin/. Nothing outside tests issues UPDATE, DELETE or TRUNCATE.
--
-- UPDATE IS NEVERTHELESS REQUIRED AND IS NOT REVOKED. PostgreSQL charges every
-- ROW-LOCKING clause to the UPDATE privilege, and the ledger depends on two:
--
--   1. Foreign-key inserts. Inserting into raw_import_rows takes a
--      `FOR KEY SHARE` lock on the referenced import_batches row.
--   2. Serialization. validate_account_resolution, validate_reconciliation_event
--      and validate_document_verification_event each take
--      `SELECT ... FOR UPDATE` on their parent row. Those locks are the entire
--      reason two concurrent writers cannot both win.
--
-- An earlier draft of this migration revoked UPDATE as "surplus authority" and
-- broke both, failing 64 tests. A future non-owner runtime writer must hold
-- SELECT, INSERT and UPDATE for exactly this reason, while direct mutation
-- stays impossible because the triggers reject it.
--
-- SCOPE OF THE REVOKE. PUBLIC and named application roles only. A role that
-- OWNS tables in this schema is skipped, because revoking from an owner is not
-- a constraint — it can re-grant at will — and pretending otherwise is how the
-- previous version produced a claim that was true in the test database and
-- false in production. Roles are matched only if they exist, so the migration
-- is portable to a cluster that provisions a different set.
-- ═════════════════════════════════════════════════════════════════════════════

DO $$
DECLARE role_name TEXT; owns INTEGER;
BEGIN
  EXECUTE 'REVOKE DELETE, TRUNCATE ON ALL TABLES IN SCHEMA investment_ledger FROM PUBLIC';
  RAISE NOTICE 'investment ledger: revoked DELETE/TRUNCATE from PUBLIC';

  -- V3: the runtime role set changed. `ai_capital_importer`, `_app` and
  -- `_operator` are added. `_owner` is deliberately absent: the owner check
  -- below would skip it anyway, and `_identity_authority` holds nothing in
  -- this schema. Roles are matched only if they exist, so this stays
  -- portable to a cluster that provisions a different set.
  FOREACH role_name IN ARRAY ARRAY[
    'ai_capital_agent', 'ai_capital_claim_writer', 'ai_capital_test_runtime',
    'ai_capital_importer', 'ai_capital_app', 'ai_capital_operator'
  ] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
      CONTINUE;
    END IF;
    SELECT count(*) INTO owns
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'investment_ledger' AND c.relkind = 'r'
       AND pg_get_userbyid(c.relowner) = role_name;
    IF owns > 0 THEN
      RAISE NOTICE
        'investment ledger: % owns % table(s) here; skipping revoke, an owner is not ACL-constrained',
        role_name, owns;
      CONTINUE;
    END IF;
    EXECUTE format(
      'REVOKE DELETE, TRUNCATE ON ALL TABLES IN SCHEMA investment_ledger FROM %I', role_name);
    RAISE NOTICE 'investment ledger: revoked DELETE/TRUNCATE from %', role_name;
  END LOOP;
END;
$$;

-- ═════════════════════════════════════════════════════════════════════════════
-- G2. At most one ROOT batch per real series.
--
-- A partial unique index, because the rule is about a subset of rows: a root is
-- a batch with no predecessor, and a series may have exactly one. Together with
-- 015's `import_batches_single_successor` — `UNIQUE (workspace_id,
-- changed_from_batch)`, workspace-scoped like every other tenant key — this
-- makes every real series a single linear chain with a single head, PER
-- WORKSPACE. 013 declares no uniqueness on `changed_from_batch` at all; it
-- carries only the composite foreign key `(workspace_id, changed_from_batch)`
-- into `import_batches (workspace_id, id)`, which is what stops a successor
-- naming a predecessor in another tenant.
--
-- The `legacy:unclassified` batches are residue from before series identity
-- existed. They are deliberately NOT rewritten or deleted — the table is
-- append-only and their history is the audit trail. The reserved key is instead
-- exempted from the index and closed to new inserts, so the residue stays
-- exactly as it is while nothing can ever join it. The exclusion is enforced
-- with NOT VALID so existing rows are exempt by construction rather than by a
-- rule that would have to be weakened for them; NOT VALID still checks every
-- future INSERT.
-- ═════════════════════════════════════════════════════════════════════════════

-- The predicate says BOTH halves of the rule out loud. An earlier draft wrote
-- only `WHERE changed_from_batch IS NULL` while the prose above claimed the
-- reserved key was exempt — so the prose and the executable predicate
-- disagreed, and the index would in fact have rejected a SECOND
-- legacy:unclassified root on a database that already carried the residue the
-- comment says must never be rewritten. The exemption is now executable.
CREATE UNIQUE INDEX import_batches_one_root_per_series
  ON investment_ledger.import_batches (workspace_id, series_key)
  WHERE changed_from_batch IS NULL
    AND series_key <> 'legacy:unclassified';

COMMENT ON INDEX investment_ledger.import_batches_one_root_per_series IS
  'At most one batch with no predecessor per series, so every real series has '
  'exactly one head. legacy:unclassified is exempt IN THE PREDICATE because it '
  'holds pre-series residue that is append-only and must not be rewritten.';

ALTER TABLE investment_ledger.import_batches
  ADD CONSTRAINT import_batches_no_new_legacy_series
    CHECK (series_key <> 'legacy:unclassified') NOT VALID;

COMMENT ON CONSTRAINT import_batches_no_new_legacy_series ON investment_ledger.import_batches IS
  'The reserved pre-series key is closed to new inserts. NOT VALID by design: '
  'the existing residue is exempt and is never rewritten, while every future '
  'INSERT is checked.';

-- ═════════════════════════════════════════════════════════════════════════════
-- Verification. POSITIVE facts only.
--
-- Trigger presence is checked because it is the guarantee that actually holds.
-- The ACL is checked by reading the STORED grants out of relacl, which reports
-- what was written whatever the querying principal is. `has_table_privilege` is
-- deliberately not used: it answers "could this role do it", which is always
-- true for a superuser, so it can neither prove nor disprove a restriction.
-- ═════════════════════════════════════════════════════════════════════════════

DO $$
DECLARE unguarded TEXT;
BEGIN
  SELECT string_agg(c.relname, ', ' ORDER BY c.relname) INTO unguarded
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'investment_ledger' AND c.relkind = 'r'
     AND NOT (
       EXISTS (SELECT 1 FROM pg_trigger g
                WHERE g.tgrelid = c.oid AND g.tgname = 'reject_truncate' AND NOT g.tgisinternal)
       AND
       EXISTS (SELECT 1 FROM pg_trigger g
                WHERE g.tgrelid = c.oid AND g.tgname = 'reject_mutation' AND NOT g.tgisinternal)
     );
  IF unguarded IS NOT NULL THEN
    RAISE EXCEPTION 'investment ledger: mutation/TRUNCATE guard missing on %', unguarded;
  END IF;
  RAISE NOTICE 'investment ledger: every base table carries both guards';
END;
$$;

DO $$
DECLARE leaked TEXT;
BEGIN
  -- EVERY stored DELETE/TRUNCATE entry whose grantee is not that table's owner,
  -- not just the roles the REVOKE above happens to name. The revoke is
  -- deliberately bounded — silently stripping privileges from roles this
  -- migration knows nothing about would be worse than reporting them — but the
  -- CHECK is not, because its whole purpose is to catch a grant nobody expected:
  -- a default privilege, a group role, or a hand-made grant from an earlier
  -- operator. Anything it finds fails the migration closed, so the surprise is
  -- resolved by a human rather than absorbed silently.
  --
  -- Owner entries are excluded because an owner is not constrained by an ACL
  -- and this check does not pretend otherwise. `a.grantee = 0` is PUBLIC, which
  -- is never an owner OID, so PUBLIC is always in scope.
  --
  -- Read from relacl, never has_table_privilege: the latter answers "could this
  -- role do it", which is unconditionally true for a superuser and therefore
  -- cannot express a negative fact about anyone.
  SELECT string_agg(format('%s->%s:%s',
                           c.relname,
                           CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END,
                           a.privilege_type),
                    ', ' ORDER BY c.relname)
    INTO leaked
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    CROSS JOIN LATERAL aclexplode(c.relacl) a
   WHERE n.nspname = 'investment_ledger' AND c.relkind = 'r'
     AND a.privilege_type IN ('DELETE', 'TRUNCATE')
     AND a.grantee <> c.relowner;
  IF leaked IS NOT NULL THEN
    RAISE EXCEPTION
      'investment ledger: an unexpected non-owner principal holds a stored DELETE/TRUNCATE grant: %',
      leaked;
  END IF;
  RAISE NOTICE 'investment ledger: no non-owner principal holds a stored DELETE/TRUNCATE grant';
END;
$$;

-- ═════════════════════════════════════════════════════════════════════════════
-- INTENDED RUNTIME-WRITER GRANT SHAPE — DOCUMENTED, NOT EXECUTED.
--
-- Deploying the ledger to production needs a non-superuser role that owns
-- nothing here. Creating it, and choosing its credential, is a separate
-- decision that has not been approved, so this migration performs none of it.
-- When that design is approved the grants are:
--
--   GRANT USAGE ON SCHEMA investment_ledger TO <writer>;
--   GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA investment_ledger TO <writer>;
--   GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA investment_ledger TO <writer>;
--   -- deliberately NOT granted: DELETE, TRUNCATE, and ownership.
--
-- UPDATE appears there only because PostgreSQL charges row locking to it. The
-- writer still cannot perform an UPDATE, a DELETE or a TRUNCATE: the triggers
-- reject all three, for it and for everyone else.
-- ═════════════════════════════════════════════════════════════════════════════
