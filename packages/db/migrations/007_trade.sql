-- Trade-graph V1: dependency cascade + chokepoint exposure for the world map.
-- See memory/project_trade_graph_v1.md for design.

create schema if not exists trade;

-- Countries — keyed by ISO3 so we line up with the worldmap dataset.
create table if not exists trade.countries (
  iso3           text primary key,
  name           text not null,
  centroid_lat   real,
  centroid_lon   real
);

-- Bilateral trade flows, directed. One row per (origin, dest, commodity, period).
-- value_usd is the dollar value for that period; null period_quarter means the
-- row is an annual aggregate (most rows from UN Comtrade will be annual).
create table if not exists trade.flows (
  id              uuid primary key default gen_random_uuid(),
  origin_iso3     text   not null references trade.countries(iso3) on delete cascade,
  dest_iso3       text   not null references trade.countries(iso3) on delete cascade,
  commodity       text   not null,        -- CommodityCategory enum (TS-side validated)
  value_usd       bigint not null check (value_usd >= 0),
  period_year     int    not null check (period_year between 1900 and 2100),
  period_quarter  int    check (period_quarter between 1 and 4),
  source          text   not null,        -- 'un_comtrade' | 'imf_dots' | 'manual' | 'dropzone'
  ingested_at     timestamptz not null default now(),
  unique (origin_iso3, dest_iso3, commodity, period_year, period_quarter)
);

create index if not exists idx_flows_origin
  on trade.flows(origin_iso3);
create index if not exists idx_flows_dest
  on trade.flows(dest_iso3);
create index if not exists idx_flows_period
  on trade.flows(period_year desc, period_quarter desc nulls last);
create index if not exists idx_flows_commodity
  on trade.flows(commodity);

-- 10 fixed maritime chokepoints. Static dataset seeded by trade-graph seed CLI.
create table if not exists trade.chokepoints (
  id            text primary key,        -- 'hormuz', 'suez', 'malacca', ...
  name          text not null,
  lat           real not null,
  lon           real not null,
  description   text
);

-- Which (origin, dest) pairs route through which chokepoint. A flow can pass
-- through multiple — e.g. Persian Gulf → East Asia oil = Hormuz AND Malacca.
create table if not exists trade.chokepoint_routes (
  chokepoint_id  text not null references trade.chokepoints(id) on delete cascade,
  origin_iso3    text not null references trade.countries(iso3) on delete cascade,
  dest_iso3      text not null references trade.countries(iso3) on delete cascade,
  primary key (chokepoint_id, origin_iso3, dest_iso3)
);

-- Per-ticker supply-chain dependency graph. Multiple rows per ticker — each row
-- is one (country, commodity[, chokepoint]) edge. LLM-derived initially with
-- manual override path via the `review` CLI.
create table if not exists trade.ticker_dependencies (
  id             uuid primary key default gen_random_uuid(),
  ticker         text not null,
  country_iso3   text not null references trade.countries(iso3) on delete cascade,
  commodity      text not null,
  chokepoint_id  text references trade.chokepoints(id) on delete set null,
  -- 1 = critical (lethal exposure), 5 = mild (substitutable in months).
  criticality    int  not null check (criticality between 1 and 5),
  rationale      text,
  source         text not null check (source in ('llm', 'manual')),
  created_at     timestamptz not null default now()
);

create index if not exists idx_ticker_deps_ticker
  on trade.ticker_dependencies(ticker);
create index if not exists idx_ticker_deps_country
  on trade.ticker_dependencies(country_iso3);
create index if not exists idx_ticker_deps_chokepoint
  on trade.ticker_dependencies(chokepoint_id);
