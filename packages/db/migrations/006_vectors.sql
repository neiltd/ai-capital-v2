-- Phase 3.3: pgvector schema for capital-ingestion chunks
-- Replaces apps/capital-intelligence-ingestion/data/lancedb/chunks.lance.
-- Field set mirrors the LanceDB schema 1:1 so the migration is a direct
-- column-rename copy (LanceDB `vector` → `embedding`, camelCase → snake_case).
--
-- Vector dimensionality matches Xenova/all-MiniLM-L6-v2: 384-dim float32.

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS capital.chunks (
  id               TEXT         PRIMARY KEY,                 -- uuid from embedder
  ticker           TEXT         NOT NULL,
  company          TEXT         NOT NULL,
  source           TEXT         NOT NULL,                    -- SourceType
  doc_type         TEXT         NOT NULL,                    -- DocType
  section          TEXT         NOT NULL DEFAULT '',          -- e.g. business / risk_factors / mda
  published_date   DATE,
  fiscal_period    TEXT         NOT NULL DEFAULT '',
  url              TEXT,
  chunk_index      INTEGER      NOT NULL,
  parent_doc_id    TEXT         NOT NULL,                    -- maps to LanceDB parentDocId
  content_hash     TEXT         NOT NULL,
  embedding_model  TEXT         NOT NULL,                    -- e.g. Xenova/all-MiniLM-L6-v2
  content          TEXT         NOT NULL,
  embedding        vector(384)  NOT NULL,
  created_at       TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- Dedup helper (mirrors LanceDB's contentHash uniqueness expectation).
CREATE INDEX IF NOT EXISTS idx_capital_chunks_content_hash
  ON capital.chunks(content_hash);

-- Per-ticker filter is the dominant query shape (briefing context loader,
-- people-analyzer, scenario-simulator's discovery filter).
CREATE INDEX IF NOT EXISTS idx_capital_chunks_ticker_date
  ON capital.chunks(ticker, published_date DESC);

-- Parent-doc lookup (used when surfacing all chunks of a given filing).
CREATE INDEX IF NOT EXISTS idx_capital_chunks_parent_doc
  ON capital.chunks(parent_doc_id);

-- HNSW vector index. pgvector 0.5+ supports HNSW.
-- m=16, ef_construction=64 are the recommended defaults for general-purpose
-- semantic search. The embedder produces L2-normalized vectors so cosine
-- and L2 are equivalent — picking cosine to match LanceDB's default.
CREATE INDEX IF NOT EXISTS idx_capital_chunks_embedding
  ON capital.chunks USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);
