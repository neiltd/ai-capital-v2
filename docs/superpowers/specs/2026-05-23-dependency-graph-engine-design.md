# Dependency Graph Engine — Design Spec

**Date:** 2026-05-23  
**Project:** AI Capital Flow & Technology Intelligence System (sub-project 4 of 7)  
**Status:** Approved

---

## Overview

A standalone TypeScript project that builds and maintains a directed relationship graph across all tracked companies. It seeds known relationships from a hand-curated config, then uses Claude to scan ingested documents for new edges. All Claude-proposed edges go through a human-in-the-loop approval step before being committed. The confirmed graph is persisted in SQLite and exported to JSON for downstream consumption by the AI Analysis Engine and Scenario Simulator.

---

## Architecture

```
dependency-graph-engine/
  src/
    types.ts
    seed/
      seed.config.ts       ← hand-curated known relationships
      seed-loader.ts       ← loads/refreshes seed into graph.db
    store/
      sqlite.ts            ← graph.db schema, CRUD operations
    graph/
      engine.ts            ← in-memory adjacency map + traversal API
      traversal.ts         ← BFS/DFS path-finding algorithms
    scanner/
      extractor.ts         ← Claude-based relationship extraction
      scanner.ts           ← orchestrates scan across company pairs
    export/
      exporter.ts          ← writes data/graph.json
    cli/
      cli-seed.ts          ← npm run seed
      cli-scan.ts          ← npm run scan
      cli-review.ts        ← npm run review
      cli-query.ts         ← npm run query
      cli-export.ts        ← npm run export
  tests/
  data/                    ← gitignored (graph.db, graph.json)
  package.json
  tsconfig.json
  .env
```

**Reads from (read-only):**
- `../capital-intelligence-ingestion/data/lancedb` — semantic search for relationship signals
- `../capital-intelligence-ingestion/data/sqlite.db` — company/watchlist metadata

**Writes to (own data only):**
- `data/graph.db` — SQLite source of truth
- `data/graph.json` — periodic JSON export for downstream projects

---

## Tech Stack

Matches existing projects exactly — no new patterns introduced:

| Dependency | Purpose |
|---|---|
| `typescript` + `tsx` | Language + runtime |
| `better-sqlite3` | Own graph.db |
| `@lancedb/lancedb` | Read-only access to ingestion LanceDB |
| `@huggingface/transformers` | Local embedder (Xenova/all-MiniLM-L6-v2) for semantic search |
| `@anthropic-ai/sdk` | Claude Sonnet 4.6 for relationship extraction |
| `dotenv` | Env vars (ANTHROPIC_API_KEY) |
| `vitest` | Tests |

---

## Data Model

### Types

```ts
type RelType   = 'supply_chain' | 'customer' | 'technology' | 'competitive'
type Strength  = 'strong' | 'moderate' | 'weak'
type EdgeStatus = 'seed' | 'confirmed' | 'rejected' | 'pending'
type ProposalStatus = 'pending' | 'approved' | 'rejected'
```

**Relationship semantics (edge direction: `from` → `to` means "from depends on to" or "from relates to to"):**
- `supply_chain` — `from` is supplied by `to` (e.g., NVDA→TSM: NVIDIA depends on TSMC to fab chips)
- `customer` — `from` is a customer of `to` (e.g., CRWV→NVDA: CoreWeave buys from NVIDIA)
- `technology` — `from` runs on or is built on `to`'s technology (e.g., META→NVDA: Meta's infra runs on NVIDIA GPUs)
- `competitive` — `from` competes with `to` in overlapping markets (symmetric in practice)

**Strength semantics:**
- `strong` — explicitly stated in public filings or widely known
- `moderate` — mentioned in documents, reasonably certain
- `weak` — inferred, tentative, or indirect

### SQLite Schema (graph.db)

