// Loader contract for /today (Daily Briefing).
//
// TODAY: the briefing exists only as markdown (briefings/YYYY-MM-DD.md);
// actions/scenarios come from simulation.json, risk pulse from risk.json,
// wash-sale from harvest.json, world events from world-map/intelligence.json.
// The composition below stitches those envelopes; the structured-briefing gap
// (backend-gaps #1) would collapse this into one `briefing.json` read.
//
// Sample values are real, from the 2026-07-06 pipeline run.

import type { RecommendedAction, RegimeSummary, Scenario, WorldEvent } from '../_shared/types'

export interface BriefingViewModel {
  date: string
  generatedAt: string
  regime: RegimeSummary
  calibrationNote: string
  scenarios: Scenario[]
  actionGroups: Array<{ group: 'act' | 'hold' | 'dca' | 'locked'; title: string; actions: RecommendedAction[] }>
  washSale: Array<{ ticker: string; doNotRebuyBefore: string; daysRemaining: number }>
  pulse: { netWorthUsd: number; sharpe: number; oneDayVAR95: number; beta: number; maxDrawdown: number }
  worldTop: WorldEvent[]
  watchItems: Array<{ kind: 'bull' | 'bear' | 'neutral'; trigger: string; tickers: string[]; why: string }>
  narrativeMd: string // full briefing markdown, rendered at the bottom
}

export async function loadBriefing(): Promise<BriefingViewModel> {
  // Real impl: read briefing md + simulation.json + risk.json + harvest.json
  // + world-map/intelligence.json (see apps' data dirs), join on date.
  return SAMPLE
}

