// Map-layer registry + sample geodata for the /world Map tab.
//
// The 21 layers below mirror the REAL registry at
// apps/unified-platform/src/worldmap/layers/_core/registry.ts — ids, labels,
// descriptions, groups, defaultEnabled flags, and legend entries are copied
// verbatim (that file is backend metadata, not old UI code). Legend colors are
// data-semantic (nuclear=violet, coal=stone, …) and validated against the
// dark surface, so they carry over unchanged.
//
// DATA PROVENANCE (verified 2026-07-06 by reading each layer's loading code):
// every layer carries a `provenance` block recording whether real data backs
// it today and where it lives. Three kinds:
//   'pipeline' — produced/refreshed by a running pipeline (hub exports, pg API)
//   'static'   — real curated dataset committed in-repo, loaded by a live
//                layer component; refreshed manually / by the Gemini
//                raw→validate→validated flow, not on a schedule
//   'unwired'  — a real data file EXISTS in data/validated/ but NO component
//                reads it in the current app (registry entry is UI-only today;
//                the redesign renders it from the file and documents the gap)
// The picker surfaces this honestly with a provenance glyph per row —
// same policy as the FX-basis rule: never hide where a number came from.
//
// COUPLING CHANGE vs. current app: the old WorldMap gangs 'conflict-zones'
// visibility to 'conflicts' (see registry.ts COUPLING NOTE). The redesign
// decouples them — each has its own toggle, as the registry always intended.
//
// Sample geodata below is excerpted from the real files (names/coords/classes
// are actual rows, trimmed to a representative handful per layer so the SVG
// stand-in renders). Production swaps each SAMPLE_* constant for the full
// dataset via the documented source path.

export type LayerGroup =
  | 'geopolitical'
  | 'economic'
  | 'infrastructure'
  | 'utilities'
  | 'intelligence'
  | 'environment'
  | 'investment'

export type LegendShape = 'circle' | 'diamond' | 'line' | 'square' | 'ramp'

export interface LegendEntry {
  color: string
  label: string
  shape?: LegendShape
}

export type ProvenanceKind = 'pipeline' | 'static' | 'unwired'

export interface LayerProvenance {
  kind: ProvenanceKind
  /** Where the real data lives (repo-relative). */
  source: string
  /** What's missing / how it refreshes. */
  note: string
}

export interface MapLayerMeta {
  id: string
  label: string
  description: string
  group: LayerGroup
  defaultEnabled: boolean
  legend?: LegendEntry[]
  provenance: LayerProvenance
}

export const LAYER_GROUPS: Array<{ id: LayerGroup; label: string }> = [
  { id: 'geopolitical', label: 'Geopolitical' },
  { id: 'economic', label: 'Economic' },
  { id: 'infrastructure', label: 'Infrastructure' },
  { id: 'utilities', label: 'Utilities' },
  { id: 'intelligence', label: 'Intelligence' },
  { id: 'environment', label: 'Environment' },
  { id: 'investment', label: 'Investment' },
]

// Sequential single-hue ramp (design-system §2) for score-graded layers —
// replaces the old app's red→green ramp, which violates the no-rainbow rule.
export const SEQ_RAMP = ['#cde2fb', '#86b6ef', '#5598e7', '#2a78d6', '#1c5cab', '#0d366b']

const rampLegend = (lo: string, hi: string): LegendEntry[] => [
  { color: 'ramp', label: `${lo} → ${hi}`, shape: 'ramp' },
]

