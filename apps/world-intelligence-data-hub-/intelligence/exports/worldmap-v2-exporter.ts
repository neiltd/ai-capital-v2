// Transforms IntelligenceEvent[] into worldmaphistory_v2's ImportedEvent schema.
//
// v2 uses a different import format than the generic intelligence.json:
//   - Reads from public/data/imports/events.json (not intelligence.json)
//   - Validates with Zod against src/data/schemas/imports.ts
//   - Expects schemaVersion, source, eventType enum, tier, confidenceLabel, etc.
//
// This adapter bridges the two schemas so v2 loads intelligence events
// through its existing adapter pipeline without modification.

import type { IntelligenceEvent } from '../schema/intelligence-event.ts';
import type { HumanIntelRecord } from '../human/store.ts';
import type { EventAnalysis }    from '../../admin/types.ts';

// ── Event type mapping ────────────────────────────────────────────────────────
// Maps Data Hub event_type → v2 eventType enum

type V2EventType =
  | 'conflict.armed' | 'conflict.protest' | 'conflict.riot' | 'conflict.cyberattack'
  | 'diplomatic.cooperation' | 'diplomatic.dispute'
  | 'economic.sanctions' | 'economic.trade'
  | 'energy.disruption'
  | 'political.election' | 'political.coup' | 'political.policy'
  | 'humanitarian.disaster' | 'humanitarian.crisis'
  | 'other';

const EVENT_TYPE_MAP: Record<string, V2EventType> = {
  armed_conflict:        'conflict.armed',
  airstrike:             'conflict.armed',
  missile_attack:        'conflict.armed',
  military_operation:    'conflict.armed',
  military_exercise:     'diplomatic.cooperation',
  nuclear_incident:      'conflict.armed',
  assassination:         'conflict.armed',
  terrorist_attack:      'conflict.armed',
  coup:                  'political.coup',
  election:              'political.election',
  protest:               'conflict.protest',
  regime_change:         'political.coup',
  diplomatic_incident:   'diplomatic.dispute',
  sanctions:             'economic.sanctions',
  treaty:                'diplomatic.cooperation',
  peace_negotiation:     'diplomatic.cooperation',
  referendum:            'political.policy',
  supply_disruption:     'energy.disruption',
  trade_dispute:         'economic.trade',
  market_crash:          'economic.trade',
  central_bank_action:   'economic.trade',
  economic_data_release: 'economic.trade',
  debt_crisis:           'economic.trade',
  commodity_price_move:  'energy.disruption',
  opec_decision:         'energy.disruption',
  energy_infrastructure: 'energy.disruption',
  humanitarian_crisis:   'humanitarian.crisis',
  refugee_movement:      'humanitarian.crisis',
  natural_disaster:      'humanitarian.disaster',
  epidemic:              'humanitarian.crisis',
  other:                 'other',
};

function toV2EventType(type: string): V2EventType {
  return EVENT_TYPE_MAP[type] ?? 'other';
}

function toTier(severity: number): 1 | 2 | 3 {
  if (severity >= 4) return 1;  // global impact
  if (severity === 3) return 2;  // regional
  return 3;                      // local / monitoring
}

function toConfidenceLabel(score: number): 'high' | 'medium' | 'low' {
  if (score >= 0.75) return 'high';
  if (score >= 0.55) return 'medium';
  return 'low';
}

// ── v2 schema output types ─────────────────────────────────────────────────────

interface V2ImportedEvent {
  id:               string;
  source:           'rss_intelligence' | 'manual';
  eventDate:        string;
  iso3:             string[];
  eventType:        V2EventType;
  headline:         string;
  summary?:         string;
  coordinateQuality?: string;
  confidenceScore:  number;
  confidenceLabel:  'high' | 'medium' | 'low';
  tier:             1 | 2 | 3;
  tags?:            string[];
  geopoliticalScore?:   number;
  economicImpactScore?: number;
  analysis?: {
    what_happened:      string;
    historical_context: string;
    political_analysis: string;
    social_analysis:    string;
    actor_goals:        Array<{ name: string; stated_goal: string; real_goal: string; red_lines: string }>;
    bloc_perspectives:  Array<{ bloc: string; how_they_see_it: string; their_interest: string; internal_tension: string }>;
    what_to_watch:      string[];
    confidence:         { score: number; reasoning: string };
  };
}

