-- Phase 3.3: dependency-graph-engine schema
-- Mirrors apps/dependency-graph-engine/data/graph.db.

CREATE SCHEMA IF NOT EXISTS graph;

CREATE TABLE IF NOT EXISTS graph.nodes (
  ticker   TEXT NOT NULL PRIMARY KEY,
  company  TEXT NOT NULL,
  themes   TEXT NOT NULL                                -- JSON array kept as TEXT
);

CREATE TABLE IF NOT EXISTS graph.edges (
  id                TEXT        PRIMARY KEY,
  from_ticker       TEXT        NOT NULL REFERENCES graph.nodes(ticker) ON DELETE CASCADE,
  to_ticker         TEXT        NOT NULL REFERENCES graph.nodes(ticker) ON DELETE CASCADE,
  rel_type          TEXT        NOT NULL,
  strength          TEXT        NOT NULL,
  description       TEXT        NOT NULL,
  status            TEXT        NOT NULL,
  source_chunk_ids  TEXT        NOT NULL,               -- JSON array kept as TEXT
  evidence_quote    TEXT,
  created_at        TIMESTAMPTZ NOT NULL,
  updated_at        TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_graph_edges_from
  ON graph.edges(from_ticker, status);
CREATE INDEX IF NOT EXISTS idx_graph_edges_to
  ON graph.edges(to_ticker, status);

CREATE TABLE IF NOT EXISTS graph.proposals (
  id                TEXT        PRIMARY KEY,
  status            TEXT        NOT NULL,
  claude_reasoning  TEXT        NOT NULL,
  chunk_ids_used    TEXT        NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL,
  resolved_at       TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS graph.proposal_edges (
  id              TEXT     PRIMARY KEY,
  proposal_id     TEXT     NOT NULL REFERENCES graph.proposals(id) ON DELETE CASCADE,
  from_ticker     TEXT     NOT NULL,
  to_ticker       TEXT     NOT NULL,
  rel_type        TEXT     NOT NULL,
  strength        TEXT     NOT NULL,
  description     TEXT     NOT NULL,
  evidence_quote  TEXT,
  approved        BOOLEAN
);

CREATE INDEX IF NOT EXISTS idx_graph_proposal_edges_proposal
  ON graph.proposal_edges(proposal_id);