export const MAP_LAYERS: MapLayerMeta[] = [
  // ── Geopolitical ──────────────────────────────────────────────────────────
  {
    id: 'conflicts',
    label: 'Active Conflicts',
    description:
      'Armed conflicts, civil wars, and territorial disputes that destabilize regions and redirect capital flows.',
    group: 'geopolitical',
    defaultEnabled: true,
    legend: [
      { color: '#ef4444', label: 'Critical', shape: 'circle' },
      { color: '#f97316', label: 'High', shape: 'circle' },
      { color: '#eab308', label: 'Medium', shape: 'circle' },
      { color: '#84cc16', label: 'Low', shape: 'circle' },
    ],
    provenance: {
      kind: 'static',
      source: 'unified-platform/src/worldmap/data/conflicts.json (30 conflicts)',
      note: 'Curated in-repo; ACLED feeds hub events, not this file — no scheduled refresh.',
    },
  },
  {
    id: 'conflict-zones',
    label: 'Conflict Zones',
    description:
      'Geographic footprint of active conflict areas — indicates territorial control and displacement risk.',
    group: 'geopolitical',
    defaultEnabled: true,
    legend: [
      { color: '#ef4444', label: 'Frontline / critical', shape: 'square' },
      { color: '#f97316', label: 'Contested / high', shape: 'square' },
    ],
    provenance: {
      kind: 'static',
      source: 'unified-platform/src/worldmap/data/conflict-zones.json (24 GeoJSON polygons)',
      note: 'Ganged to Conflicts in the old app; decoupled here (own toggle).',
    },
  },

  // ── Economic ──────────────────────────────────────────────────────────────
  {
    id: 'trade-routes',
    label: 'Trade Routes',
    description:
      'Major shipping lanes, pipelines, and rail corridors — disruptions directly impact global supply chains.',
    group: 'economic',
    defaultEnabled: false,
    legend: [
      { color: '#06b6d4', label: 'Critical volume', shape: 'line' },
      { color: '#3b82f6', label: 'High volume', shape: 'line' },
      { color: '#6366f1', label: 'Medium volume', shape: 'line' },
      { color: '#8b5cf6', label: 'Low volume', shape: 'line' },
    ],
    provenance: {
      kind: 'static',
      source: 'unified-platform/src/worldmap/data/trade-routes.json (19 routes)',
      note: 'Curated with waypoints, annual value, key goods; loaded by TradeRouteLayer.',
    },
  },
  {
    id: 'chokepoints',
    label: 'Strategic Chokepoints',
    description:
      'Maritime passages where a small number of vessels control a disproportionate share of global trade.',
    group: 'economic',
    defaultEnabled: false,
    legend: [
      { color: '#22c55e', label: 'Low risk', shape: 'diamond' },
      { color: '#f59e0b', label: 'Medium risk', shape: 'diamond' },
      { color: '#ef4444', label: 'High risk', shape: 'diamond' },
    ],
    provenance: {
      kind: 'static',
      source: 'unified-platform/src/worldmap/data/trade-routes.json → chokepoints[] (18)',
      note: 'Same file as routes; old app renders via TradeRouteLayer showChokepoints prop.',
    },
  },
  {
    id: 'portfolio-trade',
    label: 'Portfolio Trade Exposure',
    description:
      'Bilateral trade flows colored by commodity, restricted to lanes that touch the portfolio. Click a chokepoint marker to filter to lanes that pass through it and see exposed tickers.',
    group: 'economic',
    defaultEnabled: false,
    legend: [
      { color: '#06b6d4', label: 'Semis', shape: 'line' },
      { color: '#ef4444', label: 'Energy', shape: 'line' },
      { color: '#a855f7', label: 'Pharma', shape: 'line' },
      { color: '#94a3b8', label: 'Industrial metals', shape: 'line' },
      { color: '#fbbf24', label: 'Chokepoint', shape: 'diamond' },
    ],
    provenance: {
      kind: 'pipeline',
      source: 'GET /api/trade-graph + /api/trade-graph/events (Postgres, trade schema via apps/trade-graph)',
      note: 'Live endpoint; only layer with a runtime API. Events refresh every 5 min.',
    },
  },

  // ── Infrastructure ────────────────────────────────────────────────────────
  {
    id: 'airports',
    label: 'Major Airports',
    description:
      'International airports by strategic and economic significance — power projection, logistics, and trade hubs.',
    group: 'infrastructure',
    defaultEnabled: false,
    legend: [
      { color: '#f97316', label: 'Critical', shape: 'circle' },
      { color: '#3b82f6', label: 'High', shape: 'circle' },
      { color: '#64748b', label: 'Medium', shape: 'circle' },
    ],
    provenance: {
      kind: 'static',
      source: 'unified-platform/src/worldmap/data/validated/airports.json (390 airports)',
      note: 'Gemini raw→validated flow (data/raw/airports/*.raw.json per country).',
    },
  },
  {
    id: 'seaports',
    label: 'Seaports',
    description:
      'Container and bulk cargo ports — chokepoints in global manufacturing and commodity supply chains.',
    group: 'infrastructure',
    defaultEnabled: false,
    legend: [
      { color: '#06b6d4', label: 'Container', shape: 'circle' },
      { color: '#f59e0b', label: 'Oil/LNG', shape: 'circle' },
      { color: '#8b5cf6', label: 'Bulk', shape: 'circle' },
      { color: '#ef4444', label: 'Naval', shape: 'circle' },
      { color: '#22c55e', label: 'Mixed', shape: 'circle' },
    ],
    provenance: {
      kind: 'static',
      source: 'unified-platform/src/worldmap/data/validated/seaports.json (343 ports)',
      note: 'Loaded by PortLayer; includes TEU/tonnage throughput.',
    },
  },
  {
    id: 'datacenters',
    label: 'Datacenters',
    description:
      'Hyperscale and colocation datacenters — the physical infrastructure of AI, cloud, and digital economy sovereignty.',
    group: 'infrastructure',
    defaultEnabled: false,
    legend: [
      { color: '#a78bfa', label: 'Hyperscale', shape: 'circle' },
      { color: '#22d3ee', label: 'Colocation', shape: 'circle' },
      { color: '#ef4444', label: 'Government', shape: 'circle' },
      { color: '#64748b', label: 'Enterprise', shape: 'circle' },
    ],
    provenance: {
      kind: 'static',
      source: 'unified-platform/src/worldmap/data/validated/datacenters.json (300 sites)',
      note: 'Loaded by DatacenterLayer.',
    },
  },
  {
    id: 'submarine-cables',
    label: 'Submarine Cables',
    description:
      'Undersea internet cables carrying 95% of global internet traffic — critical and vulnerable digital infrastructure.',
    group: 'infrastructure',
    defaultEnabled: false,
    legend: [
      { color: '#06b6d4', label: 'Active', shape: 'line' },
      { color: '#f59e0b', label: 'Construction', shape: 'line' },
      { color: '#ef4444', label: 'Damaged', shape: 'line' },
    ],
    provenance: {
      kind: 'static',
      source: 'unified-platform/src/worldmap/data/validated/submarine-cables.json (300 cables w/ landing points)',
      note: 'Loaded by SubmarineCableLayer.',
    },
  },
  {
    id: 'rail-hubs',
    label: 'Rail Hubs',
    description:
      'Major rail hubs including BRI corridors, border crossings, and freight terminals — land-based supply chain infrastructure.',
    group: 'infrastructure',
    defaultEnabled: false,
    legend: [
      { color: '#f59e0b', label: 'Freight', shape: 'circle' },
      { color: '#60a5fa', label: 'Passenger', shape: 'circle' },
      { color: '#f97316', label: 'Border crossing', shape: 'circle' },
      { color: '#34d399', label: 'Port interface', shape: 'circle' },
      { color: '#22d3ee', label: 'High speed', shape: 'circle' },
    ],
    provenance: {
      kind: 'static',
      source: 'unified-platform/src/worldmap/data/validated/rail-hubs.json (328 hubs)',
      note: 'Loaded by RailHubLayer.',
    },
  },
  {
    id: 'hospitals',
    label: 'Major Hospitals',
    description:
      'Top hospitals globally (Newsweek 2024 + JCI + bed count). Soft-power + healthcare-system development signal; halo on the 12 world-ranked.',
    group: 'infrastructure',
    defaultEnabled: false,
    legend: [
      { color: '#3b82f6', label: 'Public/Government', shape: 'circle' },
      { color: '#22d3ee', label: 'Private nonprofit', shape: 'circle' },
      { color: '#a78bfa', label: 'Private for-profit', shape: 'circle' },
    ],
    provenance: {
      kind: 'static',
      source: 'unified-platform/src/worldmap/data/validated/hospitals.json (488 hospitals)',
      note: 'Loaded by HospitalLayer.',
    },
  },

  // ── Utilities ─────────────────────────────────────────────────────────────
  {
    id: 'power-plants',
    label: 'Power Infrastructure',
    description:
      'Major energy generation facilities — energy security is a primary driver of geopolitical positioning.',
    group: 'utilities',
    defaultEnabled: false,
    legend: [
      { color: '#a78bfa', label: 'Nuclear', shape: 'circle' },
      { color: '#78716c', label: 'Coal', shape: 'circle' },
      { color: '#f59e0b', label: 'Gas', shape: 'circle' },
      { color: '#0ea5e9', label: 'Hydro', shape: 'circle' },
      { color: '#fbbf24', label: 'Solar', shape: 'circle' },
      { color: '#34d399', label: 'Wind', shape: 'circle' },
    ],
    provenance: {
      kind: 'static',
      source: 'unified-platform/src/worldmap/data/validated/power-plants.json (502 plants)',
      note: 'Loaded by PowerLayer.',
    },
  },
  {
    id: 'refineries',
    label: 'Refineries & LNG',
    description:
      'Global oil refineries (>100k bpd) + LNG export/import terminals. Concentration reveals downstream energy choke points.',
    group: 'utilities',
    defaultEnabled: false,
    legend: [
      { color: '#fb923c', label: 'Crude refinery', shape: 'circle' },
      { color: '#facc15', label: 'Condensate', shape: 'circle' },
      { color: '#a855f7', label: 'Petrochemical', shape: 'circle' },
      { color: '#22d3ee', label: 'LNG export', shape: 'circle' },
      { color: '#3b82f6', label: 'LNG import', shape: 'circle' },
    ],
    provenance: {
      kind: 'static',
      source: 'unified-platform/src/worldmap/data/validated/refineries.json (280 facilities)',
      note: 'Loaded by RefineryLayer.',
    },
  },
  {
    id: 'critical-minerals',
    label: 'Critical Mineral Mines',
    description:
      'Mines producing ≥1% global supply for copper, lithium, cobalt, nickel, rare earths, etc. Halo marks >3%-share concentrations.',
    group: 'utilities',
    defaultEnabled: false,
    legend: [
      { color: '#f97316', label: 'Copper', shape: 'circle' },
      { color: '#22d3ee', label: 'Lithium', shape: 'circle' },
      { color: '#3b82f6', label: 'Cobalt', shape: 'circle' },
      { color: '#a855f7', label: 'Rare earths', shape: 'circle' },
      { color: '#10b981', label: 'Uranium', shape: 'circle' },
      { color: '#94a3b8', label: 'Nickel', shape: 'circle' },
    ],
    provenance: {
      kind: 'static',
      source: 'unified-platform/src/worldmap/data/validated/critical-mineral-mines.json (250 mines)',
      note: 'Loaded by MineLayer.',
    },
  },
  {
    id: 'water-infra',
    label: 'Water Infrastructure',
    description:
      'Major desalination plants + hydropower & water-supply dams. Surfaces water-security investment, especially Gulf desal and Asian hydro.',
    group: 'utilities',
    defaultEnabled: false,
    legend: [
      { color: '#06b6d4', label: 'Desalination', shape: 'circle' },
      { color: '#3b82f6', label: 'Hydropower dam', shape: 'circle' },
      { color: '#22c55e', label: 'Supply dam', shape: 'circle' },
      { color: '#a855f7', label: 'Combined-use', shape: 'circle' },
    ],
    provenance: {
      kind: 'static',
      source: 'unified-platform/src/worldmap/data/validated/water-infrastructure.json (370 facilities)',
      note: 'Loaded by WaterLayer.',
    },
  },
  {
    id: 'mci',
    label: 'Digital Connectivity (MCI)',
    description:
      'GSMA Mobile Connectivity Index 2024 — measures network coverage, affordability, consumer readiness, and content for 173 countries. Bubble size = MCI score 0-100.',
    group: 'utilities',
    defaultEnabled: false,
    legend: [
      { color: '#22d3ee', label: 'Leader (>85)', shape: 'circle' },
      { color: '#3b82f6', label: 'Advanced (70-85)', shape: 'circle' },
      { color: '#a855f7', label: 'Transitioner (55-70)', shape: 'circle' },
      { color: '#f59e0b', label: 'Discoverer (<55)', shape: 'circle' },
    ],
    provenance: {
      kind: 'static',
      source: 'unified-platform/src/worldmap/data/validated/mci-latest.json (173 countries; + mci-timeseries.json)',
      note: 'Loaded by MciLayer.',
    },
  },
  {
    id: 'energy-mix',
    label: 'Energy Mix',
    description:
      'Electricity generation by source — reveals fossil fuel dependency, renewables transition, and energy independence risk.',
    group: 'utilities',
    defaultEnabled: false,
    // Registry ships no legend; derived here from the mix categories.
    legend: [
      { color: '#34d399', label: 'Renewable-led', shape: 'circle' },
      { color: '#a78bfa', label: 'Nuclear-led', shape: 'circle' },
      { color: '#78716c', label: 'Fossil-led', shape: 'circle' },
    ],
    provenance: {
      kind: 'unwired',
      source: 'unified-platform/src/worldmap/data/validated/energy-mix.json (60 countries) — NO consumer in current app',
      note: 'Heatmap shows renewable/fossil/nuclear shares from utilities.json instead; this layer id renders nothing today. Missing: a loader + map component.',
    },
  },

  // ── Intelligence ──────────────────────────────────────────────────────────
  {
    id: 'heatmap',
    label: 'Country Heatmap',
    description: 'Comparative country scoring across 7 geopolitical and economic indicators.',
    group: 'intelligence',
    defaultEnabled: false,
    legend: rampLegend('Score 1', '10'),
    provenance: {
      kind: 'static',
      source: 'unified-platform/src/worldmap/data/indicators-index.json (~214 countries × 7 indicators) merged with validated/utilities.json + food-security.json in lib/geo/indicators.ts',
      note: 'Old app drives this via heatmapIndicator state (HeatmapSelector), excluded from the layer toggle; unified here as a normal layer. Old red→green ramp replaced by the validated sequential blue ramp.',
    },
  },
  {
    id: 'intelligence-events',
    label: 'Intelligence Events',
    description:
      'Hub-imported geopolitical events — conflicts, sanctions, diplomatic shifts, and energy disruptions.',
    group: 'intelligence',
    defaultEnabled: true,
    legend: [
      { color: '#d03b3b', label: 'Sev 5', shape: 'circle' },
      { color: '#ec835a', label: 'Sev 4', shape: 'circle' },
      { color: '#fab219', label: 'Sev 3', shape: 'circle' },
      { color: '#898781', label: 'Sev ≤2 / hollow = centroid', shape: 'circle' },
    ],
    provenance: {
      kind: 'pipeline',
      source: 'world-intelligence-data-hub-/intelligence/exports/run-exports.ts → unified-platform/public/data/imports/events.json (12 events, 2026-07-06) → useIntelligenceStore → EventsLayer',
      note: 'Live daily; the same feed this screen’s List tab renders. Severity ramp restyled to status colors (registry’s per-type diamond legend available as a variant).',
    },
  },

  // ── Environment ───────────────────────────────────────────────────────────
  {
    id: 'water-stress',
    label: 'Water Stress',
    description:
      'Water scarcity risk — a growing driver of migration, food insecurity, and regional conflict.',
    group: 'environment',
    defaultEnabled: false,
    legend: rampLegend('Low stress', 'Extreme'),
    provenance: {
      kind: 'unwired',
      source: 'unified-platform/src/worldmap/data/validated/water-stress.json (194 countries, WRI Aqueduct 4.0) — NO consumer in current app',
      note: 'Heatmap’s waterStressScore comes from utilities.json (34 countries), not this richer file. Missing: loader + map component for the dedicated dataset.',
    },
  },
  {
    id: 'food-security',
    label: 'Food Security',
    description:
      'Food supply vulnerability — countries with high food insecurity face compounded geopolitical instability.',
    group: 'environment',
    defaultEnabled: false,
    legend: rampLegend('Secure', 'Alarming'),
    provenance: {
      kind: 'unwired',
      source: 'unified-platform/src/worldmap/data/validated/food-security.json (148 countries, GHI/IPC/FAO) — consumed only as a heatmap indicator + CountryPanel field',
      note: 'No standalone map layer exists for this id today. Missing: map component (data file is real and current, asOf 2024).',
    },
  },

  // ── Investment ────────────────────────────────────────────────────────────
  {
    id: 'investment-signals',
    label: 'Investment Signals',
    description:
      'Country-level risk/opportunity signals by sector, backed by source-attributed intelligence.',
    group: 'investment',
    defaultEnabled: false,
    legend: [
      { color: '#0ca30c', label: 'Bullish', shape: 'diamond' },
      { color: '#898781', label: 'Neutral / watch', shape: 'diamond' },
      { color: '#d03b3b', label: 'Bearish', shape: 'diamond' },
    ],
    provenance: {
      kind: 'unwired',
      source: 'unified-platform/src/worldmap/data/validated/investment-signals.json (240 signals: iso3, sector, signal, strength, thesis, watchTickers) — NO consumer in current app',
      note: 'layers/investment/ holds only type defs + hardcoded sector .ts files, also unrendered. Missing: loader + map component.',
    },
  },
]

