import { describe, it, expect, vi } from 'vitest'
import Anthropic from '@anthropic-ai/sdk'
import { generateBriefing } from '../src/briefing/briefing-agent.js'
import type { ContextBundle } from '../src/types.js'

const baseCtx: ContextBundle = {
  date: '2026-05-26',
  analysis: {
    exportedAt: '',
    latestRegime: { id: 'r1', date: '', regime: 'AI Acceleration', confidence: 'high', rationale: 'GPU demand strong.', keyIndicators: ['NVDA up 80%'], affectedTickers: ['NVDA'], createdAt: '' },
    latestSignals: [],
    companySummaries: [{ ticker: 'NVDA', company: 'NVIDIA', healthScore: 'positive', thesisSummary: 'AI leader.' }],
  },
  simulation: { exportedAt: '', portfolio: [], scenarios: [], actions: [] },
  graph: { exportedAt: '', nodes: [], edges: [] },
  stockIntel: { date: '', marketEvents: [], macroRiskSignals: [], sectorExposure: [] },
  worldIntel: { date: '', events: [], countrySignals: [] },
  profile: 'Risk: moderate.',
  profileMissing: false,
}

describe('generateBriefing', () => {
  it('returns the text content from Claude', async () => {
    const mockClient = {
      messages: {
        create: vi.fn().mockResolvedValue({
          content: [{ type: 'text', text: '# Investment Briefing — 2026-05-26\n## Macro Regime\nAI Acceleration.' }],
        }),
      },
    } as unknown as Anthropic

    const result = await generateBriefing(baseCtx, { client: mockClient })
    expect(result).toContain('# Investment Briefing')
  })

  it('includes "No investor profile found" in user message when profileMissing is true', async () => {
    let capturedMessages: any[] = []
    const mockClient = {
      messages: {
        create: vi.fn().mockImplementation(async (params: any) => {
          capturedMessages = params.messages
          return { content: [{ type: 'text', text: 'Briefing.' }] }
        }),
      },
    } as unknown as Anthropic

    await generateBriefing({ ...baseCtx, profile: '', profileMissing: true }, { client: mockClient })
    const userMsg = capturedMessages.find((m: any) => m.role === 'user')
    expect(userMsg.content).toContain('No investor profile found')
  })

  it('throws when Claude returns no text block', async () => {
    const mockClient = {
      messages: {
        create: vi.fn().mockResolvedValue({ content: [{ type: 'tool_use', input: {} }] }),
      },
    } as unknown as Anthropic

    await expect(generateBriefing(baseCtx, { client: mockClient }))
      .rejects.toThrow('Expected text response from Claude')
  })
})
