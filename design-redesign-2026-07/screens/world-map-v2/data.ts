// Data module for the /world Map tab redesign (world-map-v2).
//
// LAYER REGISTRY — the 22 entries below mirror the production registry at
// apps/unified-platform/src/worldmap/layers/_core/registry.ts verbatim
// (ids, labels, descriptions, groups, defaultEnabled, legends). That file is
// backend metadata, not old UI code, so carrying it over is required — the
// redesign must keep every layer. 21 entries are individually toggleable;
// 'heatmap' is a country-shading mode driven by an indicator selector
// (exclusive, one indicator at a time), exactly as in the current app.
//
// COUPLING NOTE preserved from the registry: 'conflicts' and 'conflict-zones'
// are ganged in the current WorldMap (zones follow the conflict toggle). The
// redesign keeps both registry entries and gives each its own switch — the
// registry's stated intent — with a note in the rail row tooltip.
//
// LENSES are new: one-click curated layer combinations derived from the
// registry's own `themes: ThematicScope[]` field (layers/_core/types.ts
// documents this exact "thematic view mode" as the intended future use).
//
// Sample geodata rows are real records excerpted from each layer's source
// file (see per-layer `source`), trimmed so the SVG stand-in renders.
// Production swaps each SAMPLE_* constant for the full dataset on the
// self-hosted MapLibre dark basemap.

/* ------------------------------- registry -------------------------------- */

export type LayerGroupId =
  | 'geopolitical'
  | 'economic'
  | 'infrastructure'
  | 'utilities'
  | 'intelligence'
  | 'environment'
  | 'investment'

export interface LegendEntry {
  color: string
  label: string
  shape?: 'circle' | 'diamond' | 'line' | 'square' | 'ramp'
}

export interface LayerDef {
  id: string
  label: string
  description: string
  group: LayerGroupId
  defaultEnabled: boolean
  legend?: LegendEntry[]
  /** Repo-relative data source, shown in the row tooltip — provenance honesty. */
  source: string
}

export const GROUPS: Array<{ id: LayerGroupId; label: string }> = [
  { id: 'geopolitical', label: 'Geopolitical' },
  { id: 'economic', label: 'Economic' },
  { id: 'infrastructure', label: 'Infrastructure' },
  { id: 'utilities', label: 'Utilities' },
  { id: 'intelligence', label: 'Intelligence' },
  { id: 'environment', label: 'Environment' },
  { id: 'investment', label: 'Investment' },
]

// Sequential single-hue ramp (design-system §2) for score-graded shading.
export const SEQ_RAMP = ['#cde2fb', '#86b6ef', '#5598e7', '#2a78d6', '#1c5cab', '#0d366b']

const ramp = (lo: string, hi: string): LegendEntry[] => [{ color: 'ramp', label: `${lo} → ${hi}`, shape: 'ramp' }]