export const layersByGroup = (g: LayerGroup) => MAP_LAYERS.filter((l) => l.group === g)

export const DEFAULT_VISIBILITY: Record<string, boolean> = Object.fromEntries(
  MAP_LAYERS.map((l) => [l.id, l.defaultEnabled]),
)

/* ═══════════════════════════ sample geodata ═══════════════════════════════ */
/* Real rows excerpted from the source files named above (trimmed sets).      */

export interface Pt {
  name: string
  lng: number
  lat: number
  /** legend class — must match a legend label's semantic key below */
  k: string
  /** optional magnitude for sized marks */
  v?: number
}

export interface Line {
  name: string
  k: string
  path: Array<[number, number]> // [lng, lat]
}

export interface Zone {
  name: string
  k: string
  ring: Array<[number, number]>
}

// conflicts.json — 8 of 30
export const SAMPLE_CONFLICTS: Pt[] = [
  { name: 'Russia–Ukraine War', lng: 32.0, lat: 49.5, k: 'critical' },
  { name: 'Israel–Gaza War', lng: 34.4, lat: 31.4, k: 'critical' },
  { name: 'Sudan Civil War', lng: 30.0, lat: 15.5, k: 'critical' },
  { name: 'Myanmar Civil War', lng: 96.5, lat: 19.5, k: 'high' },
  { name: 'Yemen War', lng: 44.5, lat: 15.5, k: 'high' },
  { name: 'Sahel Jihadist Insurgency', lng: -1.0, lat: 14.5, k: 'high' },
  { name: 'DRC East (M23)', lng: 29.2, lat: -1.7, k: 'medium' },
  { name: 'Haiti Gang Crisis', lng: -72.3, lat: 18.6, k: 'medium' },
]

