// ── Core record types ──────────────────────────────────────────────────────

export type EventType = 'conflict' | 'disaster' | 'political' | 'economic' | 'other';
export type Severity = 1 | 2 | 3 | 4 | 5;

export interface EventRecord {
  id: string;
  source: string;
  type: EventType;
  title: string;
  description: string;
  country: string;       // ISO 3166-1 alpha-3, or 'UNK'
  lat: number | null;
  lng: number | null;
  severity: Severity;
  date: string;          // YYYY-MM-DD
  fetchedAt: string;     // ISO datetime
  rawHash: string;       // sha256 first 16 chars of raw record
}

export interface EnergyIndicator {
  id: string;
  source: string;
  metric: string;        // 'wti_price' | 'brent_price' | 'production_mbpd' | ...
  value: number;
  unit: string;
  country: string;
  date: string;
  fetchedAt: string;
  rawHash: string;
}

export interface MacroIndicator {
  id: string;
  source: string;
  metric: string;        // 'gdp_usd' | 'inflation_pct' | 'interest_rate_pct' | ...
  value: number;
  unit: string;
  country: string;
  date: string;
  fetchedAt: string;
  rawHash: string;
}

// ── Export envelope ─────────────────────────────────────────────────────────

export interface ExportMeta {
  schemaVersion: string;
  generatedAt: string;
  sourceVersions: Record<string, string>;   // source → last successful fetch ISO datetime
  recordCount: number;
  breaking: boolean;
  staleSourcesPresent: boolean;
}

export interface ExportEnvelope<T> {
  meta: ExportMeta;
  data: T[];
}

// ── Source / run types ──────────────────────────────────────────────────────

export type SourceStatus = 'ok' | 'failed' | 'skipped';

export interface SourceRunResult {
  source: string;
  status: SourceStatus;
  fetchedAt?: string;
  newRecords?: number;
  duplicates?: number;
  error?: string;
  attempts?: number;
}

export interface RunManifest {
  runId: string;
  startedAt: string;
  completedAt: string;
  sources: Record<string, SourceRunResult>;
  exported: boolean;
}

// ── Quota types ─────────────────────────────────────────────────────────────

export interface SourceConfig {
  name: string;
  ttlHours: number;
  maxStalenessHours: number;
  dailyLimit: number | null;
  monthlyLimit: number | null;
  resetPeriod: 'daily' | 'monthly' | 'none';
  requestsPerRun: number;   // actual HTTP requests made per fetch() call
}

export interface QuotaEntry {
  source: string;
  dailyUsed: number;
  monthlyUsed: number;
  resetDate: string;
  lastSuccessfulFetch?: string;
}

export type QuotaState = Record<string, QuotaEntry>;

// ── Dedup types ─────────────────────────────────────────────────────────────

export interface DedupEntry {
  source: string;
  recordId: string;
  seenAt: string;
}

export type DedupIndex = Record<string, DedupEntry>;

// ── Source cursor types ─────────────────────────────────────────────────────

export interface SourceCursor {
  lastFetchedAt: string;
  meta?: Record<string, unknown>;   // source-specific: page, sinceId, etc.
}

export type CursorState = Record<string, SourceCursor>;

// ── Source registry types ────────────────────────────────────────────────────

export type SourceType =
  | 'wire_agency'
  | 'newspaper'
  | 'broadcaster'
  | 'financial'
  | 'government'
  | 'think_tank'
  | 'aggregator';

export type AccessType = 'rss' | 'api' | 'rss_and_api';

export type TopicTag =
  | 'politics'
  | 'conflict'
  | 'economy'
  | 'energy'
  | 'diplomacy'
  | 'markets'
  | 'society'
  | 'technology'
  | 'general';

export interface NewsSource {
  id:               string;
  name:             string;
  country:          string;        // ISO 3166-1 alpha-2
  language:         string;        // ISO 639-1
  region_focus:     string[];
  source_type:      SourceType;
  access_type:      AccessType;
  rss_url?:         string;
  api_url?:         string;
  topics:           TopicTag[];
  reliability_tier: 1 | 2 | 3;
  bias_note?:       string;
  usage_notes?:     string;
  enabled:          boolean;
}

// ── Translation types ────────────────────────────────────────────────────────
// Fields are defined now; implementation comes with the reporter-agent.

