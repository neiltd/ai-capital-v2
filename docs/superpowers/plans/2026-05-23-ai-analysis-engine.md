# AI Analysis Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a daily-scheduled TypeScript engine that collects company health signals, classifies the macro regime via Claude, and propagates dependency signals through the graph — outputting SQLite history, analysis.json, and a Markdown report.

**Architecture:** Two-stage pipeline: Stage 1 (pure code) collects CompanyHealth from thesis-memory SQLite + ingestion LanceDB; Stage 2 makes two Claude tool-use calls — one to classify the macro regime, one to identify which graph edges are transmitting signals. Results stored in analysis.db and exported to JSON + Markdown.

**Tech Stack:** TypeScript ESM (NodeNext), tsx, better-sqlite3, @lancedb/lancedb, @anthropic-ai/sdk (Claude Sonnet 4.6 with prompt caching), node-cron, vitest

---

## File Map

```
ai-analysis-engine/
  src/
    types.ts                          ← all shared types
    store/
      sqlite.ts                       ← analysis.db schema + CRUD
    collector/
      health-collector.ts             ← Stage 1: reads thesis.db + lancedb
    analysis/
      regime-analyzer.ts              ← Stage 2a: Claude classify_macro_regime tool
      propagation-analyzer.ts         ← Stage 2b: Claude propose_propagation_signals tool
    export/
      exporter.ts                     ← writes data/analysis.json
      reporter.ts                     ← writes data/reports/YYYY-MM-DD.md
    cli/
      cli-run.ts                      ← npm run analyze (one-shot)
      cli-schedule.ts                 ← npm run schedule (daily cron)
      cli-report.ts                   ← npm run report (print latest)
  tests/
    store.test.ts
    health-collector.test.ts
    regime-analyzer.test.ts
    propagation-analyzer.test.ts
    exporter.test.ts
    reporter.test.ts
  package.json
  tsconfig.json
  vitest.config.ts
  .env
  .gitignore
```

**Sibling paths (read-only):**
- `../thesis-memory/data/thesis.db` — tables: theses, assumptions (label/status columns), narratives (content/version)
- `../capital-intelligence-ingestion/data/lancedb` — table: chunks (ticker, content, publishedDate, source, docType)
- `../dependency-graph-engine/data/graph.json` — `{ nodes: [{ticker,company,themes}], edges: [{from,to,type,strength,description,evidenceQuote}] }`

**thesis-memory AssumptionStatus values:** `'strengthening' | 'stable' | 'weakening' | 'broken'`
(Note: spec draft said 'holding' — the actual value in thesis-memory is 'stable')

---

## Task 1: Project Scaffold

**Files:**
- Create: `ai-analysis-engine/package.json`
- Create: `ai-analysis-engine/tsconfig.json`
- Create: `ai-analysis-engine/vitest.config.ts`
- Create: `ai-analysis-engine/.env`
- Create: `ai-analysis-engine/.gitignore`

- [ ] **Step 1: Create project directory and package.json**

```bash
mkdir -p /Users/thanapold/Desktop/Projects/ai-analysis-engine
cd /Users/thanapold/Desktop/Projects/ai-analysis-engine
```

Create `package.json`:
```json
{
  "name": "ai-analysis-engine",
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "analyze":    "tsx src/cli/cli-run.ts",
    "schedule":   "tsx src/cli/cli-schedule.ts",
    "report":     "tsx src/cli/cli-report.ts",
    "test":       "vitest run",
    "test:watch": "vitest"
  },
  "dependencies": {
    "@anthropic-ai/sdk": "^0.39.0",
    "@lancedb/lancedb":  "^0.29.0",
    "better-sqlite3":    "^12.0.0",
    "dotenv":            "^16.0.0",
    "node-cron":         "^3.0.0"
  },
  "devDependencies": {
    "@types/better-sqlite3": "^7.6.11",
    "@types/node":           "^22.0.0",
    "@types/node-cron":      "^3.0.11",
    "tsx":                   "^4.16.0",
    "typescript":            "^5.5.0",
    "vitest":                "^2.0.0"
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

```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
  },
})
```

- [ ] **Step 4: Create .env and .gitignore**

`.env`:
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

- [ ] **Step 5: Install dependencies**

```bash
npm install
```

Expected: `node_modules/` created, no errors.

- [ ] **Step 6: Commit**

```bash
git add package.json tsconfig.json vitest.config.ts .gitignore
git commit -m "chore: scaffold ai-analysis-engine project"
```

---

## Task 2: Types

**Files:**
- Create: `src/types.ts`

- [ ] **Step 1: Create src/types.ts**

```bash
mkdir -p src/store src/collector src/analysis src/export src/cli tests
```

Create `src/types.ts`:
```ts
export type HealthScore         = 'positive' | 'neutral' | 'negative' | 'insufficient_data'
export type RegimeConfidence    = 'high' | 'medium' | 'low'
export type SignalType          = 'supply_chain' | 'customer' | 'technology' | 'competitive'
export type SignalDirection     = 'upstream' | 'downstream'
export type SignalMagnitude     = 'strong' | 'moderate' | 'weak'
export type SignalSentiment     = 'positive' | 'negative' | 'neutral'
export type ThesisAssumptionStatus = 'strengthening' | 'stable' | 'weakening' | 'broken'

export interface ThesisAssumption {
  text:   string
  status: ThesisAssumptionStatus
}

export interface RecentChunk {
  chunkId:      string
  title:        string
  source:       string
  publishedDate: string
  content:      string
}

export interface CompanyHealth {
  ticker:        string
  company:       string
  thesisSummary: string
  assumptions:   ThesisAssumption[]
  recentChunks:  RecentChunk[]
  healthScore:   HealthScore
}

export interface MacroRegime {
  id:              string
  date:            string
  regime:          string
  confidence:      RegimeConfidence
  rationale:       string
  keyIndicators:   string[]
  affectedTickers: string[]
  createdAt:       string
}

export interface PropagationSignal {
  id:            string
  date:          string
  sourceTicker:  string
  targetTicker:  string
  signalType:    SignalType
  direction:     SignalDirection
  magnitude:     SignalMagnitude
  sentiment:     SignalSentiment
  description:   string
  evidenceQuote: string | null
  createdAt:     string
}

export interface AnalysisRun {
  id:                     string
  date:                   string
  companiesAnalyzed:      number
  regimeId:               string
  propagationSignalCount: number
  durationMs:             number
  createdAt:              string
}

export interface GraphJSON {
  exportedAt: string
  nodes: Array<{ ticker: string; company: string; themes: string[] }>
  edges: Array<{
    from:          string
    to:            string
    type:          string
    strength:      string
    description:   string
    evidenceQuote: string | null
  }>
}

export interface AnalysisJSON {
  exportedAt:       string
  latestRegime:     MacroRegime
  latestSignals:    PropagationSignal[]
  companySummaries: Array<{
    ticker:        string
    company:       string
    healthScore:   HealthScore
    thesisSummary: string
  }>
}
```

- [ ] **Step 2: Commit**

```bash
git add src/types.ts
git commit -m "feat: add shared types for ai-analysis-engine"
```

---

## Task 3: SQLite Store

**Files:**
- Create: `src/store/sqlite.ts`
- Create: `tests/store.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/store.test.ts`:
```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { unlinkSync, existsSync } from 'fs'
import { createAnalysisStore } from '../src/store/sqlite.js'
import type { MacroRegime, PropagationSignal } from '../src/types.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const TEST_DB = join(__dirname, 'test-analysis.db')

