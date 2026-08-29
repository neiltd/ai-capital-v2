import { describe, it, expect } from 'vitest'
import { formatWorldIntel, type WorldIntelContext, type WorldCoverage } from './regime-analyzer.js'

// THE INVARIANT: absence or unreadability of world-intel is MISSING evidence,
// never evidence of a quiet world.
//
// Two defects this covers. `formatWorldIntel` once returned
// 'No significant world intelligence events.' unconditionally while ACLED was
// entitlement-restricted and GDELT unreachable. And the world section itself was
// rendered only `if (options.worldIntel)`, so a failed event load removed every
// coverage statement from the prompt — on a prompt that promised the feed would
// speak up when incomplete.

const evt = (title: string) => ({
  title, summary: 's', eventType: 'conflict',
  severity: 5, escalationPotential: 0.9, marketRelevance: 0.9, countries: ['XX'],
})
const events = (o: Partial<WorldIntelContext> = {}): WorldIntelContext =>
  ({ marketEvents: [], worldEvents: [], ...o })

const COMPLETE: WorldCoverage = { complete: true, summary: 'world-intel coverage complete', caveat: null, sources: [] }
const DEGRADED: WorldCoverage = {
  complete: false, summary: 'world-intel coverage degraded: acled restricted, gdelt unavailable',
  caveat: 'events may be MISSING rather than absent — acled: restricted by entitlement', sources: [],
}

/** The four combinations the rendered input must represent. */
describe('events and coverage are independent facts', () => {
  it('events available + coverage complete → plain, no caveat', () => {
    const out = formatWorldIntel(events({ worldEvents: [evt('Border clash')] }), COMPLETE)
    expect(out).toContain('Border clash')
    expect(out).not.toMatch(/INCOMPLETE|PARTIAL|MISSING/)
  })

  it('events available + coverage degraded → PARTIAL banner, before the events', () => {
    const out = formatWorldIntel(events({ worldEvents: [evt('Border clash')] }), DEGRADED)
    expect(out).toMatch(/PARTIAL view/)
    expect(out.indexOf('PARTIAL view')).toBeLessThan(out.indexOf('Border clash'))
  })

  it('events UNAVAILABLE + coverage known/degraded → explicit MISSING, naming the coverage', () => {
    const out = formatWorldIntel(undefined, DEGRADED)
    expect(out).toMatch(/EVENTS COULD NOT BE LOADED/)
    expect(out).toMatch(/MISSING evidence/)
    expect(out).toMatch(/not as evidence of a calm/)
    expect(out).toContain('acled')
  })

  it('events UNAVAILABLE + coverage UNKNOWN → explicit UNKNOWN, still never calm', () => {
    const out = formatWorldIntel(undefined, undefined)
    expect(out).toMatch(/EVENTS COULD NOT BE LOADED/)
    expect(out).toMatch(/Coverage: UNKNOWN/)
    expect(out).toMatch(/MISSING evidence/)
    expect(out).not.toMatch(/No significant world intelligence events/)
  })
})

describe('an empty event list may only be called quiet under complete coverage', () => {
  it('no events + complete coverage may state the absence plainly', () => {
    const out = formatWorldIntel(events(), COMPLETE)
    expect(out).toMatch(/No significant world intelligence events were reported/)
    expect(out).toMatch(/coverage was complete/)
  })

  it('no events + degraded coverage must NOT imply quiet', () => {
    const out = formatWorldIntel(events(), DEGRADED)
    expect(out).not.toMatch(/^No significant world intelligence events\.$/)
    expect(out).toMatch(/COVERAGE INCOMPLETE/)
    expect(out).toMatch(/MISSING evidence/)
    expect(out).toMatch(/do not raise confidence/i)
  })

  it('no events + UNKNOWN coverage is treated as incomplete, not complete', () => {
    const out = formatWorldIntel(events(), undefined)
    expect(out).toMatch(/COVERAGE INCOMPLETE/)
    expect(out).toMatch(/coverage is UNKNOWN/)
  })
})

// The rendered MODEL INPUT, not a helper return. The section used to be emitted
// only `if (options.worldIntel)`, so a caller that passed no options — the
// legacy standalone daemon does exactly that, and writes the same analysis.json —
// produced a prompt containing no world-intelligence section at all.
describe('no caller can produce a prompt with silent world coverage', () => {
  const capture = async (options: Record<string, unknown>) => {
    let prompt = ''
    const client = {
      messages: {
        create: async (req: { messages: Array<{ content: unknown }> }) => {
          prompt = JSON.stringify(req.messages) + JSON.stringify((req as { system?: unknown }).system ?? '')
          return { content: [{ type: 'tool_use', name: 'classify_macro_regime', input: {
            regime: 'neutral', confidence: 'low', rationale: 'r',
            keyIndicators: [], affectedTickers: [], thailandRead: 't',
          } }] }
        },
      },
    }
    const { analyzeRegime } = await import('./regime-analyzer.js')
    await analyzeRegime([], { client: client as never, ...options })
    return prompt
  }

  it('analyzeRegime(health) with NO options still states coverage', async () => {
    const prompt = await capture({})
    expect(prompt).toContain('## World Intelligence')
    expect(prompt).toMatch(/EVENTS COULD NOT BE LOADED/)
    expect(prompt).toMatch(/Coverage: UNKNOWN/)
    expect(prompt).toMatch(/MISSING evidence/)
  })

  it('coverage present but events missing still reaches the prompt', async () => {
    const prompt = await capture({ worldCoverage: DEGRADED })
    expect(prompt).toContain('## World Intelligence')
    expect(prompt).toContain('acled')
    expect(prompt).toMatch(/not as evidence of a calm/)
  })

  it('the prompt no longer promises the feed announces its own incompleteness', async () => {
    const prompt = await capture({})
    expect(prompt).not.toMatch(/says so when it is/)
    // JSON-stringified, so newlines are escaped — assert on the words, not layout.
    expect(prompt).toContain('MISSING EVIDENCE')
    expect(prompt).toContain('quiet world')
  })
})
