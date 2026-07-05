# Thesis Memory System — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a standalone TypeScript CLI that stores investment theses as structured assumptions + living narratives, uses Claude to propose updates from ingestion data, and requires explicit user approval before committing any change.

**Architecture:** SQLite thesis store (append-only narratives, full history) + reasoning engine (retriever → prompter → Claude API with tool use) + interactive CLI for creating theses, generating proposals, and approving changes. Reads from the `capital-intelligence-ingestion` LanceDB/SQLite stores but never writes to them.

**Tech Stack:** TypeScript, tsx, vitest, better-sqlite3, @anthropic-ai/sdk, @lancedb/lancedb, @huggingface/transformers, dotenv

---

## File Map

```
src/
  types.ts                    All shared interfaces and union types
  store/
    sqlite.ts                 Schema + CRUD for theses, assumptions, narratives, proposals, changes, memberships
  reasoning/
    retriever.ts              Reads ingestion LanceDB — embeds queries, runs hybrid search
    prompter.ts               Builds Claude prompt string from thesis + evidence chunks
    analyzer.ts               Calls Claude API with tool use, returns structured ProposalResponse
  thesis/
    creator.ts                AI-draft or manual thesis creation flow
    updater.ts                Applies approved ProposalChanges to the thesis store
    rollup.ts                 Computes theme conviction score from member company theses
  cli/
    thesis.ts                 create / show / list / history entry point
    update.ts                 generate proposals entry point
    review.ts                 interactive proposal approval entry point
tests/
  store/sqlite.test.ts
  reasoning/retriever.test.ts
  reasoning/prompter.test.ts
  reasoning/analyzer.test.ts
  thesis/updater.test.ts
  thesis/rollup.test.ts
```

---

## Task 1: Project Setup

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `vitest.config.ts`
- Create: `.env.example`
- Create: `.gitignore`

- [ ] **Step 1: Create package.json**

```json
{
  "name": "thesis-memory",
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "thesis": "tsx src/cli/thesis.ts",
    "update": "tsx src/cli/update.ts",
    "review": "tsx src/cli/review.ts",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "dependencies": {
    "@anthropic-ai/sdk": "^0.39.0",
    "@huggingface/transformers": "^3.0.0",
    "@lancedb/lancedb": "^0.29.0",
    "better-sqlite3": "^12.0.0",
    "dotenv": "^16.0.0"
  },
  "devDependencies": {
    "@types/better-sqlite3": "^7.6.11",
    "@types/node": "^22.0.0",
    "tsx": "^4.16.0",
    "typescript": "^5.5.0",
    "vitest": "^2.0.0"
  }
}
```

- [ ] **Step 2: Create tsconfig.json**

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

- [ ] **Step 3: Create vitest.config.ts**

```typescript
import { defineConfig } from 'vitest/config'
export default defineConfig({ test: { globals: true, environment: 'node' } })
```

- [ ] **Step 4: Create .env.example**

```
ANTHROPIC_API_KEY=
INGESTION_STORE_PATH=../capital-intelligence-ingestion/data
```

- [ ] **Step 5: Create .gitignore**

```
.env
node_modules/
dist/
data/
.cache/
```

- [ ] **Step 6: Install dependencies**

```bash
cd /Users/thanapold/Desktop/Projects/thesis-memory && npm install
```

Expected: `node_modules/` created, no errors.

- [ ] **Step 7: Create data directory**

```bash
mkdir -p data
```

- [ ] **Step 8: Commit**

```bash
git add package.json tsconfig.json vitest.config.ts .env.example .gitignore
git commit -m "feat: project setup"
```

---

## Task 2: Shared Types

**Files:**
- Create: `src/types.ts`
- Create: `tests/types.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
// tests/types.test.ts
import { describe, it, expectTypeOf } from 'vitest'
import type {
  AssumptionStatus, ThesisType, PositionSize, ProposalStatus,
  Thesis, Assumption, Narrative, Proposal, ProposalChange, ThemeMembership,
  ProposalResponse
} from '../src/types.js'

describe('types', () => {
  it('AssumptionStatus covers all states', () => {
    const s: AssumptionStatus = 'strengthening'
    expectTypeOf(s).toBeString()
  })
  it('Thesis has required fields', () => {
    expectTypeOf<Thesis>().toHaveProperty('ticker')
    expectTypeOf<Thesis>().toHaveProperty('positionSize')
  })
  it('ProposalResponse has assumption_changes and narrative_update', () => {
    expectTypeOf<ProposalResponse>().toHaveProperty('assumption_changes')
    expectTypeOf<ProposalResponse>().toHaveProperty('narrative_update')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd /Users/thanapold/Desktop/Projects/thesis-memory && npm test -- tests/types.test.ts
```

Expected: FAIL — `Cannot find module '../src/types.js'`

- [ ] **Step 3: Create src/types.ts**

```typescript
// src/types.ts
export type AssumptionStatus = 'strengthening' | 'stable' | 'weakening' | 'broken'
export type ThesisType = 'company' | 'theme'
export type PositionSize = 'core' | 'satellite' | 'watchlist' | 'none'
export type ProposalStatus = 'pending' | 'approved' | 'rejected'
export type ChangeType = 'assumption_status' | 'narrative' | 'portfolio_action'
export type PortfolioAction = 'buy' | 'add' | 'hold' | 'reduce' | 'sell' | 'rotate'

export interface Thesis {
  id: string
  ticker: string
  type: ThesisType
  positionSize: PositionSize
  createdAt: string
  updatedAt: string
}

export interface Assumption {
  id: string
  thesisId: string
  label: string
  status: AssumptionStatus
  lastEvidenceSummary: string | null
  createdAt: string
  updatedAt: string
}

export interface Narrative {
  id: string
  thesisId: string
  content: string
  version: number
  createdAt: string
}

export interface Proposal {
  id: string
  thesisId: string
  status: ProposalStatus
  chunkIdsUsed: string[]
  claudeReasoning: string
  createdAt: string
  resolvedAt: string | null
}

export interface ProposalChange {
  id: string
  proposalId: string
  changeType: ChangeType
  assumptionId: string | null
  oldValue: string
  newValue: string
  reasoning: string
  evidenceQuotes: string[]
  approved: boolean | null
}

export interface ThemeMembership {
  themeId: string
  ticker: string
  weight: number
}

export interface ProposalResponse {
  assumption_changes: Array<{
    label: string
    old_status: AssumptionStatus
    new_status: AssumptionStatus
    reasoning: string
    evidence_quotes: string[]
  }>
  narrative_update: string
  portfolio_action: {
    action: PortfolioAction
    reasoning: string
    conviction: number
  } | null
}

export interface EvidenceChunk {
  id: string
  ticker: string
  source: string
  docType: string
  section: string
  publishedDate: string
  content: string
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npm test -- tests/types.test.ts
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/types.ts tests/types.test.ts
git commit -m "feat: shared types"
```

---

## Task 3: SQLite Store

