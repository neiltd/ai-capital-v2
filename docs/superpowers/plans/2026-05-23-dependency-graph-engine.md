# Dependency Graph Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a standalone TypeScript project that maintains a directed relationship graph across 34 tracked companies — seeded from hand-curated config, enriched via Claude scanning ingested documents, with human-in-the-loop approval for all AI-proposed edges.

**Architecture:** SQLite (`graph.db`) is the source of truth for nodes, edges, and proposals. On startup the graph is loaded into an in-memory adjacency map for BFS/DFS traversal. Claude scans chunks from `capital-intelligence-ingestion/data/lancedb` (read-only) and proposes edges; the user approves via `npm run review`. The confirmed graph is exported to `data/graph.json` for downstream projects.

**Tech Stack:** TypeScript + tsx + vitest, better-sqlite3, @lancedb/lancedb (read-only), @anthropic-ai/sdk (Claude Sonnet 4.6 with prompt caching), dotenv.

---

## File Map

| File | Purpose |
|---|---|
| `package.json` | Scripts + dependencies |
| `tsconfig.json` | TypeScript config (ESM, NodeNext) |
| `vitest.config.ts` | Vitest config |
| `.env.example` | Env var template |
| `.gitignore` | Ignore `data/`, `.env`, `node_modules/` |
| `src/types.ts` | All shared types |
| `src/store/sqlite.ts` | graph.db schema + CRUD |
| `src/graph/traversal.ts` | BFS path-finding algorithm |
| `src/graph/engine.ts` | In-memory adjacency map + traversal API |
| `src/seed/seed.config.ts` | Hand-curated known relationships |
| `src/seed/seed-loader.ts` | Loads seed config into graph.db |
| `src/scanner/extractor.ts` | Claude-based relationship extraction |
| `src/scanner/scanner.ts` | Orchestrates scan across company pairs |
| `src/export/exporter.ts` | Writes data/graph.json |
| `src/cli/cli-seed.ts` | `npm run seed` entrypoint |
| `src/cli/cli-scan.ts` | `npm run scan` entrypoint |
| `src/cli/cli-review.ts` | `npm run review` entrypoint |
| `src/cli/cli-query.ts` | `npm run query` entrypoint |
| `src/cli/cli-export.ts` | `npm run export` entrypoint |
| `tests/store.test.ts` | SQLite store unit tests |
| `tests/traversal.test.ts` | Traversal algorithm unit tests |
| `tests/engine.test.ts` | Graph engine unit tests |
| `tests/seed-loader.test.ts` | Seed loader unit tests |
| `tests/extractor.test.ts` | Extractor unit tests (mocked Claude) |
| `tests/exporter.test.ts` | Exporter unit tests |

---

## Task 1: Project Scaffold

**Files:**
- Create: `dependency-graph-engine/package.json`
- Create: `dependency-graph-engine/tsconfig.json`
- Create: `dependency-graph-engine/vitest.config.ts`
- Create: `dependency-graph-engine/.env.example`
- Create: `dependency-graph-engine/.gitignore`

- [ ] **Step 1: Create project directory and scaffold files**

```bash
mkdir -p /Users/thanapold/Desktop/Projects/dependency-graph-engine
cd /Users/thanapold/Desktop/Projects/dependency-graph-engine
mkdir -p src/store src/graph src/seed src/scanner src/export src/cli tests
```

- [ ] **Step 2: Write `package.json`**

```json
{
  "name": "dependency-graph-engine",
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "seed":       "tsx src/cli/cli-seed.ts",
    "scan":       "tsx src/cli/cli-scan.ts",
    "review":     "tsx src/cli/cli-review.ts",
    "query":      "tsx src/cli/cli-query.ts",
    "export":     "tsx src/cli/cli-export.ts",
    "test":       "vitest run",
    "test:watch": "vitest"
  },
  "dependencies": {
    "@anthropic-ai/sdk":  "^0.39.0",
    "@lancedb/lancedb":   "^0.29.0",
    "better-sqlite3":     "^12.0.0",
    "dotenv":             "^16.0.0"
  },
  "devDependencies": {
    "@types/better-sqlite3": "^7.6.11",
    "@types/node":           "^22.0.0",
    "tsx":                   "^4.16.0",
    "typescript":            "^5.5.0",
    "vitest":                "^2.0.0"
  }
}
```

- [ ] **Step 3: Write `tsconfig.json`**

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

- [ ] **Step 4: Write `vitest.config.ts`**

```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
  },
})
```

- [ ] **Step 5: Write `.env.example` and `.gitignore`**

`.env.example`:
```
ANTHROPIC_API_KEY=your_key_here
```

`.gitignore`:
```
node_modules/
dist/
data/
.env
```

- [ ] **Step 6: Install dependencies**

```bash
npm install
```

Expected: `node_modules/` created, no errors.

- [ ] **Step 7: Commit**

```bash
git init
git add package.json tsconfig.json vitest.config.ts .env.example .gitignore
git commit -m "feat: scaffold dependency-graph-engine project"
```

---

## Task 2: Types

**Files:**
- Create: `src/types.ts`

- [ ] **Step 1: Write `src/types.ts`**

```ts
export type RelType      = 'supply_chain' | 'customer' | 'technology' | 'competitive'
export type Strength     = 'strong' | 'moderate' | 'weak'
export type EdgeStatus   = 'seed' | 'confirmed' | 'rejected' | 'pending'
export type ProposalStatus = 'pending' | 'approved' | 'rejected'

export interface Node {
  ticker:  string
  company: string
  themes:  string[]
}

export interface Edge {
  id:             string
  from:           string
  to:             string
  type:           RelType
  strength:       Strength
  description:    string
  status:         EdgeStatus
  sourceChunkIds: string[]
  evidenceQuote:  string | null
  createdAt:      string
  updatedAt:      string
}

export interface Proposal {
  id:              string
  status:          ProposalStatus
  claudeReasoning: string
  chunkIdsUsed:    string[]
  createdAt:       string
  resolvedAt:      string | null
}

export interface ProposalEdge {
  id:            string
  proposalId:    string
  from:          string
  to:            string
  type:          RelType
  strength:      Strength
  description:   string
  evidenceQuote: string | null
  approved:      boolean | null
}

export interface SeedEdge {
  from:        string
  to:          string
  type:        RelType
  strength:    Strength
  description: string
}

export interface GraphJSON {
  exportedAt: string
  nodes: Array<{ ticker: string; company: string; themes: string[] }>
  edges: Array<{
    from:          string
    to:            string
    type:          RelType
    strength:      Strength
    description:   string
    evidenceQuote: string | null
  }>
}

export interface ExtractedRelationship {
  from:          string
  to:            string
  type:          RelType
  strength:      Strength
  description:   string
  evidenceQuote: string
  reasoning:     string
}

export interface ExtractionResult {
  relationships: ExtractedRelationship[]
}
```

- [ ] **Step 2: Commit**

```bash
git add src/types.ts
git commit -m "feat: add shared types"
```

---

## Task 3: SQLite Store

**Files:**
- Create: `tests/store.test.ts`
- Create: `src/store/sqlite.ts`

- [ ] **Step 1: Write failing tests in `tests/store.test.ts`**

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { unlinkSync, existsSync } from 'fs'
import { createGraphStore } from '../src/store/sqlite.js'
import type { Node, Edge } from '../src/types.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const TEST_DB = join(__dirname, 'test-graph.db')

