# Government Money Flow Monitor Design

## Goal

Track where federal money is going — both recent contract awards (backward-looking) and budget/appropriations signals (forward-looking) — and inject this as a 4th signal source into the ai-analysis-engine's regime classification. When government capital is flowing toward sectors or companies in the watchlist, the regime rationale says so explicitly.

## Architecture

One new standalone project (`government-flow-monitor`) plus small changes to `ai-analysis-engine`. The capital-intel-dashboard requires no changes — the improved reasoning appears automatically in the existing Briefing page rationale.

```
government-flow-monitor/
  src/
    fetchers/
      awards-fetcher.ts     # USASpending.gov API — recent contract awards
      budget-fetcher.ts     # Congress.gov API — appropriations + NDAA + AI bills
    summarizer.ts           # Claude Haiku — summarize bills, map to tickers
    types.ts
    exporter.ts
    cli/
      cli-fetch.ts          # npm run fetch
  data/
    govflow.json            # gitignored
  .env                      # CONGRESS_API_KEY, ANTHROPIC_API_KEY
  package.json
```

`govflow.json` path: `government-flow-monitor/data/govflow.json`
`ai-analysis-engine` reads it at: `../government-flow-monitor/data/govflow.json`

## Data Sources

**USASpending.gov** (Track 1 — awards)
- Base URL: `https://api.usaspending.gov/api/v2/`
- No API key required
- Endpoints used:
  - `POST /search/spending_by_award/` — search contracts by recipient name
  - `POST /search/spending_by_category/awarding_agency/` — top agencies by spend

**Congress.gov** (Track 2 — budget signals)
- Base URL: `https://api.congress.gov/v3/`
- Free API key required — register at `https://api.congress.gov/sign-up/`
- Env var: `CONGRESS_API_KEY`
- Endpoints used:
  - `GET /bill?congress=119&sort=updateDate+desc` — recent bills
  - Filter for bill titles containing: `appropriations`, `defense authorization`, `infrastructure`, `CHIPS`, `artificial intelligence`

**Claude Haiku** (budget summarizer)
- Model: `claude-haiku-4-5-20251001`
- Used only for budget signals (bill summaries → structured extraction)
- Not used for awards (structured JSON from USASpending, no AI needed)
- Estimated cost: ~$0.02/month (5–10 bills/week × ~3K tokens each)

## Types — `src/types.ts`

```typescript
export interface WatchlistAward {
  ticker:      string
  company:     string
  total30d:    number           // total award value in dollars, last 30 days
  awardCount:  number
  topAgency:   string
  contracts:   string[]        // top 3 contract descriptions, truncated to 120 chars
}

export interface AgencyFlow {
  agency:      string
  agencyId:    string
  total30d:    number
  trend:       'rising' | 'stable' | 'falling'  // vs prior 30d period
}

export interface BudgetSignal {
  billNumber:       string       // e.g. "HR 2670"
  title:            string
  congress:         number       // e.g. 119
  status:           string       // e.g. "passed", "committee", "introduced"
  date:             string       // YYYY-MM-DD of latest action
  summary:          string       // Claude-generated 2-3 sentence summary
  relevantTickers:  string[]     // watchlist tickers that benefit
  totalFunding:     number | null
  keyProvisions:    string[]     // 2-4 bullet points on what's funded
}

export interface GovFlowJSON {
  exportedAt:      string
  asOf:            string
  watchlistAwards: WatchlistAward[]
  agencyFlows:     AgencyFlow[]
  budgetSignals:   BudgetSignal[]
}
```

## awards-fetcher.ts

