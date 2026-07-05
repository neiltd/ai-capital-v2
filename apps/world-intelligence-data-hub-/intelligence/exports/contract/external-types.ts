// External consumer contract — stable camelCase interfaces for all downstream consumers.
//
// STABILITY GUARANTEE:
//   - These types are the authoritative schema for exported JSON files.
//   - Internal types (intelligence/exports/types.ts) remain snake_case and are never
//     exposed directly to consumers.
//   - Fields are never renamed or removed within a schemaVersion.
//   - New optional fields may be added in minor releases.
//   - Breaking changes increment the schemaVersion major version.
//
// schemaVersion: '2.0' — all exports using this file carry this version string.
// Consumers should gate on schemaVersion before parsing field values.
//
// Backward compatibility: exports with schema_version '1.0' (note: snake_case key)
// are the legacy format. Consumers can detect legacy by checking for the presence
// of the camelCase schemaVersion key.

export const EXTERNAL_SCHEMA_VERSION = '2.0';

// ── Shared coordinate/location enums ─────────────────────────────────────────

export type CoordinateQuality =
  | 'source_exact'     // confirmed GPS or address from source (e.g. ACLED field report)
  | 'source_approx'    // geocoded city/district level from source or AI extraction
  | 'country_centroid' // geographic centroid of primary country — no sub-national location known
  | 'missing';         // no coordinates; do not render as a map marker

export type OilLocationType =
  | 'point'          // precise GPS facility
  | 'city'           // city-level (e.g. Basra, Abadan)
  | 'region'         // sub-national region or province
  | 'country'        // country-level only
  | 'chokepoint'     // named maritime chokepoint (Hormuz, Bab-el-Mandeb, Malacca, Suez)
  | 'infrastructure' // oil/gas infrastructure (pipeline, terminal, refinery, platform)
  | 'offshore'       // offshore area without precise location
  | 'unknown';

// ── Shared export envelope ────────────────────────────────────────────────────

export interface ExternalEnvelope {
  schemaVersion:       string;  // '2.0'
  exportType:          string;  // 'world-intelligence' | 'oil-project' | 'stock-project'
  generatedAt:         string;  // ISO datetime of this export run
  date:                string;  // YYYY-MM-DD pipeline run date the data actually represents
  requestedDate?:      string;  // YYYY-MM-DD originally requested — may differ from `date`
                                 // when the pipeline fell back to older data
  isStale?:            boolean; // true when requestedDate !== date (fallback occurred)
  extractionVersion:   string;  // reporter version that produced the events
  eventCount:          number;  // verified events included
  reviewExcludedCount: number;  // events withheld — pending human review
  uniqueSourceCount:   number;  // distinct RSS outlets contributing
}

// ── World Intelligence export ─────────────────────────────────────────────────

export interface ExternalWorldIntelEvent {
  eventId:              string;
  storylineId?:         string;

  title:                string;
  summary:              string;
  eventType:            string;
  eventState?:          string;  // 'emerging' | 'developing' | 'confirmed' | 'contested'

  severity:             number;  // 1–5
  confidence:           number;  // 0–1 (was confidence_score)
  humanReviewRequired?: boolean;

  countries:            string[];  // ISO3, primary country first

  lat?:                 number;
  lng?:                 number;
  coordinateQuality?:   CoordinateQuality;
  coordinateSource?:    string;   // 'ai-extracted' | 'country-centroid' | 'acled-field'

  geopoliticalRelevance: number;
  escalationPotential:   number;
  marketRelevance:       number;

  firstSeenAt:          string;
  latestSeenAt?:        string;
  runsSeen:             number;
  sourceCount:          number;
  sourceIds:            string[];
}

export interface ExternalWorldIntelStoryline {
  storylineId:       string;
  title:             string;
  storylineState:    string;
  countries:         string[];
  eventTypes:        string[];
  totalEvents:       number;
  totalSources:      number;
  uniqueSourceIds:   string[];
  avgConfidence:     number;
  avgEscalation:     number;
  maxSeverity:       number;
  firstSeenAt:       string;
  latestSeenAt:      string;
  daysActive:        number;
  familyComposition: Record<string, number>;
  cohesionSignal?:   string;
  eventIds:          string[];
}

export interface ExternalCountrySignal {
  country:           string;
  eventCount:        number;
  maxSeverity:       number;
  avgEscalation:     number;
  avgConfidence:     number;
  dominantEventType: string;
  activeStorylines:  string[];
}

export interface ExternalWorldIntelExport extends ExternalEnvelope {
  exportType:      'world-intelligence';
  events:          ExternalWorldIntelEvent[];
  storylines:      ExternalWorldIntelStoryline[];
  countrySignals:  ExternalCountrySignal[];
}

// ── Oil project export ────────────────────────────────────────────────────────

export type HormuzRiskLevel = 'low' | 'elevated' | 'high' | 'critical';

export interface ExternalHormuzRisk {
  active:        boolean;
  riskLevel:     HormuzRiskLevel;
  maxEscalation: number;
  eventIds:      string[];
  updatedAt:     string;
}

export interface ExternalOilEvent {
  eventId:            string;
  storylineId?:       string;
  title:              string;
  summary:            string;
  eventType:          string;
  severity:           number;
  confidence:         number;
  countries:          string[];
  iso3:               string;  // primary country convenience (countries[0])
  escalationPotential: number;
  marketRelevance:    number;
  isSupplyDisruption: boolean;
  isHormuzRelated:    boolean;
  firstSeenAt:        string;
  sourceIds:          string[];
  sourceCount:        number;
  lat?:               number;
  lng?:               number;
  coordinateQuality?: CoordinateQuality;
  coordinateSource?:  string;
  locationType?:      OilLocationType;
  relatedAsset?:      string;
}

