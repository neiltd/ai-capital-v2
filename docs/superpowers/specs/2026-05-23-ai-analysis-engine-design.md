# AI Analysis Engine — Design Spec

**Date:** 2026-05-23  
**Project:** AI Capital Flow & Technology Intelligence System (sub-project 5 of 7)  
**Status:** Approved

---

## Overview

A standalone TypeScript project that runs once per day, collecting health signals from all tracked companies and using Claude to produce two outputs: (1) a macro regime classification that summarizes the current technology/investment environment, and (2) a set of propagation signals that trace how company-level events ripple upstream and downstream through the dependency graph. Results are stored in SQLite and exported to JSON and a daily Markdown report for downstream consumption.

---

## Architecture

```
ai-analysis-engine/
  src/
    types.ts
    collector/
      health-collector.ts      ← Stage 1: gather CompanyHealth[] (no Claude)
    analysis/
      regime-analyzer.ts       ← Stage 2a: Claude classifies macro regime
      propagation-analyzer.ts  ← Stage 2b: Claude proposes propagation signals
    store/
      sqlite.ts                ← analysis.db schema, CRUD operations
    export/
      exporter.ts              ← writes data/analysis.json
      reporter.ts              ← writes data/reports/YYYY-MM-DD.md
    cli/
      cli-run.ts               ← npm run analyze (one-shot)
      cli-schedule.ts          ← npm run schedule (daily cron)
      cli-report.ts            ← npm run report (print latest report)
  tests/
  data/                        ← gitignored (analysis.db, analysis.json, reports/)
  package.json
  tsconfig.json
  .env
```

**Reads from (read-only):**
- `../thesis-memory/data/thesis.db` — latest thesis + assumptions per company
- `../capital-intelligence-ingestion/data/lancedb` — recent document chunks
- `../dependency-graph-engine/data/graph.json` — seed + confirmed edges

**Writes to (own data only):**
- `data/analysis.db` — SQLite source of truth
- `data/analysis.json` — periodic JSON export for downstream projects
- `data/reports/YYYY-MM-DD.md` — daily human-readable Markdown report

---

## Tech Stack

Matches existing projects exactly:

| Dependency | Purpose |
|---|---|
| `typescript` + `tsx` | Language + runtime |
| `better-sqlite3` | Own analysis.db |
| `@lancedb/lancedb` | Read-only access to ingestion LanceDB |
| `@anthropic-ai/sdk` | Claude Sonnet 4.6 for regime + propagation analysis |
| `node-cron` | Daily scheduling |
| `dotenv` | Env vars (ANTHROPIC_API_KEY) |
| `vitest` | Tests |

---

## Data Model

### Types

```ts
interface CompanyHealth {
  ticker: string
  company: string
  thesisSummary: string           // latest thesis text from thesis-memory
  assumptions: ThesisAssumption[] // current assumption statuses
  recentChunks: RecentChunk[]     // last 7 days of ingestion chunks
  healthScore: 'positive' | 'neutral' | 'negative' | 'insufficient_data'
}

interface ThesisAssumption {
  text: string
  status: 'holding' | 'weakening' | 'broken' | 'strengthening'
}

interface RecentChunk {
  chunkId: string
  title: string
  source: string
  publishedAt: string
  content: string
}

interface MacroRegime {
  id: string
  date: string                    // YYYY-MM-DD
  regime: string                  // e.g. "AI Acceleration", "Semiconductor Correction"
  confidence: 'high' | 'medium' | 'low'
  rationale: string
  keyIndicators: string[]         // 3-5 bullet points
  affectedTickers: string[]
  createdAt: string
}

interface PropagationSignal {
  id: string
  date: string                    // YYYY-MM-DD
  sourceTicker: string
  targetTicker: string
  signalType: 'supply_chain' | 'customer' | 'technology' | 'competitive'
  direction: 'upstream' | 'downstream'
  magnitude: 'strong' | 'moderate' | 'weak'
  sentiment: 'positive' | 'negative' | 'neutral'
  description: string
  evidenceQuote: string | null
  createdAt: string
}

interface AnalysisRun {
  id: string
  date: string
  companiesAnalyzed: number
  regimeId: string
  propagationSignalCount: number
  durationMs: number
  createdAt: string
}
```

### SQLite Schema (analysis.db)

