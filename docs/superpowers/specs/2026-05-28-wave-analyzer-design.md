# Wave Analyzer — Design Spec

## Goal

Fetch 2 years of daily OHLCV data for Gold, a user-defined watchlist, and the top-N most-active US stocks (Yahoo Finance screener). Run a zigzag pivot + Elliott Wave detection algorithm on each. Surface a grid overview of all assets at `/capital/waves` and a full candlestick + wave label page at `/capital/waves/[ticker]`.

## Problem Being Solved

Macro regime analysis tells you the broad market backdrop. Elliott Wave analysis tells you *where in the cycle* individual assets are — whether a correction is likely over, whether a wave 3 extension is in progress, whether a distribution phase is beginning. Combining both gives a more precise timing signal for portfolio decisions.

## Architecture

New standalone TypeScript project `wave-analyzer/`, following the same pattern as `macro-asset-monitor`. Runs as step 3 in `daily.sh` — after macro-asset-monitor (step 2) and before capital-intelligence-ingestion (step 4).

```
world-intelligence (step 1)
  → macro-asset-monitor (step 2)
    → wave-analyzer (step 3)  ← NEW
      → capital-intelligence-ingestion (step 4)
        → ai-analysis-engine (step 5)
          → ...
            → investment-analyst-agents (steps 10+11)
```

`unified-platform` reads `waves.json` at page render time (server component, `force-dynamic`).

## Data Sources

### Yahoo Finance Screener (no auth)

```
GET https://query1.finance.yahoo.com/v1/finance/screener/predefined/saved
    ?scrIds=most_actives&count={SCREENER_COUNT}&start=0&formatted=false
```

Returns an array of the most-actively traded US stocks by volume today. Extract `quotes[].symbol`. Default `SCREENER_COUNT=20`, configurable via `.env`.

On failure (non-200, parse error, empty quotes array): log warning, fall back to empty screener list — continue with watchlist + Gold only.

### Yahoo Finance OHLCV (no auth)

```
GET https://query1.finance.yahoo.com/v8/finance/chart/{ticker}
    ?interval=1d&range=2y
```

Returns `chart.result[0]`:
- `timestamp[]` — Unix timestamps per bar
- `indicators.quote[0].open[]`
- `indicators.quote[0].high[]`
- `indicators.quote[0].low[]`
- `indicators.quote[0].close[]`
- `indicators.quote[0].volume[]`

Filter out bars where any of open/high/low/close is null. Convert timestamp to `YYYY-MM-DD` using UTC date.

On failure for a single ticker: log warning, omit that ticker from output.

### Asset Universe

Merge (deduplicated, Gold always included):
- `GC=F` (Gold) — always
- `WATCHLIST_TICKERS` from `.env` — comma-separated, e.g. `NVDA,AAPL,TSLA,META,AMZN`
- Screener results (top N most active)

## `waves.json` Schema

Written to `wave-analyzer/data/waves.json`.

```typescript
interface WavesJSON {
  exportedAt: string        // ISO timestamp
  asOf: string              // YYYY-MM-DD of most recent bar
  assets: WaveAsset[]
}

interface WaveAsset {
  ticker: string
  label: string             // human name, e.g. "Gold", "NVIDIA Corp"
  source: 'macro' | 'watchlist' | 'screener'
  candles: Candle[]         // full 2yr OHLCV history
  pivots: Pivot[]           // detected swing highs/lows
  wavePivots: WavePivot[]   // labeled subset — the Elliott Wave count
  currentWave: string | null // e.g. "3", "A" — wave we're currently in
  waveDirection: 'up' | 'down' | null
  confidence: number        // 0–100
  fibChecks: FibCheck[]
}

interface Candle {
  date: string     // YYYY-MM-DD
  open: number
  high: number
  low: number
  close: number
  volume: number
}

interface Pivot {
  date: string
  price: number
  type: 'high' | 'low'
}

interface WavePivot {
  date: string
  price: number
  label: string    // "1" | "2" | "3" | "4" | "5" | "A" | "B" | "C"
}

interface FibCheck {
  description: string   // e.g. "Wave 2 retracement"
  actual: number        // e.g. 0.618
  expectedRange: string // e.g. "38.2–61.8%"
  pass: boolean
}
```