export const LAYERS: LayerDef[] = [
  // ── Geopolitical ──────────────────────────────────────────────────────────
  {
    id: 'conflicts',
    label: 'Active Conflicts',
    description: 'Armed conflicts, civil wars, and territorial disputes that destabilize regions and redirect capital flows.',
    group: 'geopolitical',
    defaultEnabled: true,
    legend: [
      { color: '#ef4444', label: 'Critical', shape: 'circle' },
      { color: '#f97316', label: 'High', shape: 'circle' },
      { color: '#eab308', label: 'Medium', shape: 'circle' },
      { color: '#84cc16', label: 'Low', shape: 'circle' },
    ],
    source: 'src/worldmap/data/conflicts.json (30 conflicts, curated)',
  },
  {
    id: 'conflict-zones',
    label: 'Conflict Zones',
    description: 'Geographic footprint of active conflict areas — indicates territorial control and displacement risk. (Ganged to Active Conflicts in the current app; independent toggle here.)',
    group: 'geopolitical',
    defaultEnabled: true,
    legend: [
      { color: '#ef4444', label: 'Critical', shape: 'square' },
      { color: '#f97316', label: 'High', shape: 'square' },
    ],
    source: 'src/worldmap/data/conflict-zones.json (24 GeoJSON polygons)',
  },

  // ── Economic ──────────────────────────────────────────────────────────────
  {
    id: 'trade-routes',
    label: 'Trade Routes',
    description: 'Major shipping lanes, pipelines, and rail corridors — disruptions directly impact global supply chains.',
    group: 'economic',
    defaultEnabled: false,
    legend: [
      { color: '#06b6d4', label: 'Critical volume', shape: 'line' },
      { color: '#3b82f6', label: 'High volume', shape: 'line' },
      { color: '#6366f1', label: 'Medium volume', shape: 'line' },
      { color: '#8b5cf6', label: 'Low volume', shape: 'line' },
    ],
    source: 'src/worldmap/data/trade-routes.json (19 routes)',
  },
  {
    id: 'chokepoints',
    label: 'Strategic Chokepoints',
    description: 'Maritime passages where a small number of vessels control a disproportionate share of global trade.',
    group: 'economic',
    defaultEnabled: false,
    legend: [
      { color: '#22c55e', label: 'Low risk', shape: 'diamond' },
      { color: '#f59e0b', label: 'Medium risk', shape: 'diamond' },
      { color: '#ef4444', label: 'High risk', shape: 'diamond' },
    ],
    source: 'src/worldmap/data/trade-routes.json → chokepoints[] (18)',
  },
  {
    id: 'portfolio-trade',
    label: 'Portfolio Trade Exposure',
    description: 'Bilateral trade flows colored by commodity, restricted to lanes that touch the portfolio. Click a chokepoint to filter lanes through it and see exposed tickers.',
    group: 'economic',
    defaultEnabled: false,
    legend: [
      { color: '#06b6d4', label: 'Semis', shape: 'line' },
      { color: '#ef4444', label: 'Energy', shape: 'line' },
      { color: '#a855f7', label: 'Pharma', shape: 'line' },
      { color: '#94a3b8', label: 'Industrial metals', shape: 'line' },
      { color: '#fbbf24', label: 'Chokepoint', shape: 'diamond' },
    ],
    source: 'GET /api/trade-graph (+/events, Postgres trade schema — live, 5 min refresh)',
  },

  // ── Infrastructure ────────────────────────────────────────────────────────
  {
    id: 'airports',
    label: 'Major Airports',
    description: 'International airports by strategic and economic significance — power projection, logistics, and trade hubs.',
    group: 'infrastructure',
    defaultEnabled: false,
    legend: [
      { color: '#f97316', label: 'Critical', shape: 'circle' },
      { color: '#3b82f6', label: 'High', shape: 'circle' },
      { color: '#64748b', label: 'Medium', shape: 'circle' },
    ],
    source: 'src/worldmap/data/validated/airports.json (390 airports)',
  },
  {
    id: 'seaports',
    label: 'Seaports',
    description: 'Container and bulk cargo ports — chokepoints in global manufacturing and commodity supply chains.',
    group: 'infrastructure',
    defaultEnabled: false,
    legend: [
      { color: '#06b6d4', label: 'Container', shape: 'circle' },
      { color: '#f59e0b', label: 'Oil/LNG', shape: 'circle' },
      { color: '#8b5cf6', label: 'Bulk', shape: 'circle' },
      { color: '#ef4444', label: 'Naval', shape: 'circle' },
      { color: '#22c55e', label: 'Mixed', shape: 'circle' },
    ],
    source: 'src/worldmap/data/validated/seaports.json (343 ports)',
  },
  {
    id: 'datacenters',
    label: 'Datacenters',
    description: 'Hyperscale and colocation datacenters — the physical infrastructure of AI, cloud, and digital economy sovereignty.',
    group: 'infrastructure',
    defaultEnabled: false,
    legend: [
      { color: '#a78bfa', label: 'Hyperscale', shape: 'circle' },
      { color: '#22d3ee', label: 'Colocation', shape: 'circle' },
      { color: '#ef4444', label: 'Government', shape: 'circle' },
      { color: '#64748b', label: 'Enterprise', shape: 'circle' },
    ],
    source: 'src/worldmap/data/validated/datacenters.json (300 sites)',
  },
  {
    id: 'submarine-cables',
    label: 'Submarine Cables',
    description: 'Undersea internet cables carrying 95% of global internet traffic — critical and vulnerable digital infrastructure.',
    group: 'infrastructure',
    defaultEnabled: false,
    legend: [
      { color: '#06b6d4', label: 'Active', shape: 'line' },
      { color: '#f59e0b', label: 'Construction', shape: 'line' },
      { color: '#ef4444', label: 'Damaged', shape: 'line' },
    ],
    source: 'src/worldmap/data/validated/submarine-cables.json (300 cables)',
  },
  {
    id: 'rail-hubs',
    label: 'Rail Hubs',
    description: 'Major rail hubs including BRI corridors, border crossings, and freight terminals — land-based supply chain infrastructure.',
    group: 'infrastructure',
    defaultEnabled: false,
    legend: [
      { color: '#f59e0b', label: 'Freight', shape: 'circle' },
      { color: '#60a5fa', label: 'Passenger', shape: 'circle' },
      { color: '#f97316', label: 'Border crossing', shape: 'circle' },
      { color: '#34d399', label: 'Port interface', shape: 'circle' },
      { color: '#22d3ee', label: 'High speed', shape: 'circle' },
    ],
    source: 'src/worldmap/data/validated/rail-hubs.json (328 hubs)',
  },
  {
    id: 'hospitals',
    label: 'Major Hospitals',
    description: 'Top hospitals globally (Newsweek 2024 + JCI + bed count). Soft-power and healthcare-system development signal.',
    group: 'infrastructure',
    defaultEnabled: false,
    legend: [
      { color: '#3b82f6', label: 'Public/Government', shape: 'circle' },
      { color: '#22d3ee', label: 'Private nonprofit', shape: 'circle' },
      { color: '#a78bfa', label: 'Private for-profit', shape: 'circle' },
    ],
    source: 'src/worldmap/data/validated/hospitals.json (488 hospitals)',
  },

  // ── Utilities ─────────────────────────────────────────────────────────────
  {
    id: 'power-plants',
    label: 'Power Infrastructure',
    description: 'Major energy generation facilities — energy security is a primary driver of geopolitical positioning.',
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
    source: 'src/worldmap/data/validated/power-plants.json (502 plants)',
  },
  {
    id: 'refineries',
    label: 'Refineries & LNG',
    description: 'Global oil refineries (>100k bpd) + LNG export/import terminals. Concentration reveals downstream energy choke points.',
    group: 'utilities',
    defaultEnabled: false,
    legend: [
      { color: '#fb923c', label: 'Crude refinery', shape: 'circle' },
      { color: '#facc15', label: 'Condensate', shape: 'circle' },
      { color: '#a855f7', label: 'Petrochemical', shape: 'circle' },
      { color: '#22d3ee', label: 'LNG export', shape: 'circle' },
      { color: '#3b82f6', label: 'LNG import', shape: 'circle' },
    ],
    source: 'src/worldmap/data/validated/refineries.json (280 facilities)',
  },
  {
    id: 'critical-minerals',
    label: 'Critical Mineral Mines',
    description: 'Mines producing ≥1% global supply for copper, lithium, cobalt, nickel, rare earths, etc.',
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
    source: 'src/worldmap/data/validated/critical-mineral-mines.json (250 mines)',
  },
  {
    id: 'water-infra',
    label: 'Water Infrastructure',
    description: 'Major desalination plants + hydropower & water-supply dams. Surfaces water-security investment.',
    group: 'utilities',
    defaultEnabled: false,
    legend: [
      { color: '#06b6d4', label: 'Desalination', shape: 'circle' },
      { color: '#3b82f6', label: 'Hydropower dam', shape: 'circle' },
      { color: '#22c55e', label: 'Supply dam', shape: 'circle' },
      { color: '#a855f7', label: 'Combined-use', shape: 'circle' },
    ],
    source: 'src/worldmap/data/validated/water-infrastructure.json (370 facilities)',
  },
  {
    id: 'mci',
    label: 'Digital Connectivity (MCI)',
    description: 'GSMA Mobile Connectivity Index 2024 for 173 countries. Bubble size = MCI score 0-100.',
    group: 'utilities',
    defaultEnabled: false,
    legend: [
      { color: '#22d3ee', label: 'Leader (>85)', shape: 'circle' },
      { color: '#3b82f6', label: 'Advanced (70-85)', shape: 'circle' },
      { color: '#a855f7', label: 'Transitioner (55-70)', shape: 'circle' },
      { color: '#f59e0b', label: 'Discoverer (<55)', shape: 'circle' },
    ],
    source: 'src/worldmap/data/validated/mci-latest.json (173 countries)',
  },
  {
    id: 'energy-mix',
    label: 'Energy Mix',
    description: 'Electricity generation by source — reveals fossil fuel dependency, renewables transition, and energy independence risk.',
    group: 'utilities',
    defaultEnabled: false,
    legend: [
      { color: '#34d399', label: 'Renewable-led', shape: 'circle' },
      { color: '#a78bfa', label: 'Nuclear-led', shape: 'circle' },
      { color: '#78716c', label: 'Fossil-led', shape: 'circle' },
    ],
    source: 'src/worldmap/data/validated/energy-mix.json (60 countries)',
  },

  // ── Intelligence ──────────────────────────────────────────────────────────
  {
    id: 'heatmap',
    label: 'Country Heatmap',
    description: 'Comparative country scoring across 12 geopolitical, energy, and food/water indicators. Driven by the Country shading selector — one indicator at a time.',
    group: 'intelligence',
    defaultEnabled: false,
    legend: ramp('Low', 'High'),
    source: 'src/worldmap/data/indicators-index.json (~214 countries) + validated/utilities.json + food-security.json',
  },
  {
    id: 'intelligence-events',
    label: 'Intelligence Events',
    description: 'Hub-imported geopolitical events — conflicts, sanctions, diplomatic shifts, and energy disruptions. The same feed the List tab renders.',
    group: 'intelligence',
    defaultEnabled: true,
    legend: [
      { color: '#d03b3b', label: 'Sev 5', shape: 'circle' },
      { color: '#ec835a', label: 'Sev 4', shape: 'circle' },
      { color: '#fab219', label: 'Sev 3', shape: 'circle' },
      { color: '#898781', label: 'Sev ≤2', shape: 'circle' },
    ],
    source: 'world-intelligence-data-hub- exports → public/data/imports/events.json (daily pipeline)',
  },

  // ── Environment ───────────────────────────────────────────────────────────
  {
    id: 'water-stress',
    label: 'Water Stress',
    description: 'Water scarcity risk — a growing driver of migration, food insecurity, and regional conflict.',
    group: 'environment',
    defaultEnabled: false,
    legend: ramp('Low stress', 'Extreme'),
    source: 'src/worldmap/data/validated/water-stress.json (194 countries, WRI Aqueduct 4.0)',
  },
  {
    id: 'food-security',
    label: 'Food Security',
    description: 'Food supply vulnerability — countries with high food insecurity face compounded geopolitical instability.',
    group: 'environment',
    defaultEnabled: false,
    legend: ramp('Secure', 'Alarming'),
    source: 'src/worldmap/data/validated/food-security.json (148 countries, GHI/IPC/FAO)',
  },

  // ── Investment ────────────────────────────────────────────────────────────
  {
    id: 'investment-signals',
    label: 'Investment Signals',
    description: 'Country-level risk/opportunity signals by sector, backed by source-attributed intelligence.',
    group: 'investment',
    defaultEnabled: false,
    legend: [
      { color: '#0ca30c', label: 'Bullish', shape: 'diamond' },
      { color: '#898781', label: 'Neutral', shape: 'diamond' },
      { color: '#d03b3b', label: 'Bearish', shape: 'diamond' },
    ],
    source: 'src/worldmap/data/validated/investment-signals.json (240 signals)',
  },
]

export const layersByGroup = (g: LayerGroupId) => LAYERS.filter((l) => l.group === g)

export const DEFAULT_VISIBILITY: Record<string, boolean> = Object.fromEntries(
  LAYERS.filter((l) => l.id !== 'heatmap').map((l) => [l.id, l.defaultEnabled]),
)

