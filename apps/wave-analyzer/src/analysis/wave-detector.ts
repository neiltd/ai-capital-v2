import type { Pivot, WavePivot, FibCheck } from '../types.js'

export interface DetectionResult {
  wavePivots:     WavePivot[]
  currentWave:    string | null
  waveDirection:  'up' | 'down' | null
  confidence:     number
  fibChecks:      FibCheck[]
}

const EMPTY: DetectionResult = {
  wavePivots: [], currentWave: null, waveDirection: null, confidence: 0, fibChecks: [],
}

function scoreImpulse(
  pivots: Pivot[],       // exactly 6 pivots
  dir: 'up' | 'down',
): { score: number } & DetectionResult {
  if (pivots.length < 6) return { score: -1, ...EMPTY }
  const expected: Array<'high' | 'low'> = dir === 'up'
    ? ['low', 'high', 'low', 'high', 'low', 'high']
    : ['high', 'low', 'high', 'low', 'high', 'low']

  for (let i = 0; i < 6; i++) {
    if (pivots[i].type !== expected[i]) return { score: -1, ...EMPTY }
  }

  const p  = pivots.map(v => v.price)
  const w1 = Math.abs(p[1] - p[0])
  const w2 = Math.abs(p[2] - p[1])
  const w3 = Math.abs(p[3] - p[2])
  const w4 = Math.abs(p[4] - p[3])
  const w5 = Math.abs(p[5] - p[4])

  let score = 0
  const fibChecks: FibCheck[] = []

  const w3NotShortest = w3 > Math.min(w1, w5)
  score += w3NotShortest ? 20 : 0
  fibChecks.push({ description: 'Wave 3 not shortest', actual: w3 / Math.min(w1, w5), expectedRange: '>1.0', pass: w3NotShortest })

  const noOverlap = dir === 'up' ? p[4] > p[1] : p[4] < p[1]
  score += noOverlap ? 20 : 0
  fibChecks.push({ description: 'Wave 4 no overlap with Wave 1', actual: Math.abs(p[4] - p[1]) / p[1], expectedRange: '>0', pass: noOverlap })

  const w2Retrace = w2 / w1
  const w2Pass = w2Retrace >= 0.382 && w2Retrace <= 1.0
  score += w2Pass ? 10 : 0
  fibChecks.push({ description: 'Wave 2 retracement', actual: w2Retrace, expectedRange: '38.2–100%', pass: w2Pass })

  const w4Retrace = w4 / w3
  const w4Pass = w4Retrace >= 0.236 && w4Retrace <= 0.618
  score += w4Pass ? 10 : 0
  fibChecks.push({ description: 'Wave 4 retracement', actual: w4Retrace, expectedRange: '23.6–61.8%', pass: w4Pass })

  const w3Extension = w3 / w1 >= 1.618
  score += w3Extension ? 10 : 0
  fibChecks.push({ description: 'Wave 3 extension (≥1.618×W1)', actual: w3 / w1, expectedRange: '≥1.618', pass: w3Extension })

  const w5Ratio = w5 / w1
  const w5Pass = w5Ratio >= 0.618 && w5Ratio <= 1.618
  score += w5Pass ? 10 : 0
  fibChecks.push({ description: 'Wave 5 length (61.8–161.8% of W1)', actual: w5Ratio, expectedRange: '61.8–161.8%', pass: w5Pass })

  const wavePivots: WavePivot[] = pivots.slice(1).map((piv, i) => ({
    date: piv.date, price: piv.price, label: String(i + 1),
  }))

  return { score, wavePivots, currentWave: '5', waveDirection: dir, confidence: score, fibChecks }
}

function scoreCorrection(pivots: Pivot[]): { score: number } & DetectionResult {
  if (pivots.length < 4) return { score: -1, ...EMPTY }
  const last4 = pivots.slice(-4)
  if (last4[0].type !== 'high') return { score: -1, ...EMPTY }

  const aLen = Math.abs(last4[1].price - last4[0].price)
  const bLen = Math.abs(last4[2].price - last4[1].price)
  const cLen = Math.abs(last4[3].price - last4[2].price)

  let score = 0
  const fibChecks: FibCheck[] = []

  const bRetrace = bLen / aLen
  const bPass = bRetrace >= 0.382 && bRetrace <= 0.786
  score += bPass ? 20 : 0
  fibChecks.push({ description: 'Wave B retracement of A', actual: bRetrace, expectedRange: '38.2–78.6%', pass: bPass })

  const cRatio = cLen / aLen
  const cPass = cRatio >= 0.8 && cRatio <= 1.2
  score += cPass ? 20 : 0
  fibChecks.push({ description: 'Wave C length (≈A)', actual: cRatio, expectedRange: '80–120%', pass: cPass })

  const wavePivots: WavePivot[] = [
    { date: last4[1].date, price: last4[1].price, label: 'A' },
    { date: last4[2].date, price: last4[2].price, label: 'B' },
    { date: last4[3].date, price: last4[3].price, label: 'C' },
  ]

  return { score, wavePivots, currentWave: 'C', waveDirection: 'down', confidence: score, fibChecks }
}

export function detectWaves(pivots: Pivot[]): DetectionResult {
  if (pivots.length < 6) return EMPTY

  let best: { score: number } & DetectionResult = { score: -1, ...EMPTY }

  const maxOffset = Math.min(3, pivots.length - 6)
  for (let offset = 0; offset <= maxOffset; offset++) {
    const slice = pivots.slice(pivots.length - 6 - offset, pivots.length - offset)
    const bull = scoreImpulse(slice, 'up')
    const bear = scoreImpulse(slice, 'down')
    if (bull.score > best.score) best = bull
    if (bear.score > best.score) best = bear
  }

  const corr = scoreCorrection(pivots)
  if (corr.score > best.score) best = corr

  return best.score >= 0
    ? { wavePivots: best.wavePivots, currentWave: best.currentWave, waveDirection: best.waveDirection, confidence: best.confidence, fibChecks: best.fibChecks }
    : EMPTY
}
