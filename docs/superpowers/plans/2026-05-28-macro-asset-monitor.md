# Macro Asset Monitor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a standalone `macro-asset-monitor` TypeScript project that fetches daily closing prices for 11 macro market assets (Yahoo Finance) and 6 economic indicators (FRED API), exports `macro.json`, feeds it into `ai-analysis-engine`'s regime prompt, and renders it as a new `/capital/macro` page in `unified-platform`.

**Architecture:** New standalone TypeScript project with two fetchers (Yahoo Finance + FRED), one exporter, and one CLI entry point. Runs as step 2 in `daily.sh` (renumbered 1–10). Consumers are `ai-analysis-engine` (reads `macro.json` for regime context) and `unified-platform` (new server page).

**Tech Stack:** TypeScript, tsx, vitest, native `fetch` (no HTTP library), dotenv. All sibling projects use the same stack.

---

## File Map

**New project `macro-asset-monitor/`:**
- `package.json` — scripts, deps
- `tsconfig.json` — ES2022/NodeNext, matches siblings
- `vitest.config.ts` — globals: true, environment: node
- `.gitignore` — node_modules/, data/, .env
- `.env` — FRED_API_KEY=REDACTED
- `src/types.ts` — MarketAsset, EconomicIndicator, MacroJSON
- `src/fetchers/yahoo-fetcher.ts` — fetch 35d OHLCV, compute changes + trend
- `src/fetchers/fred-fetcher.ts` — fetch latest 3 observations, extract value + trend
- `src/exporter.ts` — merge fetcher outputs, write macro.json
- `src/cli/cli-fetch.ts` — entry point: calls fetchers, calls exporter
- `tests/yahoo-fetcher.test.ts`
- `tests/fred-fetcher.test.ts`
- `tests/exporter.test.ts`

**Modified in `ai-analysis-engine/`:**
- `src/analysis/regime-analyzer.ts` — add MacroContext type, formatMacroAssets(), extend WorldIntelContext + analyzeRegime()
- `src/cli/cli-run.ts` — load macro.json, pass to analyzeRegime()

**Modified in `unified-platform/`:**
- `src/types.ts` — add MacroJSON, MarketAsset, EconomicIndicator interfaces
- `src/lib/data.ts` — add readMacro()
- `src/components/capital/Sidebar.tsx` — add Macro nav link
- `src/app/capital/macro/page.tsx` — new server page (create)
- `src/components/capital/MacroAssetCard.tsx` — asset card component (create)
- `src/components/capital/MacroIndicatorRow.tsx` — indicator table row (create)

**Modified in root:**
- `daily.sh` — renumber steps 1–10, add step 2 for macro-asset-monitor

---

### Task 1: Project Scaffold

**Files:**
- Create: `macro-asset-monitor/package.json`
- Create: `macro-asset-monitor/tsconfig.json`
- Create: `macro-asset-monitor/vitest.config.ts`
- Create: `macro-asset-monitor/.gitignore`
- Create: `macro-asset-monitor/.env`

- [ ] **Step 1: Create the project directory and config files**

```bash
mkdir -p /Users/thanapold/Desktop/Projects/macro-asset-monitor/src/fetchers
mkdir -p /Users/thanapold/Desktop/Projects/macro-asset-monitor/src/cli
mkdir -p /Users/thanapold/Desktop/Projects/macro-asset-monitor/tests
mkdir -p /Users/thanapold/Desktop/Projects/macro-asset-monitor/data
```

Create `macro-asset-monitor/package.json`:
```json
{
  "name": "macro-asset-monitor",
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "fetch":      "tsx src/cli/cli-fetch.ts",
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

Create `macro-asset-monitor/tsconfig.json`:
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

Create `macro-asset-monitor/vitest.config.ts`:
```typescript
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
  },
})
```

Create `macro-asset-monitor/.gitignore`:
```
node_modules/
data/
dist/
.env
```

Create `macro-asset-monitor/.env`:
```
FRED_API_KEY=REDACTED
```

- [ ] **Step 2: Install dependencies**

```bash
cd /Users/thanapold/Desktop/Projects/macro-asset-monitor
npm install
```

Expected: `node_modules/` created, no errors.

- [ ] **Step 3: Commit**

```bash
cd /Users/thanapold/Desktop/Projects/macro-asset-monitor
git init
git add package.json tsconfig.json vitest.config.ts .gitignore
git commit -m "feat: scaffold macro-asset-monitor project"
```

---

### Task 2: Types

**Files:**
- Create: `macro-asset-monitor/src/types.ts`

- [ ] **Step 1: Write `src/types.ts`**

```typescript
export type AssetCategory = 'rates' | 'dollar' | 'commodities' | 'volatility' | 'global-equity' | 'credit'
export type IndicatorCategory = 'inflation' | 'labour' | 'consumer' | 'credit'
export type Trend = 'rising' | 'falling' | 'stable'

export interface MarketAsset {
  ticker:       string
  label:        string
  category:     AssetCategory
  close:        number
  change1d:     number
  changePct1d:  number
  changePct5d:  number
  changePct30d: number
  trend:        Trend
}

export interface EconomicIndicator {
  seriesId:    string
  label:       string
  category:    IndicatorCategory
  value:       number
  releaseDate: string
  unit:        string
  trend:       Trend
}

