-- Investment ledger Phase 1, remediation round 2.
--
-- 011 and 012 are already applied and are never edited; everything here is
-- additive or a CREATE OR REPLACE of a view/function they defined.
--
-- Four findings are closed here:
--   F1  archive-series identity: an unrelated CSV could supersede the master.
--   F2  correction rows could sit in a switch/multi_fill group and escape every
--       correction check.
--   F3  the reversal-inverse check discarded components present only on the
--       reversal, so an extra reversal component passed as "exact inverse".
--   F6  a path-only document observation could never become verified, because
--       the table rejects UPDATE and uniqueness blocked a second observation.

-- ═════════════════════════════════════════════════════════════════════════════
-- F1. Archive series identity.
--
-- THE DEFECT. `publishArchive` chose the batch to supersede as "the most recent
-- archive_csv batch", ignoring which FILE it came from, and wrote it into
-- `changed_from_batch`. `current_transactions` then dropped every row of the
-- superseded batch. Publishing a 6-row fixture, a partial broker export or an
-- unrelated CSV therefore made the entire 621-row master archive disappear from
-- the authoritative projection. This was observed live in ai_capital_test: the
-- master batch returned 0 of 621 rows because a `fixture.csv` import had become
-- its successor.
--
-- THE FIX. Every batch names the SERIES it belongs to. Supersession is only
-- meaningful inside one series, and the projection keeps the head of every
-- series independently.
-- ═════════════════════════════════════════════════════════════════════════════

-- Added with a default so the fast path applies and no row is rewritten (the
-- table rejects UPDATE, so a rewrite is not available anyway). Pre-existing
-- rows predate series identity and are honestly labelled as such rather than
-- being retro-assigned to a series they were never published under.
ALTER TABLE investment_ledger.import_batches
  ADD COLUMN series_key TEXT NOT NULL DEFAULT 'legacy:unclassified';

ALTER TABLE investment_ledger.import_batches
  ADD CONSTRAINT import_batches_series_key_format
    CHECK (series_key ~ '^[a-z0-9][a-z0-9_-]*:[a-z0-9][a-z0-9_.-]*$');

-- Fail closed: from here on every INSERT must name its series explicitly.
-- Dropping the default does not disturb the value already recorded for
-- pre-existing rows, which is stored separately from the column default.
ALTER TABLE investment_ledger.import_batches
  ALTER COLUMN series_key DROP DEFAULT;

-- Exact-rerun identity is (series, kind, bytes). The same bytes published into
-- a different series is a different fact, not a re-run of this one.
--
-- THE NAME IS THE ONE 013 ACTUALLY GENERATES. 013 declares
-- `UNIQUE (workspace_id, source_kind, source_sha256)`, and PostgreSQL names an
-- unnamed table constraint <table>_<column>_..._key — so adding workspace_id
-- during the tenancy rewrite renamed it from
-- import_batches_source_kind_source_sha256_key to the name below. This DROP
-- still carried the pre-tenancy spelling, so migration 015 failed on every
-- fresh database with:
--
--     constraint "import_batches_source_kind_source_sha256_key" of relation
--     "import_batches" does not exist
--
-- The static suite could not see it: nothing tied a DROP CONSTRAINT to the
-- UNIQUE declaration that generates its name. tests/unit/migration-order.test.ts
-- now derives the expected name from 013's own declaration.
ALTER TABLE investment_ledger.import_batches
  DROP CONSTRAINT import_batches_workspace_id_source_kind_source_sha256_key;
ALTER TABLE investment_ledger.import_batches
  ADD CONSTRAINT import_batches_series_source_unique
    -- Workspace-scoped: the same archive imported by another operator is a
    -- different fact, not an idempotent re-run of this one.
    UNIQUE (workspace_id, series_key, source_kind, source_sha256);

-- A batch may be superseded at most once, so a series is a linear chain with a
-- single head rather than a fork with an ambiguous "latest".
ALTER TABLE investment_ledger.import_batches
  ADD CONSTRAINT import_batches_single_successor
    UNIQUE (workspace_id, changed_from_batch);

ALTER TABLE investment_ledger.import_batches
  ADD CONSTRAINT import_batches_no_self_supersession
    CHECK (changed_from_batch IS NULL OR changed_from_batch <> id);

