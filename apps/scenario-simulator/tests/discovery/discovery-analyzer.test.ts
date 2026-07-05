import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mockCreate } = vi.hoisted(() => ({ mockCreate: vi.fn() }))

vi.mock('@anthropic-ai/sdk', () => ({
  default: vi.fn().mockImplementation(() => ({
    messages: { create: mockCreate },
  })),
}))

import { analyzeCandidate } from '../../src/discovery/discovery-analyzer.js'
import type { ScoredCandidate } from '../../src/discovery/types.js'

const sampleCandidate: ScoredCandidate = {
  ticker: 'SMCI',
  company: 'Super Micro Computer',
  source: 'news_mention',
  score: 82,
  rationale: 'Supply chain pivot signals accelerating server demand',
}

function makeAnalysisResponse(scenarios: object[], action: object) {
  return {
    content: [
      {
        type: 'tool_use',
        id: 'tu_1',
        name: 'analyze_discovery_ticker',
        input: { scenarios, action },
      },
    ],
  }
}

const threeScenarios = [
  {
    scenarioType: 'best',
    title: 'AI Server Supercycle',
    narrative: 'Hyperscaler capex drives 40%+ revenue growth.',
    timeHorizon: '12 months',
    probability: 60,
    regimeTransition: null,
    triggers: ['Hyperscaler capex increase'],
  },
  {
    scenarioType: 'base',
    title: 'Steady Execution',
    narrative: 'Moderate growth continues.',
    timeHorizon: '12 months',
    probability: 30,
    regimeTransition: null,
    triggers: ['Normal demand'],
  },
  {
    scenarioType: 'disruption',
    title: 'Audit Risk Returns',
    narrative: 'SEC investigation reopened.',
    timeHorizon: '6 months',
    probability: 10,
    regimeTransition: 'Risk Off',
    triggers: ['Regulatory action'],
  },
]

const sampleAction = {
  recommendation: 'buy',
  conviction: 'high',
  rationale: 'Strong AI infrastructure tailwind, clear catalyst.',
}

describe('analyzeCandidate', () => {
  beforeEach(() => {
    mockCreate.mockReset()
  })

  it('returns AnalysisResult with exactly 3 scenarios', async () => {
    mockCreate.mockResolvedValue(makeAnalysisResponse(threeScenarios, sampleAction))
    const result = await analyzeCandidate(sampleCandidate, 195.31, 'Risk On', 'AI capex accelerating')
    expect(result).not.toBeNull()
    expect(result!.scenarios).toHaveLength(3)
  })

  it('returns scenarios with correct types best/base/disruption', async () => {
    mockCreate.mockResolvedValue(makeAnalysisResponse(threeScenarios, sampleAction))
    const result = await analyzeCandidate(sampleCandidate, 195.31, 'Risk On', 'AI capex accelerating')
    const types = result!.scenarios.map(s => s.scenarioType)
    expect(types).toContain('best')
    expect(types).toContain('base')
    expect(types).toContain('disruption')
  })

  it('attaches ticker and date to each scenario', async () => {
    mockCreate.mockResolvedValue(makeAnalysisResponse(threeScenarios, sampleAction))
    const result = await analyzeCandidate(sampleCandidate, 195.31, 'Risk On', 'signals')
    for (const scenario of result!.scenarios) {
      expect(scenario.ticker).toBe('SMCI')
      expect(scenario.date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
      expect(scenario.id).toBeDefined()
      expect(scenario.createdAt).toBeDefined()
    }
  })

  it('returns action with recommendation buy or watch', async () => {
    mockCreate.mockResolvedValue(makeAnalysisResponse(threeScenarios, sampleAction))
    const result = await analyzeCandidate(sampleCandidate, 195.31, 'Risk On', 'signals')
    expect(result!.action.recommendation).toBe('buy')
    expect(result!.action.conviction).toBe('high')
    expect(result!.action.ticker).toBe('SMCI')
  })

  it('returns null when no tool_use block in response', async () => {
    mockCreate.mockResolvedValue({ content: [{ type: 'text', text: 'No analysis' }] })
    const result = await analyzeCandidate(sampleCandidate, 195.31, 'Risk On', 'signals')
    expect(result).toBeNull()
  })

  it('returns null when fewer than 3 scenarios returned', async () => {
    mockCreate.mockResolvedValue(makeAnalysisResponse([threeScenarios[0]], sampleAction))
    const result = await analyzeCandidate(sampleCandidate, 195.31, 'Risk On', 'signals')
    expect(result).toBeNull()
  })

  it('uses forced tool_choice for analyze_discovery_ticker', async () => {
    mockCreate.mockResolvedValue(makeAnalysisResponse(threeScenarios, sampleAction))
    await analyzeCandidate(sampleCandidate, 195.31, 'Risk On', 'signals')
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        tool_choice: { type: 'tool', name: 'analyze_discovery_ticker' },
      })
    )
  })
})
