// Loader for /markets — Macro & Prices.
// Sources: macro-asset-monitor/data/macro.json (marketAssets +
// economicIndicators + liquidityIndicators) + ai-analysis-engine's
// analysis.json latestRegime, both via src/lib/data.ts direct disk reads.
//
// GAP #18 (time-series store): macro.json holds latest snapshots only —
// series90d is null everywhere until GET /api/macro/:id?range=90d exists.
// GAP #19: briefing watch-thresholds are hardcoded below (not yet a shared
// watch-thresholds.json the UI and the briefing prompt both read).
// GAP #20: SET index / USD-THB pair aren't ingested by macro-asset-monitor
// (^SET.BK and THB=X both resolve on Yahoo, just not wired up yet).

import { readMacro, readAnalysis } from '@/lib/data'
import type { MarketAsset, EconomicIndicator, LiquidityIndicator } from '@/types'

export type IndicatorGroup = 'liquidity' | 'economy' | 'markets' | 'energy'

export interface Threshold {
  kind: 'above' | 'below'
  level: number
  label: string
}

export interface IndicatorVM {
  id: string
  label: string
  group: IndicatorGroup
  display: string
  deltaPct: number | null
  deltaLabel: string | null
  /** GAP #18 — no history endpoint yet. */
  series90d: number[] | null
  threshold?: Threshold
  crossed?: boolean
  footnote?: string
  /** Tile renders as an explicit data gap (GAP #20). */
  gap?: string
}

export interface MacroViewModel {
  exportedAt: string
  asOf: string
  regime: {
    regime: string
    confidence: 'high' | 'medium' | 'low'
    rationale: string
  }
  indicators: IndicatorVM[]
}

// GAP #19 — hardcoded until a shared watch-thresholds.json exists that both
// this UI and the briefing prompt read from.
const WATCH_THRESHOLDS: Record<string, Threshold> = {
  vix: { kind: 'above', level: 20, label: 'briefing tripwire: VIX > 20' },
  us10y: { kind: 'above', level: 4.7, label: 'briefing tripwire: 10Y > 4.7%' },
  sentiment: { kind: 'below', level: 45, label: 'briefing tripwire: sentiment < 45' },
  wti: { kind: 'above', level: 100, label: 'briefing tripwire: WTI > $100 (Hormuz scenario)' },
}

function checkThreshold(id: string, value: number): { threshold?: Threshold; crossed?: boolean } {
  const t = WATCH_THRESHOLDS[id]
  if (!t) return {}
  const crossed = t.kind === 'above' ? value > t.level : value < t.level
  return { threshold: t, crossed }
}

const fmtMoney = (v: number, digits = 1) =>
  '$' + v.toLocaleString('en-US', { maximumFractionDigits: digits, minimumFractionDigits: digits })

const fmtNum = (v: number, digits = 2) =>
  v.toLocaleString('en-US', { maximumFractionDigits: digits })

const fmtPct = (v: number, digits = 2) => (v > 0 ? '+' : '') + v.toFixed(digits) + '%'

function marketAssetTile(a: MarketAsset): IndicatorVM {
  const isRate = a.category === 'rates'
  const display = isRate ? `${a.close.toFixed(3)}%` : a.category === 'dollar' || a.category === 'global-equity'
    ? fmtNum(a.close, 2)
    : fmtMoney(a.close, a.close < 10 ? 3 : 2)
  const id = a.ticker === '^VIX' ? 'vix' : a.ticker === '^TNX' ? 'us10y' : a.ticker === 'CL=F' ? 'wti' : a.ticker.toLowerCase().replace(/[^a-z0-9]/g, '')
  return {
    id,
    label: a.label,
    group: a.category === 'commodities' ? 'energy' : 'markets',
    display,
    deltaPct: a.changePct30d,
    deltaLabel: '30d',
    series90d: null,
    footnote: `${fmtPct(a.changePct1d)} 1d`,
    ...checkThreshold(id, a.close),
  }
}

function economicTile(e: EconomicIndicator): IndicatorVM {
  const id = e.seriesId.toLowerCase()
  // CPI's raw index level isn't meaningful on its own — the YoY rate is what
  // the regime call and briefing tripwires actually reference.
  if (e.seriesId === 'CPIAUCSL') {
    return {
      id, label: 'CPI YoY', group: 'economy',
      display: e.changeYoY != null ? fmtPct(e.changeYoY) : '—',
      deltaPct: null, deltaLabel: null, series90d: null,
      footnote: `released ${e.releaseDate}`,
    }
  }
  const display =
    e.unit === 'Percent' ? `${e.value.toFixed(1)}%` :
    e.unit === 'Index' ? e.value.toFixed(1) :
    fmtNum(e.value, 0) + ' ' + e.unit
  return {
    id, label: e.label, group: 'economy', display,
    deltaPct: e.changeYoY, deltaLabel: e.changeYoY != null ? 'YoY' : null,
    series90d: null,
    footnote: `released ${e.releaseDate}`,
    ...(id === 'umcsent' ? checkThreshold('sentiment', e.value) : {}),
  }
}

function liquidityTile(l: LiquidityIndicator): IndicatorVM {
  const id = l.seriesId.toLowerCase()
  // M2's headline number the regime call actually cites is YoY growth, not
  // the $23T raw level.
  if (l.seriesId === 'M2SL') {
    return {
      id, label: 'M2 YoY', group: 'liquidity',
      display: l.changeYoY != null ? fmtPct(l.changeYoY) : '—',
      deltaPct: null, deltaLabel: null, series90d: null,
      footnote: 'net easing — the regime call’s liquidity leg',
    }
  }
  return {
    id, label: l.label, group: 'liquidity',
    display: fmtMoney(l.value, 1) + 'B',
    deltaPct: l.change4w, deltaLabel: l.change4w != null ? '4w' : null,
    series90d: null,
    footnote: `signal: ${l.signal}`,
  }
}

export function loadMacro(): MacroViewModel {
  const m = readMacro()
  const analysis = (() => { try { return readAnalysis() } catch { return null } })()

  const liquidity = m.liquidityIndicators.map(liquidityTile)
  const economy = m.economicIndicators.map(economicTile)
  const marketTiles = m.marketAssets.map(marketAssetTile)

  // Rates/volatility marketAssets conceptually belong in "liquidity" even
  // though macro.json tags them by their own category.
  const RATES_AND_VOL = new Set(['rates', 'volatility'])
  const reclassified = marketTiles.map((t, i) =>
    RATES_AND_VOL.has(m.marketAssets[i].category) ? { ...t, group: 'liquidity' as const } : t,
  )

  const setThbGap: IndicatorVM = {
    id: 'set-thb', label: 'SET index / USD-THB', group: 'markets',
    display: '—', deltaPct: null, deltaLabel: null, series90d: null,
    gap: 'not ingested by macro-asset-monitor (gap #20) — ^SET.BK and THB=X both resolve on Yahoo, just not wired up',
  }

  return {
    exportedAt: m.exportedAt,
    asOf: m.asOf,
    regime: analysis
      ? {
          regime: analysis.latestRegime.regime,
          confidence: (analysis.latestRegime.confidence as 'high' | 'medium' | 'low') ?? 'medium',
          rationale: analysis.latestRegime.rationale ?? '',
        }
      : { regime: 'unavailable', confidence: 'low', rationale: 'analysis.json not found' },
    indicators: [...liquidity, ...economy, ...reclassified, setThbGap],
  }
}
