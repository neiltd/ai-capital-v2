# Autonomous Discovery Agent — Design Spec

**Date:** 2026-05-27
**Project:** AI Capital Flow & Technology Intelligence System (sub-project 9)
**Status:** Approved

---

## Overview

A discovery module inside `scenario-simulator/` that runs daily at 6:45 AM and autonomously surfaces new investment candidates from two sources: (1) the ingestion DB's tracked companies table filtered against the real portfolio, and (2) ticker symbols extracted by Claude from recent news documents in the ingestion DB. Candidates are scored in a single batch Claude call (0–100); those that clear a configurable threshold get a full 3-scenario deep analysis. Tickers where Claude recommends `buy` get a paper position opened at a fixed paper allocation. All discovery data is exported to `data/discovery.json` — separate from `simulation.json`. The `capital-intel-dashboard` shows a new `/discovery` page reading this file.

---

## Architecture

```
scenario-simulator/
  src/
    discovery/
      types.ts               ← DiscoveryCandidate, ScoredCandidate, DiscoveryPosition, DiscoveryRun
      ingestion-reader.ts    ← read-only access to capital-intelligence-ingestion DB
      ticker-extractor.ts    ← Claude extracts ticker symbols from news document text
      ticker-filter.ts       ← dedup against real portfolio + open discovery positions
      discovery-scorer.ts    ← Claude light filter: all candidates → scores in one call
      discovery-analyzer.ts  ← Claude deep analysis: 3 scenarios + buy/watch per top scorer
      paper-portfolio.ts     ← CRUD for discovery_positions table in simulation.db
      discovery-exporter.ts  ← writes data/discovery.json
    cli/
      cli-discover.ts        ← npm run discover
```

**Reads from (read-only):**
- `../capital-intelligence-ingestion/data/capital_intelligence.db` — companies + raw_documents tables
- `../ai-analysis-engine/data/analysis.json` — current macro regime + signals (context for Claude)
- `data/portfolio.db` — real positions (to filter candidates)
- `data/simulation.db` — existing discovery_positions (to avoid re-opening)

**Writes to (own data only):**
- `data/simulation.db` — new `discovery_positions` and `discovery_runs` tables (appended to existing DB)
- `data/discovery.json` — daily export consumed by dashboard

---

## Tech Stack

Inherits everything from the parent `scenario-simulator/` project — no new dependencies.

| Dependency | Purpose |
|---|---|
| `typescript` + `tsx` | Language + runtime |
| `better-sqlite3` | Read ingestion DB + write simulation.db tables |
| `@anthropic-ai/sdk` | Claude Sonnet 4.6 for scorer + analyzer |
| `dotenv` | Three new env vars (DISCOVERY_THRESHOLD, DISCOVERY_ALLOCATION, DISCOVERY_NEWS_DAYS) |
| `vitest` | Tests |

---

## Data Model

### TypeScript types (`src/discovery/types.ts`)

```ts
type DiscoverySource = 'companies_table' | 'news_mention'

interface DiscoveryCandidate {
  ticker:      string
  company:     string
  source:      DiscoverySource
  newsSnippet: string | null   // excerpt used as scoring context (null for companies_table)
}

interface ScoredCandidate {
  ticker:    string
  company:   string
  source:    DiscoverySource
  score:     number            // 0–100
  rationale: string            // one sentence from Claude
}

interface DiscoveryPosition {
  ticker:        string
  company:       string
  shares:        number
  avgCost:       number        // price at time of discovery open
  currentPrice:  number
  currentValue:  number
  unrealizedPnl: number
  score:         number        // light-filter score at time of open
  source:        DiscoverySource
  rationale:     string        // one-line rationale from light filter
  openedAt:      string        // ISO date
  updatedAt:     string        // ISO timestamp of last price refresh
}

interface DiscoveryRun {
  id:              string
  date:            string
  candidatesFound: number      // total before filter
  passedFilter:    number      // scored ≥ threshold
  positionsOpened: number      // net new paper positions opened this run
  threshold:       number      // snapshot of DISCOVERY_THRESHOLD used
  durationMs:      number
  createdAt:       string
}
```

### SQLite schema additions to `simulation.db`

