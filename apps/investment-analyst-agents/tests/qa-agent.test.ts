import { describe, it, expect, vi } from 'vitest'
import Anthropic from '@anthropic-ai/sdk'
import { askQuestion } from '../src/qa/qa-agent.js'
import type { SimulationJSON, GraphJSON } from '../src/types.js'

const mockSimulation: SimulationJSON = {
  exportedAt: '',
  portfolio: [{ ticker: 'NVDA', company: 'NVIDIA', shares: 100, avgCost: 68.50, currentPrice: 92.00, currentValue: 9200, unrealizedPnl: 2350, updatedAt: '' }],
  scenarios: [],
  actions:   [],
}

const mockGraph: GraphJSON = {
  exportedAt: '',
  nodes: [],
  edges: [{ from: 'NVDA', to: 'TSM', type: 'supply_chain', strength: 'strong', description: 'NVDA depends on TSM for 3nm fab.', evidenceQuote: null }],
}

const mockContext = { simulation: mockSimulation, graph: mockGraph, profile: 'Risk: moderate.' }
const briefing    = '# Investment Briefing — 2026-05-26\n## Macro Regime\nAI Acceleration (high confidence).'

describe('askQuestion', () => {
  it('returns the text answer from Claude', async () => {
    const mockClient = {
      messages: {
        create: vi.fn().mockResolvedValue({
          content: [{ type: 'text', text: 'AI Acceleration is the current regime.' }],
        }),
      },
    } as unknown as Anthropic

    const answer = await askQuestion('What is the regime?', briefing, mockContext, [], { client: mockClient })
    expect(answer).toBe('AI Acceleration is the current regime.')
  })

  it('places history turns before the current question', async () => {
    let capturedMessages: any[] = []
    const mockClient = {
      messages: {
        create: vi.fn().mockImplementation(async (params: any) => {
          capturedMessages = params.messages
          return { content: [{ type: 'text', text: 'Answer.' }] }
        }),
      },
    } as unknown as Anthropic

    const history: Array<{ role: 'user' | 'assistant'; content: string }> = [
      { role: 'user',      content: 'Prior question.' },
      { role: 'assistant', content: 'Prior answer.' },
    ]
    await askQuestion('Follow-up.', briefing, mockContext, history, { client: mockClient })

    const last       = capturedMessages[capturedMessages.length - 1]
    const secondLast = capturedMessages[capturedMessages.length - 2]
    expect(last.role).toBe('user')
    expect(last.content).toBe('Follow-up.')
    expect(secondLast.role).toBe('assistant')
    expect(secondLast.content).toBe('Prior answer.')
  })

  it('throws when Claude returns no text block', async () => {
    const mockClient = {
      messages: {
        create: vi.fn().mockResolvedValue({ content: [] }),
      },
    } as unknown as Anthropic

    await expect(askQuestion('question', briefing, mockContext, [], { client: mockClient }))
      .rejects.toThrow('Expected text response from Claude')
  })
})