## Project Structure

```
wave-analyzer/
  src/
    fetchers/
      screener-fetcher.ts   — fetch most_actives, return string[]
      ohlcv-fetcher.ts      — fetch 2yr OHLCV for one ticker, return Candle[]
    analysis/
      zigzag.ts             — compute pivot highs/lows from Candle[]
      wave-detector.ts      — label pivots as EW waves, compute confidence
    exporter.ts             — orchestrate fetches + analysis, write waves.json
    cli/
      cli-wave.ts           — entry point: reads .env, calls exportWaves()
    types.ts
  data/
    waves.json              — gitignored
  .env                      — WATCHLIST_TICKERS=NVDA,AAPL,TSLA,META,AMZN  SCREENER_COUNT=20
  .gitignore
  package.json
  tsconfig.json
```

**Dependencies:** `dotenv`, `tsx` (dev), `typescript` (dev), `vitest` (dev).

**Scripts:** `npm run wave` — run cli-wave.ts.

## Elliott Wave Algorithm

### Stage 1 — Zigzag Pivot Detection (`zigzag.ts`)

```
computeZigzag(candles: Candle[], threshold: number): Pivot[]
```

`threshold`: 0.05 (5%) for stocks/ETFs, 0.03 (3%) for Gold.

Algorithm:
1. Start: direction = `up`, extremePrice = candles[0].low, extremeIndex = 0.
2. For each bar:
   - If direction `up`: if `high > extremePrice`, update extremePrice/index. If `close < extremePrice * (1 - threshold)`: record pivot HIGH at extremeIndex, flip direction to `down`, set extremePrice = current low.
   - If direction `down`: if `low < extremePrice`, update extremePrice/index. If `close > extremePrice * (1 + threshold)`: record pivot LOW at extremeIndex, flip direction to `up`, set extremePrice = current high.
3. After all bars: append a final unconfirmed pivot at the current extreme.
4. Output: alternating Pivot[] array, minimum 2 pivots.

### Stage 2 — Wave Labeling (`wave-detector.ts`)

```
detectWaves(pivots: Pivot[]): WaveDetectionResult
```

where `WaveDetectionResult = { wavePivots, currentWave, waveDirection, confidence, fibChecks }`.

**Requires at minimum 6 pivots.** With fewer, return empty wavePivots, null currentWave, confidence = 0.

**Attempt 5-wave impulse (bullish):** Take the last 6 pivots. If pivot[0] is a LOW: label as low=start, HIGH=W1-end, low=W2-end, HIGH=W3-end, low=W4-end, HIGH=W5-end. Score this candidate.

**Attempt 5-wave impulse (bearish):** Take the last 6 pivots. If pivot[0] is a HIGH: label as high=start, LOW=W1-end, high=W2-end, LOW=W3-end, high=W4-end, LOW=W5-end. Score this candidate.

If the last 6 pivots start with the wrong type for either impulse, try starting from pivot[-5] instead (slide the window back by one).

**Attempt 3-wave correction (A-B-C):** Take the last 4 pivots, label as: [prior extreme]=impulse-end, [1]=A-end, [2]=B-end, [3]=C-end. Score against typical correction rules (C ≈ equal length to A, B retraces 38.2–78.6% of A).

**Scoring (out of 100):**
| Rule | Points |
|------|--------|
| Wave 3 is not the shortest impulse wave | +20 |
| Wave 4 does not overlap Wave 1 territory | +20 |
| Wave 2 retraces 38.2–100% of Wave 1 | +10 |
| Wave 4 retraces 23.6–61.8% of Wave 3 | +10 |
| Wave 3 length ≥ 1.618× Wave 1 length | +10 |
| Wave 5 length within 61.8–161.8% of Wave 1 | +10 |
| Any wave hits a key Fib level (0.382/0.5/0.618/0.764/1.0/1.618) ±2% | +5 each, max +20 |

Pick the candidate (impulse bullish/bearish/correction) with the highest score. That score becomes `confidence`.

`currentWave`: determined by which labeled pivot is most recent and what follows it. E.g., if the last wavePivot is W4-end (a low), currentWave = "5" with waveDirection = "up".

`fibChecks`: one `FibCheck` per scored rule above, pass = whether that rule's condition was met.

