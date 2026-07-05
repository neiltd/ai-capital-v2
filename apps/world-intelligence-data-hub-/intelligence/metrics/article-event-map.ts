// Bidirectional article ↔ event mapping.
// Answers: "which events did article X contribute to?"
//
// Stored at intelligence/outputs/events/article-event-map.json
// (gitignored as derived runtime data — same directory as event output files).
//
// The other direction (event → articles) is already embedded in every
// IntelligenceEvent.sources.extracted_from, so this file only needs to
// cover article → events.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { PATHS } from '../../lib/paths.ts';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ArticleEventEntry {
  event_ids:    string[];   // events this article contributed to
  event_types:  string[];   // parallel array — type of each event
  dates:        string[];   // parallel array — date of each event
  last_updated: string;
}

export type ArticleEventIndex = Record<string, ArticleEventEntry>;

// ── Persistence ───────────────────────────────────────────────────────────────

function load(): ArticleEventIndex {
  if (!existsSync(PATHS.intelligence.articleEventMap)) return {};
  try {
    return JSON.parse(readFileSync(PATHS.intelligence.articleEventMap, 'utf-8')) as ArticleEventIndex;
  } catch {
    return {};
  }
}

function save(index: ArticleEventIndex): void {
  mkdirSync(dirname(PATHS.intelligence.articleEventMap), { recursive: true });
  writeFileSync(PATHS.intelligence.articleEventMap, JSON.stringify(index, null, 2));
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Record that a set of articles contributed to an event.
 * Idempotent — calling with the same args twice is safe.
 */
export function recordArticleEvents(
  articleIds: string[],
  eventId:    string,
  eventType:  string,
  date:       string,
): void {
  const index = load();
  const now   = new Date().toISOString();

  for (const articleId of articleIds) {
    const entry = index[articleId] ?? {
      event_ids:    [],
      event_types:  [],
      dates:        [],
      last_updated: now,
    };

    // Idempotency: don't record the same event_id twice for this article
    if (!entry.event_ids.includes(eventId)) {
      entry.event_ids.push(eventId);
      entry.event_types.push(eventType);
      entry.dates.push(date);
    }

    entry.last_updated = now;
    index[articleId]   = entry;
  }

  save(index);
}

/** Return all event_ids that a given article contributed to. */
export function getEventsForArticle(articleId: string): string[] {
  return load()[articleId]?.event_ids ?? [];
}

/** Return article_ids for a given event_id (cross-index lookup). */
export function getArticlesForEvent(eventId: string): string[] {
  const index = load();
  return Object.entries(index)
    .filter(([, entry]) => entry.event_ids.includes(eventId))
    .map(([articleId]) => articleId);
}

/** Summary stats for the map. */
export function mapStats(): { total_articles: number; total_mappings: number; multi_event_articles: number } {
  const index = load();
  const entries = Object.values(index);
  return {
    total_articles:       entries.length,
    total_mappings:       entries.reduce((sum, e) => sum + e.event_ids.length, 0),
    multi_event_articles: entries.filter(e => e.event_ids.length > 1).length,
  };
}