export interface MacroJSON {
  exportedAt:           string
  asOf:                 string
  marketAssets:         MarketAsset[]
  economicIndicators:   EconomicIndicator[]
}
```

- [ ] **Step 2: Commit**

```bash
git add src/types.ts
git commit -m "feat: add types"
```

---

### Task 3: Yahoo Finance Fetcher

**Files:**
- Create: `macro-asset-monitor/src/fetchers/yahoo-fetcher.ts`
- Create: `macro-asset-monitor/tests/yahoo-fetcher.test.ts`

The Yahoo Finance chart API returns 35 days of daily OHLCV. The fetcher extracts the last 3 closes (index -1, -6, -31 from the end) to compute 1d/5d/30d changes.

URL pattern: `https://query1.finance.yahoo.com/v8/finance/chart/{ticker}?interval=1d&range=35d`

Response shape:
```json
{
  "chart": {
    "result": [{
      "timestamp": [1716307200, 1716393600, ...],
      "indicators": {
        "quote": [{ "close": [4.55, null, 4.57, ..., 4.61] }]
      }
    }],
    "error": null
  }
}
```

Closes array may contain `null` for non-trading days — filter those out before indexing.

- [ ] **Step 1: Write the failing tests**

Create `tests/yahoo-fetcher.test.ts`:
```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fetchYahooAsset, YAHOO_ASSETS } from '../src/fetchers/yahoo-fetcher.js'

const makeYahooResponse = (closes: number[]) => ({
  chart: {
    result: [{
      timestamp: closes.map((_, i) => 1716307200 + i * 86400),
      indicators: { quote: [{ close: closes }] },
    }],
    error: null,
  },
})

describe('fetchYahooAsset', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn())
  })

  it('computes 1d/5d/30d changes correctly', async () => {
    // 31 closes: index 0=30d ago, 25=5d ago, 29=prev close, 30=today
    const closes = Array.from({ length: 31 }, (_, i) => 100 + i)
    // close[30]=130, close[29]=129, close[25]=125, close[0]=100
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => makeYahooResponse(closes),
    } as Response)

    const result = await fetchYahooAsset('^TNX', 'US 10Y Yield', 'rates')

    expect(result).not.toBeNull()
    expect(result!.close).toBe(130)
    expect(result!.change1d).toBeCloseTo(1)
    expect(result!.changePct1d).toBeCloseTo(0.775, 1)
    expect(result!.changePct5d).toBeCloseTo(4.0, 1)
    expect(result!.changePct30d).toBeCloseTo(30.0, 1)
    expect(result!.trend).toBe('rising')
  })

  it('skips null closes', async () => {
    const closes = [100, null, null, 103, 104, null, 106]
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => makeYahooResponse(closes as number[]),
    } as Response)

    const result = await fetchYahooAsset('HYG', 'HYG', 'credit')
    expect(result).not.toBeNull()
    expect(result!.close).toBe(106)
  })

  it('returns null on HTTP error', async () => {
    vi.mocked(fetch).mockResolvedValue({ ok: false, status: 429 } as Response)
    const result = await fetchYahooAsset('^VIX', 'VIX', 'volatility')
    expect(result).toBeNull()
  })

  it('returns null on fetch exception', async () => {
    vi.mocked(fetch).mockRejectedValue(new Error('network'))
    const result = await fetchYahooAsset('^VIX', 'VIX', 'volatility')
    expect(result).toBeNull()
  })

  it('YAHOO_ASSETS has 11 entries', () => {
    expect(YAHOO_ASSETS).toHaveLength(11)
  })
})
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
cd /Users/thanapold/Desktop/Projects/macro-asset-monitor
npm test -- tests/yahoo-fetcher.test.ts
```

Expected: FAIL — `Cannot find module '../src/fetchers/yahoo-fetcher.js'`

- [ ] **Step 3: Write `src/fetchers/yahoo-fetcher.ts`**

```typescript
import type { MarketAsset, AssetCategory, Trend } from '../types.js'

interface YahooAssetConfig {
  ticker:   string
  label:    string
  category: AssetCategory
}

export const YAHOO_ASSETS: YahooAssetConfig[] = [
  { ticker: '^TNX',      label: 'US 10Y Yield',  category: 'rates'         },
  { ticker: '^FVX',      label: 'US 2Y Yield',   category: 'rates'         },
  { ticker: 'DX-Y.NYB',  label: 'Dollar Index',  category: 'dollar'        },
  { ticker: 'CL=F',      label: 'WTI Crude Oil', category: 'commodities'   },
  { ticker: 'GC=F',      label: 'Gold',          category: 'commodities'   },
  { ticker: 'HG=F',      label: 'Copper',        category: 'commodities'   },
  { ticker: '^VIX',      label: 'VIX',           category: 'volatility'    },
  { ticker: '^N225',     label: 'Nikkei 225',    category: 'global-equity' },
  { ticker: '^GDAXI',    label: 'DAX',           category: 'global-equity' },
  { ticker: '^HSI',      label: 'Hang Seng',     category: 'global-equity' },
  { ticker: 'HYG',       label: 'HYG',           category: 'credit'        },
]

const RATE_TICKERS = new Set(['^TNX', '^FVX'])

function computeTrend(changePct5d: number, ticker: string, change5dAbs: number): Trend {
  if (RATE_TICKERS.has(ticker)) {
    // rates: use absolute bps change (^TNX quotes in %, 1pt = 100bps)
    const bps = change5dAbs * 100
    if (bps > 5)  return 'rising'
    if (bps < -5) return 'falling'
    return 'stable'
  }
  if (changePct5d > 0.5)  return 'rising'
  if (changePct5d < -0.5) return 'falling'
  return 'stable'
}

export async function fetchYahooAsset(
  ticker: string,
  label: string,
  category: AssetCategory,
): Promise<MarketAsset | null> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&range=35d`
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
    })
    if (!res.ok) {
      console.warn(`[yahoo] ${ticker}: HTTP ${res.status}`)
      return null
    }
    const data = await res.json() as {
      chart: { result: Array<{ indicators: { quote: Array<{ close: (number | null)[] }> } }> | null; error: unknown }
    }
    const result = data.chart.result?.[0]
    if (!result) return null

    const closes = (result.indicators.quote[0]?.close ?? []).filter((c): c is number => c !== null && c !== undefined)
    if (closes.length < 2) return null

    const close     = closes[closes.length - 1]
    const prev1d    = closes[closes.length - 2]
    const prev5d    = closes[Math.max(0, closes.length - 6)]
    const prev30d   = closes[Math.max(0, closes.length - 31)]

    const change1d     = close - prev1d
    const changePct1d  = (change1d / prev1d) * 100
    const changePct5d  = ((close - prev5d) / prev5d) * 100
    const changePct30d = ((close - prev30d) / prev30d) * 100
    const trend        = computeTrend(changePct5d, ticker, close - prev5d)

    return {
      ticker,
      label,
      category,
      close:        parseFloat(close.toFixed(4)),
      change1d:     parseFloat(change1d.toFixed(4)),
      changePct1d:  parseFloat(changePct1d.toFixed(2)),
      changePct5d:  parseFloat(changePct5d.toFixed(2)),
      changePct30d: parseFloat(changePct30d.toFixed(2)),
      trend,
    }
  } catch (err) {
    console.warn(`[yahoo] ${ticker}: fetch error`, err)
    return null
  }
}

