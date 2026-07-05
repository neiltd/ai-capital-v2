import { describe, it, expect, vi, beforeEach } from 'vitest'

// vi.hoisted ensures mockCreate is available inside the hoisted vi.mock factory
const { mockCreate } = vi.hoisted(() => ({ mockCreate: vi.fn() }))

// Mock Anthropic before importing the module under test
vi.mock('@anthropic-ai/sdk', () => {
  const MockAnthropic = vi.fn().mockImplementation(() => ({
    messages: { create: mockCreate },
  }))
  return { default: MockAnthropic }
})

import { extractTickers } from '../../src/discovery/ticker-extractor.js'
import type { NewsRow } from '../../src/discovery/ingestion-reader.js'

function makeToolResponse(mentions: Array<{ ticker: string; company: string; snippet: string }>) {
  return {
    content: [
      {
        type: 'tool_use',
        id: 'tu_1',
        name: 'extract_tickers',
        input: { mentions },
      },
    ],
  }
}

const sampleNews: NewsRow[] = [
  { ticker: 'NVDA', company: 'NVIDIA', content: 'NVIDIA launches new AI chips driving data center growth', publishedDate: '2026-05-27' },
  { ticker: 'AAPL', company: 'Apple', content: 'Apple partners with SMCI for server solutions', publishedDate: '2026-05-26' },
]

describe('extractTickers', () => {
  beforeEach(() => {
    mockCreate.mockReset()
  })

  it('returns empty array when news is empty', async () => {
    const result = await extractTickers([], new Set())
    expect(result).toHaveLength(0)
    // Should not call Claude at all
    expect(mockCreate).not.toHaveBeenCalled()
  })

  it('returns DiscoveryCandidates from tool response', async () => {
    mockCreate.mockResolvedValue(makeToolResponse([
      { ticker: 'SMCI', company: 'Super Micro Computer', snippet: 'Apple partners with SMCI for server solutions' },
    ]))
    const result = await extractTickers(sampleNews, new Set(['NVDA', 'AAPL']))
    expect(result).toHaveLength(1)
    expect(result[0].ticker).toBe('SMCI')
    expect(result[0].company).toBe('Super Micro Computer')
    expect(result[0].source).toBe('news_mention')
    expect(result[0].newsSnippet).toBe('Apple partners with SMCI for server solutions')
  })

  it('uppercases ticker symbols', async () => {
    mockCreate.mockResolvedValue(makeToolResponse([
      { ticker: 'smci', company: 'Super Micro Computer', snippet: 'SMCI grows fast' },
    ]))
    const result = await extractTickers(sampleNews, new Set())
    expect(result[0].ticker).toBe('SMCI')
  })

  it('filters out tickers already in knownTickers', async () => {
    mockCreate.mockResolvedValue(makeToolResponse([
      { ticker: 'NVDA', company: 'NVIDIA', snippet: 'already known' },
      { ticker: 'SMCI', company: 'SMCI Corp', snippet: 'new ticker' },
    ]))
    const result = await extractTickers(sampleNews, new Set(['NVDA']))
    const tickers = result.map(r => r.ticker)
    expect(tickers).not.toContain('NVDA')
    expect(tickers).toContain('SMCI')
  })

  it('returns empty array when Claude returns no tool use block', async () => {
    mockCreate.mockResolvedValue({ content: [{ type: 'text', text: 'No tickers found' }] })
    const result = await extractTickers(sampleNews, new Set())
    expect(result).toHaveLength(0)
  })

  it('returns empty array when mentions array is empty', async () => {
    mockCreate.mockResolvedValue(makeToolResponse([]))
    const result = await extractTickers(sampleNews, new Set())
    expect(result).toHaveLength(0)
  })

  it('calls Claude with forced tool_choice for extract_tickers', async () => {
    mockCreate.mockResolvedValue(makeToolResponse([]))
    await extractTickers(sampleNews, new Set())
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        tool_choice: { type: 'tool', name: 'extract_tickers' },
      })
    )
  })
})
