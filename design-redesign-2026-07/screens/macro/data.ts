// Loader contract for /markets — Macro & Prices.
// (Supersedes screens/specs/macro-markets.md.)
//
// Sources:
//   - macro-asset-monitor/data/macro.json (marketAssets + economicIndicators
//     + liquidityIndicators — daily snapshot, real 2026-07-06 values below)
//   - ai-analysis-engine analysis.json.latestRegime (regime strip)
//   - briefing watch thresholds (VIX>20, 10Y>4.7, sentiment<45, WTI>100) —
//     GAP #19: these live in the briefing prompt; move to a shared
//     watch-thresholds.json the UI and prompt both read.
//
// GAP #18 (part of #4 time-series store): macro.json holds latest snapshots
// only. The 90d series below are ILLUSTRATIVE shapes so the sparkline/detail
// design is reviewable — the real app must read GET /api/macro/:id?range=90d.
// GAP #20: SET index / THB pairs aren't ingested (^SET.BK works on Yahoo).

export type IndicatorGroup = 'liquidity' | 'markets' | 'energy'

export interface Threshold {
  kind: 'above' | 'below'
  level: number
  label: string // e.g. "briefing tripwire: VIX > 20"
}

export interface IndicatorVM {
  id: string
  label: string
  group: IndicatorGroup
  display: string // formatted current value
  value: number
  delta30d: number | null // fraction vs 30d ago
  trend: 'rising' | 'falling' | 'stable'
  /** GAP #18 — illustrative until the history endpoint exists. */
  series90d: number[] | null
  threshold?: Threshold
  crossed?: boolean
  footnote?: string
  /** Tile renders as an explicit data gap (e.g. SET index, gap #20). */
  gap?: string
}

export interface MacroViewModel {
  exportedAt: string
  asOf: string
  regime: {
    regime: string
    confidence: 'high' | 'medium' | 'low'
    /** chips deep-link to indicator tiles by id */
    keyIndicators: Array<{ label: string; indicatorId: string | null }>
  }
  indicators: IndicatorVM[]
}

export async function loadMacro(): Promise<MacroViewModel> {
  return {
    exportedAt: '2026-07-06T17:05:44.384Z',
    asOf: '2026-07-06',
    regime: {
      regime: 'AI Acceleration + Defense Tech Bid',
      confidence: 'medium',
      keyIndicators: [
        { label: 'M2 +5.58% YoY', indicatorId: 'm2' },
        { label: 'RRP $2B', indicatorId: 'rrp' },
        { label: 'VIX 15.85', indicatorId: 'vix' },
        { label: 'Consumer sentiment 44.8', indicatorId: 'sentiment' },
      ],
    },
    indicators: INDICATORS,
  }
}

const s = (...v: number[]) => v // illustrative 90d shape, ~13 weekly points