export async function fetchAllYahooAssets(): Promise<MarketAsset[]> {
  const results = await Promise.all(
    YAHOO_ASSETS.map(a => fetchYahooAsset(a.ticker, a.label, a.category))
  )
  return results.filter((r): r is MarketAsset => r !== null)
}
```

- [ ] **Step 4: Run tests to confirm they pass**

```bash
npm test -- tests/yahoo-fetcher.test.ts
```

Expected: 5 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/fetchers/yahoo-fetcher.ts tests/yahoo-fetcher.test.ts
git commit -m "feat: add yahoo-fetcher"
```

---

### Task 4: FRED Fetcher

**Files:**
- Create: `macro-asset-monitor/src/fetchers/fred-fetcher.ts`
- Create: `macro-asset-monitor/tests/fred-fetcher.test.ts`

FRED API endpoint: `https://api.stlouisfed.org/fred/series/observations?series_id={id}&api_key={key}&sort_order=desc&limit=3&file_type=json`

Response:
```json
{
  "observations": [
    { "date": "2026-05-14", "value": "3.4" },
    { "date": "2026-04-14", "value": "3.5" },
    { "date": "2026-03-14", "value": "3.6" }
  ]
}
```

FRED uses `"."` as the value for unreleased observations. Fetch 3 observations and pick the most recent one where `value !== "."`. Trend = compare it to the next most recent non-"." value.

- [ ] **Step 1: Write the failing tests**

Create `tests/fred-fetcher.test.ts`:
```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fetchFredSeries, FRED_SERIES } from '../src/fetchers/fred-fetcher.js'

const makeObs = (values: string[], dates?: string[]) => ({
  observations: values.map((value, i) => ({
    date: dates?.[i] ?? `2026-0${5 - i}-14`,
    value,
  })),
})

describe('fetchFredSeries', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn())
    process.env.FRED_API_KEY = 'testkey'
  })

  it('extracts latest non-dot value and computes rising trend', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => makeObs(['3.4', '3.2', '3.0']),
    } as Response)

    const result = await fetchFredSeries('CPIAUCSL', 'CPI YoY %', 'inflation', 'Percent')
    expect(result).not.toBeNull()
    expect(result!.value).toBe(3.4)
    expect(result!.trend).toBe('rising')
  })

  it('skips dot values and picks next available', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => makeObs(['.', '3.4', '3.5']),
    } as Response)

    const result = await fetchFredSeries('CPIAUCSL', 'CPI YoY %', 'inflation', 'Percent')
    expect(result!.value).toBe(3.4)
    expect(result!.trend).toBe('falling')
  })

  it('returns stable when change < 0.05', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => makeObs(['3.401', '3.400', '3.399']),
    } as Response)

    const result = await fetchFredSeries('UNRATE', 'Unemployment', 'labour', 'Percent')
    expect(result!.trend).toBe('stable')
  })

  it('returns null on HTTP error', async () => {
    vi.mocked(fetch).mockResolvedValue({ ok: false, status: 400 } as Response)
    const result = await fetchFredSeries('CPIAUCSL', 'CPI', 'inflation', 'Percent')
    expect(result).toBeNull()
  })

  it('FRED_SERIES has 6 entries', () => {
    expect(FRED_SERIES).toHaveLength(6)
  })
})
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
npm test -- tests/fred-fetcher.test.ts
```

Expected: FAIL — `Cannot find module '../src/fetchers/fred-fetcher.js'`

- [ ] **Step 3: Write `src/fetchers/fred-fetcher.ts`**

