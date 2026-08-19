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

  it('includes real live market prices in the prompt when macro data is present', async () => {
    let capturedMessages: any[] = []
    const mockClient = {
      messages: {
        create: vi.fn().mockImplementation(async (params: any) => {
          capturedMessages = params.messages
          return { content: [{ type: 'text', text: 'Briefing.' }] }
        }),
      },
    } as unknown as Anthropic

    await generateBriefing({
      ...baseCtx,
      macro: {
        asOf: '2026-07-21',
        marketAssets: [
          { ticker: 'CL=F', label: 'WTI Crude Oil', close: 84.66, changePct1d: 1.72, changePct30d: -6.49 },
        ],
      },
    }, { client: mockClient })

    // content is an array of Anthropic content blocks (see briefing-agent.ts),
    // not a plain string — same content-array shape as the
    // "No investor profile found" test above, so flatten to block text
    // before asserting rather than stringifying the block objects.
    const userText = capturedMessages
      .map((m: any) => (Array.isArray(m.content) ? m.content.map((b: any) => b.text).join('\n') : m.content))
      .join('\n')
    expect(userText).toContain('84.66')
    expect(userText).toContain('WTI Crude Oil')
  })

  it('system prompt tells the model to cite Live Market Data over regime rationale', async () => {
    let capturedSystem = ''
    const mockClient = {
      messages: {
        create: vi.fn().mockImplementation(async (params: any) => {
          capturedSystem = Array.isArray(params.system) ? params.system[0].text : params.system
          return { content: [{ type: 'text', text: 'Briefing.' }] }
        }),
      },
    } as unknown as Anthropic

    await generateBriefing(baseCtx, { client: mockClient })

    expect(capturedSystem).toContain('Live Market Data')
  })
})

// ── Risk-denominator disclosure ────────────────────────────────────────────
// Regression guard for the 2026-08-19 defect: risk.json's portfolioValueUSD is
// only the priced-securities subset ($14.3k of a $91.1k book), but the briefing
// rendered per-ticker sleeve weights as bare percentages, so the LLM wrote
// "LLY is 27.49% of the portfolio" when LLY was 4.31% of net worth. That is a
// trim signal against a 15% satellite cap on a position sitting at 4.3%.
const riskCtx = {
  schemaVersion:       '1.1',
  generatedAt:         '2026-08-19',
  windowDays:          90,
  benchmark:           'VOO',
  portfolioValueUSD:   14286,
  netWorthUSD:         91107,
  analyzedValueUSD:    14286,
  coverageOfNetWorth:  14286 / 91107,
  cashUSD:             44724,
  unpricedUSD:         32097,
  unpricedTickers:     ['PFM009', 'SCBCEH', 'GLDM'],
  portfolioVolatility: 0.1792,
  portfolioReturn:     0.05,
  sharpeRatio:         3.26,
  maxDrawdown:         -0.0422,
  oneDayVAR95:         142,
  portfolioBeta:       -0.13,
  perTicker: [
    // big in the sleeve, small in the book, and deliberately CALM (vol/beta
    // below every other trigger) so weight is the only thing that could flag it
    { ticker: 'LLY', weight: 0.2749, weightOfNetWorth: 0.0431, volatility: 0.25, totalReturn: 0.2, beta: 0.9, correlation: 0.4 },
  ],
  summary:             'Portfolio value ~$14286 (analyzed)',
}

async function capturePrompt(ctx: any): Promise<{ user: string; system: string }> {
  let capturedMessages: any[] = []
  let capturedSystem = ''
  const mockClient = {
    messages: {
      create: vi.fn().mockImplementation(async (params: any) => {
        capturedMessages = params.messages
        capturedSystem = Array.isArray(params.system) ? params.system[0].text : params.system
        return { content: [{ type: 'text', text: 'Briefing.' }] }
      }),
    },
  } as unknown as Anthropic
  await generateBriefing(ctx, { client: mockClient })
  return { user: capturedMessages.find((m: any) => m.role === 'user').content[0].text, system: capturedSystem }
}

describe('risk block denominator disclosure', () => {
  it('states the net worth the risk sleeve is a subset of, and the coverage fraction', async () => {
    const { user: text } = await capturePrompt({ ...baseCtx, risk: riskCtx })
    expect(text).toContain('$91,107')            // true net worth is present
    expect(text).toContain('$14,286')            // analyzed sleeve is present
    expect(text).toMatch(/15\.7%/)               // coverage disclosed
  })

  it('names what is excluded so the gap cannot be mistaken for zero', async () => {
    const { user: text } = await capturePrompt({ ...baseCtx, risk: riskCtx })
    expect(text).toContain('PFM009')
    expect(text).toMatch(/cash/i)
  })

  it('renders a rendered ticker\'s weight against net worth AND against the sleeve', async () => {
    // same LLY numbers, but volatile enough to clear the vol trigger so it is
    // actually rendered — the assertion is about how a shown line is worded.
    const volatileLly = {
      ...riskCtx,
      perTicker: [{ ...riskCtx.perTicker[0], volatility: 0.56 }],
    }
    const { user: text } = await capturePrompt({ ...baseCtx, risk: volatileLly })
    const lly = text.split('\n').find(l => l.includes('LLY') && l.includes('vol'))
    expect(lly).toBeDefined()
    expect(lly).toContain('4.31% of net worth')
    expect(lly).toContain('27.49% of priced sleeve')
  })

  it('instructs the model never to cite a sleeve weight as a share of the portfolio', async () => {
    const { system } = await capturePrompt({ ...baseCtx, risk: riskCtx })
    expect(system).toMatch(/never restate a sleeve weight/i)
    expect(system).toMatch(/different denominators/i)
  })

  it('does not flag a calm position as concentrated when it is small against net worth', async () => {
    const { user: text } = await capturePrompt({ ...baseCtx, risk: riskCtx })
    // LLY is 27.5% of the sleeve but 4.3% of the book, and its vol/beta are
    // below every other trigger — it must not appear as a concentration flag.
    expect(text).toContain('risk concentrations are within normal bounds')
  })

  it('still flags a position that is genuinely large against net worth', async () => {
    const heavy = {
      ...riskCtx,
      perTicker: [{ ticker: 'PFM009', weight: 0.30, weightOfNetWorth: 0.25, volatility: 0.10, totalReturn: 0.01, beta: 0.2, correlation: 0.1 }],
    }
    const { user: text } = await capturePrompt({ ...baseCtx, risk: heavy })
    expect(text).toContain('25.00% of net worth')
    expect(text).not.toContain('risk concentrations are within normal bounds')
  })
})
