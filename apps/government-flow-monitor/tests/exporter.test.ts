import { describe, it, expect } from 'vitest'
import { buildGovFlow } from '../src/exporter.js'
import type { WatchlistAward, AgencyFlow, BudgetSignal } from '../src/types.js'

const award: WatchlistAward = { ticker: 'NVDA', company: 'NVIDIA', total30d: 5e6, awardCount: 2, topAgency: 'DoD', contracts: ['AI compute'] }
const agency: AgencyFlow = { agency: 'DoD', agencyId: '097', total30d: 80e9, trend: 'rising' }
const bill: BudgetSignal = { billNumber: 'HR2670', title: 'NDAA', congress: 119, status: 'passed', date: '2026-05-01', summary: 'Defense spending', relevantTickers: ['NVDA'], totalFunding: 850e9, keyProvisions: ['AI compute'] }

describe('buildGovFlow', () => {
  it('builds GovFlowJSON with correct shape', () => {
    const result = buildGovFlow([award], [agency], [bill])
    expect(result.watchlistAwards).toHaveLength(1)
    expect(result.agencyFlows).toHaveLength(1)
    expect(result.budgetSignals).toHaveLength(1)
    expect(result.exportedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(result.asOf).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('handles empty arrays', () => {
    const result = buildGovFlow([], [], [])
    expect(result.watchlistAwards).toHaveLength(0)
  })
})
