// tests/thesis/rollup.test.ts
import { describe, it, expect } from 'vitest'
import { computeThemeConviction, convictionLabel } from '../../src/thesis/rollup.js'
import type { Assumption, ThemeMembership } from '../../src/types.js'

const makeAssumptions = (statuses: string[]): Assumption[] =>
  statuses.map((status, i) => ({
    id: `a${i}`, thesisId: 't1', label: `Assumption ${i}`,
    status: status as Assumption['status'], lastEvidenceSummary: null,
    createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
  }))

describe('computeThemeConviction', () => {
  it('returns high score when all assumptions are strengthening', () => {
    const members: ThemeMembership[] = [{ themeId: 'theme-1', ticker: 'NVDA', weight: 1.0 }]
    const assumptionsByTicker: Record<string, Assumption[]> = {
      NVDA: makeAssumptions(['strengthening', 'strengthening', 'strengthening']),
    }
    const score = computeThemeConviction(members, assumptionsByTicker)
    expect(score).toBeCloseTo(1.0, 1)
  })

  it('returns low score when assumptions are weakening', () => {
    const members: ThemeMembership[] = [{ themeId: 'theme-1', ticker: 'NVDA', weight: 1.0 }]
    const assumptionsByTicker: Record<string, Assumption[]> = {
      NVDA: makeAssumptions(['weakening', 'weakening', 'broken']),
    }
    const score = computeThemeConviction(members, assumptionsByTicker)
    expect(score).toBeLessThan(0.3)
  })

  it('weights company scores by membership weight', () => {
    const members: ThemeMembership[] = [
      { themeId: 'theme-1', ticker: 'NVDA', weight: 0.8 },
      { themeId: 'theme-1', ticker: 'AMD', weight: 0.2 },
    ]
    const assumptionsByTicker: Record<string, Assumption[]> = {
      NVDA: makeAssumptions(['strengthening', 'strengthening']),
      AMD: makeAssumptions(['broken', 'broken']),
    }
    const score = computeThemeConviction(members, assumptionsByTicker)
    expect(score).toBeGreaterThan(0.5)
  })
})

describe('convictionLabel', () => {
  it('maps scores to labels correctly', () => {
    expect(convictionLabel(0.9)).toBe('strengthening')
    expect(convictionLabel(0.6)).toBe('stable')
    expect(convictionLabel(0.3)).toBe('weakening')
    expect(convictionLabel(0.1)).toBe('broken')
  })
})