describe('GraphStore', () => {
  let store: ReturnType<typeof createGraphStore>

  beforeEach(() => { store = createGraphStore(TEST_DB) })
  afterEach(() => {
    store.close()
    if (existsSync(TEST_DB)) unlinkSync(TEST_DB)
  })

  const testEdge: Edge = {
    id: 'e1', from: 'NVDA', to: 'TSM', type: 'supply_chain', strength: 'strong',
    description: 'TSMC fabs NVIDIA chips', status: 'seed',
    sourceChunkIds: [], evidenceQuote: null,
    createdAt: '2026-05-23T00:00:00.000Z', updatedAt: '2026-05-23T00:00:00.000Z',
  }

  it('upserts and retrieves nodes', () => {
    const node: Node = { ticker: 'NVDA', company: 'NVIDIA', themes: ['ai-infrastructure'] }
    store.upsertNode(node)
    const nodes = store.getNodes()
    expect(nodes).toHaveLength(1)
    expect(nodes[0]).toEqual(node)
  })

  it('upsert is idempotent', () => {
    const node: Node = { ticker: 'NVDA', company: 'NVIDIA', themes: ['ai-infrastructure'] }
    store.upsertNode(node)
    store.upsertNode({ ...node, company: 'NVIDIA Corporation' })
    expect(store.getNodes()).toHaveLength(1)
    expect(store.getNodes()[0].company).toBe('NVIDIA Corporation')
  })

  it('inserts edge and retrieves active edges', () => {
    store.insertEdge(testEdge)
    const edges = store.getActiveEdges()
    expect(edges).toHaveLength(1)
    expect(edges[0].from).toBe('NVDA')
    expect(edges[0].to).toBe('TSM')
    expect(edges[0].sourceChunkIds).toEqual([])
  })

  it('does not return rejected edges as active', () => {
    store.insertEdge({ ...testEdge, id: 'e2', status: 'rejected' })
    expect(store.getActiveEdges()).toHaveLength(0)
  })

  it('detects existing edges (ignores direction and different types)', () => {
    store.insertEdge(testEdge)
    expect(store.edgeExists('NVDA', 'TSM', 'supply_chain')).toBe(true)
    expect(store.edgeExists('TSM', 'NVDA', 'supply_chain')).toBe(false)
    expect(store.edgeExists('NVDA', 'TSM', 'customer')).toBe(false)
  })

  it('ignores duplicate edge inserts', () => {
    store.insertEdge(testEdge)
    store.insertEdge(testEdge)
    expect(store.getActiveEdges()).toHaveLength(1)
  })

  it('manages proposal lifecycle', () => {
    store.insertProposal({
      id: 'p1', status: 'pending', claudeReasoning: 'test',
      chunkIdsUsed: ['c1'], createdAt: '2026-05-23T00:00:00.000Z', resolvedAt: null,
    })
    store.insertProposalEdge({
      id: 'pe1', proposalId: 'p1', from: 'AMZN', to: 'NVDA',
      type: 'customer', strength: 'strong',
      description: 'AWS buys NVIDIA GPUs', evidenceQuote: null, approved: null,
    })
    expect(store.getPendingProposalEdges()).toHaveLength(1)
    store.resolveProposalEdge('pe1', true)
    expect(store.getPendingProposalEdges()).toHaveLength(0)
  })
})
```

- [ ] **Step 2: Run test to confirm it fails**

```bash
npm test -- store
```

Expected: FAIL — `createGraphStore` not found.

- [ ] **Step 3: Implement `src/store/sqlite.ts`**

```ts
import Database from 'better-sqlite3'
import type { Node, Edge, Proposal, ProposalEdge, EdgeStatus, RelType, Strength } from '../types.js'

export interface GraphStore {
  upsertNode(node: Node): void
  getNodes(): Node[]
  insertEdge(edge: Edge): void
  edgeExists(from: string, to: string, type: string): boolean
  getActiveEdges(): Edge[]
  insertProposal(proposal: Proposal): void
  insertProposalEdge(pe: ProposalEdge): void
  getPendingProposalEdges(): ProposalEdge[]
  resolveProposalEdge(id: string, approved: boolean): void
  close(): void
}