```typescript
import type { EconomicIndicator, IndicatorCategory, Trend } from '../types.js'

interface FredSeriesConfig {
  seriesId: string
  label:    string
  category: IndicatorCategory
  unit:     string
}

export const FRED_SERIES: FredSeriesConfig[] = [
  { seriesId: 'CPIAUCSL',   label: 'CPI YoY %',            category: 'inflation', unit: 'Percent'    },
  { seriesId: 'JTSJOL',     label: 'JOLTS Job Openings',   category: 'labour',    unit: 'Thousands'  },
  { seriesId: 'UNRATE',     label: 'Unemployment Rate',    category: 'labour',    unit: 'Percent'    },
  { seriesId: 'UMCSENT',    label: 'Consumer Sentiment',   category: 'consumer',  unit: 'Index'      },
  { seriesId: 'DRCCLACBS',  label: 'CC Delinquency Rate',  category: 'credit',    unit: 'Percent'    },
  { seriesId: 'DRSFRMACBS', label: 'Mortgage Delinquency', category: 'credit',    unit: 'Percent'    },
]

function computeTrend(latest: number, previous: number): Trend {
  const diff = latest - previous
  const relativeDiff = Math.abs(previous) > 0.001 ? Math.abs(diff / previous) : Math.abs(diff)
  if (relativeDiff < 0.005) return 'stable'
  return diff > 0 ? 'rising' : 'falling'
}

export async function fetchFredSeries(
  seriesId: string,
  label: string,
  category: IndicatorCategory,
  unit: string,
): Promise<EconomicIndicator | null> {
  const key = process.env.FRED_API_KEY ?? ''
  const url = `https://api.stlouisfed.org/fred/series/observations?series_id=${seriesId}&api_key=${key}&sort_order=desc&limit=3&file_type=json`
  try {
    const res = await fetch(url)
    if (!res.ok) {
      console.warn(`[fred] ${seriesId}: HTTP ${res.status}`)
      return null
    }
    const data = await res.json() as { observations: Array<{ date: string; value: string }> }
    const valid = data.observations.filter(o => o.value !== '.')
    if (valid.length < 1) return null

    const latest   = valid[0]
    const previous = valid[1]
    const value    = parseFloat(latest.value)
    const trend    = previous ? computeTrend(value, parseFloat(previous.value)) : 'stable'

    return { seriesId, label, category, value, releaseDate: latest.date, unit, trend }
  } catch (err) {
    console.warn(`[fred] ${seriesId}: fetch error`, err)
    return null
  }
}

export async function fetchAllFredSeries(): Promise<EconomicIndicator[]> {
  const results = await Promise.all(
    FRED_SERIES.map(s => fetchFredSeries(s.seriesId, s.label, s.category, s.unit))
  )
  return results.filter((r): r is EconomicIndicator => r !== null)
}
```

- [ ] **Step 4: Run tests to confirm they pass**

```bash
npm test -- tests/fred-fetcher.test.ts
```

Expected: 5 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/fetchers/fred-fetcher.ts tests/fred-fetcher.test.ts
git commit -m "feat: add fred-fetcher"
```

---

### Task 5: Exporter

**Files:**
- Create: `macro-asset-monitor/src/exporter.ts`
- Create: `macro-asset-monitor/tests/exporter.test.ts`

The exporter merges fetcher results into a `MacroJSON` object and writes it to `data/macro.json`. It also accepts an optional `existingPath` to fall back to cached values when a fetch yields zero market assets (weekend / API outage).

- [ ] **Step 1: Write the failing tests**

Create `tests/exporter.test.ts`:
```typescript
import { describe, it, expect, vi } from 'vitest'
import { buildMacro } from '../src/exporter.js'
import type { MarketAsset, EconomicIndicator } from '../src/types.js'

const asset: MarketAsset = {
  ticker: '^TNX', label: 'US 10Y Yield', category: 'rates',
  close: 4.61, change1d: 0.06, changePct1d: 1.32,
  changePct5d: 4.07, changePct30d: 10.0, trend: 'rising',
}
const indicator: EconomicIndicator = {
  seriesId: 'CPIAUCSL', label: 'CPI YoY %', category: 'inflation',
  value: 3.4, releaseDate: '2026-05-14', unit: 'Percent', trend: 'rising',
}

describe('buildMacro', () => {
  it('builds MacroJSON with correct shape', () => {
    const result = buildMacro([asset], [indicator])
    expect(result.marketAssets).toHaveLength(1)
    expect(result.economicIndicators).toHaveLength(1)
    expect(result.marketAssets[0].ticker).toBe('^TNX')
    expect(result.economicIndicators[0].seriesId).toBe('CPIAUCSL')
    expect(result.exportedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(result.asOf).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('sets asOf to most recent asset date context (today)', () => {
    const result = buildMacro([asset], [])
    const today = new Date().toISOString().slice(0, 10)
    expect(result.asOf).toBe(today)
  })
})
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
npm test -- tests/exporter.test.ts
```

Expected: FAIL — `Cannot find module '../src/exporter.js'`

- [ ] **Step 3: Write `src/exporter.ts`**

```typescript
import { writeFileSync, readFileSync, mkdirSync, existsSync } from 'fs'
import { dirname } from 'path'
import type { MarketAsset, EconomicIndicator, MacroJSON } from './types.js'

export function buildMacro(
  marketAssets: MarketAsset[],
  economicIndicators: EconomicIndicator[],
): MacroJSON {
  return {
    exportedAt:         new Date().toISOString(),
    asOf:               new Date().toISOString().slice(0, 10),
    marketAssets,
    economicIndicators,
  }
}

export function exportMacro(
  marketAssets: MarketAsset[],
  economicIndicators: EconomicIndicator[],
  outputPath: string,
): MacroJSON {
  // Fall back to cached data if fetch returned nothing (weekend / outage)
  let assets = marketAssets
  if (assets.length === 0 && existsSync(outputPath)) {
    try {
      const cached = JSON.parse(readFileSync(outputPath, 'utf-8')) as MacroJSON
      assets = cached.marketAssets
      console.log('[macro] No new market data — using cached asset prices')
    } catch {
      // ignore corrupt cache
    }
  }

  const macro = buildMacro(assets, economicIndicators)
  mkdirSync(dirname(outputPath), { recursive: true })
  writeFileSync(outputPath, JSON.stringify(macro, null, 2), 'utf-8')
  return macro
}
```

