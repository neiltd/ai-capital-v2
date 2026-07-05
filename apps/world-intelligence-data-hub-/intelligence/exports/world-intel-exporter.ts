import type { IntelligenceEvent } from '../schema/intelligence-event.ts';
import type { Storyline }          from '../schema/storyline.ts';
import type {
  WorldIntelExport, WorldIntelEvent, WorldIntelStoryline, CountrySignal,
  CoordinateQuality,
} from './types.ts';
import { getCountryCentroid } from '../../lib/geocoding/country-centroids.ts';

// ── Helpers ───────────────────────────────────────────────────────────────────

function avg(nums: number[]): number {
  if (nums.length === 0) return 0;
  return Math.round((nums.reduce((a, b) => a + b, 0) / nums.length) * 1000) / 1000;
}

function mostFrequent(items: string[]): string {
  const counts: Record<string, number> = {};
  for (const s of items) counts[s] = (counts[s] ?? 0) + 1;
  return Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'other';
}

function uniqueSourceIds(event: IntelligenceEvent): string[] {
  return [...new Set(event.sources.extracted_from.map(r => r.source_id))];
}

// ── Coordinate resolution ─────────────────────────────────────────────────────
// Priority: AI-extracted coordinates → country centroid → missing.
// Quality labels follow the PM coordinate strategy (Data Hub canonical enum).

export function resolveCoordinates(e: IntelligenceEvent): {
  lat?:                number;
  lng?:                number;
  coordinate_quality?: CoordinateQuality;
  coordinate_source?:  string;
} {
  if (e.geography.coordinates) {
    const { lat, lng, precision } = e.geography.coordinates;
    const quality: CoordinateQuality =
      precision === 'exact' ? 'source_exact' : 'source_approx';
    return { lat, lng, coordinate_quality: quality, coordinate_source: 'ai-extracted' };
  }

  const primaryISO3 = e.geography.countries[0];
  if (primaryISO3) {
    const centroid = getCountryCentroid(primaryISO3);
    if (centroid) {
      return {
        lat:                centroid.lat,
        lng:                centroid.lng,
        coordinate_quality: 'country_centroid',
        coordinate_source:  'country-centroid',
      };
    }
  }

  return { coordinate_quality: 'missing' };
}

// ── Event projection ──────────────────────────────────────────────────────────

function projectEvent(e: IntelligenceEvent): WorldIntelEvent {
  const coords = resolveCoordinates(e);
  return {
    event_id:              e.event_id,
    storyline_id:          e.lifecycle?.storyline_id,
    title:                 e.event.title,
    summary:               e.event.summary,
    event_type:            e.event.event_type,
    event_state:           e.lifecycle?.event_state,
    severity:              e.event.severity,
    confidence_score:      e.event.confidence_score,
    human_review_required: e.sources.human_review_required,
    countries:             e.geography.countries,
    ...coords,
    geopolitical_relevance: e.geopolitical_scores.relevance,
    escalation_potential:  e.geopolitical_scores.escalation_potential,
    market_relevance:      e.market_impact?.relevance ?? 0,
    first_seen_at:         e.identity.first_seen_at,
    latest_seen_at:        e.identity.last_enriched_at,
    runs_seen:             e.sources.runs_seen ?? 1,
    source_count:          e.sources.source_count,
    source_ids:            uniqueSourceIds(e),
  };
}

// ── Storyline projection ──────────────────────────────────────────────────────

function projectStoryline(s: Storyline): WorldIntelStoryline {
  return {
    storyline_id:       s.storyline_id,
    title:              s.title,
    storyline_state:    s.storyline_state,
    countries:          s.countries,
    event_types:        s.event_types,
    total_events:       s.total_events,
    total_sources:      s.total_sources,
    unique_source_ids:  s.unique_source_ids ?? [],
    avg_confidence:     s.avg_confidence,
    avg_escalation:     s.avg_escalation,
    max_severity:       s.max_severity,
    first_seen_at:      s.first_seen_at,
    latest_seen_at:     s.latest_seen_at,
    days_active:        s.days_active,
    family_composition: s.family_composition ?? {},
    cohesion_signal:    s.cohesion_signal,
    event_ids:          s.event_ids,
  };
}

// ── Country signals ───────────────────────────────────────────────────────────

function buildCountrySignals(events: IntelligenceEvent[]): CountrySignal[] {
  const byCountry = new Map<string, IntelligenceEvent[]>();
  for (const e of events) {
    for (const c of e.geography.countries) {
      if (!byCountry.has(c)) byCountry.set(c, []);
      byCountry.get(c)!.push(e);
    }
  }

  return [...byCountry.entries()]
    .map(([country, evs]): CountrySignal => ({
      country,
      event_count:         evs.length,
      max_severity:        Math.max(...evs.map(e => e.event.severity)) as 1|2|3|4|5,
      avg_escalation:      avg(evs.map(e => e.geopolitical_scores.escalation_potential)),
      avg_confidence:      avg(evs.map(e => e.event.confidence_score)),
      dominant_event_type: mostFrequent(evs.map(e => e.event.event_type)),
      active_storylines:   [...new Set(
        evs.map(e => e.lifecycle?.storyline_id).filter((id): id is string => Boolean(id)),
      )],
    }))
    .sort((a, b) => b.event_count - a.event_count);
}

// ── Public builder ────────────────────────────────────────────────────────────

export function buildWorldIntelExport(
  date:       string,
  events:     IntelligenceEvent[],
  storylines: Storyline[],
  extractionVersion: string,
): WorldIntelExport {
  // Exclude human-review-required events from the exported view — these
  // are internally flagged and not yet verified for downstream consumption.
  // Consumers that need unverified events can set an include_unverified flag
  // in a future schema version.
  const verified  = events.filter(e => !e.sources.human_review_required);
  const excluded  = events.filter(e =>  e.sources.human_review_required);
  const srcIds    = new Set(verified.flatMap(e => e.sources.extracted_from.map(r => r.source_id)));

  return {
    schema_version:        '1.0',
    export_type:           'world-intelligence',
    generated_at:          new Date().toISOString(),
    date,
    extraction_version:    extractionVersion,
    event_count:           verified.length,
    review_excluded_count: excluded.length,
    unique_source_count:   srcIds.size,
    events:                verified.map(projectEvent),
    storylines:            storylines.filter(s => s.storyline_state !== 'fading').map(projectStoryline),
    country_signals:       buildCountrySignals(verified),
  };
}
