# Thesis Memory System — Design Spec
**Date:** 2026-05-22
**Status:** Approved

---

## Overview

A standalone TypeScript project that stores, tracks, and evolves investment theses over time. Theses consist of structured assumptions (each with a status) and a living narrative. When new data arrives in the ingestion store, Claude analyzes it against the current thesis and proposes updates. The user reviews and approves each proposed change before anything is written.

Runs entirely on local machine. Reads from the `capital-intelligence-ingestion` store but never writes to it.

---

## Goals

- Store investment theses as structured assumptions + living narrative per company and per theme
- Use Claude to analyze new ingestion data and propose thesis updates
- Require explicit user approval before any thesis change is committed
- Track full history of every thesis version — never overwrite, always append
- Roll company-level conviction up to theme-level summaries
- Suggest portfolio actions when conviction shifts significantly, clearly labeled as suggestions

## Non-Goals

- No autonomous updates — Claude proposes, user decides
- No price targets or quantitative models
- No UI — CLI only
- No cloud deployment
- No writing to the ingestion store

---

## Architecture

```
Ingestion Store (read-only)
  capital-intelligence-ingestion/data/lancedb/   vector chunks
  capital-intelligence-ingestion/data/sqlite.db  fetch log, watchlist
  ↓ semantic + filter search via query interface

Reasoning Engine
  retriever.ts    hybrid search for chunks relevant to each assumption
  prompter.ts     builds structured prompt: thesis + evidence chunks
  analyzer.ts     calls Claude API, parses structured JSON response

Thesis Store (SQLite — local only)
  theses, assumptions, narratives, proposals, proposal_changes, theme_memberships

CLI
  npm run thesis -- create / show / list / history
  npm run update -- [--ticker] [--theme]
  npm run review
```

---

## Data Model

### `theses`
```sql
id            TEXT PRIMARY KEY
ticker        TEXT            -- 'NVDA' for company, theme name for theme
type          TEXT            -- 'company' | 'theme'
position_size TEXT            -- 'core' | 'satellite' | 'watchlist' | 'none' — set by user at creation, updatable via thesis show
created_at    TEXT
updated_at    TEXT
```

### `assumptions`
```sql
id                    TEXT PRIMARY KEY
thesis_id             TEXT REFERENCES theses(id)
label                 TEXT    -- e.g. "CUDA moat remains dominant"
status                TEXT    -- 'strengthening' | 'stable' | 'weakening' | 'broken'
last_evidence_summary TEXT    -- brief note on latest supporting/contradicting evidence
created_at            TEXT
updated_at            TEXT
```

### `narratives`
```sql
id         TEXT PRIMARY KEY
thesis_id  TEXT REFERENCES theses(id)
content    TEXT    -- full markdown narrative
version    INTEGER -- increments on each approved update
created_at TEXT
```
Append-only — every version retained. Never updated in place.

### `proposals`
```sql
id               TEXT PRIMARY KEY
thesis_id        TEXT REFERENCES theses(id)
status           TEXT    -- 'pending' | 'approved' | 'rejected'
chunk_ids_used   TEXT    -- JSON array of ingestion chunk IDs used as evidence
claude_reasoning TEXT    -- full Claude response stored for auditability
created_at       TEXT
resolved_at      TEXT
```

### `proposal_changes`
```sql
id              TEXT PRIMARY KEY
proposal_id     TEXT REFERENCES proposals(id)
change_type     TEXT    -- 'assumption_status' | 'narrative' | 'portfolio_action'
assumption_id   TEXT    -- nullable, used for assumption_status changes
old_value       TEXT
new_value       TEXT
reasoning       TEXT    -- Claude's explanation for this specific change
evidence_quotes TEXT    -- JSON array of direct quotes from ingestion chunks
approved        INTEGER -- 1 = approved, 0 = rejected, null = pending
```

### `theme_memberships`
```sql
theme_id  TEXT REFERENCES theses(id)
ticker    TEXT REFERENCES theses(ticker)
weight    REAL    -- 0.0–1.0, for weighted conviction rollup
```

---

## Reasoning Engine

### Step 1 — Retrieve relevant chunks

For each assumption in the thesis, run a hybrid search against the ingestion store:

```
assumption: "CUDA moat remains dominant"
query:      "CUDA competitive advantage software ecosystem switching cost custom ASIC"
filters:    { ticker: 'NVDA', dateFrom: lastUpdated }
topK:       10
```

Deduplicate across assumptions. Cap total context at 30 chunks per update cycle to stay within Claude's context budget.

### Step 2 — Build prompt

```
You are analyzing whether new evidence changes an investment thesis.

CURRENT THESIS: NVIDIA Corporation (as of {lastUpdated})
Position: Core holding

Narrative:
{currentNarrative}

Assumptions:
- [stable]      CUDA moat remains dominant
- [weakening]   Hyperscaler AI capex growing
- [stable]      Sovereign AI spending rising
- [stable]      Advanced packaging not a bottleneck

NEW EVIDENCE ({lastUpdated} → {today}):
[source: 10-Q 2026-05-20, section: mda]
"..."

[source: article 2026-05-21]
"Nvidia posts 85% revenue surge..."

[source: transcript 2026-05-20, section: qa_session]
"..."

Analyze each assumption. For each one, state whether the evidence
strengthens, weakens, breaks, or leaves unchanged the assumption.
Then propose an updated narrative. If conviction has shifted
significantly, suggest a portfolio action.

Respond in the exact JSON format specified.
```

