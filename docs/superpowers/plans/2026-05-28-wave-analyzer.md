# Wave Analyzer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `wave-analyzer` — a new standalone service that fetches 2yr OHLCV from Yahoo Finance for Gold, a fixed watchlist, and the top-N most-active US stocks, runs zigzag pivot detection + Elliott Wave labeling, and surfaces results at `/capital/waves` (grid) and `/capital/waves/[ticker]` (full chart + Fib table) in `unified-platform`.

**Architecture:** New standalone TypeScript project `wave-analyzer/` (same scaffold as `macro-asset-monitor`). Runs `npm run wave` in `daily.sh` as step 3. Writes `data/waves.json`. `unified-platform` reads this file at render time via a server component; the detail page uses TradingView `lightweight-charts` in a `'use client'` component for the candlestick chart.

**Tech Stack:** TypeScript + tsx + vitest (wave-analyzer), Next.js 14 server components + `lightweight-charts` v4 (unified-platform).

---

## File Map

**New project — `wave-analyzer/`**
- `package.json` — scripts: wave, test
- `tsconfig.json` — ES2022 NodeNext strict
- `.gitignore` — node_modules/, data/, dist/, .env
- `.env` — WATCHLIST_TICKERS, SCREENER_COUNT
- `src/types.ts` — Candle, Pivot, WavePivot, FibCheck, WaveAsset, WavesJSON, WaveSource
- `src/fetchers/screener-fetcher.ts` — fetchMostActiveScreener(count) → string[]
- `src/fetchers/ohlcv-fetcher.ts` — fetchOHLCV(ticker) → Candle[] | null
- `src/analysis/zigzag.ts` — computeZigzag(candles, threshold) → Pivot[]
- `src/analysis/wave-detector.ts` — detectWaves(pivots) → DetectionResult
- `src/exporter.ts` — buildWaveAssets() + exportWaves(outputPath)
- `src/cli/cli-wave.ts` — entry point
- `tests/screener-fetcher.test.ts`
- `tests/ohlcv-fetcher.test.ts`
- `tests/zigzag.test.ts`
- `tests/wave-detector.test.ts`
- `tests/exporter.test.ts`

**Modified — `unified-platform/`**
- `src/types.ts` — append WaveSource, Candle, Pivot, WavePivot, FibCheck, WaveAsset, WavesJSON
- `src/lib/data.ts` — add readWaves()
- `src/components/capital/Sidebar.tsx` — add Waves nav entry
- `src/components/capital/WaveCard.tsx` — new mini card with SVG sparkline
- `src/components/capital/WaveChart.tsx` — new client component, lightweight-charts
- `src/app/capital/waves/page.tsx` — new grid overview
- `src/app/capital/waves/[ticker]/page.tsx` — new detail page

**Modified — root**
- `daily.sh` — add step 3, renumber 1–11

---

### Task 1: Project scaffold

**Files:**
- Create: `wave-analyzer/package.json`
- Create: `wave-analyzer/tsconfig.json`
- Create: `wave-analyzer/.gitignore`
- Create: `wave-analyzer/.env`
- Create: `wave-analyzer/src/types.ts`

- [ ] **Step 1: Create project directory and scaffold files**

```bash
mkdir -p wave-analyzer/src/fetchers wave-analyzer/src/analysis wave-analyzer/src/cli wave-analyzer/tests wave-analyzer/data
```

- [ ] **Step 2: Write `wave-analyzer/package.json`**

```json
{
  "name": "wave-analyzer",
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "wave":       "tsx src/cli/cli-wave.ts",
    "test":       "vitest run",
    "test:watch": "vitest"
  },
  "dependencies": {
    "dotenv": "^16.0.0"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "tsx":         "^4.0.0",
    "typescript":  "^5.0.0",
    "vitest":      "^3.0.0"
  }
}
```

- [ ] **Step 3: Write `wave-analyzer/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "outDir": "dist",
    "rootDir": "src",
    "esModuleInterop": true,
    "allowSyntheticDefaultImports": true,
    "resolveJsonModule": true,
    "skipLibCheck": true,
    "types": ["vitest/globals"]
  },
  "include": ["src/**/*", "tests/**/*"],
  "exclude": ["node_modules", "dist"]
}
```

- [ ] **Step 4: Write `wave-analyzer/.gitignore`**

```
node_modules/
data/
dist/
.env
*.db
*.db-shm
*.db-wal
```

- [ ] **Step 5: Write `wave-analyzer/.env`**

```
WATCHLIST_TICKERS=NVDA,AAPL,TSLA,META,AMZN
SCREENER_COUNT=20
```

- [ ] **Step 6: Write `wave-analyzer/src/types.ts`**

```typescript
export type WaveSource = 'macro' | 'watchlist' | 'screener'

export interface Candle {
  date: string   // YYYY-MM-DD
  open: number
  high: number
  low: number
  close: number
  volume: number
}

export interface Pivot {
  date: string
  price: number
  type: 'high' | 'low'
}

export interface WavePivot {
  date: string
  price: number
  label: string  // "1" | "2" | "3" | "4" | "5" | "A" | "B" | "C"
}

export interface FibCheck {
  description: string
  actual: number
  expectedRange: string
  pass: boolean
}

export interface WaveAsset {
  ticker: string
  label: string
  source: WaveSource
  candles: Candle[]
  pivots: Pivot[]
  wavePivots: WavePivot[]
  currentWave: string | null
  waveDirection: 'up' | 'down' | null
  confidence: number          // 0–100
  fibChecks: FibCheck[]
}

export interface WavesJSON {
  exportedAt: string
  asOf: string
  assets: WaveAsset[]
}
```

- [ ] **Step 7: Install dependencies**

