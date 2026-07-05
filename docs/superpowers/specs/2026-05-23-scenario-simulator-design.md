# Scenario Simulator — Design Spec

**Date:** 2026-05-23
**Project:** AI Capital Flow & Technology Intelligence System (sub-project 6 of 7)
**Status:** Approved

---

## Overview

A standalone TypeScript project that runs in two modes: (1) a daily autonomous run that takes the current macro regime and propagation signals from the AI Analysis Engine and uses Claude to generate three forward-looking scenarios (best/base/disruption) with regime transition probabilities and per-ticker portfolio action recommendations, and (2) an on-demand "what if" mode where the user specifies a free-form trigger and Claude reasons forward from it as a single scenario. Results are stored in SQLite and exported to JSON and a daily Markdown report for downstream consumption.

---

## Architecture

```
scenario-simulator/
  src/
    types.ts
    portfolio/
      portfolio-store.ts     ← position CRUD (portfolio.db)
      price-fetcher.ts       ← financialdata.net /stock-prices (free tier)
    simulation/
      scenario-generator.ts  ← Stage 1: Claude generate_scenarios tool
      action-generator.ts    ← Stage 2: Claude generate_portfolio_actions tool
    store/
      sqlite.ts              ← simulation.db schema, CRUD operations
    export/
      exporter.ts            ← writes data/simulation.json
      reporter.ts            ← writes data/reports/YYYY-MM-DD.md
    cli/
      cli-run.ts             ← npm run simulate (daily autonomous)
      cli-whatif.ts          ← npm run whatif -- --trigger "..."
      cli-portfolio.ts       ← npm run portfolio -- set/show
      cli-report.ts          ← npm run report (print latest report)
  tests/
  data/                      ← gitignored (portfolio.db, simulation.db, simulation.json, reports/)
  package.json
  tsconfig.json
  .env
```

**Reads from (read-only):**
- `../ai-analysis-engine/data/analysis.json` — current regime, propagation signals, company health summaries
- `../dependency-graph-engine/data/graph.json` — dependency edges (for scenario context)

**Writes to (own data only):**
- `data/portfolio.db` — user's positions
- `data/simulation.db` — simulation run history
- `data/simulation.json` — latest export for sub-project 7
- `data/reports/YYYY-MM-DD.md` — daily Markdown report

---

## Tech Stack

Matches existing projects exactly:

| Dependency | Purpose |
|---|---|
| `typescript` + `tsx` | Language + runtime |
| `better-sqlite3` | portfolio.db and simulation.db |
| `@anthropic-ai/sdk` | Claude Sonnet 4.6 for scenario + action generation |
| `node-cron` | Daily scheduling |
| `dotenv` | Env vars (ANTHROPIC_API_KEY, FINANCIALDATA_API_KEY) |
| `vitest` | Tests |

Price fetching uses the built-in `fetch` (Node 18+) against `https://financialdata.net/api/v1/stock-prices` — no additional HTTP library needed.

---

## Data Model

### Types

```ts
interface Position {
  ticker:        string
  company:       string
  shares:        number
  avgCost:       number   // USD per share, as entered by user
  currentPrice:  number   // fetched from financialdata.net
  currentValue:  number   // shares * currentPrice
  unrealizedPnl: number   // currentValue - (shares * avgCost)
  updatedAt:     string   // ISO timestamp of last price refresh
}

interface Scenario {
  id:               string
  runId:            string
  date:             string                                        // YYYY-MM-DD
  scenarioType:     'best' | 'base' | 'disruption' | 'whatif'
  title:            string   // e.g. "AI Acceleration Continues"
  narrative:        string   // 2–3 paragraph forward-looking description
  timeHorizon:      string   // e.g. "3–6 months"
  probability:      number   // 0–100 integer
  regimeTransition: string | null  // target regime label; null if regime unchanged
  triggers:         string[]       // specific events that cause this scenario
  createdAt:        string
}

interface PortfolioAction {
  id:                  string
  runId:               string
  scenarioId:          string
  ticker:              string
  action:              'buy' | 'hold' | 'trim' | 'exit'
  conviction:          'high' | 'medium' | 'low'
  allocationChangePct: number  // integer: +15 = add 15%, -30 = trim 30%, 0 = hold
  rationale:           string
  createdAt:           string
}

interface SimulationRun {
  id:            string
  date:          string   // YYYY-MM-DD
  type:          'daily' | 'whatif'
  trigger:       string | null  // null for daily runs
  scenarioCount: number
  actionCount:   number
  durationMs:    number
  createdAt:     string
}
```

### SQLite Schema

**`portfolio.db`:**
```sql
positions (
  ticker          TEXT PRIMARY KEY,
  company         TEXT NOT NULL,
  shares          REAL NOT NULL,
  avg_cost        REAL NOT NULL,
  current_price   REAL NOT NULL DEFAULT 0,
  current_value   REAL NOT NULL DEFAULT 0,
  unrealized_pnl  REAL NOT NULL DEFAULT 0,
  updated_at      TEXT NOT NULL
)
```