-- Cross-row, so a CHECK cannot express it.
CREATE FUNCTION investment_ledger.enforce_batch_series_link()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE prior_series TEXT;
BEGIN
  IF NEW.changed_from_batch IS NULL THEN RETURN NEW; END IF;
  SELECT series_key INTO prior_series
    FROM investment_ledger.import_batches
   WHERE id = NEW.changed_from_batch AND workspace_id = NEW.workspace_id;
  IF prior_series IS NULL THEN
    RAISE EXCEPTION 'superseded batch % does not exist', NEW.changed_from_batch;
  END IF;
  IF prior_series <> NEW.series_key THEN
    RAISE EXCEPTION
      'a batch in series % may not supersede a batch in series %: supersession is only defined within one series',
      NEW.series_key, prior_series;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER enforce_batch_series_link
BEFORE INSERT ON investment_ledger.import_batches
FOR EACH ROW EXECUTE FUNCTION investment_ledger.enforce_batch_series_link();

COMMENT ON COLUMN investment_ledger.import_batches.series_key IS
  'Stable dataset identity, namespace:name (e.g. archive:master). Supersession, '
  'exact-rerun identity and the current projection are all scoped to it. '
  '"legacy:unclassified" marks rows imported before series identity existed.';

-- The head of every series: the one batch nothing in that series supersedes.
-- Series are independent, so an unrelated import can never hide another series.

-- Same correction semantics as 012; the batch test is now series-scoped and
-- expressed positively against the per-series head.

-- ═════════════════════════════════════════════════════════════════════════════
-- F2. A correction may only live in a correction group.
--
-- 011 required `correction_role IS NOT NULL -> transaction_group_id IS NOT NULL`
-- but never constrained the group's TYPE, and 012's enforcement returns early
-- unless the group is `group_type = 'correction'`. A reversal parked in a
-- `switch` or `multi_fill` group therefore escaped every correction check while
-- `current_transactions` still dropped its target.
-- ═════════════════════════════════════════════════════════════════════════════

CREATE FUNCTION investment_ledger.enforce_correction_group_type()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE actual_type TEXT;
BEGIN
  IF NEW.correction_role IS NULL AND NEW.correction_of_id IS NULL THEN
    RETURN NEW;
  END IF;
  IF NEW.transaction_group_id IS NULL THEN
    RAISE EXCEPTION 'a correction transaction must belong to a correction group';
  END IF;
  SELECT group_type INTO actual_type FROM investment_ledger.transaction_groups
   WHERE id = NEW.transaction_group_id;
  IF actual_type IS DISTINCT FROM 'correction' THEN
    RAISE EXCEPTION
      'correction_role/correction_of_id require a transaction group of type correction, got %',
      COALESCE(actual_type, '(missing group)');
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER enforce_correction_group_type
BEFORE INSERT ON investment_ledger.transactions
FOR EACH ROW EXECUTE FUNCTION investment_ledger.enforce_correction_group_type();

-- ═════════════════════════════════════════════════════════════════════════════
-- F3. Exact economic equality in BOTH directions.
--
-- 012 wrote `... FULL OUTER JOIN r ON ... WHERE o.transaction_id = original_id`.
-- The WHERE applies after the join, so every row contributed only by the
-- reversal side was discarded and the join degenerated to a left join from the
-- original. A reversal carrying an economic component the original does not
-- have — an extra fee, a second currency — passed as "the exact inverse".
--
-- Each side is now reduced to its own economic component set FIRST, then joined
-- on the full identity (component_type, currency, representation_kind), so a
-- component missing on either side survives the join as a NULL and is caught.
-- counting_role is part of each side's filter, so a component demoted to
-- 'informational' on the reversal reads as missing, which is what it is.
-- ═════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION investment_ledger.validate_correction_group(group_id UUID)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  originals   INTEGER;
  original_id UUID;
  reversals   INTEGER;
  bad_target  INTEGER;
  components  INTEGER;
  rev         RECORD;
  bad         INTEGER;
  detail      TEXT;