```bash
cd wave-analyzer && npm install
```

Expected: `node_modules/` created, no errors.

- [ ] **Step 8: Commit**

```bash
git add wave-analyzer/
git commit -m "feat(wave-analyzer): project scaffold, types"
```

---

### Task 2: Screener fetcher

**Files:**
- Create: `wave-analyzer/src/fetchers/screener-fetcher.ts`
- Create: `wave-analyzer/tests/screener-fetcher.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `wave-analyzer/tests/screener-fetcher.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fetchMostActiveScreener } from '../src/fetchers/screener-fetcher.js'

describe('fetchMostActiveScreener', () => {
  beforeEach(() => { vi.restoreAllMocks() })

  it('extracts ticker symbols from screener response', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({
        finance: {
          result: [{
            quotes: [
              { symbol: 'NVDA' },
              { symbol: 'AAPL' },
              { symbol: 'TSLA' },
            ]
          }]
        }
      }),
    } as Response)

    const tickers = await fetchMostActiveScreener(3)
    expect(tickers).toEqual(['NVDA', 'AAPL', 'TSLA'])
  })

  it('returns empty array on HTTP error', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue({ ok: false, status: 429 } as Response)
    const tickers = await fetchMostActiveScreener(10)
    expect(tickers).toEqual([])
  })

  it('returns empty array when result is null', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ finance: { result: null } }),
    } as Response)
    const tickers = await fetchMostActiveScreener(10)
    expect(tickers).toEqual([])
  })

  it('returns empty array on fetch exception', async () => {
    vi.spyOn(global, 'fetch').mockRejectedValue(new Error('network'))
    const tickers = await fetchMostActiveScreener(10)
    expect(tickers).toEqual([])
  })
})
```

- [ ] **Step 2: Run tests — expect 4 failures**

```bash
cd wave-analyzer && npm test -- tests/screener-fetcher.test.ts
```

Expected: FAIL — `fetchMostActiveScreener` not found.

- [ ] **Step 3: Write `wave-analyzer/src/fetchers/screener-fetcher.ts`**

```typescript
export async function fetchMostActiveScreener(count: number): Promise<string[]> {
  const url = `https://query1.finance.yahoo.com/v1/finance/screener/predefined/saved?formatted=false&lang=en-US&region=US&scrIds=most_actives&count=${count}&start=0`
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } })
    if (!res.ok) {
      console.warn(`[screener] HTTP ${res.status}`)
      return []
    }
    const data = await res.json() as {
      finance: { result: Array<{ quotes: Array<{ symbol: string }> }> | null }
    }
    return (data.finance.result?.[0]?.quotes ?? []).map(q => q.symbol)
  } catch (err) {
    console.warn('[screener] fetch error', err)
    return []
  }
}
```

- [ ] **Step 4: Run tests — expect 4 passing**

```bash
cd wave-analyzer && npm test -- tests/screener-fetcher.test.ts
```

Expected: 4 passed.

- [ ] **Step 5: Commit**

```bash
git add wave-analyzer/src/fetchers/screener-fetcher.ts wave-analyzer/tests/screener-fetcher.test.ts
git commit -m "feat(wave-analyzer): screener fetcher"
```

---

### Task 3: OHLCV fetcher

**Files:**
- Create: `wave-analyzer/src/fetchers/ohlcv-fetcher.ts`
- Create: `wave-analyzer/tests/ohlcv-fetcher.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `wave-analyzer/tests/ohlcv-fetcher.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fetchOHLCV } from '../src/fetchers/ohlcv-fetcher.js'

const SAMPLE_RESPONSE = {
  chart: {
    result: [{
      timestamp: [1704067200, 1704153600, 1704240000],
      indicators: {
        quote: [{
          open:   [190.0, 192.0, null],
          high:   [195.0, 194.0, null],
          low:    [189.0, 191.0, null],
          close:  [193.0, 193.5, null],
          volume: [50_000_000, 48_000_000, null],
        }]
      }
    }]
  }
}

describe('fetchOHLCV', () => {
  beforeEach(() => { vi.restoreAllMocks() })

  it('extracts candles and filters null bars', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => SAMPLE_RESPONSE,
    } as Response)

    const candles = await fetchOHLCV('AAPL')
    expect(candles).not.toBeNull()
    expect(candles!.length).toBe(2)  // third bar is null, filtered out
    expect(candles![0].date).toBe('2024-01-01')
    expect(candles![0].open).toBe(190.0)
    expect(candles![0].high).toBe(195.0)
    expect(candles![0].low).toBe(189.0)
    expect(candles![0].close).toBe(193.0)
    expect(candles![0].volume).toBe(50_000_000)
  })

  it('returns null on HTTP error', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue({ ok: false, status: 429 } as Response)
    expect(await fetchOHLCV('AAPL')).toBeNull()
  })

  it('returns null when chart result is empty', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ chart: { result: null } }),
    } as Response)
    expect(await fetchOHLCV('AAPL')).toBeNull()
  })

  it('returns null on fetch exception', async () => {
    vi.spyOn(global, 'fetch').mockRejectedValue(new Error('network'))
    expect(await fetchOHLCV('AAPL')).toBeNull()
  })
})
```

- [ ] **Step 2: Run tests — expect 4 failures**

```bash
cd wave-analyzer && npm test -- tests/ohlcv-fetcher.test.ts
```

Expected: FAIL — `fetchOHLCV` not found.

- [ ] **Step 3: Write `wave-analyzer/src/fetchers/ohlcv-fetcher.ts`**

