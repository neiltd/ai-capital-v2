// Export contract mappers — internal snake_case types → external camelCase types.
//
// These are pure functions with no side effects.
// Internal pipeline types are never modified.
// Call these in run-exports.ts immediately before writing JSON to disk.

import { EXTERNAL_SCHEMA_VERSION } from './external-types.ts';
import type {
  ExternalEnvelope,
  ExternalWorldIntelEvent, ExternalWorldIntelStoryline, ExternalCountrySignal,
  ExternalWorldIntelExport,
  ExternalOilEvent, ExternalHormuzRisk, ExternalCommoditySignal, ExternalOilExport,
  ExternalMarketEvent, ExternalMacroRiskSignal, ExternalSectorExposure, ExternalStockExport,
} from './external-types.ts';
import type {
  ExportEnvelope,
  WorldIntelEvent, WorldIntelStoryline, CountrySignal, WorldIntelExport,
  OilEvent, HormuzRiskSnapshot, CommoditySignal, OilExport,
  MarketEvent, MacroRiskSignal, SectorExposure, StockExport,
} from '../types.ts';

// ── Envelope ──────────────────────────────────────────────────────────────────

function mapEnvelope(e: ExportEnvelope): ExternalEnvelope {
  return {
    schemaVersion:       EXTERNAL_SCHEMA_VERSION,
    exportType:          e.export_type,
    generatedAt:         e.generated_at,
    date:                e.date,
    requestedDate:       e.requested_date,
    isStale:             e.is_stale,
    extractionVersion:   e.extraction_version,
    eventCount:          e.event_count,
    reviewExcludedCount: e.review_excluded_count,
    uniqueSourceCount:   e.unique_source_count,
  };
}

// ── World Intelligence ────────────────────────────────────────────────────────

function mapWorldIntelEvent(e: WorldIntelEvent): ExternalWorldIntelEvent {
  return {
    eventId:              e.event_id,
    storylineId:          e.storyline_id,
    title:                e.title,
    summary:              e.summary,
    eventType:            e.event_type,
    eventState:           e.event_state,
    severity:             e.severity,
    confidence:           e.confidence_score,
    humanReviewRequired:  e.human_review_required,
    countries:            e.countries,
    lat:                  e.lat,
    lng:                  e.lng,
    coordinateQuality:    e.coordinate_quality,
    coordinateSource:     e.coordinate_source,
    geopoliticalRelevance: e.geopolitical_relevance,
    escalationPotential:  e.escalation_potential,
    marketRelevance:      e.market_relevance,
    firstSeenAt:          e.first_seen_at,
    latestSeenAt:         e.latest_seen_at,
    runsSeen:             e.runs_seen,
    sourceCount:          e.source_count,
    sourceIds:            e.source_ids,
  };
}

function mapWorldIntelStoryline(s: WorldIntelStoryline): ExternalWorldIntelStoryline {
  return {
    storylineId:       s.storyline_id,
    title:             s.title,
    storylineState:    s.storyline_state,
    countries:         s.countries,
    eventTypes:        s.event_types,
    totalEvents:       s.total_events,
    totalSources:      s.total_sources,
    uniqueSourceIds:   s.unique_source_ids,
    avgConfidence:     s.avg_confidence,
    avgEscalation:     s.avg_escalation,
    maxSeverity:       s.max_severity,
    firstSeenAt:       s.first_seen_at,
    latestSeenAt:      s.latest_seen_at,
    daysActive:        s.days_active,
    familyComposition: s.family_composition,
    cohesionSignal:    s.cohesion_signal,
    eventIds:          s.event_ids,
  };
}

function mapCountrySignal(s: CountrySignal): ExternalCountrySignal {
  return {
    country:           s.country,
    eventCount:        s.event_count,
    maxSeverity:       s.max_severity,
    avgEscalation:     s.avg_escalation,
    avgConfidence:     s.avg_confidence,
    dominantEventType: s.dominant_event_type,
    activeStorylines:  s.active_storylines,
  };
}

