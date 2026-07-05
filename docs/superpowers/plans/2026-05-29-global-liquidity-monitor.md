# Global Liquidity Monitor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add 4 FRED liquidity series (WALCL, WTREGEN, RRPONTSYD, M2SL) to the macro pipeline so the AI regime analysis can cite liquidity conditions in its rationale.

**Architecture:** `macro-asset-monitor` gains a `liquidity-fetcher.ts` that writes `liquidityIndicators[]` into `macro.json`. `ai-analysis-engine` reads them from `macro.json` in `cli-run.ts` and passes a `LiquidityContext` to `analyzeRegime()`, which injects it as a 3rd signal source into the Claude prompt. No new scheduler — liquidity runs inside the existing `npm run fetch`.

**Tech Stack:** TypeScript, native `fetch` (FRED REST API), vitest — all already installed.

---

## File Map

```
macro-asset-monitor/
  src/types.ts                          MODIFY — add LiquiditySignal, LiquidityIndicator, extend MacroJSON
  src/fetchers/liquidity-fetcher.ts     CREATE — fetch 4 FRED series, compute signals
  src/exporter.ts                       MODIFY — buildMacro() + exportMacro() accept liquidityIndicators
  src/cli/cli-fetch.ts                  MODIFY — fetch liquidity, pass to exportMacro
  tests/liquidity-fetcher.test.ts       CREATE — test signal computation (pure, no network)
  tests/exporter.test.ts                MODIFY — extend existing tests with liquidityIndicators

ai-analysis-engine/
  src/analysis/regime-analyzer.ts       MODIFY — add LiquidityContext interface, formatLiquidity(), extend analyzeRegime()
  src/cli/cli-run.ts                    MODIFY — add loadLiquidityContext(), pass to analyzeRegime()
```

---

### Task 1: Add liquidity types and fetcher to macro-asset-monitor

**Files:**
- Modify: `macro-asset-monitor/src/types.ts`
- Create: `macro-asset-monitor/src/fetchers/liquidity-fetcher.ts`
- Create: `macro-asset-monitor/tests/liquidity-fetcher.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `macro-asset-monitor/tests/liquidity-fetcher.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { computeSignal } from '../src/fetchers/liquidity-fetcher.js'

describe('computeSignal — WALCL (Fed Balance Sheet)', () => {
  it('returns draining when 4w change < -20B', () => {
    expect(computeSignal('WALCL', -85, null)).toBe('draining')
  })
  it('returns injecting when 4w change > +20B', () => {
    expect(computeSignal('WALCL', 50, null)).toBe('injecting')
  })
  it('returns neutral when 4w change is between -20 and +20', () => {
    expect(computeSignal('WALCL', 10, null)).toBe('neutral')
  })
  it('returns neutral when change4w is null', () => {
    expect(computeSignal('WALCL', null, null)).toBe('neutral')
  })
})

describe('computeSignal — WTREGEN (Treasury General Account)', () => {
  it('returns draining when 4w change > +20B (rising TGA drains liquidity)', () => {
    expect(computeSignal('WTREGEN', 120, null)).toBe('draining')
  })
  it('returns injecting when 4w change < -20B (falling TGA injects liquidity)', () => {
    expect(computeSignal('WTREGEN', -50, null)).toBe('injecting')
  })
  it('returns neutral within thresholds', () => {
    expect(computeSignal('WTREGEN', 5, null)).toBe('neutral')
  })
})

describe('computeSignal — RRPONTSYD (Overnight Reverse Repo)', () => {
  it('returns draining when 4w change > +20B', () => {
    expect(computeSignal('RRPONTSYD', 180, null)).toBe('draining')
  })
  it('returns injecting when 4w change < -20B', () => {
    expect(computeSignal('RRPONTSYD', -180, null)).toBe('injecting')
  })
})