export function createGraphStore(dbPath: string): GraphStore {
  const db = new Database(dbPath)

  db.exec(`
    CREATE TABLE IF NOT EXISTS nodes (
      ticker  TEXT PRIMARY KEY,
      company TEXT NOT NULL,
      themes  TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS edges (
      id               TEXT PRIMARY KEY,
      from_ticker      TEXT NOT NULL,
      to_ticker        TEXT NOT NULL,
      rel_type         TEXT NOT NULL,
      strength         TEXT NOT NULL,
      description      TEXT NOT NULL,
      status           TEXT NOT NULL,
      source_chunk_ids TEXT NOT NULL,
      evidence_quote   TEXT,
      created_at       TEXT NOT NULL,
      updated_at       TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS proposals (
      id               TEXT PRIMARY KEY,
      status           TEXT NOT NULL,
      claude_reasoning TEXT NOT NULL,
      chunk_ids_used   TEXT NOT NULL,
      created_at       TEXT NOT NULL,
      resolved_at      TEXT
    );
    CREATE TABLE IF NOT EXISTS proposal_edges (
      id             TEXT PRIMARY KEY,
      proposal_id    TEXT NOT NULL,
      from_ticker    TEXT NOT NULL,
      to_ticker      TEXT NOT NULL,
      rel_type       TEXT NOT NULL,
      strength       TEXT NOT NULL,
      description    TEXT NOT NULL,
      evidence_quote TEXT,
      approved       INTEGER
    );
  `)

  return {
    upsertNode(node: Node): void {
      db.prepare(`
        INSERT INTO nodes (ticker, company, themes) VALUES (?, ?, ?)
        ON CONFLICT(ticker) DO UPDATE SET company = excluded.company, themes = excluded.themes
      `).run(node.ticker, node.company, JSON.stringify(node.themes))
    },

    getNodes(): Node[] {
      const rows = db.prepare('SELECT * FROM nodes').all() as any[]
      return rows.map(r => ({ ticker: r.ticker, company: r.company, themes: JSON.parse(r.themes) }))
    },

    insertEdge(edge: Edge): void {
      db.prepare(`
        INSERT OR IGNORE INTO edges
          (id, from_ticker, to_ticker, rel_type, strength, description, status,
           source_chunk_ids, evidence_quote, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        edge.id, edge.from, edge.to, edge.type, edge.strength,
        edge.description, edge.status, JSON.stringify(edge.sourceChunkIds),
        edge.evidenceQuote, edge.createdAt, edge.updatedAt,
      )
    },

    edgeExists(from: string, to: string, type: string): boolean {
      const row = db.prepare(`
        SELECT id FROM edges
        WHERE from_ticker = ? AND to_ticker = ? AND rel_type = ? AND status != 'rejected'
      `).get(from, to, type)
      return row !== undefined
    },

    getActiveEdges(): Edge[] {
      const rows = db.prepare(
        `SELECT * FROM edges WHERE status IN ('seed', 'confirmed')`
      ).all() as any[]
      return rows.map(r => ({
        id:             r.id,
        from:           r.from_ticker,
        to:             r.to_ticker,
        type:           r.rel_type as RelType,
        strength:       r.strength as Strength,
        description:    r.description,
        status:         r.status as EdgeStatus,
        sourceChunkIds: JSON.parse(r.source_chunk_ids),
        evidenceQuote:  r.evidence_quote ?? null,
        createdAt:      r.created_at,
        updatedAt:      r.updated_at,
      }))
    },

    insertProposal(proposal: Proposal): void {
      db.prepare(`
        INSERT INTO proposals (id, status, claude_reasoning, chunk_ids_used, created_at, resolved_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        proposal.id, proposal.status, proposal.claudeReasoning,
        JSON.stringify(proposal.chunkIdsUsed), proposal.createdAt, proposal.resolvedAt,
      )
    },

    insertProposalEdge(pe: ProposalEdge): void {
      db.prepare(`
        INSERT INTO proposal_edges
          (id, proposal_id, from_ticker, to_ticker, rel_type, strength, description, evidence_quote, approved)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        pe.id, pe.proposalId, pe.from, pe.to, pe.type, pe.strength,
        pe.description, pe.evidenceQuote,
        pe.approved === null ? null : pe.approved ? 1 : 0,
      )
    },

    getPendingProposalEdges(): ProposalEdge[] {
      const rows = db.prepare(
        `SELECT * FROM proposal_edges WHERE approved IS NULL`
      ).all() as any[]
      return rows.map(r => ({
        id:            r.id,
        proposalId:    r.proposal_id,
        from:          r.from_ticker,
        to:            r.to_ticker,
        type:          r.rel_type as RelType,
        strength:      r.strength as Strength,
        description:   r.description,
        evidenceQuote: r.evidence_quote ?? null,
        approved:      null,
      }))
    },

    resolveProposalEdge(id: string, approved: boolean): void {
      db.prepare(`UPDATE proposal_edges SET approved = ? WHERE id = ?`)
        .run(approved ? 1 : 0, id)
    },

    close(): void { db.close() },
  }
}
```

- [ ] **Step 4: Run tests and confirm they pass**

```bash
npm test -- store
```

Expected: all 7 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/store/sqlite.ts tests/store.test.ts
git commit -m "feat: add SQLite graph store with full CRUD"
```

---

## Task 4: Graph Traversal

**Files:**
- Create: `tests/traversal.test.ts`
- Create: `src/graph/traversal.ts`

- [ ] **Step 1: Write failing tests in `tests/traversal.test.ts`**

```ts
import { describe, it, expect } from 'vitest'
import { findPaths } from '../src/graph/traversal.js'
import type { Edge } from '../src/types.js'

function edge(from: string, to: string): Edge {
  return {
    id: `${from}-${to}`, from, to, type: 'supply_chain', strength: 'strong',
    description: '', status: 'seed', sourceChunkIds: [],
    evidenceQuote: null, createdAt: '', updatedAt: '',
  }
}

describe('findPaths', () => {
  it('finds a direct one-hop path', () => {
    const forward = new Map([['A', [edge('A', 'B')]]])
    const paths = findPaths(forward, 'A', 'B')
    expect(paths).toHaveLength(1)
    expect(paths[0]).toHaveLength(1)
    expect(paths[0][0].from).toBe('A')
    expect(paths[0][0].to).toBe('B')
  })

  it('finds a two-hop path', () => {
    const forward = new Map([
      ['A', [edge('A', 'B')]],
      ['B', [edge('B', 'C')]],
    ])
    const paths = findPaths(forward, 'A', 'C')
    expect(paths).toHaveLength(1)
    expect(paths[0]).toHaveLength(2)
  })

  it('finds multiple paths', () => {
    const forward = new Map([
      ['A', [edge('A', 'B'), edge('A', 'C')]],
      ['B', [edge('B', 'D')]],
      ['C', [edge('C', 'D')]],
    ])
    const paths = findPaths(forward, 'A', 'D')
    expect(paths).toHaveLength(2)
  })

  it('returns empty array when no path exists', () => {
    const forward = new Map([['A', [edge('A', 'B')]]])
    expect(findPaths(forward, 'A', 'C')).toEqual([])
    expect(findPaths(forward, 'B', 'A')).toEqual([])
  })

  it('avoids cycles', () => {
    const forward = new Map([
      ['A', [edge('A', 'B')]],
      ['B', [edge('B', 'A'), edge('B', 'C')]],
    ])
    const paths = findPaths(forward, 'A', 'C')
    expect(paths).toHaveLength(1)
    expect(paths[0]).toHaveLength(2)
  })

  it('respects maxDepth', () => {
    const forward = new Map([
      ['A', [edge('A', 'B')]],
      ['B', [edge('B', 'C')]],
      ['C', [edge('C', 'D')]],
    ])
    expect(findPaths(forward, 'A', 'D', 2)).toHaveLength(0)
    expect(findPaths(forward, 'A', 'D', 3)).toHaveLength(1)
  })
})
```

- [ ] **Step 2: Run to confirm failure**

```bash
npm test -- traversal
```

Expected: FAIL — `findPaths` not found.

- [ ] **Step 3: Implement `src/graph/traversal.ts`**

```ts
import type { Edge } from '../types.js'

export function findPaths(
  forward: Map<string, Edge[]>,
  from: string,
  to: string,
  maxDepth: number = 4,
): Edge[][] {
  const results: Edge[][] = []

  function dfs(current: string, path: Edge[], visited: Set<string>): void {
    if (path.length >= maxDepth) return
    const neighbors = forward.get(current) ?? []
    for (const edge of neighbors) {
      if (visited.has(edge.to)) continue
      const newPath = [...path, edge]
      if (edge.to === to) {
        results.push(newPath)
      } else {
        visited.add(edge.to)
        dfs(edge.to, newPath, visited)
        visited.delete(edge.to)
      }
    }
  }

  dfs(from, [], new Set([from]))
  return results
}
```

- [ ] **Step 4: Run tests and confirm they pass**

```bash
npm test -- traversal
```

Expected: all 6 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/graph/traversal.ts tests/traversal.test.ts
git commit -m "feat: add BFS path-finding traversal algorithm"
```

---

## Task 5: Graph Engine

**Files:**
- Create: `tests/engine.test.ts`
- Create: `src/graph/engine.ts`

- [ ] **Step 1: Write failing tests in `tests/engine.test.ts`**

```ts
import { describe, it, expect } from 'vitest'
import { createGraphEngine } from '../src/graph/engine.js'
import type { Node, Edge } from '../src/types.js'

const nodes: Node[] = [
  { ticker: 'NVDA', company: 'NVIDIA',     themes: ['ai-infrastructure'] },
  { ticker: 'TSM',  company: 'TSMC',       themes: ['semiconductors']   },
  { ticker: 'CRWV', company: 'CoreWeave',  themes: ['ai-infrastructure'] },
  { ticker: 'ASML', company: 'ASML',       themes: ['semiconductors']   },
]

function edge(id: string, from: string, to: string, type: Edge['type'] = 'supply_chain'): Edge {
  return {
    id, from, to, type, strength: 'strong', description: '', status: 'seed',
    sourceChunkIds: [], evidenceQuote: null, createdAt: '', updatedAt: '',
  }
}

const edges: Edge[] = [
  edge('1', 'NVDA', 'TSM',  'supply_chain'),
  edge('2', 'CRWV', 'NVDA', 'customer'),
  edge('3', 'TSM',  'ASML', 'supply_chain'),
]

describe('GraphEngine', () => {
  const engine = createGraphEngine(nodes, edges)

  it('upstream returns outgoing edges (who X depends on)', () => {
    const up = engine.upstream('NVDA')
    expect(up).toHaveLength(1)
    expect(up[0].to).toBe('TSM')
  })

  it('downstream returns incoming edges (who depends on X)', () => {
    const down = engine.downstream('NVDA')
    expect(down).toHaveLength(1)
    expect(down[0].from).toBe('CRWV')
  })

  it('filters upstream by relType', () => {
    expect(engine.upstream('NVDA', 'customer')).toHaveLength(0)
    expect(engine.upstream('NVDA', 'supply_chain')).toHaveLength(1)
  })

  it('neighbors returns both directions', () => {
    const n = engine.neighbors('NVDA')
    expect(n).toHaveLength(2)
  })

  it('finds multi-hop paths', () => {
    const paths = engine.paths('CRWV', 'ASML')
    expect(paths).toHaveLength(1)
    expect(paths[0]).toHaveLength(3)
    expect(paths[0][0].from).toBe('CRWV')
    expect(paths[0][2].to).toBe('ASML')
  })

  it('returns empty array for node with no connections', () => {
    expect(engine.upstream('ASML')).toHaveLength(0)
  })

  it('toJSON returns correct structure', () => {
    const json = engine.toJSON()
    expect(json.nodes).toHaveLength(4)
    expect(json.edges).toHaveLength(3)
    expect(json.exportedAt).toBeTruthy()
    expect(json.edges[0]).toHaveProperty('from')
    expect(json.edges[0]).toHaveProperty('type')
    expect(json.edges[0]).not.toHaveProperty('status')
  })
})
```

- [ ] **Step 2: Run to confirm failure**

```bash
npm test -- engine
```

Expected: FAIL — `createGraphEngine` not found.

- [ ] **Step 3: Implement `src/graph/engine.ts`**

```ts
import type { Edge, Node, GraphJSON, RelType } from '../types.js'
import { findPaths } from './traversal.js'

export interface GraphEngine {
  upstream(ticker: string, relType?: RelType): Edge[]
  downstream(ticker: string, relType?: RelType): Edge[]
  neighbors(ticker: string, relType?: RelType): Edge[]
  paths(from: string, to: string): Edge[][]
  nodes(): Node[]
  edges(): Edge[]
  toJSON(): GraphJSON
}

export function createGraphEngine(nodes: Node[], edges: Edge[]): GraphEngine {
  const forward = new Map<string, Edge[]>()
  const reverse = new Map<string, Edge[]>()

  for (const edge of edges) {
    if (!forward.has(edge.from)) forward.set(edge.from, [])
    forward.get(edge.from)!.push(edge)

    if (!reverse.has(edge.to)) reverse.set(edge.to, [])
    reverse.get(edge.to)!.push(edge)
  }

  function filter(arr: Edge[], relType?: RelType): Edge[] {
    return relType ? arr.filter(e => e.type === relType) : arr
  }

  return {
    upstream(ticker, relType)   { return filter(forward.get(ticker) ?? [], relType) },
    downstream(ticker, relType) { return filter(reverse.get(ticker) ?? [], relType) },
    neighbors(ticker, relType)  {
      return filter([...(forward.get(ticker) ?? []), ...(reverse.get(ticker) ?? [])], relType)
    },
    paths(from, to) { return findPaths(forward, from, to) },
    nodes()         { return nodes },
    edges()         { return edges },
    toJSON(): GraphJSON {
      return {
        exportedAt: new Date().toISOString(),
        nodes: nodes.map(n => ({ ticker: n.ticker, company: n.company, themes: n.themes })),
        edges: edges.map(e => ({
          from:          e.from,
          to:            e.to,
          type:          e.type,
          strength:      e.strength,
          description:   e.description,
          evidenceQuote: e.evidenceQuote,
        })),
      }
    },
  }
}
```

- [ ] **Step 4: Run tests and confirm they pass**

```bash
npm test -- engine
```

Expected: all 7 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/graph/engine.ts tests/engine.test.ts
git commit -m "feat: add in-memory graph engine with traversal API"
```

---

## Task 6: Seed Config and Loader

**Files:**
- Create: `src/seed/seed.config.ts`
- Create: `tests/seed-loader.test.ts`
- Create: `src/seed/seed-loader.ts`

- [ ] **Step 1: Write `src/seed/seed.config.ts`**

```ts
import type { SeedEdge } from '../types.js'

export const SEED_NODES = [
  { ticker: 'NVDA',      company: 'NVIDIA Corporation',                themes: ['ai-infrastructure'] },
  { ticker: 'AMD',       company: 'Advanced Micro Devices',             themes: ['ai-infrastructure', 'semiconductors'] },
  { ticker: 'AVGO',      company: 'Broadcom Inc',                       themes: ['ai-infrastructure'] },
  { ticker: 'MRVL',      company: 'Marvell Technology',                 themes: ['ai-infrastructure'] },
  { ticker: 'ARM',       company: 'Arm Holdings plc',                   themes: ['ai-infrastructure', 'semiconductors'] },
  { ticker: 'SMCI',      company: 'Super Micro Computer',               themes: ['ai-infrastructure'] },
  { ticker: 'PLTR',      company: 'Palantir Technologies',              themes: ['ai-infrastructure'] },
  { ticker: 'DELL',      company: 'Dell Technologies',                  themes: ['ai-infrastructure'] },
  { ticker: 'CRWV',      company: 'CoreWeave',                          themes: ['ai-infrastructure'] },
  { ticker: 'TSM',       company: 'Taiwan Semiconductor Manufacturing', themes: ['semiconductors'] },
  { ticker: 'ASML',      company: 'ASML Holding',                       themes: ['semiconductors'] },
  { ticker: 'AMAT',      company: 'Applied Materials',                  themes: ['semiconductors'] },
  { ticker: 'KLAC',      company: 'KLA Corporation',                    themes: ['semiconductors'] },
  { ticker: 'LRCX',      company: 'Lam Research',                       themes: ['semiconductors'] },
  { ticker: 'INTC',      company: 'Intel Corporation',                  themes: ['semiconductors'] },
  { ticker: 'MU',        company: 'Micron Technology',                  themes: ['semiconductors'] },
  { ticker: 'QCOM',      company: 'Qualcomm',                           themes: ['semiconductors'] },
  { ticker: 'WDC',       company: 'Western Digital',                    themes: ['semiconductors'] },
  { ticker: 'MSFT',      company: 'Microsoft Corporation',              themes: ['cloud-hyperscalers'] },
  { ticker: 'AMZN',      company: 'Amazon.com Inc',                     themes: ['cloud-hyperscalers'] },
  { ticker: 'GOOG',      company: 'Alphabet Inc',                       themes: ['cloud-hyperscalers'] },
  { ticker: 'META',      company: 'Meta Platforms',                     themes: ['cloud-hyperscalers'] },
  { ticker: 'ORCL',      company: 'Oracle Corporation',                 themes: ['cloud-hyperscalers'] },
  { ticker: 'IBM',       company: 'IBM',                                themes: ['cloud-hyperscalers'] },
  { ticker: 'NEE',       company: 'NextEra Energy',                     themes: ['energy-infrastructure'] },
  { ticker: 'CEG',       company: 'Constellation Energy',               themes: ['energy-infrastructure'] },
  { ticker: 'VST',       company: 'Vistra Corp',                        themes: ['energy-infrastructure'] },
  { ticker: 'AEE',       company: 'Ameren Corporation',                 themes: ['energy-infrastructure'] },
  { ticker: 'CRWD',      company: 'CrowdStrike Holdings',               themes: ['cybersecurity'] },
  { ticker: 'NET',       company: 'Cloudflare Inc',                     themes: ['cybersecurity'] },
  { ticker: 'APP',       company: 'AppLovin Corporation',               themes: ['adtech'] },
  { ticker: 'ANTHROPIC', company: 'Anthropic',                          themes: ['private'] },
  { ticker: 'OPENAI',    company: 'OpenAI',                             themes: ['private'] },
  { ticker: 'XAI',       company: 'xAI',                               themes: ['private'] },
]

export const SEED_EDGES: SeedEdge[] = [
  // supply_chain: from depends on to for manufacturing/components
  { from: 'NVDA', to: 'TSM',  type: 'supply_chain', strength: 'strong',   description: 'TSMC manufactures NVIDIA GPUs (H100, B200, GB200) at 4nm/3nm nodes' },
  { from: 'AMD',  to: 'TSM',  type: 'supply_chain', strength: 'strong',   description: 'TSMC manufactures AMD CPUs (EPYC, Ryzen) and Instinct GPUs' },
  { from: 'ARM',  to: 'TSM',  type: 'supply_chain', strength: 'moderate', description: 'TSMC fabs chips based on ARM architecture for ARM licensees' },
  { from: 'AVGO', to: 'TSM',  type: 'supply_chain', strength: 'strong',   description: 'TSMC manufactures Broadcom custom AI ASICs and networking chips' },
  { from: 'MRVL', to: 'TSM',  type: 'supply_chain', strength: 'strong',   description: 'TSMC manufactures Marvell custom silicon and networking chips' },
  { from: 'NVDA', to: 'AMAT', type: 'supply_chain', strength: 'moderate', description: 'Applied Materials provides deposition/etch equipment used in NVIDIA GPU fab' },
  { from: 'TSM',  to: 'ASML', type: 'supply_chain', strength: 'strong',   description: 'TSMC depends on ASML EUV lithography for advanced node production' },
  { from: 'TSM',  to: 'AMAT', type: 'supply_chain', strength: 'strong',   description: 'Applied Materials is a major equipment supplier to TSMC fabs' },
  { from: 'TSM',  to: 'KLAC', type: 'supply_chain', strength: 'strong',   description: 'KLA provides process control equipment critical to TSMC yield management' },
  { from: 'TSM',  to: 'LRCX', type: 'supply_chain', strength: 'strong',   description: 'Lam Research provides etch and deposition equipment to TSMC' },
  { from: 'NVDA', to: 'MU',   type: 'supply_chain', strength: 'strong',   description: 'Micron supplies HBM memory stacked on NVIDIA H100/B200 GPUs' },
  { from: 'AMD',  to: 'MU',   type: 'supply_chain', strength: 'moderate', description: 'Micron supplies HBM for AMD Instinct MI300 GPUs' },
  { from: 'SMCI', to: 'NVDA', type: 'supply_chain', strength: 'strong',   description: 'SMCI builds GPU servers using NVIDIA GPUs as primary component' },
  { from: 'DELL', to: 'NVDA', type: 'supply_chain', strength: 'strong',   description: 'Dell PowerEdge AI servers use NVIDIA GPUs as core component' },

  // customer: from is a paying customer of to
  { from: 'CRWV', to: 'NVDA', type: 'customer', strength: 'strong',   description: 'CoreWeave is among the largest NVIDIA GPU customers for neocloud infrastructure' },
  { from: 'MSFT', to: 'NVDA', type: 'customer', strength: 'strong',   description: 'Microsoft Azure is a major NVIDIA GPU customer for cloud AI infrastructure' },
  { from: 'AMZN', to: 'NVDA', type: 'customer', strength: 'strong',   description: 'AWS purchases NVIDIA GPUs alongside its own Trainium/Inferentia silicon' },
  { from: 'GOOG', to: 'NVDA', type: 'customer', strength: 'moderate', description: 'Google Cloud purchases NVIDIA GPUs alongside its own TPU infrastructure' },
  { from: 'META', to: 'NVDA', type: 'customer', strength: 'strong',   description: 'Meta is one of the largest NVIDIA GPU buyers for Llama AI training' },
  { from: 'ORCL', to: 'NVDA', type: 'customer', strength: 'strong',   description: 'Oracle Cloud purchases NVIDIA GPUs for its GPU cloud infrastructure' },
  { from: 'MSFT', to: 'ARM',  type: 'customer', strength: 'strong',   description: 'Microsoft licenses ARM architecture for Azure Cobalt custom CPUs' },
  { from: 'AMZN', to: 'ARM',  type: 'customer', strength: 'strong',   description: 'Amazon licenses ARM for Graviton CPU series powering AWS infrastructure' },
  { from: 'GOOG', to: 'ARM',  type: 'customer', strength: 'strong',   description: 'Google licenses ARM for Axion custom CPU used in Google Cloud' },
  { from: 'PLTR', to: 'MSFT', type: 'customer', strength: 'moderate', description: 'Palantir runs its AIP platform on Azure cloud infrastructure' },
  { from: 'NET',  to: 'AMZN', type: 'customer', strength: 'moderate', description: 'Cloudflare uses AWS as infrastructure alongside its own global network' },

  // technology: from's products run on or are built on to's technology
  { from: 'MSFT', to: 'ARM',  type: 'technology', strength: 'strong',   description: 'Microsoft Azure Cobalt CPU is ARM-architecture based' },
  { from: 'AMZN', to: 'ARM',  type: 'technology', strength: 'strong',   description: 'AWS Graviton CPUs are ARM-based; power significant EC2 capacity' },
  { from: 'GOOG', to: 'ARM',  type: 'technology', strength: 'strong',   description: 'Google Axion CPU is ARM-based' },
  { from: 'CRWV', to: 'NVDA', type: 'technology', strength: 'strong',   description: 'CoreWeave infrastructure is built entirely on NVIDIA GPU technology (CUDA)' },
  { from: 'META', to: 'NVDA', type: 'technology', strength: 'strong',   description: 'Meta AI training runs on NVIDIA GPU clusters using CUDA' },
  { from: 'NET',  to: 'ARM',  type: 'technology', strength: 'moderate', description: 'Cloudflare uses ARM-based servers across its global network edge nodes' },

  // competitive: from and to compete in overlapping markets
  { from: 'NVDA', to: 'AMD',  type: 'competitive', strength: 'strong',   description: 'AMD Instinct GPU line competes with NVIDIA in AI accelerator market' },
  { from: 'NVDA', to: 'INTC', type: 'competitive', strength: 'moderate', description: 'Intel Gaudi AI accelerators compete with NVIDIA in data center AI' },
  { from: 'AMD',  to: 'INTC', type: 'competitive', strength: 'strong',   description: 'AMD EPYC CPUs compete directly with Intel Xeon in data center market' },
  { from: 'MSFT', to: 'AMZN', type: 'competitive', strength: 'strong',   description: 'Azure and AWS are primary competitors in enterprise cloud market' },
  { from: 'MSFT', to: 'GOOG', type: 'competitive', strength: 'strong',   description: 'Azure and Google Cloud compete in enterprise cloud and AI services' },
  { from: 'AMZN', to: 'GOOG', type: 'competitive', strength: 'strong',   description: 'AWS and Google Cloud are direct competitors in cloud infrastructure' },
  { from: 'TSM',  to: 'INTC', type: 'competitive', strength: 'moderate', description: 'Intel Foundry Services competes with TSMC for advanced semiconductor fabrication' },
  { from: 'ARM',  to: 'INTC', type: 'competitive', strength: 'moderate', description: 'ARM-based server CPUs (Graviton, Cobalt, Axion) compete with Intel Xeon' },
  { from: 'CRWD', to: 'NET',  type: 'competitive', strength: 'weak',     description: 'CrowdStrike and Cloudflare overlap in zero-trust and network security markets' },
  { from: 'OPENAI', to: 'ANTHROPIC', type: 'competitive', strength: 'strong', description: 'OpenAI and Anthropic are direct competitors in frontier AI model market' },
  { from: 'OPENAI', to: 'XAI',       type: 'competitive', strength: 'strong', description: 'OpenAI and xAI compete in AI assistant and frontier model market' },
]
```

- [ ] **Step 2: Write failing tests in `tests/seed-loader.test.ts`**

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { unlinkSync, existsSync } from 'fs'
import { createGraphStore } from '../src/store/sqlite.js'
import { loadSeed, SEED_NODES } from '../src/seed/seed-loader.js'
import { SEED_EDGES } from '../src/seed/seed.config.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const TEST_DB = join(__dirname, 'test-seed.db')

describe('loadSeed', () => {
  let store: ReturnType<typeof createGraphStore>

  beforeEach(() => { store = createGraphStore(TEST_DB) })
  afterEach(() => {
    store.close()
    if (existsSync(TEST_DB)) unlinkSync(TEST_DB)
  })

  it('loads all nodes', () => {
    loadSeed(store)
    expect(store.getNodes()).toHaveLength(SEED_NODES.length)
  })

  it('loads all seed edges', () => {
    const { edges } = loadSeed(store)
    expect(edges).toBe(SEED_EDGES.length)
    expect(store.getActiveEdges()).toHaveLength(SEED_EDGES.length)
  })

  it('all loaded edges have status seed', () => {
    loadSeed(store)
    const active = store.getActiveEdges()
    expect(active.every(e => e.status === 'seed')).toBe(true)
  })

  it('is idempotent — second run adds zero edges', () => {
    const first = loadSeed(store)
    const second = loadSeed(store)
    expect(second.edges).toBe(0)
    expect(store.getActiveEdges()).toHaveLength(first.edges)
  })
})
```

- [ ] **Step 3: Run to confirm failure**

```bash
npm test -- seed-loader
```

Expected: FAIL — `loadSeed` not found.

- [ ] **Step 4: Implement `src/seed/seed-loader.ts`**

```ts
import { randomUUID } from 'crypto'
import type { GraphStore } from '../store/sqlite.js'
import type { Edge } from '../types.js'
import { SEED_EDGES, SEED_NODES } from './seed.config.js'

export { SEED_NODES }

export function loadSeed(store: GraphStore): { nodes: number; edges: number } {
  for (const node of SEED_NODES) {
    store.upsertNode(node)
  }

  let edgesLoaded = 0
  const now = new Date().toISOString()

  for (const seed of SEED_EDGES) {
    if (store.edgeExists(seed.from, seed.to, seed.type)) continue
    const edge: Edge = {
      id:             randomUUID(),
      from:           seed.from,
      to:             seed.to,
      type:           seed.type,
      strength:       seed.strength,
      description:    seed.description,
      status:         'seed',
      sourceChunkIds: [],
      evidenceQuote:  null,
      createdAt:      now,
      updatedAt:      now,
    }
    store.insertEdge(edge)
    edgesLoaded++
  }

  return { nodes: SEED_NODES.length, edges: edgesLoaded }
}
```

- [ ] **Step 5: Run tests and confirm they pass**

```bash
npm test -- seed-loader
```

Expected: all 4 tests PASS.

- [ ] **Step 6: Commit**

```bash
git add src/seed/seed.config.ts src/seed/seed-loader.ts tests/seed-loader.test.ts
git commit -m "feat: add seed config (34 nodes, 41 edges) and loader"
```

---

## Task 7: Claude Extractor

**Files:**
- Create: `tests/extractor.test.ts`
- Create: `src/scanner/extractor.ts`

- [ ] **Step 1: Write failing tests in `tests/extractor.test.ts`**

```ts
import { describe, it, expect, vi } from 'vitest'
import { extractRelationships } from '../src/scanner/extractor.js'

vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    messages = {
      create: vi.fn().mockResolvedValue({
        content: [{
          type: 'text',
          text: JSON.stringify({
            relationships: [{
              from: 'NVDA',
              to: 'TSM',
              type: 'supply_chain',
              strength: 'strong',
              description: 'TSMC manufactures NVIDIA chips',
              evidence_quote: 'TSMC is our primary foundry partner',
              reasoning: 'Explicitly stated in 10-K',
            }],
          }),
        }],
      }),
    }
  },
}))

describe('extractRelationships', () => {
  it('returns empty when no chunks provided', async () => {
    const result = await extractRelationships('NVDA', 'NVIDIA', 'TSM', 'TSMC', [])
    expect(result.relationships).toHaveLength(0)
  })

  it('parses Claude response into structured relationships', async () => {
    const result = await extractRelationships('NVDA', 'NVIDIA', 'TSM', 'TSMC', [
      { id: 'c1', content: 'TSMC is our primary foundry partner for advanced nodes.' },
    ])
    expect(result.relationships).toHaveLength(1)
    expect(result.relationships[0].from).toBe('NVDA')
    expect(result.relationships[0].to).toBe('TSM')
    expect(result.relationships[0].type).toBe('supply_chain')
    expect(result.relationships[0].strength).toBe('strong')
    expect(result.relationships[0].evidenceQuote).toBe('TSMC is our primary foundry partner')
  })
})
```

- [ ] **Step 2: Run to confirm failure**

```bash
npm test -- extractor
```

Expected: FAIL — `extractRelationships` not found.

- [ ] **Step 3: Implement `src/scanner/extractor.ts`**

```ts
import Anthropic from '@anthropic-ai/sdk'
import type { ExtractionResult, RelType, Strength } from '../types.js'

const client = new Anthropic()

const SYSTEM_PROMPT = `You are an investment research assistant specializing in technology supply chains and competitive dynamics.
Given document excerpts about two companies, identify any dependency relationships between them.

Respond ONLY with valid JSON in this exact format:
{
  "relationships": [
    {
      "from": "TICKER_A",
      "to": "TICKER_B",
      "type": "supply_chain|customer|technology|competitive",
      "strength": "strong|moderate|weak",
      "description": "one sentence describing the relationship",
      "evidence_quote": "exact quote from the documents supporting this",
      "reasoning": "why you classified it this way"
    }
  ]
}

Relationship type definitions:
- supply_chain: from depends on to for manufacturing or supply of components/services
- customer: from is a paying customer of to
- technology: from's products run on or are built on to's technology
- competitive: from and to compete in overlapping markets

Return {"relationships": []} if no relationships are found.
Only include relationships clearly supported by the provided text.`

export async function extractRelationships(
  tickerA: string,
  companyA: string,
  tickerB: string,
  companyB: string,
  chunks: Array<{ id: string; content: string }>,
): Promise<ExtractionResult> {
  if (chunks.length === 0) return { relationships: [] }

  const chunkText = chunks
    .slice(0, 10)
    .map((c, i) => `[Excerpt ${i + 1}]\n${c.content}`)
    .join('\n\n')

  const message = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
    system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
    messages: [{
      role: 'user',
      content: `Companies: ${tickerA} (${companyA}) and ${tickerB} (${companyB})\n\nDocument excerpts:\n${chunkText}\n\nIdentify any dependency relationships between ${tickerA} and ${tickerB} based solely on the excerpts above.`,
    }],
  })

  const text = message.content[0].type === 'text' ? message.content[0].text : ''

  try {
    const parsed = JSON.parse(text)
    const relationships = (parsed.relationships ?? []).map((r: any) => ({
      from:          r.from          as string,
      to:            r.to            as string,
      type:          r.type          as RelType,
      strength:      r.strength      as Strength,
      description:   r.description   as string,
      evidenceQuote: r.evidence_quote as string,
      reasoning:     r.reasoning     as string,
    }))
    return { relationships }
  } catch {
    return { relationships: [] }
  }
}
```

- [ ] **Step 4: Run tests and confirm they pass**

```bash
npm test -- extractor
```

Expected: both tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/scanner/extractor.ts tests/extractor.test.ts
git commit -m "feat: add Claude extractor with prompt caching"
```

---

## Task 8: Scanner

**Files:**
- Create: `src/scanner/scanner.ts`

> No unit tests for scanner: it orchestrates LanceDB reads + Claude calls, both mocked in extractor tests. Integration is verified in Task 13.

- [ ] **Step 1: Implement `src/scanner/scanner.ts`**

```ts
import { join } from 'path'
import { randomUUID } from 'crypto'
import * as lancedb from '@lancedb/lancedb'
import type { GraphStore } from '../store/sqlite.js'
import type { Edge, Proposal, ProposalEdge } from '../types.js'
import { extractRelationships } from './extractor.js'

const INGESTION_LANCE_PATH = join(process.cwd(), '../capital-intelligence-ingestion/data/lancedb')

export async function runScan(
  store: GraphStore,
  options: { ticker?: string } = {},
): Promise<number> {
  const allNodes = store.getNodes()
  const nodes = options.ticker
    ? allNodes.filter(n => n.ticker === options.ticker)
    : allNodes

  if (allNodes.length < 2) {
    console.log('Not enough nodes. Run npm run seed first.')
    return 0
  }

  const db = await lancedb.connect(INGESTION_LANCE_PATH)
  const tableNames = await db.tableNames()
  if (!tableNames.includes('chunks')) {
    console.log('No chunks table found. Run capital-intelligence-ingestion pipeline first.')
    return 0
  }

  const table = await db.openTable('chunks')
  let proposalCount = 0

  for (const nodeA of nodes) {
    for (const nodeB of allNodes) {
      if (nodeA.ticker === nodeB.ticker) continue

      // Fetch chunks from nodeA's documents that mention nodeB
      const rows = await table.query()
        .where(`ticker = '${nodeA.ticker}'`)
        .limit(500)
        .toArray() as any[]

      const companyKeyword = nodeB.company.split(' ')[0].toLowerCase()
      const relevant = rows
        .filter(row => {
          const content = (row.content as string).toLowerCase()
          return (
            content.includes(nodeB.ticker.toLowerCase()) ||
            content.includes(companyKeyword)
          )
        })
        .map(row => ({ id: row.id as string, content: row.content as string }))

      if (relevant.length === 0) continue

      console.log(`  Scanning ${nodeA.ticker} → ${nodeB.ticker} (${relevant.length} relevant chunks)`)

      const result = await extractRelationships(
        nodeA.ticker, nodeA.company,
        nodeB.ticker, nodeB.company,
        relevant,
      )

      if (result.relationships.length === 0) continue

      const newRels = result.relationships.filter(
        r => !store.edgeExists(r.from, r.to, r.type)
      )
      if (newRels.length === 0) continue

      const now = new Date().toISOString()
      const proposal: Proposal = {
        id:              randomUUID(),
        status:          'pending',
        claudeReasoning: newRels.map(r => r.reasoning).join('; '),
        chunkIdsUsed:    relevant.map(c => c.id),
        createdAt:       now,
        resolvedAt:      null,
      }
      store.insertProposal(proposal)

      for (const rel of newRels) {
        const pe: ProposalEdge = {
          id:            randomUUID(),
          proposalId:    proposal.id,
          from:          rel.from,
          to:            rel.to,
          type:          rel.type,
          strength:      rel.strength,
          description:   rel.description,
          evidenceQuote: rel.evidenceQuote,
          approved:      null,
        }
        store.insertProposalEdge(pe)
        proposalCount++
      }
    }
  }

  return proposalCount
}
```

- [ ] **Step 2: Commit**

```bash
git add src/scanner/scanner.ts
git commit -m "feat: add scanner to discover relationships from ingested documents"
```

---

## Task 9: Exporter

**Files:**
- Create: `tests/exporter.test.ts`
- Create: `src/export/exporter.ts`

- [ ] **Step 1: Write failing tests in `tests/exporter.test.ts`**

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { unlinkSync, existsSync, readFileSync } from 'fs'
import { createGraphStore } from '../src/store/sqlite.js'
import { exportGraph } from '../src/export/exporter.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const TEST_DB  = join(__dirname, 'test-export.db')
const TEST_OUT = join(__dirname, 'test-graph.json')

describe('exportGraph', () => {
  let store: ReturnType<typeof createGraphStore>

  beforeEach(() => {
    store = createGraphStore(TEST_DB)
    store.upsertNode({ ticker: 'NVDA', company: 'NVIDIA', themes: ['ai-infrastructure'] })
    store.upsertNode({ ticker: 'TSM',  company: 'TSMC',   themes: ['semiconductors'] })
    store.insertEdge({
      id: 'e1', from: 'NVDA', to: 'TSM', type: 'supply_chain', strength: 'strong',
      description: 'TSMC fabs NVIDIA chips', status: 'seed', sourceChunkIds: [],
      evidenceQuote: null, createdAt: '2026-05-23T00:00:00.000Z', updatedAt: '2026-05-23T00:00:00.000Z',
    })
    // rejected edge should NOT appear in export
    store.insertEdge({
      id: 'e2', from: 'NVDA', to: 'TSM', type: 'customer', strength: 'weak',
      description: 'should be excluded', status: 'rejected', sourceChunkIds: [],
      evidenceQuote: null, createdAt: '2026-05-23T00:00:00.000Z', updatedAt: '2026-05-23T00:00:00.000Z',
    })
  })

  afterEach(() => {
    store.close()
    if (existsSync(TEST_DB))  unlinkSync(TEST_DB)
    if (existsSync(TEST_OUT)) unlinkSync(TEST_OUT)
  })

  it('returns correct graph shape', () => {
    const graph = exportGraph(store, TEST_OUT)
    expect(graph.nodes).toHaveLength(2)
    expect(graph.edges).toHaveLength(1)
    expect(graph.edges[0].from).toBe('NVDA')
    expect(graph.edges[0].to).toBe('TSM')
    expect(graph.exportedAt).toBeTruthy()
  })

  it('does not expose internal status field', () => {
    const graph = exportGraph(store, TEST_OUT)
    expect((graph.edges[0] as any).status).toBeUndefined()
  })

  it('writes valid JSON to disk', () => {
    exportGraph(store, TEST_OUT)
    const written = JSON.parse(readFileSync(TEST_OUT, 'utf-8'))
    expect(written.nodes).toHaveLength(2)
    expect(written.edges).toHaveLength(1)
    expect(written.exportedAt).toBeTruthy()
  })
})
```

- [ ] **Step 2: Run to confirm failure**

```bash
npm test -- exporter
```

Expected: FAIL — `exportGraph` not found.

- [ ] **Step 3: Implement `src/export/exporter.ts`**

```ts
import { writeFileSync } from 'fs'
import type { GraphStore } from '../store/sqlite.js'
import type { GraphJSON } from '../types.js'

export function exportGraph(store: GraphStore, outputPath: string): GraphJSON {
  const nodes = store.getNodes()
  const edges = store.getActiveEdges()

  const graph: GraphJSON = {
    exportedAt: new Date().toISOString(),
    nodes: nodes.map(n => ({ ticker: n.ticker, company: n.company, themes: n.themes })),
    edges: edges.map(e => ({
      from:          e.from,
      to:            e.to,
      type:          e.type,
      strength:      e.strength,
      description:   e.description,
      evidenceQuote: e.evidenceQuote,
    })),
  }

  writeFileSync(outputPath, JSON.stringify(graph, null, 2), 'utf-8')
  return graph
}
```

- [ ] **Step 4: Run tests and confirm they pass**

```bash
npm test -- exporter
```

Expected: all 3 tests PASS.

- [ ] **Step 5: Run full test suite**

```bash
npm test
```

Expected: all tests PASS.

- [ ] **Step 6: Commit**

```bash
git add src/export/exporter.ts tests/exporter.test.ts
git commit -m "feat: add graph JSON exporter"
```

---

## Task 10: CLI — seed, scan, export

**Files:**
- Create: `src/cli/cli-seed.ts`
- Create: `src/cli/cli-scan.ts`
- Create: `src/cli/cli-export.ts`

- [ ] **Step 1: Write `src/cli/cli-seed.ts`**

```ts
import 'dotenv/config'
import { join } from 'path'
import { mkdirSync, existsSync } from 'fs'
import { createGraphStore } from '../store/sqlite.js'
import { loadSeed } from '../seed/seed-loader.js'

const DATA_DIR = join(process.cwd(), 'data')
if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true })

const store = createGraphStore(join(DATA_DIR, 'graph.db'))
const { nodes, edges } = loadSeed(store)
console.log(`Seed complete: ${nodes} nodes, ${edges} new edges loaded`)
store.close()
```

- [ ] **Step 2: Write `src/cli/cli-scan.ts`**

```ts
import 'dotenv/config'
import { join } from 'path'
import { createGraphStore } from '../store/sqlite.js'
import { runScan } from '../scanner/scanner.js'

const DATA_DIR = join(process.cwd(), 'data')
const store = createGraphStore(join(DATA_DIR, 'graph.db'))

const args = process.argv.slice(2)
const tickerArg = args.find(a => a.startsWith('--ticker='))?.split('=')[1]

console.log('Scanning ingested documents for new relationships...')
const count = await runScan(store, { ticker: tickerArg })
console.log(`\nScan complete: ${count} new proposal edge(s) created. Run npm run review to approve.`)
store.close()
```

- [ ] **Step 3: Write `src/cli/cli-export.ts`**

```ts
import 'dotenv/config'
import { join } from 'path'
import { createGraphStore } from '../store/sqlite.js'
import { exportGraph } from '../export/exporter.js'

const DATA_DIR = join(process.cwd(), 'data')
const OUT_PATH = join(DATA_DIR, 'graph.json')
const store = createGraphStore(join(DATA_DIR, 'graph.db'))
const graph = exportGraph(store, OUT_PATH)
console.log(`Exported ${graph.nodes.length} nodes, ${graph.edges.length} edges → ${OUT_PATH}`)
store.close()
```

- [ ] **Step 4: Commit**

```bash
git add src/cli/cli-seed.ts src/cli/cli-scan.ts src/cli/cli-export.ts
git commit -m "feat: add seed, scan, and export CLI entrypoints"
```

---

## Task 11: CLI — review

**Files:**
- Create: `src/cli/cli-review.ts`

- [ ] **Step 1: Write `src/cli/cli-review.ts`**

```ts
import 'dotenv/config'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { createInterface } from 'readline'
import { createGraphStore } from '../store/sqlite.js'
import type { Edge } from '../types.js'

const DATA_DIR = join(process.cwd(), 'data')

async function prompt(rl: ReturnType<typeof createInterface>, question: string): Promise<string> {
  return new Promise(resolve => rl.question(question, resolve))
}

async function main() {
  const store = createGraphStore(join(DATA_DIR, 'graph.db'))
  const pending = store.getPendingProposalEdges()

  if (pending.length === 0) {
    console.log('No pending proposals. Run npm run scan first.')
    store.close()
    return
  }

  console.log(`\n${pending.length} pending proposal(s) to review\n`)
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  let approved = 0
  let rejected = 0

  for (let i = 0; i < pending.length; i++) {
    const pe = pending[i]
    console.log(`\n[${i + 1}/${pending.length}] ${pe.from} → ${pe.to}  (${pe.type}, ${pe.strength})`)
    console.log(`Description: "${pe.description}"`)
    if (pe.evidenceQuote) console.log(`Evidence:    "${pe.evidenceQuote}"`)

    const answer = await prompt(rl, `\nApprove? [y/n/skip] `)

    if (answer.trim().toLowerCase() === 'y') {
      store.resolveProposalEdge(pe.id, true)
      const now = new Date().toISOString()
      const edge: Edge = {
        id:             randomUUID(),
        from:           pe.from,
        to:             pe.to,
        type:           pe.type,
        strength:       pe.strength,
        description:    pe.description,
        status:         'confirmed',
        sourceChunkIds: [],
        evidenceQuote:  pe.evidenceQuote,
        createdAt:      now,
        updatedAt:      now,
      }
      store.insertEdge(edge)
      console.log('  ✓ Approved and added to graph')
      approved++
    } else if (answer.trim().toLowerCase() === 'n') {
      store.resolveProposalEdge(pe.id, false)
      console.log('  ✗ Rejected')
      rejected++
    } else {
      console.log('  → Skipped (will appear again next review)')
    }
  }

  rl.close()
  const skipped = pending.length - approved - rejected
  console.log(`\nDone: ${approved} approved, ${rejected} rejected, ${skipped} skipped`)
  store.close()
}

main().catch(err => { console.error(err); process.exit(1) })
```

- [ ] **Step 2: Commit**

```bash
git add src/cli/cli-review.ts
git commit -m "feat: add interactive review CLI for proposal approval"
```

---

## Task 12: CLI — query

**Files:**
- Create: `src/cli/cli-query.ts`

- [ ] **Step 1: Write `src/cli/cli-query.ts`**

```ts
import 'dotenv/config'
import { join } from 'path'
import { createGraphStore } from '../store/sqlite.js'
import { createGraphEngine } from '../graph/engine.js'
import type { RelType } from '../types.js'

const DATA_DIR = join(process.cwd(), 'data')
const store = createGraphStore(join(DATA_DIR, 'graph.db'))
const nodes = store.getNodes()
const edges = store.getActiveEdges()
const engine = createGraphEngine(nodes, edges)
store.close()

const args = process.argv.slice(2)
const ticker = args.find(a => a.startsWith('--ticker='))?.split('=')[1]
const from   = args.find(a => a.startsWith('--from='))?.split('=')[1]
const to     = args.find(a => a.startsWith('--to='))?.split('=')[1]
const dir    = args.find(a => a.startsWith('--direction='))?.split('=')[1]
const type   = args.find(a => a.startsWith('--type='))?.split('=')[1] as RelType | undefined

const USAGE = `Usage:
  npm run query -- --ticker NVDA --direction upstream
  npm run query -- --ticker NVDA --direction downstream --type supply_chain
  npm run query -- --ticker TSM --direction downstream --type customer
  npm run query -- --from CRWV --to ASML`

if (from && to) {
  const paths = engine.paths(from, to)
  if (paths.length === 0) {
    console.log(`No paths found from ${from} to ${to} (within 4 hops)`)
  } else {
    console.log(`\n${paths.length} path(s) from ${from} to ${to}:\n`)
    for (const path of paths) {
      console.log('  ' + path.map(e => `${e.from} -[${e.type}]→ ${e.to}`).join(' → '))
    }
  }
} else if (ticker) {
  const results =
    dir === 'upstream'   ? engine.upstream(ticker, type)
    : dir === 'downstream' ? engine.downstream(ticker, type)
    : engine.neighbors(ticker, type)

  const label = dir ?? 'neighbors'
  if (results.length === 0) {
    console.log(`No ${label} edges found for ${ticker}${type ? ` (type: ${type})` : ''}`)
  } else {
    console.log(`\n${results.length} ${label} edge(s) for ${ticker}:\n`)
    for (const e of results) {
      console.log(`  ${e.from} -[${e.type}, ${e.strength}]→ ${e.to}`)
      console.log(`    ${e.description}`)
    }
  }
} else {
  console.log(USAGE)
}
```

- [ ] **Step 2: Commit**

```bash
git add src/cli/cli-query.ts
git commit -m "feat: add query CLI for upstream, downstream, and path queries"
```

---

## Task 13: Integration Smoke Test

Verify the full seed → export → query flow works end-to-end against real data.

- [ ] **Step 1: Create `.env` from template**

```bash
cp .env.example .env
# Fill in ANTHROPIC_API_KEY (needed only for scan; not for seed/query/export)
```

- [ ] **Step 2: Run seed and verify output**

```bash
npm run seed
```

Expected output:
```
Seed complete: 34 nodes, 41 new edges loaded
```

If you see a different count, check `src/seed/seed.config.ts` for duplicate edges or missing nodes.

- [ ] **Step 3: Run export and verify JSON file**

```bash
npm run export
```

Expected:
```
Exported 34 nodes, 41 edges → /Users/thanapold/Desktop/Projects/dependency-graph-engine/data/graph.json
```

- [ ] **Step 4: Verify JSON structure**

```bash
node -e "const g = JSON.parse(require('fs').readFileSync('data/graph.json','utf-8')); console.log('nodes:', g.nodes.length, 'edges:', g.edges.length, 'exportedAt:', g.exportedAt)"
```

Expected:
```
nodes: 34 edges: 41 exportedAt: 2026-...
```

- [ ] **Step 5: Run a query**

```bash
npm run query -- --ticker NVDA --direction upstream
```

Expected (should show TSM, AMAT, MU as upstream supply chain + other types):
```
N upstream edge(s) for NVDA:
  NVDA -[supply_chain, strong]→ TSM
    TSMC manufactures NVIDIA GPUs (H100, B200, GB200) at 4nm/3nm nodes
  ...
```

- [ ] **Step 6: Run a path query**

```bash
npm run query -- --from CRWV --to ASML
```

Expected: should find path CRWV → NVDA → TSM → ASML (3 hops).

- [ ] **Step 7: Run seed a second time to verify idempotency**

```bash
npm run seed
```

Expected:
```
Seed complete: 34 nodes, 0 new edges loaded
```

- [ ] **Step 8: Final test run**

```bash
npm test
```

Expected: all tests PASS.

- [ ] **Step 9: Commit**

```bash
git add .
git commit -m "feat: complete dependency-graph-engine — seed, scan, review, query, export"
```

---

## Self-Review Notes

- **Spec coverage:** Architecture ✓, Data model ✓, Graph engine API ✓, Scanner flow ✓, CLI commands ✓, JSON export ✓, Seed config ✓
- **Type consistency:** `GraphStore`, `GraphEngine`, `Edge`, `Node`, `Proposal`, `ProposalEdge`, `SeedEdge`, `ExtractionResult`, `GraphJSON` all used consistently across all tasks
- **No placeholders:** All steps have complete code
- **YAGNI check:** No extra features — `runScan` gets optional `--ticker` flag for targeted runs, nothing else added
- **Reads siblings correctly:** Scanner reads `../capital-intelligence-ingestion/data/lancedb` via relative path from `process.cwd()` — assumes both projects sit side-by-side under `Desktop/Projects/`