- [ ] **Step 4: Run tests to confirm they pass**

```bash
npm test -- tests/exporter.test.ts
```

Expected: 2 tests pass.

- [ ] **Step 5: Run all tests**

```bash
npm test
```

Expected: All 12 tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/exporter.ts tests/exporter.test.ts
git commit -m "feat: add exporter"
```

---

### Task 6: CLI Entry Point

**Files:**
- Create: `macro-asset-monitor/src/cli/cli-fetch.ts`

No tests for the CLI entry — it's a thin orchestrator that calls the already-tested functions.

- [ ] **Step 1: Write `src/cli/cli-fetch.ts`**

```typescript
import 'dotenv/config'
import { join } from 'path'
import { fetchAllYahooAssets } from '../fetchers/yahoo-fetcher.js'
import { fetchAllFredSeries }  from '../fetchers/fred-fetcher.js'
import { exportMacro }         from '../exporter.js'

const OUTPUT_PATH = join(process.cwd(), 'data/macro.json')

async function run() {
  const startTime = Date.now()
  console.log('[macro] Fetching macro asset data...')

  const [marketAssets, economicIndicators] = await Promise.all([
    fetchAllYahooAssets(),
    fetchAllFredSeries(),
  ])

  console.log(`[macro] Market assets: ${marketAssets.length}/11`)
  console.log(`[macro] Economic indicators: ${economicIndicators.length}/6`)

  const macro = exportMacro(marketAssets, economicIndicators, OUTPUT_PATH)
  console.log(`[macro] Exported to ${OUTPUT_PATH}`)
  console.log(`[macro] asOf: ${macro.asOf}`)
  console.log(`[macro] Done in ${((Date.now() - startTime) / 1000).toFixed(1)}s`)
}