// conflict-zones.json — simplified rings of 3 of 24 features
export const SAMPLE_CONFLICT_ZONES: Zone[] = [
  {
    name: 'Russia-Ukraine War (eastern/southern front)',
    k: 'critical',
    ring: [[33.5, 46.5], [36.5, 46.5], [38.5, 47.5], [40.0, 49.5], [38.0, 50.5], [35.5, 48.5], [33.5, 46.5]],
  },
  {
    name: 'Gaza Strip',
    k: 'critical',
    ring: [[34.2, 31.2], [34.55, 31.3], [34.5, 31.6], [34.2, 31.5], [34.2, 31.2]],
  },
  {
    name: 'Darfur (El Fasher)',
    k: 'high',
    ring: [[24.0, 12.5], [27.5, 12.8], [27.0, 15.5], [24.0, 15.0], [24.0, 12.5]],
  },
]

// trade-routes.json → routes[] — 5 of 19 (from/to + key waypoint)
export const SAMPLE_TRADE_ROUTES: Line[] = [
  { name: 'Trans-Pacific (North)', k: 'critical', path: [[121.5, 31.2], [180, 40], [-140, 40], [-118.2, 33.7]] },
  { name: 'Asia–Europe via Suez', k: 'critical', path: [[114.1, 22.3], [103.8, 1.3], [43.3, 12.5], [32.5, 30.5], [5.4, 43.3]] },
  { name: 'Trans-Atlantic', k: 'high', path: [[4.4, 51.9], [-30, 45], [-74.0, 40.7]] },
  { name: 'Gulf energy exports', k: 'high', path: [[56.4, 26.6], [67, 20], [72.9, 19.0]] },
  { name: 'China–Europe rail (BRI)', k: 'medium', path: [[108.9, 34.3], [76.9, 43.2], [60.6, 56.8], [21.0, 52.2]] },
]

