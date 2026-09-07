-- Investment ledger Phase 1 remediation.
-- Adds append-only account resolution, database-enforced correction integrity,
-- serialized reconciliation transitions, and honest document/extraction status.
-- 011 is already applied and is never edited; everything here is additive.

-- ─────────────────────────────────────────────────────────────────────────────
-- F2: append-only account resolution.
--
-- The 29 placeholder accounts could never be resolved: accounts reject UPDATE
-- and DELETE, and nothing else existed. Resolution is therefore modelled as an
-- APPEND-ONLY chain of its own. Nothing rewrites a historical transaction; the
-- effective account is PROJECTED.
--
-- "Active" is derived, never stored, so supersession needs no UPDATE: a later
-- row names the row it supersedes, and a row with no successor is active.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE investment_ledger.account_resolutions (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id           UUID NOT NULL REFERENCES identity.workspaces(id),
  placeholder_account_id UUID NOT NULL,
  resolved_account_id    UUID,
  resolution_kind        TEXT NOT NULL CHECK (resolution_kind IN ('resolve','retract')),
  -- SELF-LINK, WORKSPACE-SCOPED. Bound by the composite foreign key below, not
  -- by a column-level `REFERENCES ... (id)`: an id-only self-reference lets a
  -- principal authorized in BOTH workspaces supersede another tenant's
  -- resolution. The child row's own tenancy is correct in that case, so RLS is
  -- satisfied and only the key refuses it. The single-successor rule is
  -- likewise workspace-scoped, below.
  supersedes_id          UUID,
  actor_principal_id     UUID NOT NULL REFERENCES identity.principals(id),
  reason                 TEXT NOT NULL CHECK (length(trim(reason)) > 0),
  evidence               JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- A resolve names a target; a retract cancels and names none.
  CHECK ((resolution_kind = 'resolve') = (resolved_account_id IS NOT NULL)),
  -- No self-resolution.
  CHECK (resolved_account_id IS NULL OR resolved_account_id <> placeholder_account_id),
  -- A retract exists only to cancel something.
  CHECK (resolution_kind = 'resolve' OR supersedes_id IS NOT NULL),
  CHECK (id <> supersedes_id),
  UNIQUE (workspace_id, id),
  -- LINEAR CHAIN: at most one successor per superseded resolution. Scoped by
  -- workspace to match the composite key — a bare `UNIQUE` on supersedes_id
  -- would also be correct here, but it would enforce the rule across tenants,
  -- which is a cross-workspace fact this schema must not assert.
  UNIQUE (workspace_id, supersedes_id),
  FOREIGN KEY (workspace_id, placeholder_account_id)
    REFERENCES investment_ledger.accounts (workspace_id, id),
  FOREIGN KEY (workspace_id, resolved_account_id)
    REFERENCES investment_ledger.accounts (workspace_id, id),
  FOREIGN KEY (workspace_id, supersedes_id)
    REFERENCES investment_ledger.account_resolutions (workspace_id, id)
);

CREATE INDEX idx_account_resolutions_placeholder
  ON investment_ledger.account_resolutions(placeholder_account_id, id);

-- A resolution is ACTIVE when nothing supersedes it.

CREATE FUNCTION investment_ledger.validate_account_resolution()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  superseded    investment_ledger.account_resolutions%ROWTYPE;
  active_count  INTEGER;
  cycle_found   BOOLEAN;
