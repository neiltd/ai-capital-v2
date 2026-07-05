// Trade-graph V1 types. See memory/project_trade_graph_v1.md for design.

/** Commodity categories — HS codes collapse into these 10 buckets for readability.
 *  Constrained in TS, not in SQL, so we can evolve without a migration. */
export const COMMODITY_CATEGORIES = [
  'energy',           // oil, gas, coal, electricity
  'semis',            // semiconductor chips + equipment
  'pharma',           // drugs, APIs, biologics
  'food',             // grains, meat, dairy, processed
  'industrial_metals',// steel, copper, aluminum, lithium
  'vehicles',         // cars, trucks, aircraft, parts
  'agriculture',      // raw crops, fertilizer, animal feed
  'chemicals',        // industrial chemicals, plastics, polymers
  'textiles',         // apparel, fabric, footwear
  'other',
] as const
export type CommodityCategory = typeof COMMODITY_CATEGORIES[number]

/** Sources of trade flow data — used for provenance + dedup. */
export type FlowSource = 'un_comtrade' | 'imf_dots' | 'manual' | 'dropzone'

export interface Country {
  iso3:         string
  name:         string
  /** Optional centroid for map drawing; null for landlocked-without-data. */
  centroidLat:  number | null
  centroidLon:  number | null
}

export interface TradeFlow {
  id:             string
  originIso3:     string
  destIso3:       string
  commodity:      CommodityCategory
  valueUsd:       bigint
  /** Year is required; quarter null means "annual aggregate". */
  periodYear:     number
  periodQuarter:  1 | 2 | 3 | 4 | null
  source:         FlowSource
  ingestedAt:     Date
}

/** Strategic maritime chokepoints — 10 fixed. Each has a list of (origin, dest)
 *  pairs whose primary route passes through it. */
export interface Chokepoint {
  id:           string   // 'hormuz', 'suez', etc — stable across releases
  name:         string
  lat:          number
  lon:          number
  description:  string | null
}

export interface ChokepointRoute {
  chokepointId: string
  originIso3:   string
  destIso3:     string
}

/** Per-ticker supply-chain dependency. LLM-derived from public info or manual.
 *  Multiple rows per ticker — each row is one (country, commodity[, route]) edge. */
export interface TickerDependency {
  id:            string
  ticker:        string
  countryIso3:   string
  commodity:     CommodityCategory
  /** If the dependency rides a known chokepoint, link it for cascade analysis. */
  chokepointId:  string | null
  /** 1 = critical (no substitute / lethal exposure)
   *  5 = mild (substitutable within ~months). */
  criticality:   1 | 2 | 3 | 4 | 5
  rationale:     string | null
  source:        'llm' | 'manual'
  createdAt:     Date
}