```typescript
import type { Candle } from '../types.js'

export async function fetchOHLCV(ticker: string): Promise<Candle[] | null> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&range=2y`
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } })
    if (!res.ok) {
      console.warn(`[ohlcv] ${ticker}: HTTP ${res.status}`)
      return null
    }
    const data = await res.json() as {
      chart: {
        result: Array<{
          timestamp: number[]
          indicators: {
            quote: Array<{
              open:   (number | null)[]
              high:   (number | null)[]
              low:    (number | null)[]
              close:  (number | null)[]
              volume: (number | null)[]
            }>
          }
        }> | null
      }
    }
    const result = data.chart.result?.[0]
    if (!result) return null

    const { timestamp, indicators } = result
    const q = indicators.quote[0]
    const candles: Candle[] = []

    for (let i = 0; i < timestamp.length; i++) {
      const o = q.open[i], h = q.high[i], l = q.low[i], c = q.close[i], v = q.volume[i]
      if (o == null || h == null || l == null || c == null || v == null) continue
      candles.push({
        date:   new Date(timestamp[i] * 1000).toISOString().slice(0, 10),
        open:   o, high: h, low: l, close: c, volume: v,
      })
    }
    return candles
  } catch (err) {
    console.warn(`[ohlcv] ${ticker}: fetch error`, err)
    return null
  }
}
```

- [ ] **Step 4: Run tests — expect 4 passing**

```bash
cd wave-analyzer && npm test -- tests/ohlcv-fetcher.test.ts
```

Expected: 4 passed.

- [ ] **Step 5: Commit**

```bash
git add wave-analyzer/src/fetchers/ohlcv-fetcher.ts wave-analyzer/tests/ohlcv-fetcher.test.ts
git commit -m "feat(wave-analyzer): OHLCV fetcher"
```

---

### Task 4: Zigzag pivot algorithm

**Files:**
- Create: `wave-analyzer/src/analysis/zigzag.ts`
- Create: `wave-analyzer/tests/zigzag.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `wave-analyzer/tests/zigzag.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { computeZigzag } from '../src/analysis/zigzag.js'
import type { Candle } from '../src/types.js'

function makeCandle(date: string, price: number): Candle {
  return { date, open: price * 0.998, high: price * 1.005, low: price * 0.995, close: price, volume: 1_000_000 }
}

describe('computeZigzag', () => {
  it('returns empty array for fewer than 2 candles', () => {
    expect(computeZigzag([makeCandle('2024-01-01', 100)], 0.05)).toEqual([])
  })

  it('detects a high pivot when price drops more than threshold', () => {
    // Peak at 120, then drops 5.8% to 113 — triggers HIGH pivot
    const candles = [
      makeCandle('2024-01-01', 100),
      makeCandle('2024-01-02', 108),
      makeCandle('2024-01-03', 115),
      makeCandle('2024-01-04', 120),  // peak: high = 120 * 1.005 = 120.6
      makeCandle('2024-01-05', 117),
      makeCandle('2024-01-06', 113),  // close=113 < 120.6 * 0.95 = 114.57 → HIGH pivot recorded
      makeCandle('2024-01-07', 109),
    ]
    const pivots = computeZigzag(candles, 0.05)
    expect(pivots.some(p => p.type === 'high')).toBe(true)
  })

  it('does not trigger pivot for move below threshold', () => {
    // Only a 2% drop — below 5% threshold, no confirmed pivot
    const candles = [
      makeCandle('2024-01-01', 100),
      makeCandle('2024-01-02', 104),
      makeCandle('2024-01-03', 102),  // ~1.9% drop from 104*1.005 — below threshold
    ]
    const pivots = computeZigzag(candles, 0.05)
    // Only the trailing unconfirmed pivot, no confirmed reversal
    expect(pivots.length).toBe(1)
  })

  it('produces alternating high/low pivot types', () => {
    const candles = [
      makeCandle('2024-01-01', 100),
      makeCandle('2024-01-02', 108),
      makeCandle('2024-01-03', 116),
      makeCandle('2024-01-04', 120),  // peak
      makeCandle('2024-01-05', 113),  // drop triggers HIGH
      makeCandle('2024-01-06', 107),
      makeCandle('2024-01-07', 100),  // trough: low = 99.5
      makeCandle('2024-01-08', 103),
      makeCandle('2024-01-09', 106),  // close=106 > 99.5*1.05=104.5 → LOW pivot recorded
    ]
    const pivots = computeZigzag(candles, 0.05)
    for (let i = 1; i < pivots.length; i++) {
      expect(pivots[i].type).not.toBe(pivots[i - 1].type)
    }
  })

  it('appends a trailing unconfirmed pivot at the last extreme index', () => {
    const candles = [
      makeCandle('2024-01-01', 100),
      makeCandle('2024-01-02', 110),
      makeCandle('2024-01-03', 120),
    ]
    const pivots = computeZigzag(candles, 0.05)
    expect(pivots.length).toBe(1)
    expect(pivots[0].date).toBe('2024-01-03')
  })
})
```

- [ ] **Step 2: Run tests — expect 4 failures**

```bash
cd wave-analyzer && npm test -- tests/zigzag.test.ts
```

Expected: FAIL — `computeZigzag` not found.

- [ ] **Step 3: Write `wave-analyzer/src/analysis/zigzag.ts`**

