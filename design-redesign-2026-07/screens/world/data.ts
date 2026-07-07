// Loader contract for /world — World intelligence.
// (Supersedes screens/specs/world-intel.md.)
//
// Sources:
//   - world-intelligence-data-hub-/exports/world-map/intelligence.json
//     (schema 2.0 — events, storylines, countrySignals; real 2026-07-06 run:
//     11 events, 6 storylines, 7 unique sources)
//   - intelligence/outputs/events/<date>.json — memory-agent graph enrichment
//     (causal_links, expected_consequences, counterfactual) joined by title,
//     exactly as investment-analyst-agents/src/briefing/world-storylines.ts
//     does for the briefing prompt.
//   - trade.ticker_dependencies (pg) — affected-ticker exposure via country
//     (criticality ≤ 2) and chokepoint (direct, ≤ 3) lookups, same needles as
//     world-storylines.ts CHOKEPOINT_PATTERNS.
//
// THE DESIGN NUANCE THIS SCREEN EXISTS FOR: world-intel does NOT flow through
// the general search/ingestion pipeline. It feeds exactly two consumers:
//   1. ai-analysis-engine regime analysis — a dedicated "World Intelligence"
//      context block in the prompt (events above the severity/relevance bar);
//   2. the briefing agent's top-5-events section (world-storylines.ts
//      enrichment → renderEnrichedEventBlock).
// Every event row therefore carries its consumption state — an event that fed
// today's regime call is a different object from wire noise, and the UI must
// keep them distinguishable. Not a generic news feed.
//
// GAPS (from spec, kept live): #23 real geocoding for GDELT rows (most rows
// are country centroids — rendered honestly as hollow marks); storyline
// causal links as edges {from,to,relation}; briefing↔event backlinks by
// eventId (needs structured briefing #1 — today the join is title-based).

export type EventState = 'developing' | 'escalating' | 'stable' | 'de-escalating'

export interface WorldEventVM {
  eventId: string
  storylineId: string | null
  title: string
  summary: string
  eventType: string
  eventState: EventState
  severity: number // 1–5
  confidence: number // 0–1 (< 0.6 renders as single-source "~")
  countries: string[]
  lat: number | null
  lng: number | null
  coordinateQuality: 'exact' | 'country_centroid'
  marketRelevance: number // 0–1
  escalationPotential: number // 0–1
  uniqueSourceCount: number
  latestSeenAt: string
  // memory-agent enrichment (world-storylines.ts) — may be absent
  causedByRationales: string[]
  expectedConsequences: string[]
  counterfactual: string | null
  affectedChokepoints: string[]
  affectedTickers: Array<{ ticker: string; held: boolean }>
  // ── consumption state — the linkage this screen exists to show ──────────
  fedRegime: boolean // entered today's regime-analysis context block
  briefingRank: number | null // 1–5 in today's briefing top-5, else null
  briefingQuote: string | null // the briefing sentence that cited it
}

export interface StorylineNode {
  date: string
  title: string
  /** Causal-link annotation between this node and the next. */
  linkToNext: string | null
}

export interface StorylineVM {
  storylineId: string
  title: string
  state: 'active' | 'escalating' | 'stable' | 'dormant'
  daysActive: number
  totalEvents: number
  totalSources: number
  avgEscalation: number
  maxSeverity: number
  nodes: StorylineNode[]
  /** Portfolio relevance footer: tickers + the briefing sentence citing it. */
  tickers: Array<{ ticker: string; held: boolean }>
  briefingCitation: string | null
}

export interface WorldViewModel {
  generatedAt: string
  date: string
  eventCount: number
  reviewExcludedCount: number
  uniqueSourceCount: number
  consumers: {
    regime: { fed: number; of: number; bar: string; output: string }
    briefing: { fed: number; of: number; output: string }
  }
  events: WorldEventVM[]
  storylines: StorylineVM[]
}

export async function loadWorld(): Promise<WorldViewModel> {
  const events = EVENTS
  return {
    generatedAt: '2026-07-06T23:44:56.143Z',
    date: '2026-07-06',
    eventCount: events.length,
    reviewExcludedCount: 2,
    uniqueSourceCount: 7,
    consumers: {
      regime: {
        fed: events.filter((e) => e.fedRegime).length,
        of: events.length,
        bar: 'severity ≥ 3 OR marketRelevance ≥ 0.4',
        output: 'AI Acceleration + Defense Tech Bid (medium confidence)',
      },
      briefing: {
        fed: events.filter((e) => e.briefingRank !== null).length,
        of: events.length,
        output: 'top-5 world events section, 2026-07-06 briefing',
      },
    },
    events,
    storylines: STORYLINES,
  }
}