**`simulation.db`:**
```sql
simulation_runs (
  id              TEXT PRIMARY KEY,
  date            TEXT NOT NULL,
  type            TEXT NOT NULL,
  trigger         TEXT,
  scenario_count  INTEGER NOT NULL,
  action_count    INTEGER NOT NULL,
  duration_ms     INTEGER NOT NULL,
  created_at      TEXT NOT NULL
)

scenarios (
  id                TEXT PRIMARY KEY,
  run_id            TEXT NOT NULL,
  date              TEXT NOT NULL,
  scenario_type     TEXT NOT NULL,
  title             TEXT NOT NULL,
  narrative         TEXT NOT NULL,
  time_horizon      TEXT NOT NULL,
  probability       INTEGER NOT NULL,
  regime_transition TEXT,
  triggers          TEXT NOT NULL,  -- JSON array of strings
  created_at        TEXT NOT NULL
)

portfolio_actions (
  id                    TEXT PRIMARY KEY,
  run_id                TEXT NOT NULL,
  scenario_id           TEXT NOT NULL,
  ticker                TEXT NOT NULL,
  action                TEXT NOT NULL,
  conviction            TEXT NOT NULL,
  allocation_change_pct INTEGER NOT NULL,
  rationale             TEXT NOT NULL,
  created_at            TEXT NOT NULL
)
```

---

## Portfolio Management

### `portfolio-store.ts`

Opens `portfolio.db`. Provides:
- `upsertPosition(ticker, company, shares, avgCost)` — inserts or replaces
- `updatePrices(prices: Record<string, number>)` — updates `current_price`, `current_value`, `unrealized_pnl` for all positions
- `getPositions()` — returns all `Position[]` with live computed fields
- `close()`

### `price-fetcher.ts`

Calls `https://financialdata.net/api/v1/stock-prices?identifier=NVDA,MSFT,...&key=<FINANCIALDATA_API_KEY>`. Accepts a comma-separated list of tickers. Returns `Record<string, number>` mapping ticker → price.

On HTTP error or missing ticker in response, logs a warning and uses the last known price from the database (i.e., `currentPrice` stays at whatever it was). Never throws — a failed price fetch is non-fatal.

---

## Stage 1: Scenario Generator (Claude)

`scenario-generator.ts` takes the current `AnalysisJSON` (from `analysis.json`), the graph edges (from `graph.json`), and an optional `trigger` string. It calls Claude Sonnet 4.6 with `generate_scenarios` tool use.

**For daily run:** produces 3 scenarios — `best`, `base`, `disruption`. Probabilities across the three must not necessarily sum to 100 (each is independent).

**For what-if:** produces 1 scenario — `whatif`. The trigger string is injected into the user message: "Given this trigger: [trigger], project forward as a single what-if scenario."

**Tool definition:**
```json
{
  "name": "generate_scenarios",
  "description": "Generate forward-looking scenarios based on the current macro regime, propagation signals, and dependency graph",
  "input_schema": {
    "type": "object",
    "properties": {
      "scenarios": {
        "type": "array",
        "items": {
          "type": "object",
          "properties": {
            "scenarioType":     { "type": "string", "enum": ["best", "base", "disruption", "whatif"] },
            "title":            { "type": "string", "description": "Short evocative label, e.g. AI Acceleration Continues" },
            "narrative":        { "type": "string", "description": "2-3 paragraph forward-looking description of how this scenario unfolds" },
            "timeHorizon":      { "type": "string", "description": "e.g. 3-6 months, 6-12 months" },
            "probability":      { "type": "integer", "minimum": 0, "maximum": 100, "description": "Estimated probability 0-100" },
            "regimeTransition": { "type": ["string", "null"], "description": "Target regime label if regime shifts, null if unchanged" },
            "triggers":         { "type": "array", "items": { "type": "string" }, "description": "3-5 specific events that would cause this scenario to materialize" }
          },
          "required": ["scenarioType", "title", "narrative", "timeHorizon", "probability", "regimeTransition", "triggers"]
        }
      }
    },
    "required": ["scenarios"]
  }
}
```

**System prompt (cached):** role as forward-looking technology investment strategist + instruction to ground scenarios in the provided regime and signals rather than generic forecasts.

**Result:** `Scenario[]` — 3 for daily, 1 for what-if. Each inserted into `simulation.db`.

---

## Stage 2: Action Generator (Claude)

`action-generator.ts` takes the `Scenario[]` from Stage 1 and the user's current `Position[]` (with live prices). It calls Claude Sonnet 4.6 with `generate_portfolio_actions` tool use.

**User message context includes:**
- All generated scenarios (type, title, narrative, probability, triggers, regime transition)
- Each held position (ticker, shares, avg cost, current price, current value, unrealized P&L)

Claude produces one `PortfolioAction` per scenario per held ticker. If the user holds 5 tickers and there are 3 scenarios, the output has 15 actions. For what-if (1 scenario, 5 tickers), 5 actions.