// trade-routes.json → chokepoints[] — 8 of 18
export const SAMPLE_CHOKEPOINTS: Pt[] = [
  { name: 'Strait of Malacca', lng: 103.8, lat: 1.3, k: 'medium' },
  { name: 'Strait of Hormuz', lng: 56.4, lat: 26.6, k: 'high' },
  { name: 'Suez Canal', lng: 32.5, lat: 30.5, k: 'medium' },
  { name: 'Bab el-Mandeb', lng: 43.3, lat: 12.5, k: 'high' },
  { name: 'Strait of Gibraltar', lng: -5.4, lat: 35.9, k: 'low' },
  { name: 'Turkish Straits (Bosphorus)', lng: 29.0, lat: 41.0, k: 'medium' },
  { name: 'Taiwan Strait', lng: 120.0, lat: 24.0, k: 'high' },
  { name: 'Panama Canal', lng: -79.7, lat: 9.1, k: 'medium' },
]

// /api/trade-graph — portfolio-touching lanes (shape matches FlowDto join)
export const SAMPLE_PORTFOLIO_LANES: Line[] = [
  { name: 'TWN→USA semiconductors (TSM, NVDA)', k: 'semis', path: [[121.0, 23.8], [155, 35], [-122.4, 37.8]] },
  { name: 'KOR→USA semiconductors (MU)', k: 'semis', path: [[127.0, 37.5], [170, 40], [-118.2, 33.7]] },
  { name: 'SAU→CHN crude (GULF.BK theme)', k: 'energy', path: [[50.1, 26.4], [72, 8], [103.8, 1.3], [114.1, 22.3]] },
  { name: 'AUS→CHN industrial metals', k: 'industrial_metals', path: [[118.6, -20.3], [114.1, 22.3]] },
]