```sql
discovery_positions (
  ticker          TEXT PRIMARY KEY,
  company         TEXT NOT NULL,
  shares          REAL NOT NULL,
  avg_cost        REAL NOT NULL,
  current_price   REAL NOT NULL DEFAULT 0,
  current_value   REAL NOT NULL DEFAULT 0,
  unrealized_pnl  REAL NOT NULL DEFAULT 0,
  score           INTEGER NOT NULL,
  source          TEXT NOT NULL,
  rationale       TEXT NOT NULL,
  opened_at       TEXT NOT NULL,
  updated_at      TEXT NOT NULL
)

discovery_runs (
  id               TEXT PRIMARY KEY,
  date             TEXT NOT NULL,
  candidates_found INTEGER NOT NULL,
  passed_filter    INTEGER NOT NULL,
  positions_opened INTEGER NOT NULL,
  threshold        INTEGER NOT NULL,
  duration_ms      INTEGER NOT NULL,
  created_at       TEXT NOT NULL
)
```

Tables are created on first `npm run discover` run via `CREATE TABLE IF NOT EXISTS`.

---

## .env additions

```
DISCOVERY_THRESHOLD=70      # score cutoff to proceed to deep analysis and open paper position
DISCOVERY_ALLOCATION=1000   # USD paper money allocated per new position
DISCOVERY_NEWS_DAYS=7       # how many days back to scan raw_documents for news
```

---

## Discovery Pipeline (`cli-discover.ts`)

```
1. Load analysis.json (macro regime context)
2. Load real portfolio tickers from portfolio.db (filter list)
3. Load open discovery positions from simulation.db (skip re-scoring existing tickers)
4. ingestion-reader.ts → companies table: tickers NOT in real portfolio → DiscoveryCandidate[]
5. ingestion-reader.ts → raw_documents (news, last DISCOVERY_NEWS_DAYS days)
   → ticker-extractor.ts: Claude extracts ticker symbols from document text
   → merge with step 4, deduplicate, skip tickers already in discovery positions
6. price-fetcher.ts (existing) → fetch current price for all candidates
7. discovery-scorer.ts → one Claude call scores all candidates → ScoredCandidate[]
8. For each candidate where score ≥ DISCOVERY_THRESHOLD:
   a. discovery-analyzer.ts → Claude deep analysis (3 scenarios + buy/watch action)
   b. If action = 'buy' AND ticker not already in discovery_positions:
      → paper-portfolio.ts: openPosition(ticker, allocation / price, price, score, ...)
9. paper-portfolio.ts: refresh prices for all existing discovery positions
10. discovery-exporter.ts: write data/discovery.json
11. Insert discovery_runs row
```

---

## Module Specifications

### `ticker-filter.ts`

Pure utility — no Claude call. Takes the merged candidate list from `getTrackedTickers` and `ticker-extractor`, removes duplicates by ticker symbol, and removes tickers that are already open in `discovery_positions`. Returns a deduplicated `DiscoveryCandidate[]` ready for price fetching and scoring.

---

### `ingestion-reader.ts`

Opens `../capital-intelligence-ingestion/data/capital_intelligence.db` read-only (`{ readonly: true }`). Provides:

```ts
getTrackedTickers(excludeTickers: string[]): DiscoveryCandidate[]
// SELECT ticker, company FROM companies WHERE active = 1 AND ticker NOT IN (...)

getRecentNews(daysBack: number): Array<{ ticker: string; company: string; content: string; publishedDate: string }>
// SELECT ticker, company, content, published_date FROM raw_documents
// WHERE source = 'news' AND published_date >= date('now', '-N days')
// ORDER BY published_date DESC
```

Never writes. Throws if DB file not found.

---

### `ticker-extractor.ts`

Takes `recentNews[]` and calls Claude Sonnet 4.6 with tool use to extract ticker symbols mentioned in the text that are NOT already in the known universe.

**Tool: `extract_tickers`**
```json
{
  "name": "extract_tickers",
  "input_schema": {
    "type": "object",
    "properties": {
      "mentions": {
        "type": "array",
        "items": {
          "type": "object",
          "properties": {
            "ticker":  { "type": "string" },
            "company": { "type": "string" },
            "snippet": { "type": "string", "description": "1-2 sentence excerpt mentioning this ticker" }
          },
          "required": ["ticker", "company", "snippet"]
        }
      }
    },
    "required": ["mentions"]
  }
}
```

**System prompt (cached):** Extract US-listed stock ticker symbols mentioned in the provided news documents. Only include tickers that appear to be publicly traded US equities with clear investment relevance. Do not include tickers already in the provided exclusion list.

Returns `DiscoveryCandidate[]` with `source: 'news_mention'` and `newsSnippet` populated from the extracted snippet.

---

### `discovery-scorer.ts`

One Claude call scores all `DiscoveryCandidate[]` in a single batch.