```typescript
// Watchlist companies to search — loaded from ../capital-intelligence-ingestion/data/sqlite.db
// Falls back to hardcoded list if DB unavailable
const FALLBACK_COMPANIES = [
  { ticker: 'MSFT', searchName: 'MICROSOFT' },
  { ticker: 'NVDA', searchName: 'NVIDIA' },
  { ticker: 'GOOGL', searchName: 'GOOGLE' },
  { ticker: 'AMZN', searchName: 'AMAZON' },
  { ticker: 'META', searchName: 'META PLATFORMS' },
  { ticker: 'AAPL', searchName: 'APPLE' },
  { ticker: 'PLTR', searchName: 'PALANTIR' },
  { ticker: 'JPM', searchName: 'JPMORGAN' },
  { ticker: 'BAC', searchName: 'BANK OF AMERICA' },
  { ticker: 'GS', searchName: 'GOLDMAN SACHS' },
]

export async function fetchWatchlistAwards(): Promise<WatchlistAward[]>
// POST /search/spending_by_award/ with recipient_search_text=[searchName]
// date range: last 30 days
// award_type_codes: ["A","B","C","D"] (contracts only, not grants)
// Returns [] for any company with no awards (not an error)

export async function fetchAgencyFlows(): Promise<AgencyFlow[]>
// POST /search/spending_by_category/awarding_agency/ for last 30 days
// POST again for prior 30 days to compute trend
// Returns top 8 agencies by total spend
// trend: 'rising' if current > prior * 1.1, 'falling' if < prior * 0.9, else 'stable'
```

Both functions return empty arrays on any network or API error — never throw.

## budget-fetcher.ts

```typescript
const RELEVANT_KEYWORDS = [
  'appropriations', 'defense authorization', 'infrastructure',
  'artificial intelligence', 'CHIPS', 'energy', 'semiconductor',
  'cybersecurity', 'national security',
]

export async function fetchRecentBills(): Promise<Array<{ number: string; title: string; url: string; status: string; date: string }>>
// GET /bill?congress=119&billType=hr&sort=updateDate+desc&limit=50
// GET /bill?congress=119&billType=s&sort=updateDate+desc&limit=50
// Filter: title contains any RELEVANT_KEYWORD (case-insensitive)
// Return at most 10 matches (most recent first)
// Returns [] on error
```

## summarizer.ts

```typescript
export async function summarizeBill(
  bill: { number: string; title: string; status: string; date: string },
  watchlistTickers: string[],
): Promise<BudgetSignal>
```

Calls Claude Haiku with:
```
System: You are a government spending analyst. Extract structured investment signals from congressional bill information.

User: Bill: {number} — {title}
Status: {status} as of {date}
Watchlist companies: {tickers joined by comma}

Extract:
1. A 2-3 sentence plain-English summary of what this bill funds
2. Which watchlist tickers benefit (if any)
3. Total funding amount if mentioned (null if unclear)
4. 2-4 key provisions as bullet points

Respond using the extract_bill_signal tool.
```

Tool schema:
```typescript
{
  name: 'extract_bill_signal',
  input_schema: {
    properties: {
      summary:          { type: 'string' },
      relevantTickers:  { type: 'array', items: { type: 'string' } },
      totalFunding:     { type: 'number', nullable: true },
      keyProvisions:    { type: 'array', items: { type: 'string' } },
    },
    required: ['summary', 'relevantTickers', 'keyProvisions'],
  }
}
```

Budget signals are cached by bill number in `data/budget-cache.json` — only re-summarized when the bill's `date` changes (i.e., new action taken). This prevents re-spending tokens on bills that haven't moved.

## exporter.ts

```typescript
export async function exportGovFlow(outputPath: string): Promise<void>
// 1. Load watchlist companies from ingestion DB (fallback to FALLBACK_COMPANIES)
// 2. Parallel: fetchWatchlistAwards() + fetchAgencyFlows() + fetchRecentBills()
// 3. Summarize bills (use cache for unchanged bills)
// 4. Write GovFlowJSON to outputPath
// 5. Log: "[govflow] awards: N companies, agency flows: 8, budget signals: M"
```

## cli-fetch.ts

```typescript
// npm run fetch
import 'dotenv/config'
import { join } from 'path'
import { exportGovFlow } from '../exporter.js'

const OUTPUT = join(process.cwd(), 'data', 'govflow.json')
await exportGovFlow(OUTPUT)
```

**package.json scripts:**
```json
{
  "fetch": "tsx src/cli/cli-fetch.ts",
  "schedule": "tsx src/cli/cli-schedule.ts"
}
```

Scheduler: awards daily at 07:00, budget signals weekly on Monday at 07:15. Awards run first since they're faster (no AI).

## ai-analysis-engine Changes