```typescript
import type { Candle, Pivot } from '../types.js'

export function computeZigzag(candles: Candle[], threshold: number): Pivot[] {
  if (candles.length < 2) return []

  const pivots: Pivot[] = []
  let dir: 1 | -1 = 1   // 1 = up (tracking highs), -1 = down (tracking lows)
  let extIdx = 0
  let extPrice = candles[0].close

  for (let i = 1; i < candles.length; i++) {
    const c = candles[i]
    if (dir === 1) {
      if (c.high > extPrice) {
        extPrice = c.high
        extIdx = i
      } else if (c.close < extPrice * (1 - threshold)) {
        pivots.push({ date: candles[extIdx].date, price: extPrice, type: 'high' })
        dir = -1
        extPrice = c.low
        extIdx = i
      }
    } else {
      if (c.low < extPrice) {
        extPrice = c.low
        extIdx = i
      } else if (c.close > extPrice * (1 + threshold)) {
        pivots.push({ date: candles[extIdx].date, price: extPrice, type: 'low' })
        dir = 1
        extPrice = c.high
        extIdx = i
      }
    }
  }

  // Trailing unconfirmed pivot at current extreme
  pivots.push({
    date:  candles[extIdx].date,
    price: extPrice,
    type:  dir === 1 ? 'high' : 'low',
  })

  return pivots
}
```

- [ ] **Step 4: Run tests — expect 4 passing**

```bash
cd wave-analyzer && npm test -- tests/zigzag.test.ts
```

Expected: 4 passed.

- [ ] **Step 5: Commit**

```bash
git add wave-analyzer/src/analysis/zigzag.ts wave-analyzer/tests/zigzag.test.ts
git commit -m "feat(wave-analyzer): zigzag pivot algorithm"
```

---

### Task 5: Elliott Wave detector

**Files:**
- Create: `wave-analyzer/src/analysis/wave-detector.ts`
- Create: `wave-analyzer/tests/wave-detector.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `wave-analyzer/tests/wave-detector.test.ts`:

```typescript
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
```

- [ ] **Step 2: Run tests — expect 5 failures**

```bash
cd wave-analyzer && npm test -- tests/wave-detector.test.ts
```

Expected: FAIL — `detectWaves` not found.

- [ ] **Step 3: Write `wave-analyzer/src/analysis/wave-detector.ts`**

```typescript
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
```

- [ ] **Step 4: Run tests — expect 5 passing**

```bash
cd wave-analyzer && npm test -- tests/wave-detector.test.ts
```

Expected: 5 passed.

- [ ] **Step 5: Commit**

```bash
git add wave-analyzer/src/analysis/wave-detector.ts wave-analyzer/tests/wave-detector.test.ts
git commit -m "feat(wave-analyzer): Elliott Wave detector with confidence scoring"
```

---

### Task 6: Exporter and CLI entry point

**Files:**
- Create: `wave-analyzer/src/exporter.ts`
- Create: `wave-analyzer/src/cli/cli-wave.ts`
- Create: `wave-analyzer/tests/exporter.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `wave-analyzer/tests/exporter.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

vi.mock('../src/fetchers/screener-fetcher.js', () => ({
  fetchMostActiveScreener: vi.fn(),
}))
vi.mock('../src/fetchers/ohlcv-fetcher.js', () => ({
  fetchOHLCV: vi.fn(),
}))

import { fetchMostActiveScreener } from '../src/fetchers/screener-fetcher.js'
import { fetchOHLCV } from '../src/fetchers/ohlcv-fetcher.js'
import { buildWaveAssets, exportWaves } from '../src/exporter.js'
import type { Candle } from '../src/types.js'

function makeCandles(n: number): Candle[] {
  return Array.from({ length: n }, (_, i) => ({
    date:   `2024-${String(Math.floor(i / 28) + 1).padStart(2, '0')}-${String((i % 28) + 1).padStart(2, '0')}`,
    open: 100 + i, high: 102 + i, low: 98 + i, close: 101 + i, volume: 1_000_000,
  }))
}

describe('buildWaveAssets', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    process.env.WATCHLIST_TICKERS = 'AAPL'
    process.env.SCREENER_COUNT = '1'
  })

  it('includes Gold, watchlist, and screener results', async () => {
    ;(fetchMostActiveScreener as any).mockResolvedValue(['NVDA'])
    ;(fetchOHLCV as any).mockResolvedValue(makeCandles(25))

    const assets = await buildWaveAssets()
    const tickers = assets.map(a => a.ticker)
    expect(tickers).toContain('GC=F')
    expect(tickers).toContain('AAPL')
    expect(tickers).toContain('NVDA')
  })

  it('deduplicates tickers across sources', async () => {
    process.env.WATCHLIST_TICKERS = 'NVDA'  // same as screener result
    ;(fetchMostActiveScreener as any).mockResolvedValue(['NVDA'])
    ;(fetchOHLCV as any).mockResolvedValue(makeCandles(25))

    const assets = await buildWaveAssets()
    const nvda = assets.filter(a => a.ticker === 'NVDA')
    expect(nvda).toHaveLength(1)
  })

  it('skips tickers with insufficient candle data', async () => {
    ;(fetchMostActiveScreener as any).mockResolvedValue(['NVDA'])
    ;(fetchOHLCV as any).mockImplementation((ticker: string) =>
      ticker === 'NVDA' ? null : makeCandles(25)
    )

    const assets = await buildWaveAssets()
    expect(assets.find(a => a.ticker === 'NVDA')).toBeUndefined()
  })
})

describe('exportWaves', () => {
  it('writes valid waves.json to the output path', async () => {
    ;(fetchMostActiveScreener as any).mockResolvedValue([])
    ;(fetchOHLCV as any).mockResolvedValue(makeCandles(25))
    process.env.WATCHLIST_TICKERS = ''
    process.env.SCREENER_COUNT = '0'

    const outPath = join(tmpdir(), `waves-test-${Date.now()}.json`)
    await exportWaves(outPath)

    expect(existsSync(outPath)).toBe(true)
    const parsed = JSON.parse(readFileSync(outPath, 'utf-8'))
    expect(parsed).toHaveProperty('exportedAt')
    expect(parsed).toHaveProperty('asOf')
    expect(Array.isArray(parsed.assets)).toBe(true)
  })
})
```