BEGIN
  SELECT count(*) FILTER (WHERE correction_of_id IS NULL)
    INTO originals
    FROM investment_ledger.transactions WHERE transaction_group_id = group_id;
  IF originals <> 1 THEN
    RAISE EXCEPTION 'correction group % must contain exactly one original transaction, found %',
      group_id, originals;
  END IF;

  SELECT id INTO original_id FROM investment_ledger.transactions
   WHERE transaction_group_id = group_id AND correction_of_id IS NULL;

  SELECT count(*) INTO bad_target FROM investment_ledger.transactions
   WHERE transaction_group_id = group_id
     AND correction_of_id IS NOT NULL
     AND correction_of_id <> original_id;
  IF bad_target > 0 THEN
    RAISE EXCEPTION 'correction group % mixes correction targets', group_id;
  END IF;

  SELECT count(*) INTO reversals FROM investment_ledger.transactions
   WHERE transaction_group_id = group_id AND correction_role = 'reversal';
  IF reversals < 1 THEN
    RAISE EXCEPTION 'correction group % must contain at least one reversal', group_id;
  END IF;

  -- An original with no economic components would make every inverse check
  -- vacuously true, so the check refuses to be satisfied by absence.
  SELECT count(*) INTO components
    FROM investment_ledger.transaction_amount_components
   WHERE transaction_id = original_id AND counting_role = 'economic';
  IF components < 1 THEN
    RAISE EXCEPTION
      'correction group %: the original transaction has no economic amount components to reverse',
      group_id;
  END IF;

  FOR rev IN
    SELECT id FROM investment_ledger.transactions
     WHERE transaction_group_id = group_id AND correction_role = 'reversal'
  LOOP
    SELECT count(*), string_agg(problem, '; ' ORDER BY problem)
      INTO bad, detail
      FROM (
        SELECT
          CASE
            WHEN pair.original_amount IS NULL THEN
              format('reversal has an extra %s component in %s/%s',
                     pair.component_type, pair.currency, pair.representation_kind)
            WHEN pair.reversal_amount IS NULL THEN
              format('reversal is missing the %s component in %s/%s',
                     pair.component_type, pair.currency, pair.representation_kind)
            ELSE
              format('%s in %s/%s is %s, expected %s',
                     pair.component_type, pair.currency, pair.representation_kind,
                     pair.reversal_amount, -pair.original_amount)
          END AS problem
        FROM (
          SELECT component_type, currency, representation_kind,
                 o.amount AS original_amount, r.amount AS reversal_amount
            FROM (
              SELECT component_type, currency, representation_kind, amount
                FROM investment_ledger.transaction_amount_components
               WHERE transaction_id = original_id AND counting_role = 'economic'
            ) o
            FULL OUTER JOIN (
              SELECT component_type, currency, representation_kind, amount
                FROM investment_ledger.transaction_amount_components
               WHERE transaction_id = rev.id AND counting_role = 'economic'
            ) r USING (component_type, currency, representation_kind)
        ) pair
        WHERE pair.original_amount IS NULL
           OR pair.reversal_amount IS NULL
           OR pair.reversal_amount <> -pair.original_amount
      ) problems;

    IF bad > 0 THEN
      RAISE EXCEPTION
        'correction group %: reversal % is not the exact economic inverse of the original (%)',
        group_id, rev.id, detail;
    END IF;
  END LOOP;
END;
$$;

-- ═════════════════════════════════════════════════════════════════════════════
-- F6. Document verification is an append-only observation chain.
--
-- 012 could say `unverified` honestly but could never move on: the table
-- rejects UPDATE and DELETE, `content_sha256` is settable only at INSERT, and
-- UNIQUE (logical_document_id, variant_kind, observed_path) blocked recording a
-- second observation of the same path. Verification is therefore modelled the
-- same way account resolution is: the original observation is preserved, and a
-- later verification is a NEW append-only event that supersedes explicitly.
--
-- Phase 1 still opens, parses, copies and hashes NO archive PDF. This is the
-- shape a separately authorised verification pass will write into; nothing here
-- reads a document.
-- ═════════════════════════════════════════════════════════════════════════════