const INDICATORS: IndicatorVM[] = [
  /* ── Liquidity & rates ─────────────────────────────────────────────────── */
  {
    id: 'm2', label: 'M2 YoY', group: 'liquidity', display: '+5.58%', value: 5.58,
    delta30d: 0.021, trend: 'rising',
    series90d: s(4.9, 5.0, 5.05, 5.1, 5.2, 5.18, 5.25, 5.3, 5.38, 5.42, 5.47, 5.52, 5.58),
    footnote: 'net easing — the regime call’s liquidity leg',
  },
  {
    id: 'rrp', label: 'Reverse repo (RRP)', group: 'liquidity', display: '$2B', value: 2,
    delta30d: -0.87, trend: 'falling',
    series90d: s(96, 74, 61, 48, 39, 30, 24, 18, 14, 9, 6, 4, 2),
    footnote: 'drained — no buffer left; next stress hits reserves directly',
  },
  {
    id: 'fedbs', label: 'Fed balance sheet', group: 'liquidity', display: '$6,724.6B', value: 6724.564,
    delta30d: 0.0019, trend: 'stable',
    series90d: s(6702, 6705, 6709, 6707, 6711, 6714, 6712, 6716, 6719, 6718, 6721, 6723, 6724.6),
    footnote: '+0.19% 4w · +0.98% YoY (WALCL)',
  },
  {
    id: 'us10y', label: 'US 10Y yield', group: 'liquidity', display: '4.481%', value: 4.481,
    delta30d: -0.0199, trend: 'rising',
    series90d: s(4.62, 4.58, 4.55, 4.6, 4.52, 4.49, 4.45, 4.4, 4.37, 4.42, 4.46, 4.49, 4.481),
    threshold: { kind: 'above', level: 4.7, label: 'briefing tripwire: 10Y > 4.7%' },
    crossed: false,
  },
  {
    id: 'us5y', label: 'US 5Y yield', group: 'liquidity', display: '4.216%', value: 4.216,
    delta30d: -0.0021, trend: 'rising',
    series90d: s(4.31, 4.28, 4.3, 4.27, 4.22, 4.19, 4.16, 4.13, 4.15, 4.18, 4.2, 4.21, 4.216),
  },
  {
    id: 'vix', label: 'VIX', group: 'liquidity', display: '15.85', value: 15.85,
    delta30d: -0.08, trend: 'stable',
    series90d: s(19.2, 18.1, 17.4, 18.8, 17.0, 16.2, 15.4, 16.8, 16.1, 15.6, 15.2, 15.5, 15.85),
    threshold: { kind: 'above', level: 20, label: 'briefing tripwire: VIX > 20' },
    crossed: false,
  },
  {
    id: 'sentiment', label: 'Consumer sentiment', group: 'liquidity', display: '44.8', value: 44.8,
    delta30d: -0.049, trend: 'falling',
    series90d: s(52.1, 51.4, 50.2, 49.8, 48.9, 48.2, 47.5, 47.1, 46.3, 45.9, 45.2, 45.0, 44.8),
    threshold: { kind: 'below', level: 45, label: 'briefing tripwire: sentiment < 45' },
    crossed: true,
    footnote: 'suppresses tourism — the AOT.BK trim driver',
  },
  {
    id: 'cpi', label: 'CPI YoY', group: 'liquidity', display: '+4.27%', value: 4.27,
    delta30d: 0.0047, trend: 'stable',
    series90d: s(4.6, 4.55, 4.5, 4.48, 4.42, 4.4, 4.38, 4.35, 4.33, 4.3, 4.29, 4.28, 4.27),
    footnote: 'CPIAUCSL, released 2026-05-01',
  },

  /* ── Benchmarks & FX ───────────────────────────────────────────────────── */
  {
    id: 'spy', label: 'S&P 500 (SPY)', group: 'markets', display: '$751.12', value: 751.12,
    delta30d: 0.0133, trend: 'rising',
    series90d: s(712, 718, 706, 722, 729, 725, 733, 738, 742, 741, 746, 744.8, 751.1),
    footnote: '+0.85% 1d · +3.04% 5d',
  },
  {
    id: 'qqq', label: 'Nasdaq 100 (QQQ)', group: 'markets', display: '$724.10', value: 724.1,
    delta30d: 0.0154, trend: 'rising',
    series90d: s(688, 695, 682, 699, 706, 702, 711, 716, 713, 719, 715, 712.6, 724.1),
    footnote: '+1.61% 1d',
  },
  {
    id: 'iwm', label: 'Russell 2000 (IWM)', group: 'markets', display: '$300.09', value: 300.09,
    delta30d: 0.0722, trend: 'stable',
    series90d: s(278, 281, 276, 284, 288, 286, 291, 294, 292, 296, 299, 297.6, 300.1),
    footnote: '+7.22% 30d — breadth broadening',
  },
  {
    id: 'dxy', label: 'Dollar index (DXY)', group: 'markets', display: '96.42', value: 96.42,
    delta30d: -0.011, trend: 'falling',
    series90d: s(98.4, 98.1, 97.9, 98.2, 97.6, 97.3, 97.5, 97.1, 96.8, 96.9, 96.6, 96.5, 96.42),
  },
  {
    id: 'usdthb', label: 'USD/THB', group: 'markets', display: '33.29', value: 33.29,
    delta30d: -0.004, trend: 'stable',
    series90d: s(33.6, 33.5, 33.55, 33.4, 33.45, 33.3, 33.35, 33.25, 33.3, 33.28, 33.32, 33.3, 33.29),
    footnote: 'the conversion basis for every THB position — never hidden (FX-bug rule)',
  },
  {
    id: 'set', label: 'SET index', group: 'markets', display: '—', value: 0,
    delta30d: null, trend: 'stable', series90d: null,
    gap: 'not ingested — gap #20 (^SET.BK works on Yahoo); Thai book has no benchmark on this screen until it lands',
  },

  /* ── Energy & commodities ──────────────────────────────────────────────── */
  {
    id: 'gold', label: 'Gold (GC=F)', group: 'energy', display: '$4,293', value: 4293,
    delta30d: -0.032, trend: 'falling',
    series90d: s(4480, 4530, 4610, 4765, 4700, 4640, 4592, 4520, 4460, 4410, 4370, 4310, 4293),
    footnote: 'held via GOLD_OZ — wave layer flags technical exhaustion (see /markets/waves)',
  },
  {
    id: 'wti', label: 'WTI crude', group: 'energy', display: '$78.40', value: 78.4,
    delta30d: 0.041, trend: 'rising',
    series90d: s(71.2, 72.8, 70.9, 73.4, 74.1, 75.6, 74.8, 76.2, 77.0, 76.5, 77.8, 78.1, 78.4),
    threshold: { kind: 'above', level: 100, label: 'briefing tripwire: WTI > $100 (Hormuz scenario)' },
    crossed: false,
    footnote: 'neutral-to-supportive for GULF.BK energy-infra thesis',
  },
  {
    id: 'ttf', label: 'EU natgas (TTF)', group: 'energy', display: '€41.20', value: 41.2,
    delta30d: 0.118, trend: 'rising',
    series90d: s(33.1, 33.8, 34.5, 35.2, 34.9, 36.1, 36.8, 37.5, 38.4, 39.2, 40.1, 40.8, 41.2),
    footnote: 'elevated — the Schnabel warning (ECB hold w/ tightening bias)',
  },
]
