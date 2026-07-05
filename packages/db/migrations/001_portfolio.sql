-- Phase 3.3: scenario-simulator portfolio + trade log
-- Mirrors apps/scenario-simulator/data/portfolio.db schema (Phase 1 strategy column included).

CREATE SCHEMA IF NOT EXISTS portfolio;

CREATE TABLE IF NOT EXISTS portfolio.positions (
  ticker          TEXT        PRIMARY KEY,
  company         TEXT        NOT NULL,
  shares          NUMERIC     NOT NULL,
  avg_cost        NUMERIC     NOT NULL,
  current_price   NUMERIC     NOT NULL DEFAULT 0,
  current_value   NUMERIC     NOT NULL DEFAULT 0,
  unrealized_pnl  NUMERIC     NOT NULL DEFAULT 0,
  updated_at      TIMESTAMPTZ NOT NULL,
  asset_class     TEXT        NOT NULL DEFAULT 'us_equity'
                              CHECK (asset_class IN ('us_equity','th_equity','th_fund','gold','cash')),
  currency        TEXT        NOT NULL DEFAULT 'USD'
                              CHECK (currency    IN ('USD','THB')),
  price_symbol    TEXT        NOT NULL DEFAULT '',
  strategy        TEXT        NOT NULL DEFAULT 'tactical'
                              CHECK (strategy    IN ('tactical','dca','tax_locked'))
);

CREATE TABLE IF NOT EXISTS portfolio.trade_log (
  id              SERIAL      PRIMARY KEY,
  trade_date      DATE        NOT NULL,                 -- 'date' is reserved in some clients; renamed
  ticker          TEXT        NOT NULL,
  action          TEXT        NOT NULL CHECK (action IN ('buy','sell')),
  shares          NUMERIC     NOT NULL,
  price           NUMERIC     NOT NULL,
  reason          TEXT        NOT NULL DEFAULT '',
  current_price   NUMERIC     NOT NULL DEFAULT 0,
  pct_change      NUMERIC     NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_trade_log_ticker_date
  ON portfolio.trade_log(ticker, trade_date DESC);
