-- Investment ledger foundation, Phase 1 — TENANT-AWARE FROM BIRTH.
--
-- Evidence is append-only. Existing portfolio.positions and portfolio.trade_log
-- are deliberately neither referenced nor mutated by this schema.
--
-- EVERY TABLE HERE EXCEPT `instruments` CARRIES `workspace_id` AND
-- `actor_principal_id`, both NOT NULL, both with no DEFAULT. A nullable or
-- defaulted tenancy column is how the first cross-tenant row gets written, so
-- there is deliberately no way to omit it.
--
-- THE ATTRIBUTION HALF IS NOT DECORATIVE. An earlier draft carried
-- `actor_principal_id` on the tables that felt "important" — transactions,
-- batches, documents — and left it off `accounts`, `instrument_aliases`,
-- `raw_import_rows`, `document_file_variants`, `document_extractions` and
-- `transaction_groups`. Those six are exactly where a silent rewrite of history
-- would hide: an account's display name, a security's per-tenant alias and the
-- raw bytes a transaction was derived from all change what the ledger MEANS
-- while leaving the transaction row untouched. Every one of them now names the
-- principal that wrote it, and 017 attaches the trigger that proves the name.
--
-- EVERY RELATIONSHIP BETWEEN TENANT TABLES IS A COMPOSITE FOREIGN KEY on
-- (workspace_id, id). Row-level security is the primary boundary; these keys
-- are the second, independent one — enforced by the planner rather than by a
-- policy, so a mistake in one does not silently disable the other. Each parent
-- therefore carries a redundant-looking UNIQUE (workspace_id, id) purely to be
-- a valid FK target.
--
-- `instruments` is the single GLOBAL table: a canonical security is the same
-- security for everyone. Its per-tenant naming lives in `instrument_aliases`,
-- which IS workspace-owned. Nothing may INSERT into `instruments` directly;
-- 017 installs a constrained function for that.
--
-- Views, row-level security and grants are NOT here. They are defined once, in
-- final form, in 017 — after every table exists.

CREATE SCHEMA IF NOT EXISTS investment_ledger;
CREATE SCHEMA IF NOT EXISTS cash_ledger;

CREATE TABLE investment_ledger.accounts (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id        UUID NOT NULL REFERENCES identity.workspaces(id),
  actor_principal_id  UUID NOT NULL REFERENCES identity.principals(id),
  -- WAS globally unique. `Bualuang:UNRESOLVED_ACCOUNT` is identical for every
  -- operator, so a global key made one placeholder row SHARED between tenants —
  -- record fusion, not merely leakage.
  account_key         TEXT NOT NULL,
  platform            TEXT NOT NULL,
  external_account_id TEXT,
  display_name        TEXT NOT NULL,
  resolution_status   TEXT NOT NULL CHECK (resolution_status IN ('resolved','unresolved')),
  unresolved_reason   TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((resolution_status = 'resolved') = (external_account_id IS NOT NULL)),
  CHECK (resolution_status = 'resolved' OR unresolved_reason IS NOT NULL),
  UNIQUE (workspace_id, account_key),
  UNIQUE (workspace_id, id)
);

CREATE TABLE investment_ledger.instruments (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  canonical_key   TEXT NOT NULL UNIQUE,
  display_name    TEXT NOT NULL,
  instrument_type TEXT NOT NULL CHECK (instrument_type IN ('equity','fund','crypto','fee','unknown')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE investment_ledger.instrument_aliases (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  UUID NOT NULL REFERENCES identity.workspaces(id),
  actor_principal_id UUID NOT NULL REFERENCES identity.principals(id),
  instrument_id UUID NOT NULL REFERENCES investment_ledger.instruments(id),
  platform      TEXT NOT NULL,
  alias         TEXT NOT NULL,
  exchange_key  TEXT NOT NULL DEFAULT '',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, platform, alias, exchange_key),
  UNIQUE (workspace_id, id)
);

CREATE TABLE investment_ledger.import_batches (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id       UUID NOT NULL REFERENCES identity.workspaces(id),
  actor_principal_id UUID NOT NULL REFERENCES identity.principals(id),
  source_kind        TEXT NOT NULL CHECK (source_kind IN ('archive_csv','manual','email_confirmation')),
  source_name        TEXT NOT NULL,
  source_sha256      TEXT NOT NULL CHECK (source_sha256 ~ '^[0-9a-f]{64}$'),
  importer_version   TEXT NOT NULL,
  row_count          INTEGER NOT NULL CHECK (row_count >= 0),
  status             TEXT NOT NULL CHECK (status IN ('published','superseded')),
  -- SELF-LINK, WORKSPACE-SCOPED. The composite foreign key below is what binds
  -- it; there is deliberately no column-level `REFERENCES ... (id)` here,
  -- because an id-only self-reference lets a caller authorized in BOTH
  -- workspaces name another tenant's batch as the superseded one. RLS does not
  -- catch that: the child row's own tenancy is correct, so the policy is
  -- satisfied and only the key can refuse it. Nullable, because the first batch
  -- in a series supersedes nothing.
  changed_from_batch UUID,
  published_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Idempotency is PER WORKSPACE. The same bytes imported by another operator
  -- is a different fact, not a re-run of this one: without the workspace in
  -- this key, B's import silently matched A's batch and was reported as an
  -- idempotent no-op while B then read A's rows.
  UNIQUE (workspace_id, source_kind, source_sha256),
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, changed_from_batch)
    REFERENCES investment_ledger.import_batches (workspace_id, id)
);