describe('AnalysisStore', () => {
  let store: ReturnType<typeof createAnalysisStore>

  beforeEach(() => { store = createAnalysisStore(TEST_DB) })
  afterEach(() => {
    store.close()
    if (existsSync(TEST_DB)) unlinkSync(TEST_DB)
  })

  const regime: MacroRegime = {
    id: 'r1', date: '2026-05-23', regime: 'AI Acceleration',
    confidence: 'high', rationale: 'GPU demand strong',
    keyIndicators: ['NVDA revenue up', 'CRWV expanding'],
    affectedTickers: ['NVDA', 'TSM'],
    createdAt: '2026-05-23T06:00:00.000Z',
  }

  it('inserts and retrieves latest regime', () => {
    store.insertRegime(regime)
    const latest = store.getLatestRegime()
    expect(latest).not.toBeNull()
    expect(latest!.regime).toBe('AI Acceleration')
    expect(latest!.keyIndicators).toEqual(['NVDA revenue up', 'CRWV expanding'])
    expect(latest!.affectedTickers).toEqual(['NVDA', 'TSM'])
  })

  it('returns null when no regime exists', () => {
    expect(store.getLatestRegime()).toBeNull()
  })

  it('retrieves regimes by date', () => {
    store.insertRegime(regime)
    expect(store.getRegimesByDate('2026-05-23')).toHaveLength(1)
    expect(store.getRegimesByDate('2026-05-24')).toHaveLength(0)
  })

  const signal: PropagationSignal = {
    id: 's1', date: '2026-05-23',
    sourceTicker: 'NVDA', targetTicker: 'CRWV',
    signalType: 'customer', direction: 'downstream',
    magnitude: 'strong', sentiment: 'positive',
    description: 'CRWV benefits from NVDA GPU supply',
    evidenceQuote: null,
    createdAt: '2026-05-23T06:00:00.000Z',
  }

  it('inserts and retrieves signals by date', () => {
    store.insertSignal(signal)
    const results = store.getSignalsByDate('2026-05-23')
    expect(results).toHaveLength(1)
    expect(results[0].sourceTicker).toBe('NVDA')
    expect(results[0].evidenceQuote).toBeNull()
  })

  it('inserts analysis run without throwing', () => {
    store.insertRun({
      id: 'run1', date: '2026-05-23', companiesAnalyzed: 34,
      regimeId: 'r1', propagationSignalCount: 12,
      durationMs: 5000, createdAt: '2026-05-23T06:00:00.000Z',
    })
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run tests/store.test.ts
```

Expected: FAIL — `createAnalysisStore` not found.

- [ ] **Step 3: Implement src/store/sqlite.ts**

```ts
import Database from 'better-sqlite3'
import type { MacroRegime, PropagationSignal, AnalysisRun } from '../types.js'

export interface AnalysisStore {
  insertRegime(regime: MacroRegime): void
  getLatestRegime(): MacroRegime | null
  getRegimesByDate(date: string): MacroRegime[]
  insertSignal(signal: PropagationSignal): void
  getSignalsByDate(date: string): PropagationSignal[]
  insertRun(run: AnalysisRun): void
  close(): void
}

export function createAnalysisStore(dbPath: string): AnalysisStore {
  const db = new Database(dbPath)
  db.pragma('journal_mode = WAL')

  db.exec(`
    CREATE TABLE IF NOT EXISTS macro_regimes (
      id               TEXT PRIMARY KEY,
      date             TEXT NOT NULL,
      regime           TEXT NOT NULL,
      confidence       TEXT NOT NULL,
      rationale        TEXT NOT NULL,
      key_indicators   TEXT NOT NULL,
      affected_tickers TEXT NOT NULL,
      created_at       TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS propagation_signals (
      id             TEXT PRIMARY KEY,
      date           TEXT NOT NULL,
      source_ticker  TEXT NOT NULL,
      target_ticker  TEXT NOT NULL,
      signal_type    TEXT NOT NULL,
      direction      TEXT NOT NULL,
      magnitude      TEXT NOT NULL,
      sentiment      TEXT NOT NULL,
      description    TEXT NOT NULL,
      evidence_quote TEXT,
      created_at     TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS analysis_runs (
      id                       TEXT PRIMARY KEY,
      date                     TEXT NOT NULL,
      companies_analyzed       INTEGER NOT NULL,
      regime_id                TEXT NOT NULL,
      propagation_signal_count INTEGER NOT NULL,
      duration_ms              INTEGER NOT NULL,
      created_at               TEXT NOT NULL
    );
  `)

  function rowToRegime(row: Record<string, unknown>): MacroRegime {
    return {
      id:              row.id as string,
      date:            row.date as string,
      regime:          row.regime as string,
      confidence:      row.confidence as MacroRegime['confidence'],
      rationale:       row.rationale as string,
      keyIndicators:   JSON.parse(row.key_indicators as string),
      affectedTickers: JSON.parse(row.affected_tickers as string),
      createdAt:       row.created_at as string,
    }
  }

  function rowToSignal(row: Record<string, unknown>): PropagationSignal {
    return {
      id:            row.id as string,
      date:          row.date as string,
      sourceTicker:  row.source_ticker as string,
      targetTicker:  row.target_ticker as string,
      signalType:    row.signal_type as PropagationSignal['signalType'],
      direction:     row.direction as PropagationSignal['direction'],
      magnitude:     row.magnitude as PropagationSignal['magnitude'],
      sentiment:     row.sentiment as PropagationSignal['sentiment'],
      description:   row.description as string,
      evidenceQuote: row.evidence_quote as string | null,
      createdAt:     row.created_at as string,
    }
  }

  return {
    insertRegime(r) {
      db.prepare(`
        INSERT INTO macro_regimes
          (id, date, regime, confidence, rationale, key_indicators, affected_tickers, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(r.id, r.date, r.regime, r.confidence, r.rationale,
             JSON.stringify(r.keyIndicators), JSON.stringify(r.affectedTickers), r.createdAt)
    },
    getLatestRegime() {
      const row = db.prepare(
        'SELECT * FROM macro_regimes ORDER BY created_at DESC LIMIT 1'
      ).get() as Record<string, unknown> | undefined
      return row ? rowToRegime(row) : null
    },
    getRegimesByDate(date) {
      return (db.prepare('SELECT * FROM macro_regimes WHERE date = ? ORDER BY created_at')
        .all(date) as Record<string, unknown>[]).map(rowToRegime)
    },
    insertSignal(s) {
      db.prepare(`
        INSERT INTO propagation_signals
          (id, date, source_ticker, target_ticker, signal_type, direction,
           magnitude, sentiment, description, evidence_quote, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(s.id, s.date, s.sourceTicker, s.targetTicker, s.signalType,
             s.direction, s.magnitude, s.sentiment, s.description, s.evidenceQuote, s.createdAt)
    },
    getSignalsByDate(date) {
      return (db.prepare('SELECT * FROM propagation_signals WHERE date = ? ORDER BY created_at')
        .all(date) as Record<string, unknown>[]).map(rowToSignal)
    },
    insertRun(run) {
      db.prepare(`
        INSERT INTO analysis_runs
          (id, date, companies_analyzed, regime_id, propagation_signal_count, duration_ms, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(run.id, run.date, run.companiesAnalyzed, run.regimeId,
             run.propagationSignalCount, run.durationMs, run.createdAt)
    },
    close() { db.close() },
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run tests/store.test.ts
```

Expected: PASS — 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src/store/sqlite.ts tests/store.test.ts
git commit -m "feat: add AnalysisStore with SQLite persistence"
```

---

## Task 4: Health Collector

**Files:**
- Create: `src/collector/health-collector.ts`
- Create: `tests/health-collector.test.ts`

- [ ] **Step 1: Write failing tests**

Create `tests/health-collector.test.ts`:
```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { unlinkSync, existsSync } from 'fs'
import Database from 'better-sqlite3'
import { collectHealth } from '../src/collector/health-collector.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const TEMP_THESIS_DB = join(__dirname, 'temp-thesis.db')

function createTempThesisDb() {
  const db = new Database(TEMP_THESIS_DB)
  db.exec(`
    CREATE TABLE IF NOT EXISTS theses (
      id TEXT PRIMARY KEY, ticker TEXT NOT NULL, type TEXT NOT NULL,
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
  `)
  return db
}

describe('collectHealth', () => {
  let db: Database.Database

  beforeEach(() => { db = createTempThesisDb() })
  afterEach(() => {
    db.close()
    if (existsSync(TEMP_THESIS_DB)) unlinkSync(TEMP_THESIS_DB)
  })

  it('returns insufficient_data when no thesis exists', async () => {
    const results = await collectHealth(
      [{ ticker: 'NVDA', company: 'NVIDIA' }],
      { thesisDbPath: TEMP_THESIS_DB, lanceDbPath: '/nonexistent' },
    )
    expect(results).toHaveLength(1)
    expect(results[0].healthScore).toBe('insufficient_data')
    expect(results[0].assumptions).toEqual([])
    expect(results[0].recentChunks).toEqual([])
  })

  it('returns positive when all assumptions are stable or strengthening', async () => {
    db.prepare('INSERT INTO theses VALUES (?, ?, ?, ?, ?, ?)').run('t1', 'NVDA', 'company', 'core', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
    db.prepare('INSERT INTO narratives VALUES (?, ?, ?, ?, ?)').run('n1', 't1', 'NVDA is the GPU leader', 1, '2026-01-01T00:00:00.000Z')
    db.prepare('INSERT INTO assumptions VALUES (?, ?, ?, ?, ?, ?, ?)').run('a1', 't1', 'GPU demand stays strong', 'stable', null, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
    db.prepare('INSERT INTO assumptions VALUES (?, ?, ?, ?, ?, ?, ?)').run('a2', 't1', 'TSMC capacity available', 'strengthening', null, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')

    const results = await collectHealth(
      [{ ticker: 'NVDA', company: 'NVIDIA' }],
      { thesisDbPath: TEMP_THESIS_DB, lanceDbPath: '/nonexistent' },
    )
    expect(results[0].healthScore).toBe('positive')
    expect(results[0].thesisSummary).toBe('NVDA is the GPU leader')
    expect(results[0].assumptions).toHaveLength(2)
    expect(results[0].assumptions[0]).toEqual({ text: 'GPU demand stays strong', status: 'stable' })
  })

  it('returns negative when any assumption is broken', async () => {
    db.prepare('INSERT INTO theses VALUES (?, ?, ?, ?, ?, ?)').run('t2', 'AMD', 'company', 'satellite', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
    db.prepare('INSERT INTO narratives VALUES (?, ?, ?, ?, ?)').run('n2', 't2', 'AMD thesis', 1, '2026-01-01T00:00:00.000Z')
    db.prepare('INSERT INTO assumptions VALUES (?, ?, ?, ?, ?, ?, ?)').run('a3', 't2', 'Market share gains', 'broken', null, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
    db.prepare('INSERT INTO assumptions VALUES (?, ?, ?, ?, ?, ?, ?)').run('a4', 't2', 'TSMC yields', 'stable', null, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')

    const results = await collectHealth(
      [{ ticker: 'AMD', company: 'AMD' }],
      { thesisDbPath: TEMP_THESIS_DB, lanceDbPath: '/nonexistent' },
    )
    expect(results[0].healthScore).toBe('negative')
  })

  it('returns neutral when assumptions include weakening but not broken', async () => {
    db.prepare('INSERT INTO theses VALUES (?, ?, ?, ?, ?, ?)').run('t3', 'TSM', 'company', 'core', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
    db.prepare('INSERT INTO narratives VALUES (?, ?, ?, ?, ?)').run('n3', 't3', 'TSM thesis', 1, '2026-01-01T00:00:00.000Z')
    db.prepare('INSERT INTO assumptions VALUES (?, ?, ?, ?, ?, ?, ?)').run('a5', 't3', 'Advanced node demand', 'stable', null, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
    db.prepare('INSERT INTO assumptions VALUES (?, ?, ?, ?, ?, ?, ?)').run('a6', 't3', 'Customer concentration', 'weakening', null, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')

    const results = await collectHealth(
      [{ ticker: 'TSM', company: 'TSMC' }],
      { thesisDbPath: TEMP_THESIS_DB, lanceDbPath: '/nonexistent' },
    )
    expect(results[0].healthScore).toBe('neutral')
  })

  it('skips theme theses — only reads company type', async () => {
    db.prepare('INSERT INTO theses VALUES (?, ?, ?, ?, ?, ?)').run('t4', 'NVDA', 'theme', 'core', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')

    const results = await collectHealth(
      [{ ticker: 'NVDA', company: 'NVIDIA' }],
      { thesisDbPath: TEMP_THESIS_DB, lanceDbPath: '/nonexistent' },
    )
    expect(results[0].healthScore).toBe('insufficient_data')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run tests/health-collector.test.ts
```

Expected: FAIL — `collectHealth` not found.

- [ ] **Step 3: Implement src/collector/health-collector.ts**

```ts
import Database from 'better-sqlite3'
import { join } from 'path'
import * as lancedb from '@lancedb/lancedb'
import type { CompanyHealth, ThesisAssumption, RecentChunk, HealthScore } from '../types.js'

const DEFAULT_THESIS_DB  = join(process.cwd(), '../thesis-memory/data/thesis.db')
const DEFAULT_LANCE_PATH = join(process.cwd(), '../capital-intelligence-ingestion/data/lancedb')

function computeHealthScore(assumptions: ThesisAssumption[]): HealthScore {
  if (assumptions.length === 0) return 'insufficient_data'
  if (assumptions.some(a => a.status === 'broken')) return 'negative'
  if (assumptions.every(a => a.status === 'stable' || a.status === 'strengthening')) return 'positive'
  return 'neutral'
}

export async function collectHealth(
  nodes: Array<{ ticker: string; company: string }>,
  options: { thesisDbPath?: string; lanceDbPath?: string } = {},
): Promise<CompanyHealth[]> {
  const thesisDbPath = options.thesisDbPath ?? DEFAULT_THESIS_DB
  const lanceDbPath  = options.lanceDbPath  ?? DEFAULT_LANCE_PATH

  const thesisDb = new Database(thesisDbPath, { readonly: true })
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)

  let lanceTable: any = null
  try {
    const conn = await lancedb.connect(lanceDbPath)
    const names = await conn.tableNames()
    if (names.includes('chunks')) lanceTable = await conn.openTable('chunks')
  } catch {
    // LanceDB unavailable — recentChunks will be empty for all companies
  }

  const results: CompanyHealth[] = []

  for (const node of nodes) {
    const thesisRow = thesisDb.prepare(
      "SELECT * FROM theses WHERE ticker = ? AND type = 'company'"
    ).get(node.ticker) as Record<string, unknown> | undefined

    if (!thesisRow) {
      results.push({
        ticker: node.ticker, company: node.company,
        thesisSummary: '', assumptions: [], recentChunks: [],
        healthScore: 'insufficient_data',
      })
      continue
    }

    const narrativeRow = thesisDb.prepare(
      'SELECT content FROM narratives WHERE thesis_id = ? ORDER BY version DESC LIMIT 1'
    ).get(thesisRow.id as string) as { content: string } | undefined

    const assumptionRows = thesisDb.prepare(
      'SELECT label, status FROM assumptions WHERE thesis_id = ? ORDER BY created_at'
    ).all(thesisRow.id as string) as Array<{ label: string; status: string }>

    const assumptions: ThesisAssumption[] = assumptionRows.map(r => ({
      text:   r.label,
      status: r.status as ThesisAssumption['status'],
    }))

    const recentChunks: RecentChunk[] = []
    if (lanceTable) {
      try {
        const rows = await lanceTable.query()
          .where(`ticker = '${node.ticker}'`)
          .limit(200)
          .toArray() as any[]

        rows
          .filter(r => { try { return new Date(r.publishedDate) >= sevenDaysAgo } catch { return false } })
          .slice(0, 10)
          .forEach((r: any) => recentChunks.push({
            chunkId:       r.id as string,
            title:         r.docType as string,
            source:        r.source as string,
            publishedDate: r.publishedDate as string,
            content:       (r.content as string).slice(0, 500),
          }))
      } catch {
        // silently skip per-ticker LanceDB errors
      }
    }

    results.push({
      ticker:        node.ticker,
      company:       node.company,
      thesisSummary: narrativeRow?.content ?? '',
      assumptions,
      recentChunks,
      healthScore:   computeHealthScore(assumptions),
    })
  }

  thesisDb.close()
  return results
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run tests/health-collector.test.ts
```

Expected: PASS — 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src/collector/health-collector.ts tests/health-collector.test.ts
git commit -m "feat: add health-collector (Stage 1 — reads thesis + lancedb)"
```

---

## Task 5: Regime Analyzer

**Files:**
- Create: `src/analysis/regime-analyzer.ts`
- Create: `tests/regime-analyzer.test.ts`

- [ ] **Step 1: Write failing tests**

Create `tests/regime-analyzer.test.ts`:
```ts
import { describe, it, expect, vi } from 'vitest'
import { analyzeRegime } from '../src/analysis/regime-analyzer.js'
import type { CompanyHealth } from '../src/types.js'

const mockHealth: CompanyHealth[] = [{
  ticker: 'NVDA', company: 'NVIDIA',
  thesisSummary: 'NVIDIA dominates GPU market',
  assumptions: [{ text: 'GPU demand stays strong', status: 'stable' }],
  recentChunks: [],
  healthScore: 'positive',
}]

describe('analyzeRegime', () => {
  it('returns MacroRegime with correct shape from Claude tool response', async () => {
    const mockClient = {
      messages: {
        create: vi.fn().mockResolvedValue({
          content: [{
            type: 'tool_use',
            name: 'classify_macro_regime',
            input: {
              regime: 'AI Acceleration',
              confidence: 'high',
              rationale: 'GPU demand is strong across the board.',
              keyIndicators: ['NVDA revenue up 60%', 'CRWV expanding capacity'],
              affectedTickers: ['NVDA', 'TSM'],
            },
          }],
        }),
      },
    }

    const result = await analyzeRegime(mockHealth, { client: mockClient as any })

    expect(result.regime).toBe('AI Acceleration')
    expect(result.confidence).toBe('high')
    expect(result.rationale).toBe('GPU demand is strong across the board.')
    expect(result.keyIndicators).toHaveLength(2)
    expect(result.affectedTickers).toContain('NVDA')
    expect(result.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(result.date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(result.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('throws when Claude does not return tool_use block', async () => {
    const mockClient = {
      messages: {
        create: vi.fn().mockResolvedValue({
          content: [{ type: 'text', text: 'unexpected text response' }],
        }),
      },
    }

    await expect(analyzeRegime(mockHealth, { client: mockClient as any }))
      .rejects.toThrow('Expected tool_use response')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run tests/regime-analyzer.test.ts
```

Expected: FAIL — `analyzeRegime` not found.

- [ ] **Step 3: Implement src/analysis/regime-analyzer.ts**

```ts
import Anthropic from '@anthropic-ai/sdk'
import { randomUUID } from 'crypto'
import type { CompanyHealth, MacroRegime, RegimeConfidence } from '../types.js'

const SYSTEM_PROMPT = `You are a macro technology investment analyst.
Classify the current investment regime based on company health signals using the classify_macro_regime tool.

Regime taxonomy examples (you may coin a new label when none fit):
- AI Acceleration: broad AI infrastructure spending up, GPU demand strong
- Semiconductor Correction: inventory excess, CapEx pullback across fab customers
- Cloud Consolidation: hyperscalers slowing new commitments, renegotiating contracts
- Energy Bottleneck: data center buildout constrained by power availability
- AI Commoditization: model costs falling, compute demand shifting to inference

Base your classification strictly on the provided company health signals.`

const CLASSIFY_TOOL: Anthropic.Tool = {
  name: 'classify_macro_regime',
  description: 'Classify the current macro technology investment regime based on company health signals',
  input_schema: {
    type: 'object',
    properties: {
      regime:          { type: 'string', description: 'Short label, e.g. AI Acceleration' },
      confidence:      { type: 'string', enum: ['high', 'medium', 'low'] },
      rationale:       { type: 'string', description: '2-3 sentence explanation' },
      keyIndicators:   { type: 'array', items: { type: 'string' }, description: '3-5 specific evidence points from the health data' },
      affectedTickers: { type: 'array', items: { type: 'string' } },
    },
    required: ['regime', 'confidence', 'rationale', 'keyIndicators', 'affectedTickers'],
  },
}

function formatHealth(health: CompanyHealth[]): string {
  return health.map(h => {
    const assumptions = h.assumptions.map(a => `  - ${a.text} [${a.status}]`).join('\n')
    const chunks = h.recentChunks
      .map(c => `  [${c.publishedDate}] ${c.source}: ${c.content.slice(0, 200)}`)
      .join('\n')
    return [
      `## ${h.ticker} (${h.company}) — health: ${h.healthScore}`,
      h.thesisSummary ? `Thesis: ${h.thesisSummary}` : 'No thesis recorded.',
      assumptions ? `Assumptions:\n${assumptions}` : 'No assumptions.',
      chunks ? `Recent documents:\n${chunks}` : 'No recent documents.',
    ].join('\n')
  }).join('\n\n')
}

export async function analyzeRegime(
  health: CompanyHealth[],
  options: { client?: Anthropic } = {},
): Promise<MacroRegime> {
  const client = options.client ?? new Anthropic()
  const today  = new Date().toISOString().slice(0, 10)
  const now    = new Date().toISOString()

  const message = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 2048,
    system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
    tools: [CLASSIFY_TOOL],
    tool_choice: { type: 'tool', name: 'classify_macro_regime' },
    messages: [{
      role: 'user',
      content: `Classify the current macro regime based on these ${health.length} company health summaries:\n\n${formatHealth(health)}`,
    }],
  })

  const toolUse = message.content.find(b => b.type === 'tool_use')
  if (!toolUse || toolUse.type !== 'tool_use') {
    throw new Error('Expected tool_use response from Claude')
  }

  const input = toolUse.input as {
    regime: string; confidence: string; rationale: string
    keyIndicators: string[]; affectedTickers: string[]
  }

  return {
    id:              randomUUID(),
    date:            today,
    regime:          input.regime,
    confidence:      input.confidence as RegimeConfidence,
    rationale:       input.rationale,
    keyIndicators:   input.keyIndicators,
    affectedTickers: input.affectedTickers,
    createdAt:       now,
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run tests/regime-analyzer.test.ts
```

Expected: PASS — 2 tests.

- [ ] **Step 5: Commit**

```bash
git add src/analysis/regime-analyzer.ts tests/regime-analyzer.test.ts
git commit -m "feat: add regime-analyzer (Stage 2a — Claude classify_macro_regime)"
```

---

## Task 6: Propagation Analyzer

**Files:**
- Create: `src/analysis/propagation-analyzer.ts`
- Create: `tests/propagation-analyzer.test.ts`

- [ ] **Step 1: Write failing tests**

Create `tests/propagation-analyzer.test.ts`:
```ts
import { describe, it, expect, vi } from 'vitest'
import { analyzePropagation } from '../src/analysis/propagation-analyzer.js'
import type { MacroRegime, CompanyHealth, GraphJSON } from '../src/types.js'

const mockRegime: MacroRegime = {
  id: 'r1', date: '2026-05-23', regime: 'AI Acceleration',
  confidence: 'high', rationale: 'GPU demand strong',
  keyIndicators: ['NVDA up'], affectedTickers: ['NVDA'],
  createdAt: '2026-05-23T06:00:00.000Z',
}

const mockGraph: GraphJSON = {
  exportedAt: '2026-05-23T00:00:00.000Z',
  nodes: [
    { ticker: 'NVDA', company: 'NVIDIA', themes: ['ai-infrastructure'] },
    { ticker: 'CRWV', company: 'CoreWeave', themes: ['ai-infrastructure'] },
  ],
  edges: [
    { from: 'CRWV', to: 'NVDA', type: 'customer', strength: 'strong', description: 'CoreWeave buys NVIDIA GPUs', evidenceQuote: null },
  ],
}

const mockHealth: CompanyHealth[] = [
  { ticker: 'NVDA', company: 'NVIDIA', thesisSummary: 'Dominant GPU maker', assumptions: [], recentChunks: [], healthScore: 'positive' },
  { ticker: 'CRWV', company: 'CoreWeave', thesisSummary: 'GPU cloud provider', assumptions: [], recentChunks: [], healthScore: 'positive' },
]

describe('analyzePropagation', () => {
  it('returns PropagationSignal array from Claude tool response', async () => {
    const mockClient = {
      messages: {
        create: vi.fn().mockResolvedValue({
          content: [{
            type: 'tool_use',
            name: 'propose_propagation_signals',
            input: {
              signals: [{
                sourceTicker: 'NVDA', targetTicker: 'CRWV',
                signalType: 'customer', direction: 'downstream',
                magnitude: 'strong', sentiment: 'positive',
                description: 'CRWV benefits from NVDA GPU availability during AI Acceleration',
                evidenceQuote: null,
              }],
            },
          }],
        }),
      },
    }

    const results = await analyzePropagation(mockRegime, mockGraph, mockHealth, { client: mockClient as any })

    expect(results).toHaveLength(1)
    expect(results[0].sourceTicker).toBe('NVDA')
    expect(results[0].targetTicker).toBe('CRWV')
    expect(results[0].sentiment).toBe('positive')
    expect(results[0].id).toMatch(/^[0-9a-f-]{36}$/)
    expect(results[0].date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(results[0].evidenceQuote).toBeNull()
  })

  it('returns empty array when no signals are proposed', async () => {
    const mockClient = {
      messages: {
        create: vi.fn().mockResolvedValue({
          content: [{
            type: 'tool_use',
            name: 'propose_propagation_signals',
            input: { signals: [] },
          }],
        }),
      },
    }

    const results = await analyzePropagation(mockRegime, mockGraph, mockHealth, { client: mockClient as any })
    expect(results).toHaveLength(0)
  })

  it('throws when Claude does not return tool_use block', async () => {
    const mockClient = {
      messages: {
        create: vi.fn().mockResolvedValue({
          content: [{ type: 'text', text: 'unexpected' }],
        }),
      },
    }

    await expect(analyzePropagation(mockRegime, mockGraph, mockHealth, { client: mockClient as any }))
      .rejects.toThrow('Expected tool_use response')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run tests/propagation-analyzer.test.ts
```

Expected: FAIL — `analyzePropagation` not found.

- [ ] **Step 3: Implement src/analysis/propagation-analyzer.ts**

```ts
import Anthropic from '@anthropic-ai/sdk'
import { randomUUID } from 'crypto'
import type { CompanyHealth, MacroRegime, PropagationSignal, GraphJSON } from '../types.js'

const SYSTEM_PROMPT = `You are a technology supply chain analyst.
Identify which dependency relationships between companies are currently transmitting signals,
given the current macro regime and each company's health data.

Edge type semantics:
- supply_chain: from depends on to for manufacturing/supply
- customer: from is a paying customer of to
- technology: from's products run on or are built on to's technology
- competitive: from and to compete in overlapping markets

direction semantics:
- "downstream": signal flows from source to its customers/dependents
- "upstream": signal flows back from source to its suppliers

Use the propose_propagation_signals tool. Return an empty signals array if no active propagation is occurring.`

const PROPAGATE_TOOL: Anthropic.Tool = {
  name: 'propose_propagation_signals',
  description: 'Identify which dependency relationships are currently transmitting signals',
  input_schema: {
    type: 'object',
    properties: {
      signals: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            sourceTicker:  { type: 'string' },
            targetTicker:  { type: 'string' },
            signalType:    { type: 'string', enum: ['supply_chain', 'customer', 'technology', 'competitive'] },
            direction:     { type: 'string', enum: ['upstream', 'downstream'] },
            magnitude:     { type: 'string', enum: ['strong', 'moderate', 'weak'] },
            sentiment:     { type: 'string', enum: ['positive', 'negative', 'neutral'] },
            description:   { type: 'string' },
            evidenceQuote: { type: 'string' },
          },
          required: ['sourceTicker', 'targetTicker', 'signalType', 'direction', 'magnitude', 'sentiment', 'description'],
        },
      },
    },
    required: ['signals'],
  },
}

function formatContext(regime: MacroRegime, graph: GraphJSON, health: CompanyHealth[]): string {
  const healthMap = new Map(health.map(h => [h.ticker, h]))

  const edgeSummary = graph.edges
    .map(e => `${e.from} -[${e.type}, ${e.strength}]→ ${e.to}: ${e.description}`)
    .join('\n')

  const healthSummary = graph.nodes
    .map(n => {
      const h = healthMap.get(n.ticker)
      if (!h) return `${n.ticker}: no health data`
      return `${n.ticker} (${h.healthScore}): ${h.thesisSummary.slice(0, 200)}`
    })
    .join('\n')

  return [
    `## Current Macro Regime: ${regime.regime} (${regime.confidence} confidence)`,
    regime.rationale,
    `Key indicators: ${regime.keyIndicators.join('; ')}`,
    '',
    '## Dependency Graph Edges',
    edgeSummary,
    '',
    '## Company Health Snapshot',
    healthSummary,
  ].join('\n')
}

export async function analyzePropagation(
  regime: MacroRegime,
  graph: GraphJSON,
  health: CompanyHealth[],
  options: { client?: Anthropic } = {},
): Promise<PropagationSignal[]> {
  const client = options.client ?? new Anthropic()
  const today  = new Date().toISOString().slice(0, 10)
  const now    = new Date().toISOString()

  const message = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 4096,
    system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
    tools: [PROPAGATE_TOOL],
    tool_choice: { type: 'tool', name: 'propose_propagation_signals' },
    messages: [{
      role: 'user',
      content: formatContext(regime, graph, health),
    }],
  })

  const toolUse = message.content.find(b => b.type === 'tool_use')
  if (!toolUse || toolUse.type !== 'tool_use') {
    throw new Error('Expected tool_use response from Claude')
  }

  const input = toolUse.input as { signals: Array<Record<string, unknown>> }

  return input.signals.map(s => ({
    id:            randomUUID(),
    date:          today,
    sourceTicker:  s.sourceTicker as string,
    targetTicker:  s.targetTicker as string,
    signalType:    s.signalType as PropagationSignal['signalType'],
    direction:     s.direction as PropagationSignal['direction'],
    magnitude:     s.magnitude as PropagationSignal['magnitude'],
    sentiment:     s.sentiment as PropagationSignal['sentiment'],
    description:   s.description as string,
    evidenceQuote: (s.evidenceQuote as string | undefined) ?? null,
    createdAt:     now,
  }))
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run tests/propagation-analyzer.test.ts
```

Expected: PASS — 3 tests.

- [ ] **Step 5: Commit**

```bash
git add src/analysis/propagation-analyzer.ts tests/propagation-analyzer.test.ts
git commit -m "feat: add propagation-analyzer (Stage 2b — Claude propose_propagation_signals)"
```

---

## Task 7: Exporter

**Files:**
- Create: `src/export/exporter.ts`
- Create: `tests/exporter.test.ts`

- [ ] **Step 1: Write failing tests**

Create `tests/exporter.test.ts`:
```ts
import { describe, it, expect, vi, afterEach } from 'vitest'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { existsSync, unlinkSync } from 'fs'
import { exportAnalysis } from '../src/export/exporter.js'
import type { MacroRegime, PropagationSignal, CompanyHealth } from '../src/types.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const OUTPUT_PATH = join(__dirname, 'test-analysis.json')

const mockRegime: MacroRegime = {
  id: 'r1', date: '2026-05-23', regime: 'AI Acceleration',
  confidence: 'high', rationale: 'GPU demand strong',
  keyIndicators: ['NVDA up'], affectedTickers: ['NVDA'],
  createdAt: '2026-05-23T06:00:00.000Z',
}

const mockSignal: PropagationSignal = {
  id: 's1', date: '2026-05-23',
  sourceTicker: 'NVDA', targetTicker: 'CRWV',
  signalType: 'customer', direction: 'downstream',
  magnitude: 'strong', sentiment: 'positive',
  description: 'CRWV benefits', evidenceQuote: null,
  createdAt: '2026-05-23T06:00:00.000Z',
}

const mockHealth: CompanyHealth[] = [{
  ticker: 'NVDA', company: 'NVIDIA',
  thesisSummary: 'Dominant GPU maker',
  assumptions: [], recentChunks: [], healthScore: 'positive',
}]

afterEach(() => { if (existsSync(OUTPUT_PATH)) unlinkSync(OUTPUT_PATH) })

describe('exportAnalysis', () => {
  it('writes JSON file with correct shape', () => {
    const mockStore = {
      getLatestRegime:  vi.fn().mockReturnValue(mockRegime),
      getSignalsByDate: vi.fn().mockReturnValue([mockSignal]),
    }

    const result = exportAnalysis(mockStore as any, mockHealth, OUTPUT_PATH)

    expect(result.latestRegime.regime).toBe('AI Acceleration')
    expect(result.latestSignals).toHaveLength(1)
    expect(result.companySummaries).toHaveLength(1)
    expect(result.companySummaries[0].healthScore).toBe('positive')
    expect(result.exportedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(existsSync(OUTPUT_PATH)).toBe(true)
  })

  it('throws when no regime exists', () => {
    const mockStore = {
      getLatestRegime:  vi.fn().mockReturnValue(null),
      getSignalsByDate: vi.fn(),
    }
    expect(() => exportAnalysis(mockStore as any, mockHealth, OUTPUT_PATH))
      .toThrow('No regime found')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run tests/exporter.test.ts
```

Expected: FAIL — `exportAnalysis` not found.

- [ ] **Step 3: Implement src/export/exporter.ts**

```ts
import { writeFileSync } from 'fs'
import type { AnalysisStore } from '../store/sqlite.js'
import type { CompanyHealth, AnalysisJSON } from '../types.js'

export function exportAnalysis(
  store: AnalysisStore,
  health: CompanyHealth[],
  outputPath: string,
): AnalysisJSON {
  const latestRegime = store.getLatestRegime()
  if (!latestRegime) throw new Error('No regime found — run npm run analyze first')

  const latestSignals = store.getSignalsByDate(latestRegime.date)

  const result: AnalysisJSON = {
    exportedAt:   new Date().toISOString(),
    latestRegime,
    latestSignals,
    companySummaries: health.map(h => ({
      ticker:        h.ticker,
      company:       h.company,
      healthScore:   h.healthScore,
      thesisSummary: h.thesisSummary,
    })),
  }

  writeFileSync(outputPath, JSON.stringify(result, null, 2), 'utf-8')
  return result
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run tests/exporter.test.ts
```

Expected: PASS — 2 tests.

- [ ] **Step 5: Commit**

```bash
git add src/export/exporter.ts tests/exporter.test.ts
git commit -m "feat: add exporter (writes data/analysis.json)"
```

---

## Task 8: Reporter

**Files:**
- Create: `src/export/reporter.ts`
- Create: `tests/reporter.test.ts`

- [ ] **Step 1: Write failing tests**

Create `tests/reporter.test.ts`:
```ts
import { describe, it, expect, afterEach } from 'vitest'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { existsSync, unlinkSync } from 'fs'
import { generateReport } from '../src/export/reporter.js'
import type { MacroRegime, PropagationSignal, CompanyHealth } from '../src/types.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const OUTPUT_PATH = join(__dirname, 'test-report.md')

const regime: MacroRegime = {
  id: 'r1', date: '2026-05-23', regime: 'AI Acceleration',
  confidence: 'high', rationale: 'GPU demand strong across the board.',
  keyIndicators: ['NVDA revenue up 60%', 'CRWV expanding capacity'],
  affectedTickers: ['NVDA'], createdAt: '2026-05-23T06:00:00.000Z',
}

const signals: PropagationSignal[] = [
  {
    id: 's1', date: '2026-05-23', sourceTicker: 'NVDA', targetTicker: 'CRWV',
    signalType: 'customer', direction: 'downstream', magnitude: 'strong', sentiment: 'positive',
    description: 'CRWV benefits from GPU availability', evidenceQuote: null,
    createdAt: '2026-05-23T06:00:00.000Z',
  },
  {
    id: 's2', date: '2026-05-23', sourceTicker: 'TSM', targetTicker: 'AMD',
    signalType: 'supply_chain', direction: 'upstream', magnitude: 'moderate', sentiment: 'negative',
    description: 'AMD capacity allocation under pressure', evidenceQuote: null,
    createdAt: '2026-05-23T06:00:00.000Z',
  },
]

const health: CompanyHealth[] = [
  { ticker: 'NVDA', company: 'NVIDIA', thesisSummary: '', assumptions: [], recentChunks: [], healthScore: 'positive' },
  { ticker: 'AMD', company: 'AMD', thesisSummary: '', assumptions: [], recentChunks: [], healthScore: 'negative' },
]

afterEach(() => { if (existsSync(OUTPUT_PATH)) unlinkSync(OUTPUT_PATH) })

describe('generateReport', () => {
  it('produces Markdown with all expected sections', () => {
    const content = generateReport('2026-05-23', regime, signals, health, OUTPUT_PATH)

    expect(content).toContain('# AI Analysis — 2026-05-23')
    expect(content).toContain('## Macro Regime: AI Acceleration (high confidence)')
    expect(content).toContain('GPU demand strong across the board.')
    expect(content).toContain('- NVDA revenue up 60%')
    expect(content).toContain('## Propagation Signals (2)')
    expect(content).toContain('### Positive')
    expect(content).toContain('### Negative')
    expect(content).toContain('## Company Health Snapshot')
    expect(content).toContain('| NVDA | NVIDIA | positive |')
    expect(content).toContain('| AMD | AMD | negative |')
    expect(existsSync(OUTPUT_PATH)).toBe(true)
  })

  it('shows no-signals message and omits sentiment sections when signals empty', () => {
    const content = generateReport('2026-05-23', regime, [], health, OUTPUT_PATH)

    expect(content).toContain('## Propagation Signals (0)')
    expect(content).toContain('_No active propagation signals for this period._')
    expect(content).not.toContain('### Positive')
    expect(content).not.toContain('### Negative')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run tests/reporter.test.ts
```

Expected: FAIL — `generateReport` not found.

- [ ] **Step 3: Implement src/export/reporter.ts**

```ts
import { writeFileSync } from 'fs'
import type { MacroRegime, PropagationSignal, CompanyHealth } from '../types.js'

function signalLine(s: PropagationSignal): string {
  return `- ${s.sourceTicker} → ${s.targetTicker} (${s.signalType}, ${s.direction}, ${s.magnitude}): ${s.description}`
}

export function generateReport(
  date: string,
  regime: MacroRegime,
  signals: PropagationSignal[],
  health: CompanyHealth[],
  outputPath: string,
): string {
  const positive = signals.filter(s => s.sentiment === 'positive')
  const negative = signals.filter(s => s.sentiment === 'negative')
  const neutral  = signals.filter(s => s.sentiment === 'neutral')

  const lines: string[] = [
    `# AI Analysis — ${date}`,
    '',
    `## Macro Regime: ${regime.regime} (${regime.confidence} confidence)`,
    regime.rationale,
    '',
    '**Key Indicators:**',
    ...regime.keyIndicators.map(i => `- ${i}`),
    '',
    `## Propagation Signals (${signals.length})`,
  ]

  if (positive.length > 0) { lines.push('', '### Positive', ...positive.map(signalLine)) }
  if (negative.length > 0) { lines.push('', '### Negative', ...negative.map(signalLine)) }
  if (neutral.length  > 0) { lines.push('', '### Neutral',  ...neutral.map(signalLine))  }
  if (signals.length  === 0) { lines.push('', '_No active propagation signals for this period._') }

  lines.push(
    '',
    '## Company Health Snapshot',
    '| Ticker | Company | Health |',
    '|--------|---------|--------|',
    ...health.map(h => `| ${h.ticker} | ${h.company} | ${h.healthScore} |`),
  )

  const content = lines.join('\n')
  writeFileSync(outputPath, content, 'utf-8')
  return content
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run tests/reporter.test.ts
```

Expected: PASS — 2 tests.

- [ ] **Step 5: Commit**

```bash
git add src/export/reporter.ts tests/reporter.test.ts
git commit -m "feat: add reporter (writes data/reports/YYYY-MM-DD.md)"
```

---

## Task 9: CLI Files

**Files:**
- Create: `src/cli/cli-run.ts`
- Create: `src/cli/cli-schedule.ts`
- Create: `src/cli/cli-report.ts`

No tests for CLI files — they are thin orchestration wrappers over already-tested modules.

- [ ] **Step 1: Create src/cli/cli-run.ts**

```ts
import 'dotenv/config'
import { join } from 'path'
import { mkdirSync, readFileSync } from 'fs'
import { randomUUID } from 'crypto'
import { createAnalysisStore } from '../store/sqlite.js'
import { collectHealth } from '../collector/health-collector.js'
import { analyzeRegime } from '../analysis/regime-analyzer.js'
import { analyzePropagation } from '../analysis/propagation-analyzer.js'
import { exportAnalysis } from '../export/exporter.js'
import { generateReport } from '../export/reporter.js'
import type { GraphJSON } from '../types.js'

const DATA_DIR    = join(process.cwd(), 'data')
const REPORTS_DIR = join(DATA_DIR, 'reports')
const GRAPH_PATH  = join(process.cwd(), '../dependency-graph-engine/data/graph.json')

async function run() {
  const startTime = Date.now()

  mkdirSync(DATA_DIR,    { recursive: true })
  mkdirSync(REPORTS_DIR, { recursive: true })

  const graph: GraphJSON = JSON.parse(readFileSync(GRAPH_PATH, 'utf-8'))
  const store = createAnalysisStore(join(DATA_DIR, 'analysis.db'))
  const today = new Date().toISOString().slice(0, 10)

  console.log(`[${new Date().toISOString()}] Stage 1: collecting health for ${graph.nodes.length} companies...`)
  const health = await collectHealth(graph.nodes)
  const pos = health.filter(h => h.healthScore === 'positive').length
  const neg = health.filter(h => h.healthScore === 'negative').length
  console.log(`  positive=${pos}  neutral=${health.length - pos - neg}  negative=${neg}`)

  console.log(`[${new Date().toISOString()}] Stage 2a: classifying macro regime...`)
  const regime = await analyzeRegime(health)
  store.insertRegime(regime)
  console.log(`  Regime: ${regime.regime} (${regime.confidence})`)

  console.log(`[${new Date().toISOString()}] Stage 2b: analyzing propagation signals...`)
  const signals = await analyzePropagation(regime, graph, health)
  for (const s of signals) store.insertSignal(s)
  console.log(`  ${signals.length} propagation signal(s)`)

  exportAnalysis(store, health, join(DATA_DIR, 'analysis.json'))

  const reportPath = join(REPORTS_DIR, `${today}.md`)
  generateReport(today, regime, signals, health, reportPath)

  store.insertRun({
    id: randomUUID(), date: today,
    companiesAnalyzed: health.length,
    regimeId: regime.id,
    propagationSignalCount: signals.length,
    durationMs: Date.now() - startTime,
    createdAt: new Date().toISOString(),
  })

  store.close()
  console.log(`\nDone in ${((Date.now() - startTime) / 1000).toFixed(1)}s`)
  console.log(`Report: ${reportPath}`)
}

run().catch(err => { console.error(err); process.exit(1) })
```

- [ ] **Step 2: Create src/cli/cli-schedule.ts**

```ts
import 'dotenv/config'
import cron from 'node-cron'
import { join } from 'path'
import { mkdirSync, readFileSync } from 'fs'
import { randomUUID } from 'crypto'
import { createAnalysisStore } from '../store/sqlite.js'
import { collectHealth } from '../collector/health-collector.js'
import { analyzeRegime } from '../analysis/regime-analyzer.js'
import { analyzePropagation } from '../analysis/propagation-analyzer.js'
import { exportAnalysis } from '../export/exporter.js'
import { generateReport } from '../export/reporter.js'
import type { GraphJSON } from '../types.js'

const DATA_DIR    = join(process.cwd(), 'data')
const REPORTS_DIR = join(DATA_DIR, 'reports')
const GRAPH_PATH  = join(process.cwd(), '../dependency-graph-engine/data/graph.json')

async function runAnalysis() {
  const startTime = Date.now()
  const graph: GraphJSON = JSON.parse(readFileSync(GRAPH_PATH, 'utf-8'))
  const store = createAnalysisStore(join(DATA_DIR, 'analysis.db'))
  const today = new Date().toISOString().slice(0, 10)

  const health  = await collectHealth(graph.nodes)
  const regime  = await analyzeRegime(health)
  store.insertRegime(regime)
  const signals = await analyzePropagation(regime, graph, health)
  for (const s of signals) store.insertSignal(s)
  exportAnalysis(store, health, join(DATA_DIR, 'analysis.json'))
  generateReport(today, regime, signals, health, join(REPORTS_DIR, `${today}.md`))
  store.insertRun({
    id: randomUUID(), date: today,
    companiesAnalyzed: health.length,
    regimeId: regime.id,
    propagationSignalCount: signals.length,
    durationMs: Date.now() - startTime,
    createdAt: new Date().toISOString(),
  })
  store.close()
  console.log(`[${new Date().toISOString()}] Analysis complete: ${regime.regime} (${regime.confidence}), ${signals.length} signals`)
}

mkdirSync(DATA_DIR,    { recursive: true })
mkdirSync(REPORTS_DIR, { recursive: true })

console.log('AI Analysis Engine scheduler started. Running daily at 06:00.')
cron.schedule('0 6 * * *', () => {
  runAnalysis().catch(err => console.error('Analysis failed:', err))
})
```

- [ ] **Step 3: Create src/cli/cli-report.ts**

```ts
import 'dotenv/config'
import { join } from 'path'
import { readdirSync, readFileSync, existsSync } from 'fs'

const REPORTS_DIR = join(process.cwd(), 'data', 'reports')

if (!existsSync(REPORTS_DIR)) {
  console.log('No reports found. Run npm run analyze first.')
  process.exit(0)
}

const files = readdirSync(REPORTS_DIR).filter(f => f.endsWith('.md')).sort()

if (files.length === 0) {
  console.log('No reports found. Run npm run analyze first.')
  process.exit(0)
}

const latest = files[files.length - 1]
console.log(readFileSync(join(REPORTS_DIR, latest), 'utf-8'))
```

- [ ] **Step 4: Run full test suite**

```bash
npx vitest run
```

Expected: PASS — all tests across all test files.

- [ ] **Step 5: Commit**

```bash
git add src/cli/
git commit -m "feat: add CLI entry points (analyze, schedule, report)"
```

---

## Task 10: Integration Smoke Test

No new files. Verify the full pipeline runs end-to-end against real data.

Prerequisites:
- `../dependency-graph-engine/data/graph.json` must exist (run `npm run export` in that project first)
- `ANTHROPIC_API_KEY` set in `.env`

- [ ] **Step 1: Ensure graph.json exists**

```bash
ls ../dependency-graph-engine/data/graph.json
```

If missing, run in the dependency-graph-engine project:
```bash
cd ../dependency-graph-engine && npm run export && cd ../ai-analysis-engine
```

- [ ] **Step 2: Run the analyzer**

```bash
npm run analyze
```

Expected output (approx):
```
[2026-05-23T06:00:00.000Z] Stage 1: collecting health for 34 companies...
  positive=N  neutral=N  negative=N
[2026-05-23T06:00:00.000Z] Stage 2a: classifying macro regime...
  Regime: AI Acceleration (high)
[2026-05-23T06:00:00.000Z] Stage 2b: analyzing propagation signals...
  N propagation signal(s)

Done in N.Ns
Report: .../data/reports/2026-05-23.md
```

- [ ] **Step 3: Verify outputs**

```bash
ls data/
# Expected: analysis.db  analysis.json  reports/

ls data/reports/
# Expected: 2026-05-23.md

npm run report
# Expected: full Markdown report printed to stdout
```

- [ ] **Step 4: Verify analysis.json shape**

```bash
node -e "const j = JSON.parse(require('fs').readFileSync('data/analysis.json','utf-8')); console.log('regime:', j.latestRegime.regime, '| signals:', j.latestSignals.length, '| companies:', j.companySummaries.length)"
```

Expected: regime name printed, signals count ≥ 0, companies = 34.

- [ ] **Step 5: Final commit**

```bash
git add -A
git commit -m "feat: ai-analysis-engine — daily macro regime + propagation signal analysis"
```

---

## Self-Review Checklist

- [x] **Spec coverage:** All spec sections covered — Stage 1 (Task 4), Stage 2a (Task 5), Stage 2b (Task 6), export (Task 7), reporter (Task 8), CLI (Task 9), scheduling (Task 9 cli-schedule.ts)
- [x] **No placeholders:** All steps have complete code
- [x] **Type consistency:** `ThesisAssumptionStatus` uses `'stable'` (matching actual thesis-memory schema) throughout Tasks 2, 4; `AnalysisStore` interface defined in Task 3 and used in Tasks 7, 9; `GraphJSON` defined in Task 2 and used in Tasks 6, 9
- [x] **Method name consistency:** `collectHealth`, `analyzeRegime`, `analyzePropagation`, `exportAnalysis`, `generateReport` — consistent across definition and usage in Tasks 9
- [x] **LanceDB field:** Uses `publishedDate` (not `publishedAt`) — matches actual ingestion chunk schema
