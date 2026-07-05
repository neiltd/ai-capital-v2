// Daily operational metrics — persisted to intelligence/metrics/YYYY-MM-DD.json.
// Metrics directory is tracked in git (not gitignored) — the history is valuable
// for calibrating extraction quality and operational reliability.
//
// Design:
//   - Collection and scoring: latest-wins (each run replaces the snapshot)
//   - Extraction: accumulates across runs (tokens, cost, event counts add up)

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'fs';
import { join } from 'path';
import { PATHS } from '../../lib/paths.ts';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface CollectionMetrics {
  last_run:           string;
  run_count:          number;
  total_articles:     number;
  by_source:          Record<string, number>;
  failed_sources:     string[];
  skipped_sources:    string[];    // cache-fresh, not fetched
  stale_articles:     number;      // rejected by recency filter (>30 days old)
  stale_feed_sources: string[];    // sources where >50% of items were stale
  avg_article_age_hours:  number;  // average age of accepted articles across sources
  oldest_article_days:    number;  // oldest accepted article in days
}

export interface ScoringMetrics {
  last_run:          string;
  run_count:         number;
  total_scored:      number;
  recommended:       number;
  filtered:          number;
  reduction_pct:     number;
  score_distribution: {
    urgent:   number;
    high:     number;
    relevant: number;
    marginal: number;
    noise:    number;
  };
  by_source: Record<string, { total: number; recommended: number }>;
}

export interface ExtractionMetrics {
  last_run:            string;
  run_count:           number;
  articles_sent_to_ai: number;
  batches_run:         number;
  events_extracted:    number;
  events_merged:       number;
  low_confidence:      number;  // confidence < 0.5
  human_review:        number;  // flagged for review
  api_tokens: {
    input:       number;
    output:      number;
    cache_write: number;
    cache_read:  number;
  };
  estimated_cost_usd:  number;
}

export interface DailyMetrics {
  date:         string;
  last_updated: string;
  collection?:  CollectionMetrics;
  scoring?:     ScoringMetrics;
  extraction?:  ExtractionMetrics;
}

// ── Persistence ───────────────────────────────────────────────────────────────

function metricsPath(date: string): string {
  return join(PATHS.intelligence.metrics, `${date}.json`);
}

function load(date: string): DailyMetrics {
  const p = metricsPath(date);
  if (!existsSync(p)) return { date, last_updated: new Date().toISOString() };
  try {
    return JSON.parse(readFileSync(p, 'utf-8')) as DailyMetrics;
  } catch {
    return { date, last_updated: new Date().toISOString() };
  }
}

function save(metrics: DailyMetrics): void {
  mkdirSync(PATHS.intelligence.metrics, { recursive: true });
  metrics.last_updated = new Date().toISOString();
  writeFileSync(metricsPath(metrics.date), JSON.stringify(metrics, null, 2));
}

// ── Update functions ──────────────────────────────────────────────────────────

export function updateCollectionMetrics(
  date:  string,
  data:  Omit<CollectionMetrics, 'last_run' | 'run_count'>,
): void {
  const m    = load(date);
  const prev = m.collection;
  m.collection = {
    last_run:               new Date().toISOString(),
    run_count:              (prev?.run_count ?? 0) + 1,
    total_articles:         data.total_articles,
    by_source:              data.by_source,
    failed_sources:         data.failed_sources,
    skipped_sources:        data.skipped_sources,
    stale_articles:         data.stale_articles,
    stale_feed_sources:     data.stale_feed_sources,
    avg_article_age_hours:  data.avg_article_age_hours,
    oldest_article_days:    data.oldest_article_days,
  };
  save(m);
}

export function updateScoringMetrics(
  date:  string,
  data:  Omit<ScoringMetrics, 'last_run' | 'run_count'>,
): void {
  const m    = load(date);
  const prev = m.scoring;
  m.scoring = {
    last_run:           new Date().toISOString(),
    run_count:          (prev?.run_count ?? 0) + 1,
    total_scored:       data.total_scored,
    recommended:        data.recommended,
    filtered:           data.filtered,
    reduction_pct:      data.reduction_pct,
    score_distribution: data.score_distribution,
    by_source:          data.by_source,
  };
  save(m);
}

export function updateExtractionMetrics(
  date: string,
  data: Omit<ExtractionMetrics, 'last_run' | 'run_count'>,
): void {
  const m    = load(date);
  const prev = m.extraction;
  m.extraction = {
    last_run:            new Date().toISOString(),
    run_count:           (prev?.run_count ?? 0) + 1,
    // These accumulate — each reporter run adds to the daily totals
    articles_sent_to_ai: (prev?.articles_sent_to_ai ?? 0) + data.articles_sent_to_ai,
    batches_run:         (prev?.batches_run ?? 0)         + data.batches_run,
    events_extracted:    (prev?.events_extracted ?? 0)    + data.events_extracted,
    events_merged:       (prev?.events_merged ?? 0)       + data.events_merged,
    low_confidence:      (prev?.low_confidence ?? 0)      + data.low_confidence,
    human_review:        (prev?.human_review ?? 0)        + data.human_review,
    api_tokens: {
      input:       (prev?.api_tokens.input       ?? 0) + data.api_tokens.input,
      output:      (prev?.api_tokens.output      ?? 0) + data.api_tokens.output,
      cache_write: (prev?.api_tokens.cache_write ?? 0) + data.api_tokens.cache_write,
      cache_read:  (prev?.api_tokens.cache_read  ?? 0) + data.api_tokens.cache_read,
    },
    estimated_cost_usd: (prev?.estimated_cost_usd ?? 0) + data.estimated_cost_usd,
  };
  save(m);
}

// ── Read functions ────────────────────────────────────────────────────────────

export function getDailyMetrics(date: string): DailyMetrics | null {
  const p = metricsPath(date);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf-8')) as DailyMetrics;
  } catch {
    return null;
  }
}

/** Return all available metric dates, sorted newest first. */
export function listMetricDates(): string[] {
  if (!existsSync(PATHS.intelligence.metrics)) return [];
  return readdirSync(PATHS.intelligence.metrics)
    .filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .map(f => f.replace('.json', ''))
    .sort()
    .reverse();
}