run().catch(err => { console.error('[macro] Fatal:', err); process.exit(1) })
```

- [ ] **Step 2: Run a live smoke test**

```bash
cd /Users/thanapold/Desktop/Projects/macro-asset-monitor
npm run fetch
```

Expected output (values will vary):
```
[macro] Fetching macro asset data...
[macro] Market assets: 11/11
[macro] Economic indicators: 6/6
[macro] Exported to .../data/macro.json
[macro] asOf: 2026-05-28
[macro] Done in 2.4s
```

Check the file: `cat data/macro.json | head -30`

Expected: valid JSON with `marketAssets` array of 11 objects each having `ticker`, `close`, `change1d`, `trend`.

- [ ] **Step 3: Commit**

```bash
git add src/cli/cli-fetch.ts
git commit -m "feat: add cli-fetch entry point"
```

---

### Task 7: Integrate into `ai-analysis-engine`

**Files:**
- Modify: `ai-analysis-engine/src/analysis/regime-analyzer.ts`
- Modify: `ai-analysis-engine/src/cli/cli-run.ts`

The regime prompt currently ends with the world intel section. We prepend a new macro section before company health data so Claude sees hard price numbers before text-based signals.

- [ ] **Step 1: Extend `WorldIntelContext` and add `formatMacroAssets` in `regime-analyzer.ts`**

Open `ai-analysis-engine/src/analysis/regime-analyzer.ts`.

After the existing `WorldIntelContext` interface (around line 15), add:

```typescript
export interface MacroContext {
  asOf: string
  marketAssets: Array<{
    ticker: string; label: string; category: string
    close: number; change1d: number
    changePct1d: number; changePct5d: number; changePct30d: number
    trend: string
  }>
  economicIndicators: Array<{
    seriesId: string; label: string; category: string
    value: number; releaseDate: string; unit: string; trend: string
  }>
}
```

Add a `formatMacroAssets` function after `formatWorldIntel`:

```typescript
function formatMacroAssets(macro: MacroContext): string {
  const TREND = (t: string) => t === 'rising' ? '↑' : t === 'falling' ? '↓' : '→'
  const PCT   = (n: number) => `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`
  const ABS   = (n: number) => `${n >= 0 ? '+' : ''}${n.toFixed(3)}`

  const byCategory = (cat: string) =>
    macro.marketAssets
      .filter(a => a.category === cat)
      .map(a => {
        const isRate = a.category === 'rates'
        const d1 = isRate ? `${ABS(a.change1d * 100)}bps` : PCT(a.changePct1d)
        const d30 = isRate ? `${ABS(a.changePct30d * 100)}bps 30d` : `${PCT(a.changePct30d)} 30d`
        return `${a.label} ${a.close}(${d1} ${d30} ${TREND(a.trend)})`
      })
      .join(' | ')

  const lines = [
    `## Macro Asset Prices (as of ${macro.asOf})`,
    `RATES      : ${byCategory('rates')}`,
    `DOLLAR     : ${byCategory('dollar')}`,
    `COMMODITIES: ${byCategory('commodities')}`,
    `VOLATILITY : ${byCategory('volatility')}`,
    `GLOBAL EQ  : ${byCategory('global-equity')}`,
    `CREDIT     : ${byCategory('credit')}`,
    '',
    '## Economic Indicators (latest available)',
    ...macro.economicIndicators.map(i =>
      `${i.label.padEnd(24)}: ${i.value} ${i.unit} [${i.releaseDate} ${TREND(i.trend)}]`
    ),
  ]
  return lines.join('\n')
}
```

- [ ] **Step 2: Add `macroAssets` to `analyzeRegime` options and inject into prompt**

Find the `analyzeRegime` function signature (around line 65):

```typescript
export async function analyzeRegime(
  health: CompanyHealth[],
  options: { client?: Anthropic; worldIntel?: WorldIntelContext } = {},
): Promise<MacroRegime> {
```

Change to:

```typescript
export async function analyzeRegime(
  health: CompanyHealth[],
  options: { client?: Anthropic; worldIntel?: WorldIntelContext; macroAssets?: MacroContext } = {},
): Promise<MacroRegime> {
```

Find the `worldSection` variable and add a `macroSection` alongside it:

```typescript
  const macroSection = options.macroAssets
    ? `\n\n${formatMacroAssets(options.macroAssets)}`
    : ''

  const worldSection = options.worldIntel
    ? `\n\n## World Intelligence (live macro events)\n${formatWorldIntel(options.worldIntel)}`
    : ''
```

Update the `messages` content to prepend the macro section first:

```typescript
    messages: [{
      role: 'user',
      content: `Classify the current macro regime.\n\n## Company Health Signals (${health.length} companies)\n${formatHealth(health)}${macroSection}${worldSection}`,
    }],
```

- [ ] **Step 3: Load `macro.json` in `cli-run.ts`**

Open `ai-analysis-engine/src/cli/cli-run.ts`.

After the existing path constants at the top (around line 12), add:

```typescript
const MACRO_PATH = join(process.cwd(), '../macro-asset-monitor/data/macro.json')
```

Add a `loadMacroAssets` function after `loadWorldIntel`:

```typescript
function loadMacroAssets(): import('../analysis/regime-analyzer.js').MacroContext | undefined {
  try {
    if (!existsSync(MACRO_PATH)) return undefined
    return JSON.parse(readFileSync(MACRO_PATH, 'utf-8'))
  } catch {
    console.log('  macro.json not available, running without macro asset context')
    return undefined
  }
}
```

In the `run()` function, after `loadWorldIntel()`:

```typescript
  const macroAssets = loadMacroAssets()
  if (macroAssets) {
    console.log(`  Macro assets: ${macroAssets.marketAssets.length} assets, ${macroAssets.economicIndicators.length} indicators (as of ${macroAssets.asOf})`)
  } else {
    console.log('  Macro assets: not available')
  }
```

Pass `macroAssets` into `analyzeRegime`:

```typescript
  const regime = await analyzeRegime(health, { worldIntel, macroAssets })
```

- [ ] **Step 4: Test the integration**

```bash
cd /Users/thanapold/Desktop/Projects/ai-analysis-engine
npm run analyze 2>&1 | head -20
```

Expected: lines like:
```
  Macro assets: 11 assets, 6 indicators (as of 2026-05-28)
  Regime: AI Acceleration Under Stagflationary Pressure (medium)
```

- [ ] **Step 5: Commit**

```bash
cd /Users/thanapold/Desktop/Projects/ai-analysis-engine
git add src/analysis/regime-analyzer.ts src/cli/cli-run.ts
git commit -m "feat: inject macro asset context into regime analyzer"
```

---

### Task 8: Dashboard Page in `unified-platform`

**Files:**
- Modify: `unified-platform/src/types.ts`
- Modify: `unified-platform/src/lib/data.ts`
- Modify: `unified-platform/src/components/capital/Sidebar.tsx`
- Create: `unified-platform/src/app/capital/macro/page.tsx`
- Create: `unified-platform/src/components/capital/MacroAssetCard.tsx`
- Create: `unified-platform/src/components/capital/MacroIndicatorRow.tsx`

- [ ] **Step 1: Add types to `src/types.ts`**

Open `unified-platform/src/types.ts` and append at the end of the file:

```typescript
export type Trend = 'rising' | 'falling' | 'stable'

export interface MarketAsset {
  ticker:       string
  label:        string
  category:     string
  close:        number
  change1d:     number
  changePct1d:  number
  changePct5d:  number
  changePct30d: number
  trend:        Trend
}

export interface EconomicIndicator {
  seriesId:    string
  label:       string
  category:    string
  value:       number
  releaseDate: string
  unit:        string
  trend:       Trend
}

export interface MacroJSON {
  exportedAt:           string
  asOf:                 string
  marketAssets:         MarketAsset[]
  economicIndicators:   EconomicIndicator[]
}
```

- [ ] **Step 2: Add `readMacro()` to `src/lib/data.ts`**

Open `unified-platform/src/lib/data.ts`. Add the import at the top:

```typescript
import type { ..., MacroJSON } from '@/types'
```

(Add `MacroJSON` to the existing import from `'@/types'`.)

Append at the end of the file:

```typescript
export function readMacro(): MacroJSON {
  return readJSON<MacroJSON>(
    path.join(dataRoot(), 'macro-asset-monitor/data/macro.json')
  )
}
```

- [ ] **Step 3: Add Macro link to `Sidebar.tsx`**

Open `unified-platform/src/components/capital/Sidebar.tsx`.

In the `NAV` array, add after the graph entry:

```typescript
  { href: '/capital/macro',     icon: '📈', label: 'Macro'     },
```

Full updated NAV array:
```typescript
const NAV = [
  { href: '/capital/briefing',  icon: '📋', label: 'Briefing'  },
  { href: '/capital/portfolio', icon: '💼', label: 'Portfolio' },
  { href: '/capital/discovery', icon: '✦',  label: 'Discovery' },
  { href: '/capital/thesis',    icon: '🧠', label: 'Thesis'    },
  { href: '/capital/graph',     icon: '🕸', label: 'Graph'     },
  { href: '/capital/macro',     icon: '📈', label: 'Macro'     },
  { href: '/capital/ask',       icon: '💬', label: 'Ask'       },
]
```

- [ ] **Step 4: Create `MacroAssetCard.tsx`**

Create `unified-platform/src/components/capital/MacroAssetCard.tsx`:

```typescript
import type { MarketAsset } from '@/types'

function formatValue(asset: MarketAsset): string {
  const isRate = asset.category === 'rates'
  if (isRate) return `${asset.close.toFixed(2)}%`
  if (asset.ticker === '^VIX') return asset.close.toFixed(2)
  if (asset.close > 100) return `${asset.close.toLocaleString('en-US', { maximumFractionDigits: 2 })}`
  return asset.close.toFixed(4)
}

function formatChange(pct: number): string {
  return `${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%`
}

function trendColor(trend: string): string {
  if (trend === 'rising')  return 'text-green-signal'
  if (trend === 'falling') return 'text-red-signal'
  return 'text-text-muted'
}

function changeColor(pct: number): string {
  if (pct > 0.1)  return 'text-green-signal'
  if (pct < -0.1) return 'text-red-signal'
  return 'text-text-muted'
}

const TREND_ARROW: Record<string, string> = { rising: '↑', falling: '↓', stable: '→' }

export function MacroAssetCard({ asset }: { asset: MarketAsset }) {
  return (
    <div className="bg-bg-card border border-border-subtle rounded-lg p-3 flex flex-col gap-1">
      <div className="flex items-center justify-between">
        <span className="text-[10px] text-text-inactive uppercase tracking-wide">{asset.category}</span>
        <span className={`text-xs font-bold ${trendColor(asset.trend)}`}>
          {TREND_ARROW[asset.trend]}
        </span>
      </div>
      <div className="text-xs font-semibold text-text-primary">{asset.label}</div>
      <div className="text-sm font-bold text-text-primary">{formatValue(asset)}</div>
      <div className="flex gap-2 text-[10px]">
        <span className={changeColor(asset.changePct1d)}>{formatChange(asset.changePct1d)} 1d</span>
        <span className={changeColor(asset.changePct5d)}>{formatChange(asset.changePct5d)} 5d</span>
        <span className={changeColor(asset.changePct30d)}>{formatChange(asset.changePct30d)} 30d</span>
      </div>
    </div>
  )
}
```

- [ ] **Step 5: Create `MacroIndicatorRow.tsx`**

Create `unified-platform/src/components/capital/MacroIndicatorRow.tsx`:

```typescript
import type { EconomicIndicator } from '@/types'

function trendColor(trend: string): string {
  if (trend === 'rising')  return 'text-green-signal'
  if (trend === 'falling') return 'text-red-signal'
  return 'text-text-muted'
}

function alertColor(indicator: EconomicIndicator): string {
  if (indicator.seriesId === 'DRCCLACBS'  && indicator.value > 2.5) return 'text-amber-signal'
  if (indicator.seriesId === 'DRSFRMACBS' && indicator.value > 1.5) return 'text-amber-signal'
  if (indicator.seriesId === 'UNRATE'     && indicator.value > 4.5) return 'text-amber-signal'
  return 'text-text-primary'
}

const TREND_ARROW: Record<string, string> = { rising: '↑', falling: '↓', stable: '→' }

export function MacroIndicatorRow({ indicator }: { indicator: EconomicIndicator }) {
  return (
    <tr className="border-b border-border-subtle last:border-0">
      <td className="py-2 pr-4 text-xs text-text-secondary">{indicator.label}</td>
      <td className={`py-2 pr-4 text-xs font-semibold tabular-nums ${alertColor(indicator)}`}>
        {indicator.value.toLocaleString('en-US', { maximumFractionDigits: 2 })} {indicator.unit === 'Thousands' ? 'K' : indicator.unit === 'Percent' ? '%' : ''}
      </td>
      <td className="py-2 pr-4 text-[10px] text-text-inactive">{indicator.releaseDate}</td>
      <td className={`py-2 text-xs ${trendColor(indicator.trend)}`}>
        {TREND_ARROW[indicator.trend]} {indicator.trend}
      </td>
    </tr>
  )
}
```

- [ ] **Step 6: Create the page `src/app/capital/macro/page.tsx`**

```typescript
export const dynamic = 'force-dynamic'

import type { MacroJSON } from '@/types'
import { readMacro } from '@/lib/data'
import { MacroAssetCard } from '@/components/capital/MacroAssetCard'
import { MacroIndicatorRow } from '@/components/capital/MacroIndicatorRow'

const CATEGORY_ORDER = ['rates', 'dollar', 'commodities', 'volatility', 'global-equity', 'credit']

export default async function MacroPage() {
  let macro: MacroJSON | null = null
  let error: string | null = null

  try {
    macro = readMacro()
  } catch (e) {
    error = e instanceof Error ? e.message : 'Failed to load macro data'
  }

  if (error || !macro) {
    return (
      <div className="max-w-4xl">
        <h1 className="text-base font-bold text-text-primary mb-4">Macro Monitor</h1>
        <div className="bg-red-signal/10 border border-red-signal/20 rounded-lg p-4 text-sm text-red-signal">
          {error ?? 'macro.json not found — run ./daily.sh to fetch macro data'}
        </div>
      </div>
    )
  }

  const sortedAssets = [...macro.marketAssets].sort(
    (a, b) => CATEGORY_ORDER.indexOf(a.category) - CATEGORY_ORDER.indexOf(b.category)
  )

  return (
    <div className="max-w-5xl space-y-6">
      <div className="flex items-baseline justify-between">
        <h1 className="text-base font-bold text-text-primary">Macro Monitor</h1>
        <span className="text-[10px] text-text-inactive">as of {macro.asOf}</span>
      </div>

      <div>
        <h2 className="text-xs font-semibold uppercase tracking-wide text-accent-primary mb-3">Market Pulse</h2>
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6 gap-2">
          {sortedAssets.map(asset => (
            <MacroAssetCard key={asset.ticker} asset={asset} />
          ))}
        </div>
      </div>

      <div>
        <h2 className="text-xs font-semibold uppercase tracking-wide text-accent-primary mb-3">Economic Indicators</h2>
        <div className="bg-bg-card border border-border-subtle rounded-lg p-4">
          <table className="w-full">
            <thead>
              <tr className="border-b border-border-subtle">
                <th className="text-left text-[10px] uppercase tracking-wide text-text-inactive pb-2 pr-4">Indicator</th>
                <th className="text-left text-[10px] uppercase tracking-wide text-text-inactive pb-2 pr-4">Value</th>
                <th className="text-left text-[10px] uppercase tracking-wide text-text-inactive pb-2 pr-4">Released</th>
                <th className="text-left text-[10px] uppercase tracking-wide text-text-inactive pb-2">Trend</th>
              </tr>
            </thead>
            <tbody>
              {macro.economicIndicators.map(ind => (
                <MacroIndicatorRow key={ind.seriesId} indicator={ind} />
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
```

- [ ] **Step 7: Verify the page renders**

Make sure `unified-platform` dev server is running (`npm run dev` in the `unified-platform/` directory), then open:

```
http://localhost:3000/capital/macro
```

Expected: Page loads with "Market Pulse" grid of 11 asset cards and "Economic Indicators" table with 6 rows. Sidebar shows "Macro" link active.

- [ ] **Step 8: Commit**

```bash
cd /Users/thanapold/Desktop/Projects/unified-platform
git add src/types.ts src/lib/data.ts src/components/capital/Sidebar.tsx \
  src/app/capital/macro/page.tsx \
  src/components/capital/MacroAssetCard.tsx \
  src/components/capital/MacroIndicatorRow.tsx
git commit -m "feat: add macro monitor dashboard page"
```

---

### Task 9: Wire into `daily.sh`

**Files:**
- Modify: `daily.sh` (root of Projects)

Renumber all steps 1–10. Macro-asset-monitor is the new step 2.

- [ ] **Step 1: Update `daily.sh`**

Replace the full `daily.sh` content with:

```bash
#!/bin/bash
set -e
set -o pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
mkdir -p "$ROOT/logs"
LOG="$ROOT/logs/daily-$(date +%F).log"

log() { echo "[$(date '+%H:%M:%S')] $*" | tee -a "$LOG"; }

log "=== Daily pipeline starting ==="

log "[1/10] World Intelligence — observe"
cd "$ROOT/world-intelligence-data-hub-"
npm run observe 2>&1 | tee -a "$LOG"

log "[2/10] Macro Asset Monitor — fetch"
cd "$ROOT/macro-asset-monitor"
npm run fetch 2>&1 | tee -a "$LOG"

log "[3/10] Capital Intelligence — pipeline"
cd "$ROOT/capital-intelligence-ingestion"
npm run pipeline 2>&1 | tee -a "$LOG"

log "[4/10] AI Analysis Engine — analyze"
cd "$ROOT/ai-analysis-engine"
npm run analyze 2>&1 | tee -a "$LOG"

log "[5/10] Scenario Simulator — simulate"
cd "$ROOT/scenario-simulator"
npm run simulate 2>&1 | tee -a "$LOG"

log "[6/10] Scenario Simulator — discover"
npm run discover 2>&1 | tee -a "$LOG"

log "[7/10] Dependency Graph — scan + export"
cd "$ROOT/dependency-graph-engine"
npm run scan 2>&1 | tee -a "$LOG"
npm run export 2>&1 | tee -a "$LOG"

log "[8/10] Thesis Memory — update"
cd "$ROOT/thesis-memory"
npm run update 2>&1 | tee -a "$LOG"

log "[9/10] Investment Analyst — brief"
cd "$ROOT/investment-analyst-agents"
npm run brief 2>&1 | tee -a "$LOG"

log "[10/10] Investment Analyst — act (apply base scenario actions)"
npm run act 2>&1 | tee -a "$LOG"

log "=== Daily pipeline complete ==="
```

- [ ] **Step 2: Smoke-test the new step in isolation**

```bash
cd /Users/thanapold/Desktop/Projects/macro-asset-monitor
npm run fetch
```

Expected: exits 0, `data/macro.json` written.

- [ ] **Step 3: Commit**

```bash
cd /Users/thanapold/Desktop/Projects
git add daily.sh
git commit -m "feat(pipeline): add macro-asset-monitor as step 2/10"
```

---

## Self-Review

**Spec coverage:**
- ✅ Yahoo Finance fetcher — Task 3
- ✅ FRED fetcher — Task 4
- ✅ `macro.json` export with fallback to cache — Task 5
- ✅ CLI entry point — Task 6
- ✅ `ai-analysis-engine` macro context injection — Task 7
- ✅ Dashboard page `/capital/macro` — Task 8
- ✅ Sidebar nav link — Task 8 step 3
- ✅ Alert colors for delinquency/unemployment — Task 8 step 5
- ✅ `daily.sh` step 2 — Task 9
- ✅ Error handling: null on HTTP error, null on exception, fallback to cache — Tasks 3, 4, 5

**Type consistency check:**
- `MarketAsset` defined in Task 2 `types.ts`, used identically in Tasks 3/5/8 ✅
- `EconomicIndicator` defined in Task 2, used identically in Tasks 4/5/8 ✅
- `MacroContext` in regime-analyzer mirrors `MacroJSON` shape (inline copy, no cross-project import) ✅
- `fetchAllYahooAssets()` → `MarketAsset[]`, consumed by `exportMacro()` which expects `MarketAsset[]` ✅
- `readMacro()` returns `MacroJSON`, consumed by `MacroPage` which types it as `MacroJSON | null` ✅