export interface ExternalCommoditySignal {
  commodity:       'oil' | 'gas' | 'gold' | 'fertilizer';
  signalDirection: 'up' | 'down' | 'neutral' | 'uncertain';
  intensity:       number;
  eventIds:        string[];
  eventCount:      number;
}

export interface ExternalOilExport extends ExternalEnvelope {
  exportType:       'oil-project';
  hormuzRisk:       ExternalHormuzRisk;
  energyEvents:     ExternalOilEvent[];
  commoditySignals: ExternalCommoditySignal[];
}

// ── Stock project export ──────────────────────────────────────────────────────

export interface ExternalMarketEvent {
  eventId:         string;
  storylineId?:    string;
  title:           string;
  summary:         string;
  eventType:       string;
  severity:        number;
  confidence:      number;
  countries:       string[];
  marketRelevance: number;
  marketDirection: string;
  firstSeenAt:     string;
  sourceIds:       string[];
}

export type MacroRiskType =
  | 'inflation_rate' | 'supply_shock' | 'sanctions'
  | 'geopolitical_conflict' | 'currency_stress' | 'debt_crisis';

export interface ExternalMacroRiskSignal {
  riskType:         MacroRiskType;
  intensity:        number;
  primaryCountries: string[];
  eventCount:       number;
  eventIds:         string[];
  storylineIds:     string[];
}

export type SectorName    = 'energy' | 'defense' | 'finance' | 'commodities' | 'tech' | 'other';
export type ExposureLevel = 'high' | 'medium' | 'low';

export interface ExternalSectorExposure {
  sector:            SectorName;
  exposure:          ExposureLevel;
  eventCount:        number;
  maxSeverity:       number;
  maxMarketRelevance: number;
  eventIds:          string[];
}

export interface ExternalStockExport extends ExternalEnvelope {
  exportType:        'stock-project';
  marketEvents:      ExternalMarketEvent[];
  macroRiskSignals:  ExternalMacroRiskSignal[];
  sectorExposure:    ExternalSectorExposure[];
}

// ── Commodity time-series exports ─────────────────────────────────────────────
// Used by oil-prices.json, gas-prices.json, lng-prices.json.
// These do NOT extend ExternalEnvelope — they are a separate export family
// with their own envelope shape (series-oriented, not event-oriented).

export type CommodityDatapointStatus =
  | 'final'        // settlement price, no further revision expected
  | 'provisional'  // released but subject to revision
  | 'preliminary'  // early estimate, almost certain to be revised
  | 'revised'      // previously published value officially corrected
  | 'estimated'    // computed by hub (carry-forward or interpolation)
  | 'missing';     // no value available

export type MissingReason =
  | 'market_holiday'
  | 'weekend'
  | 'fetch_failed'
  | 'source_not_yet_published'
  | 'data_gap';

export type StalenessLevel = 'fresh' | 'stale' | 'very_stale' | 'unknown';
export type FetchStatus    = 'success' | 'partial' | 'failed' | 'skipped' | 'never';

export interface ExternalCommodityDatapoint {
  date:           string;           // YYYY-MM-DD, UTC business day
  value:          number | null;    // null on weekend/holiday/failed fetch
  status:         CommodityDatapointStatus;
  missingReason?: MissingReason;    // present only when value is null
  isRevised?:     boolean;          // true when value differs from original publication
  revisionCount?: number;           // how many times revised (≥1 when isRevised)
}

export interface ExternalCommodityFreshness {
  lastUpdated:         string;         // ISO datetime — last successful fetch
  lastDataPoint:       string | null;  // YYYY-MM-DD — most recent non-null value
  coverageFrom:        string | null;  // YYYY-MM-DD — earliest point in store
  dataLag:             string;         // 'D+1', 'W+1', 'M+10d', etc.
  staleness:           StalenessLevel;
  staleThresholdHours: number;
  nextExpectedUpdate:  string;         // ISO datetime — estimated next update
  fetchStatus:         FetchStatus;
}

export interface ExternalCommoditySeries {
  benchmarkId: string;     // immutable identifier — 'brent_crude', 'wti_crude', etc.
  name:        string;
  assetClass:  string;     // 'commodity'
  subClass:    string;     // 'crude_oil' | 'natural_gas' | 'lng'
  unit:        string;     // 'USD/barrel' | 'USD/MMBtu' | 'EUR/MWh' | 'GBP/therm'
  currency:    string;     // 'USD' | 'EUR' | 'GBP'
  timezone:    'UTC';
  frequency:   string;     // 'daily' | 'weekly' | 'monthly'
  source:      string;
  freshness:   ExternalCommodityFreshness;
  datapoints:  ExternalCommodityDatapoint[];
}

export interface ExternalDataHealth {
  allSeriesFresh:       boolean;
  staleSeriesCount:     number;
  veryStaleSeriesCount: number;
  failedSeriesCount:    number;
  staleSeriesIds:       string[];
}

export interface ExternalCommodityExport {
  schemaVersion:       '2.0';
  exportType:          string;     // 'oil-prices' | 'gas-prices' | 'lng-prices'
  generatedAt:         string;     // ISO datetime
  asOf:                string;     // YYYY-MM-DD — most recent date in this export
  coverageFrom:        string;     // YYYY-MM-DD — earliest date in this export
  frequencyNormalized: string;     // 'daily'
  dataHealth:          ExternalDataHealth;
  series:              ExternalCommoditySeries[];
}