- [ ] **Step 2: Run tests — expect failures**

```bash
cd wave-analyzer && npm test -- tests/exporter.test.ts
```

Expected: FAIL — `buildWaveAssets` not found.

- [ ] **Step 3: Write `wave-analyzer/src/exporter.ts`**

```typescript
import 'dotenv/config'
import { writeFileSync, mkdirSync } from 'fs'
import { dirname } from 'path'
import { fetchMostActiveScreener } from './fetchers/screener-fetcher.js'
import { fetchOHLCV } from './fetchers/ohlcv-fetcher.js'
import { computeZigzag } from './analysis/zigzag.js'
import { detectWaves } from './analysis/wave-detector.js'
import type { WaveAsset, WaveSource, WavesJSON } from './types.js'

const GOLD_TICKER = 'GC=F'
const GOLD_LABEL  = 'Gold'

export async function buildWaveAssets(): Promise<WaveAsset[]> {
  const screenerCount = parseInt(process.env.SCREENER_COUNT ?? '20', 10)
  const watchlist = (process.env.WATCHLIST_TICKERS ?? '')
    .split(',').map(t => t.trim()).filter(Boolean)

  const screenerTickers = await fetchMostActiveScreener(screenerCount)

  const seen   = new Set<string>()
  const toFetch: Array<{ ticker: string; label: string; source: WaveSource }> = []

  const add = (ticker: string, label: string, source: WaveSource) => {
    if (seen.has(ticker)) return
    seen.add(ticker)
    toFetch.push({ ticker, label, source })
  }

  add(GOLD_TICKER, GOLD_LABEL, 'macro')
  for (const t of watchlist) add(t, t, 'watchlist')
  for (const t of screenerTickers) add(t, t, 'screener')

  const results = await Promise.all(toFetch.map(async ({ ticker, label, source }) => {
    const candles = await fetchOHLCV(ticker)
    if (!candles || candles.length < 20) {
      console.warn(`[wave] ${ticker}: insufficient data, skipping`)
      return null
    }
    const threshold = source === 'macro' ? 0.03 : 0.05
    const pivots    = computeZigzag(candles, threshold)
    const { wavePivots, currentWave, waveDirection, confidence, fibChecks } = detectWaves(pivots)
    const asset: WaveAsset = {
      ticker, label, source, candles, pivots,
      wavePivots, currentWave, waveDirection, confidence, fibChecks,
    }
    return asset
  }))

  return results.filter((r): r is WaveAsset => r !== null)
}

export async function exportWaves(outputPath: string): Promise<void> {
  const assets   = await buildWaveAssets()
  const allDates = assets.flatMap(a => a.candles.map(c => c.date)).sort()
  const asOf     = allDates.at(-1) ?? new Date().toISOString().slice(0, 10)

  const output: WavesJSON = {
    exportedAt: new Date().toISOString(),
    asOf,
    assets,
  }

  mkdirSync(dirname(outputPath), { recursive: true })
  writeFileSync(outputPath, JSON.stringify(output, null, 2))
  console.log(`[wave] Wrote ${assets.length} assets to ${outputPath}`)
}
```

- [ ] **Step 4: Write `wave-analyzer/src/cli/cli-wave.ts`**

```typescript
import 'dotenv/config'
import { join } from 'path'
import { exportWaves } from '../exporter.js'

const OUTPUT_PATH = join(process.cwd(), 'data/waves.json')

exportWaves(OUTPUT_PATH).catch(err => { console.error(err); process.exit(1) })
```

- [ ] **Step 5: Run all tests**

```bash
cd wave-analyzer && npm test
```

