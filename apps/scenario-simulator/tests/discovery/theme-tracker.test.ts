import { describe, it, expect } from 'vitest'
import {
  loadThemesMap,
  themesFor,
  paperBookThemeValue,
  realPortfolioThemeValueUSD,
  formatThemeContext,
  THEME_CONCENTRATION_CAP,
} from '../../src/discovery/theme-tracker.js'
import type { DiscoveryPosition } from '../../src/discovery/types.js'
import type { Position } from '../../src/types.js'

function paperPos(overrides: Partial<DiscoveryPosition> = {}): DiscoveryPosition {
  return {
    ticker: 'NVDA', company: 'NVIDIA', shares: 10, avgCost: 100,
    currentPrice: 100, currentValue: 1000, unrealizedPnl: 0, score: 80,
    source: 'companies_table', rationale: 'test', openedAt: '2026-07-01T00:00:00Z',
    updatedAt: '2026-07-01T00:00:00Z', benchmarkPriceAtOpen: null,
    ...overrides,
  }
}

function realPos(overrides: Partial<Position> = {}): Position {
  return {
    ticker: 'CRWD', company: 'CrowdStrike', shares: 5, avgCost: 200,
    currentPrice: 200, currentValue: 1000, unrealizedPnl: 0, updatedAt: '2026-07-01T00:00:00Z',
    assetClass: 'us_equity', currency: 'USD', priceSymbol: 'CRWD', strategy: 'tactical',
    ...overrides,
  }
}

describe('THEME_CONCENTRATION_CAP', () => {
  it('is 30%, matching correlation-runner.ts\'s concentration threshold', () => {
    expect(THEME_CONCENTRATION_CAP).toBe(0.30)
  })
})

describe('paperBookThemeValue', () => {
  it('sums cost basis (shares * avgCost) by theme', () => {
    const positions = [
      paperPos({ ticker: 'NVDA', shares: 10, avgCost: 100 }),
      paperPos({ ticker: 'AMD', shares: 5, avgCost: 200 }),
      paperPos({ ticker: 'UNH', shares: 2, avgCost: 300 }),
    ]
    const themesMap = { NVDA: ['ai-infrastructure'], AMD: ['ai-infrastructure'], UNH: ['healthcare'] }
    const result = paperBookThemeValue(positions, themesMap)
    expect(result.get('ai-infrastructure')).toBeCloseTo(1000 + 1000) // 10*100 + 5*200
    expect(result.get('healthcare')).toBeCloseTo(600)
  })

  it('ignores tickers not in the theme map', () => {
    const positions = [paperPos({ ticker: 'UNKNOWN_TICKER', shares: 10, avgCost: 100 })]
    const result = paperBookThemeValue(positions, {})
    expect(result.size).toBe(0)
  })

  it('returns an empty map for an empty book', () => {
    expect(paperBookThemeValue([], {}).size).toBe(0)
  })
})

describe('realPortfolioThemeValueUSD', () => {
  it('sums USD value by theme and computes total in USD', () => {
    const positions = [
      realPos({ ticker: 'CRWD', currentValue: 1000, currency: 'USD' }),
      realPos({ ticker: 'NET', currentValue: 500, currency: 'USD' }),
      realPos({ ticker: 'AOT.BK', currentValue: 33000, currency: 'THB' }),
    ]
    const themesMap = { CRWD: ['cybersecurity'], NET: ['cybersecurity'] }
    const { byTheme, totalUsd } = realPortfolioThemeValueUSD(positions, themesMap, 33)
    expect(byTheme.get('cybersecurity')).toBeCloseTo(1500)
    // AOT.BK has no theme mapping, so it contributes to totalUsd but not byTheme
    expect(totalUsd).toBeCloseTo(1000 + 500 + 1000) // 33000/33 = 1000
    expect(byTheme.has('th_equity')).toBe(false)
  })

  it('falls back to raw currentValue when usdThb is null (no double-counting bug)', () => {
    const positions = [realPos({ ticker: 'AOT.BK', currentValue: 33000, currency: 'THB' })]
    const { totalUsd } = realPortfolioThemeValueUSD(positions, {}, null)
    expect(totalUsd).toBe(33000) // not converted, but at least doesn't crash
  })

  it('returns zero total for an empty portfolio', () => {
    const { totalUsd, byTheme } = realPortfolioThemeValueUSD([], {}, 33)
    expect(totalUsd).toBe(0)
    expect(byTheme.size).toBe(0)
  })
})

