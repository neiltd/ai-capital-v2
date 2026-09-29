// D3-B2: untrusted tool output is validated before it becomes a MacroRegime.
//
// The tool schema asks for `keyIndicators: string[]`. A 2026-09-29 run returned
// a bare string; the old code cast the tool input straight to the declared shape,
// `insertRegime` persisted it, and the run died two stages later inside
// `propagation-analyzer.ts:68` on `regime.keyIndicators.join is not a function`.
import { describe, it, expect } from 'vitest'
import { validatedRegimeInput } from '../src/analysis/regime-analyzer.js'

const VALID = {
  regime: 'late-cycle expansion',
  confidence: 'medium',
  rationale: 'Breadth narrowing while liquidity stays ample.',
  keyIndicators: ['2s10s re-steepening', 'HY spreads +40bp'],
  affectedTickers: ['NVDA', 'AVGO'],
  thailandRead: 'SET flows mildly negative.',
}

describe('D3-B2: analyzeRegime tool-response boundary', () => {
  it('passes a valid response through unchanged in shape and value', () => {
    const out = validatedRegimeInput(VALID)
    expect(out).toEqual(VALID)
    expect(Array.isArray(out.keyIndicators)).toBe(true)
  })

  it('accepts a response with thailandRead absent', () => {
    const { thailandRead, ...rest } = VALID
    void thailandRead
    expect(validatedRegimeInput(rest).thailandRead).toBeUndefined()
  })

  it('REJECTS keyIndicators supplied as a string — the exact production failure', () => {
    expect(() => validatedRegimeInput({ ...VALID, keyIndicators: '2s10s re-steepening' }))
      .toThrow(/keyIndicators that is not an array of strings/)
  })

  it('rejects keyIndicators containing a non-string member', () => {
    expect(() => validatedRegimeInput({ ...VALID, keyIndicators: ['ok', 42] }))
      .toThrow(/keyIndicators\[1\] that is not a string/)
  })

  it('rejects affectedTickers supplied as a non-array', () => {
    expect(() => validatedRegimeInput({ ...VALID, affectedTickers: { a: 'NVDA' } }))
      .toThrow(/affectedTickers that is not an array of strings/)
  })

  it('rejects an invalid confidence', () => {
    expect(() => validatedRegimeInput({ ...VALID, confidence: 'very high' }))
      .toThrow(/confidence that is not one of high, medium, low/)
  })

  it('rejects an empty regime and an empty rationale', () => {
    expect(() => validatedRegimeInput({ ...VALID, regime: '' })).toThrow(/regime/)
    expect(() => validatedRegimeInput({ ...VALID, rationale: '' })).toThrow(/rationale/)
  })

  it('rejects a non-object tool input', () => {
    expect(() => validatedRegimeInput(null)).toThrow(/not an object/)
    expect(() => validatedRegimeInput(['a'])).toThrow(/not an object/)
  })

  it('NEVER puts the raw model response in the error', () => {
    // The rationale reasons over real holdings; an error that echoed it would
    // copy that into logs, launchd output and pipeline_runs rows.
    const secret = 'CONFIDENTIAL-THESIS-7741'
    const err = (() => {
      try { validatedRegimeInput({ ...VALID, rationale: secret, keyIndicators: 'x' }); return null }
      catch (e) { return e as Error }
    })()
    expect(err).not.toBeNull()
    expect(err?.message).not.toContain(secret)
    expect(JSON.stringify(err)).not.toContain(secret)
  })
})
