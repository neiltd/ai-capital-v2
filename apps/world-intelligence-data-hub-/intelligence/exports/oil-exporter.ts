import type { IntelligenceEvent } from '../schema/intelligence-event.ts';
import type {
  OilExport, OilEvent, HormuzRiskSnapshot, HormuzRiskLevel, CommoditySignal,
  CoordinateQuality, OilLocationType,
} from './types.ts';
import { resolveCoordinates } from './world-intel-exporter.ts';

// ── Oil-relevant event types ──────────────────────────────────────────────────

const OIL_EVENT_TYPES = new Set([
  'supply_disruption', 'energy_infrastructure', 'opec_decision',
  'commodity_price_move', 'economic_data_release',
]);

// Secondary: these types are included if they involve energy countries + high market_relevance
const SECONDARY_OIL_TYPES = new Set([
  'trade_dispute', 'sanctions', 'armed_conflict', 'airstrike',
  'military_operation', 'humanitarian_crisis',
]);

// Persian Gulf + key energy-producing/transit countries
const OIL_COUNTRIES = new Set([
  'IRN', 'SAU', 'ARE', 'QAT', 'KWT', 'OMN', 'IRQ', 'YEM',  // Gulf
  'EGY',                                                       // Suez
  'RUS', 'AZE', 'KAZ',                                        // Caspian/CIS
  'LBY', 'NGA', 'AGO', 'DZA', 'SDN',                         // Africa
  'VEN', 'ECU', 'BRA', 'COL',                                 // LatAm
  'NOR', 'GBR',                                               // North Sea
]);

// Hormuz-adjacent countries: events here directly implicate the strait
const HORMUZ_COUNTRIES = new Set(['IRN', 'ARE', 'OMN', 'QAT', 'KWT', 'SAU', 'USA']);

// ── Helpers ───────────────────────────────────────────────────────────────────

function avg(nums: number[]): number {
  if (nums.length === 0) return 0;
  return Math.round((nums.reduce((a, b) => a + b, 0) / nums.length) * 1000) / 1000;
}

function uniqueSourceIds(event: IntelligenceEvent): string[] {
  return [...new Set(event.sources.extracted_from.map(r => r.source_id))];
}

function isOilEvent(e: IntelligenceEvent): boolean {
  if (e.sources.human_review_required) return false;
  if (OIL_EVENT_TYPES.has(e.event.event_type)) return true;
  if (
    SECONDARY_OIL_TYPES.has(e.event.event_type) &&
    e.geography.countries.some(c => OIL_COUNTRIES.has(c)) &&
    (e.market_impact?.relevance ?? 0) > 0.40
  ) return true;
  return false;
}

function isHormuzRelated(e: IntelligenceEvent): boolean {
  return (
    e.geography.countries.some(c => HORMUZ_COUNTRIES.has(c)) &&
    ['supply_disruption', 'energy_infrastructure', 'military_operation',
     'airstrike', 'armed_conflict'].includes(e.event.event_type)
  );
}

// ── Hormuz risk ───────────────────────────────────────────────────────────────

function computeHormuzRisk(events: IntelligenceEvent[]): HormuzRiskSnapshot {
  const relevant = events.filter(e =>
    !e.sources.human_review_required && isHormuzRelated(e),
  );

  if (relevant.length === 0) {
    return {
      active:        false,
      risk_level:    'low',
      max_escalation: 0,
      event_ids:     [],
      updated_at:    new Date().toISOString(),
    };
  }

  const maxEsc = Math.max(...relevant.map(e => e.geopolitical_scores.escalation_potential));
  const level: HormuzRiskLevel =
    maxEsc >= 0.85 ? 'critical' :
    maxEsc >= 0.65 ? 'high' :
    maxEsc >= 0.45 ? 'elevated' :
    'low';

  return {
    active:         level !== 'low',
    risk_level:     level,
    max_escalation: maxEsc,
    event_ids:      relevant.map(e => e.event_id),
    updated_at:     new Date().toISOString(),
  };
}

// ── Commodity signals ─────────────────────────────────────────────────────────

