import { describe, it, expect } from 'vitest'
import { formatWorldIntel, type WorldIntelContext } from './regime-analyzer.js'

// THE INVARIANT: absence of events under incomplete coverage is MISSING
// evidence, never evidence of calm. On 2026-08-29 this function returned
// "No significant world intelligence events." unconditionally, while ACLED was
// entitlement-restricted and GDELT unreachable — a false statement handed
// straight to the model as if it were a quiet geopolitical backdrop.

const evt = (title: string) => ({
  title, summary: 's', eventType: 'conflict',
  severity: 5, escalationPotential: 0.9, marketRelevance: 0.9, countries: ['XX'],
})
const ctx = (o: Partial<WorldIntelContext>): WorldIntelContext =>
  ({ marketEvents: [], worldEvents: [], ...o })

const COMPLETE = { complete: true,  summary: 'complete', caveat: null, sources: [] }
const DEGRADED = { complete: false, summary: 'degraded',
  caveat: 'events may be MISSING rather than absent — acled: restricted by entitlement', sources: [] }

describe('world-intel coverage cannot be read as calm', () => {
  it('no events + INCOMPLETE coverage does not claim there were no events', () => {
    const out = formatWorldIntel(ctx({ coverage: DEGRADED }))
    expect(out).not.toMatch(/^No significant world intelligence events\.$/)
    expect(out).toMatch(/COVERAGE INCOMPLETE/)
    expect(out).toMatch(/MISSING evidence/)
    expect(out).toMatch(/not as evidence of a calm/)
    expect(out).toMatch(/do not raise confidence/i)
    expect(out).toContain('acled')
  })

  it('no events + UNKNOWN coverage (no record at all) is treated as incomplete', () => {
    const out = formatWorldIntel(ctx({}))          // coverage undefined
    expect(out).toMatch(/COVERAGE INCOMPLETE/)
    expect(out).toMatch(/coverage is UNKNOWN/)
  })

  it('no events + COMPLETE coverage may state the absence plainly', () => {
    const out = formatWorldIntel(ctx({ coverage: COMPLETE }))
    expect(out).toMatch(/No significant world intelligence events were reported/)
    expect(out).toMatch(/coverage was complete/)
    expect(out).not.toMatch(/INCOMPLETE/)
  })

  it('events present + incomplete coverage are labelled a PARTIAL view', () => {
    const out = formatWorldIntel(ctx({ worldEvents: [evt('Border clash')], coverage: DEGRADED }))
    expect(out).toMatch(/PARTIAL view/)
    expect(out).toContain('Border clash')
    // the caveat must come first, so it cannot be missed below the event list
    expect(out.indexOf('PARTIAL view')).toBeLessThan(out.indexOf('Border clash'))
  })

  it('events present + complete coverage carry no caveat', () => {
    const out = formatWorldIntel(ctx({ worldEvents: [evt('Border clash')], coverage: COMPLETE }))
    expect(out).not.toMatch(/INCOMPLETE|PARTIAL/)
    expect(out).toContain('Border clash')
  })
})