**Files:**
- Create: `src/store/sqlite.ts`
- Create: `tests/store/sqlite.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// tests/store/sqlite.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createThesisStore, ThesisStore } from '../../src/store/sqlite.js'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { Thesis, Assumption, Narrative, Proposal, ProposalChange } from '../../src/types.js'

let tmpDir: string
let store: ThesisStore

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'thesis-test-'))
  store = createThesisStore(join(tmpDir, 'thesis.db'))
})

afterEach(() => {
  store.close()
  rmSync(tmpDir, { recursive: true })
})

const thesis: Thesis = {
  id: 'thesis-1', ticker: 'NVDA', type: 'company',
  positionSize: 'core', createdAt: '2026-05-22T00:00:00Z', updatedAt: '2026-05-22T00:00:00Z',
}

const assumption: Assumption = {
  id: 'assum-1', thesisId: 'thesis-1', label: 'CUDA moat remains dominant',
  status: 'stable', lastEvidenceSummary: null,
  createdAt: '2026-05-22T00:00:00Z', updatedAt: '2026-05-22T00:00:00Z',
}

const narrative: Narrative = {
  id: 'narr-1', thesisId: 'thesis-1',
  content: 'NVIDIA holds a dominant position in AI compute.',
  version: 1, createdAt: '2026-05-22T00:00:00Z',
}

describe('ThesisStore', () => {
  it('creates and retrieves a thesis', () => {
    store.createThesis(thesis)
    expect(store.getThesis('NVDA')).toMatchObject({ ticker: 'NVDA', type: 'company' })
  })

  it('returns null for unknown ticker', () => {
    expect(store.getThesis('UNKNOWN')).toBeNull()
  })

  it('lists all theses', () => {
    store.createThesis(thesis)
    store.createThesis({ ...thesis, id: 'thesis-2', ticker: 'TSM' })
    expect(store.listTheses()).toHaveLength(2)
  })

  it('creates and retrieves assumptions', () => {
    store.createThesis(thesis)
    store.createAssumption(assumption)
    const assumptions = store.getAssumptions('thesis-1')
    expect(assumptions).toHaveLength(1)
    expect(assumptions[0].label).toBe('CUDA moat remains dominant')
  })

  it('updates assumption status', () => {
    store.createThesis(thesis)
    store.createAssumption(assumption)
    store.updateAssumptionStatus('assum-1', 'strengthening', 'Q1 2026 revenue beat confirms moat')
    const updated = store.getAssumptions('thesis-1')[0]
    expect(updated.status).toBe('strengthening')
    expect(updated.lastEvidenceSummary).toBe('Q1 2026 revenue beat confirms moat')
  })

  it('creates narratives append-only', () => {
    store.createThesis(thesis)
    store.createNarrative(narrative)
    store.createNarrative({ ...narrative, id: 'narr-2', content: 'Updated narrative.', version: 2 })
    expect(store.getNarrativeHistory('thesis-1')).toHaveLength(2)
    expect(store.getCurrentNarrative('thesis-1')?.version).toBe(2)
  })

  it('creates and retrieves pending proposals', () => {
    store.createThesis(thesis)
    const proposal: Proposal = {
      id: 'prop-1', thesisId: 'thesis-1', status: 'pending',
      chunkIdsUsed: ['chunk-1', 'chunk-2'], claudeReasoning: 'Analysis...',
      createdAt: '2026-05-22T00:00:00Z', resolvedAt: null,
    }
    store.createProposal(proposal)
    expect(store.getPendingProposals()).toHaveLength(1)
    store.updateProposalStatus('prop-1', 'approved')
    expect(store.getPendingProposals()).toHaveLength(0)
  })

  it('creates and approves proposal changes', () => {
    store.createThesis(thesis)
    const proposal: Proposal = {
      id: 'prop-1', thesisId: 'thesis-1', status: 'pending',
      chunkIdsUsed: [], claudeReasoning: '',
      createdAt: '2026-05-22T00:00:00Z', resolvedAt: null,
    }
    store.createProposal(proposal)
    const change: ProposalChange = {
      id: 'change-1', proposalId: 'prop-1', changeType: 'assumption_status',
      assumptionId: 'assum-1', oldValue: 'stable', newValue: 'strengthening',
      reasoning: 'Strong revenue beat', evidenceQuotes: ['revenue up 85%'], approved: null,
    }
    store.createProposalChange(change)
    store.approveProposalChange('change-1', true)
    const changes = store.getProposalChanges('prop-1')
    expect(changes[0].approved).toBe(true)
  })

  it('manages theme memberships', () => {
    store.createThesis(thesis)
    store.createThesis({ ...thesis, id: 'theme-1', ticker: 'ai-infrastructure', type: 'theme' })
    store.addThemeMembership({ themeId: 'theme-1', ticker: 'NVDA', weight: 0.35 })
    const members = store.getThemeMembers('theme-1')
    expect(members).toHaveLength(1)
    expect(members[0].weight).toBe(0.35)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npm test -- tests/store/sqlite.test.ts
```

Expected: FAIL — `Cannot find module '../../src/store/sqlite.js'`

- [ ] **Step 3: Create src/store/sqlite.ts**

