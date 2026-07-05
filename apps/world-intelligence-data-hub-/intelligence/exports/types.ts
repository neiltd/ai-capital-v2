// Export interface types — stable contracts for downstream consumers.
//
// STABILITY GUARANTEE:
//   - Fields are never renamed or removed within a schema_version.
//   - New optional fields may be added in minor releases.
//   - Breaking changes bump schema_version and the old version is preserved
//     in the manifest until consumers have migrated.
//
// Downstream projects MUST read from exports/ only.
// They MUST NOT import from intelligence/ or store/.

// ── Shared envelope ───────────────────────────────────────────────────────────

export interface ExportEnvelope {
  schema_version:        string;  // '1.0' — consumers must gate on this
  export_type:           string;  // 'world-intelligence' | 'oil-project' | 'stock-project'
  generated_at:          string;  // ISO datetime of this export run
  date:                  string;  // YYYY-MM-DD pipeline run date the data actually represents
  requested_date?:       string;  // YYYY-MM-DD originally requested — may differ from `date`
                                   // when the pipeline fell back to older data
  is_stale?:             boolean; // true when requested_date !== date (fallback occurred) —
                                   // consumers should surface this rather than assume freshness
  extraction_version:    string;  // reporter version that produced the events
  event_count:           number;  // verified events included
  review_excluded_count: number;  // events withheld — pending human review, not yet verified
  unique_source_count:   number;  // distinct RSS outlets contributing to this export
}

// ── Coordinate quality ────────────────────────────────────────────────────────
// Set by the Data Hub at export time. Frontend must use this to style markers.
//   source_exact    — confirmed GPS/address from source (e.g. ACLED field report)
//   source_approx   — geocoded city/district from source (e.g. AI-extracted)
//   country_centroid — fallback to country geographic centroid, no sub-national location
//   missing         — no coordinates available, event not placed on map
export type CoordinateQuality = 'source_exact' | 'source_approx' | 'country_centroid' | 'missing';

// ── Oil location type ─────────────────────────────────────────────────────────
export type OilLocationType =
  | 'point'          // precise GPS point (e.g. a specific facility)
  | 'city'           // city-level (e.g. Basra, Kuwait City)
  | 'region'         // sub-national region (e.g. Khuzestan Province)
  | 'country'        // country centroid only
  | 'chokepoint'     // named maritime chokepoint (Hormuz, Bab-el-Mandeb, Suez)
  | 'infrastructure' // oil/gas infrastructure (pipeline, terminal, platform)
  | 'offshore'       // offshore area without precise location
  | 'unknown';

// ── World Intelligence export ─────────────────────────────────────────────────
// Full event and storyline view for the world intelligence frontend.
// All events from the day's post-dedup pipeline run.

export interface WorldIntelEvent {
  // Identity — stable, deterministic
  event_id:            string;
  storyline_id?:       string;    // links to WorldIntelStoryline

  // Core description
  title:               string;
  summary:             string;
  event_type:          string;
  event_state?:        string;    // emerging | developing | confirmed | contested

  // Assessment
  severity:            number;    // 1–5
  confidence_score:    number;    // 0–1
  human_review_required?: boolean;

  // Geography
  countries:           string[];  // ISO3, primary country first

  // Coordinates — set by Data Hub at export time, never by frontend.
  // Always check coordinate_quality before rendering a map marker.
  lat?:                number;
  lng?:                number;
  coordinate_quality?: CoordinateQuality;
  coordinate_source?:  string;    // e.g. 'ai-extracted', 'country-centroid'

  // Scores
  geopolitical_relevance:  number;
  escalation_potential:    number;
  market_relevance:        number;

  // Temporal
  first_seen_at:       string;
  latest_seen_at?:     string;

  // Provenance — which RSS sources contributed
  runs_seen:           number;
  source_count:        number;    // distinct articles
  source_ids:          string[];  // e.g. ['bloomberg-markets', 'nytimes-world']
}

export interface WorldIntelStoryline {
  storyline_id:        string;
  title:               string;
  storyline_state:     string;    // emerging | active | escalating | stabilizing | fading
  countries:           string[];
  event_types:         string[];
  total_events:        number;
  total_sources:       number;
  unique_source_ids:   string[];
  avg_confidence:      number;
  avg_escalation:      number;
  max_severity:        number;
  first_seen_at:       string;
  latest_seen_at:      string;
  days_active:         number;
  family_composition:  Record<string, number>;  // { military: 4, diplomatic: 3 }
  cohesion_signal?:    string;
  event_ids:           string[];
}