/* --------------------------------- lenses --------------------------------- */
// One-click curated layer combos. Derived from the registry's `themes`
// (ThematicScope) tags — the thematic view mode layers/_core/types.ts
// documents as the intended future use. A lens REPLACES the visible set;
// manual toggles afterwards mark the lens as custom. Every layer stays
// individually toggleable below the lens row.

export interface Lens {
  id: string
  label: string
  hint: string
  layers: string[]
}

export const LENSES: Lens[] = [
  {
    id: 'briefing',
    label: 'Morning brief',
    hint: 'Default view — active conflicts, their zones, and today\'s intelligence events.',
    layers: ['conflicts', 'conflict-zones', 'intelligence-events'],
  },
  {
    id: 'portfolio',
    label: 'My portfolio',
    hint: 'Trade lanes that touch the real portfolio, the chokepoints they pass, and country signals.',
    layers: ['portfolio-trade', 'chokepoints', 'investment-signals', 'intelligence-events'],
  },
  {
    id: 'energy',
    label: 'Energy security',
    hint: 'Generation, refining, LNG, mineral supply, and the routes that move it.',
    layers: ['power-plants', 'refineries', 'critical-minerals', 'chokepoints', 'trade-routes', 'intelligence-events'],
  },
  {
    id: 'logistics',
    label: 'Logistics',
    hint: 'Routes, chokepoints, ports, airports, and rail — the supply-chain fragility picture.',
    layers: ['trade-routes', 'chokepoints', 'seaports', 'airports', 'rail-hubs', 'intelligence-events'],
  },
  {
    id: 'digital',
    label: 'Digital sovereignty',
    hint: 'Datacenters, submarine cables, and mobile connectivity.',
    layers: ['datacenters', 'submarine-cables', 'mci', 'intelligence-events'],
  },
]

/* ---------------------------- heatmap indicators --------------------------- */
// Mirrors lib/geo/indicators.ts: 12 indicators, grouped; two are inverted
// (high = bad), which flips the ramp direction in the legend.

export type IndicatorKey =
  | 'none'
  | 'politicalStability' | 'economicDirection' | 'investmentAttractiveness'
  | 'geopoliticalRisk' | 'educationQuality' | 'healthcareQuality' | 'technologyInvestment'
  | 'renewableShare' | 'fossilFuelShare' | 'nuclearShare'
  | 'foodSecurityScore' | 'waterStressScore'

export const INDICATOR_LABELS: Record<IndicatorKey, string> = {
  none: 'None',
  politicalStability: 'Political Stability',
  economicDirection: 'Economic Direction',
  investmentAttractiveness: 'Investment Attractiveness',
  geopoliticalRisk: 'Geopolitical Risk',
  educationQuality: 'Education Quality',
  healthcareQuality: 'Healthcare Quality',
  technologyInvestment: 'Technology Investment',
  renewableShare: 'Renewable Energy %',
  fossilFuelShare: 'Fossil Fuel %',
  nuclearShare: 'Nuclear Energy %',
  foodSecurityScore: 'Food Security (GFSI)',
  waterStressScore: 'Water Stress',
}

export const INDICATOR_GROUPS: Array<{ label: string; keys: IndicatorKey[] }> = [
  {
    label: 'Geopolitical',
    keys: ['politicalStability', 'economicDirection', 'investmentAttractiveness',
      'geopoliticalRisk', 'educationQuality', 'healthcareQuality', 'technologyInvestment'],
  },
  { label: 'Energy', keys: ['renewableShare', 'fossilFuelShare', 'nuclearShare'] },
  { label: 'Food & Water', keys: ['foodSecurityScore', 'waterStressScore'] },
]

/** Indicators where high = bad — ramp direction flips. */
export const INVERTED_INDICATORS = new Set<IndicatorKey>(['fossilFuelShare', 'waterStressScore'])

/* ------------------------------ sample geodata ----------------------------- */
// Real rows excerpted from the source files named in each layer's `source`.

export interface Pt {
  name: string
  lng: number
  lat: number
  k: string
  v?: number
  /**
   * Facility importance tier for the density control: 1 (default) = key
   * facility, always shown; 2 = extended registry, shown only in "All"
   * density (small until zoomed in). Production maps this to each registry's
   * own importance/significance field (e.g. airports' strategic tier).
   */
  tier?: 1 | 2
  /** ISO3 — links country-scored samples to their COUNTRY_SHAPES polygon. */
  iso?: string
}
export interface Line { name: string; k: string; path: Array<[number, number]> }
export interface Zone { name: string; k: string; ring: Array<[number, number]> }

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

export const SAMPLE_CONFLICT_ZONES: Zone[] = [
  { name: 'Russia–Ukraine eastern/southern front', k: 'critical',
    ring: [[33.5, 46.5], [36.5, 46.5], [38.5, 47.5], [40.0, 49.5], [38.0, 50.5], [35.5, 48.5], [33.5, 46.5]] },
  { name: 'Gaza Strip', k: 'critical',
    ring: [[34.2, 31.2], [34.55, 31.3], [34.5, 31.6], [34.2, 31.5], [34.2, 31.2]] },
  { name: 'Darfur (El Fasher)', k: 'high',
    ring: [[24.0, 12.5], [27.5, 12.8], [27.0, 15.5], [24.0, 15.0], [24.0, 12.5]] },
]

export const SAMPLE_TRADE_ROUTES: Line[] = [
  { name: 'Trans-Pacific (North)', k: 'critical', path: [[121.5, 31.2], [180, 40], [-140, 40], [-118.2, 33.7]] },
  { name: 'Asia–Europe via Suez', k: 'critical', path: [[114.1, 22.3], [103.8, 1.3], [43.3, 12.5], [32.5, 30.5], [5.4, 43.3]] },
  { name: 'Trans-Atlantic', k: 'high', path: [[4.4, 51.9], [-30, 45], [-74.0, 40.7]] },
  { name: 'Gulf energy exports', k: 'high', path: [[56.4, 26.6], [67, 20], [72.9, 19.0]] },
  { name: 'China–Europe rail (BRI)', k: 'medium', path: [[108.9, 34.3], [76.9, 43.2], [60.6, 56.8], [21.0, 52.2]] },
]

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

export const SAMPLE_PORTFOLIO_LANES: Line[] = [
  { name: 'TWN→USA semiconductors (TSM, NVDA)', k: 'semis', path: [[121.0, 23.8], [155, 35], [-122.4, 37.8]] },
  { name: 'KOR→USA semiconductors (MU)', k: 'semis', path: [[127.0, 37.5], [170, 40], [-118.2, 33.7]] },
  { name: 'SAU→CHN crude (GULF.BK theme)', k: 'energy', path: [[50.1, 26.4], [72, 8], [103.8, 1.3], [114.1, 22.3]] },
  { name: 'AUS→CHN industrial metals', k: 'industrial_metals', path: [[118.6, -20.3], [114.1, 22.3]] },
]

export const SAMPLE_AIRPORTS: Pt[] = [
  { name: 'Dubai International (DXB)', lng: 55.37, lat: 25.25, k: 'critical' },
  { name: 'Heathrow (LHR)', lng: -0.45, lat: 51.47, k: 'critical' },
  { name: 'Singapore Changi (SIN)', lng: 103.99, lat: 1.36, k: 'critical' },
  { name: 'Suvarnabhumi (BKK)', lng: 100.75, lat: 13.69, k: 'high' },
  { name: 'Frankfurt (FRA)', lng: 8.56, lat: 50.04, k: 'high' },
  { name: 'Sharjah (SHJ)', lng: 55.52, lat: 25.33, k: 'medium' },
  // tier 2 — extended registry (representative of the other ~384 rows)
  { name: 'Hartsfield–Jackson Atlanta (ATL)', lng: -84.43, lat: 33.64, k: 'critical', tier: 2 },
  { name: 'Los Angeles (LAX)', lng: -118.41, lat: 33.94, k: 'critical', tier: 2 },
  { name: 'Tokyo Haneda (HND)', lng: 139.78, lat: 35.55, k: 'critical', tier: 2 },
  { name: 'Istanbul (IST)', lng: 28.75, lat: 41.26, k: 'high', tier: 2 },
  { name: 'Delhi Indira Gandhi (DEL)', lng: 77.1, lat: 28.56, k: 'high', tier: 2 },
  { name: 'São Paulo Guarulhos (GRU)', lng: -46.48, lat: -23.43, k: 'high', tier: 2 },
  { name: 'Sydney Kingsford Smith (SYD)', lng: 151.18, lat: -33.95, k: 'high', tier: 2 },
  { name: 'Cairo International (CAI)', lng: 31.41, lat: 30.12, k: 'medium', tier: 2 },
  { name: 'Don Mueang (DMK)', lng: 100.6, lat: 13.91, k: 'medium', tier: 2 },
  { name: 'Incheon (ICN)', lng: 126.45, lat: 37.46, k: 'critical', tier: 2 },
]