// validated/airports.json — 6 of 390
export const SAMPLE_AIRPORTS: Pt[] = [
  { name: 'Dubai International (DXB)', lng: 55.3657, lat: 25.2532, k: 'critical' },
  { name: 'Heathrow (LHR)', lng: -0.4543, lat: 51.47, k: 'critical' },
  { name: 'Singapore Changi (SIN)', lng: 103.9915, lat: 1.3644, k: 'critical' },
  { name: 'Suvarnabhumi (BKK)', lng: 100.7501, lat: 13.69, k: 'high' },
  { name: 'Frankfurt (FRA)', lng: 8.5622, lat: 50.0379, k: 'high' },
  { name: 'Sharjah (SHJ)', lng: 55.5172, lat: 25.3286, k: 'medium' },
]

// validated/seaports.json — 6 of 343
export const SAMPLE_SEAPORTS: Pt[] = [
  { name: 'Jebel Ali Port', lng: 55.061, lat: 25.011, k: 'container' },
  { name: 'Port of Shanghai', lng: 121.5, lat: 31.23, k: 'container' },
  { name: 'Port of Fujairah', lng: 56.359, lat: 25.188, k: 'oil' },
  { name: 'Port of Rotterdam', lng: 4.4, lat: 51.9, k: 'mixed' },
  { name: 'Saqr Port', lng: 56.064, lat: 25.978, k: 'bulk' },
  { name: 'Norfolk Naval Station', lng: -76.3, lat: 36.95, k: 'naval' },
]

// validated/datacenters.json — 5 of 300
export const SAMPLE_DATACENTERS: Pt[] = [
  { name: 'AWS Middle East (UAE) Region', lng: 55.18, lat: 25.05, k: 'hyperscale' },
  { name: 'Microsoft Azure UAE North', lng: 55.2, lat: 25.08, k: 'hyperscale' },
  { name: 'Equinix SG1 Singapore', lng: 103.7, lat: 1.32, k: 'colocation' },
  { name: 'NSA Utah Data Center', lng: -111.93, lat: 40.43, k: 'government' },
  { name: 'Ashburn VA cluster', lng: -77.49, lat: 39.04, k: 'hyperscale' },
]

