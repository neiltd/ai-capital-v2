import { describe, it, expect } from 'vitest'
import type { WatchlistAward, AgencyFlow, BudgetSignal, GovFlowJSON } from '../src/types.js'

describe('types', () => {
  it('WatchlistAward has required fields', () => {
    const a: WatchlistAward = {
      ticker: 'NVDA', company: 'NVIDIA',
      total30d: 5_000_000, awardCount: 3,
      topAgency: 'Department of Defense',
      contracts: ['AI compute infrastructure'],
    }
    expect(a.ticker).toBe('NVDA')
    expect(a.total30d).toBe(5_000_000)
  })

  it('GovFlowJSON has all arrays', () => {
    const g: GovFlowJSON = {
      exportedAt: '2026-05-29T00:00:00.000Z',
      asOf: '2026-05-29',
      watchlistAwards: [],
      agencyFlows: [],
      budgetSignals: [],
    }
    expect(g.watchlistAwards).toHaveLength(0)
  })
})
