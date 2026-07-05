-- Phase 3.3: investment-analyst-agents archive schema
-- Mirrors the JSONL archive files (predictions.jsonl + qa.jsonl).
-- App stays on JSONL; this migration prepares a structured store so the
-- backtester + Q&A history can be queried with real SQL.

CREATE SCHEMA IF NOT EXISTS briefing;

-- One row per daily briefing run. The actions array is preserved as JSONB
-- so the backtester can join individual recommendations against actual
-- prices without a separate table.
CREATE TABLE IF NOT EXISTS briefing.predictions (
  date         DATE        PRIMARY KEY,
  regime       TEXT        NOT NULL,
  confidence   TEXT        NOT NULL,
  scenarios    JSONB       NOT NULL,
  actions      JSONB       NOT NULL,
  archived_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Per-action index lets the backtest report group by recommendation type
-- (buy/hold/trim/exit) without scanning every prediction row.
CREATE INDEX IF NOT EXISTS idx_briefing_predictions_regime
  ON briefing.predictions(regime);

-- Conversational Q&A archive. Each row is one back-and-forth session.
CREATE TABLE IF NOT EXISTS briefing.qa (
  id           BIGSERIAL   PRIMARY KEY,
  date         DATE        NOT NULL,
  asked_at     TIMESTAMPTZ NOT NULL,
  mode         TEXT        NOT NULL,                     -- 'oneshot' | 'session' | etc.
  exchanges    JSONB       NOT NULL,                     -- array of {q, a, ...}
  archived_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_briefing_qa_date
  ON briefing.qa(date DESC);
