import { describe, it, expect } from 'vitest'
import { filterCandidates } from '../../src/discovery/ticker-filter.js'
import type { DiscoveryCandidate } from '../../src/discovery/types.js'

function candidate(ticker: string, source: 'companies_table' | 'news_mention' = 'companies_table'): DiscoveryCandidate {
  return { ticker, company: `${ticker} Corp`, source, newsSnippet: null }
}

describe('filterCandidates', () => {
  it('returns all candidates when no duplicates and no open positions', () => {
    const input = [candidate('AAPL'), candidate('NVDA'), candidate('MSFT')]
    const result = filterCandidates(input, new Set())
    expect(result).toHaveLength(3)
    expect(result.map(r => r.ticker)).toEqual(['AAPL', 'NVDA', 'MSFT'])
  })

  it('deduplicates by ticker, keeping first occurrence', () => {
    const input = [
      candidate('AAPL', 'companies_table'),
      candidate('AAPL', 'news_mention'),  // duplicate — should be dropped
      candidate('NVDA'),
    ]
    const result = filterCandidates(input, new Set())
    expect(result).toHaveLength(2)
    expect(result[0].ticker).toBe('AAPL')
    expect(result[0].source).toBe('companies_table')  // first one kept
  })

  it('removes tickers already in open discovery positions', () => {
    const input = [candidate('AAPL'), candidate('NVDA'), candidate('MSFT')]
    const result = filterCandidates(input, new Set(['AAPL', 'MSFT']))
    expect(result).toHaveLength(1)
    expect(result[0].ticker).toBe('NVDA')
  })

  it('returns empty array when all candidates are open positions', () => {
    const input = [candidate('AAPL'), candidate('NVDA')]
    const result = filterCandidates(input, new Set(['AAPL', 'NVDA']))
    expect(result).toHaveLength(0)
  })

  it('handles empty input', () => {
    const result = filterCandidates([], new Set(['AAPL']))
    expect(result).toHaveLength(0)
  })

  it('handles empty open positions set', () => {
    const input = [candidate('AAPL')]
    const result = filterCandidates(input, new Set())
    expect(result).toHaveLength(1)
  })

  it('preserves candidate fields unchanged', () => {
    const input: DiscoveryCandidate[] = [
      { ticker: 'NVDA', company: 'NVIDIA Corporation', source: 'news_mention', newsSnippet: 'AI chips surge' }
    ]
    const result = filterCandidates(input, new Set())
    expect(result[0]).toEqual(input[0])
  })
})