// validated/submarine-cables.json — 3 of 300 (landing-point pairs)
export const SAMPLE_CABLES: Line[] = [
  { name: 'SEA-ME-WE 5 (Marseille–Tuas)', k: 'active', path: [[5.4, 43.3], [32.5, 30.5], [43.3, 12.5], [77, 6], [103.7, 1.3]] },
  { name: '2Africa (partial)', k: 'construction', path: [[-5.4, 35.9], [-17.4, 14.7], [18.4, -33.9]] },
  { name: 'AAE-1 Red Sea segment', k: 'damaged', path: [[32.5, 30.5], [43.3, 12.5], [58, 20]] },
]

// validated/rail-hubs.json — 5 of 328
export const SAMPLE_RAIL_HUBS: Pt[] = [
  { name: 'Khorgos Gateway (BRI)', lng: 80.4, lat: 44.2, k: 'border_crossing' },
  { name: 'Duisburg Intermodal', lng: 6.75, lat: 51.43, k: 'freight' },
  { name: 'Rosario Rail Export Terminal', lng: -60.653, lat: -32.944, k: 'port_interface' },
  { name: 'Tokyo Station', lng: 139.767, lat: 35.681, k: 'high_speed' },
  { name: 'Retiro Station Complex', lng: -58.375, lat: -34.591, k: 'passenger' },
]

// validated/hospitals.json — 4 of 488
export const SAMPLE_HOSPITALS: Pt[] = [
  { name: 'Mayo Clinic — Rochester', lng: -92.466, lat: 44.022, k: 'private_nonprofit' },
  { name: 'Johns Hopkins Hospital', lng: -76.592, lat: 39.297, k: 'private_nonprofit' },
  { name: 'Toronto General', lng: -79.388, lat: 43.659, k: 'public' },
  { name: 'Bumrungrad International', lng: 100.552, lat: 13.744, k: 'private_forprofit' },
]

// validated/power-plants.json — 6 of 502
export const SAMPLE_POWER: Pt[] = [
  { name: 'Barakah NPP (5.6 GW)', lng: 52.2317, lat: 23.9678, k: 'nuclear' },
  { name: 'Jebel Ali Complex (9.5 GW)', lng: 55.1172, lat: 25.0597, k: 'gas' },
  { name: 'MBR Al Maktoum Solar Park', lng: 55.365, lat: 24.7547, k: 'solar' },
  { name: 'Three Gorges (22.5 GW)', lng: 111.005, lat: 30.825, k: 'hydro' },
  { name: 'Bełchatów (coal)', lng: 19.33, lat: 51.27, k: 'coal' },
  { name: 'Hornsea offshore wind', lng: 1.9, lat: 53.9, k: 'wind' },
]

// validated/refineries.json — 5 of 280
export const SAMPLE_REFINERIES: Pt[] = [
  { name: 'Jamnagar Complex', lng: 69.855, lat: 22.355, k: 'crude_refinery' },
  { name: 'Ulsan Refinery', lng: 129.355, lat: 35.525, k: 'crude_refinery' },
  { name: 'Port Arthur', lng: -93.955, lat: 29.895, k: 'crude_refinery' },
  { name: 'Sabine Pass LNG', lng: -93.87, lat: 29.75, k: 'lng_export' },
  { name: 'Futtsu LNG', lng: 139.85, lat: 35.31, k: 'lng_import' },
]

// validated/critical-mineral-mines.json — 6 of 250
export const SAMPLE_MINES: Pt[] = [
  { name: 'Escondida (copper)', lng: -69.065, lat: -24.275, k: 'copper' },
  { name: 'Grasberg (copper)', lng: 137.11, lat: -4.05, k: 'copper' },
  { name: 'Greenbushes (lithium)', lng: 116.055, lat: -33.855, k: 'lithium' },
  { name: 'Tenke Fungurume (cobalt)', lng: 26.215, lat: -10.585, k: 'cobalt' },
  { name: 'Mountain Pass (rare earths)', lng: -115.535, lat: 35.485, k: 'rare_earths' },
  { name: 'Bayan Obo (rare earths)', lng: 109.97, lat: 41.77, k: 'rare_earths' },
]

// validated/water-infrastructure.json — 5 of 370
export const SAMPLE_WATER_INFRA: Pt[] = [
  { name: 'Shuaibah 3 desal', lng: 39.525, lat: 20.675, k: 'desalination' },
  { name: 'Sorek desal', lng: 34.717, lat: 31.833, k: 'desalination' },
  { name: 'Three Gorges dam', lng: 111.005, lat: 30.825, k: 'hydropower_dam' },
  { name: 'Itaipu dam', lng: -54.585, lat: -25.405, k: 'hydropower_dam' },
  { name: 'Bhumibol supply dam', lng: 98.97, lat: 17.24, k: 'supply_dam' },
]

