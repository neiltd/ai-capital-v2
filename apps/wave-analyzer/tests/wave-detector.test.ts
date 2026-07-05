import { describe, it, expect } from 'vitest'
import { detectWaves } from '../src/analysis/wave-detector.js'
import type { Pivot } from '../src/types.js'

// Textbook bullish 5-wave. Scores: W3-not-shortest ✓(+20), no-overlap ✓(+20),
// W2-retrace 60% ✓(+10), W4-retrace 37.5% ✓(+10), W3/W1=1.6 ✗, W5/W1=1.0 ✓(+10) → 70
const BULL_PIVOTS: Pivot[] = [
  { date: '2024-01-01', price: 100, type: 'low'  },
  { date: '2024-02-01', price: 150, type: 'high' },
  { date: '2024-03-01', price: 120, type: 'low'  },
  { date: '2024-04-01', price: 200, type: 'high' },
  { date: '2024-05-01', price: 170, type: 'low'  },
  { date: '2024-06-01', price: 220, type: 'high' },
]

describe('detectWaves', () => {
  it('returns empty result for fewer than 6 pivots', () => {
    const result = detectWaves(BULL_PIVOTS.slice(0, 5))
    expect(result.wavePivots).toHaveLength(0)
    expect(result.confidence).toBe(0)
    expect(result.currentWave).toBeNull()
  })

  it('labels a textbook bullish impulse with correct wave names', () => {
    const result = detectWaves(BULL_PIVOTS)
    expect(result.wavePivots.map(p => p.label)).toEqual(['1', '2', '3', '4', '5'])
    expect(result.waveDirection).toBe('up')
    expect(result.confidence).toBeGreaterThanOrEqual(60)
  })

  it('reduces confidence when wave 4 overlaps wave 1', () => {
    const overlapPivots: Pivot[] = [
      { date: '2024-01-01', price: 100, type: 'low'  },
      { date: '2024-02-01', price: 150, type: 'high' },
      { date: '2024-03-01', price: 120, type: 'low'  },
      { date: '2024-04-01', price: 200, type: 'high' },
      { date: '2024-05-01', price: 140, type: 'low'  }, // overlap: 140 < 150
      { date: '2024-06-01', price: 180, type: 'high' },
    ]
    expect(detectWaves(overlapPivots).confidence).toBeLessThan(detectWaves(BULL_PIVOTS).confidence)
  })

  it('detects A-B-C correction when pivot sequence matches', () => {
    // 6 pivots. Last 4: [high, low, high, low] forms an A-B-C correction.
    // aLen=60, bLen=25 (retrace 41.6%) ✓, cLen=60 (ratio 1.0) ✓ → score=40
    const corrPivots: Pivot[] = [
      { date: '2023-10-01', price: 80,  type: 'low'  },
      { date: '2023-11-01', price: 120, type: 'high' },
      { date: '2024-01-01', price: 200, type: 'high' }, // impulse top (last4[0])
      { date: '2024-03-01', price: 140, type: 'low'  }, // A end
      { date: '2024-04-01', price: 165, type: 'high' }, // B end
      { date: '2024-05-01', price: 105, type: 'low'  }, // C end
    ]
    const result = detectWaves(corrPivots)
    const labels = result.wavePivots.map(p => p.label)
    expect(labels).toContain('A')
    expect(labels).toContain('C')
  })

  it('fibChecks array has correct shape', () => {
    const result = detectWaves(BULL_PIVOTS)
    expect(result.fibChecks.length).toBeGreaterThan(0)
    result.fibChecks.forEach(fc => {
      expect(typeof fc.description).toBe('string')
      expect(typeof fc.actual).toBe('number')
      expect(typeof fc.pass).toBe('boolean')
    })
  })
})
