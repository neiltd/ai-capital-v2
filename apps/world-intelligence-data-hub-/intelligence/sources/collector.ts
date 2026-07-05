import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from 'fs';
import { join } from 'path';
import type { NewsSource, ArticleRecord, ArticleLifecycle, TranslationMetadata } from '../../lib/types.ts';
import { PATHS }                from '../../lib/paths.ts';
import { logger }               from '../../lib/logger.ts';
import { rssSources }           from './registry.ts';
import { SourceHealthMonitor }  from './health.ts';
import { checkAndRecord }       from './fingerprint.ts';
import { parseFeed }            from './rss-parser.ts';
import type { RawFeedItem }     from './rss-parser.ts';

// ── Result types ──────────────────────────────────────────────────────────────

export interface CollectionResult {
  source_id:        string;
  status:           'ok' | 'skipped' | 'failed';
  new_articles:     number;
  exact_duplicates: number;
  syndicated:       number;
  stale_skipped:    number;   // articles rejected for being > MAX_ARTICLE_AGE_DAYS old
  avg_age_hours:    number;   // average age of accepted articles
  oldest_age_days:  number;   // oldest accepted article in days
  stale_feed:       boolean;  // true when > 50% of feed items were stale
  duration_ms:      number;
  error?:           string;
}

export interface CollectionSummary {
  run_at:            string;
  duration_ms:       number;
  sources_ok:        number;
  sources_failed:    number;
  sources_skipped:   number;
  total_new:         number;
  total_dupes:       number;
  total_syndicated:  number;
  total_stale:       number;   // articles rejected across all sources
  stale_feed_sources: string[]; // sources where > 50% of items were stale
  results:           CollectionResult[];
}

export interface CollectOpts {
  skipCache?:    boolean;   // ignore cache, always re-fetch
  cacheTtlMs?:   number;    // default: 60 minutes
}

// ── Paths helpers ─────────────────────────────────────────────────────────────

function rawDir(sourceId: string): string {
  return join(PATHS.intelligence.rawArticles, sourceId);
}

function rawPath(sourceId: string, date: string): string {
  return join(rawDir(sourceId), `${date}.json`);
}

function outputDir(date: string): string {
  return join(PATHS.intelligence.outputArticles, date);
}

function outputPath(sourceId: string, date: string): string {
  return join(outputDir(date), `${sourceId}.json`);
}

function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

// ── URL normalization ─────────────────────────────────────────────────────────
// Strip tracking query params before storing URLs. Does not affect fingerprinting
// (which uses title + source_id), but keeps stored URLs clean for downstream use.

const TRACKING_PARAMS = new Set([
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
  'utm_id', 'utm_reader',
  'srnd', 'taid',                          // Bloomberg internal
  'fbclid', 'gclid', 'twclid', 'msclkid', // ad network click IDs
  'mc_cid', 'mc_eid',                      // Mailchimp
  'traffic_source',                        // Al Jazeera RSS
]);

// Only http(s) URLs are accepted — rejects javascript:, data:, file:, and other
// schemes that a malicious/compromised feed could inject into ArticleRecord.url.
const ALLOWED_URL_SCHEMES = new Set(['http:', 'https:']);

function normalizeUrl(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    logger.warn('collector', `normalizeUrl: unparseable URL rejected — "${raw}"`);
    return null;
  }

  if (!ALLOWED_URL_SCHEMES.has(u.protocol)) {
    logger.warn('collector', `normalizeUrl: rejected URL with disallowed scheme "${u.protocol}" — "${raw}"`);
    return null;
  }

  let changed = false;
  for (const key of [...u.searchParams.keys()]) {
    if (TRACKING_PARAMS.has(key)) { u.searchParams.delete(key); changed = true; }
  }
  if (!changed) return raw;
  // Remove trailing '?' if all params were stripped
  const qs = u.searchParams.toString();
  return qs ? u.toString() : u.origin + u.pathname + (u.hash || '');
}

// ── Recency filter ────────────────────────────────────────────────────────────
// Articles older than this are skipped. Prevents stale RSS feeds (e.g. Xinhua
// returning 2017 articles) from reaching the scoring and extraction layers.

const MAX_ARTICLE_AGE_DAYS = 30;
const MAX_ARTICLE_AGE_MS   = MAX_ARTICLE_AGE_DAYS * 86_400_000;

// A feed is considered "stale" when more than half its items are too old.
const STALE_FEED_THRESHOLD = 0.5;

// ── Cache check ───────────────────────────────────────────────────────────────

const DEFAULT_CACHE_TTL_MS = 60 * 60 * 1_000; // 1 hour

