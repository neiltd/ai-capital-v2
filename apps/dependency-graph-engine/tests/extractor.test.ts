import { describe, it, expect, vi } from 'vitest'
import { extractRelationships } from '../src/scanner/extractor.js'

vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    messages = {
      create: vi.fn().mockResolvedValue({
        content: [{
          type: 'text',
          text: JSON.stringify({
            relationships: [{
              from: 'NVDA',
              to: 'TSM',
              type: 'supply_chain',
              strength: 'strong',
              description: 'TSMC manufactures NVIDIA chips',
              evidence_quote: 'TSMC is our primary foundry partner',
              reasoning: 'Explicitly stated in 10-K',
            }],
          }),
        }],
      }),
    }
  },
}))

describe('extractRelationships', () => {
  it('returns empty when no chunks provided', async () => {
    const result = await extractRelationships('NVDA', 'NVIDIA', 'TSM', 'TSMC', [])
    expect(result.relationships).toHaveLength(0)
  })

  it('parses Claude response into structured relationships', async () => {
    const result = await extractRelationships('NVDA', 'NVIDIA', 'TSM', 'TSMC', [
      { id: 'c1', content: 'TSMC is our primary foundry partner for advanced nodes.' },
    ])
    expect(result.relationships).toHaveLength(1)
    expect(result.relationships[0].from).toBe('NVDA')
    expect(result.relationships[0].to).toBe('TSM')
    expect(result.relationships[0].type).toBe('supply_chain')
    expect(result.relationships[0].strength).toBe('strong')
    expect(result.relationships[0].evidenceQuote).toBe('TSMC is our primary foundry partner')
  })
})