Expected: 17 passed (4+4+4+5 = 17, plus 4 exporter = well, let's count: 4+4+4+5+4 = 21 total).

- [ ] **Step 6: Smoke test (optional — requires network)**

```bash
cd wave-analyzer && WATCHLIST_TICKERS=AAPL SCREENER_COUNT=3 npm run wave
```

Expected: `data/waves.json` written, prints asset count.

- [ ] **Step 7: Commit**

```bash
git add wave-analyzer/src/exporter.ts wave-analyzer/src/cli/cli-wave.ts wave-analyzer/tests/exporter.test.ts
git commit -m "feat(wave-analyzer): exporter and CLI — writes waves.json"
```

---

### Task 7: unified-platform types and readWaves

**Files:**
- Modify: `unified-platform/src/types.ts` (append)
- Modify: `unified-platform/src/lib/data.ts` (append readWaves)

- [ ] **Step 1: Append wave types to `unified-platform/src/types.ts`**

Add to the end of the file:

```typescript
// --- Wave Analyzer types ---

export type WaveSource = 'macro' | 'watchlist' | 'screener'

export interface Candle {
  date: string
  open: number
  high: number
  low: number
  close: number
  volume: number
}

export interface Pivot {
  date: string
  price: number
  type: 'high' | 'low'
}

export interface WavePivot {
  date: string
  price: number
  label: string
}

export interface FibCheck {
  description: string
  actual: number
  expectedRange: string
  pass: boolean
}

export interface WaveAsset {
  ticker: string
  label: string
  source: WaveSource
  candles: Candle[]
  pivots: Pivot[]
  wavePivots: WavePivot[]
  currentWave: string | null
  waveDirection: 'up' | 'down' | null
  confidence: number
  fibChecks: FibCheck[]
}

export interface WavesJSON {
  exportedAt: string
  asOf: string
  assets: WaveAsset[]
}
```

- [ ] **Step 2: Add `readWaves` to `unified-platform/src/lib/data.ts`**

Add to the import line at the top — append `WavesJSON` to the type imports:

```typescript
import type { AnalysisJSON, SimulationJSON, GraphJSON, StockIntelJSON, WorldIntelJSON, DiscoveryJSON, MacroJSON, WavesJSON } from '@/types'
```

Then append at the end of the file:

```typescript
export function readWaves(): WavesJSON | null {
  const filePath = path.join(dataRoot(), 'wave-analyzer/data/waves.json')
  try {
    return readJSON<WavesJSON>(filePath)
  } catch {
    return null
  }
}
```

- [ ] **Step 3: Verify TypeScript compiles with no errors**

```bash
cd unified-platform && npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add unified-platform/src/types.ts unified-platform/src/lib/data.ts
git commit -m "feat(unified-platform): wave analyzer types and readWaves reader"
```

---

### Task 8: WaveCard component, grid overview page, and Sidebar

**Files:**
- Create: `unified-platform/src/components/capital/WaveCard.tsx`
- Create: `unified-platform/src/app/capital/waves/page.tsx`
- Modify: `unified-platform/src/components/capital/Sidebar.tsx`

- [ ] **Step 1: Create `unified-platform/src/components/capital/WaveCard.tsx`**

```tsx
import Link from 'next/link'
import type { WaveAsset } from '@/types'

function waveColor(w: string | null): string {
  if (['1', '3', '5'].includes(w ?? '')) return '#22c55e'
  if (['2', '4'].includes(w ?? ''))       return '#f59e0b'
  if (w)                                  return '#ef4444'
  return '#8a8f98'
}

function confColor(c: number): string {
  if (c >= 75) return '#22c55e'
  if (c >= 50) return '#f59e0b'
  return '#ef4444'
}

export function WaveCard({ asset }: { asset: WaveAsset }) {
  const { ticker, label, source, wavePivots, currentWave, waveDirection, confidence } = asset

  let sparkPoints: string | null = null
  if (wavePivots.length >= 2) {
    const prices = wavePivots.map(p => p.price)
    const minP = Math.min(...prices), maxP = Math.max(...prices)
    const range = maxP - minP || 1
    sparkPoints = wavePivots.map((p, i) => {
      const x = (i / (wavePivots.length - 1)) * 100
      const y = 36 - ((p.price - minP) / range) * 36
      return `${x.toFixed(1)},${y.toFixed(1)}`
    }).join(' ')
  }

  const wLabel = currentWave
    ? `Wave ${currentWave} ${waveDirection === 'up' ? '↑' : '↓'}`
    : 'No count'

  return (
    <Link href={`/capital/waves/${encodeURIComponent(ticker)}`}
      className="block bg-[#0f1011] border border-[#23252a] rounded-[8px] p-3 hover:border-[#3a3d45] transition-colors">
      <div className="flex items-center justify-between mb-2">
        <div>
          <span className="text-[13px] font-semibold text-[#f7f8f8]">{ticker}</span>
          {label !== ticker && (
            <span className="ml-1.5 text-[10px] text-[#8a8f98]">{label}</span>
          )}
        </div>
        <span className="text-[9px] text-[#62666d] border border-[#23252a] rounded px-1.5 py-0.5">
          {source}
        </span>
      </div>

      {sparkPoints ? (
        <svg viewBox="0 0 100 36" className="w-full h-8 mb-2">
          <polyline points={sparkPoints} fill="none" stroke="#5e6ad2" strokeWidth="1.5" strokeLinejoin="round"/>
        </svg>
      ) : (
        <div className="w-full h-8 mb-2 flex items-center justify-center">
          <span className="text-[10px] text-[#62666d]">no data</span>
        </div>
      )}

      <div className="flex items-center gap-1.5 flex-wrap">
        <span className="text-[10px] font-medium rounded px-1.5 py-0.5"
          style={{ background: waveColor(currentWave) + '22', color: waveColor(currentWave) }}>
          {wLabel}
        </span>
        {confidence > 0 && (
          <span className="text-[10px] rounded px-1.5 py-0.5"
            style={{ background: confColor(confidence) + '22', color: confColor(confidence) }}>
            {confidence}%
          </span>
        )}
      </div>
    </Link>
  )
}
```

- [ ] **Step 2: Create `unified-platform/src/app/capital/waves/page.tsx`**

```tsx
import { readWaves } from '@/lib/data'
import { WaveCard } from '@/components/capital/WaveCard'

export const dynamic = 'force-dynamic'

export default async function WavesPage() {
  let data
  try { data = readWaves() } catch { data = null }

  if (!data) {
    return (
      <div className="p-6">
        <h1 className="text-[15px] font-semibold text-[#f7f8f8] mb-1">Wave Analysis</h1>
        <p className="text-sm text-[#8a8f98]">
          Wave data not available — run the daily pipeline.
        </p>
      </div>
    )
  }

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-5">
        <div>
          <h1 className="text-[15px] font-semibold text-[#f7f8f8]">Wave Analysis</h1>
          <p className="text-[11px] text-[#62666d] mt-0.5">
            as of {data.asOf} · {data.assets.length} assets
          </p>
        </div>
      </div>
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
        {data.assets.map(asset => (
          <WaveCard key={asset.ticker} asset={asset} />
        ))}
      </div>
    </div>
  )
}
```

- [ ] **Step 3: Add Waves nav entry to `unified-platform/src/components/capital/Sidebar.tsx`**

In the `NAV` array, add after the `macro` entry:

```tsx
{ href: '/capital/waves',     icon: '〜', label: 'Waves'     },
```

The full updated NAV array should be:

```tsx
const NAV = [
  { href: '/capital/briefing',  icon: '📋', label: 'Briefing'  },
  { href: '/capital/portfolio', icon: '💼', label: 'Portfolio' },
  { href: '/capital/discovery', icon: '✦',  label: 'Discovery' },
  { href: '/capital/thesis',    icon: '🧠', label: 'Thesis'    },
  { href: '/capital/graph',     icon: '🕸', label: 'Graph'     },
  { href: '/capital/macro',     icon: '📈', label: 'Macro'     },
  { href: '/capital/waves',     icon: '〜', label: 'Waves'     },
  { href: '/capital/ask',       icon: '💬', label: 'Ask'       },
]
```

- [ ] **Step 4: Verify TypeScript compiles**

```bash
cd unified-platform && npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add unified-platform/src/components/capital/WaveCard.tsx \
        unified-platform/src/app/capital/waves/page.tsx \
        unified-platform/src/components/capital/Sidebar.tsx
git commit -m "feat(unified-platform): wave grid overview page and WaveCard component"
```

---

### Task 9: WaveChart client component

**Files:**
- Modify: `unified-platform/package.json` (add lightweight-charts)
- Create: `unified-platform/src/components/capital/WaveChart.tsx`

- [ ] **Step 1: Install lightweight-charts**

```bash
cd unified-platform && npm install lightweight-charts@^4.2.0
```

Expected: `lightweight-charts` appears in `package.json` dependencies.

- [ ] **Step 2: Create `unified-platform/src/components/capital/WaveChart.tsx`**

```tsx
'use client'
import { useEffect, useRef } from 'react'
import type { WaveAsset } from '@/types'

export function WaveChart({ asset }: { asset: WaveAsset }) {
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!containerRef.current || asset.candles.length === 0) return

    let chart: any

    ;(async () => {
      const { createChart } = await import('lightweight-charts')
      if (!containerRef.current) return

      chart = createChart(containerRef.current, {
        width:  containerRef.current.clientWidth,
        height: 480,
        layout: {
          background: { color: '#0a0b0d' },
          textColor: '#8a8f98',
        },
        grid: {
          vertLines: { color: '#1a1c20' },
          horzLines: { color: '#1a1c20' },
        },
        timeScale:       { borderColor: '#23252a' },
        rightPriceScale: { borderColor: '#23252a' },
      })

      const candleSeries = chart.addCandlestickSeries({
        upColor:     '#22c55e',
        downColor:   '#ef4444',
        borderVisible: false,
        wickUpColor: '#22c55e',
        wickDownColor: '#ef4444',
      })
      candleSeries.setData(asset.candles.map(c => ({
        time: c.date, open: c.open, high: c.high, low: c.low, close: c.close,
      })))

      if (asset.wavePivots.length >= 2) {
        const lineSeries = chart.addLineSeries({
          color: '#5e6ad2', lineWidth: 1, lineStyle: 2,
        })
        lineSeries.setData(asset.wavePivots.map(p => ({ time: p.date, value: p.price })))

        candleSeries.setMarkers(asset.wavePivots.map(p => ({
          time:     p.date as any,
          position: ['2', '4', 'B'].includes(p.label) ? 'belowBar' : 'aboveBar',
          color:    ['2', '4', 'B'].includes(p.label) ? '#f59e0b' : '#5e6ad2',
          shape:    'circle',
          text:     p.label,
          size:     1,
        })))
      }

      const resize = () => {
        if (containerRef.current) chart?.applyOptions({ width: containerRef.current.clientWidth })
      }
      window.addEventListener('resize', resize)
      return () => window.removeEventListener('resize', resize)
    })()

    return () => { chart?.remove() }
  }, [asset])

  if (asset.candles.length === 0) {
    return (
      <div className="w-full bg-[#0a0b0d] rounded-[8px] border border-[#23252a] flex items-center justify-center"
        style={{ height: 480 }}>
        <span className="text-sm text-[#8a8f98]">No chart data</span>
      </div>
    )
  }

  return (
    <div ref={containerRef}
      className="w-full rounded-[8px] overflow-hidden border border-[#23252a]"
      style={{ height: 480 }} />
  )
}
```

- [ ] **Step 3: Verify TypeScript compiles**

```bash
cd unified-platform && npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add unified-platform/package.json unified-platform/package-lock.json \
        unified-platform/src/components/capital/WaveChart.tsx
git commit -m "feat(unified-platform): WaveChart client component using lightweight-charts"
```

---

### Task 10: Wave detail page

**Files:**
- Create: `unified-platform/src/app/capital/waves/[ticker]/page.tsx`

- [ ] **Step 1: Create `unified-platform/src/app/capital/waves/[ticker]/page.tsx`**

```tsx
import { notFound } from 'next/navigation'
import Link from 'next/link'
import { readWaves } from '@/lib/data'
import { WaveChart } from '@/components/capital/WaveChart'

export const dynamic = 'force-dynamic'

export default async function WaveDetailPage({
  params,
}: {
  params: { ticker: string }
}) {
  const ticker = decodeURIComponent(params.ticker)

  let waves
  try { waves = readWaves() } catch { waves = null }
  if (!waves) return notFound()

  const asset = waves.assets.find(a => a.ticker === ticker)
  if (!asset) return notFound()

  const waveColor = ['1','3','5'].includes(asset.currentWave ?? '')
    ? '#22c55e' : ['2','4'].includes(asset.currentWave ?? '') ? '#f59e0b' : '#ef4444'
  const confColor = asset.confidence >= 75 ? '#22c55e' : asset.confidence >= 50 ? '#f59e0b' : '#ef4444'

  return (
    <div className="p-6 max-w-5xl">
      <div className="flex items-center gap-3 mb-5 flex-wrap">
        <Link href="/capital/waves"
          className="text-[11px] text-[#8a8f98] hover:text-[#d0d6e0] transition-colors">
          ← All assets
        </Link>
        <h1 className="text-[15px] font-semibold text-[#f7f8f8]">{asset.ticker}</h1>
        {asset.label !== asset.ticker && (
          <span className="text-[12px] text-[#8a8f98]">{asset.label}</span>
        )}
        {asset.currentWave && (
          <span className="text-[11px] font-medium rounded px-2 py-0.5"
            style={{ background: waveColor + '22', color: waveColor }}>
            Wave {asset.currentWave} {asset.waveDirection === 'up' ? '↑' : '↓'}
          </span>
        )}
        {asset.confidence > 0 && (
          <span className="text-[11px] rounded px-2 py-0.5"
            style={{ background: confColor + '22', color: confColor }}>
            {asset.confidence}% confidence
          </span>
        )}
        <span className="text-[10px] text-[#62666d] border border-[#23252a] rounded px-1.5 py-0.5 ml-auto">
          {asset.source}
        </span>
      </div>

      <WaveChart asset={asset} />

      {asset.fibChecks.length > 0 && (
        <div className="mt-5">
          <h2 className="text-[11px] font-semibold text-[#8a8f98] uppercase tracking-wider mb-2">
            Fibonacci Checks
          </h2>
          <table className="w-full text-sm border-collapse">
            <thead>
              <tr className="text-[11px] text-[#62666d] border-b border-[#23252a]">
                <th className="text-left py-1.5 pr-4 font-medium">Rule</th>
                <th className="text-right py-1.5 pr-4 font-medium">Expected</th>
                <th className="text-right py-1.5 pr-4 font-medium">Actual</th>
                <th className="text-right py-1.5 font-medium">Pass</th>
              </tr>
            </thead>
            <tbody>
              {asset.fibChecks.map((fc, i) => (
                <tr key={i} className="border-b border-[#1a1c20]">
                  <td className="py-1.5 pr-4 text-[#d0d6e0]">{fc.description}</td>
                  <td className="py-1.5 pr-4 text-right text-[#8a8f98]">{fc.expectedRange}</td>
                  <td className="py-1.5 pr-4 text-right text-[#8a8f98]">{fc.actual.toFixed(3)}</td>
                  <td className="py-1.5 text-right">
                    <span style={{ color: fc.pass ? '#22c55e' : '#ef4444' }}>
                      {fc.pass ? '✓' : '✗'}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
cd unified-platform && npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add unified-platform/src/app/capital/waves/
git commit -m "feat(unified-platform): wave detail page with candlestick chart and Fib table"
```

---

### Task 11: Update daily.sh

**Files:**
- Modify: `daily.sh`

- [ ] **Step 1: Replace `daily.sh` with the updated 11-step version**

```bash
#!/bin/bash
set -e
set -o pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
mkdir -p "$ROOT/logs"
LOG="$ROOT/logs/daily-$(date +%F).log"

log() { echo "[$(date '+%H:%M:%S')] $*" | tee -a "$LOG"; }

log "=== Daily pipeline starting ==="

log "[1/11] World Intelligence — observe"
cd "$ROOT/world-intelligence-data-hub-"
npm run observe 2>&1 | tee -a "$LOG"

log "[2/11] Macro Asset Monitor — fetch"
cd "$ROOT/macro-asset-monitor"
npm run fetch 2>&1 | tee -a "$LOG"

log "[3/11] Wave Analyzer — wave"
cd "$ROOT/wave-analyzer"
npm run wave 2>&1 | tee -a "$LOG"

log "[4/11] Capital Intelligence — pipeline"
cd "$ROOT/capital-intelligence-ingestion"
npm run pipeline 2>&1 | tee -a "$LOG"

log "[5/11] AI Analysis Engine — analyze"
cd "$ROOT/ai-analysis-engine"
npm run analyze 2>&1 | tee -a "$LOG"

log "[6/11] Scenario Simulator — simulate"
cd "$ROOT/scenario-simulator"
npm run simulate 2>&1 | tee -a "$LOG"

log "[7/11] Scenario Simulator — discover"
npm run discover 2>&1 | tee -a "$LOG"

log "[8/11] Dependency Graph — scan + export"
cd "$ROOT/dependency-graph-engine"
npm run scan 2>&1 | tee -a "$LOG"
npm run export 2>&1 | tee -a "$LOG"

log "[9/11] Thesis Memory — update"
cd "$ROOT/thesis-memory"
npm run update 2>&1 | tee -a "$LOG"

log "[10/11] Investment Analyst — brief"
cd "$ROOT/investment-analyst-agents"
npm run brief 2>&1 | tee -a "$LOG"

log "[11/11] Investment Analyst — act (apply base scenario actions)"
npm run act 2>&1 | tee -a "$LOG"

log "=== Daily pipeline complete ==="
```

- [ ] **Step 2: Verify the file looks correct**

```bash
cat daily.sh | grep -E '^\s*log "\[.*/11\]'
```

Expected output (11 lines):
```
log "[1/11] World Intelligence — observe"
log "[2/11] Macro Asset Monitor — fetch"
log "[3/11] Wave Analyzer — wave"
log "[4/11] Capital Intelligence — pipeline"
log "[5/11] AI Analysis Engine — analyze"
log "[6/11] Scenario Simulator — simulate"
log "[7/11] Scenario Simulator — discover"
log "[8/11] Dependency Graph — scan + export"
log "[9/11] Thesis Memory — update"
log "[10/11] Investment Analyst — brief"
log "[11/11] Investment Analyst — act (apply base scenario actions)"
```

- [ ] **Step 3: Commit**

```bash
git add daily.sh
git commit -m "feat(daily): add wave-analyzer as step 3, renumber to 11 steps"
```