```typescript
// src/store/sqlite.ts
import Database from 'better-sqlite3'
import type {
  Thesis, Assumption, Narrative, Proposal, ProposalChange,
  ThemeMembership, AssumptionStatus, ProposalStatus
} from '../types.js'

export interface ThesisStore {
  createThesis(thesis: Thesis): void
  getThesis(ticker: string): Thesis | null
  listTheses(): Thesis[]
  updateThesisUpdatedAt(id: string, updatedAt: string): void
  createAssumption(assumption: Assumption): void
  getAssumptions(thesisId: string): Assumption[]
  updateAssumptionStatus(id: string, status: AssumptionStatus, evidenceSummary: string): void
  createNarrative(narrative: Narrative): void
  getCurrentNarrative(thesisId: string): Narrative | null
  getNarrativeHistory(thesisId: string): Narrative[]
  createProposal(proposal: Proposal): void
  getPendingProposals(): Proposal[]
  getProposal(id: string): Proposal | null
  updateProposalStatus(id: string, status: ProposalStatus): void
  createProposalChange(change: ProposalChange): void
  getProposalChanges(proposalId: string): ProposalChange[]
  approveProposalChange(id: string, approved: boolean): void
  addThemeMembership(membership: ThemeMembership): void
  getThemeMembers(themeId: string): ThemeMembership[]
  close(): void
}

export function createThesisStore(dbPath: string): ThesisStore {
  const db = new Database(dbPath)
  db.pragma('journal_mode = WAL')

  db.exec(`
    CREATE TABLE IF NOT EXISTS theses (
      id TEXT PRIMARY KEY, ticker TEXT NOT NULL UNIQUE, type TEXT NOT NULL,
      position_size TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS assumptions (
      id TEXT PRIMARY KEY, thesis_id TEXT NOT NULL, label TEXT NOT NULL,
      status TEXT NOT NULL, last_evidence_summary TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS narratives (
      id TEXT PRIMARY KEY, thesis_id TEXT NOT NULL, content TEXT NOT NULL,
      version INTEGER NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS proposals (
      id TEXT PRIMARY KEY, thesis_id TEXT NOT NULL, status TEXT NOT NULL,
      chunk_ids_used TEXT NOT NULL, claude_reasoning TEXT NOT NULL,
      created_at TEXT NOT NULL, resolved_at TEXT
    );
    CREATE TABLE IF NOT EXISTS proposal_changes (
      id TEXT PRIMARY KEY, proposal_id TEXT NOT NULL, change_type TEXT NOT NULL,
      assumption_id TEXT, old_value TEXT NOT NULL, new_value TEXT NOT NULL,
      reasoning TEXT NOT NULL, evidence_quotes TEXT NOT NULL, approved INTEGER
    );
    CREATE TABLE IF NOT EXISTS theme_memberships (
      theme_id TEXT NOT NULL, ticker TEXT NOT NULL, weight REAL NOT NULL,
      PRIMARY KEY (theme_id, ticker)
    );
  `)

  function rowToThesis(row: Record<string, unknown>): Thesis {
    return {
      id: row.id as string, ticker: row.ticker as string,
      type: row.type as Thesis['type'], positionSize: row.position_size as Thesis['positionSize'],
      createdAt: row.created_at as string, updatedAt: row.updated_at as string,
    }
  }

  function rowToAssumption(row: Record<string, unknown>): Assumption {
    return {
      id: row.id as string, thesisId: row.thesis_id as string,
      label: row.label as string, status: row.status as AssumptionStatus,
      lastEvidenceSummary: row.last_evidence_summary as string | null,
      createdAt: row.created_at as string, updatedAt: row.updated_at as string,
    }
  }

  function rowToNarrative(row: Record<string, unknown>): Narrative {
    return {
      id: row.id as string, thesisId: row.thesis_id as string,
      content: row.content as string, version: row.version as number,
      createdAt: row.created_at as string,
    }
  }

  function rowToProposal(row: Record<string, unknown>): Proposal {
    return {
      id: row.id as string, thesisId: row.thesis_id as string,
      status: row.status as ProposalStatus,
      chunkIdsUsed: JSON.parse(row.chunk_ids_used as string),
      claudeReasoning: row.claude_reasoning as string,
      createdAt: row.created_at as string, resolvedAt: row.resolved_at as string | null,
    }
  }

  function rowToChange(row: Record<string, unknown>): ProposalChange {
    const approved = row.approved
    return {
      id: row.id as string, proposalId: row.proposal_id as string,
      changeType: row.change_type as ProposalChange['changeType'],
      assumptionId: row.assumption_id as string | null,
      oldValue: row.old_value as string, newValue: row.new_value as string,
      reasoning: row.reasoning as string,
      evidenceQuotes: JSON.parse(row.evidence_quotes as string),
      approved: approved === null ? null : Boolean(approved),
    }
  }

  return {
    createThesis(t) {
      db.prepare(`INSERT INTO theses (id, ticker, type, position_size, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)`).run(t.id, t.ticker, t.type, t.positionSize, t.createdAt, t.updatedAt)
    },
    getThesis(ticker) {
      const row = db.prepare('SELECT * FROM theses WHERE ticker = ?').get(ticker) as Record<string, unknown> | undefined
      return row ? rowToThesis(row) : null
    },
    listTheses() {
      return (db.prepare('SELECT * FROM theses ORDER BY created_at').all() as Record<string, unknown>[]).map(rowToThesis)
    },
    updateThesisUpdatedAt(id, updatedAt) {
      db.prepare('UPDATE theses SET updated_at = ? WHERE id = ?').run(updatedAt, id)
    },
    createAssumption(a) {
      db.prepare(`INSERT INTO assumptions (id, thesis_id, label, status, last_evidence_summary, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`).run(a.id, a.thesisId, a.label, a.status, a.lastEvidenceSummary, a.createdAt, a.updatedAt)
    },
    getAssumptions(thesisId) {
      return (db.prepare('SELECT * FROM assumptions WHERE thesis_id = ? ORDER BY created_at').all(thesisId) as Record<string, unknown>[]).map(rowToAssumption)
    },
    updateAssumptionStatus(id, status, evidenceSummary) {
      db.prepare('UPDATE assumptions SET status = ?, last_evidence_summary = ?, updated_at = ? WHERE id = ?')
        .run(status, evidenceSummary, new Date().toISOString(), id)
    },
    createNarrative(n) {
      db.prepare('INSERT INTO narratives (id, thesis_id, content, version, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(n.id, n.thesisId, n.content, n.version, n.createdAt)
    },
    getCurrentNarrative(thesisId) {
      const row = db.prepare('SELECT * FROM narratives WHERE thesis_id = ? ORDER BY version DESC LIMIT 1').get(thesisId) as Record<string, unknown> | undefined
      return row ? rowToNarrative(row) : null
    },
    getNarrativeHistory(thesisId) {
      return (db.prepare('SELECT * FROM narratives WHERE thesis_id = ? ORDER BY version').all(thesisId) as Record<string, unknown>[]).map(rowToNarrative)
    },
    createProposal(p) {
      db.prepare(`INSERT INTO proposals (id, thesis_id, status, chunk_ids_used, claude_reasoning, created_at, resolved_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`).run(p.id, p.thesisId, p.status, JSON.stringify(p.chunkIdsUsed), p.claudeReasoning, p.createdAt, p.resolvedAt)
    },
    getPendingProposals() {
      return (db.prepare("SELECT * FROM proposals WHERE status = 'pending' ORDER BY created_at").all() as Record<string, unknown>[]).map(rowToProposal)
    },
    getProposal(id) {
      const row = db.prepare('SELECT * FROM proposals WHERE id = ?').get(id) as Record<string, unknown> | undefined
      return row ? rowToProposal(row) : null
    },
    updateProposalStatus(id, status) {
      db.prepare('UPDATE proposals SET status = ?, resolved_at = ? WHERE id = ?')
        .run(status, new Date().toISOString(), id)
    },
    createProposalChange(c) {
      db.prepare(`INSERT INTO proposal_changes (id, proposal_id, change_type, assumption_id, old_value, new_value, reasoning, evidence_quotes, approved)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(c.id, c.proposalId, c.changeType, c.assumptionId, c.oldValue, c.newValue, c.reasoning, JSON.stringify(c.evidenceQuotes), c.approved === null ? null : (c.approved ? 1 : 0))
    },
    getProposalChanges(proposalId) {
      return (db.prepare('SELECT * FROM proposal_changes WHERE proposal_id = ? ORDER BY id').all(proposalId) as Record<string, unknown>[]).map(rowToChange)
    },
    approveProposalChange(id, approved) {
      db.prepare('UPDATE proposal_changes SET approved = ? WHERE id = ?').run(approved ? 1 : 0, id)
    },
    addThemeMembership(m) {
      db.prepare('INSERT OR REPLACE INTO theme_memberships (theme_id, ticker, weight) VALUES (?, ?, ?)').run(m.themeId, m.ticker, m.weight)
    },
    getThemeMembers(themeId) {
      return (db.prepare('SELECT * FROM theme_memberships WHERE theme_id = ?').all(themeId) as Record<string, unknown>[])
        .map(row => ({ themeId: row.theme_id as string, ticker: row.ticker as string, weight: row.weight as number }))
    },
    close() { db.close() },
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npm test -- tests/store/sqlite.test.ts
```

Expected: 9 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/store/sqlite.ts tests/store/sqlite.test.ts
git commit -m "feat: thesis SQLite store — all 6 tables with full CRUD"
```

---

## Task 4: Retriever

**Files:**
- Create: `src/reasoning/retriever.ts`
- Create: `tests/reasoning/retriever.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// tests/reasoning/retriever.test.ts
import { describe, it, expect, vi } from 'vitest'
import { createRetriever } from '../../src/reasoning/retriever.js'

vi.mock('@lancedb/lancedb', () => ({
  connect: vi.fn().mockResolvedValue({
    tableNames: vi.fn().mockResolvedValue(['chunks']),
    openTable: vi.fn().mockResolvedValue({
      vectorSearch: vi.fn().mockReturnValue({
        limit: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        toArray: vi.fn().mockResolvedValue([
          {
            id: 'chunk-1', ticker: 'NVDA', source: 'sec_filing', docType: '10-Q',
            section: 'mda', publishedDate: '2026-05-20',
            content: 'Revenue grew 69% year over year to $44.1 billion.',
            vector: Array(384).fill(0.1),
          },
        ]),
      }),
    }),
  }),
}))

vi.mock('@huggingface/transformers', () => ({
  pipeline: vi.fn().mockResolvedValue(
    vi.fn().mockResolvedValue({ tolist: () => [Array(384).fill(0.1)] })
  ),
  env: { cacheDir: '' },
}))

describe('createRetriever', () => {
  it('returns relevant chunks for a query', async () => {
    const retriever = await createRetriever('/fake/ingestion/path')
    const chunks = await retriever.search('CUDA competitive advantage', 'NVDA', 5)
    expect(chunks).toHaveLength(1)
    expect(chunks[0].ticker).toBe('NVDA')
    expect(chunks[0].content).toContain('Revenue grew')
  })

  it('returns empty array when ingestion store has no chunks table', async () => {
    const { connect } = await import('@lancedb/lancedb') as { connect: ReturnType<typeof vi.fn> }
    connect.mockResolvedValueOnce({
      tableNames: vi.fn().mockResolvedValue([]),
    })
    const retriever = await createRetriever('/fake/ingestion/path')
    const chunks = await retriever.search('query', 'NVDA', 5)
    expect(chunks).toHaveLength(0)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npm test -- tests/reasoning/retriever.test.ts
```

Expected: FAIL

- [ ] **Step 3: Create src/reasoning/retriever.ts**

```typescript
// src/reasoning/retriever.ts
import * as lancedb from '@lancedb/lancedb'
import { pipeline, env } from '@huggingface/transformers'
import { join } from 'path'
import type { EvidenceChunk } from '../types.js'

env.cacheDir = './.cache/transformers'

const MODEL = 'Xenova/all-MiniLM-L6-v2'
let _pipeline: Awaited<ReturnType<typeof pipeline>> | null = null

async function embed(text: string): Promise<number[]> {
  if (!_pipeline) _pipeline = await pipeline('feature-extraction', MODEL)
  const out = await _pipeline([text], { pooling: 'mean', normalize: true })
  return (out as { tolist(): number[][] }).tolist()[0]
}

export interface Retriever {
  search(query: string, ticker: string, topK: number, dateFrom?: string): Promise<EvidenceChunk[]>
}

export async function createRetriever(ingestionDataPath: string): Promise<Retriever> {
  const db = await lancedb.connect(join(ingestionDataPath, 'lancedb'))
  const tables = await db.tableNames()

  if (!tables.includes('chunks')) {
    return { async search() { return [] } }
  }

  const table = await db.openTable('chunks')

  return {
    async search(query, ticker, topK, dateFrom) {
      const vector = await embed(query)
      const conditions = [`ticker = '${ticker.replace(/'/g, "''")}'`]
      if (dateFrom) conditions.push(`publishedDate >= '${dateFrom}'`)

      const q = table
        .vectorSearch(vector)
        .limit(topK)
        .where(conditions.join(' AND '))

      const rows = await q.toArray()
      return rows.map(row => ({
        id: row.id as string,
        ticker: row.ticker as string,
        source: row.source as string,
        docType: row.docType as string,
        section: row.section as string,
        publishedDate: row.publishedDate as string,
        content: row.content as string,
      }))
    },
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npm test -- tests/reasoning/retriever.test.ts
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/reasoning/retriever.ts tests/reasoning/retriever.test.ts
git commit -m "feat: retriever — hybrid search against ingestion LanceDB"
```

---

## Task 5: Prompter

**Files:**
- Create: `src/reasoning/prompter.ts`
- Create: `tests/reasoning/prompter.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// tests/reasoning/prompter.test.ts
import { describe, it, expect } from 'vitest'
import { buildPrompt } from '../../src/reasoning/prompter.js'
import type { Thesis, Assumption, Narrative, EvidenceChunk } from '../../src/types.js'

const thesis: Thesis = {
  id: 't1', ticker: 'NVDA', type: 'company', positionSize: 'core',
  createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-04-01T00:00:00Z',
}

const assumptions: Assumption[] = [
  { id: 'a1', thesisId: 't1', label: 'CUDA moat remains dominant', status: 'stable',
    lastEvidenceSummary: null, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' },
  { id: 'a2', thesisId: 't1', label: 'Hyperscaler capex growing', status: 'weakening',
    lastEvidenceSummary: null, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' },
]

const narrative: Narrative = {
  id: 'n1', thesisId: 't1', content: 'NVIDIA dominates AI compute infrastructure.',
  version: 1, createdAt: '2026-01-01T00:00:00Z',
}

const chunks: EvidenceChunk[] = [
  { id: 'c1', ticker: 'NVDA', source: 'sec_filing', docType: '10-Q',
    section: 'mda', publishedDate: '2026-05-20',
    content: 'Data center revenue grew 427% year over year.' },
]

describe('buildPrompt', () => {
  it('includes the current narrative', () => {
    const prompt = buildPrompt(thesis, assumptions, narrative, chunks, '2026-04-01')
    expect(prompt).toContain('NVIDIA dominates AI compute infrastructure.')
  })

  it('includes all assumption labels and statuses', () => {
    const prompt = buildPrompt(thesis, assumptions, narrative, chunks, '2026-04-01')
    expect(prompt).toContain('CUDA moat remains dominant')
    expect(prompt).toContain('[stable]')
    expect(prompt).toContain('Hyperscaler capex growing')
    expect(prompt).toContain('[weakening]')
  })

  it('includes evidence chunk content', () => {
    const prompt = buildPrompt(thesis, assumptions, narrative, chunks, '2026-04-01')
    expect(prompt).toContain('Data center revenue grew 427%')
  })

  it('includes the ticker and date range', () => {
    const prompt = buildPrompt(thesis, assumptions, narrative, chunks, '2026-04-01')
    expect(prompt).toContain('NVDA')
    expect(prompt).toContain('2026-04-01')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npm test -- tests/reasoning/prompter.test.ts
```

Expected: FAIL

- [ ] **Step 3: Create src/reasoning/prompter.ts**

```typescript
// src/reasoning/prompter.ts
import type { Thesis, Assumption, Narrative, EvidenceChunk } from '../types.js'

export function buildPrompt(
  thesis: Thesis,
  assumptions: Assumption[],
  narrative: Narrative,
  chunks: EvidenceChunk[],
  lastUpdated: string
): string {
  const today = new Date().toISOString().slice(0, 10)

  const assumptionLines = assumptions
    .map(a => `  [${a.status}]  ${a.label}`)
    .join('\n')

  const chunkLines = chunks
    .map(c => `[${c.source} ${c.publishedDate}, ${c.section}]\n"${c.content.slice(0, 500)}"`)
    .join('\n\n')

  return `You are analyzing whether new evidence changes an investment thesis.

CURRENT THESIS: ${thesis.ticker} (as of ${lastUpdated})
Position size: ${thesis.positionSize}

Narrative:
${narrative.content}

Assumptions:
${assumptionLines}

NEW EVIDENCE (${lastUpdated} → ${today}):
${chunkLines}

Analyze each assumption. For each one, determine whether the new evidence:
- STRENGTHENS it (more confidence it will hold)
- WEAKENS it (less confidence, but thesis still intact)
- BREAKS it (assumption is no longer valid)
- Leaves it UNCHANGED (no relevant evidence)

Only include assumptions where the status should CHANGE. Do not include unchanged assumptions.

Then propose an updated narrative reflecting the new evidence. Keep the narrative concise (2-4 sentences).

If conviction has shifted significantly (multiple assumptions changed, or a core assumption broke), suggest a portfolio action.

Use the propose_thesis_update tool to respond.`
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npm test -- tests/reasoning/prompter.test.ts
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/reasoning/prompter.ts tests/reasoning/prompter.test.ts
git commit -m "feat: prompter — builds structured Claude prompt from thesis and evidence"
```

---

## Task 6: Analyzer (Claude API)

**Files:**
- Create: `src/reasoning/analyzer.ts`
- Create: `tests/reasoning/analyzer.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// tests/reasoning/analyzer.test.ts
import { describe, it, expect, vi } from 'vitest'
import { createAnalyzer } from '../../src/reasoning/analyzer.js'

vi.mock('@anthropic-ai/sdk', () => ({
  default: vi.fn().mockImplementation(() => ({
    messages: {
      create: vi.fn().mockResolvedValue({
        content: [
          {
            type: 'tool_use',
            name: 'propose_thesis_update',
            input: {
              assumption_changes: [
                {
                  label: 'Hyperscaler capex growing',
                  old_status: 'weakening',
                  new_status: 'strengthening',
                  reasoning: 'Q1 2026 shows capex accelerating across all hyperscalers.',
                  evidence_quotes: ['revenue of $39.3 billion, up 69%'],
                },
              ],
              narrative_update: 'The NVIDIA thesis has strengthened materially.',
              portfolio_action: { action: 'hold', reasoning: 'Valuation stretch', conviction: 8 },
            },
          },
        ],
      }),
    },
  })),
}))

describe('createAnalyzer', () => {
  it('returns a structured ProposalResponse from Claude', async () => {
    const analyzer = createAnalyzer('test-key')
    const result = await analyzer.analyze('test prompt', 'NVDA')
    expect(result.assumption_changes).toHaveLength(1)
    expect(result.assumption_changes[0].label).toBe('Hyperscaler capex growing')
    expect(result.assumption_changes[0].new_status).toBe('strengthening')
    expect(result.narrative_update).toBe('The NVIDIA thesis has strengthened materially.')
    expect(result.portfolio_action?.action).toBe('hold')
    expect(result.portfolio_action?.conviction).toBe(8)
  })

  it('handles response with no portfolio action', async () => {
    const Anthropic = (await import('@anthropic-ai/sdk')).default as ReturnType<typeof vi.fn>
    Anthropic.mockImplementationOnce(() => ({
      messages: {
        create: vi.fn().mockResolvedValue({
          content: [
            {
              type: 'tool_use',
              name: 'propose_thesis_update',
              input: {
                assumption_changes: [],
                narrative_update: 'No significant changes.',
                portfolio_action: null,
              },
            },
          ],
        }),
      },
    }))
    const analyzer = createAnalyzer('test-key')
    const result = await analyzer.analyze('prompt', 'NVDA')
    expect(result.portfolio_action).toBeNull()
    expect(result.assumption_changes).toHaveLength(0)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npm test -- tests/reasoning/analyzer.test.ts
```

Expected: FAIL

- [ ] **Step 3: Create src/reasoning/analyzer.ts**

```typescript
// src/reasoning/analyzer.ts
import Anthropic from '@anthropic-ai/sdk'
import type { ProposalResponse } from '../types.js'

const TOOL: Anthropic.Tool = {
  name: 'propose_thesis_update',
  description: 'Propose structured changes to an investment thesis based on evidence analysis.',
  input_schema: {
    type: 'object' as const,
    properties: {
      assumption_changes: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            label: { type: 'string' },
            old_status: { type: 'string', enum: ['strengthening', 'stable', 'weakening', 'broken'] },
            new_status: { type: 'string', enum: ['strengthening', 'stable', 'weakening', 'broken'] },
            reasoning: { type: 'string' },
            evidence_quotes: { type: 'array', items: { type: 'string' } },
          },
          required: ['label', 'old_status', 'new_status', 'reasoning', 'evidence_quotes'],
        },
      },
      narrative_update: { type: 'string' },
      portfolio_action: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['buy', 'add', 'hold', 'reduce', 'sell', 'rotate'] },
          reasoning: { type: 'string' },
          conviction: { type: 'number' },
        },
        required: ['action', 'reasoning', 'conviction'],
      },
    },
    required: ['assumption_changes', 'narrative_update'],
  },
}

export interface Analyzer {
  analyze(prompt: string, ticker: string): Promise<ProposalResponse>
}

export function createAnalyzer(apiKey: string): Analyzer {
  const client = new Anthropic({ apiKey })

  return {
    async analyze(prompt, ticker) {
      const response = await client.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 4096,
        tools: [TOOL],
        tool_choice: { type: 'tool', name: 'propose_thesis_update' },
        messages: [{ role: 'user', content: prompt }],
      })

      const toolUse = response.content.find(b => b.type === 'tool_use' && b.name === 'propose_thesis_update')
      if (!toolUse || toolUse.type !== 'tool_use') {
        throw new Error(`[Analyzer] No tool use response for ${ticker}`)
      }

      return toolUse.input as ProposalResponse
    },
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npm test -- tests/reasoning/analyzer.test.ts
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/reasoning/analyzer.ts tests/reasoning/analyzer.test.ts
git commit -m "feat: analyzer — Claude API tool use for structured proposal generation"
```

---

## Task 7: Thesis Updater

**Files:**
- Create: `src/thesis/updater.ts`
- Create: `tests/thesis/updater.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// tests/thesis/updater.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { applyApprovedChanges } from '../../src/thesis/updater.js'
import { createThesisStore, ThesisStore } from '../../src/store/sqlite.js'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { Thesis, Assumption, Narrative, Proposal, ProposalChange } from '../../src/types.js'

let tmpDir: string
let store: ThesisStore

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'updater-test-'))
  store = createThesisStore(join(tmpDir, 'thesis.db'))

  const thesis: Thesis = {
    id: 't1', ticker: 'NVDA', type: 'company', positionSize: 'core',
    createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
  }
  store.createThesis(thesis)

  const assumption: Assumption = {
    id: 'a1', thesisId: 't1', label: 'CUDA moat remains dominant', status: 'stable',
    lastEvidenceSummary: null, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
  }
  store.createAssumption(assumption)

  const narrative: Narrative = {
    id: 'n1', thesisId: 't1', content: 'Original narrative.', version: 1,
    createdAt: '2026-01-01T00:00:00Z',
  }
  store.createNarrative(narrative)
})

afterEach(() => {
  store.close()
  rmSync(tmpDir, { recursive: true })
})

describe('applyApprovedChanges', () => {
  it('updates assumption status when change is approved', () => {
    const proposal: Proposal = {
      id: 'p1', thesisId: 't1', status: 'pending', chunkIdsUsed: [],
      claudeReasoning: '', createdAt: '2026-05-22T00:00:00Z', resolvedAt: null,
    }
    store.createProposal(proposal)

    const change: ProposalChange = {
      id: 'c1', proposalId: 'p1', changeType: 'assumption_status', assumptionId: 'a1',
      oldValue: 'stable', newValue: 'strengthening',
      reasoning: 'Strong revenue growth', evidenceQuotes: ['revenue up 85%'], approved: true,
    }
    store.createProposalChange(change)

    applyApprovedChanges('p1', store)

    const updated = store.getAssumptions('t1')[0]
    expect(updated.status).toBe('strengthening')
    expect(updated.lastEvidenceSummary).toBe('Strong revenue growth')
  })

  it('creates a new narrative version when narrative change is approved', () => {
    const proposal: Proposal = {
      id: 'p1', thesisId: 't1', status: 'pending', chunkIdsUsed: [],
      claudeReasoning: '', createdAt: '2026-05-22T00:00:00Z', resolvedAt: null,
    }
    store.createProposal(proposal)

    const change: ProposalChange = {
      id: 'c2', proposalId: 'p1', changeType: 'narrative', assumptionId: null,
      oldValue: 'Original narrative.', newValue: 'Updated narrative reflecting new evidence.',
      reasoning: 'Evidence supports stronger thesis', evidenceQuotes: [], approved: true,
    }
    store.createProposalChange(change)

    applyApprovedChanges('p1', store)

    const history = store.getNarrativeHistory('t1')
    expect(history).toHaveLength(2)
    expect(history[1].content).toBe('Updated narrative reflecting new evidence.')
    expect(history[1].version).toBe(2)
  })

  it('does not apply rejected changes', () => {
    const proposal: Proposal = {
      id: 'p1', thesisId: 't1', status: 'pending', chunkIdsUsed: [],
      claudeReasoning: '', createdAt: '2026-05-22T00:00:00Z', resolvedAt: null,
    }
    store.createProposal(proposal)

    const change: ProposalChange = {
      id: 'c1', proposalId: 'p1', changeType: 'assumption_status', assumptionId: 'a1',
      oldValue: 'stable', newValue: 'weakening',
      reasoning: 'Some concern', evidenceQuotes: [], approved: false,
    }
    store.createProposalChange(change)

    applyApprovedChanges('p1', store)

    const assumption = store.getAssumptions('t1')[0]
    expect(assumption.status).toBe('stable')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npm test -- tests/thesis/updater.test.ts
```

Expected: FAIL

- [ ] **Step 3: Create src/thesis/updater.ts**

```typescript
// src/thesis/updater.ts
import { randomUUID } from 'crypto'
import type { ThesisStore } from '../store/sqlite.js'
import type { AssumptionStatus } from '../types.js'

export function applyApprovedChanges(proposalId: string, store: ThesisStore): void {
  const changes = store.getProposalChanges(proposalId)
  const proposal = store.getProposal(proposalId)
  if (!proposal) throw new Error(`Proposal ${proposalId} not found`)

  for (const change of changes) {
    if (!change.approved) continue

    if (change.changeType === 'assumption_status' && change.assumptionId) {
      store.updateAssumptionStatus(
        change.assumptionId,
        change.newValue as AssumptionStatus,
        change.reasoning
      )
    }

    if (change.changeType === 'narrative') {
      const current = store.getCurrentNarrative(proposal.thesisId)
      const nextVersion = (current?.version ?? 0) + 1
      store.createNarrative({
        id: randomUUID(),
        thesisId: proposal.thesisId,
        content: change.newValue,
        version: nextVersion,
        createdAt: new Date().toISOString(),
      })
    }
  }

  store.updateThesisUpdatedAt(proposal.thesisId, new Date().toISOString())
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npm test -- tests/thesis/updater.test.ts
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/thesis/updater.ts tests/thesis/updater.test.ts
git commit -m "feat: thesis updater — applies approved proposal changes"
```

---

## Task 8: Theme Rollup

**Files:**
- Create: `src/thesis/rollup.ts`
- Create: `tests/thesis/rollup.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// tests/thesis/rollup.test.ts
import { describe, it, expect } from 'vitest'
import { computeThemeConviction, convictionLabel } from '../../src/thesis/rollup.js'
import type { Assumption, ThemeMembership } from '../../src/types.js'

const makeAssumptions = (statuses: string[]): Assumption[] =>
  statuses.map((status, i) => ({
    id: `a${i}`, thesisId: 't1', label: `Assumption ${i}`,
    status: status as Assumption['status'], lastEvidenceSummary: null,
    createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
  }))

describe('computeThemeConviction', () => {
  it('returns high score when all assumptions are strengthening', () => {
    const members: ThemeMembership[] = [{ themeId: 'theme-1', ticker: 'NVDA', weight: 1.0 }]
    const assumptionsByTicker: Record<string, Assumption[]> = {
      NVDA: makeAssumptions(['strengthening', 'strengthening', 'strengthening']),
    }
    const score = computeThemeConviction(members, assumptionsByTicker)
    expect(score).toBeCloseTo(1.0, 1)
  })

  it('returns low score when assumptions are weakening', () => {
    const members: ThemeMembership[] = [{ themeId: 'theme-1', ticker: 'NVDA', weight: 1.0 }]
    const assumptionsByTicker: Record<string, Assumption[]> = {
      NVDA: makeAssumptions(['weakening', 'weakening', 'broken']),
    }
    const score = computeThemeConviction(members, assumptionsByTicker)
    expect(score).toBeLessThan(0.3)
  })

  it('weights company scores by membership weight', () => {
    const members: ThemeMembership[] = [
      { themeId: 'theme-1', ticker: 'NVDA', weight: 0.8 },
      { themeId: 'theme-1', ticker: 'AMD', weight: 0.2 },
    ]
    const assumptionsByTicker: Record<string, Assumption[]> = {
      NVDA: makeAssumptions(['strengthening', 'strengthening']),
      AMD: makeAssumptions(['broken', 'broken']),
    }
    // NVDA (0.8 weight, score 1.0) + AMD (0.2 weight, score -0.5) → weighted heavily toward NVDA
    const score = computeThemeConviction(members, assumptionsByTicker)
    expect(score).toBeGreaterThan(0.5)
  })
})

describe('convictionLabel', () => {
  it('maps scores to labels correctly', () => {
    expect(convictionLabel(0.9)).toBe('strengthening')
    expect(convictionLabel(0.6)).toBe('stable')
    expect(convictionLabel(0.3)).toBe('weakening')
    expect(convictionLabel(0.1)).toBe('broken')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npm test -- tests/thesis/rollup.test.ts
```

Expected: FAIL

- [ ] **Step 3: Create src/thesis/rollup.ts**

```typescript
// src/thesis/rollup.ts
import type { Assumption, ThemeMembership } from '../types.js'

const STATUS_WEIGHTS: Record<string, number> = {
  strengthening: 1.0,
  stable: 0.5,
  weakening: 0.0,
  broken: -0.5,
}

function companyScore(assumptions: Assumption[]): number {
  if (assumptions.length === 0) return 0.5
  const total = assumptions.reduce((sum, a) => sum + (STATUS_WEIGHTS[a.status] ?? 0.5), 0)
  return total / assumptions.length
}

export function computeThemeConviction(
  members: ThemeMembership[],
  assumptionsByTicker: Record<string, Assumption[]>
): number {
  if (members.length === 0) return 0.5

  const totalWeight = members.reduce((sum, m) => sum + m.weight, 0)
  let weighted = 0

  for (const member of members) {
    const assumptions = assumptionsByTicker[member.ticker] ?? []
    const score = companyScore(assumptions)
    weighted += score * (member.weight / totalWeight)
  }

  return weighted
}

export function convictionLabel(score: number): string {
  if (score >= 0.8) return 'strengthening'
  if (score >= 0.5) return 'stable'
  if (score >= 0.2) return 'weakening'
  return 'broken'
}

export function convictionBar(score: number, width = 10): string {
  const filled = Math.round(score * width)
  return '█'.repeat(filled) + '░'.repeat(width - filled)
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npm test -- tests/thesis/rollup.test.ts
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/thesis/rollup.ts tests/thesis/rollup.test.ts
git commit -m "feat: theme rollup — weighted conviction score from member theses"
```

---

## Task 9: Thesis Creator

**Files:**
- Create: `src/thesis/creator.ts`

No unit tests — creator orchestrates retriever + analyzer + store; integration tested via CLI smoke test in Task 11.

- [ ] **Step 1: Create src/thesis/creator.ts**

```typescript
// src/thesis/creator.ts
import { randomUUID } from 'crypto'
import type { ThesisStore } from '../store/sqlite.js'
import type { Retriever } from '../reasoning/retriever.js'
import type { Analyzer } from '../reasoning/analyzer.js'
import type { PositionSize, ThesisType } from '../types.js'

export async function draftThesisFromIngestion(
  ticker: string,
  thesisType: ThesisType,
  positionSize: PositionSize,
  store: ThesisStore,
  retriever: Retriever,
  analyzer: Analyzer
): Promise<void> {
  const thesisId = randomUUID()
  const now = new Date().toISOString()

  // Bootstrap: search for broad context about this company
  const chunks = await retriever.search(
    `${ticker} business model revenue drivers competitive advantage risks`,
    ticker,
    20
  )

  if (chunks.length === 0) {
    throw new Error(`No ingestion data found for ${ticker}. Run the ingestion pipeline first.`)
  }

  const chunkSummaries = chunks
    .map(c => `[${c.source} ${c.publishedDate}, ${c.section}]\n"${c.content.slice(0, 400)}"`)
    .join('\n\n')

  const prompt = `You are creating an initial investment thesis for ${ticker}.

Based on the following evidence from SEC filings, earnings transcripts, and news, create:
1. A list of 4-6 key investment assumptions (the things that must be true for this to be a good investment)
2. A concise thesis narrative (3-5 sentences)
3. An initial portfolio action recommendation

EVIDENCE:
${chunkSummaries}

Use the propose_thesis_update tool. For assumption_changes, treat all assumptions as NEW (old_status = 'stable', new_status = their initial status based on evidence). The narrative_update should be the initial thesis narrative.`

  const response = await analyzer.analyze(prompt, ticker)

  // Create thesis
  store.createThesis({
    id: thesisId,
    ticker,
    type: thesisType,
    positionSize,
    createdAt: now,
    updatedAt: now,
  })

  // Create initial assumptions from Claude's analysis
  for (const change of response.assumption_changes) {
    store.createAssumption({
      id: randomUUID(),
      thesisId,
      label: change.label,
      status: change.new_status,
      lastEvidenceSummary: change.reasoning,
      createdAt: now,
      updatedAt: now,
    })
  }

  // Create initial narrative
  store.createNarrative({
    id: randomUUID(),
    thesisId,
    content: response.narrative_update,
    version: 1,
    createdAt: now,
  })

  console.log(`\nThesis created for ${ticker} with ${response.assumption_changes.length} assumptions.`)
}

export function createManualThesis(
  ticker: string,
  thesisType: ThesisType,
  positionSize: PositionSize,
  assumptions: string[],
  narrative: string,
  store: ThesisStore
): void {
  const thesisId = randomUUID()
  const now = new Date().toISOString()

  store.createThesis({ id: thesisId, ticker, type: thesisType, positionSize, createdAt: now, updatedAt: now })

  for (const label of assumptions) {
    store.createAssumption({
      id: randomUUID(), thesisId, label, status: 'stable',
      lastEvidenceSummary: null, createdAt: now, updatedAt: now,
    })
  }

  store.createNarrative({ id: randomUUID(), thesisId, content: narrative, version: 1, createdAt: now })
  console.log(`\nManual thesis created for ${ticker} with ${assumptions.length} assumptions.`)
}
```

- [ ] **Step 2: Commit**

```bash
git add src/thesis/creator.ts
git commit -m "feat: thesis creator — AI-draft or manual creation"
```

---

## Task 10: CLI — thesis commands

**Files:**
- Create: `src/cli/thesis.ts`

- [ ] **Step 1: Create src/cli/thesis.ts**

```typescript
// src/cli/thesis.ts
import 'dotenv/config'
import { join } from 'path'
import { createThesisStore } from '../store/sqlite.js'
import { createRetriever } from '../reasoning/retriever.js'
import { createAnalyzer } from '../reasoning/analyzer.js'
import { draftThesisFromIngestion, createManualThesis } from '../thesis/creator.js'
import { computeThemeConviction, convictionLabel, convictionBar } from '../thesis/rollup.js'
import type { PositionSize, ThesisType } from '../types.js'

const DATA_DIR = join(process.cwd(), 'data')
const INGESTION_PATH = process.env.INGESTION_STORE_PATH
  ?? join(process.cwd(), '..', 'capital-intelligence-ingestion', 'data')

const args = process.argv.slice(2)
const command = args[0]
const get = (flag: string) => args.find(a => a.startsWith(`${flag}=`))?.split('=').slice(1).join('=')

async function main() {
  const store = createThesisStore(join(DATA_DIR, 'thesis.db'))

  try {
    if (command === 'list') {
      const theses = store.listTheses()
      if (theses.length === 0) { console.log('No theses yet. Run: npm run thesis -- create --ticker=NVDA'); return }
      console.log('\nYour Investment Theses:\n')
      for (const t of theses) {
        const assumptions = store.getAssumptions(t.id)
        const scores = assumptions.map(a => ({ stable: 0.5, strengthening: 1, weakening: 0, broken: -0.5 }[a.status] ?? 0.5))
        const avg = scores.length ? scores.reduce((s, n) => s + n, 0) / scores.length : 0.5
        console.log(`  ${t.ticker.padEnd(12)} [${t.positionSize.padEnd(10)}] ${convictionBar(avg)} ${convictionLabel(avg)}`)
      }
      return
    }

    if (command === 'show') {
      const ticker = get('--ticker')
      const theme = get('--theme')

      if (ticker) {
        const thesis = store.getThesis(ticker)
        if (!thesis) { console.error(`No thesis for ${ticker}`); process.exit(1) }
        const assumptions = store.getAssumptions(thesis.id)
        const narrative = store.getCurrentNarrative(thesis.id)
        console.log(`\n=== ${ticker} Thesis ===`)
        console.log(`Position: ${thesis.positionSize} | Updated: ${thesis.updatedAt.slice(0, 10)}\n`)
        console.log('Assumptions:')
        for (const a of assumptions) {
          console.log(`  [${a.status.padEnd(14)}] ${a.label}`)
          if (a.lastEvidenceSummary) console.log(`                 → ${a.lastEvidenceSummary}`)
        }
        console.log(`\nNarrative (v${narrative?.version ?? '?'}):\n${narrative?.content ?? 'No narrative.'}`)
        return
      }

      if (theme) {
        const themeTicker = theme
        const thesis = store.getThesis(themeTicker)
        if (!thesis) { console.error(`No theme thesis for ${theme}`); process.exit(1) }
        const members = store.getThemeMembers(thesis.id)
        const assumptionsByTicker: Record<string, typeof assumptions> = {}
        for (const m of members) {
          const mt = store.getThesis(m.ticker)
          if (mt) assumptionsByTicker[m.ticker] = store.getAssumptions(mt.id)
        }
        const score = computeThemeConviction(members, assumptionsByTicker)
        console.log(`\n=== ${theme} Theme ===`)
        console.log(`Overall: ${convictionLabel(score).toUpperCase()} (score: ${score.toFixed(2)})\n`)
        for (const m of members) {
          const mt = store.getThesis(m.ticker)
          if (!mt) continue
          const mas = assumptionsByTicker[m.ticker] ?? []
          const scores2 = mas.map(a => ({ stable: 0.5, strengthening: 1, weakening: 0, broken: -0.5 }[a.status] ?? 0.5))
          const avg = scores2.length ? scores2.reduce((s, n) => s + n, 0) / scores2.length : 0.5
          console.log(`  ${m.ticker.padEnd(8)} ${convictionBar(avg)} ${convictionLabel(avg).padEnd(14)} (weight: ${m.weight})`)
        }
        return
      }
    }

    if (command === 'history') {
      const ticker = get('--ticker')
      if (!ticker) { console.error('Usage: npm run thesis -- history --ticker=NVDA'); process.exit(1) }
      const thesis = store.getThesis(ticker)
      if (!thesis) { console.error(`No thesis for ${ticker}`); process.exit(1) }
      const history = store.getNarrativeHistory(thesis.id)
      console.log(`\n=== ${ticker} Narrative History (${history.length} versions) ===\n`)
      for (const n of history) {
        console.log(`--- v${n.version} (${n.createdAt.slice(0, 10)}) ---`)
        console.log(n.content + '\n')
      }
      return
    }

    if (command === 'create') {
      const ticker = get('--ticker')
      const theme = get('--theme')
      const manual = args.includes('--manual')
      const positionSize = (get('--position') ?? 'watchlist') as PositionSize
      const target = ticker ?? theme
      const thesisType: ThesisType = theme ? 'theme' : 'company'

      if (!target) { console.error('Usage: npm run thesis -- create --ticker=NVDA [--position=core] [--manual]'); process.exit(1) }

      const existing = store.getThesis(target)
      if (existing) { console.error(`Thesis for ${target} already exists. Use npm run update.`); process.exit(1) }

      if (manual) {
        console.log(`Creating manual thesis for ${target}. Enter assumptions (one per line, blank to finish):`)
        const assumptions: string[] = []
        process.stdout.write('> ')
        for await (const line of process.stdin) {
          const trimmed = line.toString().trim()
          if (!trimmed) break
          assumptions.push(trimmed)
          process.stdout.write('> ')
        }
        console.log('Enter narrative:')
        process.stdout.write('> ')
        let narrative = ''
        for await (const line of process.stdin) {
          narrative = line.toString().trim()
          break
        }
        createManualThesis(target, thesisType, positionSize, assumptions, narrative, store)
      } else {
        const apiKey = process.env.ANTHROPIC_API_KEY
        if (!apiKey) { console.error('ANTHROPIC_API_KEY not set'); process.exit(1) }
        console.log(`Drafting thesis for ${target} from ingestion data...`)
        const retriever = await createRetriever(INGESTION_PATH)
        const analyzer = createAnalyzer(apiKey)
        await draftThesisFromIngestion(target, thesisType, positionSize, store, retriever, analyzer)
      }
      return
    }

    console.error('Usage: npm run thesis -- <create|show|list|history> [options]')
    process.exit(1)
  } finally {
    store.close()
  }
}

// needed for async for-of on stdin
const assumptions: never[] = []
main().catch(err => { console.error(err); process.exit(1) })
```

- [ ] **Step 2: Commit**

```bash
git add src/cli/thesis.ts
git commit -m "feat: CLI thesis — create, show, list, history commands"
```

---

## Task 11: CLI — update command

**Files:**
- Create: `src/cli/update.ts`

- [ ] **Step 1: Create src/cli/update.ts**

```typescript
// src/cli/update.ts
import 'dotenv/config'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { createThesisStore } from '../store/sqlite.js'
import { createRetriever } from '../reasoning/retriever.js'
import { createAnalyzer } from '../reasoning/analyzer.js'
import { buildPrompt } from '../reasoning/prompter.js'

const DATA_DIR = join(process.cwd(), 'data')
const INGESTION_PATH = process.env.INGESTION_STORE_PATH
  ?? join(process.cwd(), '..', 'capital-intelligence-ingestion', 'data')

const args = process.argv.slice(2)
const get = (flag: string) => args.find(a => a.startsWith(`${flag}=`))?.split('=').slice(1).join('=')
const tickerArg = get('--ticker')
const themeArg = get('--theme')

async function generateProposal(
  ticker: string,
  store: ReturnType<typeof createThesisStore>,
  retriever: Awaited<ReturnType<typeof createRetriever>>,
  analyzer: ReturnType<typeof createAnalyzer>
): Promise<void> {
  const thesis = store.getThesis(ticker)
  if (!thesis) { console.error(`No thesis for ${ticker}. Create one first.`); return }

  const assumptions = store.getAssumptions(thesis.id)
  const narrative = store.getCurrentNarrative(thesis.id)
  if (!narrative) { console.error(`No narrative for ${ticker}`); return }

  const lastUpdated = thesis.updatedAt.slice(0, 10)
  console.log(`  Retrieving evidence for ${ticker} since ${lastUpdated}...`)

  // Retrieve chunks for each assumption
  const allChunks: typeof chunks = []
  const seenIds = new Set<string>()
  for (const assumption of assumptions) {
    const chunks2 = await retriever.search(assumption.label, ticker, 8, lastUpdated)
    for (const c of chunks2) {
      if (!seenIds.has(c.id)) { seenIds.add(c.id); allChunks.push(c) }
    }
  }

  if (allChunks.length === 0) {
    console.log(`  No new evidence for ${ticker} since ${lastUpdated} — skipping`)
    return
  }

  // Cap at 30 chunks
  const chunks = allChunks.slice(0, 30)
  console.log(`  Analyzing ${chunks.length} evidence chunks with Claude...`)

  const prompt = buildPrompt(thesis, assumptions, narrative, chunks, lastUpdated)
  const response = await analyzer.analyze(prompt, ticker)

  if (response.assumption_changes.length === 0 && !response.portfolio_action) {
    console.log(`  No changes proposed for ${ticker}`)
    return
  }

  // Store proposal
  const proposalId = randomUUID()
  const now = new Date().toISOString()

  store.createProposal({
    id: proposalId,
    thesisId: thesis.id,
    status: 'pending',
    chunkIdsUsed: chunks.map(c => c.id),
    claudeReasoning: JSON.stringify(response),
    createdAt: now,
    resolvedAt: null,
  })

  // Store individual changes
  for (const change of response.assumption_changes) {
    const assumption = assumptions.find(a => a.label === change.label)
    store.createProposalChange({
      id: randomUUID(),
      proposalId,
      changeType: 'assumption_status',
      assumptionId: assumption?.id ?? null,
      oldValue: change.old_status,
      newValue: change.new_status,
      reasoning: change.reasoning,
      evidenceQuotes: change.evidence_quotes,
      approved: null,
    })
  }

  if (response.narrative_update && response.narrative_update !== narrative.content) {
    store.createProposalChange({
      id: randomUUID(),
      proposalId,
      changeType: 'narrative',
      assumptionId: null,
      oldValue: narrative.content,
      newValue: response.narrative_update,
      reasoning: 'Updated narrative based on new evidence',
      evidenceQuotes: [],
      approved: null,
    })
  }

  if (response.portfolio_action) {
    store.createProposalChange({
      id: randomUUID(),
      proposalId,
      changeType: 'portfolio_action',
      assumptionId: null,
      oldValue: '',
      newValue: JSON.stringify(response.portfolio_action),
      reasoning: response.portfolio_action.reasoning,
      evidenceQuotes: [],
      approved: null,
    })
  }

  const changeCount = response.assumption_changes.length + (response.narrative_update !== narrative.content ? 1 : 0)
  console.log(`  ✓ Proposal created: ${changeCount} changes + ${response.portfolio_action ? '1 action suggestion' : 'no action suggestion'}`)
}

async function main() {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) { console.error('ANTHROPIC_API_KEY not set'); process.exit(1) }

  const store = createThesisStore(join(DATA_DIR, 'thesis.db'))
  const retriever = await createRetriever(INGESTION_PATH)
  const analyzer = createAnalyzer(apiKey)

  try {
    let tickers: string[] = []

    if (tickerArg) {
      tickers = [tickerArg]
    } else if (themeArg) {
      const themeTicker = store.getThesis(themeArg)
      if (!themeTicker) { console.error(`No theme thesis for ${themeArg}`); process.exit(1) }
      tickers = store.getThemeMembers(themeTicker.id).map(m => m.ticker)
    } else {
      tickers = store.listTheses().filter(t => t.type === 'company').map(t => t.ticker)
    }

    if (tickers.length === 0) { console.log('No theses to update.'); return }

    console.log(`\nGenerating proposals for ${tickers.length} thesis(es)...\n`)
    for (const ticker of tickers) {
      await generateProposal(ticker, store, retriever, analyzer)
    }

    const pending = store.getPendingProposals()
    console.log(`\nDone. ${pending.length} proposal(s) pending review. Run: npm run review`)
  } finally {
    store.close()
  }
}

// type fix for chunks variable
type Chunks = Awaited<ReturnType<Awaited<ReturnType<typeof createRetriever>>['search']>>
const chunks: Chunks = []

main().catch(err => { console.error(err); process.exit(1) })
```

- [ ] **Step 2: Commit**

```bash
git add src/cli/update.ts
git commit -m "feat: CLI update — generate Claude proposals for all theses"
```

---

## Task 12: CLI — review command

**Files:**
- Create: `src/cli/review.ts`

- [ ] **Step 1: Create src/cli/review.ts**

```typescript
// src/cli/review.ts
import 'dotenv/config'
import { join } from 'path'
import * as readline from 'readline'
import { createThesisStore } from '../store/sqlite.js'
import { applyApprovedChanges } from '../thesis/updater.js'

const DATA_DIR = join(process.cwd(), 'data')

function prompt(rl: readline.Interface, question: string): Promise<string> {
  return new Promise(resolve => rl.question(question, resolve))
}

async function main() {
  const store = createThesisStore(join(DATA_DIR, 'thesis.db'))
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })

  try {
    const proposals = store.getPendingProposals()

    if (proposals.length === 0) {
      console.log('\nNo pending proposals. Run: npm run update')
      return
    }

    console.log(`\n=== Pending Proposals (${proposals.length}) ===`)

    for (let pi = 0; pi < proposals.length; pi++) {
      const proposal = proposals[pi]
      const thesis = store.getThesis(proposal.thesisId) ??
        store.listTheses().find(t => t.id === proposal.thesisId)

      const ticker = thesis?.ticker ?? proposal.thesisId
      const changes = store.getProposalChanges(proposal.id)

      console.log(`\n[${pi + 1}/${proposals.length}] ${ticker} — generated ${proposal.createdAt.slice(0, 10)}\n`)

      const assumptionChanges = changes.filter(c => c.changeType === 'assumption_status')
      const narrativeChange = changes.find(c => c.changeType === 'narrative')
      const actionChange = changes.find(c => c.changeType === 'portfolio_action')

      if (assumptionChanges.length > 0) {
        console.log('  Assumption changes:')
        assumptionChanges.forEach((c, i) => {
          console.log(`  [${i + 1}] ${c.oldValue} → ${c.newValue.toUpperCase()}: ${c.oldValue !== c.newValue ? '⚡ ' : ''}`)
          // find label by assumption id
          const assumptions = thesis ? store.getAssumptions(thesis.id) : []
          const assumption = assumptions.find(a => a.id === c.assumptionId)
          if (assumption) console.log(`      "${assumption.label}"`)
          console.log(`      Reason: ${c.reasoning}`)
          if (c.evidenceQuotes.length > 0) console.log(`      Evidence: "${c.evidenceQuotes[0].slice(0, 120)}"`)
        })
      }

      if (narrativeChange) {
        console.log('\n  Narrative update:')
        console.log(`    OLD: ${narrativeChange.oldValue.slice(0, 100)}...`)
        console.log(`    NEW: ${narrativeChange.newValue.slice(0, 100)}...`)
      }

      if (actionChange) {
        const action = JSON.parse(actionChange.newValue) as { action: string; reasoning: string; conviction: number }
        console.log(`\n  Portfolio action (suggestion): ${action.action.toUpperCase()} — ${action.reasoning} (conviction: ${action.conviction}/10)`)
      }

      console.log('\n  [a] Approve all  [r] Reject all  [s] Skip  [q] Quit')
      const answer = (await prompt(rl, '  > ')).trim().toLowerCase()

      if (answer === 'q') break
      if (answer === 's') continue

      const approveAll = answer === 'a'
      const rejectAll = answer === 'r'

      for (const change of changes) {
        store.approveProposalChange(change.id, approveAll ? true : rejectAll ? false : false)
      }

      const anyApproved = changes.some(c => {
        const updated = store.getProposalChanges(proposal.id).find(pc => pc.id === c.id)
        return updated?.approved === true
      })

      if (approveAll) {
        applyApprovedChanges(proposal.id, store)
        store.updateProposalStatus(proposal.id, 'approved')
        console.log(`  ✓ Changes applied to ${ticker} thesis.`)
      } else if (rejectAll) {
        store.updateProposalStatus(proposal.id, 'rejected')
        console.log(`  ✗ Proposal rejected.`)
      }
    }

    console.log('\nReview complete.')
  } finally {
    rl.close()
    store.close()
  }
}

main().catch(err => { console.error(err); process.exit(1) })
```

- [ ] **Step 2: Commit**

```bash
git add src/cli/review.ts
git commit -m "feat: CLI review — interactive proposal approval"
```

---

## Task 13: Full Test Suite + README

**Files:**
- Create: `README.md`

- [ ] **Step 1: Run full test suite**

```bash
npm test
```

Expected: All tests pass. Fix any failures before proceeding.

- [ ] **Step 2: Create README.md**

```markdown
# Thesis Memory System

Tracks investment theses as structured assumptions + living narratives. Uses Claude to propose updates from ingestion data. Requires your approval before committing any change.

## Setup

```bash
npm install
cp .env.example .env
# Fill in ANTHROPIC_API_KEY
# Set INGESTION_STORE_PATH if not using default sibling directory
```

## Usage

```bash
# Create a thesis (AI drafts from ingestion data)
npm run thesis -- create --ticker=NVDA --position=core

# Create manually
npm run thesis -- create --ticker=NVDA --manual

# View a thesis
npm run thesis -- show --ticker=NVDA

# List all theses
npm run thesis -- list

# View full narrative history
npm run thesis -- history --ticker=NVDA

# Generate update proposals (calls Claude)
npm run update -- --ticker=NVDA
npm run update                      # all theses

# Review and approve pending proposals
npm run review
```

## How It Works

1. `npm run update` queries the ingestion store for evidence relevant to your assumptions
2. Claude analyzes the evidence and proposes changes (status updates, narrative update, portfolio action)
3. `npm run review` shows you each proposed change — you approve or reject
4. Approved changes are applied; rejected changes are recorded in the audit trail

## Data

All data lives in `data/thesis.db` (gitignored — never pushed).
```

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: README with setup and usage"
```

- [ ] **Step 4: Tag v0.1.0**

```bash
git tag v0.1.0
```

---

## Self-Review

**Spec coverage:**
- ✅ Structured assumptions + living narrative — Tasks 2, 3
- ✅ AI proposes, user approves — Tasks 6, 11, 12
- ✅ AI-draft or manual creation — Task 9, 10
- ✅ Per-company + theme rollup — Tasks 8, 10
- ✅ Full narrative history (append-only) — Task 3 (narratives table, getCurrentNarrative returns highest version)
- ✅ Portfolio action suggestions — Tasks 6, 11, 12
- ✅ Conviction tracking — Tasks 8, 10
- ✅ Audit trail (chunk_ids_used, claude_reasoning stored) — Task 11
- ✅ Read-only access to ingestion store — Task 4 (retriever reads only)
- ✅ INGESTION_STORE_PATH env var — Tasks 10, 11

**Placeholder scan:** No TBD, TODO, or incomplete steps found.

**Type consistency:**
- `AssumptionStatus` used consistently: sqlite.ts, updater.ts, rollup.ts, analyzer.ts
- `ThesisStore` interface matches implementation throughout
- `EvidenceChunk` returned by retriever, consumed by prompter and update CLI
- `ProposalResponse` returned by analyzer, consumed by update CLI
- `applyApprovedChanges(proposalId, store)` called correctly in review CLI
