# Global Liquidity Monitor Design

## Goal

Add 4 FRED liquidity series to the macro pipeline as a silent signal layer. The data feeds into the ai-analysis-engine's regime classification so that when global liquidity conditions are driving the market outlook, the regime rationale explicitly says so. No new UI — the output appears in the existing Briefing page rationale.

## Architecture

Changes to 2 projects only:

1. **macro-asset-monitor** — fetch 4 FRED series, compute changes, derive signal, add to `macro.json`
2. **ai-analysis-engine** — read liquidity from `macro.json`, inject as 3rd signal source into regime prompt

`macro.json` is already the bridge between these two projects — `cli-run.ts` reads it and passes it to `analyzeRegime()`. Liquidity simply extends that existing path.

## The 4 Liquidity Series

| FRED Series | Label | Frequency | Unit | Signal logic |
|-------------|-------|-----------|------|-------------|
| WALCL | Fed Balance Sheet | Weekly | Billions USD | Falling 4w → `draining`; rising → `injecting` |
| WTREGEN | Treasury General Account | Weekly | Billions USD | Rising 4w → `draining`; falling → `injecting` |
| RRPONTSYD | Overnight Reverse Repo | Daily | Billions USD | Rising 4w → `draining`; falling → `injecting` |
| M2SL | M2 Money Supply | Monthly | Billions USD | YoY negative → `draining`; positive → `injecting` |

Signal thresholds (avoid noise):
- WALCL / WTREGEN / RRPONTSYD: `draining` if 4w change < −$20B; `injecting` if > +$20B; else `neutral`
- M2SL: `draining` if YoY < −0.5%; `injecting` if > +1.0%; else `neutral`

## Component Changes

### 1. macro-asset-monitor

**New type — `src/types.ts`:**
```typescript
export type LiquiditySignal = 'draining' | 'neutral' | 'injecting'

export interface LiquidityIndicator {
  seriesId:    string         // WALCL, WTREGEN, RRPONTSYD, M2SL
  label:       string
  value:       number         // latest observation, billions USD
  releaseDate: string         // YYYY-MM-DD of latest observation
  unit:        string         // 'Billions USD'
  change4w:    number | null  // change from 4 weeks ago (null for monthly M2SL)
  changeYoY:   number | null  // % change year-over-year
  signal:      LiquiditySignal
}

// Extend MacroJSON:
export interface MacroJSON {
  exportedAt:          string
  asOf:                string
  marketAssets:        MarketAsset[]
  economicIndicators:  EconomicIndicator[]
  liquidityIndicators: LiquidityIndicator[]   // NEW
}
```

**New file — `src/fetchers/liquidity-fetcher.ts`:**

Fetches each series from FRED using the existing `FRED_API_KEY` env var. Observation limits:
- WALCL: `limit=56` (weekly, covers ~1yr for YoY + 4w change)
- WTREGEN: `limit=56`
- RRPONTSYD: `limit=365` (daily, covers 1yr)
- M2SL: `limit=14` (monthly, covers ~1yr for YoY)

```typescript
const SERIES: Array<{
  seriesId: string; label: string; limit: number
  frequency: 'daily' | 'weekly' | 'monthly'
  computeSignal: (change4w: number | null, changeYoY: number | null) => LiquiditySignal
}> = [
  {
    seriesId: 'WALCL', label: 'Fed Balance Sheet', limit: 56, frequency: 'weekly',
    computeSignal: (c4w) => c4w == null ? 'neutral' : c4w < -20 ? 'draining' : c4w > 20 ? 'injecting' : 'neutral',
  },
  {
    seriesId: 'WTREGEN', label: 'Treasury General Account', limit: 56, frequency: 'weekly',
    computeSignal: (c4w) => c4w == null ? 'neutral' : c4w > 20 ? 'draining' : c4w < -20 ? 'injecting' : 'neutral',
  },
  {
    seriesId: 'RRPONTSYD', label: 'Overnight Reverse Repo', limit: 365, frequency: 'daily',
    computeSignal: (c4w) => c4w == null ? 'neutral' : c4w > 20 ? 'draining' : c4w < -20 ? 'injecting' : 'neutral',
  },
  {
    seriesId: 'M2SL', label: 'M2 Money Supply', limit: 14, frequency: 'monthly',
    computeSignal: (_c4w, yoy) => yoy == null ? 'neutral' : yoy < -0.5 ? 'draining' : yoy > 1.0 ? 'injecting' : 'neutral',
  },
]

export async function fetchLiquidityIndicators(): Promise<LiquidityIndicator[]>
```

For 4-week lookback:
- Weekly series: compare obs[0] to obs[4]
- Daily series: compare obs[0] to obs[28] (28 calendar days ≈ 4 weeks)
- Monthly series: no 4w change (null); use YoY only (obs[0] vs obs[12])

For YoY:
- Weekly: obs[0] vs obs[52]
- Daily: obs[0] vs obs[365]
- Monthly: obs[0] vs obs[12]

Values filtered for null/missing before indexing. Returns empty array on any FRED error (never throws — analysis continues without liquidity context if FRED is down).

