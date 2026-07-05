import { createHash } from 'crypto';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { PATHS } from '../../lib/paths.ts';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ArticleFingerprint {
  exact:           string;   // sha256(source_id + normalized_title + date + url?)
  syndication_key: string;   // sha256(first-8-words of title) — cross-source match
}

export interface FingerprintIndexEntry {
  source_id:    string;
  title:        string;
  url?:         string;
  published_at: string;
  first_seen:   string;       // ISO datetime — when first encountered
  seen_count:   number;
  sources_seen: string[];     // all source_ids that published this syndication_key
}

export type FingerprintIndex = Record<string, FingerprintIndexEntry>;

// ── Normalization ─────────────────────────────────────────────────────────────

function normalizeTitle(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')   // punctuation → space (preserves word boundaries)
    .replace(/\s+/g, ' ')
    .trim();
}

function firstNWords(title: string, n: number): string {
  return normalizeTitle(title).split(' ').filter(Boolean).slice(0, n).join(' ');
}

function sha256(input: string, len = 24): string {
  return createHash('sha256').update(input, 'utf8').digest('hex').slice(0, len);
}

// ── Public fingerprint API ────────────────────────────────────────────────────

/**
 * Compute both fingerprint hashes for an article.
 *
 * exact:           Unique per (source, title, date, url).
 *                  Used for dedup within and across sources.
 *
 * syndication_key: Derived from first 8 words of title only.
 *                  Two articles from Reuters and AP reporting the same
 *                  event will typically share the first 8 words of their
 *                  headline — this hash catches that overlap.
 *                  Not collision-free; intended as a clustering signal.
 *
 *                  Known limitation: if one headline has fewer than 8 words
 *                  and a syndicated variant adds words after the shared prefix
 *                  (e.g. ', 5 dead'), the keys will differ. Works best when
 *                  both headlines have ≥ 8 words. Future improvement: use
 *                  min-length normalisation or Simhash for shorter headlines.
 */
export function computeFingerprint(
  title:       string,
  sourceId:    string,
  publishedAt: string,
  url?:        string,
): ArticleFingerprint {
  const norm    = normalizeTitle(title);
  const dateKey = publishedAt.slice(0, 10);                 // YYYY-MM-DD

  const exactSeed = [sourceId, norm, dateKey, url ?? ''].join('\x00');
  const exact     = sha256(exactSeed, 24);

  const syndicationSeed = firstNWords(norm, 8);
  const syndication_key = sha256(syndicationSeed, 16);

  return { exact, syndication_key };
}

// ── Index persistence ─────────────────────────────────────────────────────────

export function loadFingerprintIndex(): FingerprintIndex {
  if (!existsSync(PATHS.intelligence.fingerprintIndex)) return {};
  try {
    return JSON.parse(
      readFileSync(PATHS.intelligence.fingerprintIndex, 'utf-8'),
    ) as FingerprintIndex;
  } catch {
    return {};
  }
}

function saveIndex(index: FingerprintIndex): void {
  writeFileSync(PATHS.intelligence.fingerprintIndex, JSON.stringify(index, null, 2));
}

// ── Check + record ────────────────────────────────────────────────────────────

export interface FingerprintCheckResult {
  is_exact_duplicate: boolean;          // this exact article already seen
  is_syndicated:      boolean;          // same story seen from another source
  syndicated_sources: string[];         // which other source_ids matched
  fingerprint:        ArticleFingerprint;
}

/**
 * Check an article against the index, record it, and return the result.
 * Idempotent on re-runs: seen_count increments but no duplicate entries created.
 */
export function checkAndRecord(
  title:       string,
  sourceId:    string,
  publishedAt: string,
  url?:        string,
): FingerprintCheckResult {
  const fp    = computeFingerprint(title, sourceId, publishedAt, url);
  const index = loadFingerprintIndex();
  const now   = new Date().toISOString();

  // ── Exact match ──────────────────────────────────────────────────────────

  const exactEntry        = index[fp.exact];
  const is_exact_duplicate = !!exactEntry;

  if (!exactEntry) {
    index[fp.exact] = {
      source_id:    sourceId,
      title,
      url,
      published_at: publishedAt,
      first_seen:   now,
      seen_count:   1,
      sources_seen: [sourceId],
    };
  } else {
    exactEntry.seen_count++;
    if (!exactEntry.sources_seen.includes(sourceId)) {
      exactEntry.sources_seen.push(sourceId);
    }
  }

  // ── Syndication match ────────────────────────────────────────────────────

  const syndEntry = index[fp.syndication_key];
  const syndicated_sources = syndEntry
    ? syndEntry.sources_seen.filter(s => s !== sourceId)
    : [];
  const is_syndicated = syndicated_sources.length > 0;

  if (!syndEntry) {
    index[fp.syndication_key] = {
      source_id:    sourceId,
      title,
      url,
      published_at: publishedAt,
      first_seen:   now,
      seen_count:   1,
      sources_seen: [sourceId],
    };
  } else {
    syndEntry.seen_count++;
    if (!syndEntry.sources_seen.includes(sourceId)) {
      syndEntry.sources_seen.push(sourceId);
    }
  }

  saveIndex(index);

  return { is_exact_duplicate, is_syndicated, syndicated_sources, fingerprint: fp };
}

// ── Stats ─────────────────────────────────────────────────────────────────────

export function fingerprintStats(): {
  total_entries:         number;
  syndicated_events:     number;   // entries with >1 source
  max_sources_per_event: number;
} {
  const entries    = Object.values(loadFingerprintIndex());
  const syndicated = entries.filter(e => e.sources_seen.length > 1);
  const max        = syndicated.reduce((m, e) => Math.max(m, e.sources_seen.length), 0);
  return {
    total_entries:         entries.length,
    syndicated_events:     syndicated.length,
    max_sources_per_event: max,
  };
}
