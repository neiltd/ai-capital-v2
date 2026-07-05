import { describe, it, expect } from 'vitest'
import { parseSynthesisLegs } from './cli-brainstorm.js'

describe('parseSynthesisLegs', () => {
  it('extracts legs from a structured response', () => {
    const text = `
Leg 1: AI royalty volume expansion
  Thesis: Hyperscaler design win cycle drives unit volume
  Evidence: Q3 FY26 transcript — royalty revenue up 37% YoY
  Weakens if: Custom RISC-V adoption exceeds 15%

Leg 2: v9 architecture pricing power
  Thesis: Mandatory v9 migration adds royalty premium per chip
  Evidence: Analyst day 2025 — confirmed v9 ASP uplift of 8-12%
  Weakens if: Hyperscalers negotiate exemptions at volume
`
    const legs = parseSynthesisLegs(text)
    expect(legs).toHaveLength(2)
    expect(legs[0]).toContain('AI royalty volume expansion')
    expect(legs[1]).toContain('v9 architecture pricing power')
  })

  it('returns a single leg when no numbered format present', () => {
    const text = 'ARM benefits from AI chip proliferation because every new accelerator uses ARM ISA.'
    const legs = parseSynthesisLegs(text)
    expect(legs).toHaveLength(1)
    expect(legs[0]).toBe(text.trim())
  })

  it('handles empty string gracefully', () => {
    const legs = parseSynthesisLegs('')
    expect(legs).toHaveLength(0)
  })
})
