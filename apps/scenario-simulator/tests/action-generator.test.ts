import { describe, it, expect, vi } from 'vitest'
import Anthropic from '@anthropic-ai/sdk'
import { generateActions } from '../src/simulation/action-generator.js'
import type { Scenario, Position } from '../src/types.js'

const mockScenarios: Scenario[] = [
  {
    id: 's1', runId: 'run-1', date: '2026-05-23', scenarioType: 'best',
    title: 'AI Boom', narrative: 'Strong demand.', timeHorizon: '3-6 months',
    probability: 65, regimeTransition: null, triggers: ['NVDA beats'],
    createdAt: '2026-05-23T10:00:00Z',
  },
  {
    id: 's2', runId: 'run-1', date: '2026-05-23', scenarioType: 'disruption',
    title: 'Supply Shock', narrative: 'TSM cuts.', timeHorizon: '3-6 months',
    probability: 20, regimeTransition: 'Semiconductor Correction', triggers: ['TSM cuts 2nm'],
    createdAt: '2026-05-23T10:00:00Z',
  },
]

const mockPositions: Position[] = [
  { ticker: 'NVDA', company: 'NVIDIA', shares: 100, avgCost: 68.50, currentPrice: 92.00, currentValue: 9200, unrealizedPnl: 2350, updatedAt: '2026-05-23T10:00:00Z' },
]

describe('generateActions', () => {
  it('returns actions with correct scenarioId mapping', async () => {
    const mockClient = {
      messages: {
        create: vi.fn().mockResolvedValue({
          content: [{
            type: 'tool_use',
            input: {
              actions: [
                { scenarioType: 'best', ticker: 'NVDA', action: 'buy', conviction: 'high', allocationChangePct: 15, rationale: 'AI demand accelerating.' },
                { scenarioType: 'disruption', ticker: 'NVDA', action: 'trim', conviction: 'high', allocationChangePct: -25, rationale: 'Supply risk elevated.' },
              ],
            },
          }],
        }),
      },
    } as unknown as Anthropic

    const actions = await generateActions(mockScenarios, mockPositions, { runId: 'run-1', client: mockClient })

    expect(actions).toHaveLength(2)
    expect(actions[0].scenarioId).toBe('s1')
    expect(actions[1].scenarioId).toBe('s2')
    expect(actions[0].action).toBe('buy')
    expect(actions[0].allocationChangePct).toBe(15)
    expect(actions[1].allocationChangePct).toBe(-25)
    expect(actions[0].runId).toBe('run-1')
  })

  it('allocationChangePct is stored as-is (integer from Claude)', async () => {
    const mockClient = {
      messages: {
        create: vi.fn().mockResolvedValue({
          content: [{ type: 'tool_use', input: { actions: [{ scenarioType: 'best', ticker: 'NVDA', action: 'hold', conviction: 'medium', allocationChangePct: 0, rationale: 'Monitoring.' }] } }],
        }),
      },
    } as unknown as Anthropic

    const actions = await generateActions(mockScenarios, mockPositions, { runId: 'run-1', client: mockClient })

    expect(actions[0].allocationChangePct).toBe(0)
  })

  it('throws when Claude does not return tool_use', async () => {
    const badClient = {
      messages: { create: vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'oops' }] }) },
    } as unknown as Anthropic

    await expect(
      generateActions(mockScenarios, mockPositions, { runId: 'run-1', client: badClient })
    ).rejects.toThrow('Expected tool_use response from Claude')
  })
})