```sql
nodes (
  ticker      TEXT PRIMARY KEY,
  company     TEXT NOT NULL,
  themes      TEXT NOT NULL   -- JSON array e.g. ["ai-infrastructure","semiconductors"]
)

edges (
  id               TEXT PRIMARY KEY,   -- uuid
  from_ticker      TEXT NOT NULL,
  to_ticker        TEXT NOT NULL,
  rel_type         TEXT NOT NULL,      -- RelType
  strength         TEXT NOT NULL,      -- Strength
  description      TEXT NOT NULL,
  status           TEXT NOT NULL,      -- EdgeStatus
  source_chunk_ids TEXT NOT NULL,      -- JSON array of chunk IDs
  evidence_quote   TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
)

proposals (
  id              TEXT PRIMARY KEY,
  status          TEXT NOT NULL,       -- ProposalStatus
  claude_reasoning TEXT NOT NULL,
  chunk_ids_used  TEXT NOT NULL,       -- JSON array
  created_at      TEXT NOT NULL,
  resolved_at     TEXT
)

proposal_edges (
  id             TEXT PRIMARY KEY,
  proposal_id    TEXT NOT NULL,
  from_ticker    TEXT NOT NULL,
  to_ticker      TEXT NOT NULL,
  rel_type       TEXT NOT NULL,
  strength       TEXT NOT NULL,
  description    TEXT NOT NULL,
  evidence_quote TEXT,
  approved       INTEGER              -- NULL=pending, 1=approved, 0=rejected
)
```

**Edge lifecycle:**
- Seed edges → `status = 'seed'` (always trusted, never re-reviewed)
- Claude proposals → `proposals` + `proposal_edges` (approved=NULL) → user approves → edge inserted into `edges` with `status = 'confirmed'`
- Rejected proposals → `proposal_edges.approved = 0`, never written to `edges`

---

## Graph Engine & Traversal API

`engine.ts` loads all `seed` and `confirmed` edges from SQLite into two in-memory adjacency maps at startup (forward + reverse). With 21–30 nodes this is trivially fast.

```ts
interface GraphEngine {
  upstream(ticker: string, relType?: RelType): Edge[]    // who does X depend on?
  downstream(ticker: string, relType?: RelType): Edge[]  // who depends on X?
  neighbors(ticker: string, relType?: RelType): Edge[]   // both directions
  paths(from: string, to: string): Edge[][]              // all simple paths (BFS, max 4 hops)
  nodes(): Node[]
  edges(): Edge[]
  toJSON(): GraphJSON
}
```

`traversal.ts` implements BFS for `paths()`. Max depth defaults to 4 hops (configurable). Cycles are avoided by tracking visited nodes per path.

---

## Scanner & Proposal Flow

### Step 1 — Pair selection
For each ordered company pair (A, B) in the watchlist, run a semantic search against the ingestion LanceDB using the local embedder. Query: both ticker symbols together. Only pairs with at least one matching chunk above a similarity threshold proceed to Claude.

Pairs where an edge already exists (any status) in the same direction and type are skipped to avoid re-proposing known relationships.

### Step 2 — Claude extraction
Matching chunks for a pair are sent to Claude Sonnet 4.6 with prompt caching enabled (system prompt cached). The prompt instructs Claude to identify dependency relationships and respond with structured JSON:

```json
{
  "relationships": [{
    "from": "NVDA",
    "to": "TSM",
    "type": "supply_chain",
    "strength": "strong",
    "description": "TSMC manufactures NVIDIA's H100/B200 GPUs at 4nm node",
    "evidence_quote": "Our supply agreement with TSMC covers...",
    "reasoning": "Explicitly stated in 10-K risk factors section"
  }]
}
```

An empty `relationships` array is a valid response (no relationship found).

### Step 3 — Proposal storage
Claude's response becomes one `proposals` record. Each relationship item becomes a `proposal_edges` row with `approved = NULL`. Only relationships not already present in `edges` are stored.

### Step 4 — Human review (`npm run review`)
Pages through pending `proposal_edges` one at a time:

```
[1/3] NVDA → TSM  (supply_chain, strong)
Description: "TSMC manufactures NVIDIA's H100/B200 GPUs at 4nm node"
Evidence:    "Our supply agreement with TSMC covers..."
Reasoning:   "Explicitly stated in 10-K risk factors"

Approve? [y/n/skip] 
```

- `y` → `proposal_edges.approved = 1`, edge inserted into `edges` with `status = 'confirmed'`
- `n` → `proposal_edges.approved = 0`, nothing written to `edges`
- `skip` → remains pending, shown again next review session

---

## CLI Commands

```
npm run seed     ← load/refresh seed.config.ts relationships into graph.db
npm run scan     ← Claude scans new ingested chunks for relationship signals
npm run review   ← approve/reject pending Claude proposals
npm run query    ← interactive graph query (see examples below)
npm run export   ← write data/graph.json from confirmed+seed edges
```

Query examples:
```
npm run query -- --ticker NVDA --direction upstream
npm run query -- --ticker NVDA --direction downstream --type supply_chain
npm run query -- --from CRWV --to ASML
npm run query -- --ticker TSM --direction downstream --type customer
```

---

## JSON Export Schema

```json
{
  "exportedAt": "2026-05-23T10:00:00.000Z",
  "nodes": [
    { "ticker": "NVDA", "company": "NVIDIA Corporation", "themes": ["ai-infrastructure"] }
  ],
  "edges": [
    {
      "from": "NVDA",
      "to": "TSM",
      "type": "supply_chain",
      "strength": "strong",
      "description": "TSMC is NVIDIA's primary foundry partner for GPU production",
      "evidenceQuote": "Our wafer supply agreements with TSMC..."
    }
  ]
}
```

Exported to `data/graph.json`. Downstream projects (AI Analysis Engine, Scenario Simulator) read this file directly — same pattern as `world-intelligence-data-hub-/exports/intelligence.json`.

---

## Testing

- Unit tests for `traversal.ts` — BFS correctness, cycle avoidance, max depth
- Unit tests for `sqlite.ts` — edge CRUD, proposal lifecycle
- Unit tests for `exporter.ts` — JSON shape matches schema
- Integration test for `engine.ts` — load edges from SQLite, verify traversal results
- Mock Claude responses in `extractor.ts` tests (no live API calls in test suite)

---

## Seed Config Example

`seed.config.ts` follows the same pattern as `themes.config.ts`:

```ts
export const SEED_EDGES: SeedEdge[] = [
  { from: 'NVDA', to: 'TSM',  type: 'supply_chain', strength: 'strong',  description: 'TSMC manufactures NVIDIA GPUs (H100, B200) at advanced nodes' },
  { from: 'AMD',  to: 'TSM',  type: 'supply_chain', strength: 'strong',  description: 'TSMC manufactures AMD CPUs and GPUs' },
  { from: 'CRWV', to: 'NVDA', type: 'customer',     strength: 'strong',  description: 'CoreWeave (from) is a major customer of NVIDIA (to) — buys GPUs at scale' },
  { from: 'MSFT', to: 'NVDA', type: 'customer',     strength: 'strong',  description: 'Microsoft Azure (from) is a major customer of NVIDIA (to) for GPU infrastructure' },
  { from: 'AMD',  to: 'NVDA', type: 'competitive',  strength: 'strong',  description: 'AMD Instinct competes with NVIDIA in AI accelerator market' },
  // ... more seed edges
]
```

---

## Key Design Constraints

- **Read-only siblings** — never writes to `capital-intelligence-ingestion/data/`
- **Human-in-the-loop** — Claude proposes, user approves, nothing auto-commits
- **Local only** — `data/` gitignored, pushed as private repo for version control only
- **No OpenAI** — embeddings via local Xenova model, generation via Anthropic SDK only
- **Prompt caching** — Claude calls use prompt caching to minimize cost