const t = (ticker: string, held = false) => ({ ticker, held })

const EVENTS: WorldEventVM[] = [
  {
    eventId: 'ev-kyiv-0706', storylineId: 'sl-kyiv',
    title: 'Russia mass strike on Kyiv ahead of NATO summit',
    summary: '68 missiles and 351 drones; 23 killed. Patriot interceptor shortage publicly disclosed by Ukrainian air force command.',
    eventType: 'missile_attack', eventState: 'escalating', severity: 5, confidence: 0.78,
    countries: ['UKR', 'RUS'], lat: 50.45, lng: 30.52, coordinateQuality: 'exact',
    marketRelevance: 0.4, escalationPotential: 0.8, uniqueSourceCount: 7,
    latestSeenAt: '2026-07-06T17:22:09.000Z',
    causedByRationales: [
      'Timed to precede the NATO summit — a demonstration of reach before security-guarantee negotiations.',
      'Follows three weeks of degraded Ukrainian air-defense interceptor stocks.',
    ],
    expectedConsequences: [
      'Accelerated European defense appropriations (1–2 weeks)',
      'Patriot resupply debate strains US inventory disclosures',
      'Energy risk premium persists into ECB late-July meeting',
    ],
    counterfactual: 'Without the strike, the NATO summit likely centers on burden-sharing rather than air-defense supply — the defense-tech bid loses its nearest catalyst.',
    affectedChokepoints: [],
    affectedTickers: [t('GOLD_OZ', true), t('PLTR', true), t('CRWD')],
    fedRegime: true, briefingRank: 1,
    briefingQuote: 'Friction overlay non-trivial: Kyiv mass strike … sustains the gold risk premium and the defense-tech bid.',
  },
  {
    eventId: 'ev-lbn-0706', storylineId: 'sl-lebanon',
    title: 'Israel strikes Lebanon despite US-brokered ceasefire',
    summary: 'Airstrikes killed at least four, including a teacher; strikes continue under an active ceasefire agreement.',
    eventType: 'airstrike', eventState: 'developing', severity: 4, confidence: 0.72,
    countries: ['LBN', 'ISR'], lat: 33.9, lng: 35.5, coordinateQuality: 'country_centroid',
    marketRelevance: 0.25, escalationPotential: 0.75, uniqueSourceCount: 4,
    latestSeenAt: '2026-07-06T17:22:09.000Z',
    causedByRationales: ['Ceasefire enforcement asymmetry — no monitoring mechanism survived the June framework.'],
    expectedConsequences: ['Hezbollah escalation risk window 1–2 weeks', 'Ceasefire credibility erosion pressures US mediation'],
    counterfactual: null,
    affectedChokepoints: [],
    affectedTickers: [t('GOLD_OZ', true), t('CRWD')],
    fedRegime: true, briefingRank: 2,
    briefingQuote: 'Ceasefire credibility eroding; Hezbollah escalation risk 1–2 weeks.',
  },
  {
    eventId: 'ev-ecb-0706', storylineId: 'sl-energy',
    title: 'ECB Schnabel: Mideast peace has not restored energy conditions',
    summary: 'Executive-board speech flags TTF still elevated; hold with tightening bias likely at the late-July meeting.',
    eventType: 'policy_statement', eventState: 'stable', severity: 3, confidence: 0.9,
    countries: ['DEU'], lat: 50.11, lng: 8.68, coordinateQuality: 'exact',
    marketRelevance: 0.6, escalationPotential: 0.3, uniqueSourceCount: 3,
    latestSeenAt: '2026-07-06T15:00:00.000Z',
    causedByRationales: ['TTF +11.8% over 30d despite the June ceasefire framework.'],
    expectedConsequences: ['ECB hold w/ tightening bias late-July', 'EUR rate path repricing'],
    counterfactual: null,
    affectedChokepoints: [],
    affectedTickers: [],
    fedRegime: true, briefingRank: 3,
    briefingQuote: 'ECB energy warning … liquidity net easing but friction overlay non-trivial.',
  },
  {
    eventId: 'ev-redsea-0705', storylineId: 'sl-energy',
    title: 'Houthi attacks resume on Red Sea shipping',
    summary: 'Two commercial vessels targeted near Bab-el-Mandeb after a five-week pause; war-risk premiums re-widen.',
    eventType: 'maritime_attack', eventState: 'escalating', severity: 3, confidence: 0.68,
    countries: ['YEM'], lat: 12.6, lng: 43.3, coordinateQuality: 'exact',
    marketRelevance: 0.45, escalationPotential: 0.65, uniqueSourceCount: 3,
    latestSeenAt: '2026-07-05T21:40:00.000Z',
    causedByRationales: ['Pause ended following the Lebanon strikes — the axis re-links maritime pressure to the northern front.'],
    expectedConsequences: ['Suez transit volumes fall; Cape routing adds 10–14 days', 'Container rates firm into Q3'],
    counterfactual: null,
    affectedChokepoints: ['bab_el_mandeb', 'suez'],
    affectedTickers: [t('GULF.BK', true)],
    fedRegime: true, briefingRank: 4,
    briefingQuote: 'Red Sea resumption keeps the energy-infrastructure theme supported (GULF.BK hold).',
  },
  {
    eventId: 'ev-cn-ree-0704', storylineId: null,
    title: 'China expands rare-earth export controls to two more elements',
    summary: 'MOFCOM adds dysprosium and terbium processing tech to the control list, effective August 1.',
    eventType: 'trade_policy', eventState: 'developing', severity: 3, confidence: 0.85,
    countries: ['CHN'], lat: 35.0, lng: 105.0, coordinateQuality: 'country_centroid',
    marketRelevance: 0.55, escalationPotential: 0.5, uniqueSourceCount: 4,
    latestSeenAt: '2026-07-04T09:12:00.000Z',
    causedByRationales: ['Response sequencing to June US chip-tool restrictions.'],
    expectedConsequences: ['Magnet supply-chain requalification costs', 'Semicap export-license friction'],
    counterfactual: null,
    affectedChokepoints: ['taiwan_strait'],
    affectedTickers: [t('TSM'), t('NVDA'), t('AVGO'), t('MU')],
    fedRegime: true, briefingRank: 5,
    briefingQuote: 'Export-control tit-for-tat is the disruption scenario’s slow fuse for the AI supply chain (paper book exposure).',
  },
  {
    eventId: 'ev-hormuz-0705', storylineId: null,
    title: 'Iran stages naval exercise near Strait of Hormuz',
    summary: 'IRGC navy fast-attack drill with anti-ship missile launches; shipping unaffected so far.',
    eventType: 'military_exercise', eventState: 'developing', severity: 3, confidence: 0.55,
    countries: ['IRN'], lat: 26.6, lng: 56.5, coordinateQuality: 'exact',
    marketRelevance: 0.5, escalationPotential: 0.7, uniqueSourceCount: 1,
    latestSeenAt: '2026-07-05T14:30:00.000Z',
    causedByRationales: [],
    expectedConsequences: ['Hormuz disruption = the briefing’s named disruption-scenario trigger'],
    counterfactual: null,
    affectedChokepoints: ['hormuz'],
    affectedTickers: [t('GULF.BK', true), t('GOLD_OZ', true)],
    fedRegime: true, briefingRank: null,
    briefingQuote: null, // fed the regime block but was cut from the top-5 — single-source
  },
  {
    eventId: 'ev-sdn-0706', storylineId: null,
    title: 'Armed clashes escalate around El Fasher, Sudan',
    summary: 'RSF offensive on the last army-held Darfur capital; aid corridors closed.',
    eventType: 'armed_conflict', eventState: 'escalating', severity: 3, confidence: 0.62,
    countries: ['SDN'], lat: 15.0, lng: 30.0, coordinateQuality: 'country_centroid',
    marketRelevance: 0.05, escalationPotential: 0.6, uniqueSourceCount: 2,
    latestSeenAt: '2026-07-06T11:05:00.000Z',
    causedByRationales: [],
    expectedConsequences: [],
    counterfactual: null,
    affectedChokepoints: [],
    affectedTickers: [],
    fedRegime: true, briefingRank: null,
    briefingQuote: null, // severity qualifies it for the regime block; no market path → not top-5
  },
  {
    eventId: 'ev-tha-0703', storylineId: null,
    title: 'Bangkok protest march over coalition budget deadlock',
    summary: 'Peaceful weekend demonstration, ~15k attendance; no market reaction in SET futures.',
    eventType: 'protest', eventState: 'stable', severity: 2, confidence: 0.8,
    countries: ['THA'], lat: 13.75, lng: 100.5, coordinateQuality: 'exact',
    marketRelevance: 0.3, escalationPotential: 0.25, uniqueSourceCount: 2,
    latestSeenAt: '2026-07-03T13:00:00.000Z',
    causedByRationales: [],
    expectedConsequences: [],
    counterfactual: null,
    affectedChokepoints: [],
    affectedTickers: [t('AOT.BK', true), t('SCB.BK', true)],
    fedRegime: false, briefingRank: null,
    briefingQuote: null, // below both bars — visible here, consumed by nothing
  },
  {
    eventId: 'ev-pan-0702', storylineId: null,
    title: 'Panama Canal reinstates draft restrictions on drought',
    summary: 'ACP cuts max draft 0.5m; transit slots reduced 8% from August.',
    eventType: 'infrastructure', eventState: 'developing', severity: 2, confidence: 0.75,
    countries: ['PAN'], lat: 9.1, lng: -79.7, coordinateQuality: 'exact',
    marketRelevance: 0.35, escalationPotential: 0.2, uniqueSourceCount: 2,
    latestSeenAt: '2026-07-02T19:20:00.000Z',
    causedByRationales: [],
    expectedConsequences: ['Trans-Pacific rate firmness into peak season'],
    counterfactual: null,
    affectedChokepoints: ['panama'],
    affectedTickers: [],
    fedRegime: false, briefingRank: null,
    briefingQuote: null,
  },
]