**Update `src/cli/cli-fetch.ts`:**
```typescript
import { fetchLiquidityIndicators } from '../fetchers/liquidity-fetcher.js'

// In the fetch run:
const liquidityIndicators = await fetchLiquidityIndicators()
console.log(`[macro] Liquidity indicators: ${liquidityIndicators.length}/4`)

// Include in MacroJSON export:
const output: MacroJSON = {
  exportedAt, asOf,
  marketAssets,
  economicIndicators,
  liquidityIndicators,   // NEW
}
```

### 2. ai-analysis-engine

**Update `src/analysis/regime-analyzer.ts`:**

Add interface:
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

Add formatter:
```typescript
function formatLiquidity(liq: LiquidityContext): string {
  const SIGNAL = (s: string) => s === 'draining' ? '⬇ DRAINING' : s === 'injecting' ? '⬆ INJECTING' : '→ NEUTRAL'
  const lines = liq.indicators.map(i => {
    const c4w  = i.change4w  != null ? ` | 4w: ${i.change4w >= 0 ? '+' : ''}${i.change4w.toFixed(1)}B` : ''
    const yoy  = i.changeYoY != null ? ` | YoY: ${i.changeYoY >= 0 ? '+' : ''}${i.changeYoY.toFixed(2)}%` : ''
    return `${i.label.padEnd(28)}: $${i.value.toFixed(0)}B${c4w}${yoy} [${SIGNAL(i.signal)}]`
  })
  const draining  = liq.indicators.filter(i => i.signal === 'draining').length
  const injecting = liq.indicators.filter(i => i.signal === 'injecting').length
  const summary   = draining > injecting ? 'Net: TIGHTENING' : injecting > draining ? 'Net: EASING' : 'Net: MIXED/NEUTRAL'
  return `## Global Liquidity Conditions (as of ${liq.asOf})\n${lines.join('\n')}\n${summary}`
}
```

Extend `analyzeRegime()` options:
```typescript
export async function analyzeRegime(
  health: CompanyHealth[],
  options: {
    client?: Anthropic
    worldIntel?: WorldIntelContext
    macroAssets?: MacroContext
    liquidityContext?: LiquidityContext   // NEW
  } = {},
): Promise<MacroRegime>
```

Add to prompt construction:
```typescript
const liquiditySection = options.liquidityContext
  ? `\n\n${formatLiquidity(options.liquidityContext)}`
  : ''

// In messages[0].content:
`...${macroSection}${liquiditySection}${worldSection}`
```

Update `SYSTEM_PROMPT` to add liquidity as a 3rd signal source:
```
You have three signal sources:
1. Company health signals — thesis assumption status and recent documents per company
2. World intelligence — live geopolitical events and market events ranked by severity
3. Global liquidity conditions — Fed balance sheet (QE/QT), Treasury issuance (TGA), reverse repo
   drainage, and M2 growth. Contracting liquidity compresses equity multiples even when company
   fundamentals are strong. When liquidity conditions are driving or modifying your assessment,
   say so explicitly in the rationale field.
```

**Update `src/cli/cli-run.ts`:**
```typescript
// MacroContext type already has liquidityIndicators on the JSON — extract it:
function loadLiquidityContext(): LiquidityContext | undefined {
  try {
    if (!existsSync(MACRO_PATH)) return undefined
    const macro = JSON.parse(readFileSync(MACRO_PATH, 'utf-8'))
    if (!macro.liquidityIndicators?.length) return undefined
    return { asOf: macro.asOf, indicators: macro.liquidityIndicators }
  } catch {
    return undefined
  }
}

// In run():
const liquidityContext = loadLiquidityContext()
if (liquidityContext) {
  console.log(`  Liquidity: ${liquidityContext.indicators.length} indicators (as of ${liquidityContext.asOf})`)
} else {
  console.log('  Liquidity: not available')
}
const regime = await analyzeRegime(health, { worldIntel, macroAssets, liquidityContext })
```

## What the Rationale Looks Like

When liquidity is tightening, the regime rationale will include language like:

> "...However, global liquidity is tightening: Fed balance sheet declined $85B over 4 weeks (QT ongoing), Treasury issued $120B in T-bills pulling cash from markets, and M2 growth is decelerating to +1.2% YoY. RRP drainage ($180B) partially offsets this, but net liquidity is a headwind. Multiple compression risk rises if QT continues at this pace."

The `keyIndicators` array will also include items like `"Fed QT: -$85B/4w"` and `"TGA rising: liquidity drain"` when relevant.

## Operational Notes

- `npm run fetch` in macro-asset-monitor already runs daily. Liquidity fetching is added to that same run — no new scheduler needed.
- FRED API key is already in macro-asset-monitor's `.env` as `FRED_API_KEY`.
- If FRED is unreachable, `fetchLiquidityIndicators()` returns `[]` and `macro.json` is written with `liquidityIndicators: []`. The analysis engine sees an empty array and skips the liquidity section — no crash, no stale data.
- All 4 series are free-tier FRED endpoints. No additional API cost.