CREATE TABLE investment_ledger.document_verification_events (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id   UUID NOT NULL REFERENCES identity.workspaces(id),
  variant_id     UUID NOT NULL,
  event_kind     TEXT NOT NULL CHECK (event_kind IN ('verified','failed','retracted')),
  content_sha256 TEXT CHECK (content_sha256 IS NULL OR content_sha256 ~ '^[0-9a-f]{64}$'),
  -- SELF-LINK, WORKSPACE-SCOPED. Bound by the composite foreign key below, not
  -- by a column-level `REFERENCES ... (id)`: an id-only self-reference lets a
  -- principal authorized in BOTH workspaces retract another tenant's
  -- verification event. The child row's own tenancy is correct in that case, so
  -- RLS is satisfied and only the key refuses it.
  supersedes_id  UUID,
  actor_principal_id UUID NOT NULL REFERENCES identity.principals(id),
  reason         TEXT NOT NULL CHECK (length(trim(reason)) > 0),
  evidence       JSONB NOT NULL DEFAULT '{}'::jsonb,
  observed_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- A checksum is exactly what "verified" means; the other kinds assert no
  -- content identity and must not smuggle one in.
  CHECK ((event_kind = 'verified') = (content_sha256 IS NOT NULL)),
  -- A retraction exists only to cancel a previous claim.
  CHECK (event_kind <> 'retracted' OR supersedes_id IS NOT NULL),
  CHECK (id <> supersedes_id),
  UNIQUE (workspace_id, id),
  -- LINEAR CHAIN: at most one successor per superseded event, scoped by
  -- workspace to match the composite key rather than asserting a
  -- cross-tenant fact.
  UNIQUE (workspace_id, supersedes_id),
  FOREIGN KEY (workspace_id, variant_id)
    REFERENCES investment_ledger.document_file_variants (workspace_id, id),
  FOREIGN KEY (workspace_id, supersedes_id)
    REFERENCES investment_ledger.document_verification_events (workspace_id, id)
);

CREATE INDEX idx_document_verification_events_variant
  ON investment_ledger.document_verification_events(variant_id, id);

CREATE TRIGGER reject_mutation
BEFORE UPDATE OR DELETE ON investment_ledger.document_verification_events
FOR EACH ROW EXECUTE FUNCTION investment_ledger.reject_economic_mutation();


CREATE FUNCTION investment_ledger.validate_document_verification_event()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  superseded   investment_ledger.document_verification_events%ROWTYPE;
  active_count INTEGER;
  locked       UUID;
BEGIN
  -- Serialize per variant so two writers cannot both believe they are the
  -- first verification of the same file.
  SELECT id INTO locked FROM investment_ledger.document_file_variants
   WHERE id = NEW.variant_id FOR UPDATE;
  IF locked IS NULL THEN
    RAISE EXCEPTION 'document file variant % does not exist', NEW.variant_id;
  END IF;

  IF NEW.supersedes_id IS NOT NULL THEN
    SELECT * INTO superseded FROM investment_ledger.document_verification_events
      WHERE id = NEW.supersedes_id AND workspace_id = NEW.workspace_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'superseded verification event % does not exist', NEW.supersedes_id;
    END IF;
    IF superseded.variant_id <> NEW.variant_id THEN
      RAISE EXCEPTION 'a verification event may only supersede one for the same variant';
    END IF;
    IF EXISTS (SELECT 1 FROM investment_ledger.document_verification_events
                WHERE supersedes_id = NEW.supersedes_id
                  AND workspace_id = NEW.workspace_id) THEN
      RAISE EXCEPTION 'verification event % has already been superseded', NEW.supersedes_id;
    END IF;
  END IF;

  SELECT count(*) INTO active_count
    FROM investment_ledger.active_document_verification_events
   WHERE variant_id = NEW.variant_id
     AND (NEW.supersedes_id IS NULL OR id <> NEW.supersedes_id);
  IF active_count > 0 THEN
    RAISE EXCEPTION
      'document variant % already has an active verification event; supersede it explicitly',
      NEW.variant_id;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER validate_document_verification_event
BEFORE INSERT ON investment_ledger.document_verification_events
FOR EACH ROW EXECUTE FUNCTION investment_ledger.validate_document_verification_event();

-- The COMMENT ON VIEW for investment_ledger.current_document_verification used
-- to sit here. It has moved to 017, immediately after the CREATE VIEW.
--
-- WHY. The nine views were relocated into 017 so each is defined once, in final
-- form, after every table exists — but this comment was left behind. Unlike a
-- PL/pgSQL function body, which resolves relation names at EXECUTION time,
-- COMMENT ON resolves its target IMMEDIATELY. So 015 failed on every fresh
-- database with:
--
--     relation "investment_ledger.current_document_verification" does not exist
--
-- The COMMENT ON COLUMN below STAYS: `document_file_variants` is created in 013
-- and this is the earliest point at which the column's meaning is settled, so
-- there is no dependency reason to move it. It merely NAMES the view in its
-- text, which resolves nothing.

COMMENT ON COLUMN investment_ledger.document_file_variants.verification_status IS
  'FROZEN at first observation and always "unverified" in Phase 1. Read '
  'investment_ledger.current_document_verification for the authoritative state.';