CREATE TABLE investment_ledger.raw_import_rows (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES identity.workspaces(id),
  actor_principal_id UUID NOT NULL REFERENCES identity.principals(id),
  batch_id     UUID NOT NULL,
  row_number   INTEGER NOT NULL CHECK (row_number > 1),
  raw_sha256   TEXT NOT NULL CHECK (raw_sha256 ~ '^[0-9a-f]{64}$'),
  raw_payload  JSONB NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, batch_id, row_number),
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, batch_id)
    REFERENCES investment_ledger.import_batches (workspace_id, id)
);

CREATE TABLE investment_ledger.logical_documents (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id   UUID NOT NULL REFERENCES identity.workspaces(id),
  actor_principal_id UUID NOT NULL REFERENCES identity.principals(id),
  platform       TEXT NOT NULL,
  logical_key    TEXT NOT NULL,
  document_type  TEXT NOT NULL,
  source_filename TEXT NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, platform, logical_key),
  UNIQUE (workspace_id, id)
);

CREATE TABLE investment_ledger.document_file_variants (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id        UUID NOT NULL REFERENCES identity.workspaces(id),
  actor_principal_id  UUID NOT NULL REFERENCES identity.principals(id),
  logical_document_id UUID NOT NULL,
  variant_kind        TEXT NOT NULL CHECK (variant_kind IN ('raw_encrypted','unlocked')),
  observed_path       TEXT NOT NULL,
  content_sha256      TEXT CHECK (content_sha256 IS NULL OR content_sha256 ~ '^[0-9a-f]{64}$'),
  observed_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, logical_document_id, variant_kind, observed_path),
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, logical_document_id)
    REFERENCES investment_ledger.logical_documents (workspace_id, id)
);

CREATE TABLE investment_ledger.document_extractions (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id        UUID NOT NULL REFERENCES identity.workspaces(id),
  actor_principal_id  UUID NOT NULL REFERENCES identity.principals(id),
  logical_document_id UUID NOT NULL,
  extraction_version  INTEGER NOT NULL CHECK (extraction_version > 0),
  extractor_name      TEXT NOT NULL,
  extractor_version   TEXT NOT NULL,
  extraction_sha256   TEXT NOT NULL CHECK (extraction_sha256 ~ '^[0-9a-f]{64}$'),
  payload             JSONB NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, logical_document_id, extraction_version),
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, logical_document_id)
    REFERENCES investment_ledger.logical_documents (workspace_id, id)
);

CREATE TABLE investment_ledger.transaction_groups (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES identity.workspaces(id),
  actor_principal_id UUID NOT NULL REFERENCES identity.principals(id),
  group_type  TEXT NOT NULL CHECK (group_type IN ('switch','multi_fill','correction')),
  -- WAS globally unique. The switch key is derived from broker + source
  -- filename, so two operators with a same-named confirmation collided.
  group_key   TEXT NOT NULL,
  description TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, group_key),
  UNIQUE (workspace_id, id)
);