const SAMPLE: BriefingViewModel = {
  date: '2026-07-06',
  generatedAt: '2026-07-06T23:44:56.000Z',
  regime: {
    regime: 'AI Acceleration + Defense Tech Bid',
    confidence: 'medium',
    date: '2026-07-06',
    rationale:
      'Synchronized AI infrastructure and defense-tech spending: PLTR $101M DHS win, NDAA FY2027 and NatSec appropriations advancing, ARM record $737M royalty quarter. Liquidity net easing (M2 +5.58% YoY, RRP drained to $2B, VIX 15.85). Friction overlay non-trivial: Kyiv mass strike, ECB energy warning, consumer sentiment 44.8.',
    keyIndicators: ['M2 +5.58% YoY', 'RRP $2B', 'VIX 15.85', 'Consumer sentiment 44.8'],
  },
  calibrationNote:
    'HIGH-conviction calls running at 37% accuracy (18.5pp below medium) — all HIGH labels downgraded one level today. TRIM remains the strongest edge at 76.5% (7d).',
  scenarios: [
    { id: 's1', scenarioType: 'best', title: 'AI Capex Supercycle Breaks Escape Velocity', narrative: '', timeHorizon: '3-6mo', probability: 0.22, triggers: ['NDAA floor vote', '2+ PLTR contracts'] },
    { id: 's2', scenarioType: 'base', title: 'AI Grind Higher — Geopolitical Friction Persists', narrative: '', timeHorizon: '3-6mo', probability: 0.48, triggers: [] },
    { id: 's3', scenarioType: 'disruption', title: 'Geopolitical Shock Fractures AI Trade', narrative: '', timeHorizon: '1-4mo', probability: 0.3, triggers: ['Hormuz disruption', 'NDAA stall'] },
  ],
  actionGroups: [
    {
      group: 'act',
      title: 'Act now',
      actions: [
        { id: 'a1', ticker: 'AOT.BK', action: 'trim', conviction: 'medium', convictionDowngraded: true, allocationChangePct: -22, rationale: '37% of priced portfolio, −$1,597 USD underwater; consumer sentiment 44.8 suppresses tourism; Thai SET — no harvest benefit, purely a sizing call. Target ~28-30%.', harvestableUsd: null, washSaleNote: null },
        { id: 'a2', ticker: 'SCBCEH', action: 'trim', conviction: 'medium', allocationChangePct: -50, rationale: 'China/HK thesis has no named catalyst in any scenario; pause contributions, evaluate deep trim. Rotate toward KFINDIA-A / US broad / global REITs.', harvestableUsd: -286, washSaleNote: null },
        { id: 'a3', ticker: 'PLTR', action: 'trim', conviction: 'medium', convictionDowngraded: true, allocationChangePct: -17, rationale: 'Trump PLTR sale adds sentiment overhang on a thin cushion; NDAA still in Rules Committee, not on the floor.', harvestableUsd: -104, washSaleNote: null },
      ],
    },
    {
      group: 'hold',
      title: 'Hold — with missed-upside flags',
      actions: [
        { id: 'a4', ticker: 'NET', action: 'hold', conviction: 'medium', allocationChangePct: 0, rationale: 'Thesis strengthening (NDAA cyber, ARM cost tailwinds); 84.6% vol at 5.6% weight is manageable. NDAA floor vote = material repricing risk if trimmed.' },
        { id: 'a5', ticker: 'LLY', action: 'hold', conviction: 'medium', allocationChangePct: 0, rationale: 'GLP-1 demand non-cyclical; strong winner (+$590). HOLD is historically a coin flip at 30d — do not overtrade a winner.' },
        { id: 'a6', ticker: 'GULF.BK', action: 'hold', conviction: 'medium', allocationChangePct: 0, rationale: 'WTI neutral-to-supportive; Canadian pipeline tailwind for energy infra theme. Hold the +$604 gain.' },
        { id: 'a7', ticker: 'SCB.BK', action: 'hold', conviction: 'medium', allocationChangePct: 0, rationale: 'Thai banking stable; sentiment headwind priced in. +$549.' },
        { id: 'a8', ticker: 'GOLD_OZ', action: 'hold', conviction: 'medium', allocationChangePct: 0, rationale: 'Kyiv strike + Lebanon escalation + Schnabel warning sustain the risk premium. Revisit add if NDAA stalls.' },
      ],
    },
    {
      group: 'dca',
      title: 'DCA — continue as scheduled',
      actions: [
        { id: 'a9', ticker: 'K-VIETNAM', action: 'hold', conviction: 'medium', allocationChangePct: 0, rationale: 'Vietnam FDI story intact. Underwater is the strategy working.' },
        { id: 'a10', ticker: 'KFINDIA-A', action: 'hold', conviction: 'medium', allocationChangePct: 0, rationale: 'India structural thesis intact. −$222 harvestable if resetting basis; prioritize accumulation.', harvestableUsd: -222 },
      ],
    },
    {
      group: 'locked',
      title: 'Tax-locked — no action',
      actions: [
        { id: 'a11', ticker: 'K-ESGSI-THAIESG', action: 'hold', conviction: 'low', allocationChangePct: 0, rationale: 'Hold to maturity.' },
        { id: 'a12', ticker: 'K-TNZ-THAIESG', action: 'hold', conviction: 'low', allocationChangePct: 0, rationale: 'Hold to maturity.' },
        { id: 'a13', ticker: 'PFM009', action: 'hold', conviction: 'low', allocationChangePct: 0, rationale: 'Locked social security fund.' },
      ],
    },
  ],
  washSale: [
    { ticker: 'CRWD', doNotRebuyBefore: '2026-07-08', daysRemaining: 1 },
    { ticker: 'CRWD', doNotRebuyBefore: '2026-07-15', daysRemaining: 8 },
    { ticker: 'UNH', doNotRebuyBefore: '2026-07-15', daysRemaining: 8 },
  ],
  pulse: { netWorthUsd: 74574, sharpe: 3.35, oneDayVAR95: 474, beta: 0.28, maxDrawdown: -0.054 },
  worldTop: [
    { eventId: 'w1', title: 'Russia mass strike on Kyiv ahead of NATO summit', summary: '68 missiles, 351 drones, 23 killed; Patriot interceptor shortage disclosed.', severity: 5, countries: ['UKR', 'RUS'], marketRelevance: 0.4, escalationPotential: 0.8, latestSeenAt: '2026-07-06T17:22:09.000Z' },
    { eventId: 'w2', title: 'Israel strikes Lebanon despite US-brokered ceasefire', summary: 'Ceasefire credibility eroding; Hezbollah escalation risk 1–2 weeks.', severity: 4, countries: ['LBN', 'ISR'], marketRelevance: 0.25, escalationPotential: 0.75, latestSeenAt: '2026-07-06T17:22:09.000Z' },
    { eventId: 'w3', title: 'ECB Schnabel: Mideast peace has not restored energy conditions', summary: 'Hold with tightening bias likely at late-July meeting; TTF elevated.', severity: 3, countries: ['DEU'], marketRelevance: 0.6, escalationPotential: 0.3, latestSeenAt: '2026-07-06T15:00:00.000Z' },
  ],
  watchItems: [
    { kind: 'bull', trigger: 'NDAA FY2027 (H.R. 8800) advances to House floor vote', tickers: ['PLTR', 'CRWD', 'NET'], why: 'Single clearest bull catalyst — would justify reversing PLTR/CRWD trims.' },
    { kind: 'bull', trigger: 'PLTR wins 2nd federal AI contract >$100M', tickers: ['PLTR'], why: 'Validates DHS award as leading indicator (60d window).' },
    { kind: 'bear', trigger: 'Iran Strait of Hormuz disruption event', tickers: ['GOLD_OZ', 'GULF.BK'], why: 'Disruption-scenario trigger; WTI spike forces risk-off rotation.' },
    { kind: 'bear', trigger: 'Hezbollah escalates post-Lebanon strikes', tickers: ['GOLD_OZ', 'CRWD'], why: 'Ceasefire collapse within 1–2 weeks per causal model.' },
    { kind: 'neutral', trigger: 'ARM / NVDA / META Q2 earnings', tickers: ['NET', 'PLTR', 'CRWD'], why: 'ARM royalty trajectory is the demand signal for the whole AI trade.' },
  ],
  narrativeMd: '',
}
