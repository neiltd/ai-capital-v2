-- Phase 3.3: investment-analyst-agents archive schema
-- Originally mirrored the JSONL archive files (predictions.jsonl + qa.jsonl).
--
-- NO LONGER A PREPARATION. This schema is the live system of record whenever
-- DATABASE_URL is set: cli-brief writes every prediction to
-- briefing.predictions, and since 2026-09-29 briefing-backtest READS its corpus
-- from here rather than from predictions.jsonl. The JSONL files remain only for
-- the offline/legacy path where no DATABASE_URL exists, and are not written in
-- production. The superseded "App stays on JSONL" note is corrected here because
-- it was the sentence that made the stale-read defect look intentional.

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