CREATE TABLE investment_ledger.transactions (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id          UUID NOT NULL REFERENCES identity.workspaces(id),
  actor_principal_id    UUID NOT NULL REFERENCES identity.principals(id),
  import_row_id         UUID,
  account_id            UUID NOT NULL,
  instrument_id         UUID NOT NULL REFERENCES investment_ledger.instruments(id),
  transaction_group_id  UUID,
  correction_of_id      UUID,
  correction_role       TEXT CHECK (correction_role IN ('reversal','replacement')),
  occurred_on           DATE NOT NULL,
  transaction_type      TEXT NOT NULL CHECK (transaction_type IN ('BUY','SELL','SUB','RED','SWITCH_IN','SWITCH_OUT','FEE')),
  units                 NUMERIC,
  unit_price            NUMERIC,
  unit_price_currency   TEXT CHECK (unit_price_currency IS NULL OR unit_price_currency ~ '^[A-Z]{3,10}$'),
  broker_reference      TEXT,
  business_fingerprint  TEXT NOT NULL CHECK (business_fingerprint ~ '^[0-9a-f]{64}$'),
  record_source         TEXT NOT NULL CHECK (record_source IN ('archive_csv','manual','email_confirmation')),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((transaction_type = 'FEE') OR units IS NOT NULL),
  CHECK ((unit_price IS NULL) = (unit_price_currency IS NULL)),
  CHECK (correction_of_id IS NULL OR correction_of_id <> id),
  CHECK ((correction_of_id IS NULL) = (correction_role IS NULL)),
  CHECK (correction_role IS NULL OR transaction_group_id IS NOT NULL),
  UNIQUE (workspace_id, import_row_id),
  UNIQUE (workspace_id, id),
  -- Composite foreign keys: a child cannot reference a parent in another
  -- workspace even with row-level security disabled.
  FOREIGN KEY (workspace_id, import_row_id)
    REFERENCES investment_ledger.raw_import_rows (workspace_id, id),
  FOREIGN KEY (workspace_id, account_id)
    REFERENCES investment_ledger.accounts (workspace_id, id),
  FOREIGN KEY (workspace_id, transaction_group_id)
    REFERENCES investment_ledger.transaction_groups (workspace_id, id),
  FOREIGN KEY (workspace_id, correction_of_id)
    REFERENCES investment_ledger.transactions (workspace_id, id)
);

-- Every index leads with workspace_id: every tenant query filters on it first.
CREATE INDEX idx_investment_transactions_business_fingerprint
  ON investment_ledger.transactions(workspace_id, business_fingerprint);
CREATE INDEX idx_investment_transactions_account_date
  ON investment_ledger.transactions(workspace_id, account_id, occurred_on, id);

CREATE TABLE investment_ledger.transaction_amount_components (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id        UUID NOT NULL REFERENCES identity.workspaces(id),
  actor_principal_id  UUID NOT NULL REFERENCES identity.principals(id),
  transaction_id      UUID NOT NULL,
  component_type      TEXT NOT NULL CHECK (component_type IN ('gross','fee','vat','withholding_tax','net','cash_flow')),
  amount              NUMERIC NOT NULL,
  currency            TEXT NOT NULL CHECK (currency ~ '^[A-Z]{3,10}$'),
  representation_kind TEXT NOT NULL CHECK (representation_kind IN ('native','broker_converted')),
  counting_role       TEXT NOT NULL CHECK (counting_role IN ('economic','informational')),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, transaction_id, component_type, currency, representation_kind),
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, transaction_id)
    REFERENCES investment_ledger.transactions (workspace_id, id)
);

CREATE TABLE investment_ledger.transaction_document_links (
  workspace_id       UUID NOT NULL REFERENCES identity.workspaces(id),
  actor_principal_id UUID NOT NULL REFERENCES identity.principals(id),
  transaction_id     UUID NOT NULL,
  logical_document_id UUID NOT NULL,
  link_role          TEXT NOT NULL CHECK (link_role IN ('evidence','correction_evidence')),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, transaction_id, logical_document_id, link_role),
  FOREIGN KEY (workspace_id, transaction_id)
    REFERENCES investment_ledger.transactions (workspace_id, id),
  FOREIGN KEY (workspace_id, logical_document_id)
    REFERENCES investment_ledger.logical_documents (workspace_id, id)
);

CREATE TABLE investment_ledger.validation_findings (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id    UUID NOT NULL REFERENCES identity.workspaces(id),
  actor_principal_id UUID NOT NULL REFERENCES identity.principals(id),
  batch_id        UUID NOT NULL,
  import_row_id   UUID,
  transaction_id  UUID,
  finding_code    TEXT NOT NULL,
  severity        TEXT NOT NULL CHECK (severity IN ('info','warning','error')),
  details         JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, batch_id)
    REFERENCES investment_ledger.import_batches (workspace_id, id),
  FOREIGN KEY (workspace_id, import_row_id)
    REFERENCES investment_ledger.raw_import_rows (workspace_id, id),
  FOREIGN KEY (workspace_id, transaction_id)
    REFERENCES investment_ledger.transactions (workspace_id, id)
);

CREATE INDEX idx_validation_findings_batch
  ON investment_ledger.validation_findings(workspace_id, batch_id);