export type TranslationStatus =
  | 'not_required'   // source language matches target (usually 'en')
  | 'pending'        // queued but not yet started
  | 'in_progress'    // actively being translated
  | 'completed'      // translation done and attached
  | 'failed'         // translation attempted, failed
  | 'skipped';       // deliberately skipped (low priority or low relevance)

export interface TranslationMetadata {
  original_language:      string;          // ISO 639-1 (e.g. 'th', 'zh', 'ar')
  translated_language?:   string;          // ISO 639-1 — set when status = 'completed'
  translation_status:     TranslationStatus;
  translation_confidence?: number;          // 0.0–1.0 confidence from model
  translation_model?:     string;          // e.g. 'claude-haiku-4-5', 'google-translate-v3'
  translated_at?:         string;          // ISO datetime when translation completed
}

// ── Article lifecycle status types ───────────────────────────────────────────

export type IngestionStatus =
  | 'fetched'           // raw feed retrieved and raw snapshot saved
  | 'failed';           // fetch or parse failed

export type ProcessingStatus =
  | 'normalized'        // ArticleRecord fields populated
  | 'failed';           // normalization failed (bad data)

export type DedupStatus =
  | 'new'               // never seen before
  | 'exact_duplicate'   // same source + title + date already in index
  | 'syndicated';       // different source reported same headline (wire syndication)

export type AIStatus =
  | 'pending'           // waiting for reporter-agent
  | 'extracted'         // structured event extracted
  | 'translated'        // translation completed
  | 'analyzed'          // narrative/relevance analysis done
  | 'skipped';          // not worth processing (low relevance, exact dupe, etc.)

export interface ArticleLifecycle {
  ingestion_status:  IngestionStatus;
  processing_status: ProcessingStatus;
  dedup_status:      DedupStatus;
  ai_status:         AIStatus;
}

// ── Article record ────────────────────────────────────────────────────────────
// The canonical unit produced by the RSS collector and consumed by the reporter-agent.

export interface ArticleRecord {
  // Identity
  id:              string;          // exact fingerprint hash — globally unique
  source_id:       string;          // references NewsSource.id
  source_name:     string;
  reliability_tier: 1 | 2 | 3;     // copied from NewsSource at ingest time

  // Content
  title:           string;
  url:             string;
  published_at:    string;          // ISO datetime from feed (may be approximate)
  fetched_at:      string;          // ISO datetime when hub fetched the feed
  description?:    string;          // RSS <description> / Atom <summary>
  author?:         string;
  tags?:           string[];        // RSS <category> values

  // Fingerprinting
  fingerprint:     string;          // exact hash — dedup within/across sources
  syndication_key: string;          // 8-word hash — cross-source wire match

  // Translation (populated by reporter-agent, not the collector)
  translation:     TranslationMetadata;

  // Lifecycle — updated at each pipeline stage
  lifecycle:       ArticleLifecycle;

  // Scoring — populated by article-scorer, absent before scoring runs
  scoring?:        ArticleScoringResult;
}

// ── Article scoring types ─────────────────────────────────────────────────────

export interface ScoringCategoryBreakdown {
  geopolitical:         number;
  conflict:             number;
  economic:             number;
  commodity:            number;
  country:              number;
  tier_bonus:           number;
  multi_category_bonus: number;
  noise_penalty:        number;
}

export interface ArticleScoringResult {
  relevance_score:          number;         // 0–100
  relevance_reasons:        string[];       // human-readable signal explanations
  recommended_for_ai:       boolean;        // score >= RECOMMENDATION_THRESHOLD, or narrative track
  narrative_source:         boolean;        // Tier 3 state media on narrative track (score 25–34)
  cross_reference_required: boolean;        // true for all narrative_source articles
  scored_at:                string;         // ISO datetime
  category_breakdown:       ScoringCategoryBreakdown;
}

// ── Source health types ───────────────────────────────────────────────────────

export interface SourceHealthEntry {
  source_id:             string;
  total_fetches:         number;
  successful_fetches:    number;
  failed_fetches:        number;
  empty_feed_count:      number;
  consecutive_failures:  number;
  error_count:           number;
  last_success?:         string;   // ISO datetime
  last_failure?:         string;   // ISO datetime
  last_failure_reason?:  string;
  last_response_time_ms?: number;
  avg_response_time_ms?:  number;  // exponential moving average (α = 0.2)
}

export type SourceHealthState = Record<string, SourceHealthEntry>;
