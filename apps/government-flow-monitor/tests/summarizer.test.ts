import { describe, it, expect } from 'vitest'
import { buildNarrativeKey, mergeCacheEntry } from '../src/summarizer.js'
import type { BudgetSignal } from '../src/types.js'

describe('buildNarrativeKey', () => {
  it('builds key from billNumber and date', () => {
    expect(buildNarrativeKey('HR2670', '2026-05-01')).toBe('HR2670:2026-05-01')
  })
})

describe('mergeCacheEntry', () => {
  it('returns cached signal when key matches', () => {
    const cached: BudgetSignal = {
      billNumber: 'HR2670', title: 'Test Bill', congress: 119,
      status: 'passed', date: '2026-05-01',
      summary: 'Cached summary',
      relevantTickers: ['NVDA'], totalFunding: 1e9, keyProvisions: ['AI compute'],
    }
    const result = mergeCacheEntry('HR2670:2026-05-01', { 'HR2670:2026-05-01': cached })
    expect(result).toBe(cached)
  })

  it('returns null when key not found', () => {
    const result = mergeCacheEntry('HR9999:2026-05-01', {})
    expect(result).toBeNull()
  })
})