describe('formatThemeContext', () => {
  it('flags a theme at or above the cap in the paper book', () => {
    const paperBook = new Map([['ai-infrastructure', 3000]])
    const ctx = formatThemeContext(paperBook, 10000, { byTheme: new Map(), totalUsd: 0 })
    expect(ctx).toContain('ai-infrastructure: 30.0%')
    expect(ctx).toContain('AT CAP')
  })

  it('flags a concentrated real-portfolio theme', () => {
    const real = { byTheme: new Map([['cybersecurity', 4000]]), totalUsd: 10000 }
    const ctx = formatThemeContext(new Map(), 10000, real)
    expect(ctx).toContain('cybersecurity: 40.0%')
    expect(ctx).toContain('concentrated')
  })

  it('handles an empty paper book and unavailable real portfolio gracefully', () => {
    const ctx = formatThemeContext(new Map(), 10000, { byTheme: new Map(), totalUsd: 0 })
    expect(ctx).toContain('no open positions yet')
    expect(ctx).toContain('unavailable')
  })
})

// ── Multi-theme membership and coverage availability ───────────────────────
//
// The artifact used to map each ticker to ONE theme. IBM is in both
// cloud-hyperscalers and quantum-computing, so the old projection dropped a
// membership and a candidate could clear a cap on a theme it was really in.
// A missing or malformed artifact used to read as `{}`, which is
// indistinguishable from "nothing has a theme" — silently disabling the cap.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const withTmp = (fn: (dir: string) => void) => {
  const dir = mkdtempSync(join(tmpdir(), 'themes-map-'))
  try { fn(dir) } finally { rmSync(dir, { recursive: true, force: true }) }
}

describe('loadThemesMap coverage states', () => {
  it('reports a missing artifact as unavailable, not as empty coverage', () => {
    const r = loadThemesMap('/nonexistent/themes-map.json')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('missing')
  })

  it('reports unparseable JSON as malformed', () => {
    withTmp(dir => {
      const p = join(dir, 'themes-map.json')
      writeFileSync(p, '{ this is not json')
      const r = loadThemesMap(p)
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.reason).toBe('malformed')
    })
  })

  it('rejects the OLD lossy ticker->string schema as malformed', () => {
    withTmp(dir => {
      const p = join(dir, 'themes-map.json')
      writeFileSync(p, JSON.stringify({ IBM: 'quantum-computing' }))
      const r = loadThemesMap(p)
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.reason).toBe('malformed')
    })
  })

  it('rejects a structurally valid but zero-ticker artifact', () => {
    withTmp(dir => {
      const p = join(dir, 'themes-map.json')
      writeFileSync(p, '{}')
      const r = loadThemesMap(p)
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.reason).toBe('empty')
    })
  })

  it('accepts a well-formed plural artifact', () => {
    withTmp(dir => {
      const p = join(dir, 'themes-map.json')
      writeFileSync(p, JSON.stringify({ IBM: ['cloud-hyperscalers', 'quantum-computing'], NVDA: ['ai-infrastructure'] }))
      const r = loadThemesMap(p)
      expect(r.ok).toBe(true)
      if (r.ok) {
        expect(r.map['IBM']).toEqual(['cloud-hyperscalers', 'quantum-computing'])
        expect(r.map['NVDA']).toEqual(['ai-infrastructure'])
      }
    })
  })

  it('reads the REAL committed artifact and keeps both of IBM\'s themes', () => {
    const real = join(process.cwd(), '../capital-intelligence-ingestion/src/discovery/themes-map.json')
    const r = loadThemesMap(real)
    expect(r.ok, 'the tracked artifact must be readable from a fresh checkout').toBe(true)
    if (r.ok) {
      expect(r.map['IBM']).toEqual(['cloud-hyperscalers', 'quantum-computing'])
      expect(r.map['NVDA']).toEqual(['ai-infrastructure'])
    }
  })
})

