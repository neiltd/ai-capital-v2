// tests/reasoning/analyzer.test.ts
import { describe, it, expect, vi } from 'vitest'
import { createAnalyzer } from '../../src/reasoning/analyzer.js'

vi.mock('@anthropic-ai/sdk', () => ({
  default: vi.fn().mockImplementation(() => ({
    messages: {
      create: vi.fn().mockResolvedValue({
        content: [
          {
            type: 'tool_use',
            name: 'propose_thesis_update',
            input: {
              assumption_changes: [
                {
                  label: 'Hyperscaler capex growing',
                  old_status: 'weakening',
                  new_status: 'strengthening',
                  reasoning: 'Q1 2026 shows capex accelerating across all hyperscalers.',
                  evidence_quotes: ['revenue of $39.3 billion, up 69%'],
                },
              ],
              narrative_update: 'The NVIDIA thesis has strengthened materially.',
              portfolio_action: { action: 'hold', reasoning: 'Valuation stretch', conviction: 8 },
            },
          },
        ],
      }),
    },
  })),
}))

describe('createAnalyzer', () => {
  it('returns a structured ProposalResponse from Claude', async () => {
    const analyzer = createAnalyzer('test-key')
    const result = await analyzer.analyze('test prompt', 'NVDA')
    expect(result.assumption_changes).toHaveLength(1)
    expect(result.assumption_changes[0].label).toBe('Hyperscaler capex growing')
    expect(result.assumption_changes[0].new_status).toBe('strengthening')
    expect(result.narrative_update).toBe('The NVIDIA thesis has strengthened materially.')
    expect(result.portfolio_action?.action).toBe('hold')
    expect(result.portfolio_action?.conviction).toBe(8)
  })

  it('handles response with no portfolio action', async () => {
    const Anthropic = (await import('@anthropic-ai/sdk')).default as ReturnType<typeof vi.fn>
    Anthropic.mockImplementationOnce(() => ({
      messages: {
        create: vi.fn().mockResolvedValue({
          content: [
            {
              type: 'tool_use',
              name: 'propose_thesis_update',
              input: {
                assumption_changes: [],
                narrative_update: 'No significant changes.',
                portfolio_action: null,
              },
            },
          ],
        }),
      },
    }))
    const analyzer = createAnalyzer('test-key')
    const result = await analyzer.analyze('prompt', 'NVDA')
    expect(result.portfolio_action).toBeNull()
    expect(result.assumption_changes).toHaveLength(0)
  })
})