### Step 3 — Structured output (Claude tool use)

```typescript
interface ProposalResponse {
  assumption_changes: Array<{
    label: string
    old_status: AssumptionStatus
    new_status: AssumptionStatus
    reasoning: string
    evidence_quotes: string[]
  }>
  narrative_update: string
  portfolio_action: {
    action: 'buy' | 'add' | 'hold' | 'reduce' | 'sell' | 'rotate'
    reasoning: string
    conviction: number  // 1–10
  } | null
}
```

Uses Claude's tool use (function calling) to enforce structured JSON output.

### Step 4 — Store as pending proposal

Written to SQLite with `status: 'pending'`. Thesis is unchanged until user approves.

---

## Approval CLI (`npm run review`)

```
=== Pending Proposals (2) ===

[1/2] NVIDIA — generated 2026-05-22 09:41

  Assumption changes:
  ✦ Hyperscaler AI capex growing: weakening → STRENGTHENING
    Reasoning: Q1 2026 10-Q shows data center revenue +427% YoY. Jensen Huang
    confirmed "demand exceeds supply through end of year."
    Evidence: "revenue of $39.3 billion, up 69% from a year ago"

  ✦ Advanced packaging not a bottleneck: stable → WEAKENING
    Reasoning: Multiple articles reference CoWoS capacity constraints at TSMC
    Evidence: "packaging constraints limiting Blackwell shipment ramp"

  Narrative update:
    OLD: The NVIDIA thesis faces near-term uncertainty around capex timing...
    NEW: The NVIDIA thesis has strengthened materially. Blackwell demand...

  Portfolio action (suggestion only):
    HOLD — thesis intact, valuation stretch limits upside (conviction: 8/10)

  [a] Approve all  [r] Reject all
  [1] Toggle assumption 1  [2] Toggle assumption 2
  [n] Toggle narrative  [p] Toggle portfolio action
  [s] Skip to next  [q] Quit

>
```

- Granular approval: each change can be approved or rejected independently
- Rejected changes are recorded (with reason) — part of the audit trail
- `[s]` skips the proposal without resolving it — stays pending for next review

---

## CLI Reference

```bash
# Create a thesis
npm run thesis -- create --ticker=NVDA           # AI drafts from ingestion data
npm run thesis -- create --ticker=NVDA --manual  # open $EDITOR to write manually
npm run thesis -- create --theme=ai-infrastructure  # theme-level thesis

# View theses
npm run thesis -- show --ticker=NVDA
npm run thesis -- show --theme=ai-infrastructure
npm run thesis -- list                           # all theses, conviction summary
npm run thesis -- history --ticker=NVDA          # full version history

# Generate update proposals (calls Claude)
npm run update -- --ticker=NVDA
npm run update -- --theme=ai-infrastructure
npm run update                                   # all theses

# Review and approve pending proposals
npm run review
```

---

## Theme Rollup

Theme conviction is computed from the weighted average of company assumption statuses:

```
Status weights: strengthening=1.0, stable=0.5, weakening=0.0, broken=-0.5

Theme conviction score = weighted average of (company scores × company weight)
Score → label: ≥0.8 strengthening, ≥0.5 stable, ≥0.2 weakening, <0.2 broken
```

Display (`npm run thesis -- show --theme=ai-infrastructure`):

```
AI Infrastructure Theme
Overall conviction: STRENGTHENING  (score: 0.81)

  NVDA  ████████░░  strengthening  (weight: 0.35)
  TSM   ██████░░░░  stable         (weight: 0.25)
  ASML  ████░░░░░░  weakening      (weight: 0.20)
  INTC  ██░░░░░░░░  weakening      (weight: 0.10)
  AMAT  █████░░░░░  stable         (weight: 0.10)
```

---

## Project Structure

```
thesis-memory/
  src/
    store/
      sqlite.ts          schema creation, all CRUD operations
    reasoning/
      retriever.ts       hybrid search against ingestion store
      prompter.ts        builds Claude prompt from thesis + evidence chunks
      analyzer.ts        calls Claude API, parses structured response
    thesis/
      creator.ts         AI-draft or manual thesis creation flow
      updater.ts         applies approved proposal_changes to thesis store
      rollup.ts          computes theme conviction from member company theses
    cli/
      thesis.ts          create / show / list / history commands
      update.ts          generate proposals (orchestrates retriever + analyzer)
      review.ts          interactive proposal approval interface
  data/
    thesis.db            gitignored — local only
  .env.example
  .gitignore
  package.json
  tsconfig.json
  README.md
```

---

## Environment Variables

```
ANTHROPIC_API_KEY=      # already set in ingestion project .env
INGESTION_STORE_PATH=   # absolute path to capital-intelligence-ingestion/data/
```

`INGESTION_STORE_PATH` defaults to `../capital-intelligence-ingestion/data` if not set, assuming the two projects are siblings.

---

## Key Dependencies

| Package | Purpose |
|---|---|
| `@anthropic-ai/sdk` | Claude API for reasoning and structured output |
| `better-sqlite3` | Thesis SQLite store |
| `@lancedb/lancedb` | Read ingestion vector store for retrieval |
| `@huggingface/transformers` | Embed search queries (same model as ingestion) |
| `dotenv` | Environment variables |
| `tsx` | TypeScript execution |
| `vitest` | Testing |
| `typescript` | Language |

---

## .gitignore

```
.env
node_modules/
dist/
data/
.cache/
```

`data/` (thesis.db) never pushed — stays entirely local.