interface V2EventsFile {
  schemaVersion: string;
  generatedAt:   string;
  source:        string;
  eventCount:    number;
  dateRange: {
    from: string;
    to:   string;
  };
  events: V2ImportedEvent[];
}

interface V2ManifestFile {
  schemaVersion: string;
  generatedAt:   string;
  hub:           string;
  contents: {
    events: { count: number; from: string; to: string };
    energyIndicators: { count: number; asOf: string };
    macroIndicators:  { countryCount: number; indicatorCount: number; asOf: string };
  };
}

// ── Transform ──────────────────────────────────────────────────────────────────

export function buildV2EventsFile(
  events:    IntelligenceEvent[],
  date:      string,
): V2EventsFile {
  // Exclude human-review-required events — same policy as intelligence.json
  const verified = events.filter(e => !e.sources.human_review_required);

  const v2Events: V2ImportedEvent[] = verified.map(e => {
    const sourceIds = [...new Set(e.sources.extracted_from.map(r => r.source_id))];
    const tags = [
      ...sourceIds,
      ...(e.lifecycle?.storyline_id ? [`storyline:${e.lifecycle.storyline_id.slice(0, 8)}`] : []),
    ];

    return {
      id:              e.event_id,
      source:          'rss_intelligence',
      eventDate:       date,
      iso3:            e.geography.countries.filter(c => /^[A-Z]{3}$/.test(c)),
      eventType:       toV2EventType(e.event.event_type),
      headline:        e.event.title,
      summary:         e.event.summary,
      confidenceScore: e.event.confidence_score,
      confidenceLabel: toConfidenceLabel(e.event.confidence_score),
      // RSS-sourced events carry no coordinates from this pipeline — signal that
      // explicitly rather than leaving coordinateQuality undefined, so the
      // frontend's `=== 'missing'` branch (imports.ts) fires as documented.
      coordinateQuality: 'missing',
      tier:            toTier(e.event.severity),
      tags:            tags.length > 0 ? tags : undefined,
      geopoliticalScore:   Math.round(e.geopolitical_scores.relevance * 10 * 10) / 10,
      economicImpactScore: Math.round((e.market_impact?.relevance ?? 0) * 10 * 10) / 10,
    };
  });

  const dates = verified.map(e => e.identity.first_seen_at.slice(0, 10)).sort();

  return {
    schemaVersion: '1.0.0',
    generatedAt:   new Date().toISOString(),
    source:        'world-intelligence-hub',
    eventCount:    v2Events.length,
    dateRange: {
      from: dates[0] ?? date,
      to:   dates[dates.length - 1] ?? date,
    },
    events: v2Events,
  };
}

export function buildV2Manifest(
  eventCount: number,
  date:       string,
): V2ManifestFile {
  return {
    schemaVersion: '1.0.0',
    generatedAt:   new Date().toISOString(),
    hub:           'world-intelligence-hub',
    contents: {
      events: { count: eventCount, from: date, to: date },
      // Energy and macro not yet produced by intelligence pipeline
      energyIndicators: { count: 0, asOf: date },
      macroIndicators:  { countryCount: 0, indicatorCount: 0, asOf: date },
    },
  };
}

export function buildV2HumanEventEntry(
  record:    HumanIntelRecord,
  analysis?: EventAnalysis,
): V2ImportedEvent | null {
  if (!record.extracted.event_type) return null;
  const iso3s = record.extracted.countries.filter(c => /^[A-Z]{3}$/.test(c));
  if (iso3s.length === 0) return null;

  return {
    id:               record.id,
    source:           'manual',
    eventDate:        record.submitted_at.slice(0, 10),
    iso3:             iso3s,
    eventType:        toV2EventType(record.extracted.event_type),
    headline:         record.extracted.title,
    coordinateQuality: 'country_centroid',
    confidenceScore:  record.extracted.confidence,
    confidenceLabel:  toConfidenceLabel(record.extracted.confidence),
    tier:             2,
    tags:             record.extracted.tags.length > 0 ? record.extracted.tags : undefined,
    analysis: analysis ? {
      what_happened:      analysis.what_happened,
      historical_context: analysis.historical_context,
      political_analysis: analysis.political_analysis,
      social_analysis:    analysis.social_analysis,
      actor_goals:        analysis.actor_goals,
      bloc_perspectives:  analysis.bloc_perspectives,
      what_to_watch:      analysis.what_to_watch,
      confidence:         analysis.confidence,
    } : undefined,
  };
}