**Tool definition:**
```json
{
  "name": "generate_portfolio_actions",
  "description": "Generate position-aware portfolio actions for each held ticker under each scenario",
  "input_schema": {
    "type": "object",
    "properties": {
      "actions": {
        "type": "array",
        "items": {
          "type": "object",
          "properties": {
            "scenarioType":        { "type": "string" },
            "ticker":              { "type": "string" },
            "action":              { "type": "string", "enum": ["buy", "hold", "trim", "exit"] },
            "conviction":          { "type": "string", "enum": ["high", "medium", "low"] },
            "allocationChangePct": { "type": "integer", "description": "+15 means add 15% to position, -30 means trim 30%, 0 means hold" },
            "rationale":           { "type": "string", "description": "1-2 sentence explanation referencing scenario-specific evidence" }
          },
          "required": ["scenarioType", "ticker", "action", "conviction", "allocationChangePct", "rationale"]
        }
      }
    },
    "required": ["actions"]
  }
}
```

**System prompt (cached):** role as portfolio manager + instruction to make `allocationChangePct` consistent with `action` (buy → positive, hold → 0, trim → negative, exit → -100).

**Result:** `PortfolioAction[]` — all inserted into `simulation.db`.

---

## Export & Report

### JSON Export (`exporter.ts`)

Writes `data/simulation.json`:
```json
{
  "exportedAt": "2026-05-23T10:00:00.000Z",
  "portfolio": [ ...Position[] ],
  "scenarios": [ ...Scenario[] ],
  "actions":   [ ...PortfolioAction[] ]
}
```

Throws `'No simulation found — run npm run simulate first'` if `simulation.db` is empty.

### Markdown Report (`reporter.ts`)

Writes `data/reports/YYYY-MM-DD.md`:

```markdown
# Scenario Simulation — 2026-05-23

## Current Portfolio
| Ticker | Shares | Avg Cost | Price | Value | Unrealized P&L |
|--------|--------|----------|-------|-------|----------------|
| NVDA   | 200    | $68.50   | $92.00 | $18,400 | +$4,700 |

## Best Case: AI Acceleration Continues (65%, 3–6 months)
[narrative]

**Triggers:**
- ...

**Regime Transition:** → AI Commoditization

**Portfolio Actions:**
- NVDA: **buy +15%** (high conviction) — [rationale]
- INTC: **trim −30%** (high conviction) — [rationale]

## Base Case: Cautious Consolidation (55%, 6–12 months)
...

## Disruption Case: Semiconductor Supply Shock (20%, 3–6 months)
...
```

For what-if runs, the report contains only the single what-if scenario section (no portfolio table repeated).

---

## CLI Commands

```
npm run simulate                                     ← daily autonomous run (best/base/disruption)
npm run whatif -- --trigger "TSMC cuts 2nm by 30%"  ← single what-if scenario
npm run portfolio -- set NVDA 200 68.50              ← upsert position (ticker, shares, avg cost)
npm run portfolio -- show                            ← list positions with live prices + P&L
npm run report                                       ← print latest Markdown report to stdout
npm run schedule                                     ← start daily cron (runs at 6:30 AM local)
```

`cli-run.ts` and `cli-whatif.ts` exit after one run. `cli-portfolio.ts` exits after the command. `cli-report.ts` prints and exits.

The scheduler runs at `30 6 * * *` (30 minutes after the analysis engine at `0 6 * * *`) to ensure `analysis.json` is fresh before simulation begins.

---

## Testing

- Unit tests for `portfolio-store.ts` — upsert, get, price update, P&L computation
- Unit tests for `price-fetcher.ts` — mock `fetch`, verify `Record<string, number>` output and graceful degradation on error
- Unit tests for `scenario-generator.ts` — mock Claude tool response, verify `Scenario` shape for both daily (3 scenarios) and what-if (1 scenario)
- Unit tests for `action-generator.ts` — mock Claude tool response, verify `PortfolioAction` shape, verify `allocationChangePct` is integer, verify one action per scenario per ticker
- Unit tests for `reporter.ts` — verify Markdown output structure for 3-scenario and 1-scenario cases
- No live Claude API calls or live HTTP calls in test suite

---

## Key Design Constraints

- **Read-only siblings** — never writes to ai-analysis-engine or dependency-graph-engine data directories
- **Prompt caching** — system prompts for both Claude calls use `cache_control: { type: 'ephemeral' }`
- **History preserved** — each run appends new rows; old scenarios and actions are never deleted
- **Price fetch is non-fatal** — if financialdata.net is unavailable, last known price is used; simulation still runs
- **Portfolio is optional at runtime** — if `positions` table is empty, Stage 2 is skipped, `simulation.json` exports `portfolio: []` and `actions: []`, and the report omits the portfolio table and actions sections
- **Scheduler offset** — runs at 6:30 AM, 30 minutes after the analysis engine, to ensure `analysis.json` is available
- **`allocationChangePct` invariants** — enforced in system prompt: buy → > 0, hold → 0, trim → < 0, exit → −100