export const SAMPLE_SEAPORTS: Pt[] = [
  { name: 'Jebel Ali Port', lng: 55.06, lat: 25.01, k: 'container' },
  { name: 'Port of Shanghai', lng: 121.5, lat: 31.23, k: 'container' },
  { name: 'Port of Fujairah', lng: 56.36, lat: 25.19, k: 'oil' },
  { name: 'Port of Rotterdam', lng: 4.4, lat: 51.9, k: 'mixed' },
  { name: 'Saqr Port', lng: 56.06, lat: 25.98, k: 'bulk' },
  { name: 'Norfolk Naval Station', lng: -76.3, lat: 36.95, k: 'naval' },
  // tier 2 — extended registry
  { name: 'Port of Singapore', lng: 103.72, lat: 1.26, k: 'container', tier: 2 },
  { name: 'Port of Ningbo-Zhoushan', lng: 121.85, lat: 29.94, k: 'container', tier: 2 },
  { name: 'Port of Los Angeles', lng: -118.27, lat: 33.73, k: 'container', tier: 2 },
  { name: 'Laem Chabang', lng: 100.88, lat: 13.08, k: 'container', tier: 2 },
  { name: 'Port of Santos', lng: -46.3, lat: -23.98, k: 'mixed', tier: 2 },
  { name: 'Ras Tanura', lng: 50.16, lat: 26.64, k: 'oil', tier: 2 },
  { name: 'Port Hedland', lng: 118.58, lat: -20.31, k: 'bulk', tier: 2 },
  { name: 'Yokosuka Naval Base', lng: 139.67, lat: 35.29, k: 'naval', tier: 2 },
]

export const SAMPLE_DATACENTERS: Pt[] = [
  { name: 'AWS Middle East (UAE) Region', lng: 55.18, lat: 25.05, k: 'hyperscale' },
  { name: 'Microsoft Azure UAE North', lng: 55.2, lat: 25.08, k: 'hyperscale' },
  { name: 'Equinix SG1 Singapore', lng: 103.7, lat: 1.32, k: 'colocation' },
  { name: 'NSA Utah Data Center', lng: -111.93, lat: 40.43, k: 'government' },
  { name: 'Ashburn VA cluster', lng: -77.49, lat: 39.04, k: 'hyperscale' },
  // tier 2 — extended registry
  { name: 'Google Council Bluffs IA', lng: -95.86, lat: 41.26, k: 'hyperscale', tier: 2 },
  { name: 'AWS Dublin cluster', lng: -6.3, lat: 53.35, k: 'hyperscale', tier: 2 },
  { name: 'Frankfurt FRA1 colo', lng: 8.68, lat: 50.11, k: 'colocation', tier: 2 },
  { name: 'Tokyo TY colo cluster', lng: 139.7, lat: 35.62, k: 'colocation', tier: 2 },
  { name: 'GDS Shanghai campus', lng: 121.3, lat: 31.15, k: 'enterprise', tier: 2 },
  { name: 'True IDC Bangkok', lng: 100.56, lat: 13.72, k: 'colocation', tier: 2 },
  { name: 'Mumbai colocation cluster', lng: 72.87, lat: 19.08, k: 'colocation', tier: 2 },
]

export const SAMPLE_CABLES: Line[] = [
  { name: 'SEA-ME-WE 5 (Marseille–Tuas)', k: 'active', path: [[5.4, 43.3], [32.5, 30.5], [43.3, 12.5], [77, 6], [103.7, 1.3]] },
  { name: '2Africa (partial)', k: 'construction', path: [[-5.4, 35.9], [-17.4, 14.7], [18.4, -33.9]] },
  { name: 'AAE-1 Red Sea segment', k: 'damaged', path: [[32.5, 30.5], [43.3, 12.5], [58, 20]] },
]

export const SAMPLE_RAIL_HUBS: Pt[] = [
  { name: 'Khorgos Gateway (BRI)', lng: 80.4, lat: 44.2, k: 'border_crossing' },
  { name: 'Duisburg Intermodal', lng: 6.75, lat: 51.43, k: 'freight' },
  { name: 'Rosario Rail Export Terminal', lng: -60.65, lat: -32.94, k: 'port_interface' },
  { name: 'Tokyo Station', lng: 139.77, lat: 35.68, k: 'high_speed' },
  { name: 'Retiro Station Complex', lng: -58.38, lat: -34.59, k: 'passenger' },
  // tier 2 — extended registry
  { name: 'Chicago rail gateway', lng: -87.65, lat: 41.85, k: 'freight', tier: 2 },
  { name: 'Zhengzhou BRI terminal', lng: 113.63, lat: 34.75, k: 'freight', tier: 2 },
  { name: 'Bang Sue Grand Station', lng: 100.54, lat: 13.8, k: 'passenger', tier: 2 },
  { name: 'Alashankou border crossing', lng: 82.57, lat: 45.17, k: 'border_crossing', tier: 2 },
  { name: 'Hamburg rail-port interface', lng: 9.98, lat: 53.54, k: 'port_interface', tier: 2 },
]

export const SAMPLE_HOSPITALS: Pt[] = [
  { name: 'Mayo Clinic — Rochester', lng: -92.47, lat: 44.02, k: 'private_nonprofit' },
  { name: 'Johns Hopkins Hospital', lng: -76.59, lat: 39.3, k: 'private_nonprofit' },
  { name: 'Toronto General', lng: -79.39, lat: 43.66, k: 'public' },
  { name: 'Bumrungrad International', lng: 100.55, lat: 13.74, k: 'private_forprofit' },
  // tier 2 — extended registry
  { name: 'Charité Berlin', lng: 13.38, lat: 52.53, k: 'public', tier: 2 },
  { name: 'Singapore General', lng: 103.83, lat: 1.28, k: 'public', tier: 2 },
  { name: 'Cleveland Clinic', lng: -81.62, lat: 41.5, k: 'private_nonprofit', tier: 2 },
  { name: 'Siriraj Hospital', lng: 100.49, lat: 13.76, k: 'public', tier: 2 },
  { name: 'Asan Medical Center Seoul', lng: 127.11, lat: 37.53, k: 'private_nonprofit', tier: 2 },
]

export const SAMPLE_POWER: Pt[] = [
  { name: 'Barakah NPP (5.6 GW)', lng: 52.23, lat: 23.97, k: 'nuclear' },
  { name: 'Jebel Ali Complex (9.5 GW)', lng: 55.12, lat: 25.06, k: 'gas' },
  { name: 'MBR Al Maktoum Solar Park', lng: 55.37, lat: 24.75, k: 'solar' },
  { name: 'Three Gorges (22.5 GW)', lng: 111.0, lat: 30.83, k: 'hydro' },
  { name: 'Bełchatów (coal)', lng: 19.33, lat: 51.27, k: 'coal' },
  { name: 'Hornsea offshore wind', lng: 1.9, lat: 53.9, k: 'wind' },
  // tier 2 — extended registry
  { name: 'Kashiwazaki-Kariwa NPP', lng: 138.6, lat: 37.43, k: 'nuclear', tier: 2 },
  { name: 'Itaipu hydro (14 GW)', lng: -54.59, lat: -25.41, k: 'hydro', tier: 2 },
  { name: 'Bhadla Solar Park', lng: 71.9, lat: 27.53, k: 'solar', tier: 2 },
  { name: 'Gansu wind corridor', lng: 96.5, lat: 40.2, k: 'wind', tier: 2 },
  { name: 'Mae Moh (coal, Thailand)', lng: 99.72, lat: 18.28, k: 'coal', tier: 2 },
  { name: 'Grand Coulee hydro', lng: -118.98, lat: 47.96, k: 'hydro', tier: 2 },
]

