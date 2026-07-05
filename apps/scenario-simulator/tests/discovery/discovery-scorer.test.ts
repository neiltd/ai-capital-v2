import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mockCreate } = vi.hoisted(() => ({ mockCreate: vi.fn() }))

vi.mock('@anthropic-ai/sdk', () => ({
  default: vi.fn().mockImplementation(() => ({
    messages: { create: mockCreate },
  })),
}))

import { scoreCandidates } from '../../src/discovery/discovery-scorer.js'
import type { DiscoveryCandidate } from '../../src/discovery/types.js'

function candidate(ticker: string, source: 'companies_table' | 'news_mention' = 'companies_table'): DiscoveryCandidate {
  return { ticker, company: `${ticker} Corp`, source, newsSnippet: source === 'news_mention' ? 'news snippet' : null }
}

function makeScoreResponse(scores: Array<{ ticker: string; score: number; rationale: string }>) {
  return {
    content: [
      {
        type: 'tool_use',
        id: 'tu_1',
        name: 'score_candidates',
        input: { scores },
      },
    ],
  }
}

describe('scoreCandidates', () => {
  beforeEach(() => {
    mockCreate.mockReset()
  })

  it('returns empty array when candidates list is empty', async () => {
    const result = await scoreCandidates([], 'Risk On', [], [])
    expect(result).toHaveLength(0)
    expect(mockCreate).not.toHaveBeenCalled()
  })

  it('returns ScoredCandidate[] from tool response', async () => {
    const candidates = [candidate('NVDA'), candidate('SMCI', 'news_mention')]
    mockCreate.mockResolvedValue(makeScoreResponse([
      { ticker: 'NVDA', score: 85, rationale: 'AI leader' },
      { ticker: 'SMCI', score: 72, rationale: 'Server demand surge' },
    ]))

    const result = await scoreCandidates(candidates, 'Risk On', ['AAPL'], [])
    expect(result).toHaveLength(2)
    expect(result[0].ticker).toBe('NVDA')
    expect(result[0].score).toBe(85)
    expect(result[0].source).toBe('companies_table')
    expect(result[1].ticker).toBe('SMCI')
    expect(result[1].score).toBe(72)
    expect(result[1].source).toBe('news_mention')
  })

  it('clamps scores to 0–100 range', async () => {
    mockCreate.mockResolvedValue(makeScoreResponse([
      { ticker: 'AAPL', score: 150, rationale: 'Way too high' },
      { ticker: 'MSFT', score: -10, rationale: 'Negative' },
    ]))
    const result = await scoreCandidates([candidate('AAPL'), candidate('MSFT')], 'Risk On', [], [])
    expect(result[0].score).toBe(100)
    expect(result[1].score).toBe(0)
  })

  it('returns empty array when no tool_use block in response', async () => {
    mockCreate.mockResolvedValue({ content: [{ type: 'text', text: 'No scores' }] })
    const result = await scoreCandidates([candidate('NVDA')], 'Risk On', [], [])
    expect(result).toHaveLength(0)
  })

  it('uses forced tool_choice for score_candidates', async () => {
    mockCreate.mockResolvedValue(makeScoreResponse([]))
    await scoreCandidates([candidate('NVDA')], 'Risk On', [], [])
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        tool_choice: { type: 'tool', name: 'score_candidates' },
      })
    )
  })

  it('includes macro regime and portfolio context in user message', async () => {
    mockCreate.mockResolvedValue(makeScoreResponse([]))
    await scoreCandidates([candidate('NVDA')], 'Risk Off — Recession Fear', ['TSLA', 'META'], ['SMCI'])
    const call = mockCreate.mock.calls[0][0]
    const userContent = call.messages[0].content
    expect(userContent).toContain('Risk Off — Recession Fear')
    expect(userContent).toContain('TSLA')
    expect(userContent).toContain('SMCI')
  })
})
