import { describe, it, expect, vi } from 'vitest'
import Anthropic from '@anthropic-ai/sdk'
import { generateScenarios } from '../src/simulation/scenario-generator.js'
import type { AnalysisJSON, GraphJSON } from '../src/types.js'

const mockAnalysis: AnalysisJSON = {
  exportedAt: '2026-05-23T10:00:00.000Z',
  latestRegime: {
    id: 'r1', date: '2026-05-23', regime: 'AI Acceleration', confidence: 'high',
    rationale: 'GPU demand strong across hyperscalers.',
    keyIndicators: ['NVDA revenue up 80% YoY'],
    affectedTickers: ['NVDA', 'AMD'],
    createdAt: '2026-05-23T10:00:00.000Z',
  },
  latestSignals: [],
  companySummaries: [
    { ticker: 'NVDA', company: 'NVIDIA', healthScore: 'positive', thesisSummary: 'AI infrastructure leader.' },
  ],
}

const mockGraph: GraphJSON = {
  exportedAt: '2026-05-23T10:00:00.000Z',
  nodes: [{ ticker: 'NVDA', company: 'NVIDIA', themes: ['ai-infrastructure'] }],
  edges: [],
}

const threeScenarios = [
  { scenarioType: 'best', title: 'AI Boom', narrative: 'Strong demand.', timeHorizon: '3-6 months', probability: 65, regimeTransition: null, triggers: ['NVDA beats guidance'] },
  { scenarioType: 'base', title: 'Steady State', narrative: 'Moderate growth.', timeHorizon: '6-12 months', probability: 55, regimeTransition: null, triggers: ['Macro stable'] },
  { scenarioType: 'disruption', title: 'Supply Shock', narrative: 'TSM cuts.', timeHorizon: '3-6 months', probability: 20, regimeTransition: 'Semiconductor Correction', triggers: ['TSM cuts 2nm'] },
]

function makeMockClient(scenarios: typeof threeScenarios): Anthropic {
  return {
    messages: {
      create: vi.fn().mockResolvedValue({
        content: [{ type: 'tool_use', input: { scenarios } }],
      }),
    },
  } as unknown as Anthropic
}

describe('generateScenarios', () => {
  it('returns 3 scenarios for a daily run', async () => {
    const scenarios = await generateScenarios(mockAnalysis, mockGraph, {
      runId: 'run-1', client: makeMockClient(threeScenarios),
    })

    expect(scenarios).toHaveLength(3)
    expect(scenarios[0].scenarioType).toBe('best')
    expect(scenarios[1].scenarioType).toBe('base')
    expect(scenarios[2].scenarioType).toBe('disruption')
    expect(scenarios[0].runId).toBe('run-1')
    expect(scenarios[2].regimeTransition).toBe('Semiconductor Correction')
    expect(scenarios[0].id).toBeTruthy()
  })

  it('returns 1 whatif scenario when trigger is provided', async () => {
    const whatif = [{ scenarioType: 'whatif', title: 'TSMC Shock', narrative: 'Downstream shortages.', timeHorizon: '3-6 months', probability: 40, regimeTransition: 'Semiconductor Correction', triggers: ['TSMC cuts 30%'] }]
    const scenarios = await generateScenarios(mockAnalysis, mockGraph, {
      trigger: 'TSMC cuts 2nm capacity by 30%', runId: 'run-2', client: makeMockClient(whatif),
    })

    expect(scenarios).toHaveLength(1)
    expect(scenarios[0].scenarioType).toBe('whatif')
  })

  it('throws when Claude does not return tool_use', async () => {
    const badClient = {
      messages: { create: vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'oops' }] }) },
    } as unknown as Anthropic

    await expect(
      generateScenarios(mockAnalysis, mockGraph, { runId: 'run-3', client: badClient })
    ).rejects.toThrow('Expected tool_use response from Claude')
  })
})
