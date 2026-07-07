// Theme-weight tracking for discovery's concentration guardrails (see
// docs/discovery-agent-enhancement-proposal-2026-07-06.md, P1). The old
// scorer prompt named "AI infrastructure, semiconductors, and emerging tech"
// as favored themes directly, and the 2026-06 cohort put 15 of 16 positions
// in that one theme — this module gives the loop in cli-discover.ts a real
// number to cap against instead of leaving diversification to prompt wording.
import { existsSync, readFileSync } from 'fs'
import type { DiscoveryPosition } from './types.js'
import type { Position as RealPosition } from '../types.js'

export const THEME_CONCENTRATION_CAP = 0.30 // mirrors correlation-runner.ts's CONCENTRATION_WARN_PCT

export function loadThemesMap(path: string): Record<string, string> {
  if (!existsSync(path)) return {}
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as Record<string, string>
  } catch {
    return {}
  }
}

/** Per-theme deployed value (cost basis, shares × avg_cost) across open discovery positions. */
export function paperBookThemeValue(
  positions: DiscoveryPosition[],
  themesMap: Record<string, string>,
): Map<string, number> {
  const byTheme = new Map<string, number>()
  for (const p of positions) {
    const theme = themesMap[p.ticker]
    if (!theme) continue
    byTheme.set(theme, (byTheme.get(theme) ?? 0) + p.shares * p.avgCost)
  }
  return byTheme
}

/** Per-theme USD value across the real portfolio, plus the portfolio's total USD value. */
export function realPortfolioThemeValueUSD(
  positions: RealPosition[],
  themesMap: Record<string, string>,
  usdThb: number | null,
): { byTheme: Map<string, number>; totalUsd: number } {
  const byTheme = new Map<string, number>()
  let totalUsd = 0
  for (const p of positions) {
    const valueUsd = p.currency === 'THB' && usdThb ? p.currentValue / usdThb : p.currentValue
    totalUsd += valueUsd
    const theme = themesMap[p.ticker]
    if (!theme) continue
    byTheme.set(theme, (byTheme.get(theme) ?? 0) + valueUsd)
  }
  return { byTheme, totalUsd }
}

export function formatThemeContext(
  paperBook: Map<string, number>,
  paperMaxDeployable: number,
  realPortfolio: { byTheme: Map<string, number>; totalUsd: number },
): string {
  const lines = ['Theme-weight context (for diversification scoring):']

  if (paperBook.size === 0) {
    lines.push('- Paper book: no open positions yet.')
  } else {
    lines.push('- Paper book theme weights (of max deployable budget):')
    for (const [theme, value] of [...paperBook.entries()].sort((a, b) => b[1] - a[1])) {
      const pct = paperMaxDeployable > 0 ? (value / paperMaxDeployable) * 100 : 0
      lines.push(`    ${theme}: ${pct.toFixed(1)}%${pct >= THEME_CONCENTRATION_CAP * 100 ? ' (AT CAP — no new picks in this theme)' : ''}`)
    }
  }

  if (realPortfolio.totalUsd <= 0) {
    lines.push('- Real portfolio: unavailable.')
  } else {
    lines.push('- Real portfolio theme weights (the human\'s actual money — a new pick here is stacking, not diversifying):')
    for (const [theme, value] of [...realPortfolio.byTheme.entries()].sort((a, b) => b[1] - a[1])) {
      const pct = (value / realPortfolio.totalUsd) * 100
      lines.push(`    ${theme}: ${pct.toFixed(1)}% of real net worth${pct >= THEME_CONCENTRATION_CAP * 100 ? ' (concentrated — new picks here will be sized down)' : ''}`)
    }
  }

  return lines.join('\n')
}