export function toExternalWorldIntelExport(internal: WorldIntelExport): ExternalWorldIntelExport {
  return {
    ...mapEnvelope(internal),
    exportType:     'world-intelligence',
    events:         internal.events.map(mapWorldIntelEvent),
    storylines:     internal.storylines.map(mapWorldIntelStoryline),
    countrySignals: internal.country_signals.map(mapCountrySignal),
  };
}

// ── Oil Project ───────────────────────────────────────────────────────────────

function mapOilEvent(e: OilEvent): ExternalOilEvent {
  return {
    eventId:             e.event_id,
    storylineId:         e.storyline_id,
    title:               e.title,
    summary:             e.summary,
    eventType:           e.event_type,
    severity:            e.severity,
    confidence:          e.confidence_score,
    countries:           e.countries,
    iso3:                e.countries[0] ?? '',
    escalationPotential: e.escalation_potential,
    marketRelevance:     e.market_relevance,
    isSupplyDisruption:  e.is_supply_disruption,
    isHormuzRelated:     e.is_hormuz_related,
    firstSeenAt:         e.first_seen_at,
    sourceIds:           e.source_ids,
    sourceCount:         e.source_ids.length,
    lat:                 e.lat,
    lng:                 e.lng,
    coordinateQuality:   e.coordinate_quality,
    coordinateSource:    e.coordinate_source,
    locationType:        e.location_type,
    relatedAsset:        e.related_asset,
  };
}

function mapHormuzRisk(r: HormuzRiskSnapshot): ExternalHormuzRisk {
  return {
    active:        r.active,
    riskLevel:     r.risk_level,
    maxEscalation: r.max_escalation,
    eventIds:      r.event_ids,
    updatedAt:     r.updated_at,
  };
}

function mapCommoditySignal(s: CommoditySignal): ExternalCommoditySignal {
  return {
    commodity:       s.commodity,
    signalDirection: s.signal_direction,
    intensity:       s.intensity,
    eventIds:        s.event_ids,
    eventCount:      s.event_count,
  };
}

export function toExternalOilExport(internal: OilExport): ExternalOilExport {
  return {
    ...mapEnvelope(internal),
    exportType:       'oil-project',
    hormuzRisk:       mapHormuzRisk(internal.hormuz_risk),
    energyEvents:     internal.energy_events.map(mapOilEvent),
    commoditySignals: internal.commodity_signals.map(mapCommoditySignal),
  };
}

// ── Stock Project ─────────────────────────────────────────────────────────────

function mapMarketEvent(e: MarketEvent): ExternalMarketEvent {
  return {
    eventId:         e.event_id,
    storylineId:     e.storyline_id,
    title:           e.title,
    summary:         e.summary,
    eventType:       e.event_type,
    severity:        e.severity,
    confidence:      e.confidence_score,
    countries:       e.countries,
    marketRelevance: e.market_relevance,
    marketDirection: e.market_direction,
    firstSeenAt:     e.first_seen_at,
    sourceIds:       e.source_ids,
  };
}

function mapMacroRiskSignal(s: MacroRiskSignal): ExternalMacroRiskSignal {
  return {
    riskType:         s.risk_type,
    intensity:        s.intensity,
    primaryCountries: s.primary_countries,
    eventCount:       s.event_count,
    eventIds:         s.event_ids,
    storylineIds:     s.storyline_ids,
  };
}

function mapSectorExposure(s: SectorExposure): ExternalSectorExposure {
  return {
    sector:             s.sector,
    exposure:           s.exposure,
    eventCount:         s.event_count,
    maxSeverity:        s.max_severity,
    maxMarketRelevance: s.max_market_relevance,
    eventIds:           s.event_ids,
  };
}

export function toExternalStockExport(internal: StockExport): ExternalStockExport {
  return {
    ...mapEnvelope(internal),
    exportType:       'stock-project',
    marketEvents:     internal.market_events.map(mapMarketEvent),
    macroRiskSignals: internal.macro_risk_signals.map(mapMacroRiskSignal),
    sectorExposure:   internal.sector_exposure.map(mapSectorExposure),
  };
}