export const SAMPLE_REFINERIES: Pt[] = [
  { name: 'Jamnagar Complex', lng: 69.86, lat: 22.36, k: 'crude_refinery' },
  { name: 'Ulsan Refinery', lng: 129.36, lat: 35.53, k: 'crude_refinery' },
  { name: 'Port Arthur', lng: -93.96, lat: 29.9, k: 'crude_refinery' },
  { name: 'Sabine Pass LNG', lng: -93.87, lat: 29.75, k: 'lng_export' },
  { name: 'Futtsu LNG', lng: 139.85, lat: 35.31, k: 'lng_import' },
  // tier 2 — extended registry
  { name: 'Ras Laffan LNG', lng: 51.55, lat: 25.92, k: 'lng_export', tier: 2 },
  { name: 'Rotterdam Pernis refinery', lng: 4.38, lat: 51.88, k: 'crude_refinery', tier: 2 },
  { name: 'Map Ta Phut (Thailand)', lng: 101.15, lat: 12.71, k: 'petrochemical', tier: 2 },
  { name: 'Zhoushan Ningbo refinery', lng: 121.9, lat: 30.0, k: 'crude_refinery', tier: 2 },
  { name: 'Freeport LNG', lng: -95.31, lat: 28.94, k: 'lng_export', tier: 2 },
]

export const SAMPLE_MINES: Pt[] = [
  { name: 'Escondida (copper)', lng: -69.07, lat: -24.28, k: 'copper' },
  { name: 'Grasberg (copper)', lng: 137.11, lat: -4.05, k: 'copper' },
  { name: 'Greenbushes (lithium)', lng: 116.06, lat: -33.86, k: 'lithium' },
  { name: 'Tenke Fungurume (cobalt)', lng: 26.22, lat: -10.59, k: 'cobalt' },
  { name: 'Mountain Pass (rare earths)', lng: -115.54, lat: 35.49, k: 'rare_earths' },
  { name: 'Bayan Obo (rare earths)', lng: 109.97, lat: 41.77, k: 'rare_earths' },
  // tier 2 — extended registry
  { name: 'Atacama lithium brine', lng: -68.25, lat: -23.5, k: 'lithium', tier: 2 },
  { name: 'Kamoa-Kakula (copper)', lng: 25.34, lat: -10.77, k: 'copper', tier: 2 },
  { name: 'Cigar Lake (uranium)', lng: -104.54, lat: 58.07, k: 'uranium', tier: 2 },
  { name: 'Sorowako (nickel)', lng: 121.35, lat: -2.53, k: 'nickel', tier: 2 },
  { name: 'Mt Weld (rare earths)', lng: 122.55, lat: -28.86, k: 'rare_earths', tier: 2 },
]

export const SAMPLE_WATER_INFRA: Pt[] = [
  { name: 'Shuaibah 3 desal', lng: 39.53, lat: 20.68, k: 'desalination' },
  { name: 'Sorek desal', lng: 34.72, lat: 31.83, k: 'desalination' },
  { name: 'Three Gorges dam', lng: 111.0, lat: 30.83, k: 'hydropower_dam' },
  { name: 'Itaipu dam', lng: -54.59, lat: -25.41, k: 'hydropower_dam' },
  { name: 'Bhumibol supply dam', lng: 98.97, lat: 17.24, k: 'supply_dam' },
  // tier 2 — extended registry
  { name: 'Grand Ethiopian Renaissance Dam', lng: 35.09, lat: 11.21, k: 'hydropower_dam', tier: 2 },
  { name: 'Ras Al Khair desal', lng: 49.2, lat: 27.55, k: 'desalination', tier: 2 },
  { name: 'Hoover Dam', lng: -114.74, lat: 36.02, k: 'combined', tier: 2 },
  { name: 'Sirikit Dam (Thailand)', lng: 100.56, lat: 17.77, k: 'supply_dam', tier: 2 },
  { name: 'Tuas desal (Singapore)', lng: 103.65, lat: 1.3, k: 'desalination', tier: 2 },
]

export const SAMPLE_MCI: Pt[] = [
  { name: 'UAE — 90.7', lng: 54.0, lat: 24.0, k: 'leader', v: 90.7 },
  { name: 'Singapore — 89.5', lng: 103.8, lat: 1.35, k: 'leader', v: 89.5 },
  { name: 'Thailand — 74.9', lng: 100.9, lat: 15.8, k: 'advanced', v: 74.9 },
  { name: 'Albania — 72.2', lng: 20.0, lat: 41.0, k: 'advanced', v: 72.2 },
  { name: 'Angola — 48.0', lng: 17.9, lat: -11.2, k: 'discoverer', v: 48.0 },
  { name: 'Afghanistan — 26.8', lng: 66.0, lat: 33.9, k: 'discoverer', v: 26.8 },
]

export const SAMPLE_ENERGY_MIX: Pt[] = [
  { name: 'China — fossil 63.6%', lng: 104.2, lat: 35.9, k: 'fossil', v: 63.6 },
  { name: 'France — nuclear-led', lng: 2.2, lat: 46.2, k: 'nuclear', v: 65 },
  { name: 'Norway — hydro-led', lng: 8.5, lat: 60.5, k: 'renewable', v: 92 },
  { name: 'Brazil — renewable-led', lng: -51.9, lat: -14.2, k: 'renewable', v: 85 },
  { name: 'Saudi Arabia — fossil-led', lng: 45.1, lat: 23.9, k: 'fossil', v: 99 },
]

/** Country shading samples — rendered as real country-polygon fills (iso →
 *  COUNTRY_SHAPES); production computes the same fill per indicator for all
 *  ~214 scored countries. */
export const SAMPLE_HEATMAP: Pt[] = [
  { name: 'USA — 9/10', iso: 'USA', lng: -98.6, lat: 39.8, k: 'seq', v: 9 },
  { name: 'Germany — 8/10', iso: 'DEU', lng: 10.4, lat: 51.2, k: 'seq', v: 8 },
  { name: 'India — 7/10', iso: 'IND', lng: 78.9, lat: 20.6, k: 'seq', v: 7 },
  { name: 'Thailand — 6/10', iso: 'THA', lng: 100.9, lat: 15.8, k: 'seq', v: 6 },
  { name: 'Russia — 2/10', iso: 'RUS', lng: 97.0, lat: 61.5, k: 'seq', v: 2 },
  { name: 'Sudan — 1/10', iso: 'SDN', lng: 30.2, lat: 12.9, k: 'seq', v: 1 },
]

export const SAMPLE_WATER_STRESS: Pt[] = [
  { name: 'Saudi Arabia — extreme (4.8)', iso: 'SAU', lng: 45.1, lat: 23.9, k: 'seq', v: 4.8 },
  { name: 'India — high (3.7)', iso: 'IND', lng: 78.9, lat: 20.6, k: 'seq', v: 3.7 },
  { name: 'Spain — high (3.4)', iso: 'ESP', lng: -3.7, lat: 40.4, k: 'seq', v: 3.4 },
  { name: 'Thailand — medium (2.6)', iso: 'THA', lng: 100.9, lat: 15.8, k: 'seq', v: 2.6 },
  { name: 'Norway — low (0.5)', iso: 'NOR', lng: 8.5, lat: 60.5, k: 'seq', v: 0.5 },
]

export const SAMPLE_FOOD_SECURITY: Pt[] = [
  { name: 'Afghanistan — alarming (GHI 38.7)', iso: 'AFG', lng: 66.0, lat: 33.9, k: 'seq', v: 38.7 },
  { name: 'Sudan — alarming', iso: 'SDN', lng: 30.2, lat: 12.9, k: 'seq', v: 36.0 },
  { name: 'Yemen — alarming', iso: 'YEM', lng: 47.5, lat: 15.6, k: 'seq', v: 34.0 },
  { name: 'India — serious', iso: 'IND', lng: 78.9, lat: 20.6, k: 'seq', v: 27.3 },
  { name: 'Thailand — moderate', iso: 'THA', lng: 100.9, lat: 15.8, k: 'seq', v: 10.2 },
]

