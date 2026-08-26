-- Phase 4.2: claim governance — provenance, capture method, protocol version.
--
-- THE RULE THIS ENCODES:
--   Agents decide and emit structured governance events. Orchestration
--   persists them. No agent receives direct write authority.
--
-- WHY THE NEW COLUMNS EXIST. Warden's review of 008 found that the system as
-- built would probably have MISSED the incident it was created for: verifying
-- or resolving a claim requires the claim row to already exist, and the claim a
-- specialist is least likely to volunteer is the shaky one carrying its own
-- recommendation. On 2026-08-25 both Atlas and Sentinel retracted exactly such
-- a claim under challenge, and neither had declared it.
--
-- So a challenger must be able to record a claim on the claimant's behalf — and
-- that must NEVER be able to masquerade as a voluntary self-declaration. That
-- distinction is the point of claimant / recorded_by / capture_method, and it is
-- enforced by CHECK constraints rather than by convention.

-- `agent` becomes `claimant`: whose claim it is, as distinct from who caused it
-- to be recorded. Safe to rename — the table has never held a row, because
-- nothing was ever wired to write to it.
ALTER TABLE desk.agent_claims RENAME COLUMN agent TO claimant;

ALTER TABLE desk.agent_claims
  -- Who decided this should be on the record. NOT who executed the INSERT —
  -- that is always orchestration, which would make the column uninformative.
  ADD COLUMN recorded_by      TEXT NOT NULL DEFAULT 'unknown',
  ADD COLUMN capture_method   TEXT NOT NULL DEFAULT 'self',
  -- Which version of the claim protocol produced this row. Lets a format change
  -- be detected instead of silently reinterpreting old rows.
  ADD COLUMN protocol_version TEXT NOT NULL DEFAULT 'claim/1';

ALTER TABLE desk.agent_claims ALTER COLUMN recorded_by DROP DEFAULT;

ALTER TABLE desk.agent_claims
  ADD CONSTRAINT agent_claims_capture_method_check CHECK (capture_method IN (
    'self',          -- the claimant volunteered it
    'challenger',    -- someone else surfaced it under challenge (Vizier)
    'orchestrator'   -- captured mechanically from the run, no agent judgement
  )),
  ADD CONSTRAINT agent_claims_protocol_version_check
    CHECK (protocol_version ~ '^claim/[0-9]+$'),

  -- A self-declaration is BY the claimant. Anything else is not self-declared,
  -- whatever it says.
  ADD CONSTRAINT agent_claims_self_capture_is_self CHECK (
    capture_method <> 'self' OR lower(recorded_by) = lower(claimant)
  ),
  -- The load-bearing one: a challenger-captured claim can never look voluntary.
  ADD CONSTRAINT agent_claims_challenger_is_not_claimant CHECK (
    capture_method <> 'challenger' OR lower(recorded_by) <> lower(claimant)
  ),

  -- Mandatory provenance. A reputation record detached from its analytical
  -- context is worse than no record: it looks authoritative and cannot be
  -- audited. At least one durable reference must survive.
  ADD CONSTRAINT agent_claims_provenance_required CHECK (
    source_session IS NOT NULL OR source_artifact IS NOT NULL
  );

CREATE INDEX IF NOT EXISTS idx_desk_agent_claims_capture
  ON desk.agent_claims(capture_method, claimant, asserted_at DESC);

-- ── Immutability now covers the governance columns too ─────────────────────
-- Rewriting who made a claim, or how it was captured, would defeat the entire
-- distinction above.
CREATE OR REPLACE FUNCTION desk.agent_claims_assertion_is_immutable()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.claimant IS DISTINCT FROM OLD.claimant
     OR NEW.recorded_by IS DISTINCT FROM OLD.recorded_by
     OR NEW.capture_method IS DISTINCT FROM OLD.capture_method
     OR NEW.protocol_version IS DISTINCT FROM OLD.protocol_version
     OR NEW.domain IS DISTINCT FROM OLD.domain
     OR NEW.claim IS DISTINCT FROM OLD.claim
     OR NEW.claim_type IS DISTINCT FROM OLD.claim_type
     OR NEW.confidence IS DISTINCT FROM OLD.confidence
     OR NEW.horizon IS DISTINCT FROM OLD.horizon
     OR NEW.invalidation_condition IS DISTINCT FROM OLD.invalidation_condition
     OR NEW.evidence IS DISTINCT FROM OLD.evidence
     OR NEW.asserted_at IS DISTINCT FROM OLD.asserted_at
     OR NEW.source_session IS DISTINCT FROM OLD.source_session
     OR NEW.source_agent_run IS DISTINCT FROM OLD.source_agent_run
     OR NEW.source_artifact IS DISTINCT FROM OLD.source_artifact
     OR NEW.source_context IS DISTINCT FROM OLD.source_context
  THEN
    RAISE EXCEPTION
      'desk.agent_claims: the assertion and its provenance are immutable (claim %). Record a NEW claim with supersedes_claim_id = % instead of editing this one.',
      OLD.id, OLD.id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Verification must remain independent of the CLAIMANT (renamed column).
ALTER TABLE desk.agent_claims DROP CONSTRAINT IF EXISTS agent_claims_independent_verification;
ALTER TABLE desk.agent_claims
  ADD CONSTRAINT agent_claims_independent_verification CHECK (
    verified_by IS NULL OR lower(verified_by) <> lower(claimant)
  );

-- ── Non-emission observability ─────────────────────────────────────────────
-- Strategic non-emission is deliberately MEASURED, not scored: a specialist
-- that logs nothing currently has a spotless record, selection is at its own
-- discretion, and it knows the record is kept. This records the denominator —
-- runs that produced a material recommendation — so under-logging becomes
-- visible without creating a reputation penalty nobody has evidence for yet.
CREATE TABLE IF NOT EXISTS desk.agent_runs (
  id                BIGSERIAL   PRIMARY KEY,
  agent             TEXT        NOT NULL,
  session_id        TEXT,
  run_ref           TEXT,
  task_summary      TEXT,
  -- Did the run actually carry a recommendation or material conclusion?
  material          BOOLEAN     NOT NULL DEFAULT false,
  blocks_detected   INTEGER     NOT NULL DEFAULT 0,
  blocks_parsed     INTEGER     NOT NULL DEFAULT 0,
  claims_persisted  INTEGER     NOT NULL DEFAULT 0,
  parse_errors      TEXT,
  recorded_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_desk_agent_runs_agent
  ON desk.agent_runs(agent, recorded_at DESC);

-- The question the 10–20 run review needs to answer: which agents produce
-- material output and declare nothing?
CREATE OR REPLACE VIEW desk.non_emission AS
  SELECT agent,
         count(*)                                            AS material_runs,
         count(*) FILTER (WHERE claims_persisted = 0)        AS runs_with_no_claim,
         round(100.0 * count(*) FILTER (WHERE claims_persisted = 0) / nullif(count(*), 0), 1)
                                                             AS pct_silent,
         sum(blocks_detected)                                AS blocks_detected,
         sum(claims_persisted)                               AS claims_persisted,
         count(*) FILTER (WHERE parse_errors IS NOT NULL)    AS runs_with_parse_errors
    FROM desk.agent_runs
   WHERE material
   GROUP BY agent
   ORDER BY pct_silent DESC NULLS LAST;
