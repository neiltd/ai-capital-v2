import { describe, it, expect } from 'vitest'
import { parseCsv } from '../../src/csv.js'
import { addDecimals, decimalOrNull } from '../../src/decimal.js'

// Lossless primitives, MOVED VERBATIM out of tests/unit/archive.test.ts.
//
// These assertions depend on nothing but the parser, yet they previously sat in
// the same file as the real-archive evidence — so a portable, data-free property
// was hostage to a private CSV. Nothing here is weakened; the block is unchanged
// apart from its location and imports.

describe('lossless primitives', () => {
  it('parses quoted commas and escaped quotes', () => {
    expect(parseCsv('a,b\n"x,y","say ""hi"""\n')).toEqual([['a','b'], ['x,y','say "hi"']])
  })

  it('never round-trips decimals through JavaScript number', () => {
    expect(decimalOrNull('12345678901234567890.123456789')).toBe('12345678901234567890.123456789')
    expect(addDecimals(['0.1','0.2','-0.03'])).toBe('0.27')
  })
})