export const SAMPLE_INVESTMENT_SIGNALS: Pt[] = [
  { name: 'USA · ai · bullish (NVDA MSFT GOOGL)', lng: -98.6, lat: 39.8, k: 'bullish' },
  { name: 'TWN · semis · bullish w/ strait risk (TSM)', lng: 121.0, lat: 23.8, k: 'bullish' },
  { name: 'THA · tourism-infra · neutral (AOT.BK)', lng: 100.9, lat: 15.8, k: 'neutral' },
  { name: 'ARE · energy-transition · bullish', lng: 54.0, lat: 24.0, k: 'bullish' },
  { name: 'RUS · all · bearish (sanctions)', lng: 97.0, lat: 61.5, k: 'bearish' },
]

/** Intelligence events — shape mirrors WorldEvent (real 2026-07-06 style rows). */
export interface EventVM {
  eventId: string
  title: string
  summary: string
  eventType: string
  severity: number // 1–5
  confidence: number // 0–1
  countries: string[]
  lng: number
  lat: number
  coordinateQuality: 'exact' | 'country_centroid'
  escalationPotential: number
  uniqueSourceCount: number
}

export const SAMPLE_EVENTS: EventVM[] = [
  {
    eventId: 'ev-hormuz-01', title: 'Iran signals possible closure of Strait of Hormuz',
    summary: 'IRGC naval exercises near the strait alongside statements tying transit rights to sanctions relief. Tanker insurance premiums up 40bps this week.',
    eventType: 'energy_disruption', severity: 5, confidence: 0.82,
    countries: ['Iran', 'Oman'], lng: 56.4, lat: 26.6, coordinateQuality: 'exact',
    escalationPotential: 0.8, uniqueSourceCount: 4,
  },
  {
    eventId: 'ev-redsea-02', title: 'Houthi attacks resume on Red Sea shipping',
    summary: 'Two commercial vessels struck near Bab el-Mandeb; major carriers re-routing around the Cape, adding 10-14 days to Asia-Europe transit.',
    eventType: 'conflict', severity: 4, confidence: 0.9,
    countries: ['Yemen'], lng: 43.3, lat: 12.5, coordinateQuality: 'exact',
    escalationPotential: 0.72, uniqueSourceCount: 6,
  },
  {
    eventId: 'ev-taiwan-03', title: 'PLA air incursions reach 6-month high near Taiwan',
    summary: 'Record sortie count into the ADIZ; TSMC contingency planning back in analyst notes. No change in US carrier posture.',
    eventType: 'conflict', severity: 4, confidence: 0.75,
    countries: ['Taiwan', 'China'], lng: 120.0, lat: 24.0, coordinateQuality: 'exact',
    escalationPotential: 0.65, uniqueSourceCount: 5,
  },
  {
    eventId: 'ev-eu-sanc-04', title: 'EU adopts 15th sanctions package on Russia',
    summary: 'New restrictions target LNG transshipment and shadow-fleet insurers. Limited near-term price impact expected.',
    eventType: 'economic', severity: 3, confidence: 0.95,
    countries: ['Russia', 'EU'], lng: 37.6, lat: 55.7, coordinateQuality: 'country_centroid',
    escalationPotential: 0.3, uniqueSourceCount: 7,
  },
  {
    eventId: 'ev-drc-05', title: 'M23 advances toward Goma; cobalt logistics at risk',
    summary: 'Renewed offensive threatens the eastern trade corridor; cobalt spot markets watching Kolwezi routes.',
    eventType: 'conflict', severity: 3, confidence: 0.6,
    countries: ['DR Congo'], lng: 29.2, lat: -1.7, coordinateQuality: 'country_centroid',
    escalationPotential: 0.55, uniqueSourceCount: 2,
  },
]

/* ----------------------------- inspector payloads --------------------------- */

/** Conflict detail — shape mirrors conflicts.json rows (ConflictCard contract). */
export interface ConflictDetail {
  id: string
  name: string
  type: string
  intensity: 'critical' | 'high' | 'medium' | 'low'
  status: string
  startYear: number
  region: string
  parties: Array<{ countryName: string; role: string }>
  summary: string
  currentStatus: string
  casualties: string
  internationalInvolvement: string
}

export const CONFLICT_DETAILS: Record<string, ConflictDetail> = {
  'Russia–Ukraine War': {
    id: 'RUS-UKR-2022', name: 'Russia–Ukraine War', type: 'Armed Conflict',
    intensity: 'critical', status: 'active', startYear: 2022, region: 'Eastern Europe',
    parties: [
      { countryName: 'Russia', role: 'Aggressor / Occupying power' },
      { countryName: 'Ukraine', role: 'Defender / Occupied state' },
    ],
    summary: 'Russia launched a full-scale invasion of Ukraine on 24 February 2022, occupying large portions of eastern and southern Ukraine. The largest armed conflict in Europe since World War II.',
    currentStatus: 'Active front lines across eastern Ukraine (Donetsk, Zaporizhzhia). Drone and missile exchanges targeting civilian infrastructure ongoing as of 2026.',
    casualties: 'Est. 300,000–500,000+ combined military casualties; 10,000+ confirmed civilian deaths (UN). Likely undercounted.',
    internationalInvolvement: 'NATO members supplying weapons, intelligence, and financial support to Ukraine. Russia backed diplomatically by China, North Korea (weapons), Iran (drones).',
  },
  'Israel–Gaza War': {
    id: 'ISR-GAZ-2023', name: 'Israel–Gaza War', type: 'Armed Conflict',
    intensity: 'critical', status: 'active', startYear: 2023, region: 'Middle East',
    parties: [
      { countryName: 'Israel', role: 'State party' },
      { countryName: 'Gaza (Hamas)', role: 'Non-state armed group' },
    ],
    summary: 'War following the October 2023 attacks; extensive urban combat and humanitarian crisis in the Gaza Strip with regional spillover (Red Sea, Lebanon).',
    currentStatus: 'Intermittent ceasefire negotiations; strikes and ground operations continue in phases as of 2026.',
    casualties: 'Tens of thousands killed; majority of Gaza population displaced (UN OCHA).',
    internationalInvolvement: 'US military and diplomatic support to Israel; Iran-aligned groups (Houthis, Hezbollah) engaged in regional spillover.',
  },
}

/** Event intelligence analysis — shape mirrors EventAnalysis (AnalysisCard contract). */
export interface EventAnalysisVM {
  what_happened: string
  historical_context: string
  political_analysis: string
  actor_goals: Array<{ name: string; stated_goal: string; real_goal: string; red_lines: string }>
  what_to_watch: string[]
  confidence: { score: number; reasoning: string }
}

export const EVENT_ANALYSES: Record<string, EventAnalysisVM> = {
  'ev-hormuz-01': {
    what_happened: 'IRGC naval units conducted live-fire exercises within 20nm of the Strait of Hormuz shipping lanes while Iranian officials publicly linked freedom of transit to sanctions relief negotiations.',
    historical_context: 'Iran has threatened closure repeatedly since 1980 but has never fully closed the strait — roughly 20% of global oil transits here, including its own exports to China.',
    political_analysis: 'Signaling ahead of the Vienna round: raising the perceived cost of a no-deal outcome without crossing the closure red line that would trigger direct US naval response.',
    actor_goals: [
      { name: 'Iran (IRGC)', stated_goal: 'Defensive readiness in territorial waters', real_goal: 'Leverage in sanctions negotiations; domestic hardliner signaling', red_lines: 'Actual closure or strike on a US-flagged vessel' },
      { name: 'United States (5th Fleet)', stated_goal: 'Freedom of navigation', real_goal: 'Deter closure without escalation before elections', red_lines: 'Mining of the strait; attack on carrier group' },
    ],
    what_to_watch: [
      'Tanker war-risk insurance premiums (leading indicator, currently +40bps)',
      'US carrier group repositioning from Diego Garcia',
      'Iranian crude exports to China — a drop signals Tehran pricing in escalation',
    ],
    confidence: { score: 0.82, reasoning: '4 independent sources incl. AIS traffic data; core facts corroborated, intent inference is analytic judgment.' },
  },
}

/** Country profile — shape mirrors data/countries/<ISO3>.json (CountryPanel + ScoreBar contract). */
export interface CountryIndicator {
  score: number
  trend: 'rising' | 'improving' | 'stable' | 'declining'
  confidence: 'high' | 'medium' | 'low'
  note?: string
}