export interface CountrySignal {
  country:             string;    // ISO3
  event_count:         number;
  max_severity:        number;    // 1–5
  avg_escalation:      number;    // 0–1
  avg_confidence:      number;    // 0–1
  dominant_event_type: string;
  active_storylines:   string[];  // storyline_ids
}

export interface WorldIntelExport extends ExportEnvelope {
  export_type:         'world-intelligence';
  events:              WorldIntelEvent[];
  storylines:          WorldIntelStoryline[];
  country_signals:     CountrySignal[];
}

// ── Oil project export ────────────────────────────────────────────────────────
// Energy, commodity, and shipping risk events for the oil intelligence project.

export type HormuzRiskLevel = 'low' | 'elevated' | 'high' | 'critical';

export interface HormuzRiskSnapshot {
  active:              boolean;
  risk_level:          HormuzRiskLevel;
  max_escalation:      number;    // highest escalation_potential among relevant events
  event_ids:           string[];  // events driving this risk level
  updated_at:          string;
}

export interface OilEvent {
  event_id:            string;
  storyline_id?:       string;
  title:               string;
  summary:             string;
  event_type:          string;
  severity:            number;
  confidence_score:    number;
  countries:           string[];
  escalation_potential: number;
  market_relevance:    number;
  is_supply_disruption: boolean;
  is_hormuz_related:   boolean;
  first_seen_at:       string;
  source_ids:          string[];
  // Coordinates — set by Data Hub at export time
  lat?:                number;
  lng?:                number;
  coordinate_quality?: CoordinateQuality;
  coordinate_source?:  string;
  location_type?:      OilLocationType;
  related_asset?:      string;  // 'oil' | 'gas' | 'chokepoint' | 'infrastructure'
}

export interface CommoditySignal {
  commodity:           'oil' | 'gas' | 'gold' | 'fertilizer';
  signal_direction:    'up' | 'down' | 'neutral' | 'uncertain';
  intensity:           number;    // 0–1, avg market_relevance of driving events
  event_ids:           string[];
  event_count:         number;
}

export interface OilExport extends ExportEnvelope {
  export_type:         'oil-project';
  hormuz_risk:         HormuzRiskSnapshot;
  energy_events:       OilEvent[];
  commodity_signals:   CommoditySignal[];
}

// ── Stock project export ──────────────────────────────────────────────────────
// Market-relevant events, macro risk signals, and sector exposure for
// the stock intelligence project.

export type MacroRiskType =
  | 'inflation_rate'
  | 'supply_shock'
  | 'sanctions'
  | 'geopolitical_conflict'
  | 'currency_stress'
  | 'debt_crisis';

export interface MacroRiskSignal {
  risk_type:           MacroRiskType;
  intensity:           number;       // 0–1, avg market_relevance of driving events
  primary_countries:   string[];     // ISO3 countries most affected
  event_count:         number;
  event_ids:           string[];
  storyline_ids:       string[];
}

export type SectorName = 'energy' | 'defense' | 'finance' | 'commodities' | 'tech' | 'other';
export type ExposureLevel = 'high' | 'medium' | 'low';

export interface SectorExposure {
  sector:              SectorName;
  exposure:            ExposureLevel;
  event_count:         number;
  max_severity:        number;
  max_market_relevance: number;
  event_ids:           string[];
}

export interface MarketEvent {
  event_id:            string;
  storyline_id?:       string;
  title:               string;
  summary:             string;
  event_type:          string;
  severity:            number;
  confidence_score:    number;
  countries:           string[];
  market_relevance:    number;
  market_direction:    string;    // bullish | bearish | neutral | uncertain
  first_seen_at:       string;
  source_ids:          string[];
}

export interface StockExport extends ExportEnvelope {
  export_type:         'stock-project';
  market_events:       MarketEvent[];
  macro_risk_signals:  MacroRiskSignal[];
  sector_exposure:     SectorExposure[];
}

// ── Manifest ──────────────────────────────────────────────────────────────────
// Index of all available exports. Consumers should poll this to discover
// the latest available data before fetching specific export files.

export interface ManifestEntry {
  schema_version:  string;
  generated_at:    string;
  date:            string;
  requested_date:  string;        // originally requested date — may differ from `date` on fallback
  is_stale:        boolean;       // true when requested_date !== date (pipeline served fallback data)
  event_count:     number;
  file:            string;        // relative path from exports/ root
}

export interface ExportManifest {
  manifest_version:   '1.0';
  last_updated:       string;
  exports: {
    'world-intelligence': ManifestEntry | null;
    'oil-project':        ManifestEntry | null;
    'stock-project':      ManifestEntry | null;
  };
}