BEGIN
  -- Serialize per placeholder so two writers cannot both believe they are the
  -- first active resolution.
  PERFORM 1 FROM investment_ledger.accounts
    WHERE id = NEW.placeholder_account_id FOR UPDATE;

  IF NEW.supersedes_id IS NOT NULL THEN
    SELECT * INTO superseded FROM investment_ledger.account_resolutions
      WHERE id = NEW.supersedes_id AND workspace_id = NEW.workspace_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'superseded resolution % does not exist', NEW.supersedes_id;
    END IF;
    IF superseded.placeholder_account_id <> NEW.placeholder_account_id THEN
      RAISE EXCEPTION 'a resolution may only supersede one for the same placeholder account';
    END IF;
    IF EXISTS (SELECT 1 FROM investment_ledger.account_resolutions
                WHERE supersedes_id = NEW.supersedes_id
                  AND workspace_id = NEW.workspace_id) THEN
      RAISE EXCEPTION 'resolution % has already been superseded', NEW.supersedes_id;
    END IF;
  END IF;

  -- At most one ACTIVE resolution per placeholder. A new row either supersedes
  -- the current active one or there must be none.
  SELECT count(*) INTO active_count
    FROM investment_ledger.active_account_resolutions
   WHERE placeholder_account_id = NEW.placeholder_account_id
     AND (NEW.supersedes_id IS NULL OR id <> NEW.supersedes_id);
  IF active_count > 0 THEN
    RAISE EXCEPTION
      'placeholder account % already has an active resolution; supersede it explicitly',
      NEW.placeholder_account_id;
  END IF;

  -- Cycle prevention across the whole active chain.
  IF NEW.resolution_kind = 'resolve' THEN
    WITH RECURSIVE walk(account_id, depth) AS (
      SELECT NEW.resolved_account_id, 0
      UNION ALL
      SELECT r.resolved_account_id, w.depth + 1
        FROM walk w
        JOIN investment_ledger.active_account_resolutions r
          ON r.placeholder_account_id = w.account_id
         AND r.resolution_kind = 'resolve'
       WHERE w.depth < 32
    )
    SELECT EXISTS (SELECT 1 FROM walk WHERE account_id = NEW.placeholder_account_id)
      INTO cycle_found;
    IF cycle_found THEN
      RAISE EXCEPTION 'account resolution would create a cycle for placeholder %',
        NEW.placeholder_account_id;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER validate_account_resolution
BEFORE INSERT ON investment_ledger.account_resolutions
FOR EACH ROW EXECUTE FUNCTION investment_ledger.validate_account_resolution();

CREATE TRIGGER reject_mutation
BEFORE UPDATE OR DELETE ON investment_ledger.account_resolutions
FOR EACH ROW EXECUTE FUNCTION investment_ledger.reject_economic_mutation();

-- Authoritative projection: every account to the account it now stands for.

-- Authoritative per-transaction projection. Historical rows are untouched.

-- ─────────────────────────────────────────────────────────────────────────────
-- F5: correction integrity, enforced by the database.
--
-- 011 labelled reversal/replacement rows but enforced none of the semantics.
-- Validation is DEFERRED to commit because a correction group is only coherent
-- once every member and its amount components exist.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE FUNCTION investment_ledger.validate_correction_group(group_id UUID)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  originals   INTEGER;
  original_id UUID;
  reversals   INTEGER;
  bad_target  INTEGER;
  mismatch    INTEGER;
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

  -- No mixed correction targets.
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

  -- Every reversal must be the exact economic inverse of the original.
  SELECT count(*) INTO mismatch
    FROM investment_ledger.transactions rev
    JOIN LATERAL (
      SELECT count(*) AS bad FROM (
        SELECT o.component_type, o.currency, o.amount AS original_amount, r.amount AS reversal_amount
          FROM investment_ledger.transaction_amount_components o
          FULL OUTER JOIN investment_ledger.transaction_amount_components r
            ON r.transaction_id = rev.id
           AND r.component_type = o.component_type
           AND r.currency       = o.currency
           AND r.representation_kind = o.representation_kind
         WHERE o.transaction_id = original_id
           AND o.counting_role = 'economic'
      ) pairs
      WHERE reversal_amount IS NULL OR original_amount IS NULL
         OR reversal_amount <> -original_amount
    ) checked ON true
   WHERE rev.transaction_group_id = group_id
     AND rev.correction_role = 'reversal'
     AND checked.bad > 0;
  IF mismatch > 0 THEN
    RAISE EXCEPTION
      'correction group %: reversal economic components are not the inverse of the original',
      group_id;
  END IF;
END;
$$;

CREATE FUNCTION investment_ledger.enforce_correction_integrity()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE gid UUID;
BEGIN
  IF TG_TABLE_NAME = 'transactions' THEN
    gid := NEW.transaction_group_id;
  ELSE
    SELECT transaction_group_id INTO gid FROM investment_ledger.transactions
     WHERE id = NEW.transaction_id;
  END IF;
  IF gid IS NULL THEN RETURN NULL; END IF;
  IF NOT EXISTS (SELECT 1 FROM investment_ledger.transaction_groups
                  WHERE id = gid AND group_type = 'correction') THEN
    RETURN NULL;
  END IF;
  PERFORM investment_ledger.validate_correction_group(gid);
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER enforce_correction_integrity_tx
AFTER INSERT ON investment_ledger.transactions
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION investment_ledger.enforce_correction_integrity();