const STORYLINES: StorylineVM[] = [
  {
    storylineId: 'sl-kyiv',
    title: 'Russia escalates strikes on Kyiv around the NATO summit',
    state: 'active', daysActive: 4, totalEvents: 16, totalSources: 30,
    avgEscalation: 0.631, maxSeverity: 5,
    nodes: [
      { date: '2026-07-03', title: 'Drone waves probe Kyiv air defense on three consecutive nights', linkToNext: 'interceptor depletion → larger strike window opens' },
      { date: '2026-07-05', title: 'Russia masses Tu-95 sorties; NATO summit agenda leaks (security guarantees)', linkToNext: 'summit timing → demonstration incentive' },
      { date: '2026-07-06', title: 'Mass strike: 68 missiles, 351 drones, 23 killed; Patriot shortage disclosed', linkToNext: null },
    ],
    tickers: [t('GOLD_OZ', true), t('PLTR', true), t('CRWD')],
    briefingCitation: 'Kyiv mass strike ahead of the NATO summit sustains both the gold risk premium and the defense-tech bid — hold GOLD_OZ, PLTR trim is sizing-only.',
  },
  {
    storylineId: 'sl-lebanon',
    title: 'US-brokered Lebanon ceasefire erodes under continued strikes',
    state: 'escalating', daysActive: 9, totalEvents: 7, totalSources: 11,
    avgEscalation: 0.7, maxSeverity: 4,
    nodes: [
      { date: '2026-06-28', title: 'First post-ceasefire Israeli strike on southern Lebanon vehicle', linkToNext: 'no enforcement response → strike tempo normalizes' },
      { date: '2026-07-02', title: 'Hezbollah statement: “restraint is not indefinite”', linkToNext: 'declared threshold → escalation window opens' },
      { date: '2026-07-06', title: 'Strikes kill four including a teacher; ceasefire formally still active', linkToNext: null },
    ],
    tickers: [t('GOLD_OZ', true), t('CRWD')],
    briefingCitation: 'Ceasefire collapse within 1–2 weeks per the causal model — bear watch-item on GOLD_OZ / CRWD.',
  },
  {
    storylineId: 'sl-energy',
    title: 'European energy security re-tightens (TTF, Red Sea, ECB)',
    state: 'stable', daysActive: 12, totalEvents: 9, totalSources: 8,
    avgEscalation: 0.4, maxSeverity: 3,
    nodes: [
      { date: '2026-06-25', title: 'TTF breaks above €38 despite ceasefire framework', linkToNext: 'price signal → central-bank attention' },
      { date: '2026-07-05', title: 'Houthi attacks resume near Bab-el-Mandeb after five-week pause', linkToNext: 'war-risk premium → LNG routing costs' },
      { date: '2026-07-06', title: 'Schnabel: energy conditions not restored; hold w/ tightening bias', linkToNext: null },
    ],
    tickers: [t('GULF.BK', true)],
    briefingCitation: 'WTI neutral-to-supportive; energy-infra theme (GULF.BK) holds its +$604 gain.',
  },
]