```sql
analysis_runs (
  id                     TEXT PRIMARY KEY,
  date                   TEXT NOT NULL,         -- YYYY-MM-DD
  companies_analyzed     INTEGER NOT NULL,
  regime_id              TEXT NOT NULL,
  propagation_signal_count INTEGER NOT NULL,
  duration_ms            INTEGER NOT NULL,
  created_at             TEXT NOT NULL
)

macro_regimes (
  id                TEXT PRIMARY KEY,
  date              TEXT NOT NULL,
  regime            TEXT NOT NULL,
  confidence        TEXT NOT NULL,
  rationale         TEXT NOT NULL,
  key_indicators    TEXT NOT NULL,              -- JSON array of strings
  affected_tickers  TEXT NOT NULL,              -- JSON array of tickers
  created_at        TEXT NOT NULL
)

propagation_signals (
  id               TEXT PRIMARY KEY,
  date             TEXT NOT NULL,
  source_ticker    TEXT NOT NULL,
  target_ticker    TEXT NOT NULL,
  signal_type      TEXT NOT NULL,
  direction        TEXT NOT NULL,
  magnitude        TEXT NOT NULL,
  sentiment        TEXT NOT NULL,
  description      TEXT NOT NULL,
  evidence_quote   TEXT,
  created_at       TEXT NOT NULL
)
```

---

## Stage 1: Health Collector (No Claude)

`health-collector.ts` reads two data sources for each tracked company and returns a `CompanyHealth[]` array. No Claude calls. This stage is pure data assembly.

**Data source 1 — thesis-memory SQLite:**
Opens `../thesis-memory/data/thesis.db` read-only. For each company, reads the latest thesis record and its current assumptions (only rows not superseded by a newer update — i.e., the most recent version of each assumption). Computes `healthScore` from assumption statuses:
- All holding/strengthening → `positive`
- Any broken → `negative`
- Mix of weakening → `neutral`
- No thesis record → `insufficient_data`

**Data source 2 — ingestion LanceDB:**
Opens the capital-intelligence-ingestion LanceDB table read-only. Queries per ticker with `.where("ticker = 'X'")` filtered to `publishedAt >= 7 days ago`, `.limit(10)`. Returns chunk id, title, source, publishedAt, and first 500 chars of content.

**Company list:**
Derived from the graph.json nodes array (the same 34 companies tracked in dependency-graph-engine). This avoids a separate config file.

**Output:** `CompanyHealth[]` — one entry per company with thesis summary, assumptions, recent chunks, and healthScore.

---

## Stage 2a: Macro Regime Analysis (Claude)

`regime-analyzer.ts` takes the `CompanyHealth[]` from Stage 1 and calls Claude Sonnet 4.6 with tool use to classify the current macro regime.

**Prompt structure:**
- System prompt (cached): role as macro analyst + tool schema + regime taxonomy guide
- User message: formatted CompanyHealth summaries for all companies (thesis text + assumption statuses)

**Tool definition:**
```json
{
  "name": "classify_macro_regime",
  "description": "Classify the current macro technology investment regime based on company health signals",
  "input_schema": {
    "type": "object",
    "properties": {
      "regime": { "type": "string", "description": "Short label, e.g. AI Acceleration, Semiconductor Correction, Cloud Consolidation" },
      "confidence": { "type": "string", "enum": ["high", "medium", "low"] },
      "rationale": { "type": "string", "description": "2-3 sentence explanation of why this regime is in effect" },
      "keyIndicators": { "type": "array", "items": { "type": "string" }, "description": "3-5 specific evidence points drawn from company health data" },
      "affectedTickers": { "type": "array", "items": { "type": "string" }, "description": "Tickers most directly affected by this regime" }
    },
    "required": ["regime", "confidence", "rationale", "keyIndicators", "affectedTickers"]
  }
}
```

**Regime taxonomy examples** (included in system prompt to guide Claude):
- `AI Acceleration` — broad AI infrastructure spending up, GPU demand strong
- `Semiconductor Correction` — inventory excess, CapEx pullback across fab customers
- `Cloud Consolidation` — hyperscalers slowing new commitments, renegotiating contracts
- `Energy Bottleneck` — data center buildout constrained by power availability
- `AI Commoditization` — model costs falling, compute demand shifting to inference
- Claude may coin a new label when none fit — this is intentional

**Result:** One `MacroRegime` row inserted into `macro_regimes`. Subsequent daily runs create new rows; history is preserved.

---

## Stage 2b: Propagation Analysis (Claude)