// validated/mci-latest.json — 6 of 173 (bubble size = index)
export const SAMPLE_MCI: Pt[] = [
  { name: 'UAE — 90.7', lng: 54.0, lat: 24.0, k: 'leader', v: 90.72 },
  { name: 'Singapore — 89.5', lng: 103.8, lat: 1.35, k: 'leader', v: 89.5 },
  { name: 'Albania — 72.2', lng: 20.0, lat: 41.0, k: 'advanced', v: 72.21 },
  { name: 'Thailand — 74.9', lng: 100.9, lat: 15.8, k: 'advanced', v: 74.9 },
  { name: 'Angola — 48.0', lng: 17.9, lat: -11.2, k: 'discoverer', v: 47.97 },
  { name: 'Afghanistan — 26.8', lng: 66.0, lat: 33.9, k: 'transitioner', v: 55.0 },
]

// validated/energy-mix.json — 5 of 60 (dominant source class)
export const SAMPLE_ENERGY_MIX: Pt[] = [
  { name: 'China — fossil 63.6% / renew 28.9%', lng: 104.2, lat: 35.9, k: 'fossil', v: 63.6 },
  { name: 'France — nuclear-led', lng: 2.2, lat: 46.2, k: 'nuclear', v: 65 },
  { name: 'Norway — hydro-led', lng: 8.5, lat: 60.5, k: 'renewable', v: 92 },
  { name: 'Brazil — renewable-led', lng: -51.9, lat: -14.2, k: 'renewable', v: 85 },
  { name: 'Saudi Arabia — fossil-led', lng: 45.1, lat: 23.9, k: 'fossil', v: 99 },
]

// indicators-index.json — composite stand-in, 6 of ~214 (production: country fill)
export const SAMPLE_HEATMAP: Pt[] = [
  { name: 'USA — invest. attractiveness 9/10', lng: -98.6, lat: 39.8, k: 'seq', v: 9 },
  { name: 'Germany — 8/10', lng: 10.4, lat: 51.2, k: 'seq', v: 8 },
  { name: 'Thailand — 6/10', lng: 100.9, lat: 15.8, k: 'seq', v: 6 },
  { name: 'India — 7/10', lng: 78.9, lat: 20.6, k: 'seq', v: 7 },
  { name: 'Russia — 2/10', lng: 97.0, lat: 61.5, k: 'seq', v: 2 },
  { name: 'Sudan — 1/10', lng: 30.2, lat: 12.9, k: 'seq', v: 1 },
]

// validated/water-stress.json — 6 of 194 (Aqueduct 0–5 → v)
export const SAMPLE_WATER_STRESS: Pt[] = [
  { name: 'Saudi Arabia — extreme (4.8)', lng: 45.1, lat: 23.9, k: 'seq', v: 4.8 },
  { name: 'India — high (3.7)', lng: 78.9, lat: 20.6, k: 'seq', v: 3.7 },
  { name: 'Spain — high (3.4)', lng: -3.7, lat: 40.4, k: 'seq', v: 3.4 },
  { name: 'Albania — high (3.4)', lng: 20.0, lat: 41.0, k: 'seq', v: 3.4 },
  { name: 'Thailand — medium (2.6)', lng: 100.9, lat: 15.8, k: 'seq', v: 2.6 },
  { name: 'Norway — low (0.5)', lng: 8.5, lat: 60.5, k: 'seq', v: 0.5 },
]

// validated/food-security.json — 5 of 148 (hungerIndex 0–50 → v)
export const SAMPLE_FOOD_SECURITY: Pt[] = [
  { name: 'Afghanistan — alarming (GHI 38.7)', lng: 66.0, lat: 33.9, k: 'seq', v: 38.7 },
  { name: 'Sudan — alarming', lng: 30.2, lat: 12.9, k: 'seq', v: 36.0 },
  { name: 'Yemen — alarming', lng: 47.5, lat: 15.6, k: 'seq', v: 34.0 },
  { name: 'India — serious', lng: 78.9, lat: 20.6, k: 'seq', v: 27.3 },
  { name: 'Thailand — moderate', lng: 100.9, lat: 15.8, k: 'seq', v: 10.2 },
]

// validated/investment-signals.json — 5 of 240
export const SAMPLE_INVESTMENT_SIGNALS: Pt[] = [
  { name: 'USA · ai · bullish (NVDA MSFT GOOGL)', lng: -98.6, lat: 39.8, k: 'bullish', v: 5 },
  { name: 'TWN · semis · bullish w/ strait risk (TSM)', lng: 121.0, lat: 23.8, k: 'bullish', v: 4 },
  { name: 'THA · tourism-infra · neutral (AOT.BK)', lng: 100.9, lat: 15.8, k: 'neutral', v: 3 },
  { name: 'ARE · energy-transition · bullish', lng: 54.0, lat: 24.0, k: 'bullish', v: 4 },
  { name: 'RUS · all · bearish (sanctions)', lng: 97.0, lat: 61.5, k: 'bearish', v: 5 },
]