**Tool: `score_candidates`**
```json
{
  "name": "score_candidates",
  "input_schema": {
    "type": "object",
    "properties": {
      "scores": {
        "type": "array",
        "items": {
          "type": "object",
          "properties": {
            "ticker":    { "type": "string" },
            "score":     { "type": "integer", "minimum": 0, "maximum": 100 },
            "rationale": { "type": "string", "description": "One sentence explaining the score" }
          },
          "required": ["ticker", "score", "rationale"]
        }
      }
    },
    "required": ["scores"]
  }
}
```

**System prompt (cached):** You are a technology investment analyst screening stocks for portfolio fit. The investor focuses on AI infrastructure, semiconductors, and emerging tech. Score each ticker 0–100 based on: recent news signal strength, sector fit, momentum, and data availability. Be conservative — only score ≥ 70 if there is a clear, specific reason to investigate further.

**User message includes:**
- Current macro regime label + confidence (from `analysis.json`)
- All candidates with ticker, company, source, and newsSnippet
- Real portfolio tickers (for context: "these are already held, avoid scoring up close substitutes")
- Already-open discovery position tickers (skip re-scoring)

Returns `ScoredCandidate[]`.

---

### `discovery-analyzer.ts`

One Claude call per top-scorer (score ≥ threshold). Combines scenario generation and buy/watch recommendation in a single call.

**Tool: `analyze_discovery_ticker`**
```json
{
  "name": "analyze_discovery_ticker",
  "input_schema": {
    "type": "object",
    "properties": {
      "scenarios": {
        "type": "array",
        "description": "Exactly 3 scenarios: best, base, disruption",
        "items": {
          "type": "object",
          "properties": {
            "scenarioType":     { "type": "string", "enum": ["best", "base", "disruption"] },
            "title":            { "type": "string" },
            "narrative":        { "type": "string", "description": "2-3 paragraph forward-looking description" },
            "timeHorizon":      { "type": "string" },
            "probability":      { "type": "integer", "minimum": 0, "maximum": 100 },
            "regimeTransition": { "type": ["string", "null"] },
            "triggers":         { "type": "array", "items": { "type": "string" } }
          },
          "required": ["scenarioType", "title", "narrative", "timeHorizon", "probability", "regimeTransition", "triggers"]
        }
      },
      "action": {
        "type": "object",
        "properties": {
          "recommendation": { "type": "string", "enum": ["buy", "watch"] },
          "conviction":     { "type": "string", "enum": ["high", "medium", "low"] },
          "rationale":      { "type": "string", "description": "1-2 sentences explaining the recommendation" }
        },
        "required": ["recommendation", "conviction", "rationale"]
      }
    },
    "required": ["scenarios", "action"]
  }
}
```

**System prompt (cached):** Same as `scenario-generator.ts` — forward-looking technology investment strategist grounding analysis in macro regime and specific ticker signals.

**User message includes:**
- Ticker, company, score, light-filter rationale
- News snippet(s) that surfaced this ticker
- Current macro regime + key propagation signals (from `analysis.json`)
- Current price

A ticker can score ≥ 70 in the light filter but still receive `action: 'watch'` if deep analysis reveals meaningful downside. Watch tickers appear in `candidates[]` in `discovery.json` but no paper position is opened.

---

### `paper-portfolio.ts`

Operates on `simulation.db` (existing DB). Provides:

```ts
openPosition(ticker, company, shares, avgCost, score, source, rationale): void
updatePrices(prices: Record<string, number>): void
getPositions(): DiscoveryPosition[]
close(): void
```

`openPosition` is a no-op if `ticker` already exists in `discovery_positions`. `updatePrices` updates `current_price`, `current_value`, `unrealized_pnl`, and `updated_at` for all rows.

Paper allocation formula: `shares = DISCOVERY_ALLOCATION / currentPrice` (rounded to 4 decimal places).

---

### `discovery-exporter.ts`

Writes `data/discovery.json`:

```json
{
  "exportedAt": "2026-05-27T06:45:00.000Z",
  "config": {
    "threshold": 70,
    "paperAllocation": 1000,
    "newsDays": 7
  },
  "candidates": [
    {
      "ticker": "SMCI",
      "company": "Super Micro Computer",
      "score": 82,
      "rationale": "Supply chain pivot signals accelerating server demand",
      "source": "news_mention",
      "discoveredAt": "2026-05-27",
      "action": "buy"
    }
  ],
  "discoveryPortfolio": [ ...DiscoveryPosition[] ],
  "scenarios": [ ...Scenario[] ],  // same shape as existing Scenario type but without runId (not persisted to SQLite)
  "actions": [
    {
      "ticker": "SMCI",
      "recommendation": "buy",
      "conviction": "high",
      "rationale": "..."
    }
  ]
}
```

