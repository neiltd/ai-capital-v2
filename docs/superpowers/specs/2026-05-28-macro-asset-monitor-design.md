# Macro Asset Monitor — Design Spec

## Goal

Fetch daily closing prices for 11 macro market assets (Yahoo Finance) and latest values for 6 economic indicators (FRED API), export a single `macro.json`, and surface that data in two places: the `ai-analysis-engine` regime prompt and a new `/capital/macro` dashboard page in `unified-platform`.

## Problem Being Solved

The current regime analyzer infers macro conditions from news text and geopolitical events. It does not see actual price data — it doesn't know that the US 10Y yield rose 42bps in 30 days, that the dollar is strengthening, or that credit card delinquency rates are at a 10-year high. Adding this layer replaces inference with observation, materially improving regime detection accuracy.

## Architecture

New standalone TypeScript project `macro-asset-monitor`, following the same pattern as all sibling projects. Runs as step 1.5 in `daily.sh` — after world-intelligence-data-hub (step 1) and before capital-intelligence-ingestion (step 2).

```
world-intelligence (step 1)
  → macro-asset-monitor (step 1.5)  ← NEW
    → capital-intelligence-ingestion (step 2)
      → ai-analysis-engine (step 3)   ← reads macro.json
        → scenario-simulator (step 4)
          → ...
            → investment-analyst-agents (step 8+9)
```

`unified-platform` reads `macro.json` at page render time (server component, `force-dynamic`).

## Data Sources

### Yahoo Finance (no API key)

Endpoint: `https://query1.finance.yahoo.com/v8/finance/chart/{ticker}?interval=1d&range=35d`

Returns OHLCV history for the last 35 days. The fetcher takes the most recent complete trading day's close, plus closes from 5 and 30 days prior, to compute momentum.

| Label | Yahoo Ticker | Category |
|---|---|---|
| US 10Y Yield | `^TNX` | rates |
| US 2Y Yield | `^FVX` | rates |
| Dollar Index | `DX-Y.NYB` | dollar |
| WTI Crude Oil | `CL=F` | commodities |
| Gold | `GC=F` | commodities |
| Copper | `HG=F` | commodities |
| VIX | `^VIX` | volatility |
| Nikkei 225 | `^N225` | global-equity |
| DAX | `^GDAXI` | global-equity |
| Hang Seng | `^HSI` | global-equity |
| HYG (High Yield ETF) | `HYG` | credit |

### FRED API (free key required)

Endpoint: `https://api.stlouisfed.org/fred/series/observations?series_id={id}&api_key={key}&sort_order=desc&limit=2&file_type=json`

Fetches the two most recent observations for each series; uses the latest non-null value and its release date. When the latest observation has no value yet (FRED uses `.` for unreleased), falls back to the previous one.

| Label | Series ID | Cadence | Relevance |
|---|---|---|---|
| CPI YoY % | `CPIAUCSL` | Monthly | Inflation regime signal |
| JOLTS Job Openings | `JTSJOL` | Monthly | Labour demand |
| Unemployment Rate | `UNRATE` | Monthly | Labour supply |
| Consumer Sentiment (UMich) | `UMCSENT` | Monthly | Consumer confidence |
| Credit Card Delinquency | `DRCCLACBS` | Quarterly | Consumer stress |
| Mortgage Delinquency | `DRSFRMACBS` | Quarterly | Housing / credit stress |

Trend for FRED series is computed by comparing the latest value to the previous observation: rising / falling / stable (within ±0.05).

## `macro.json` Schema

Written to `macro-asset-monitor/data/macro.json`.

```typescript
interface MacroJSON {
  exportedAt: string          // ISO timestamp of fetch run
  asOf: string                // YYYY-MM-DD of the market close date used
  marketAssets: MarketAsset[]
  economicIndicators: EconomicIndicator[]
}

interface MarketAsset {
  ticker:      string         // Yahoo ticker
  label:       string         // Human label e.g. "US 10Y Yield"
  category:    'rates' | 'dollar' | 'commodities' | 'volatility' | 'global-equity' | 'credit'
  close:       number         // Most recent daily close
  change1d:    number         // Absolute change vs previous close
  changePct1d: number         // % change 1 day
  changePct5d: number         // % change 5 trading days
  changePct30d: number        // % change 30 trading days
  trend:       'rising' | 'falling' | 'stable'  // based on 5d direction
}

interface EconomicIndicator {
  seriesId:    string         // FRED series ID
  label:       string         // Human label
  category:    'inflation' | 'labour' | 'consumer' | 'credit'
  value:       number         // Latest available value
  releaseDate: string         // YYYY-MM-DD of this observation
  unit:        string         // e.g. "Percent", "Thousands"
  trend:       'rising' | 'falling' | 'stable'
}
```

`trend` for market assets uses 5-day % change: rising if > +0.5%, falling if < -0.5%, stable otherwise. Rate assets (^TNX, ^FVX) use absolute bps change instead of percent.

## Project Structure