CREATE TABLE investment_ledger.reconciliation_cases (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id         UUID NOT NULL REFERENCES identity.workspaces(id),
  actor_principal_id   UUID NOT NULL REFERENCES identity.principals(id),
  case_key             TEXT NOT NULL,
  case_type            TEXT NOT NULL CHECK (case_type IN ('missing_manual','missing_document','field_mismatch','duplicate_document','duplicate_transaction','low_confidence','changed_archive')),
  subject_transaction_id UUID,
  opened_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, case_key),
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, subject_transaction_id)
    REFERENCES investment_ledger.transactions (workspace_id, id)
);

CREATE TABLE investment_ledger.reconciliation_case_events (
  -- BIGSERIAL is PRESERVED from V2: correct for a high-volume append-only event
  -- log, and changing it would edit a reviewed migration for no functional
  -- gain. 017 grants USAGE on the resulting sequence to the importer, which is
  -- the only role that may INSERT here.
  id          BIGSERIAL PRIMARY KEY,
  workspace_id UUID NOT NULL REFERENCES identity.workspaces(id),
  case_id     UUID NOT NULL,
  event_type  TEXT NOT NULL CHECK (event_type IN ('OPEN','MATCH','FLAG_MISMATCH','REQUEST_REVIEW','RESOLVE','REOPEN','DISMISS')),
  -- WAS free text. An audit row must name a principal that exists and is
  -- entitled here; 017 attaches the trigger that proves it.
  actor_principal_id UUID NOT NULL REFERENCES identity.principals(id),
  notes       TEXT,
  evidence    JSONB NOT NULL DEFAULT '{}'::jsonb,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, case_id)
    REFERENCES investment_ledger.reconciliation_cases (workspace_id, id)
);

-- ONE index, workspace-leading. An earlier draft of this file created this
-- name TWICE -- once workspace-leading and once (case_id, id) -- which is a
-- hard failure on a fresh apply: the second CREATE INDEX raises 42P07
-- "relation already exists". Every tenant read reaches these rows through an
-- RLS predicate on workspace_id, so the workspace-leading form is also the
-- one the planner actually wants; the (case_id, id) form was strictly worse.
CREATE INDEX idx_reconciliation_case_events_case
  ON investment_ledger.reconciliation_case_events(workspace_id, case_id, id);

-- EXACTLY ONE OPENING EVENT PER CASE.
--
-- Semantically right on its own — a case is opened once and REOPENed
-- thereafter, so a second 'OPEN' was never meaningful — and it is also what
-- makes 017's narrow archive-import rule safe under concurrency. That rule lets
-- a caller holding only `archive-import` author the INITIAL event of a
-- `changed_archive` case; "initial" is tested in a BEFORE INSERT trigger, and
-- two concurrent transactions could both see no prior event. The trigger is the
-- readable rule and this index is the one that cannot lose a race.
CREATE UNIQUE INDEX uq_reconciliation_case_events_open
  ON investment_ledger.reconciliation_case_events(workspace_id, case_id)
  WHERE event_type = 'OPEN';

CREATE FUNCTION investment_ledger.reject_economic_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'investment ledger evidence is append-only: % on %.%', TG_OP, TG_TABLE_SCHEMA, TG_TABLE_NAME;
END;
$$;

DO $$
DECLARE table_name TEXT;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'accounts','instruments','instrument_aliases','import_batches','raw_import_rows',
    'logical_documents','document_file_variants','document_extractions','transaction_groups',
    'transactions','transaction_amount_components','transaction_document_links',
    'validation_findings','reconciliation_cases','reconciliation_case_events'
  ] LOOP
    EXECUTE format(
      'CREATE TRIGGER reject_mutation BEFORE UPDATE OR DELETE ON investment_ledger.%I FOR EACH ROW EXECUTE FUNCTION investment_ledger.reject_economic_mutation()',
      table_name
    );
  END LOOP;
END;
$$;

CREATE FUNCTION investment_ledger.validate_reconciliation_event()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE prior_state TEXT;
BEGIN
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

CREATE TRIGGER validate_reconciliation_event
BEFORE INSERT ON investment_ledger.reconciliation_case_events
FOR EACH ROW EXECUTE FUNCTION investment_ledger.validate_reconciliation_event();

-- Explicit cash-ledger boundary. Phase 1 creates no cash objects: future cash
-- migrations must be additive under this schema and must not overload
-- investment_ledger.transaction_amount_components.
COMMENT ON SCHEMA cash_ledger IS
  'Reserved additive boundary for bank, savings, and broker-cash ledgers; intentionally empty in investment-ledger Phase 1.';

-- Views, row-level security and grants are defined once, in final form, in 017.