`propagation-analyzer.ts` takes the MacroRegime from Stage 2a, the graph edges from graph.json, and the CompanyHealth array from Stage 1. It calls Claude Sonnet 4.6 with tool use to identify which dependency relationships are currently active and transmitting signals.

**Prompt structure:**
- System prompt (cached): role as supply chain analyst + tool schema + edge type semantics
- User message: macro regime summary + all graph edges (from→to, type, strength, description) + CompanyHealth for each ticker mentioned in edges

**Tool definition:**
```json
{
  "name": "propose_propagation_signals",
  "description": "Identify which dependency relationships are currently transmitting signals given the macro regime and company health data",
  "input_schema": {
    "type": "object",
    "properties": {
      "signals": {
        "type": "array",
        "items": {
          "type": "object",
          "properties": {
            "sourceTicker": { "type": "string" },
            "targetTicker": { "type": "string" },
            "signalType": { "type": "string", "enum": ["supply_chain", "customer", "technology", "competitive"] },
            "direction": { "type": "string", "enum": ["upstream", "downstream"] },
            "magnitude": { "type": "string", "enum": ["strong", "moderate", "weak"] },
            "sentiment": { "type": "string", "enum": ["positive", "negative", "neutral"] },
            "description": { "type": "string" },
            "evidenceQuote": { "type": "string" }
          },
          "required": ["sourceTicker", "targetTicker", "signalType", "direction", "magnitude", "sentiment", "description"]
        }
      }
    },
    "required": ["signals"]
  }
}
```

**Signal semantics:**
- `direction: "downstream"` — signal flows from source to its customers/dependents (source is upstream node)
- `direction: "upstream"` — signal flows back to source's suppliers (source is downstream node)
- An empty `signals` array is valid (regime is neutral, no active propagation)

**Result:** N `PropagationSignal` rows inserted into `propagation_signals`. Like regimes, history accumulates across daily runs.

---

## Export & Report

### JSON Export (`exporter.ts`)

Writes `data/analysis.json`:
```json
{
  "exportedAt": "2026-05-23T10:00:00.000Z",
  "latestRegime": { ...MacroRegime },
  "latestSignals": [ ...PropagationSignal[] ],
  "companySummaries": [
    { "ticker": "NVDA", "company": "NVIDIA", "healthScore": "positive", "thesisSummary": "..." }
  ]
}
```

### Markdown Report (`reporter.ts`)

Writes `data/reports/YYYY-MM-DD.md`:
```markdown
# AI Analysis — 2026-05-23

## Macro Regime: AI Acceleration (high confidence)
[rationale paragraph]

**Key Indicators:**
- ...

## Propagation Signals (12)

### Positive
- NVDA → CRWV (customer, downstream, strong): ...

### Negative
- TSM → AMD (supply_chain, upstream, moderate): ...

## Company Health Snapshot
| Ticker | Company | Health |
|--------|---------|--------|
| NVDA   | NVIDIA  | positive |
...
```

---

## CLI Commands

```
npm run analyze    ← run one full analysis cycle (Stage 1 + 2a + 2b + export + report)
npm run schedule   ← start daily cron (runs at 6:00 AM local time)
npm run report     ← print the latest report to stdout
```

`cli-run.ts` exits after one run. `cli-schedule.ts` keeps the process alive with node-cron.

---

## Testing

- Unit tests for `health-collector.ts` — mock thesis.db reads, mock LanceDB queries, verify healthScore computation
- Unit tests for `regime-analyzer.ts` — mock Claude tool response, verify MacroRegime shape
- Unit tests for `propagation-analyzer.ts` — mock Claude tool response, verify PropagationSignal shape and direction semantics
- Unit tests for `sqlite.ts` — regime insert, signal insert, run record insert
- Unit tests for `reporter.ts` — verify Markdown output structure
- No live Claude API calls in test suite

---

## Key Design Constraints

- **Read-only siblings** — never writes to thesis-memory, ingestion, or dependency-graph-engine data directories
- **Prompt caching** — system prompts for both Claude calls use `cache_control: { type: 'ephemeral' }` to minimize cost
- **History preserved** — each daily run appends new rows; old regime/signal rows are never deleted
- **No embeddings** — Stage 1 queries LanceDB with `.where()` filters only; no embedding model needed
- **No OpenAI** — generation via Anthropic SDK only; LanceDB accessed without vector search
- **graph.json as interface** — reads dependency graph via exported JSON, not by opening graph.db directly; respects the downstream-project boundary
