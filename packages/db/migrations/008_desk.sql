-- Phase 4.1: claim-level specialist memory.
--
-- WHY THIS EXISTS. Specialist agents (Atlas, Cassandra, Ledger, Sentinel) are
-- ephemeral: they start cold, answer, and vanish. Nothing in this monorepo has
-- ever recorded what a named specialist actually claimed. On 2026-08-25 both
-- Atlas and Sentinel retracted, under challenge, the single claim their own
-- recommendation rested on — the most valuable calibration datum the desk has
-- ever produced — and it survived nowhere.
--
-- WHY NOT briefing.predictions. That table's grain is one row per day per
-- briefing, and backtest-runner scores it on price direction alone. That is a
-- different object with a different question. Reusing it would produce exactly
-- the naive accuracy leaderboard this design is required NOT to build.
--
-- GRAIN: one row = one MATERIAL claim by one named specialist. Six load-bearing
-- claims per session beats two hundred observations nobody reads.

CREATE SCHEMA IF NOT EXISTS desk;

CREATE TABLE IF NOT EXISTS desk.agent_claims (
  id                     BIGSERIAL   PRIMARY KEY,

  -- ── ASSERTION ──────────────────────────────────────────────────────────
  -- What the specialist said. IMMUTABLE once written (see the trigger below).
  -- A CLAIM: block means "this specialist asserted this". It does NOT mean
  -- "this is true" — that is what verification is for, and it is a separate
  -- event by a separate party.
  agent                  TEXT        NOT NULL,
  domain                 TEXT        NOT NULL,  -- free slug: 'monetary-liquidity',
                                                -- 'sanctions', 'concentration', ...
                                                -- deliberately not an enum: domains
                                                -- must be discoverable from real data,
                                                -- not fixed before we have any.
  claim                  TEXT        NOT NULL,
  claim_type             TEXT        NOT NULL,
  confidence             TEXT        NOT NULL,
  horizon                TEXT,                  -- '3mo', 'structural', NULL when timeless
  invalidation_condition TEXT,                  -- what the specialist says would prove it wrong
  evidence               TEXT,                  -- what they cited when asserting

  -- ── PROVENANCE ─────────────────────────────────────────────────────────
  -- A future reviewer must be able to answer "where did Atlas actually say
  -- this?". A reputation record detached from its analytical context is worse
  -- than no record, because it looks authoritative and cannot be audited.
  source_session         TEXT,
  source_agent_run       TEXT,
  source_artifact        TEXT,                  -- file path, report, transcript
  source_context         TEXT,                  -- the question being answered
  asserted_at            TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- ── VERIFICATION ───────────────────────────────────────────────────────
  -- Did anyone independently check that the evidence supports the claim?
  -- Distinct from resolution: a claim can be properly supported when made and
  -- still be overtaken by events. That is not an integrity failure.
  verification_status    TEXT        NOT NULL DEFAULT 'unverified',
  verification_evidence  TEXT,
  verified_by            TEXT,
  verified_at            TIMESTAMPTZ,

  -- ── RESOLUTION ─────────────────────────────────────────────────────────
  -- What eventually happened. NULL until enough time or evidence arrives.
  resolution_type        TEXT,
  outcome_evidence       TEXT,
  resolved_at            TIMESTAMPTZ,

  -- ── LINEAGE ────────────────────────────────────────────────────────────
  -- A later claim points BACK at what it replaces. The old row is never
  -- rewritten, so "Atlas changed his mind because new data arrived" stays
  -- distinguishable from "Atlas asserted something unsupported".
  supersedes_claim_id    BIGINT      REFERENCES desk.agent_claims(id),

  CONSTRAINT agent_claims_type_check CHECK (claim_type IN (
    'factual',          -- checkable against a primary source, now
    'interpretation',   -- a reading of agreed evidence
    'forecast',         -- a prediction about the future
    'recommendation',   -- a proposed action
    'risk_warning'      -- a flagged hazard, not necessarily predicted to occur
  )),
  CONSTRAINT agent_claims_confidence_check CHECK (confidence IN ('high','medium','low')),
  CONSTRAINT agent_claims_verification_check CHECK (verification_status IN (
    'unverified',       -- nobody has checked
    'verified',         -- an independent party confirmed the evidence supports it
    'unsupported',      -- checked, and the evidence does NOT support it
    'unverifiable'      -- checked, and no verification path exists
  )),
  CONSTRAINT agent_claims_resolution_check CHECK (resolution_type IS NULL OR resolution_type IN (
    'confirmed',        -- happened as claimed
    'falsified',        -- the predicted outcome did not occur
    'invalidated',      -- the claim's own stated invalidation condition occurred
    'retracted',        -- withdrawn: the original evidence never supported it
    'superseded',       -- replaced by a later claim on new information
    'expired'           -- horizon passed with no determinable outcome
  )),

  -- A specialist may not verify its own claim. Enforced here rather than in a
  -- prompt because "verification must remain independent" is a structural
  -- guarantee, and prompts are advisory.
  CONSTRAINT agent_claims_independent_verification CHECK (
    verified_by IS NULL OR lower(verified_by) <> lower(agent)
  ),
  -- Verification metadata must arrive together with a verdict.
  CONSTRAINT agent_claims_verification_coherent CHECK (
    (verification_status = 'unverified' AND verified_at IS NULL AND verified_by IS NULL)
    OR (verification_status <> 'unverified' AND verified_at IS NOT NULL AND verified_by IS NOT NULL)
  ),
  CONSTRAINT agent_claims_resolution_coherent CHECK (
    (resolution_type IS NULL AND resolved_at IS NULL)
    OR (resolution_type IS NOT NULL AND resolved_at IS NOT NULL)
  ),
  CONSTRAINT agent_claims_no_self_supersede CHECK (
    supersedes_claim_id IS NULL OR supersedes_claim_id <> id
  )
);