function isCacheFresh(sourceId: string, date: string, ttlMs: number): boolean {
  const p = rawPath(sourceId, date);
  if (!existsSync(p)) return false;
  const ageMs = Date.now() - statSync(p).mtimeMs;
  return ageMs < ttlMs;
}

// ── Raw snapshot persistence ──────────────────────────────────────────────────

interface RawSnapshot {
  source_id:     string;
  fetched_at:    string;
  feed_format:   string;
  feed_title?:   string;
  article_count: number;
  items:         RawFeedItem[];
}

function saveRaw(sourceId: string, date: string, snapshot: RawSnapshot): void {
  mkdirSync(rawDir(sourceId), { recursive: true });
  writeFileSync(rawPath(sourceId, date), JSON.stringify(snapshot, null, 2));
}

// ── Output persistence ────────────────────────────────────────────────────────

interface SourceOutputFile {
  source_id:    string;
  date:         string;
  generated_at: string;
  stats: {
    total:           number;
    new_articles:    number;
    exact_duplicates: number;
    syndicated:      number;
  };
  articles:     ArticleRecord[];
}

function loadExistingOutput(sourceId: string, date: string): ArticleRecord[] {
  const p = outputPath(sourceId, date);
  if (!existsSync(p)) return [];
  try {
    const f = JSON.parse(readFileSync(p, 'utf-8')) as SourceOutputFile;
    return f.articles ?? [];
  } catch {
    return [];
  }
}

function saveOutput(sourceId: string, date: string, articles: ArticleRecord[], stats: SourceOutputFile['stats']): void {
  mkdirSync(outputDir(date), { recursive: true });
  const file: SourceOutputFile = {
    source_id:    sourceId,
    date,
    generated_at: new Date().toISOString(),
    stats,
    articles,
  };
  writeFileSync(outputPath(sourceId, date), JSON.stringify(file, null, 2));
  logger.debug('collector', `Saved ${articles.length} articles → ${outputPath(sourceId, date)}`);
}

// ── Article builder ───────────────────────────────────────────────────────────

function defaultTranslation(language: string): TranslationMetadata {
  return {
    original_language: language,
    translation_status: language === 'en' ? 'not_required' : 'pending',
  };
}

function defaultLifecycle(): ArticleLifecycle {
  return {
    ingestion_status:  'fetched',
    processing_status: 'normalized',
    dedup_status:      'new',
    ai_status:         'pending',
  };
}

function buildArticleRecord(
  item:      RawFeedItem,
  source:    NewsSource,
  fetchedAt: string,
): ArticleRecord | null {
  // title and url are required
  if (!item.title?.trim()) return null;
  const rawUrl = item.link?.trim() ?? item.guid?.trim();
  if (!rawUrl) return null;
  const url = normalizeUrl(rawUrl);
  if (!url) return null;

  const title      = item.title.trim();
  const pubAt      = item.published_at ?? fetchedAt;
  const fp         = checkAndRecord(title, source.id, pubAt, url);

  const lifecycle  = defaultLifecycle();
  lifecycle.dedup_status = fp.is_exact_duplicate
    ? 'exact_duplicate'
    : fp.is_syndicated
      ? 'syndicated'
      : 'new';

  if (fp.is_exact_duplicate) {
    lifecycle.ai_status = 'skipped';
  }

  return {
    id:               fp.fingerprint.exact,
    source_id:        source.id,
    source_name:      source.name,
    reliability_tier: source.reliability_tier,
    title,
    url,
    published_at:     pubAt,
    fetched_at:       fetchedAt,
    description:      item.description,
    author:           item.author,
    tags:             item.tags.length > 0 ? item.tags : undefined,
    fingerprint:      fp.fingerprint.exact,
    syndication_key:  fp.fingerprint.syndication_key,
    translation:      defaultTranslation(source.language),
    lifecycle,
  };
}

// ── Single source collection ──────────────────────────────────────────────────