describe('computeSignal — M2SL (M2 Money Supply)', () => {
  it('returns draining when YoY < -0.5%', () => {
    expect(computeSignal('M2SL', null, -1.2)).toBe('draining')
  })
  it('returns injecting when YoY > +1.0%', () => {
    expect(computeSignal('M2SL', null, 2.5)).toBe('injecting')
  })
  it('returns neutral between thresholds', () => {
    expect(computeSignal('M2SL', null, 0.3)).toBe('neutral')
  })
  it('returns neutral when YoY is null', () => {
    expect(computeSignal('M2SL', null, null)).toBe('neutral')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd /Users/thanapold/Desktop/Projects/macro-asset-monitor
npm test -- tests/liquidity-fetcher.test.ts --reporter=verbose 2>&1 | tail -10
```

Expected: FAIL — `computeSignal` not exported.

- [ ] **Step 3: Add types to `src/types.ts`**

Add after `export interface MacroJSON`:

```typescript
export type LiquiditySignal = 'draining' | 'neutral' | 'injecting'

export interface LiquidityIndicator {
  seriesId:    string
  label:       string
  value:       number
  releaseDate: string
  unit:        string
  change4w:    number | null
  changeYoY:   number | null
  signal:      LiquiditySignal
}
```

Extend `MacroJSON` to add `liquidityIndicators`:

```typescript
export interface MacroJSON {
  exportedAt:           string
  asOf:                 string
  marketAssets:         MarketAsset[]
  economicIndicators:   EconomicIndicator[]
  liquidityIndicators:  LiquidityIndicator[]
}
```

- [ ] **Step 4: Create `src/fetchers/liquidity-fetcher.ts`**

```typescript
import type { LiquidityIndicator, LiquiditySignal } from '../types.js'

interface SeriesConfig {
  seriesId:  string
  label:     string
  limit:     number
  frequency: 'daily' | 'weekly' | 'monthly'
}

const SERIES: SeriesConfig[] = [
  { seriesId: 'WALCL',     label: 'Fed Balance Sheet',       limit: 56,  frequency: 'weekly'  },
  { seriesId: 'WTREGEN',   label: 'Treasury General Account', limit: 56,  frequency: 'weekly'  },
  { seriesId: 'RRPONTSYD', label: 'Overnight Reverse Repo',   limit: 365, frequency: 'daily'   },
  { seriesId: 'M2SL',      label: 'M2 Money Supply',          limit: 14,  frequency: 'monthly' },
]

export function computeSignal(
  seriesId: string,
  change4w: number | null,
  changeYoY: number | null,
): LiquiditySignal {
  if (seriesId === 'M2SL') {
    if (changeYoY == null) return 'neutral'
    if (changeYoY < -0.5) return 'draining'
    if (changeYoY > 1.0)  return 'injecting'
    return 'neutral'
  }
  // WALCL: falling balance sheet = draining; rising = injecting
  // WTREGEN: rising TGA = draining (money locked up); falling = injecting
  // RRPONTSYD: rising RRP = draining; falling = injecting
  if (change4w == null) return 'neutral'
  if (seriesId === 'WALCL') {
    if (change4w < -20) return 'draining'
    if (change4w > 20)  return 'injecting'
    return 'neutral'
  }
  // WTREGEN and RRPONTSYD: sign is flipped relative to WALCL
  if (change4w > 20)  return 'draining'
  if (change4w < -20) return 'injecting'
  return 'neutral'
}

function pctChange(latest: number, base: number): number | null {
  if (Math.abs(base) < 0.0001) return null
  return ((latest - base) / Math.abs(base)) * 100
}

async function fetchSeries(config: SeriesConfig): Promise<LiquidityIndicator | null> {
  const key = process.env.FRED_API_KEY ?? ''
  const url = `https://api.stlouisfed.org/fred/series/observations?series_id=${config.seriesId}&api_key=${key}&sort_order=desc&limit=${config.limit}&file_type=json`
  try {
    const res = await fetch(url)
    if (!res.ok) {
      console.warn(`[liquidity] ${config.seriesId}: HTTP ${res.status}`)
      return null
    }
    const data = await res.json() as { observations: Array<{ date: string; value: string }> }
    const validObs = data.observations.filter(o => o.value !== '.')
    const values   = validObs.map(o => parseFloat(o.value))
    if (values.length < 1) return null

    const value       = values[0]
    const releaseDate = validObs[0]?.date ?? ''

    // 4-week lookback index: weekly=4, daily=28, monthly=null
    const idx4w = config.frequency === 'weekly' ? 4
                : config.frequency === 'daily'  ? 28
                : null

    // YoY lookback index
    const idxYoY = config.frequency === 'weekly'  ? 52
                 : config.frequency === 'daily'   ? 365
                 : 12

    const change4w  = idx4w != null && values[idx4w] != null
      ? value - values[idx4w]
      : null

    const changeYoY = values[idxYoY] != null
      ? pctChange(value, values[idxYoY])
      : null

    const signal = computeSignal(config.seriesId, change4w, changeYoY)

    return {
      seriesId:    config.seriesId,
      label:       config.label,
      value,
      releaseDate,
      unit:        'Billions USD',
      change4w,
      changeYoY,
      signal,
    }
  } catch (err) {
    console.warn(`[liquidity] ${config.seriesId}: fetch error`, err)
    return null
  }
}

export async function fetchLiquidityIndicators(): Promise<LiquidityIndicator[]> {
  const results = await Promise.all(SERIES.map(fetchSeries))
  return results.filter((r): r is LiquidityIndicator => r !== null)
}
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
cd /Users/thanapold/Desktop/Projects/macro-asset-monitor
npm test -- tests/liquidity-fetcher.test.ts --reporter=verbose 2>&1 | tail -15
```

Expected: 12 tests pass.

- [ ] **Step 6: Commit**

```bash
cd /Users/thanapold/Desktop/Projects/macro-asset-monitor
git add src/types.ts src/fetchers/liquidity-fetcher.ts tests/liquidity-fetcher.test.ts
git commit -m "feat(macro): add LiquidityIndicator types and liquidity-fetcher"
```

---

### Task 2: Wire liquidity into exporter and CLI

**Files:**
- Modify: `macro-asset-monitor/src/exporter.ts`
- Modify: `macro-asset-monitor/src/cli/cli-fetch.ts`
- Modify: `macro-asset-monitor/tests/exporter.test.ts`

- [ ] **Step 1: Write failing test for updated exporter**

In `macro-asset-monitor/tests/exporter.test.ts`, add a `liquidityIndicator` fixture and two new tests inside the `describe('buildMacro', ...)` block. Read the current test file first, then add:

```typescript
import type { LiquidityIndicator } from '../src/types.js'

const liquidityIndicator: LiquidityIndicator = {
  seriesId: 'WALCL', label: 'Fed Balance Sheet',
  value: 7200, releaseDate: '2026-05-22', unit: 'Billions USD',
  change4w: -85, changeYoY: -2.1, signal: 'draining',
}
```

Add to `describe('buildMacro', ...)`:

```typescript
it('includes liquidityIndicators in output', () => {
  const result = buildMacro([asset], [indicator], [liquidityIndicator])
  expect(result.liquidityIndicators).toHaveLength(1)
  expect(result.liquidityIndicators[0].seriesId).toBe('WALCL')
  expect(result.liquidityIndicators[0].signal).toBe('draining')
})

it('accepts empty liquidityIndicators array', () => {
  const result = buildMacro([asset], [indicator], [])
  expect(result.liquidityIndicators).toHaveLength(0)
})
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd /Users/thanapold/Desktop/Projects/macro-asset-monitor
npm test -- tests/exporter.test.ts --reporter=verbose 2>&1 | tail -10
```

Expected: FAIL — `buildMacro` does not accept a 3rd argument yet.

- [ ] **Step 3: Update `src/exporter.ts`**

Replace the full file with:

```typescript
import { writeFileSync, readFileSync, mkdirSync, existsSync } from 'fs'
import { dirname } from 'path'
import type { MarketAsset, EconomicIndicator, LiquidityIndicator, MacroJSON } from './types.js'

export function buildMacro(
  marketAssets: MarketAsset[],
  economicIndicators: EconomicIndicator[],
  liquidityIndicators: LiquidityIndicator[] = [],
): MacroJSON {
  return {
    exportedAt:          new Date().toISOString(),
    asOf:                new Date().toISOString().slice(0, 10),
    marketAssets,
    economicIndicators,
    liquidityIndicators,
  }
}

export function exportMacro(
  marketAssets: MarketAsset[],
  economicIndicators: EconomicIndicator[],
  outputPath: string,
  liquidityIndicators: LiquidityIndicator[] = [],
): MacroJSON {
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

  const macro = buildMacro(assets, economicIndicators, liquidityIndicators)
  mkdirSync(dirname(outputPath), { recursive: true })
  writeFileSync(outputPath, JSON.stringify(macro, null, 2), 'utf-8')
  return macro
}
```

- [ ] **Step 4: Update `src/cli/cli-fetch.ts`**

Replace the full file with:

```typescript
import 'dotenv/config'
import { join } from 'path'
import { fetchAllYahooAssets }     from '../fetchers/yahoo-fetcher.js'
import { fetchAllFredSeries }      from '../fetchers/fred-fetcher.js'
import { fetchLiquidityIndicators } from '../fetchers/liquidity-fetcher.js'
import { exportMacro }             from '../exporter.js'

const OUTPUT_PATH = join(process.cwd(), 'data/macro.json')

async function run() {
  const startTime = Date.now()
  console.log('[macro] Fetching macro asset data...')

  const [marketAssets, economicIndicators, liquidityIndicators] = await Promise.all([
    fetchAllYahooAssets(),
    fetchAllFredSeries(),
    fetchLiquidityIndicators(),
  ])

  console.log(`[macro] Market assets: ${marketAssets.length}`)
  console.log(`[macro] Economic indicators: ${economicIndicators.length}`)
  console.log(`[macro] Liquidity indicators: ${liquidityIndicators.length}/4`)

  const macro = exportMacro(marketAssets, economicIndicators, OUTPUT_PATH, liquidityIndicators)
  console.log(`[macro] Exported to ${OUTPUT_PATH}`)
  console.log(`[macro] asOf: ${macro.asOf}`)
  console.log(`[macro] Done in ${((Date.now() - startTime) / 1000).toFixed(1)}s`)
}

run().catch(err => { console.error('[macro] Fatal:', err); process.exit(1) })
```

- [ ] **Step 5: Run all tests to verify they pass**

```bash
cd /Users/thanapold/Desktop/Projects/macro-asset-monitor
npm test -- --reporter=verbose 2>&1 | tail -20
```

Expected: all tests pass including the 2 new exporter tests.

Note: the existing `exportMacro` tests call `exportMacro([asset], [indicator], tmpFile)` — the 4th param defaults to `[]`, so they should still pass unchanged.

- [ ] **Step 6: Commit**

```bash
cd /Users/thanapold/Desktop/Projects/macro-asset-monitor
git add src/exporter.ts src/cli/cli-fetch.ts tests/exporter.test.ts
git commit -m "feat(macro): wire liquidityIndicators into exporter and cli-fetch"
```

---

### Task 3: Add LiquidityContext + formatLiquidity to regime-analyzer

**Files:**
- Modify: `ai-analysis-engine/src/analysis/regime-analyzer.ts`

- [ ] **Step 1: Write the failing test**

Check if `ai-analysis-engine` has a tests folder:

```bash
ls /Users/thanapold/Desktop/Projects/ai-analysis-engine/tests/ 2>/dev/null || echo "no tests dir"
```

If no tests folder, create `ai-analysis-engine/tests/regime-analyzer.test.ts`. If it exists, add to the existing test file.

Create (or add to) `ai-analysis-engine/tests/regime-analyzer.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { formatLiquidity } from '../src/analysis/regime-analyzer.js'
import type { LiquidityContext } from '../src/analysis/regime-analyzer.js'

const mockLiquidity: LiquidityContext = {
  asOf: '2026-05-29',
  indicators: [
    {
      seriesId: 'WALCL', label: 'Fed Balance Sheet',
      value: 7200, unit: 'Billions USD',
      change4w: -85, changeYoY: -2.1, signal: 'draining',
    },
    {
      seriesId: 'WTREGEN', label: 'Treasury General Account',
      value: 850, unit: 'Billions USD',
      change4w: 120, changeYoY: null, signal: 'draining',
    },
    {
      seriesId: 'RRPONTSYD', label: 'Overnight Reverse Repo',
      value: 400, unit: 'Billions USD',
      change4w: -180, changeYoY: null, signal: 'injecting',
    },
    {
      seriesId: 'M2SL', label: 'M2 Money Supply',
      value: 21000, unit: 'Billions USD',
      change4w: null, changeYoY: 1.2, signal: 'injecting',
    },
  ],
}

describe('formatLiquidity', () => {
  it('includes header with asOf date', () => {
    const result = formatLiquidity(mockLiquidity)
    expect(result).toContain('2026-05-29')
    expect(result).toContain('Global Liquidity Conditions')
  })

  it('shows DRAINING for draining signals', () => {
    const result = formatLiquidity(mockLiquidity)
    expect(result).toContain('DRAINING')
  })

  it('shows INJECTING for injecting signals', () => {
    const result = formatLiquidity(mockLiquidity)
    expect(result).toContain('INJECTING')
  })

  it('shows 4w change with sign for non-null change4w', () => {
    const result = formatLiquidity(mockLiquidity)
    expect(result).toContain('4w: -85.0B')
  })

  it('shows YoY for M2SL', () => {
    const result = formatLiquidity(mockLiquidity)
    expect(result).toContain('YoY: +1.20%')
  })

  it('shows net summary — Net: MIXED/NEUTRAL when 2 draining and 2 injecting', () => {
    const result = formatLiquidity(mockLiquidity)
    expect(result).toContain('Net: MIXED/NEUTRAL')
  })

  it('shows Net: TIGHTENING when majority draining', () => {
    const drainingCtx: LiquidityContext = {
      asOf: '2026-05-29',
      indicators: [
        { seriesId: 'WALCL',     label: 'Fed BS',  value: 7200, unit: 'Billions USD', change4w: -85,  changeYoY: null, signal: 'draining' },
        { seriesId: 'WTREGEN',   label: 'TGA',     value: 850,  unit: 'Billions USD', change4w: 120,  changeYoY: null, signal: 'draining' },
        { seriesId: 'RRPONTSYD', label: 'RRP',     value: 400,  unit: 'Billions USD', change4w: 180,  changeYoY: null, signal: 'draining' },
        { seriesId: 'M2SL',      label: 'M2',      value: 21000,unit: 'Billions USD', change4w: null, changeYoY: 0.2,  signal: 'neutral'  },
      ],
    }
    expect(formatLiquidity(drainingCtx)).toContain('Net: TIGHTENING')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd /Users/thanapold/Desktop/Projects/ai-analysis-engine
npm test -- tests/regime-analyzer.test.ts --reporter=verbose 2>&1 | tail -10
```

Expected: FAIL — `formatLiquidity` not exported.

- [ ] **Step 3: Update `src/analysis/regime-analyzer.ts`**

Make these 5 changes to the file:

**Change 1** — Add `LiquidityContext` interface after `MacroContext` (around line 28):

```typescript
export interface LiquidityContext {
  asOf: string
  indicators: Array<{
    seriesId:  string
    label:     string
    value:     number
    unit:      string
    change4w:  number | null
    changeYoY: number | null
    signal:    'draining' | 'neutral' | 'injecting'
  }>
}
```

**Change 2** — Update `SYSTEM_PROMPT` constant. Replace the two-source version:

```typescript
const SYSTEM_PROMPT = `You are a macro technology investment analyst.
Classify the current investment regime using the classify_macro_regime tool.

You have three signal sources:
1. Company health signals — thesis assumption status and recent documents per company
2. World intelligence — live geopolitical events and market events ranked by severity
3. Global liquidity conditions — Fed balance sheet (QE/QT), Treasury issuance (TGA), reverse repo
   drainage, and M2 growth. Contracting liquidity compresses equity multiples even when company
   fundamentals are strong. When liquidity conditions are driving or modifying your assessment,
   say so explicitly in the rationale field.

Weight them together: company signals reveal sector-level dynamics; world events set the macro risk
backdrop; liquidity conditions determine whether multiple expansion or compression is likely.

Regime taxonomy examples (you may coin a new label when none fit):
- AI Acceleration: broad AI infrastructure spending up, GPU demand strong
- Semiconductor Correction: inventory excess, CapEx pullback across fab customers
- Cloud Consolidation: hyperscalers slowing new commitments, renegotiating contracts
- Energy Bottleneck: data center buildout constrained by power availability
- AI Commoditization: model costs falling, compute demand shifting to inference
- Stagflationary Pressure: rate risk rising, macro headwinds compressing multiples`
```

**Change 3** — Add `formatLiquidity` function (exported) after `formatWorldIntel`:

```typescript
export function formatLiquidity(liq: LiquidityContext): string {
  const SIGNAL = (s: string) => s === 'draining' ? '⬇ DRAINING' : s === 'injecting' ? '⬆ INJECTING' : '→ NEUTRAL'
  const lines = liq.indicators.map(i => {
    const c4w = i.change4w  != null ? ` | 4w: ${i.change4w >= 0 ? '+' : ''}${i.change4w.toFixed(1)}B` : ''
    const yoy = i.changeYoY != null ? ` | YoY: ${i.changeYoY >= 0 ? '+' : ''}${i.changeYoY.toFixed(2)}%` : ''
    return `${i.label.padEnd(28)}: $${i.value.toFixed(0)}B${c4w}${yoy} [${SIGNAL(i.signal)}]`
  })
  const draining  = liq.indicators.filter(i => i.signal === 'draining').length
  const injecting = liq.indicators.filter(i => i.signal === 'injecting').length
  const summary   = draining > injecting ? 'Net: TIGHTENING' : injecting > draining ? 'Net: EASING' : 'Net: MIXED/NEUTRAL'
  return `## Global Liquidity Conditions (as of ${liq.asOf})\n${lines.join('\n')}\n${summary}`
}
```

**Change 4** — Extend `analyzeRegime` signature to accept `liquidityContext`:

```typescript
export async function analyzeRegime(
  health: CompanyHealth[],
  options: {
    client?: Anthropic
    worldIntel?: WorldIntelContext
    macroAssets?: MacroContext
    liquidityContext?: LiquidityContext
  } = {},
): Promise<MacroRegime>
```

**Change 5** — Add liquidity section to prompt construction. In `analyzeRegime`, after `const worldSection = ...`:

```typescript
const liquiditySection = options.liquidityContext
  ? `\n\n${formatLiquidity(options.liquidityContext)}`
  : ''
```

And update the messages content to include it:

```typescript
content: `Classify the current macro regime.\n\n## Company Health Signals (${health.length} companies)\n${formatHealth(health)}${macroSection}${liquiditySection}${worldSection}`,
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd /Users/thanapold/Desktop/Projects/ai-analysis-engine
npm test -- --reporter=verbose 2>&1 | tail -20
```

Expected: all tests pass including the 7 new `formatLiquidity` tests.

- [ ] **Step 5: Commit**

```bash
cd /Users/thanapold/Desktop/Projects/ai-analysis-engine
git add src/analysis/regime-analyzer.ts tests/regime-analyzer.test.ts
git commit -m "feat(ai-engine): add LiquidityContext, formatLiquidity, extend analyzeRegime"
```

---

### Task 4: Wire liquidityContext into cli-run.ts

**Files:**
- Modify: `ai-analysis-engine/src/cli/cli-run.ts`

- [ ] **Step 1: Update imports in `src/cli/cli-run.ts`**

Add `LiquidityContext` to the import from `regime-analyzer`:

```typescript
import type { WorldIntelContext, LiquidityContext } from '../analysis/regime-analyzer.js'
```

- [ ] **Step 2: Add `loadLiquidityContext()` function**

Add after `loadMacroAssets()` (around line 29):

```typescript
function loadLiquidityContext(): LiquidityContext | undefined {
  try {
    if (!existsSync(MACRO_PATH)) return undefined
    const macro = JSON.parse(readFileSync(MACRO_PATH, 'utf-8'))
    if (!Array.isArray(macro.liquidityIndicators) || macro.liquidityIndicators.length === 0) return undefined
    return { asOf: macro.asOf, indicators: macro.liquidityIndicators }
  } catch {
    return undefined
  }
}
```

- [ ] **Step 3: Call it and pass to analyzeRegime**

In `run()`, after `const macroAssets = loadMacroAssets()` block, add:

```typescript
const liquidityContext = loadLiquidityContext()
if (liquidityContext) {
  console.log(`  Liquidity: ${liquidityContext.indicators.length} indicators (as of ${liquidityContext.asOf})`)
} else {
  console.log('  Liquidity: not available')
}
```

Update the `analyzeRegime` call:

```typescript
const regime = await analyzeRegime(health, { worldIntel, macroAssets, liquidityContext })
```

- [ ] **Step 4: Verify TypeScript compiles**

```bash
cd /Users/thanapold/Desktop/Projects/ai-analysis-engine
npx tsc --noEmit 2>&1 | head -20
```

Expected: no errors.

- [ ] **Step 5: Run all tests**

```bash
cd /Users/thanapold/Desktop/Projects/ai-analysis-engine
npm test -- --reporter=verbose 2>&1 | tail -10
```

Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
cd /Users/thanapold/Desktop/Projects/ai-analysis-engine
git add src/cli/cli-run.ts
git commit -m "feat(ai-engine): load liquidityContext from macro.json and pass to analyzeRegime"
```

---

### Task 5: Fetch fresh liquidity data and smoke-test end-to-end

**Files:** No code changes — runs CLI commands against live APIs.

- [ ] **Step 1: Fetch updated macro data including liquidity**

```bash
cd /Users/thanapold/Desktop/Projects/macro-asset-monitor
npm run fetch 2>&1 | grep -E "Liquidity|Error|Done"
```

Expected output includes:
```
[macro] Liquidity indicators: 4/4
[macro] Done in X.Xs
```

If only 3/4 or 2/4 — that's acceptable if FRED has partial data. If 0/4, check `FRED_API_KEY` in `.env`.

- [ ] **Step 2: Verify macro.json has liquidityIndicators**

```bash
node -e "const m = require('/Users/thanapold/Desktop/Projects/macro-asset-monitor/data/macro.json'); console.log('liquidity count:', m.liquidityIndicators?.length); m.liquidityIndicators?.forEach(i => console.log(i.seriesId, i.signal, i.value?.toFixed(0) + 'B'))"
```

Expected: 4 lines showing each series with its signal.

- [ ] **Step 3: Verify ai-analysis-engine reads it**

```bash
cd /Users/thanapold/Desktop/Projects/ai-analysis-engine
node -e "
const { existsSync, readFileSync } = require('fs');
const { join } = require('path');
const MACRO_PATH = join(process.cwd(), '../macro-asset-monitor/data/macro.json');
const macro = JSON.parse(readFileSync(MACRO_PATH, 'utf-8'));
console.log('asOf:', macro.asOf);
console.log('liquidityIndicators:', macro.liquidityIndicators?.length);
"
```

Expected: prints `asOf:` today's date and `liquidityIndicators: 4`.

- [ ] **Step 4: No commit needed** — Task 5 is operational verification only.
