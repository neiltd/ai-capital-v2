-- Phase 3.3: capital-intelligence-ingestion SQLite tables
-- Schema mirrors apps/capital-intelligence-ingestion/data/sqlite.db.
-- App still uses SQLite at this commit; this migration prepares Postgres
-- so the app can switch to a dual-backend store in a follow-up commit.

CREATE SCHEMA IF NOT EXISTS capital;

-- Curated set of tickers + themes the ingestion pipeline targets.
CREATE TABLE IF NOT EXISTS capital.watchlist (
  ticker              TEXT        PRIMARY KEY,
  company             TEXT        NOT NULL,
  cik                 TEXT,
  themes              TEXT        NOT NULL,                  -- JSON array; kept as TEXT for parity
  news_only           BOOLEAN     NOT NULL DEFAULT FALSE,
  ir_feed_url         TEXT,
  ir_feed_status      TEXT        NOT NULL DEFAULT 'pending'
                                  CHECK (ir_feed_status IN ('pending','discovered','manual','dead')),
  active              BOOLEAN     NOT NULL DEFAULT TRUE,
  added_at            TIMESTAMPTZ NOT NULL,
  news_search_terms   TEXT        NOT NULL,                  -- JSON array
  thesis_update_days  INTEGER     NOT NULL DEFAULT 1
);

-- Dedup tracker: doc_hash -> (ticker, fetched_at).
-- ~30k rows already in SQLite; this is the high-volume table.
CREATE TABLE IF NOT EXISTS capital.documents (
  doc_hash    TEXT        PRIMARY KEY,
  ticker      TEXT        NOT NULL,
  fetched_at  TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_capital_documents_ticker_fetched
  ON capital.documents(ticker, fetched_at DESC);

-- Per-source fetch run record (one row per source per pipeline run).
CREATE TABLE IF NOT EXISTS capital.fetch_log (
  id          SERIAL      PRIMARY KEY,
  ticker      TEXT        NOT NULL,
  source      TEXT        NOT NULL,
  fetched_at  TIMESTAMPTZ NOT NULL,
  doc_count   INTEGER     NOT NULL,
  chunk_count INTEGER     NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_capital_fetch_log_ticker_source
  ON capital.fetch_log(ticker, source, fetched_at DESC);

-- FINRA short interest snapshots (daily per ticker).
CREATE TABLE IF NOT EXISTS capital.short_interest (
  date                DATE      NOT NULL,
  ticker              TEXT      NOT NULL,
  short_volume        NUMERIC   NOT NULL DEFAULT 0,
  short_exempt_volume NUMERIC   NOT NULL DEFAULT 0,
  total_volume        NUMERIC   NOT NULL DEFAULT 0,
  short_pct           NUMERIC   NOT NULL DEFAULT 0,
  PRIMARY KEY (date, ticker)
);

CREATE INDEX IF NOT EXISTS idx_capital_short_interest_ticker_date
  ON capital.short_interest(ticker, date DESC);

-- Per-source per-day request counter (FinancialData.net budget tracking, etc.).
CREATE TABLE IF NOT EXISTS capital.api_budget (
  source         TEXT     NOT NULL,
  date           DATE     NOT NULL,
  requests_used  INTEGER  NOT NULL DEFAULT 0,
  PRIMARY KEY (source, date)
);

-- Human-in-the-loop queue: surfaced at end of pipeline runs.
CREATE TABLE IF NOT EXISTS capital.pending_manual_input (
  id                TEXT        PRIMARY KEY,
  ticker            TEXT        NOT NULL,
  source            TEXT        NOT NULL,
  reason            TEXT        NOT NULL,
  suggested_action  TEXT        NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL,
  resolved_at       TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_capital_pending_unresolved
  ON capital.pending_manual_input(created_at DESC) WHERE resolved_at IS NULL;