```
macro-asset-monitor/
  src/
    fetchers/
      yahoo-fetcher.ts      — fetch 35d OHLCV, compute 1d/5d/30d changes
      fred-fetcher.ts       — fetch latest 2 observations, extract value + trend
    exporter.ts             — merge results, write macro.json
    cli/
      cli-fetch.ts          — entry point
    types.ts                — MarketAsset, EconomicIndicator, MacroJSON
  data/
    macro.json              — gitignored
  .env                      — FRED_API_KEY=8e85...
  .gitignore
  package.json
  tsconfig.json
```

**Dependencies:** `dotenv`, `tsx` (dev), `typescript` (dev). Native `fetch` only — no HTTP library.

**Scripts:**
- `npm run fetch` — run cli-fetch.ts

## Integration: `ai-analysis-engine`

### File change: `src/cli/cli-run.ts`

Add `MACRO_PATH = join(process.cwd(), '../macro-asset-monitor/data/macro.json')`.

Load macro.json with graceful fallback (missing file → undefined, logged as warning).

Pass it to `analyzeRegime()` as a new optional `macroAssets` field on the context object.

### File change: `src/analysis/regime-analyzer.ts`

Extend `WorldIntelContext` interface:
```typescript
macroAssets?: MacroContext
```

Where `MacroContext` mirrors the `MacroJSON` shape (imported by value, not by cross-project import — copy the types inline in `regime-analyzer.ts`).

Add a `formatMacroAssets(macro: MacroContext): string` function that produces a compact text block:

```
## Macro Asset Prices (as of 2026-05-27)
RATES      : US10Y 4.61% (+6bps 1d, +42bps 30d ↑) | US2Y 4.91% (+3bps 1d ↑)
DOLLAR     : DXY 104.2 (+0.3% 1d, +2.1% 30d ↑)
COMMODITIES: WTI $78.4 (-1.2% 1d ↓) | Gold $2,340 (+0.4% 1d →) | Copper $4.21 (-0.8% 1d ↓)
VOLATILITY : VIX 18.4 (+5% 1d ↑)
GLOBAL     : Nikkei -0.8% 1d | DAX -0.4% 1d | HSI -1.1% 1d
CREDIT     : HYG $77.2 (-0.3% 1d ↓)

## Economic Indicators (latest available)
CPI YoY          : 3.4% [2026-05-14, rising ↑]
JOLTS Openings   : 8.49M [2026-05-07, falling ↓]
Unemployment     : 3.9% [2026-05-03, rising ↑]
Consumer Sentiment: 67.4 [2026-05-17, falling ↓]
CC Delinquency   : 3.16% [2026-03-31, rising ↑]
Mortgage Delinquency: 1.72% [2026-03-31, stable →]
```

This block is prepended to the regime prompt before company health data.

## Integration: `unified-platform`

### New page: `src/app/capital/macro/page.tsx`

Server component with `export const dynamic = 'force-dynamic'`.

Reads `macro.json` from `DATA_ROOT/macro-asset-monitor/data/macro.json`.

**Layout:**

**Section 1 — Market Pulse**
A 2-row grid of asset cards (6 per row on desktop). Each card shows:
- Label (e.g. "US 10Y Yield")
- Current value (formatted: yields as `4.61%`, prices as `$2,340`, VIX as `18.4`)
- 1d change with color: green if positive, red if negative, muted if near zero
- 5d and 30d change as smaller secondary text
- Trend arrow (↑ ↓ →)
- Category badge

**Section 2 — Economic Indicators**
A table with columns: Indicator | Value | Released | Trend. Delinquency rows highlighted amber when > 2.5% (credit card) or > 1.5% (mortgage). Unemployment highlighted amber when > 4.5%.

### TopNav update

Add "Macro" link to the existing nav alongside Briefing, Portfolio, etc.

## `daily.sh` change

Add step 1.5 between world-intelligence and capital-intelligence:

```bash
log "[1.5/9] Macro Asset Monitor — fetch"
cd "$ROOT/macro-asset-monitor"
npm run fetch 2>&1 | tee -a "$LOG"
```

Steps renumber to 1–10: world-intelligence stays step 1, macro-asset-monitor becomes step 2, capital-intelligence becomes step 3, and so on through act at step 10.

## Error Handling

- Yahoo Finance fetch failure for a single ticker: log a warning, set that asset's fields to `null`, continue. The exporter writes whatever was successfully fetched.
- FRED fetch failure for a single series: same — log warning, omit that indicator from the export.
- If Yahoo Finance returns no data (market closed, weekend): the exporter uses the most recent cached values from the previous `macro.json` if it exists, with `asOf` unchanged.
- If `macro.json` is missing when `ai-analysis-engine` runs: the macro context block is omitted from the prompt; regime analysis proceeds without it (same as today's behavior).

## Testing

- Unit test for `yahoo-fetcher.ts`: mock `fetch`, verify it extracts close, computes 1d/5d/30d changes and trend correctly.
- Unit test for `fred-fetcher.ts`: mock `fetch`, verify it picks the latest non-`.` observation, computes trend from previous observation.
- Unit test for `exporter.ts`: given mock fetcher outputs, verify the written JSON matches the schema.
- Integration smoke test: real fetch of `^TNX` from Yahoo and `UNRATE` from FRED, assert result has `close > 0` and `value > 0`.
