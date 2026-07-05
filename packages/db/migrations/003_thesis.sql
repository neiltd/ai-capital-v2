-- Phase 3.3: thesis-memory schema
-- Mirrors apps/thesis-memory/data/thesis.db.
-- App stays on SQLite; this migration prepares Postgres for the per-app
-- store-swap in a follow-up commit.

CREATE SCHEMA IF NOT EXISTS thesis;

CREATE TABLE IF NOT EXISTS thesis.theses (
  id              TEXT        PRIMARY KEY,
  ticker          TEXT        NOT NULL UNIQUE,
  type            TEXT        NOT NULL,
  position_size   TEXT        NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL,
  updated_at      TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS thesis.assumptions (
  id                       TEXT        PRIMARY KEY,
  thesis_id                TEXT        NOT NULL REFERENCES thesis.theses(id) ON DELETE CASCADE,
  label                    TEXT        NOT NULL,
  status                   TEXT        NOT NULL,
  last_evidence_summary    TEXT,
  created_at               TIMESTAMPTZ NOT NULL,
  updated_at               TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_thesis_assumptions_thesis
  ON thesis.assumptions(thesis_id);

CREATE TABLE IF NOT EXISTS thesis.narratives (
  id           TEXT        PRIMARY KEY,
  thesis_id    TEXT        NOT NULL REFERENCES thesis.theses(id) ON DELETE CASCADE,
  content      TEXT        NOT NULL,
  version      INTEGER     NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_thesis_narratives_thesis_version
  ON thesis.narratives(thesis_id, version DESC);

CREATE TABLE IF NOT EXISTS thesis.proposals (
  id                TEXT        PRIMARY KEY,
  thesis_id         TEXT        NOT NULL REFERENCES thesis.theses(id) ON DELETE CASCADE,
  status            TEXT        NOT NULL,
  chunk_ids_used    TEXT        NOT NULL,   -- JSON array kept as TEXT for parity
  claude_reasoning  TEXT        NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL,
  resolved_at       TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_thesis_proposals_thesis_status
  ON thesis.proposals(thesis_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS thesis.proposal_changes (
  id              TEXT     PRIMARY KEY,
  proposal_id     TEXT     NOT NULL REFERENCES thesis.proposals(id) ON DELETE CASCADE,
  change_type     TEXT     NOT NULL,
  assumption_id   TEXT,
  old_value       TEXT     NOT NULL,
  new_value       TEXT     NOT NULL,
  reasoning       TEXT     NOT NULL,
  evidence_quotes TEXT     NOT NULL,
  approved        BOOLEAN
);

CREATE INDEX IF NOT EXISTS idx_thesis_proposal_changes_proposal
  ON thesis.proposal_changes(proposal_id);

CREATE TABLE IF NOT EXISTS thesis.theme_memberships (
  theme_id   TEXT     NOT NULL,
  ticker     TEXT     NOT NULL,
  weight     NUMERIC  NOT NULL,
  PRIMARY KEY (theme_id, ticker)
);

CREATE INDEX IF NOT EXISTS idx_thesis_theme_memberships_ticker
  ON thesis.theme_memberships(ticker);