`candidates[]` includes all tickers that passed the light filter (both `buy` and `watch`). `discoveryPortfolio[]` includes all open paper positions (including positions opened in prior runs). `scenarios[]` includes the 3 scenarios for each ticker that received deep analysis today.

---

## CLI Command

```
npm run discover    ← full discovery pipeline (runs in ~1-2 minutes)
```

Added to `package.json`:
```json
"discover": "tsx src/cli/cli-discover.ts"
```

The existing `npm run schedule` cron (`30 6 * * *` for simulate) gains a second job at `45 6 * * *` for discover.

---

## Dashboard Integration (`capital-intel-dashboard`)

### New API route: `GET /api/discovery`

Reads `$DATA_ROOT/scenario-simulator/data/discovery.json`. Returns it as-is. Returns `{ missing: true }` if the file doesn't exist (discovery hasn't run yet).

### New page: `/discovery`

Added as the 6th sidebar entry ("Discovery ✦"). Three sections stacked vertically:

1. **Paper Positions table** — ticker (link), company, score badge (color-coded ≥80 green / 70–79 amber), avg cost, live price, unrealized P&L (green/red), source tag (news / tracked), opened date. If empty: "No paper positions yet — discovery runs daily at 6:45 AM."

2. **Today's Candidates** — all tickers from `candidates[]` that passed the light filter, showing score, one-line rationale, and outcome badge (→ position / → watch). Sorted by score descending.

3. **Scenario strip** — best/base/disruption cards for the first paper position by default; clicking a ticker row in the table swaps the strip to that ticker's scenarios. If no scenarios available for a position (opened in a prior run, not re-analyzed today), shows "Scenarios generated on [openedAt date]."

### New component: `DiscoveryCandidateRow.tsx`

Renders one row in the Today's Candidates section with score badge and outcome pill.

---

## Testing

- Unit tests for `ingestion-reader.ts` — mock DB, verify `getTrackedTickers` excludes filtered tickers, verify `getRecentNews` applies date filter
- Unit tests for `ticker-extractor.ts` — mock Claude tool response, verify `DiscoveryCandidate[]` shape with `source: 'news_mention'`
- Unit tests for `discovery-scorer.ts` — mock Claude tool response, verify all candidates get a score, verify scores are integers 0–100
- Unit tests for `discovery-analyzer.ts` — mock Claude tool response, verify exactly 3 scenarios produced, verify `action.recommendation` is `'buy' | 'watch'`
- Unit tests for `paper-portfolio.ts` — in-memory SQLite, verify `openPosition` is idempotent (second call with same ticker is a no-op), verify `updatePrices` recomputes `unrealized_pnl` correctly
- Unit tests for `discovery-exporter.ts` — verify JSON shape, verify `candidates[]` includes both buy and watch tickers
- No live Claude API calls or live HTTP calls in test suite

---

## Key Design Constraints

- **Read-only ingestion DB** — opens with `{ readonly: true }`; never writes to ingestion project
- **Extends simulation.db, not a new file** — `discovery_positions` and `discovery_runs` are added to the existing DB via `CREATE TABLE IF NOT EXISTS`
- **Separate export file** — `discovery.json` is never merged into `simulation.json`; dashboard reads both independently
- **Idempotent position opening** — `openPosition` is a no-op if ticker already exists; running discover twice in a day is safe
- **Prompt caching** — system prompts for all three Claude calls (`ticker-extractor`, `discovery-scorer`, `discovery-analyzer`) use `cache_control: { type: 'ephemeral' }`
- **Price fetch reuse** — uses existing `price-fetcher.ts` directly; no duplication
- **Watch ≠ no signal** — tickers that pass the light filter but get `watch` from deep analysis are preserved in `candidates[]` in the export; the dashboard surfaces them so the user can review Claude's reasoning
- **Bounded universe** — discovery is limited to tickers with reliable financialdata.net data; the ingestion DB's `companies.active = 1` filter and the `news_mention` extraction (which only surfaces named companies from tracked news) keeps the candidate set manageable
- **Scheduler offset** — runs at 6:45 AM, 15 minutes after scenario-simulator (6:30 AM), which itself runs 30 minutes after the analysis engine (6:00 AM)
