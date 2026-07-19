import { describe, it, expect, vi } from 'vitest'
import Anthropic from '@anthropic-ai/sdk'
import { generateBriefing } from '../src/briefing/briefing-agent.js'
import type { ContextBundle, CalibrationContext } from '../src/types.js'

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

const baseCalibration: CalibrationContext = {
  generatedAt:           '2026-07-16',
  predictionsAnalyzed:   44,
  scoredCalls:           612,
  windows:               [7, 30, 90],
  byAction:              {},
  byConviction:          {},
  calibrationInverted:   false,
  highConvictionPenalty: 0,
  bestEdge:              null,
  worstSignal:           null,
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
    // content is an array of Anthropic content blocks (see briefing-agent.ts),
    // not a plain string — this predates that message-content change.
    expect(userMsg.content[0].text).toContain('No investor profile found')
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

  it('omits both the calibration block and the Decaying signals section when calibration is undefined', async () => {
    let capturedMessages: any[] = []
    const mockClient = {
      messages: {
        create: vi.fn().mockImplementation(async (params: any) => {
          capturedMessages = params.messages
          return { content: [{ type: 'text', text: 'Briefing.' }] }
        }),
      },
    } as unknown as Anthropic

    // baseCtx never sets `calibration` — it's undefined, exercising the
    // pre-existing `if (!calibration) return ''` early-return path in
    // calibrationBlock. This confirms the new decay-rendering code added in
    // this task doesn't change that existing no-calibration behavior.
    await generateBriefing(baseCtx, { client: mockClient })
    const userMsg = capturedMessages.find((m: any) => m.role === 'user')
    const text = userMsg.content[0].text
    expect(text).not.toContain('Briefing Self-Calibration')
    expect(text).not.toContain('Decaying signals')
  })

  it('omits the Decaying signals section when calibration has no decaying field', async () => {
    let capturedMessages: any[] = []
    const mockClient = {
      messages: {
        create: vi.fn().mockImplementation(async (params: any) => {
          capturedMessages = params.messages
          return { content: [{ type: 'text', text: 'Briefing.' }] }
        }),
      },
    } as unknown as Anthropic

    await generateBriefing({ ...baseCtx, calibration: baseCalibration }, { client: mockClient })
    const userMsg = capturedMessages.find((m: any) => m.role === 'user')
    expect(userMsg.content[0].text).not.toContain('Decaying signals')
  })

  it('omits the Decaying signals section when decaying is an empty array', async () => {
    let capturedMessages: any[] = []
    const mockClient = {
      messages: {
        create: vi.fn().mockImplementation(async (params: any) => {
          capturedMessages = params.messages
          return { content: [{ type: 'text', text: 'Briefing.' }] }
        }),
      },
    } as unknown as Anthropic

    await generateBriefing(
      { ...baseCtx, calibration: { ...baseCalibration, decayWindowPredictions: 15, decaying: [] } },
      { client: mockClient },
    )
    const userMsg = capturedMessages.find((m: any) => m.role === 'user')
    expect(userMsg.content[0].text).not.toContain('Decaying signals')
  })

  it('includes a Decaying signals section with signal name and both accuracies when populated', async () => {
    let capturedMessages: any[] = []
    const mockClient = {
      messages: {
        create: vi.fn().mockImplementation(async (params: any) => {
          capturedMessages = params.messages
          return { content: [{ type: 'text', text: 'Briefing.' }] }
        }),
      },
    } as unknown as Anthropic

    await generateBriefing(
      {
        ...baseCtx,
        calibration: {
          ...baseCalibration,
          decayWindowPredictions: 15,
          decaying: [
            { signal: 'trim (30d)', allTimeAccuracy: 0.75, recentAccuracy: 0.2, allTimeCalls: 12, recentCalls: 5 },
          ],
        },
      },
      { client: mockClient },
    )
    const userMsg = capturedMessages.find((m: any) => m.role === 'user')
    const text = userMsg.content[0].text
    expect(text).toContain('Decaying signals')
    expect(text).toContain('trim (30d)')
    expect(text).toContain('75.0%')
    expect(text).toContain('20.0%')
  })
})