CREATE CONSTRAINT TRIGGER enforce_correction_integrity_amounts
AFTER INSERT ON investment_ledger.transaction_amount_components
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION investment_ledger.enforce_correction_integrity();

-- Corrections now have defined projection behaviour: a corrected original and
-- its reversals drop out of the current view; replacements remain.

-- ─────────────────────────────────────────────────────────────────────────────
-- F6: serialize reconciliation transitions per case.
-- The prior trigger read current state without locking, so two writers could
-- both observe the same prior state and both succeed.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION investment_ledger.validate_reconciliation_event()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE prior_state TEXT; locked UUID;
BEGIN
  SELECT id INTO locked FROM investment_ledger.reconciliation_cases
   WHERE id = NEW.case_id FOR UPDATE;
  IF locked IS NULL THEN
    RAISE EXCEPTION 'reconciliation case % does not exist', NEW.case_id;
  END IF;

  SELECT state INTO prior_state
    FROM investment_ledger.reconciliation_case_current_state
   WHERE case_id = NEW.case_id;
  IF prior_state IS NULL AND NEW.event_type <> 'OPEN' THEN
    RAISE EXCEPTION 'first reconciliation event must be OPEN';
  ELSIF prior_state = 'open' AND NEW.event_type NOT IN ('MATCH','FLAG_MISMATCH','REQUEST_REVIEW','RESOLVE','DISMISS') THEN
    RAISE EXCEPTION 'illegal reconciliation transition from open via %', NEW.event_type;
  ELSIF prior_state = 'matched' AND NEW.event_type NOT IN ('REOPEN','RESOLVE') THEN
    RAISE EXCEPTION 'illegal reconciliation transition from matched via %', NEW.event_type;
  ELSIF prior_state IN ('mismatch','review') AND NEW.event_type NOT IN ('MATCH','RESOLVE','DISMISS') THEN
    RAISE EXCEPTION 'illegal reconciliation transition from % via %', prior_state, NEW.event_type;
  ELSIF prior_state IN ('resolved','dismissed') AND NEW.event_type <> 'REOPEN' THEN
    RAISE EXCEPTION 'closed reconciliation case requires REOPEN';
  END IF;
  RETURN NEW;
END;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- F7: document and extraction truth.
-- A path alone never implies a verified document identity, and an extraction
-- that could not be parsed must be sayable.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE investment_ledger.document_file_variants
  ADD COLUMN verification_status TEXT NOT NULL DEFAULT 'unverified'
    CHECK (verification_status IN ('unverified','verified')),
  ADD CONSTRAINT document_variant_verified_requires_checksum
    CHECK (verification_status = 'unverified' OR content_sha256 IS NOT NULL);

COMMENT ON COLUMN investment_ledger.document_file_variants.verification_status IS
  'unverified means only a path was observed: content identity is DEFERRED until a checksum is recorded. Phase 1 records no PDF checksums.';

ALTER TABLE investment_ledger.document_extractions
  ADD COLUMN extraction_outcome TEXT NOT NULL DEFAULT 'parsed'
    CHECK (extraction_outcome IN ('parsed','unparseable'));

ALTER TABLE investment_ledger.reconciliation_cases
  DROP CONSTRAINT reconciliation_cases_case_type_check;
ALTER TABLE investment_ledger.reconciliation_cases
  ADD CONSTRAINT reconciliation_cases_case_type_check
    CHECK (case_type IN ('missing_manual','missing_document','field_mismatch','duplicate_document',
                         'duplicate_transaction','low_confidence','changed_archive','unparseable'));

-- ─────────────────────────────────────────────────────────────────────────────
-- F8: remove the unreachable batch status.
-- import_batches rejects UPDATE, so a row could never move to 'superseded'.
-- Supersession is expressed by changed_from_batch on the SUCCESSOR row.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE investment_ledger.import_batches
  DROP CONSTRAINT import_batches_status_check;
ALTER TABLE investment_ledger.import_batches
  ADD CONSTRAINT import_batches_status_check CHECK (status = 'published');

COMMENT ON COLUMN investment_ledger.import_batches.status IS
  'Always published: the table rejects UPDATE, so no row can ever be transitioned. A later batch points back with changed_from_batch.';