export async function collectFromSource(
  source:  NewsSource,
  health:  SourceHealthMonitor,
  opts:    CollectOpts = {},
): Promise<CollectionResult> {
  const { skipCache = false, cacheTtlMs = DEFAULT_CACHE_TTL_MS } = opts;
  const date    = todayStr();
  const t0      = Date.now();

  if (!skipCache && isCacheFresh(source.id, date, cacheTtlMs)) {
    logger.info('collector', `${source.id}: cache fresh — skipping`);
    return { source_id: source.id, status: 'skipped', new_articles: 0, exact_duplicates: 0, syndicated: 0, stale_skipped: 0, avg_age_hours: 0, oldest_age_days: 0, stale_feed: false, duration_ms: Date.now() - t0 };
  }

  // ── Fetch ──────────────────────────────────────────────────────────────────

  const fetchedAt = new Date().toISOString();
  let xmlText: string;

  try {
    logger.info('collector', `${source.id}: fetching ${source.rss_url}`);
    const res = await fetch(source.rss_url!, {
      signal:  AbortSignal.timeout(20_000),
      headers: {
        'User-Agent': 'WorldIntelligenceHub/1.0 (RSS collector)',
        'Accept':     'application/rss+xml, application/atom+xml, application/xml, text/xml, */*',
      },
    });

    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    xmlText = await res.text();
  } catch (err) {
    const msg = (err as Error).message;
    health.recordFailure(source.id, msg);
    logger.error('collector', `${source.id}: fetch failed — ${msg}`);
    return { source_id: source.id, status: 'failed', new_articles: 0, exact_duplicates: 0, syndicated: 0, stale_skipped: 0, avg_age_hours: 0, oldest_age_days: 0, stale_feed: false, duration_ms: Date.now() - t0, error: msg };
  }

  const fetchMs = Date.now() - t0;

  // ── Parse ──────────────────────────────────────────────────────────────────

  let feed;
  try {
    feed = parseFeed(xmlText);
  } catch (err) {
    const msg = `Parse failed: ${(err as Error).message}`;
    health.recordFailure(source.id, msg);
    logger.error('collector', `${source.id}: ${msg}`);
    return { source_id: source.id, status: 'failed', new_articles: 0, exact_duplicates: 0, syndicated: 0, stale_skipped: 0, avg_age_hours: 0, oldest_age_days: 0, stale_feed: false, duration_ms: Date.now() - t0, error: msg };
  }

  // Record health — successful fetch
  health.recordSuccess(source.id, fetchMs);

  if (feed.items.length === 0) {
    health.recordEmptyFeed(source.id);
    logger.warn('collector', `${source.id}: feed returned 0 items`);
  }

  // ── Save raw snapshot ──────────────────────────────────────────────────────

  const snapshot: RawSnapshot = {
    source_id:     source.id,
    fetched_at:    fetchedAt,
    feed_format:   feed.format,
    feed_title:    feed.feed_title,
    article_count: feed.items.length,
    items:         feed.items,
  };
  saveRaw(source.id, date, snapshot);

  // ── Build + dedup ArticleRecords ───────────────────────────────────────────

  const existingIds  = new Set(loadExistingOutput(source.id, date).map(a => a.id));
  const allArticles: ArticleRecord[] = [];
  let newCount    = 0;
  let dupeCount   = 0;
  let syndCount   = 0;
  let staleCount  = 0;
  const acceptedAgesMs: number[] = [];   // age in ms for recency metrics

  for (const item of feed.items) {
    // ── Recency check ──────────────────────────────────────────────────────
    // Apply before building the full record — cheaper and catches stale feeds
    // early. Uses published_at from the RSS parser (already coerced to ISO).
    if (item.published_at) {
      const pubMs   = new Date(item.published_at).getTime();
      const ageMs   = Date.now() - pubMs;
      if (ageMs > MAX_ARTICLE_AGE_MS) {
        staleCount++;
        logger.debug('collector', `${source.id}: stale — "${(item.title ?? '?').slice(0, 60)}" (${(ageMs / 86_400_000).toFixed(1)}d old)`);
        continue;
      }
      acceptedAgesMs.push(ageMs);
    } else {
      // No date — treat as fresh (we can't tell, don't filter)
      acceptedAgesMs.push(0);
    }

    const record = buildArticleRecord(item, source, fetchedAt);
    if (!record) continue;

    // Skip articles already in today's output file (idempotent re-runs)
    if (existingIds.has(record.id)) {
      dupeCount++;
      continue;
    }

    if (record.lifecycle.dedup_status === 'exact_duplicate') {
      dupeCount++;
      continue;
    }

    if (record.lifecycle.dedup_status === 'syndicated') syndCount++;
    else newCount++;

    allArticles.push(record);
  }

  // ── Feed freshness metrics ──────────────────────────────────────────────

  const totalItems   = feed.items.length;
  const staleFraction = totalItems > 0 ? staleCount / totalItems : 0;
  const staleFeed     = staleFraction > STALE_FEED_THRESHOLD;
  const avgAgeHours   = acceptedAgesMs.length > 0
    ? acceptedAgesMs.reduce((a, b) => a + b, 0) / acceptedAgesMs.length / 3_600_000
    : 0;
  const oldestAgeDays = acceptedAgesMs.length > 0
    ? Math.max(...acceptedAgesMs) / 86_400_000
    : 0;

  if (staleCount > 0) {
    logger.info('collector', `${source.id}: ${staleCount} stale article${staleCount !== 1 ? 's' : ''} skipped (>${MAX_ARTICLE_AGE_DAYS}d old)`);
  }
  if (staleFeed) {
    logger.warn('collector', `${source.id}: stale feed — ${Math.round(staleFraction * 100)}% of items are older than ${MAX_ARTICLE_AGE_DAYS} days. RSS may be serving cached/archived content.`);
  }

  // Merge with any previously-saved articles from earlier runs today
  const previousArticles = loadExistingOutput(source.id, date)
    .filter(a => !allArticles.some(n => n.id === a.id));
  const mergedArticles = [...previousArticles, ...allArticles];

  const stats = {
    total:            mergedArticles.length,
    new_articles:     newCount,
    exact_duplicates: dupeCount,
    syndicated:       syndCount,
    stale_skipped:    staleCount,
  };

  saveOutput(source.id, date, mergedArticles, stats);

  const duration_ms = Date.now() - t0;
  logger.info('collector', `${source.id}: ${newCount} new / ${dupeCount} dupes / ${syndCount} syndicated / ${staleCount} stale (${duration_ms}ms)`);

  return {
    source_id:        source.id,
    status:           'ok',
    new_articles:     newCount,
    exact_duplicates: dupeCount,
    syndicated:       syndCount,
    stale_skipped:    staleCount,
    avg_age_hours:    Math.round(avgAgeHours * 10) / 10,
    oldest_age_days:  Math.round(oldestAgeDays * 10) / 10,
    stale_feed:       staleFeed,
    duration_ms,
  };
}