describe('themesFor', () => {
  it('returns every membership for a multi-theme ticker', () => {
    expect(themesFor({ IBM: ['cloud-hyperscalers', 'quantum-computing'] }, 'IBM'))
      .toEqual(['cloud-hyperscalers', 'quantum-computing'])
  })

  it('returns a single membership unchanged', () => {
    expect(themesFor({ NVDA: ['ai-infrastructure'] }, 'NVDA')).toEqual(['ai-infrastructure'])
  })

  it('returns [] for a ticker in no theme — a real answer, not missing data', () => {
    expect(themesFor({ NVDA: ['ai-infrastructure'] }, 'TSLA')).toEqual([])
  })
})

describe('multi-theme value attribution', () => {
  it('counts a multi-theme position in full under each of its themes', () => {
    const result = paperBookThemeValue(
      [paperPos({ ticker: 'IBM', shares: 10, avgCost: 100 })],
      { IBM: ['cloud-hyperscalers', 'quantum-computing'] },
    )
    expect(result.get('cloud-hyperscalers')).toBeCloseTo(1000)
    expect(result.get('quantum-computing')).toBeCloseTo(1000)
  })

  it('leaves single-theme attribution exactly as before', () => {
    const single = paperBookThemeValue(
      [paperPos({ ticker: 'NVDA', shares: 10, avgCost: 100 })],
      { NVDA: ['ai-infrastructure'] },
    )
    expect([...single]).toEqual([['ai-infrastructure', 1000]])
  })

  it('does the same for the real portfolio', () => {
    const { byTheme, totalUsd } = realPortfolioThemeValueUSD(
      [realPos({ ticker: 'IBM', currentValue: 1000, currency: 'USD' })],
      { IBM: ['cloud-hyperscalers', 'quantum-computing'] }, null,
    )
    expect(byTheme.get('cloud-hyperscalers')).toBeCloseTo(1000)
    expect(byTheme.get('quantum-computing')).toBeCloseTo(1000)
    // Counted once toward the total, twice across themes: theme weights may sum
    // past 100%, which is correct for "how exposed is the book to this theme".
    expect(totalUsd).toBeCloseTo(1000)
  })
})

// The cap decision itself, as cli-discover applies it: a candidate must clear
// EVERY theme it is in. Mirrors the loop so the rule is pinned independently.
describe('cap decision across multiple memberships', () => {
  const capBreached = (themes: string[], deployed: Map<string, number>, alloc: number, max: number) =>
    themes.some(t => max > 0 && ((deployed.get(t) ?? 0) + alloc) / max > THEME_CONCENTRATION_CAP)

  it('blocks when ONE of several themes is over the cap', () => {
    const deployed = new Map([['cloud-hyperscalers', 2900], ['quantum-computing', 0]])
    // Safe on quantum-computing, over on cloud-hyperscalers -> must be blocked.
    expect(capBreached(['cloud-hyperscalers', 'quantum-computing'], deployed, 200, 10000)).toBe(true)
  })

  it('would have ALLOWED it under the old single-theme projection', () => {
    const deployed = new Map([['cloud-hyperscalers', 2900], ['quantum-computing', 0]])
    // The old artifact recorded only quantum-computing for IBM — the bug.
    expect(capBreached(['quantum-computing'], deployed, 200, 10000)).toBe(false)
  })

  it('allows when every theme is under the cap', () => {
    const deployed = new Map([['cloud-hyperscalers', 100], ['quantum-computing', 100]])
    expect(capBreached(['cloud-hyperscalers', 'quantum-computing'], deployed, 200, 10000)).toBe(false)
  })

  it('cannot be bypassed by unavailable coverage — no map means no deployment', () => {
    const r = loadThemesMap('/nonexistent/themes-map.json')
    expect(r.ok).toBe(false)
    // cli-discover returns before the candidate loop when coverage is not ok,
    // so there is no themesMap to consult and no capital is deployed.
  })
})
