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

// ── E1: the same strict contract and a fail-closed validator here too ─────────
//
// This stage used the identical unchecked cast that failed in the classifier, so
// it is hardened before it costs a run rather than after. Assertions read the real
// request passed to `messages.create`.
describe('E1: propose_propagation_signals strict tool contract', () => {
  const SIGNAL = {
    sourceTicker: 'NVDA', targetTicker: 'CRWV',
    signalType: 'customer', direction: 'downstream',
    magnitude: 'strong', sentiment: 'positive',
    description: 'CoreWeave keeps expanding GPU capacity.',
    evidenceQuote: null,
  }
  const clientFor = (input: unknown) => ({
    messages: {
      create: vi.fn().mockResolvedValue({
        content: [{ type: 'tool_use', name: 'propose_propagation_signals', input }],
      }),
    },
  })
  const run = (input: unknown) => {
    const c = clientFor(input)
    return { c, p: analyzePropagation(mockRegime, mockGraph, mockHealth, { client: c as any }) }
  }
  const schemaOf = (c: any) => {
    const req = c.messages.create.mock.calls[0][0]
    return req.tools.find((t: any) => t.name === 'propose_propagation_signals')
  }

  it('sends strict: true on the propagation tool', async () => {
    const { c, p } = run({ signals: [SIGNAL] }); await p
    expect(schemaOf(c).strict).toBe(true)
  })

  it('sends additionalProperties: false on BOTH the root and each signal object', async () => {
    const { c, p } = run({ signals: [SIGNAL] }); await p
    const s = schemaOf(c).input_schema
    expect(s.additionalProperties).toBe(false)
    expect(s.properties.signals.items.additionalProperties).toBe(false)
  })

  it('declares evidenceQuote required and string-or-null', async () => {
    const { c, p } = run({ signals: [SIGNAL] }); await p
    const items = schemaOf(c).input_schema.properties.signals.items
    expect(items.properties.evidenceQuote.type).toEqual(['string', 'null'])
    expect(items.required).toContain('evidenceQuote')
    expect([...items.required].sort()).toEqual([
      'description', 'direction', 'evidenceQuote', 'magnitude',
      'sentiment', 'signalType', 'sourceTicker', 'targetTicker',
    ])
  })

  it('keeps the reviewed enums on the wire', async () => {
    const { c, p } = run({ signals: [SIGNAL] }); await p
    const props = schemaOf(c).input_schema.properties.signals.items.properties
    expect(props.signalType.enum).toEqual(['supply_chain', 'customer', 'technology', 'competitive'])
    expect(props.direction.enum).toEqual(['upstream', 'downstream'])
    expect(props.magnitude.enum).toEqual(['strong', 'moderate', 'weak'])
    expect(props.sentiment.enum).toEqual(['positive', 'negative', 'neutral'])
  })

  it('accepts a valid response and an empty signals array', async () => {
    const one = await run({ signals: [SIGNAL] }).p
    expect(one).toHaveLength(1)
    expect(one[0].evidenceQuote).toBeNull()
    expect(await run({ signals: [] }).p).toEqual([])
  })

  it('accepts a string evidenceQuote', async () => {
    const out = await run({ signals: [{ ...SIGNAL, evidenceQuote: 'capacity doubled' }] }).p
    expect(out[0].evidenceQuote).toBe('capacity doubled')
  })

  it('REJECTS a malformed container', async () => {
    await expect(run({ signals: 'none' }).p).rejects.toThrow(/signals that is not an array/)
    await expect(run(null).p).rejects.toThrow(/not an object/)
    await expect(run({}).p).rejects.toThrow(/signals that is not an array/)
  })

  it('REJECTS a malformed member rather than skipping it', async () => {
    // Discarding it would publish a shorter list and call it the analysis.
    await expect(run({ signals: [SIGNAL, 'oops'] }).p).rejects.toThrow(/signals\[1\] that is not an object/)
    await expect(run({ signals: [{ ...SIGNAL, description: 7 }] }).p)
      .rejects.toThrow(/signals\[0\]\.description that is not a non-empty string/)
  })

  it('REJECTS every out-of-enum value by name', async () => {
    const cases: Array<[string, string, RegExp]> = [
      ['signalType', 'pricing', /signalType that is not one of supply_chain, customer, technology, competitive/],
      ['direction', 'sideways', /direction that is not one of upstream, downstream/],
      ['magnitude', 'huge', /magnitude that is not one of strong, moderate, weak/],
      ['sentiment', 'mixed', /sentiment that is not one of positive, negative, neutral/],
    ]
    for (const [field, value, re] of cases) {
      await expect(run({ signals: [{ ...SIGNAL, [field]: value }] }).p).rejects.toThrow(re)
    }
  })

  it('REJECTS a missing or wrongly-typed evidenceQuote', async () => {
    const { evidenceQuote, ...without } = SIGNAL
    void evidenceQuote
    await expect(run({ signals: [without] }).p)
      .rejects.toThrow(/evidenceQuote that is not present \(string or null\)/)
    await expect(run({ signals: [{ ...SIGNAL, evidenceQuote: 5 }] }).p)
      .rejects.toThrow(/evidenceQuote that is not a string or null/)
  })

  it('NEVER reproduces raw model content in an error', async () => {
    const secret = 'CONFIDENTIAL-QUOTE-5521'
    const err = await run({ signals: [{ ...SIGNAL, description: secret, signalType: 'pricing' }] })
      .p.catch((e: Error) => e)
    expect(String((err as Error).message)).not.toContain(secret)
  })

  it('calls messages.create exactly once — no hidden corrective re-ask', async () => {
    const bad = run({ signals: [{ ...SIGNAL, magnitude: 'huge' }] })
    await bad.p.catch(() => undefined)
    expect(bad.c.messages.create).toHaveBeenCalledTimes(1)
    const good = run({ signals: [SIGNAL] })
    await good.p
    expect(good.c.messages.create).toHaveBeenCalledTimes(1)
  })
})