**`src/analysis/regime-analyzer.ts` — add interface:**
```typescript
export interface GovFlowContext {
  asOf: string
  watchlistAwards: Array<{
    ticker: string; company: string; total30d: number; topAgency: string; contracts: string[]
  }>
  agencyFlows: Array<{
    agency: string; total30d: number; trend: string
  }>
  budgetSignals: Array<{
    billNumber: string; title: string; summary: string
    relevantTickers: string[]; totalFunding: number | null; keyProvisions: string[]
  }>
}
```

**Add formatter:**
```typescript
function formatGovFlow(gov: GovFlowContext): string {
  const USD = (n: number) => n >= 1e9 ? `$${(n/1e9).toFixed(1)}B` : `$${(n/1e6).toFixed(0)}M`
  const TREND = (t: string) => t === 'rising' ? '↑' : t === 'falling' ? '↓' : '→'

  const awardLines = gov.watchlistAwards
    .filter(a => a.total30d > 0)
    .sort((a, b) => b.total30d - a.total30d)
    .map(a => `  ${a.ticker.padEnd(6)}: ${USD(a.total30d)} from ${a.topAgency} — ${a.contracts[0] ?? ''}`)
    .join('\n')

  const agencyLines = gov.agencyFlows
    .sort((a, b) => b.total30d - a.total30d)
    .slice(0, 5)
    .map(a => `  ${a.agency.padEnd(30)}: ${USD(a.total30d)} ${TREND(a.trend)}`)
    .join('\n')

  const budgetLines = gov.budgetSignals
    .map(b => [
      `  [${b.billNumber}] ${b.title}`,
      `  ${b.summary}`,
      b.relevantTickers.length ? `  Watchlist impact: ${b.relevantTickers.join(', ')}` : '',
    ].filter(Boolean).join('\n'))
    .join('\n\n')

  const parts = ['## Government Capital Flows (as of ' + gov.asOf + ')']
  if (awardLines) parts.push('### Recent Contract Awards (30d)\n' + awardLines)
  if (agencyLines) parts.push('### Top Agencies by Spend (30d)\n' + agencyLines)
  if (budgetLines) parts.push('### Budget & Appropriations Signals\n' + budgetLines)
  return parts.join('\n\n')
}
```

**Extend `analyzeRegime()` options:**
```typescript
options: {
  client?: Anthropic
  worldIntel?: WorldIntelContext
  macroAssets?: MacroContext
  liquidityContext?: LiquidityContext
  govFlowContext?: GovFlowContext    // NEW
}
```

**Update `SYSTEM_PROMPT`** — add 4th signal source:
```
4. Government capital flows — recent federal contract awards to watchlist companies and top agencies,
   plus forward-looking budget and appropriations signals. Government spending is a leading indicator:
   a DoD AI budget increase precedes contracts by 6-12 months. When watchlist companies are winning
   significant government contracts or relevant appropriations bills have passed, factor this into
   your regime assessment and mention it in the rationale.
```

**Update `src/cli/cli-run.ts`:**
```typescript
const GOV_FLOW_PATH = join(process.cwd(), '../government-flow-monitor/data/govflow.json')

function loadGovFlow(): GovFlowContext | undefined {
  try {
    if (!existsSync(GOV_FLOW_PATH)) return undefined
    return JSON.parse(readFileSync(GOV_FLOW_PATH, 'utf-8'))
  } catch { return undefined }
}

// In run():
const govFlowContext = loadGovFlow()
console.log(govFlowContext
  ? `  Gov flow: ${govFlowContext.watchlistAwards.length} companies, ${govFlowContext.budgetSignals.length} budget signals`
  : '  Gov flow: not available')

const regime = await analyzeRegime(health, { worldIntel, macroAssets, liquidityContext, govFlowContext })
```

## Cost Summary

| Component | Cost |
|-----------|------|
| USASpending.gov API | Free |
| Congress.gov API | Free (requires free API key) |
| Claude Haiku (bill summaries, cached) | ~$0.02/month |
| Additional ai-analysis-engine tokens (larger prompt) | ~$0.10/month |
| **Total addition** | **~$0.12/month** |

## Setup

1. Register for Congress.gov API key at `https://api.congress.gov/sign-up/`
2. Add `CONGRESS_API_KEY=...` to `government-flow-monitor/.env`
3. Add `ANTHROPIC_API_KEY=...` to `government-flow-monitor/.env`
4. `npm install && npm run fetch` — first run populates `govflow.json`
5. `npm run schedule` — starts daily awards + weekly budget scheduler