export interface CountryProfile {
  id: string
  iso2: string
  name: string
  region: string
  capital: string
  summary: string
  indicators: Record<string, CountryIndicator>
  investmentNotes: { strengths: string[]; risks: string[]; sectors: string[] }
  lng: number
  lat: number
}

export const COUNTRY_PROFILES: Record<string, CountryProfile> = {
  THA: {
    id: 'THA', iso2: 'TH', name: 'Thailand', region: 'Asia', capital: 'Bangkok',
    summary: 'Second-largest ASEAN economy; tourism- and export-driven with deepening EV and electronics supply-chain roles. Politics cyclical between elected governments and establishment interventions.',
    indicators: {
      politicalStability: { score: 5, trend: 'stable', confidence: 'medium', note: 'Coalition politics fragile; military influence persists.' },
      economicDirection: { score: 6, trend: 'improving', confidence: 'medium', note: 'Tourism recovery + EV FDI inflows.' },
      investmentAttractiveness: { score: 6, trend: 'stable', confidence: 'high' },
      geopoliticalRisk: { score: 7, trend: 'stable', confidence: 'high', note: 'Balances US and China relationships effectively.' },
      educationQuality: { score: 5, trend: 'stable', confidence: 'medium' },
      healthcareQuality: { score: 7, trend: 'improving', confidence: 'high', note: 'Regional medical-tourism hub.' },
      technologyInvestment: { score: 5, trend: 'improving', confidence: 'medium' },
    },
    investmentNotes: {
      strengths: ['EV/electronics FDI momentum', 'Tourism cash flows', 'Regional healthcare hub'],
      risks: ['Household debt ~90% of GDP', 'Political cycle risk', 'Aging demographics'],
      sectors: ['Tourism & airports (AOT.BK)', 'Banks (KBANK.BK)', 'Energy (GULF.BK)'],
    },
    lng: 100.9, lat: 15.8,
  },
  TWN: {
    id: 'TWN', iso2: 'TW', name: 'Taiwan', region: 'Asia', capital: 'Taipei',
    summary: 'Semiconductor superpower — TSMC fabricates ~90% of leading-edge logic. The single largest concentration risk in global technology supply chains.',
    indicators: {
      politicalStability: { score: 7, trend: 'stable', confidence: 'high' },
      economicDirection: { score: 8, trend: 'rising', confidence: 'high', note: 'AI capex supercycle demand.' },
      investmentAttractiveness: { score: 7, trend: 'stable', confidence: 'medium', note: 'Discounted for strait risk.' },
      geopoliticalRisk: { score: 3, trend: 'declining', confidence: 'high', note: 'PLA pressure campaign intensifying.' },
      educationQuality: { score: 8, trend: 'stable', confidence: 'high' },
      healthcareQuality: { score: 8, trend: 'stable', confidence: 'high' },
      technologyInvestment: { score: 9, trend: 'rising', confidence: 'high' },
    },
    investmentNotes: {
      strengths: ['Leading-edge fab monopoly', 'Deep engineering talent pool'],
      risks: ['Strait blockade scenario', 'Water/power constraints on fabs'],
      sectors: ['Semiconductors (TSM)'],
    },
    lng: 121.0, lat: 23.8,
  },
}

/** Chokepoint detail — portfolio-trade click contract (lanes through + exposed tickers). */
export interface ChokepointDetail {
  name: string
  risk: 'low' | 'medium' | 'high'
  share: string
  lanesThrough: string[]
  exposedTickers: Array<{ ticker: string; via: string }>
  note: string
}

export const CHOKEPOINT_DETAILS: Record<string, ChokepointDetail> = {
  'Strait of Hormuz': {
    name: 'Strait of Hormuz', risk: 'high', share: '~20% of global oil, ~30% of seaborne crude',
    lanesThrough: ['SAU→CHN crude', 'Gulf energy exports', 'UAE→Asia LNG'],
    exposedTickers: [
      { ticker: 'GULF.BK', via: 'LNG import cost pass-through' },
      { ticker: 'PTT.BK', via: 'Crude feedstock pricing' },
    ],
    note: 'Closure scenario: +$25-40/bbl crude shock; Thai utilities margin compression within one quarter.',
  },
  'Bab el-Mandeb': {
    name: 'Bab el-Mandeb', risk: 'high', share: '~12% of global trade via Suez transits',
    lanesThrough: ['Asia–Europe via Suez'],
    exposedTickers: [{ ticker: 'MAERSK-B (watch)', via: 'Re-routing cost baseline' }],
    note: 'Active Houthi attack zone; Cape re-routing adds 10-14 days Asia-Europe.',
  },
}

/* --------------------------- country relationships -------------------------- */
// Ally / rival tints on country selection (confirmed keep in round-3 review).
// When a country is selected, other countries' REAL polygon shapes tint by
// relationship — production reads this from each country profile's alliances
// block (data/countries/<ISO3>.json); everything unlisted renders neutral.

export interface CountryRelations { allies: string[]; rivals: string[] }

export const COUNTRY_RELATIONS: Record<string, CountryRelations> = {
  THA: { allies: ['USA', 'JPN', 'AUS', 'SGP', 'MYS', 'VNM', 'IDN', 'PHL', 'KHM', 'LAO'], rivals: ['MMR'] },
  TWN: { allies: ['USA', 'JPN', 'KOR', 'PHL', 'AUS'], rivals: ['CHN', 'RUS', 'PRK'] },
  USA: { allies: ['GBR', 'FRA', 'DEU', 'JPN', 'KOR', 'AUS', 'CAN', 'MEX', 'THA', 'PHL', 'ISR', 'POL', 'ITA', 'ESP', 'NOR', 'TUR', 'TWN'], rivals: ['CHN', 'RUS', 'IRN', 'PRK'] },
  CHN: { allies: ['RUS', 'PRK', 'PAK', 'IRN', 'KHM', 'LAO', 'MMR'], rivals: ['USA', 'JPN', 'IND', 'TWN', 'KOR', 'PHL', 'AUS'] },
  RUS: { allies: ['CHN', 'PRK', 'IRN', 'MMR'], rivals: ['USA', 'GBR', 'FRA', 'DEU', 'UKR', 'POL', 'NOR', 'JPN'] },
}

/* ------------------------------ country search ----------------------------- */
// Stand-in for country-index.json (~214 entries) + Fuse.js fuzzy search.

export interface CountryEntry { id: string; iso2: string; name: string; region: string; lng: number; lat: number }

export const COUNTRY_INDEX: CountryEntry[] = [
  { id: 'THA', iso2: 'TH', name: 'Thailand', region: 'Asia', lng: 100.9, lat: 15.8 },
  { id: 'TWN', iso2: 'TW', name: 'Taiwan', region: 'Asia', lng: 121.0, lat: 23.8 },
  { id: 'USA', iso2: 'US', name: 'United States', region: 'Americas', lng: -98.6, lat: 39.8 },
  { id: 'CHN', iso2: 'CN', name: 'China', region: 'Asia', lng: 104.2, lat: 35.9 },
  { id: 'JPN', iso2: 'JP', name: 'Japan', region: 'Asia', lng: 138.3, lat: 36.2 },
  { id: 'KOR', iso2: 'KR', name: 'South Korea', region: 'Asia', lng: 127.8, lat: 36.5 },
  { id: 'IND', iso2: 'IN', name: 'India', region: 'Asia', lng: 78.9, lat: 20.6 },
  { id: 'IRN', iso2: 'IR', name: 'Iran', region: 'Middle East', lng: 53.7, lat: 32.4 },
  { id: 'SAU', iso2: 'SA', name: 'Saudi Arabia', region: 'Middle East', lng: 45.1, lat: 23.9 },
  { id: 'ARE', iso2: 'AE', name: 'United Arab Emirates', region: 'Middle East', lng: 54.0, lat: 24.0 },
  { id: 'RUS', iso2: 'RU', name: 'Russia', region: 'Europe/Asia', lng: 97.0, lat: 61.5 },
  { id: 'UKR', iso2: 'UA', name: 'Ukraine', region: 'Europe', lng: 31.2, lat: 48.4 },
  { id: 'DEU', iso2: 'DE', name: 'Germany', region: 'Europe', lng: 10.4, lat: 51.2 },
  { id: 'GBR', iso2: 'GB', name: 'United Kingdom', region: 'Europe', lng: -3.4, lat: 55.4 },
  { id: 'FRA', iso2: 'FR', name: 'France', region: 'Europe', lng: 2.2, lat: 46.2 },
  { id: 'BRA', iso2: 'BR', name: 'Brazil', region: 'Americas', lng: -51.9, lat: -14.2 },
  { id: 'AUS', iso2: 'AU', name: 'Australia', region: 'Oceania', lng: 133.8, lat: -25.3 },
  { id: 'EGY', iso2: 'EG', name: 'Egypt', region: 'Africa', lng: 30.8, lat: 26.8 },
  { id: 'COD', iso2: 'CD', name: 'DR Congo', region: 'Africa', lng: 21.8, lat: -4.0 },
  { id: 'SGP', iso2: 'SG', name: 'Singapore', region: 'Asia', lng: 103.8, lat: 1.35 },
]