-- Calibration is DOMAIN-specific, never agent-wide, so this is the access path
-- that matters: "how has Atlas done on monetary-liquidity claims specifically".
CREATE INDEX IF NOT EXISTS idx_desk_agent_claims_agent_domain
  ON desk.agent_claims(agent, domain, asserted_at DESC);

-- The observation plan needs "what is still outstanding" to be cheap.
CREATE INDEX IF NOT EXISTS idx_desk_agent_claims_open
  ON desk.agent_claims(asserted_at DESC) WHERE resolution_type IS NULL;

CREATE INDEX IF NOT EXISTS idx_desk_agent_claims_supersedes
  ON desk.agent_claims(supersedes_claim_id) WHERE supersedes_claim_id IS NOT NULL;

-- ── History is append-only ────────────────────────────────────────────────
-- The single most important property of this table: an old claim is never
-- silently rewritten into the specialist's newest belief. Updates may only add
-- verification, resolution, or lineage. Changing what was asserted is refused.
CREATE OR REPLACE FUNCTION desk.agent_claims_assertion_is_immutable()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.agent IS DISTINCT FROM OLD.agent
     OR NEW.domain IS DISTINCT FROM OLD.domain
     OR NEW.claim IS DISTINCT FROM OLD.claim
     OR NEW.claim_type IS DISTINCT FROM OLD.claim_type
     OR NEW.confidence IS DISTINCT FROM OLD.confidence
     OR NEW.horizon IS DISTINCT FROM OLD.horizon
     OR NEW.invalidation_condition IS DISTINCT FROM OLD.invalidation_condition
     OR NEW.evidence IS DISTINCT FROM OLD.evidence
     OR NEW.asserted_at IS DISTINCT FROM OLD.asserted_at
  THEN
    RAISE EXCEPTION
      'desk.agent_claims: the assertion is immutable (claim %). Record a NEW claim with supersedes_claim_id = % instead of editing this one.',
      OLD.id, OLD.id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS agent_claims_assertion_immutable ON desk.agent_claims;
CREATE TRIGGER agent_claims_assertion_immutable
  BEFORE UPDATE ON desk.agent_claims
  FOR EACH ROW EXECUTE FUNCTION desk.agent_claims_assertion_is_immutable();

-- Convenience read for the 10–20 run review: what is outstanding, and how long
-- has it been outstanding.
CREATE OR REPLACE VIEW desk.open_claims AS
  SELECT id, agent, domain, claim_type, confidence, horizon,
         verification_status, invalidation_condition,
         asserted_at,
         date_trunc('day', now() - asserted_at) AS open_for
    FROM desk.agent_claims
   WHERE resolution_type IS NULL
   ORDER BY asserted_at DESC;
