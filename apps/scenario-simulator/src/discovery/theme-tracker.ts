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

/**
 * A ticker's COMPLETE theme membership. Plural because the artifact used to map
 * each ticker to one theme and silently dropped the rest — IBM is in both
 * cloud-hyperscalers and quantum-computing, and a discarded membership let a
 * candidate slip past the cap on a theme it was really in.
 */
export type ThemesMap = Record<string, string[]>

/**
 * Whether theme coverage is usable, as a value the caller cannot ignore.
 *
 * The previous loader returned `{}` for a missing OR unparseable file, which is
 * indistinguishable from "no ticker has a theme". Every downstream guard is
 * written as `if (theme)`, so an unreadable artifact silently disabled the
 * concentration cap while discovery went on deploying capital. Absence of
 * coverage must never be readable as absence of concentration.
 */
export type ThemeCoverage =
  | { ok: true; map: ThemesMap }
  | { ok: false; reason: 'missing' | 'malformed' | 'empty'; detail: string }

/**
 * Read theme coverage. Never throws, never guesses.
 *
 * `empty` is treated as unavailable rather than as a legal state: THEMES is
 * non-empty by construction, so a zero-entry artifact means the projection
 * failed, and accepting it would reproduce exactly the silent-`{}` bug this
 * type exists to prevent.
 */
export function loadThemesMap(path: string): ThemeCoverage {
  if (!existsSync(path)) return { ok: false, reason: 'missing', detail: `no artifact at ${path}` }

  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, 'utf-8'))
  } catch (err) {
    return { ok: false, reason: 'malformed', detail: `${path} is not valid JSON: ${(err as Error).message}` }
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, reason: 'malformed', detail: `${path} is not a ticker->themes object` }
  }

  const map: ThemesMap = {}
  for (const [ticker, themes] of Object.entries(parsed as Record<string, unknown>)) {
    if (!Array.isArray(themes) || themes.length === 0 || themes.some(t => typeof t !== 'string' || t === '')) {
      // Catches the OLD ticker->string schema too, which must not be read as
      // valid: it is the lossy shape this repair replaced.
      return { ok: false, reason: 'malformed', detail: `${path}: "${ticker}" is not a non-empty array of theme ids` }
    }
    map[ticker] = themes as string[]
  }

  if (Object.keys(map).length === 0) {
    return { ok: false, reason: 'empty', detail: `${path} contains no tickers` }
  }
  return { ok: true, map }
}

/** Every theme a ticker belongs to. Empty means "in no configured theme" — a real answer, not missing data. */
export function themesFor(themesMap: ThemesMap, ticker: string): string[] {
  return themesMap[ticker] ?? []
}

/**
 * Per-theme deployed value (cost basis, shares × avg_cost) across open discovery
 * positions.
 *
 * A position in N themes contributes its FULL value to each of them — no
 * fractional split, which no existing domain logic supports. The question each
 * theme's number answers is "how exposed is the book to this theme", and a
 * position is fully exposed to every theme it is in. Consequence: the values
 * may sum to more than the book. That is correct for a cap check and
 * deliberately errs toward restricting, never toward permitting.
 */
export function paperBookThemeValue(
  positions: DiscoveryPosition[],
  themesMap: ThemesMap,
): Map<string, number> {
  const byTheme = new Map<string, number>()
  for (const p of positions) {
    for (const theme of themesFor(themesMap, p.ticker)) {
      byTheme.set(theme, (byTheme.get(theme) ?? 0) + p.shares * p.avgCost)
    }
  }
  return byTheme
}

/** Per-theme USD value across the real portfolio, plus the portfolio's total USD value. */
export function realPortfolioThemeValueUSD(
  positions: RealPosition[],
  themesMap: ThemesMap,
  usdThb: number | null,
): { byTheme: Map<string, number>; totalUsd: number } {
  const byTheme = new Map<string, number>()
  let totalUsd = 0
  for (const p of positions) {
    const valueUsd = p.currency === 'THB' && usdThb ? p.currentValue / usdThb : p.currentValue
    totalUsd += valueUsd
    // Counted in full under every theme, for the same reason as the paper book.
    for (const theme of themesFor(themesMap, p.ticker)) {
      byTheme.set(theme, (byTheme.get(theme) ?? 0) + valueUsd)
    }
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