## Integration: `unified-platform`

### New types: `src/types.ts`

Append `Candle`, `Pivot`, `WavePivot`, `FibCheck`, `WaveAsset`, `WavesJSON` interfaces (matching the schema above).

### New reader: `src/lib/data.ts`

```typescript
export function readWaves(): WavesJSON | null {
  const filePath = path.join(dataRoot(), 'wave-analyzer/data/waves.json')
  try { return readJSON<WavesJSON>(filePath) } catch { return null }
}
```

### New page: `src/app/capital/waves/page.tsx`

Server component, `export const dynamic = 'force-dynamic'`.

Calls `readWaves()`. If null, shows: "Wave data not available — run the daily pipeline."

Renders a responsive grid (`grid-cols-2 md:grid-cols-3 lg:grid-cols-4`) of `<WaveCard>` components, one per asset. Each card is a `<Link href="/capital/waves/{ticker}">`.

`WaveCard` displays:
- Ticker + label
- Source badge (`watchlist` / `screener` / `macro`)
- Mini SVG zigzag line (connect wavePivots price sequence)
- Current wave badge (e.g. "Wave 3 ↑") — green for impulse up, red for correction, amber for impulse down
- Confidence badge — green ≥75%, amber 50–74%, red <50%

### New page: `src/app/capital/waves/[ticker]/page.tsx`

Server component, `export const dynamic = 'force-dynamic'`.

Reads waves.json, finds the asset by ticker. If not found: "Ticker not found."

Passes `asset.candles` and `asset.wavePivots` to client component `<WaveChart>`.

Renders below the chart:
- Fibonacci check table (description | expected | actual | pass/fail)
- `currentWave` + confidence in the page header

### New component: `src/components/capital/WaveChart.tsx`

`'use client'` component. Uses `lightweight-charts` v5 (TradingView).

```tsx
import { createChart, CandlestickSeries, LineSeries } from 'lightweight-charts'
```

Renders:
1. Candlestick series from `candles` (OHLCV)
2. Line series for the zigzag wave path: connects `wavePivots` by date/price
3. Marker annotations at each `wavePivot` showing the wave label ("1", "2", … "A", "B", "C")

Chart config: dark background (`#0a0b0d`), grid color `#1a1c20`, up color `#22c55e`, down color `#ef4444`, zigzag line color `#5e6ad2`.

`lightweight-charts` is a new dependency — add to `unified-platform/package.json`.

### Sidebar update: `src/components/capital/Sidebar.tsx`

Add `{ href: '/capital/waves', icon: '〜', label: 'Waves' }` after Macro.

## `daily.sh` change

Add step 3 between macro-asset-monitor and capital-intelligence-ingestion. Renumber all steps 1–11.

```bash
log "[3/11] Wave Analyzer — wave"
cd "$ROOT/wave-analyzer"
npm run wave 2>&1 | tee -a "$LOG"
```

## Error Handling

- Screener returns empty: log warning, continue with watchlist + Gold only
- OHLCV fetch fails for ticker: log warning, skip that asset
- Fewer than 6 pivots detected (insufficient data): store pivots, set `wavePivots=[]`, `currentWave=null`, `confidence=0`
- `waves.json` missing when `unified-platform` renders: show "Wave data not available" empty state
- `WaveChart` receives empty candles: renders placeholder "No chart data"

## Testing

- `zigzag.test.ts`: mock OHLCV with a known pattern (clear up-down swings), verify pivot alternation and count. Verify threshold: 3% move does not trigger a 5% threshold pivot.
- `wave-detector.test.ts`:
  - Classic 5-wave up: 6 pre-defined pivots satisfying all EW rules → verify all labels correct, confidence ≥ 80.
  - Rule violation (wave 4 overlaps wave 1): verify confidence is reduced and overlap check fails.
  - Only 4 pivots: verify returns empty wavePivots, null currentWave, confidence = 0.
- `screener-fetcher.test.ts`: mock fetch returning sample Yahoo screener JSON, verify correct ticker extraction.
- `ohlcv-fetcher.test.ts`: mock fetch with sample Yahoo chart JSON, verify candle extraction, null filtering, date conversion.
- `exporter.test.ts`: mock fetchers, verify `waves.json` is written with correct structure and all assets present.