/* ------------------------------ basemap geometry ---------------------------- */
// Round 3: the coarse hand-drawn continent silhouettes are GONE, replaced by
// real per-country polygons in countries-geo.ts (generated from the repo's
// production countries-110m.json — see bake-countries.mjs). Every country now
// has a visible border, is hover-namable and click-selectable, and heatmap /
// ally-rival shading fills the country's actual shape. Production renders the
// same source file at full resolution in MapLibre.

/* --------------------------------- map labels -------------------------------- */
// Country + ocean/sea name labels for the SVG basemap stand-in. Curated, not
// exhaustive: countries are the ones referenced by COUNTRY_INDEX / the sample
// layers, waters are the basins the routes/chokepoints actually traverse.
// Positions are hand-tuned so labels sit clear of layer marks at default zoom.
// Production note: the MapLibre dark basemap ships its own label layer — this
// list is only the mockup equivalent so reviewers can orient themselves.

export interface MapLabel {
  text: string
  lng: number
  lat: number
  kind: 'country' | 'water'
  /** font size in SVG user units (viewBox is 960×480) */
  size: number
  anchor?: 'start' | 'middle'
}

export const MAP_LABELS: MapLabel[] = [
  // countries — majors
  { text: 'UNITED STATES', lng: -100, lat: 39, kind: 'country', size: 12 },
  { text: 'BRAZIL', lng: -52, lat: -11, kind: 'country', size: 12 },
  { text: 'RUSSIA', lng: 95, lat: 62, kind: 'country', size: 12 },
  { text: 'CHINA', lng: 102, lat: 32, kind: 'country', size: 12 },
  { text: 'AUSTRALIA', lng: 133.8, lat: -26, kind: 'country', size: 12 },
  { text: 'INDIA', lng: 78.5, lat: 21, kind: 'country', size: 10 },
  // countries — mid
  { text: 'IRAN', lng: 54, lat: 32.5, kind: 'country', size: 9 },
  { text: 'SAUDI ARABIA', lng: 44, lat: 21, kind: 'country', size: 8 },
  { text: 'EGYPT', lng: 29, lat: 25.5, kind: 'country', size: 8 },
  { text: 'DR CONGO', lng: 22.5, lat: -3.5, kind: 'country', size: 8 },
  { text: 'THAILAND', lng: 100, lat: 18.5, kind: 'country', size: 7.5 },
  { text: 'UKRAINE', lng: 25, lat: 52.5, kind: 'country', size: 7.5 },
  { text: 'GERMANY', lng: 11, lat: 48.8, kind: 'country', size: 7.5 },
  { text: 'FRANCE', lng: 0, lat: 45.5, kind: 'country', size: 7.5 },
  { text: 'JAPAN', lng: 144.5, lat: 34.5, kind: 'country', size: 7.5, anchor: 'start' },
  // countries — small (positions offset into open water where the marks crowd)
  { text: 'UK', lng: -6.5, lat: 57, kind: 'country', size: 7 },
  { text: 'S. KOREA', lng: 125, lat: 34, kind: 'country', size: 7 },
  { text: 'TAIWAN', lng: 124.5, lat: 21.3, kind: 'country', size: 7, anchor: 'start' },
  { text: 'UAE', lng: 55.3, lat: 22.6, kind: 'country', size: 7 },
  { text: 'SINGAPORE', lng: 106, lat: 4.5, kind: 'country', size: 7, anchor: 'start' },
  // waters
  { text: 'PACIFIC OCEAN', lng: -152, lat: 5, kind: 'water', size: 11 },
  { text: 'ATLANTIC OCEAN', lng: -38, lat: 28, kind: 'water', size: 11 },
  { text: 'INDIAN OCEAN', lng: 80, lat: -23, kind: 'water', size: 11 },
  { text: 'MEDITERRANEAN SEA', lng: 15, lat: 36.5, kind: 'water', size: 6 },
  { text: 'ARABIAN SEA', lng: 64, lat: 12, kind: 'water', size: 7 },
  { text: 'SOUTH CHINA SEA', lng: 115.5, lat: 12.5, kind: 'water', size: 6 },
]

/* --------------------------------- helpers --------------------------------- */

export const CLASS_COLOR: Record<string, Record<string, string>> = {
  conflicts: { critical: '#ef4444', high: '#f97316', medium: '#eab308', low: '#84cc16' },
  'conflict-zones': { critical: '#ef4444', high: '#f97316' },
  'trade-routes': { critical: '#06b6d4', high: '#3b82f6', medium: '#6366f1', low: '#8b5cf6' },
  chokepoints: { low: '#22c55e', medium: '#f59e0b', high: '#ef4444' },
  'portfolio-trade': { semis: '#06b6d4', energy: '#ef4444', pharma: '#a855f7', industrial_metals: '#94a3b8' },
  airports: { critical: '#f97316', high: '#3b82f6', medium: '#64748b' },
  seaports: { container: '#06b6d4', oil: '#f59e0b', bulk: '#8b5cf6', naval: '#ef4444', mixed: '#22c55e' },
  datacenters: { hyperscale: '#a78bfa', colocation: '#22d3ee', government: '#ef4444', enterprise: '#64748b' },
  'submarine-cables': { active: '#06b6d4', construction: '#f59e0b', damaged: '#ef4444' },
  'rail-hubs': { freight: '#f59e0b', passenger: '#60a5fa', border_crossing: '#f97316', port_interface: '#34d399', high_speed: '#22d3ee' },
  hospitals: { public: '#3b82f6', private_nonprofit: '#22d3ee', private_forprofit: '#a78bfa' },
  'power-plants': { nuclear: '#a78bfa', coal: '#78716c', gas: '#f59e0b', hydro: '#0ea5e9', solar: '#fbbf24', wind: '#34d399' },
  refineries: { crude_refinery: '#fb923c', condensate: '#facc15', petrochemical: '#a855f7', lng_export: '#22d3ee', lng_import: '#3b82f6' },
  'critical-minerals': { copper: '#f97316', lithium: '#22d3ee', cobalt: '#3b82f6', rare_earths: '#a855f7', uranium: '#10b981', nickel: '#94a3b8' },
  'water-infra': { desalination: '#06b6d4', hydropower_dam: '#3b82f6', supply_dam: '#22c55e', combined: '#a855f7' },
  mci: { leader: '#22d3ee', advanced: '#3b82f6', transitioner: '#a855f7', discoverer: '#f59e0b' },
  'energy-mix': { renewable: '#34d399', nuclear: '#a78bfa', fossil: '#78716c' },
  'investment-signals': { bullish: '#0ca30c', neutral: '#898781', bearish: '#d03b3b' },
}

export const classColor = (layerId: string, k: string) => CLASS_COLOR[layerId]?.[k] ?? '#898781'

export const EVENT_COLOR = (s: number) => (s >= 5 ? '#d03b3b' : s >= 4 ? '#ec835a' : s >= 3 ? '#fab219' : '#898781')

export function seqColor(t: number): string {
  const i = Math.min(SEQ_RAMP.length - 1, Math.max(0, Math.round(t * (SEQ_RAMP.length - 1))))
  return SEQ_RAMP[i]
}