// ── Collect all enabled sources ───────────────────────────────────────────────

export async function collectAll(
  opts: CollectOpts & { sourceIds?: string[] } = {},
): Promise<CollectionSummary> {
  const { sourceIds, ...collectOpts } = opts;
  const runAt = new Date().toISOString();
  const t0    = Date.now();
  const health = new SourceHealthMonitor();

  const sources = rssSources().filter(s =>
    !sourceIds || sourceIds.includes(s.id),
  );

  if (sources.length === 0) {
    logger.warn('collector', 'No enabled RSS sources matched');
    return { run_at: runAt, duration_ms: 0, sources_ok: 0, sources_failed: 0, sources_skipped: 0, total_new: 0, total_dupes: 0, total_syndicated: 0, total_stale: 0, stale_feed_sources: [], results: [] };
  }

  logger.info('collector', `Starting collection — ${sources.length} sources`);

  // Run all sources concurrently — each targets a different server
  const settled = await Promise.allSettled(
    sources.map(s => collectFromSource(s, health, collectOpts)),
  );

  const results: CollectionResult[] = settled.map((r, i) => {
    if (r.status === 'fulfilled') return r.value;
    const msg = r.reason instanceof Error ? r.reason.message : String(r.reason);
    return {
      source_id:        sources[i]!.id,
      status:           'failed' as const,
      new_articles:     0,
      exact_duplicates: 0,
      syndicated:       0,
      stale_skipped:    0,
      avg_age_hours:    0,
      oldest_age_days:  0,
      stale_feed:       false,
      duration_ms:      0,
      error:            msg,
    };
  });

  const staleFeeds = results.filter(r => r.stale_feed).map(r => r.source_id);
  const totalStale = results.reduce((s, r) => s + r.stale_skipped, 0);

  const summary: CollectionSummary = {
    run_at:             runAt,
    duration_ms:        Date.now() - t0,
    sources_ok:         results.filter(r => r.status === 'ok').length,
    sources_failed:     results.filter(r => r.status === 'failed').length,
    sources_skipped:    results.filter(r => r.status === 'skipped').length,
    total_new:          results.reduce((s, r) => s + r.new_articles, 0),
    total_dupes:        results.reduce((s, r) => s + r.exact_duplicates, 0),
    total_syndicated:   results.reduce((s, r) => s + r.syndicated, 0),
    total_stale:        totalStale,
    stale_feed_sources: staleFeeds,
    results,
  };

  const staleMsg = totalStale > 0 ? ` / ${totalStale} stale` : '';
  if (staleFeeds.length > 0) {
    logger.warn('collector', `Stale feeds: ${staleFeeds.join(', ')}`);
  }
  logger.info('collector', `Collection done — ${summary.total_new} new / ${summary.total_dupes} dupes / ${summary.total_syndicated} syndicated${staleMsg}`);
  return summary;
}
