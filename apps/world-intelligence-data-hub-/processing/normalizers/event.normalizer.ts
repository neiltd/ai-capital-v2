import { createHash } from 'crypto';
import type { EventRecord } from '../../lib/types.ts';
import { inferCountry, inferEventType, inferSeverity } from '../../lib/inference.ts';
import type { NewsAPIResponse, NewsAPIArticle } from '../../ingestion/clients/newsapi.ts';
import type { ACLEDResponse, ACLEDEvent } from '../../ingestion/clients/acled.ts';
import type { GDELTResponse, GDELTArticle } from '../../ingestion/clients/gdelt.ts';
import type { UCDPResponse, UCDPEvent } from '../../ingestion/clients/ucdp.ts';

// ── Helpers ───────────────────────────────────────────────────────────────────

function shortHash(data: unknown): string {
  return createHash('sha256').update(JSON.stringify(data)).digest('hex').slice(0, 16);
}

function stableId(source: string, seed: string): string {
  return createHash('sha256').update(`${source}:${seed}`).digest('hex').slice(0, 20);
}

function safeFloat(v: string | number | null | undefined): number | null {
  const n = parseFloat(String(v));
  return isNaN(n) ? null : n;
}

// ── NewsAPI → EventRecord[] ───────────────────────────────────────────────────

export function normalizeNewsAPI(raw: unknown, fetchedAt: string): EventRecord[] {
  const response = raw as NewsAPIResponse;
  if (!Array.isArray(response.articles)) return [];

  return response.articles
    .filter((a): a is NewsAPIArticle => !!a.title && !!a.publishedAt)
    .map((article): EventRecord => {
      const text   = `${article.title} ${article.description ?? ''}`;
      const date   = article.publishedAt.slice(0, 10);
      return {
        id:          stableId('newsapi', article.url),
        source:      'newsapi',
        type:        inferEventType(text),
        title:       article.title.slice(0, 255),
        description: article.description ?? '',
        country:     inferCountry(text),
        lat:         null,   // NewsAPI has no geo
        lng:         null,
        severity:    inferSeverity(text),
        date,
        fetchedAt,
        rawHash:     shortHash(article),
      };
    });
}

// ── ACLED → EventRecord[] ─────────────────────────────────────────────────────

const ACLED_TYPE_MAP: Record<string, EventRecord['type']> = {
  'Battles':              'conflict',
  'Explosions/Remote violence': 'conflict',
  'Violence against civilians': 'conflict',
  'Protests':             'political',
  'Riots':                'political',
  'Strategic developments': 'political',
};

export function normalizeACLED(raw: unknown, fetchedAt: string): EventRecord[] {
  const response = raw as ACLEDResponse;
  if (!Array.isArray(response.data)) return [];

  return response.data
    .filter((e): e is ACLEDEvent => !!e.event_id_cnty && !!e.event_date)
    .map((event): EventRecord => {
      const text  = `${event.event_type} ${event.sub_event_type} ${event.notes ?? ''}`;
      const lat   = safeFloat(event.latitude);
      const lng   = safeFloat(event.longitude);
      return {
        id:          stableId('acled', event.event_id_cnty),
        source:      'acled',
        type:        ACLED_TYPE_MAP[event.event_type] ?? inferEventType(text),
        title:       `${event.event_type}: ${event.location}, ${event.country}`.slice(0, 255),
        description: event.notes ?? '',
        country:     event.iso3 ?? inferCountry(event.country),
        lat:         lat,
        lng:         lng,
        severity:    inferSeverity(text, event.fatalities),
        date:        event.event_date,
        fetchedAt,
        rawHash:     shortHash(event),
      };
    });
}

// ── UCDP → EventRecord[] ──────────────────────────────────────────────────────
// UCDP is the academic counterpart to ACLED — structured conflict events with
// lat/lng + fatality estimates + actor sides. We map their numeric
// type_of_violence into our event-type vocabulary, derive severity from
// `best` (UCDP's most-likely fatality estimate) similar to how ACLED uses
// `fatalities`, and translate the free-text country name through inferCountry
// to ISO3.

// EventType is a narrow 5-value union; all 3 UCDP violence types map to 'conflict'.
const UCDP_VIOLENCE_TYPE_MAP: Record<number, EventRecord['type']> = {
  1: 'conflict',  // state-based (gov vs rebel / state vs state)
  2: 'conflict',  // non-state (rebel vs rebel)
  3: 'conflict',  // one-sided violence against civilians
};

export function normalizeUCDP(raw: unknown, fetchedAt: string): EventRecord[] {
  const response = raw as UCDPResponse;
  if (!Array.isArray(response.Result)) return [];

  return response.Result
    .filter((e): e is UCDPEvent => !!e.id && !!e.date_start)
    .map((event): EventRecord => {
      const text = [
        event.conflict_name ?? '',
        event.side_a ?? '',
        event.side_b ?? '',
        event.source_headline ?? '',
        event.source_article ?? '',
      ].filter(Boolean).join(' ');
      const fatalities = event.best ?? event.high ?? null;
      const lat = safeFloat(event.latitude);
      const lng = safeFloat(event.longitude);
      // Prefer source_headline as title when available; fall back to conflict
      // + country so the briefing always has a readable label.
      const title = event.source_headline
        ?? `${event.conflict_name ?? 'Conflict event'}: ${event.country}`;
      return {
        id:          stableId('ucdp', String(event.id)),
        source:      'ucdp',
        type:        UCDP_VIOLENCE_TYPE_MAP[event.type_of_violence] ?? inferEventType(text),
        title:       title.slice(0, 255),
        description: event.source_article ?? '',
        country:     inferCountry(event.country),
        lat,
        lng,
        severity:    inferSeverity(text, fatalities ?? undefined),
        date:        event.date_start.slice(0, 10),
        fetchedAt,
        rawHash:     shortHash(event),
      };
    });
}

// ── GDELT → EventRecord[] ─────────────────────────────────────────────────────

function parseGDELTDate(seendate: string): string {
  // Format: YYYYMMDDTHHMMSSZ  →  YYYY-MM-DD
  if (seendate.length >= 8) {
    return `${seendate.slice(0, 4)}-${seendate.slice(4, 6)}-${seendate.slice(6, 8)}`;
  }
  return new Date().toISOString().slice(0, 10);
}

export function normalizeGDELT(raw: unknown, fetchedAt: string): EventRecord[] {
  const response = raw as GDELTResponse;
  if (!Array.isArray(response.articles)) return [];

  return response.articles
    .filter((a): a is GDELTArticle => !!a.title && !!a.url)
    .map((article): EventRecord => {
      const text = article.title;
      const date = parseGDELTDate(article.seendate ?? '');
      return {
        id:          stableId('gdelt', article.url),
        source:      'gdelt',
        type:        inferEventType(text),
        title:       text.slice(0, 255),
        description: '',
        country:     inferCountry(text),
        lat:         null,
        lng:         null,
        severity:    inferSeverity(text),
        date,
        fetchedAt,
        rawHash:     shortHash(article),
      };
    });
}
