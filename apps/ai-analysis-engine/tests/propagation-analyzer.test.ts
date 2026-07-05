import { describe, it, expect, vi } from 'vitest'
import { analyzePropagation } from '../src/analysis/propagation-analyzer.js'
import type { MacroRegime, CompanyHealth, GraphJSON } from '../src/types.js'

const mockRegime: MacroRegime = {
  id: 'r1', date: '2026-05-23', regime: 'AI Acceleration',
  confidence: 'high', rationale: 'GPU demand strong',
  keyIndicators: ['NVDA up'], affectedTickers: ['NVDA'],
  createdAt: '2026-05-23T06:00:00.000Z',
}

const mockGraph: GraphJSON = {
  exportedAt: '2026-05-23T00:00:00.000Z',
  nodes: [
    { ticker: 'NVDA', company: 'NVIDIA', themes: ['ai-infrastructure'] },
    { ticker: 'CRWV', company: 'CoreWeave', themes: ['ai-infrastructure'] },
  ],
  edges: [
    { from: 'CRWV', to: 'NVDA', type: 'customer', strength: 'strong', description: 'CoreWeave buys NVIDIA GPUs', evidenceQuote: null },
  ],
}

const mockHealth: CompanyHealth[] = [
  { ticker: 'NVDA', company: 'NVIDIA', thesisSummary: 'Dominant GPU maker', assumptions: [], recentChunks: [], healthScore: 'positive' },
  { ticker: 'CRWV', company: 'CoreWeave', thesisSummary: 'GPU cloud provider', assumptions: [], recentChunks: [], healthScore: 'positive' },
]

describe('analyzePropagation', () => {
  it('returns PropagationSignal array from Claude tool response', async () => {
    const mockClient = {
      messages: {
        create: vi.fn().mockResolvedValue({
          content: [{
            type: 'tool_use',
            name: 'propose_propagation_signals',
            input: {
              signals: [{
                sourceTicker: 'NVDA', targetTicker: 'CRWV',
                signalType: 'customer', direction: 'downstream',
                magnitude: 'strong', sentiment: 'positive',
                description: 'CRWV benefits from NVDA GPU availability during AI Acceleration',
                evidenceQuote: null,
              }],
            },
          }],
        }),
      },
    }

    const results = await analyzePropagation(mockRegime, mockGraph, mockHealth, { client: mockClient as any })

    expect(results).toHaveLength(1)
    expect(results[0].sourceTicker).toBe('NVDA')
    expect(results[0].targetTicker).toBe('CRWV')
    expect(results[0].sentiment).toBe('positive')
    expect(results[0].id).toMatch(/^[0-9a-f-]{36}$/)
    expect(results[0].date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(results[0].evidenceQuote).toBeNull()
  })

  it('returns empty array when no signals are proposed', async () => {
    const mockClient = {
      messages: {
        create: vi.fn().mockResolvedValue({
          content: [{
            type: 'tool_use',
            name: 'propose_propagation_signals',
            input: { signals: [] },
          }],
        }),
      },
    }

    const results = await analyzePropagation(mockRegime, mockGraph, mockHealth, { client: mockClient as any })
    expect(results).toHaveLength(0)
  })

  it('throws when Claude does not return tool_use block', async () => {
    const mockClient = {
      messages: {
        create: vi.fn().mockResolvedValue({
          content: [{ type: 'text', text: 'unexpected' }],
        }),
      },
    }

    await expect(analyzePropagation(mockRegime, mockGraph, mockHealth, { client: mockClient as any }))
      .rejects.toThrow('Expected tool_use response')
  })
})