const COMMODITY_KEYWORDS: Record<string, string[]> = {
  oil:        ['oil', 'crude', 'petroleum', 'barrel', 'opec', 'hormuz', 'gasoline', 'refinery', 'brent', 'wti'],
  gas:        ['gas', 'lng', 'natural gas', 'pipeline', 'methane', 'energy price'],
  gold:       ['gold', 'bullion', 'precious metal', 'safe haven'],
  fertilizer: ['fertilizer', 'food security', 'grain', 'wheat', 'agriculture', 'potash'],
};

function detectCommoditySignal(
  commodity: 'oil' | 'gas' | 'gold' | 'fertilizer',
  events: IntelligenceEvent[],
): CommoditySignal {
  const keywords = COMMODITY_KEYWORDS[commodity]!;
  const normalize = (s: string) => s.toLowerCase();

  const relevant = events.filter(e => {
    if (e.sources.human_review_required) return false;
    const text = normalize(`${e.event.title} ${e.event.summary}`);
    return keywords.some(k => text.includes(k));
  });

  if (relevant.length === 0) {
    return { commodity, signal_direction: 'neutral', intensity: 0, event_ids: [], event_count: 0 };
  }

  // Infer direction from market_impact if available, else uncertain
  const directions = relevant.map(e => e.market_impact?.direction ?? 'uncertain');
  const dir = directions.filter(d => d !== 'uncertain');
  const dominant = dir.length > 0
    ? (dir.filter(d => d === 'bearish').length > dir.filter(d => d === 'bullish').length ? 'down'
       : dir.filter(d => d === 'bullish').length > dir.filter(d => d === 'bearish').length ? 'up'
       : 'uncertain')
    : 'uncertain';

  return {
    commodity,
    signal_direction: dominant as CommoditySignal['signal_direction'],
    intensity:        avg(relevant.map(e => e.market_impact?.relevance ?? 0)),
    event_ids:        relevant.map(e => e.event_id),
    event_count:      relevant.length,
  };
}

// Coordinate quality → oil location type. resolveCoordinates() doesn't know
// about oil-specific concepts (chokepoints, infrastructure), so this only
// derives the granularity level it can infer from the quality signal itself.
function toOilLocationType(quality: CoordinateQuality | undefined): OilLocationType | undefined {
  if (quality === 'country_centroid') return 'country';
  if (quality === 'source_exact' || quality === 'source_approx') return 'unknown';
  return undefined;
}

// ── Event projection ──────────────────────────────────────────────────────────

function projectOilEvent(e: IntelligenceEvent): OilEvent {
  const coords = resolveCoordinates(e);
  return {
    event_id:            e.event_id,
    storyline_id:        e.lifecycle?.storyline_id,
    title:               e.event.title,
    summary:             e.event.summary,
    event_type:          e.event.event_type,
    severity:            e.event.severity,
    confidence_score:    e.event.confidence_score,
    countries:           e.geography.countries,
    escalation_potential: e.geopolitical_scores.escalation_potential,
    market_relevance:    e.market_impact?.relevance ?? 0,
    is_supply_disruption: e.event.event_type === 'supply_disruption',
    is_hormuz_related:   isHormuzRelated(e),
    first_seen_at:       e.identity.first_seen_at,
    source_ids:          uniqueSourceIds(e),
    ...coords,
    location_type:       toOilLocationType(coords.coordinate_quality),
  };
}

// ── Public builder ────────────────────────────────────────────────────────────

export function buildOilExport(
  date:       string,
  events:     IntelligenceEvent[],
  extractionVersion: string,
): OilExport {
  const oilEvents = events.filter(isOilEvent);

  const excluded = events.filter(e => e.sources.human_review_required);
  const srcIds   = new Set(oilEvents.flatMap(e => e.sources.extracted_from.map(r => r.source_id)));

  return {
    schema_version:        '1.0',
    export_type:           'oil-project',
    generated_at:          new Date().toISOString(),
    date,
    extraction_version:    extractionVersion,
    event_count:           oilEvents.length,
    review_excluded_count: excluded.length,
    unique_source_count:   srcIds.size,
    hormuz_risk:           computeHormuzRisk(events),
    energy_events:         oilEvents.map(projectOilEvent),
    commodity_signals: [
      detectCommoditySignal('oil',        events),
      detectCommoditySignal('gas',        events),
      detectCommoditySignal('gold',       events),
      detectCommoditySignal('fertilizer', events),
    ].filter(s => s.event_count > 0),
  };
}
