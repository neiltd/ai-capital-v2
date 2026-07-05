# Scenario Simulator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a TypeScript project that uses Claude to generate best/base/disruption scenarios from the current macro analysis, produce position-aware portfolio actions, and support on-demand "what if" queries.

**Architecture:** Two-stage Claude pipeline (scenario generation → portfolio actions), portfolio positions in `portfolio.db`, simulation history in `simulation.db`, exports to JSON + Markdown. Reads `analysis.json` and `graph.json` from sibling projects read-only.

**Tech Stack:** TypeScript ESM + tsx, better-sqlite3, @anthropic-ai/sdk (Claude Sonnet 4.6 with prompt caching + tool_choice), node-cron, dotenv, vitest. Native `fetch` for price API.

---

## File Map

```
scenario-simulator/
  src/
    types.ts
    portfolio/
      portfolio-store.ts       — portfolio.db CRUD
      price-fetcher.ts         — financialdata.net /stock-prices
    simulation/
      scenario-generator.ts    — Stage 1: generate_scenarios tool
      action-generator.ts      — Stage 2: generate_portfolio_actions tool
    store/
      sqlite.ts                — simulation.db schema + CRUD
    export/
      exporter.ts              — writes data/simulation.json
      reporter.ts              — writes data/reports/YYYY-MM-DD.md
    cli/
      cli-run.ts               — npm run simulate
      cli-whatif.ts            — npm run whatif
      cli-portfolio.ts         — npm run portfolio
      cli-report.ts            — npm run report
      cli-schedule.ts          — npm run schedule
  tests/
    portfolio-store.test.ts
    price-fetcher.test.ts
    simulation-store.test.ts
    scenario-generator.test.ts
    action-generator.test.ts
    reporter.test.ts
  data/                        — gitignored
  package.json
  tsconfig.json
  vitest.config.ts
  .gitignore
  .env
```

---

### Task 1: Project Scaffold

**Files:**
- Create: `scenario-simulator/package.json`
- Create: `scenario-simulator/tsconfig.json`
- Create: `scenario-simulator/vitest.config.ts`
- Create: `scenario-simulator/.gitignore`
- Create: `scenario-simulator/.env`

- [ ] **Step 1: Create the project directory and scaffold files**

Run from `/Users/thanapold/Desktop/Projects/`:
```bash
mkdir -p scenario-simulator/src/portfolio scenario-simulator/src/simulation scenario-simulator/src/store scenario-simulator/src/export scenario-simulator/src/cli scenario-simulator/tests scenario-simulator/data
```

Create `scenario-simulator/package.json`:
```json
{
  "name": "scenario-simulator",
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "simulate":  "tsx src/cli/cli-run.ts",
    "whatif":    "tsx src/cli/cli-whatif.ts",
    "portfolio": "tsx src/cli/cli-portfolio.ts",
    "report":    "tsx src/cli/cli-report.ts",
    "schedule":  "tsx src/cli/cli-schedule.ts",
    "test":      "vitest run",
    "test:watch": "vitest"
  },
  "dependencies": {
    "@anthropic-ai/sdk": "^0.39.0",
    "better-sqlite3":    "^12.0.0",
    "dotenv":            "^16.0.0",
    "node-cron":         "^3.0.0"
  },
  "devDependencies": {
    "@types/better-sqlite3": "^7.6.0",
    "@types/node":           "^22.0.0",
    "@types/node-cron":      "^3.0.0",
    "tsx":                   "^4.0.0",
    "typescript":            "^5.0.0",
    "vitest":                "^3.0.0"
  }
}
```

Create `scenario-simulator/tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src", "tests"]
}
```

Create `scenario-simulator/vitest.config.ts`:
```ts
import { defineConfig } from 'vitest/config'
export default defineConfig({ test: { globals: true } })
```

Create `scenario-simulator/.gitignore`:
```
node_modules/
dist/
data/
.env
```

Create `scenario-simulator/.env`:
```
ANTHROPIC_API_KEY=your_key_here
FINANCIALDATA_API_KEY=REDACTED
```

- [ ] **Step 2: Install dependencies**

```bash
cd scenario-simulator && npm install
```

Expected: `node_modules/` created, no errors.

- [ ] **Step 3: Commit**

```bash
git add scenario-simulator/package.json scenario-simulator/tsconfig.json scenario-simulator/vitest.config.ts scenario-simulator/.gitignore
git commit -m "chore: scaffold scenario-simulator project"
```

---

### Task 2: Types

**Files:**
- Create: `scenario-simulator/src/types.ts`

- [ ] **Step 1: Write `src/types.ts`**

```ts
export interface Position {
  ticker:        string
  company:       string
  shares:        number
  avgCost:       number
  currentPrice:  number
  currentValue:  number
  unrealizedPnl: number
  updatedAt:     string
}

export interface Scenario {
  id:               string
  runId:            string
  date:             string
  scenarioType:     'best' | 'base' | 'disruption' | 'whatif'
  title:            string
  narrative:        string
  timeHorizon:      string
  probability:      number
  regimeTransition: string | null
  triggers:         string[]
  createdAt:        string
}

export interface PortfolioAction {
  id:                  string
  runId:               string
  scenarioId:          string
  ticker:              string
  action:              'buy' | 'hold' | 'trim' | 'exit'
  conviction:          'high' | 'medium' | 'low'
  allocationChangePct: number
  rationale:           string
  createdAt:           string
}

export interface SimulationRun {
  id:            string
  date:          string
  type:          'daily' | 'whatif'
  trigger:       string | null
  scenarioCount: number
  actionCount:   number
  durationMs:    number
  createdAt:     string
}

export interface AnalysisJSON {
  exportedAt: string
  latestRegime: {
    id:              string
    date:            string
    regime:          string
    confidence:      string
    rationale:       string
    keyIndicators:   string[]
    affectedTickers: string[]
    createdAt:       string
  }
  latestSignals: Array<{
    id:            string
    date:          string
    sourceTicker:  string
    targetTicker:  string
    signalType:    string
    direction:     string
    magnitude:     string
    sentiment:     string
    description:   string
    evidenceQuote: string | null
    createdAt:     string
  }>
  companySummaries: Array<{
    ticker:        string
    company:       string
    healthScore:   string
    thesisSummary: string
  }>
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

export interface SimulationJSON {
  exportedAt: string
  portfolio:  Position[]
  scenarios:  Scenario[]
  actions:    PortfolioAction[]
}
```

- [ ] **Step 2: Commit**

```bash
git add scenario-simulator/src/types.ts
git commit -m "feat: add shared types for scenario-simulator"
```

---

### Task 3: Portfolio Store

**Files:**
- Create: `scenario-simulator/src/portfolio/portfolio-store.ts`
- Test: `scenario-simulator/tests/portfolio-store.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `scenario-simulator/tests/portfolio-store.test.ts`:
```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, rmSync } from 'fs'
import { join } from 'path'
import { createPortfolioStore } from '../src/portfolio/portfolio-store.js'

const TEST_DIR = 'tests/tmp-portfolio'
const DB_PATH  = join(TEST_DIR, 'portfolio-test.db')

beforeEach(() => { mkdirSync(TEST_DIR, { recursive: true }) })
afterEach(() => { try { rmSync(TEST_DIR, { recursive: true }) } catch {} })

describe('PortfolioStore', () => {
  it('upserts a position and reads it back', () => {
    const store = createPortfolioStore(DB_PATH)
    store.upsertPosition('NVDA', 'NVIDIA Corporation', 100, 68.50)
    const positions = store.getPositions()
    store.close()

    expect(positions).toHaveLength(1)
    expect(positions[0].ticker).toBe('NVDA')
    expect(positions[0].shares).toBe(100)
    expect(positions[0].avgCost).toBe(68.50)
    expect(positions[0].currentPrice).toBe(0)
  })

  it('overwrites an existing position on upsert', () => {
    const store = createPortfolioStore(DB_PATH)
    store.upsertPosition('NVDA', 'NVIDIA', 100, 68.50)
    store.upsertPosition('NVDA', 'NVIDIA Corporation', 200, 75.00)
    const positions = store.getPositions()
    store.close()

    expect(positions).toHaveLength(1)
    expect(positions[0].shares).toBe(200)
    expect(positions[0].avgCost).toBe(75.00)
  })

  it('updates prices and computes currentValue and unrealizedPnl', () => {
    const store = createPortfolioStore(DB_PATH)
    store.upsertPosition('NVDA', 'NVIDIA', 100, 68.50)
    store.updatePrices({ NVDA: 92.00 })
    const positions = store.getPositions()
    store.close()

    expect(positions[0].currentPrice).toBe(92.00)
    expect(positions[0].currentValue).toBeCloseTo(9200.00)
    expect(positions[0].unrealizedPnl).toBeCloseTo(2350.00) // (92 - 68.5) * 100
  })

  it('ignores updatePrices for unknown tickers', () => {
    const store = createPortfolioStore(DB_PATH)
    store.upsertPosition('NVDA', 'NVIDIA', 100, 68.50)
    store.updatePrices({ MSFT: 400.00 })
    const positions = store.getPositions()
    store.close()

    expect(positions[0].currentPrice).toBe(0)
  })
})
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
cd scenario-simulator && npm test -- tests/portfolio-store.test.ts
```

Expected: FAIL — `Cannot find module '../src/portfolio/portfolio-store.js'`

- [ ] **Step 3: Write `src/portfolio/portfolio-store.ts`**

```ts
import Database from 'better-sqlite3'
import type { Position } from '../types.js'

export interface PortfolioStore {
  upsertPosition(ticker: string, company: string, shares: number, avgCost: number): void
  updatePrices(prices: Record<string, number>): void
  getPositions(): Position[]
  close(): void
}

export function createPortfolioStore(dbPath: string): PortfolioStore {
  const db = new Database(dbPath)
  db.pragma('journal_mode = WAL')

  db.exec(`
    CREATE TABLE IF NOT EXISTS positions (
      ticker         TEXT PRIMARY KEY,
      company        TEXT NOT NULL,
      shares         REAL NOT NULL,
      avg_cost       REAL NOT NULL,
      current_price  REAL NOT NULL DEFAULT 0,
      current_value  REAL NOT NULL DEFAULT 0,
      unrealized_pnl REAL NOT NULL DEFAULT 0,
      updated_at     TEXT NOT NULL
    )
  `)

  const upsertStmt = db.prepare(`
    INSERT INTO positions (ticker, company, shares, avg_cost, current_price, current_value, unrealized_pnl, updated_at)
    VALUES (?, ?, ?, ?, 0, 0, 0, ?)
    ON CONFLICT(ticker) DO UPDATE SET
      company    = excluded.company,
      shares     = excluded.shares,
      avg_cost   = excluded.avg_cost,
      updated_at = excluded.updated_at
  `)

  const priceStmt = db.prepare(`
    UPDATE positions SET
      current_price  = ?,
      current_value  = shares * ?,
      unrealized_pnl = (shares * ?) - (shares * avg_cost),
      updated_at     = ?
    WHERE ticker = ?
  `)

  return {
    upsertPosition(ticker, company, shares, avgCost) {
      upsertStmt.run(ticker, company, shares, avgCost, new Date().toISOString())
    },

    updatePrices(prices) {
      const now = new Date().toISOString()
      for (const [ticker, price] of Object.entries(prices)) {
        priceStmt.run(price, price, price, now, ticker)
      }
    },

    getPositions() {
      type Row = {
        ticker: string; company: string; shares: number; avg_cost: number
        current_price: number; current_value: number; unrealized_pnl: number; updated_at: string
      }
      return (db.prepare('SELECT * FROM positions ORDER BY ticker').all() as Row[]).map(r => ({
        ticker:        r.ticker,
        company:       r.company,
        shares:        r.shares,
        avgCost:       r.avg_cost,
        currentPrice:  r.current_price,
        currentValue:  r.current_value,
        unrealizedPnl: r.unrealized_pnl,
        updatedAt:     r.updated_at,
      }))
    },

    close() { db.close() },
  }
}
```

- [ ] **Step 4: Run tests to confirm they pass**

```bash
npm test -- tests/portfolio-store.test.ts
```

Expected: 4 passed.

- [ ] **Step 5: Commit**

```bash
git add scenario-simulator/src/portfolio/portfolio-store.ts scenario-simulator/tests/portfolio-store.test.ts
git commit -m "feat: add portfolio-store (position CRUD with price/P&L update)"
```

---

### Task 4: Price Fetcher

**Files:**
- Create: `scenario-simulator/src/portfolio/price-fetcher.ts`
- Test: `scenario-simulator/tests/price-fetcher.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `scenario-simulator/tests/price-fetcher.test.ts`:
```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fetchPrices } from '../src/portfolio/price-fetcher.js'

beforeEach(() => { vi.resetAllMocks() })

describe('fetchPrices', () => {
  it('returns a price map from a successful API response', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok:   true,
      json: async () => ({ data: [{ ticker: 'NVDA', price: 92.00 }, { ticker: 'MSFT', price: 415.00 }] }),
    } as any)

    const prices = await fetchPrices(['NVDA', 'MSFT'])

    expect(prices).toEqual({ NVDA: 92.00, MSFT: 415.00 })
  })

  it('returns an empty object on HTTP error', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 429 } as any)

    const prices = await fetchPrices(['NVDA'])

    expect(prices).toEqual({})
  })

  it('returns an empty object on network failure', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('network failure'))

    const prices = await fetchPrices(['NVDA'])

    expect(prices).toEqual({})
  })

  it('returns an empty object without calling fetch when given empty tickers', async () => {
    global.fetch = vi.fn()

    const prices = await fetchPrices([])

    expect(prices).toEqual({})
    expect(global.fetch).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
npm test -- tests/price-fetcher.test.ts
```

Expected: FAIL — `Cannot find module '../src/portfolio/price-fetcher.js'`

- [ ] **Step 3: Write `src/portfolio/price-fetcher.ts`**

```ts
const BASE_URL = 'https://financialdata.net/api/v1/stock-prices'

export async function fetchPrices(tickers: string[]): Promise<Record<string, number>> {
  if (tickers.length === 0) return {}

  const key         = process.env.FINANCIALDATA_API_KEY ?? ''
  const identifiers = tickers.join(',')
  const url         = `${BASE_URL}?identifier=${encodeURIComponent(identifiers)}&key=${key}`

  try {
    const res = await fetch(url)
    if (!res.ok) {
      console.warn(`Price fetch failed: HTTP ${res.status}`)
      return {}
    }
    const data = await res.json() as any
    const items: any[] = Array.isArray(data) ? data : (data.data ?? [])
    const result: Record<string, number> = {}
    for (const item of items) {
      if (item.ticker && typeof item.price === 'number') {
        result[item.ticker] = item.price
      }
    }
    return result
  } catch (error) {
    console.warn('Price fetch error:', error)
    return {}
  }
}
```

- [ ] **Step 4: Run tests to confirm they pass**

```bash
npm test -- tests/price-fetcher.test.ts
```

Expected: 4 passed.

- [ ] **Step 5: Commit**

```bash
git add scenario-simulator/src/portfolio/price-fetcher.ts scenario-simulator/tests/price-fetcher.test.ts
git commit -m "feat: add price-fetcher (financialdata.net stock-prices, graceful degradation)"
```

---

### Task 5: Simulation SQLite Store

**Files:**
- Create: `scenario-simulator/src/store/sqlite.ts`
- Test: `scenario-simulator/tests/simulation-store.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `scenario-simulator/tests/simulation-store.test.ts`:
```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, rmSync } from 'fs'
import { join } from 'path'
import { createSimulationStore } from '../src/store/sqlite.js'
import type { SimulationRun, Scenario, PortfolioAction } from '../src/types.js'

const TEST_DIR = 'tests/tmp-sim'
const DB_PATH  = join(TEST_DIR, 'simulation-test.db')

beforeEach(() => { mkdirSync(TEST_DIR, { recursive: true }) })
afterEach(() => { try { rmSync(TEST_DIR, { recursive: true }) } catch {} })

const run: SimulationRun = {
  id: 'run-1', date: '2026-05-23', type: 'daily', trigger: null,
  scenarioCount: 3, actionCount: 6, durationMs: 12000, createdAt: '2026-05-23T10:00:00Z',
}

const scenario: Scenario = {
  id: 's1', runId: 'run-1', date: '2026-05-23', scenarioType: 'best',
  title: 'AI Boom', narrative: 'Strong demand continues.', timeHorizon: '3-6 months',
  probability: 65, regimeTransition: null, triggers: ['NVDA beats guidance'],
  createdAt: '2026-05-23T10:00:00Z',
}

const action: PortfolioAction = {
  id: 'a1', runId: 'run-1', scenarioId: 's1', ticker: 'NVDA',
  action: 'buy', conviction: 'high', allocationChangePct: 15,
  rationale: 'AI demand accelerating.', createdAt: '2026-05-23T10:00:00Z',
}

describe('SimulationStore', () => {
  it('inserts and retrieves a run with getLatestRun', () => {
    const store = createSimulationStore(DB_PATH)
    store.insertRun(run)
    const latest = store.getLatestRun()
    store.close()

    expect(latest).not.toBeNull()
    expect(latest!.id).toBe('run-1')
    expect(latest!.type).toBe('daily')
    expect(latest!.trigger).toBeNull()
  })

  it('inserts and retrieves a scenario with triggers round-tripped as string[]', () => {
    const store = createSimulationStore(DB_PATH)
    store.insertRun(run)
    store.insertScenario(scenario)
    const scenarios = store.getScenariosByRunId('run-1')
    store.close()

    expect(scenarios).toHaveLength(1)
    expect(scenarios[0].scenarioType).toBe('best')
    expect(scenarios[0].triggers).toEqual(['NVDA beats guidance'])
    expect(scenarios[0].regimeTransition).toBeNull()
  })

  it('inserts and retrieves a portfolio action', () => {
    const store = createSimulationStore(DB_PATH)
    store.insertRun(run)
    store.insertScenario(scenario)
    store.insertAction(action)
    const actions = store.getActionsByRunId('run-1')
    store.close()

    expect(actions).toHaveLength(1)
    expect(actions[0].allocationChangePct).toBe(15)
    expect(actions[0].action).toBe('buy')
    expect(actions[0].scenarioId).toBe('s1')
  })

  it('getLatestRun returns null when no runs exist', () => {
    const store = createSimulationStore(DB_PATH)
    const latest = store.getLatestRun()
    store.close()

    expect(latest).toBeNull()
  })
})
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
npm test -- tests/simulation-store.test.ts
```

Expected: FAIL — `Cannot find module '../src/store/sqlite.js'`

- [ ] **Step 3: Write `src/store/sqlite.ts`**

```ts
import Database from 'better-sqlite3'
import type { SimulationRun, Scenario, PortfolioAction } from '../types.js'

export interface SimulationStore {
  insertRun(run: SimulationRun): void
  insertScenario(scenario: Scenario): void
  insertAction(action: PortfolioAction): void
  getLatestRun(): SimulationRun | null
  getScenariosByRunId(runId: string): Scenario[]
  getActionsByRunId(runId: string): PortfolioAction[]
  close(): void
}

export function createSimulationStore(dbPath: string): SimulationStore {
  const db = new Database(dbPath)
  db.pragma('journal_mode = WAL')

  db.exec(`
    CREATE TABLE IF NOT EXISTS simulation_runs (
      id             TEXT PRIMARY KEY,
      date           TEXT NOT NULL,
      type           TEXT NOT NULL,
      trigger        TEXT,
      scenario_count INTEGER NOT NULL,
      action_count   INTEGER NOT NULL,
      duration_ms    INTEGER NOT NULL,
      created_at     TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS scenarios (
      id                TEXT PRIMARY KEY,
      run_id            TEXT NOT NULL,
      date              TEXT NOT NULL,
      scenario_type     TEXT NOT NULL,
      title             TEXT NOT NULL,
      narrative         TEXT NOT NULL,
      time_horizon      TEXT NOT NULL,
      probability       INTEGER NOT NULL,
      regime_transition TEXT,
      triggers          TEXT NOT NULL,
      created_at        TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS portfolio_actions (
      id                     TEXT PRIMARY KEY,
      run_id                 TEXT NOT NULL,
      scenario_id            TEXT NOT NULL,
      ticker                 TEXT NOT NULL,
      action                 TEXT NOT NULL,
      conviction             TEXT NOT NULL,
      allocation_change_pct  INTEGER NOT NULL,
      rationale              TEXT NOT NULL,
      created_at             TEXT NOT NULL
    );
  `)

  return {
    insertRun(run) {
      db.prepare(`
        INSERT INTO simulation_runs (id, date, type, trigger, scenario_count, action_count, duration_ms, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(run.id, run.date, run.type, run.trigger, run.scenarioCount, run.actionCount, run.durationMs, run.createdAt)
    },

    insertScenario(s) {
      db.prepare(`
        INSERT INTO scenarios (id, run_id, date, scenario_type, title, narrative, time_horizon, probability, regime_transition, triggers, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(s.id, s.runId, s.date, s.scenarioType, s.title, s.narrative, s.timeHorizon, s.probability, s.regimeTransition, JSON.stringify(s.triggers), s.createdAt)
    },

    insertAction(a) {
      db.prepare(`
        INSERT INTO portfolio_actions (id, run_id, scenario_id, ticker, action, conviction, allocation_change_pct, rationale, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(a.id, a.runId, a.scenarioId, a.ticker, a.action, a.conviction, a.allocationChangePct, a.rationale, a.createdAt)
    },

    getLatestRun() {
      type Row = { id: string; date: string; type: string; trigger: string | null; scenario_count: number; action_count: number; duration_ms: number; created_at: string }
      const row = db.prepare('SELECT * FROM simulation_runs ORDER BY created_at DESC LIMIT 1').get() as Row | undefined
      if (!row) return null
      return {
        id: row.id, date: row.date, type: row.type as SimulationRun['type'],
        trigger: row.trigger, scenarioCount: row.scenario_count,
        actionCount: row.action_count, durationMs: row.duration_ms, createdAt: row.created_at,
      }
    },

    getScenariosByRunId(runId) {
      type Row = { id: string; run_id: string; date: string; scenario_type: string; title: string; narrative: string; time_horizon: string; probability: number; regime_transition: string | null; triggers: string; created_at: string }
      return (db.prepare('SELECT * FROM scenarios WHERE run_id = ?').all(runId) as Row[]).map(r => ({
        id: r.id, runId: r.run_id, date: r.date,
        scenarioType: r.scenario_type as Scenario['scenarioType'],
        title: r.title, narrative: r.narrative, timeHorizon: r.time_horizon,
        probability: r.probability, regimeTransition: r.regime_transition,
        triggers: JSON.parse(r.triggers) as string[],
        createdAt: r.created_at,
      }))
    },

    getActionsByRunId(runId) {
      type Row = { id: string; run_id: string; scenario_id: string; ticker: string; action: string; conviction: string; allocation_change_pct: number; rationale: string; created_at: string }
      return (db.prepare('SELECT * FROM portfolio_actions WHERE run_id = ?').all(runId) as Row[]).map(r => ({
        id: r.id, runId: r.run_id, scenarioId: r.scenario_id, ticker: r.ticker,
        action: r.action as PortfolioAction['action'],
        conviction: r.conviction as PortfolioAction['conviction'],
        allocationChangePct: r.allocation_change_pct,
        rationale: r.rationale, createdAt: r.created_at,
      }))
    },

    close() { db.close() },
  }
}
```

- [ ] **Step 4: Run tests to confirm they pass**

```bash
npm test -- tests/simulation-store.test.ts
```

Expected: 4 passed.

- [ ] **Step 5: Commit**

```bash
git add scenario-simulator/src/store/sqlite.ts scenario-simulator/tests/simulation-store.test.ts
git commit -m "feat: add SimulationStore with SQLite persistence"
```

---

### Task 6: Scenario Generator

**Files:**
- Create: `scenario-simulator/src/simulation/scenario-generator.ts`
- Test: `scenario-simulator/tests/scenario-generator.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `scenario-simulator/tests/scenario-generator.test.ts`:
```ts
import { describe, it, expect, vi } from 'vitest'
import Anthropic from '@anthropic-ai/sdk'
import { generateScenarios } from '../src/simulation/scenario-generator.js'
import type { AnalysisJSON, GraphJSON } from '../src/types.js'

const mockAnalysis: AnalysisJSON = {
  exportedAt: '2026-05-23T10:00:00.000Z',
  latestRegime: {
    id: 'r1', date: '2026-05-23', regime: 'AI Acceleration', confidence: 'high',
    rationale: 'GPU demand strong across hyperscalers.',
    keyIndicators: ['NVDA revenue up 80% YoY'],
    affectedTickers: ['NVDA', 'AMD'],
    createdAt: '2026-05-23T10:00:00.000Z',
  },
  latestSignals: [],
  companySummaries: [
    { ticker: 'NVDA', company: 'NVIDIA', healthScore: 'positive', thesisSummary: 'AI infrastructure leader.' },
  ],
}

const mockGraph: GraphJSON = {
  exportedAt: '2026-05-23T10:00:00.000Z',
  nodes: [{ ticker: 'NVDA', company: 'NVIDIA', themes: ['ai-infrastructure'] }],
  edges: [],
}

const threeScenarios = [
  { scenarioType: 'best', title: 'AI Boom', narrative: 'Strong demand.', timeHorizon: '3-6 months', probability: 65, regimeTransition: null, triggers: ['NVDA beats guidance'] },
  { scenarioType: 'base', title: 'Steady State', narrative: 'Moderate growth.', timeHorizon: '6-12 months', probability: 55, regimeTransition: null, triggers: ['Macro stable'] },
  { scenarioType: 'disruption', title: 'Supply Shock', narrative: 'TSM cuts.', timeHorizon: '3-6 months', probability: 20, regimeTransition: 'Semiconductor Correction', triggers: ['TSM cuts 2nm'] },
]

function makeMockClient(scenarios: typeof threeScenarios): Anthropic {
  return {
    messages: {
      create: vi.fn().mockResolvedValue({
        content: [{ type: 'tool_use', input: { scenarios } }],
      }),
    },
  } as unknown as Anthropic
}

describe('generateScenarios', () => {
  it('returns 3 scenarios for a daily run', async () => {
    const scenarios = await generateScenarios(mockAnalysis, mockGraph, {
      runId: 'run-1', client: makeMockClient(threeScenarios),
    })

    expect(scenarios).toHaveLength(3)
    expect(scenarios[0].scenarioType).toBe('best')
    expect(scenarios[1].scenarioType).toBe('base')
    expect(scenarios[2].scenarioType).toBe('disruption')
    expect(scenarios[0].runId).toBe('run-1')
    expect(scenarios[2].regimeTransition).toBe('Semiconductor Correction')
    expect(scenarios[0].id).toBeTruthy()
  })

  it('returns 1 whatif scenario when trigger is provided', async () => {
    const whatif = [{ scenarioType: 'whatif', title: 'TSMC Shock', narrative: 'Downstream shortages.', timeHorizon: '3-6 months', probability: 40, regimeTransition: 'Semiconductor Correction', triggers: ['TSMC cuts 30%'] }]
    const scenarios = await generateScenarios(mockAnalysis, mockGraph, {
      trigger: 'TSMC cuts 2nm capacity by 30%', runId: 'run-2', client: makeMockClient(whatif),
    })

    expect(scenarios).toHaveLength(1)
    expect(scenarios[0].scenarioType).toBe('whatif')
  })

  it('throws when Claude does not return tool_use', async () => {
    const badClient = {
      messages: { create: vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'oops' }] }) },
    } as unknown as Anthropic

    await expect(
      generateScenarios(mockAnalysis, mockGraph, { runId: 'run-3', client: badClient })
    ).rejects.toThrow('Expected tool_use response from Claude')
  })
})
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
npm test -- tests/scenario-generator.test.ts
```

Expected: FAIL — `Cannot find module '../src/simulation/scenario-generator.js'`

- [ ] **Step 3: Write `src/simulation/scenario-generator.ts`**

```ts
import Anthropic from '@anthropic-ai/sdk'
import { randomUUID } from 'crypto'
import type { Scenario, AnalysisJSON, GraphJSON } from '../types.js'

const SYSTEM_PROMPT = `You are a forward-looking technology investment strategist.
Generate scenarios using the generate_scenarios tool based on the provided macro regime, propagation signals, and dependency graph.
Ground each scenario in specific company health signals and dependency relationships — avoid generic market commentary.
For daily runs, produce exactly three scenarios of types: best, base, disruption.
For what-if runs, produce exactly one scenario of type: whatif.`

const GENERATE_SCENARIOS_TOOL: Anthropic.Tool = {
  name: 'generate_scenarios',
  description: 'Generate forward-looking scenarios based on current macro regime and propagation signals',
  input_schema: {
    type: 'object',
    properties: {
      scenarios: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            scenarioType:     { type: 'string', enum: ['best', 'base', 'disruption', 'whatif'] },
            title:            { type: 'string', description: 'Short label, e.g. AI Acceleration Continues' },
            narrative:        { type: 'string', description: '2-3 paragraph forward-looking description' },
            timeHorizon:      { type: 'string', description: 'e.g. 3-6 months' },
            probability:      { type: 'integer', minimum: 0, maximum: 100 },
            regimeTransition: { type: ['string', 'null'], description: 'Target regime label if regime shifts, null if unchanged' },
            triggers:         { type: 'array', items: { type: 'string' }, description: '3-5 specific events that cause this scenario' },
          },
          required: ['scenarioType', 'title', 'narrative', 'timeHorizon', 'probability', 'regimeTransition', 'triggers'],
        },
      },
    },
    required: ['scenarios'],
  },
}

function formatAnalysis(analysis: AnalysisJSON, graph: GraphJSON): string {
  const { latestRegime: r, latestSignals, companySummaries } = analysis
  const signals = latestSignals.length
    ? latestSignals.map(s => `  ${s.sourceTicker} → ${s.targetTicker} (${s.signalType}, ${s.direction}, ${s.magnitude}, ${s.sentiment}): ${s.description}`).join('\n')
    : '  None'
  const health = companySummaries.map(c => `  ${c.ticker}: ${c.healthScore}`).join('\n')
  const edges = graph.edges.slice(0, 20).map(e => `  ${e.from} → ${e.to} [${e.type}, ${e.strength}]: ${e.description.slice(0, 100)}`).join('\n')
  return [
    `## Current Regime: ${r.regime} (${r.confidence} confidence)`,
    r.rationale,
    `Key Indicators:\n${r.keyIndicators.map(i => `  - ${i}`).join('\n')}`,
    `\n## Propagation Signals (${latestSignals.length}):\n${signals}`,
    `\n## Company Health:\n${health}`,
    `\n## Key Dependency Edges:\n${edges || '  None'}`,
  ].join('\n')
}

export async function generateScenarios(
  analysis: AnalysisJSON,
  graph: GraphJSON,
  options: { trigger?: string; runId: string; client?: Anthropic },
): Promise<Scenario[]> {
  const client  = options.client ?? new Anthropic()
  const today   = new Date().toISOString().slice(0, 10)
  const now     = new Date().toISOString()
  const context = formatAnalysis(analysis, graph)

  const userContent = options.trigger
    ? `Given this what-if trigger: "${options.trigger}"\n\nCurrent state:\n${context}`
    : `Generate three scenarios (best, base, disruption) from this current state:\n\n${context}`

  const message = await client.messages.create({
    model:      'claude-sonnet-4-6',
    max_tokens: 4096,
    system:     [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
    tools:      [GENERATE_SCENARIOS_TOOL],
    tool_choice: { type: 'tool', name: 'generate_scenarios' },
    messages:   [{ role: 'user', content: userContent }],
  })

  const toolUse = message.content.find(b => b.type === 'tool_use')
  if (!toolUse || toolUse.type !== 'tool_use') {
    throw new Error('Expected tool_use response from Claude')
  }

  const input = toolUse.input as {
    scenarios: Array<{
      scenarioType: string; title: string; narrative: string; timeHorizon: string
      probability: number; regimeTransition: string | null; triggers: string[]
    }>
  }

  return input.scenarios.map(s => ({
    id:               randomUUID(),
    runId:            options.runId,
    date:             today,
    scenarioType:     s.scenarioType as Scenario['scenarioType'],
    title:            s.title,
    narrative:        s.narrative,
    timeHorizon:      s.timeHorizon,
    probability:      s.probability,
    regimeTransition: (s.regimeTransition as string | undefined) ?? null,
    triggers:         s.triggers,
    createdAt:        now,
  }))
}
```

- [ ] **Step 4: Run tests to confirm they pass**

```bash
npm test -- tests/scenario-generator.test.ts
```

Expected: 3 passed.

- [ ] **Step 5: Commit**

```bash
git add scenario-simulator/src/simulation/scenario-generator.ts scenario-simulator/tests/scenario-generator.test.ts
git commit -m "feat: add scenario-generator (Stage 1 — Claude generate_scenarios tool)"
```

---

### Task 7: Action Generator

**Files:**
- Create: `scenario-simulator/src/simulation/action-generator.ts`
- Test: `scenario-simulator/tests/action-generator.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `scenario-simulator/tests/action-generator.test.ts`:
```ts
import { describe, it, expect, vi } from 'vitest'
import Anthropic from '@anthropic-ai/sdk'
import { generateActions } from '../src/simulation/action-generator.js'
import type { Scenario, Position } from '../src/types.js'

const mockScenarios: Scenario[] = [
  {
    id: 's1', runId: 'run-1', date: '2026-05-23', scenarioType: 'best',
    title: 'AI Boom', narrative: 'Strong demand.', timeHorizon: '3-6 months',
    probability: 65, regimeTransition: null, triggers: ['NVDA beats'],
    createdAt: '2026-05-23T10:00:00Z',
  },
  {
    id: 's2', runId: 'run-1', date: '2026-05-23', scenarioType: 'disruption',
    title: 'Supply Shock', narrative: 'TSM cuts.', timeHorizon: '3-6 months',
    probability: 20, regimeTransition: 'Semiconductor Correction', triggers: ['TSM cuts 2nm'],
    createdAt: '2026-05-23T10:00:00Z',
  },
]

const mockPositions: Position[] = [
  { ticker: 'NVDA', company: 'NVIDIA', shares: 100, avgCost: 68.50, currentPrice: 92.00, currentValue: 9200, unrealizedPnl: 2350, updatedAt: '2026-05-23T10:00:00Z' },
]

describe('generateActions', () => {
  it('returns actions with correct scenarioId mapping', async () => {
    const mockClient = {
      messages: {
        create: vi.fn().mockResolvedValue({
          content: [{
            type: 'tool_use',
            input: {
              actions: [
                { scenarioType: 'best', ticker: 'NVDA', action: 'buy', conviction: 'high', allocationChangePct: 15, rationale: 'AI demand accelerating.' },
                { scenarioType: 'disruption', ticker: 'NVDA', action: 'trim', conviction: 'high', allocationChangePct: -25, rationale: 'Supply risk elevated.' },
              ],
            },
          }],
        }),
      },
    } as unknown as Anthropic

    const actions = await generateActions(mockScenarios, mockPositions, { runId: 'run-1', client: mockClient })

    expect(actions).toHaveLength(2)
    expect(actions[0].scenarioId).toBe('s1')
    expect(actions[1].scenarioId).toBe('s2')
    expect(actions[0].action).toBe('buy')
    expect(actions[0].allocationChangePct).toBe(15)
    expect(actions[1].allocationChangePct).toBe(-25)
    expect(actions[0].runId).toBe('run-1')
  })

  it('allocationChangePct is stored as-is (integer from Claude)', async () => {
    const mockClient = {
      messages: {
        create: vi.fn().mockResolvedValue({
          content: [{ type: 'tool_use', input: { actions: [{ scenarioType: 'best', ticker: 'NVDA', action: 'hold', conviction: 'medium', allocationChangePct: 0, rationale: 'Monitoring.' }] } }],
        }),
      },
    } as unknown as Anthropic

    const actions = await generateActions(mockScenarios, mockPositions, { runId: 'run-1', client: mockClient })

    expect(actions[0].allocationChangePct).toBe(0)
  })

  it('throws when Claude does not return tool_use', async () => {
    const badClient = {
      messages: { create: vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'oops' }] }) },
    } as unknown as Anthropic

    await expect(
      generateActions(mockScenarios, mockPositions, { runId: 'run-1', client: badClient })
    ).rejects.toThrow('Expected tool_use response from Claude')
  })
})
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
npm test -- tests/action-generator.test.ts
```

Expected: FAIL — `Cannot find module '../src/simulation/action-generator.js'`

- [ ] **Step 3: Write `src/simulation/action-generator.ts`**

```ts
import Anthropic from '@anthropic-ai/sdk'
import { randomUUID } from 'crypto'
import type { Scenario, Position, PortfolioAction } from '../types.js'

const SYSTEM_PROMPT = `You are a portfolio manager making position-aware recommendations.
Generate portfolio actions using the generate_portfolio_actions tool.
For each held position under each scenario, recommend: buy, hold, trim, or exit.
allocationChangePct MUST be consistent with action: buy → positive integer, hold → 0, trim → negative integer, exit → -100.
Base rationale on scenario-specific evidence, not generic advice.`

const GENERATE_ACTIONS_TOOL: Anthropic.Tool = {
  name: 'generate_portfolio_actions',
  description: 'Generate position-aware portfolio actions for each held ticker under each scenario',
  input_schema: {
    type: 'object',
    properties: {
      actions: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            scenarioType:        { type: 'string' },
            ticker:              { type: 'string' },
            action:              { type: 'string', enum: ['buy', 'hold', 'trim', 'exit'] },
            conviction:          { type: 'string', enum: ['high', 'medium', 'low'] },
            allocationChangePct: { type: 'integer', description: '+15 = add 15%, -30 = trim 30%, 0 = hold, -100 = exit' },
            rationale:           { type: 'string', description: '1-2 sentences referencing scenario-specific evidence' },
          },
          required: ['scenarioType', 'ticker', 'action', 'conviction', 'allocationChangePct', 'rationale'],
        },
      },
    },
    required: ['actions'],
  },
}

function formatScenarios(scenarios: Scenario[]): string {
  return scenarios.map(s =>
    `## ${s.scenarioType.toUpperCase()}: ${s.title} (${s.probability}%, ${s.timeHorizon})\n${s.narrative.slice(0, 400)}\nTriggers: ${s.triggers.join('; ')}\nRegime → ${s.regimeTransition ?? 'unchanged'}`
  ).join('\n\n')
}

function formatPositions(positions: Position[]): string {
  return positions.map(p =>
    `  ${p.ticker}: ${p.shares} shares @ avg $${p.avgCost.toFixed(2)} | current $${p.currentPrice.toFixed(2)} | value $${p.currentValue.toFixed(2)} | P&L ${p.unrealizedPnl >= 0 ? '+' : ''}$${p.unrealizedPnl.toFixed(2)}`
  ).join('\n')
}

export async function generateActions(
  scenarios: Scenario[],
  positions: Position[],
  options: { runId: string; client?: Anthropic },
): Promise<PortfolioAction[]> {
  const client = options.client ?? new Anthropic()
  const now    = new Date().toISOString()

  const message = await client.messages.create({
    model:      'claude-sonnet-4-6',
    max_tokens: 4096,
    system:     [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
    tools:      [GENERATE_ACTIONS_TOOL],
    tool_choice: { type: 'tool', name: 'generate_portfolio_actions' },
    messages: [{
      role:    'user',
      content: `Scenarios:\n${formatScenarios(scenarios)}\n\nCurrent Portfolio:\n${formatPositions(positions)}`,
    }],
  })

  const toolUse = message.content.find(b => b.type === 'tool_use')
  if (!toolUse || toolUse.type !== 'tool_use') {
    throw new Error('Expected tool_use response from Claude')
  }

  const input = toolUse.input as {
    actions: Array<{
      scenarioType: string; ticker: string; action: string; conviction: string
      allocationChangePct: number; rationale: string
    }>
  }

  const scenarioMap = new Map(scenarios.map(s => [s.scenarioType, s.id]))

  return input.actions.map(a => ({
    id:                  randomUUID(),
    runId:               options.runId,
    scenarioId:          scenarioMap.get(a.scenarioType) ?? '',
    ticker:              a.ticker,
    action:              a.action as PortfolioAction['action'],
    conviction:          a.conviction as PortfolioAction['conviction'],
    allocationChangePct: a.allocationChangePct,
    rationale:           a.rationale,
    createdAt:           now,
  }))
}
```

- [ ] **Step 4: Run tests to confirm they pass**

```bash
npm test -- tests/action-generator.test.ts
```

Expected: 3 passed.

- [ ] **Step 5: Commit**

```bash
git add scenario-simulator/src/simulation/action-generator.ts scenario-simulator/tests/action-generator.test.ts
git commit -m "feat: add action-generator (Stage 2 — Claude generate_portfolio_actions tool)"
```

---

### Task 8: Exporter

**Files:**
- Create: `scenario-simulator/src/export/exporter.ts`

No separate test — the exporter is a thin coordinator; its behavior is covered by the integration smoke test in Task 11.

- [ ] **Step 1: Write `src/export/exporter.ts`**

```ts
import { writeFileSync } from 'fs'
import type { SimulationStore } from '../store/sqlite.js'
import type { PortfolioStore } from '../portfolio/portfolio-store.js'
import type { SimulationJSON } from '../types.js'

export function exportSimulation(
  simStore: SimulationStore,
  portfolioStore: PortfolioStore,
  outputPath: string,
): SimulationJSON {
  const run = simStore.getLatestRun()
  if (!run) throw new Error('No simulation found — run npm run simulate first')

  const scenarios = simStore.getScenariosByRunId(run.id)
  const actions   = simStore.getActionsByRunId(run.id)
  const portfolio = portfolioStore.getPositions()

  const json: SimulationJSON = {
    exportedAt: new Date().toISOString(),
    portfolio,
    scenarios,
    actions,
  }

  writeFileSync(outputPath, JSON.stringify(json, null, 2), 'utf-8')
  return json
}
```

- [ ] **Step 2: Commit**

```bash
git add scenario-simulator/src/export/exporter.ts
git commit -m "feat: add exporter (writes data/simulation.json)"
```

---

### Task 9: Reporter

**Files:**
- Create: `scenario-simulator/src/export/reporter.ts`
- Test: `scenario-simulator/tests/reporter.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `scenario-simulator/tests/reporter.test.ts`:
```ts
import { describe, it, expect, afterEach } from 'vitest'
import { mkdirSync, rmSync, readFileSync } from 'fs'
import { join } from 'path'
import { generateReport } from '../src/export/reporter.js'
import type { Scenario, PortfolioAction, Position } from '../src/types.js'

const TEST_DIR = 'tests/tmp-reporter'

const scenarios: Scenario[] = [
  {
    id: 's1', runId: 'r1', date: '2026-05-23', scenarioType: 'best',
    title: 'AI Boom', narrative: 'Strong demand continues.', timeHorizon: '3-6 months',
    probability: 65, regimeTransition: null, triggers: ['NVDA beats guidance'],
    createdAt: '2026-05-23T10:00:00Z',
  },
]

const actions: PortfolioAction[] = [
  {
    id: 'a1', runId: 'r1', scenarioId: 's1', ticker: 'NVDA', action: 'buy',
    conviction: 'high', allocationChangePct: 15, rationale: 'AI demand accelerating.',
    createdAt: '2026-05-23T10:00:00Z',
  },
]

const positions: Position[] = [
  { ticker: 'NVDA', company: 'NVIDIA', shares: 100, avgCost: 68.50, currentPrice: 92.00, currentValue: 9200, unrealizedPnl: 2350, updatedAt: '2026-05-23T10:00:00Z' },
]

afterEach(() => { try { rmSync(TEST_DIR, { recursive: true }) } catch {} })

describe('generateReport', () => {
  it('writes a Markdown file with date heading, portfolio table, and scenario section', () => {
    mkdirSync(TEST_DIR, { recursive: true })
    generateReport('2026-05-23', scenarios, actions, positions, join(TEST_DIR, 'out.md'))

    const content = readFileSync(join(TEST_DIR, 'out.md'), 'utf-8')
    expect(content).toContain('# Scenario Simulation — 2026-05-23')
    expect(content).toContain('## Current Portfolio')
    expect(content).toContain('NVDA')
    expect(content).toContain('Best: AI Boom')
    expect(content).toContain('buy +15%')
    expect(content).toContain('high conviction')
    expect(content).toContain('AI demand accelerating.')
  })

  it('shows "No change expected" when regimeTransition is null', () => {
    mkdirSync(TEST_DIR, { recursive: true })
    generateReport('2026-05-23', scenarios, actions, positions, join(TEST_DIR, 'out.md'))

    const content = readFileSync(join(TEST_DIR, 'out.md'), 'utf-8')
    expect(content).toContain('No change expected')
  })

  it('shows regime transition label when set', () => {
    mkdirSync(TEST_DIR, { recursive: true })
    const withTransition = [{ ...scenarios[0], regimeTransition: 'Semiconductor Correction' }]
    generateReport('2026-05-23', withTransition, actions, positions, join(TEST_DIR, 'out.md'))

    const content = readFileSync(join(TEST_DIR, 'out.md'), 'utf-8')
    expect(content).toContain('→ Semiconductor Correction')
  })

  it('shows no-positions message when portfolio is empty', () => {
    mkdirSync(TEST_DIR, { recursive: true })
    generateReport('2026-05-23', scenarios, [], [], join(TEST_DIR, 'out.md'))

    const content = readFileSync(join(TEST_DIR, 'out.md'), 'utf-8')
    expect(content).toContain('_No positions recorded._')
  })

  it('labels a whatif scenario correctly', () => {
    mkdirSync(TEST_DIR, { recursive: true })
    const whatif: Scenario[] = [{ ...scenarios[0], id: 'w1', scenarioType: 'whatif', title: 'TSMC Shock' }]
    generateReport('2026-05-23', whatif, [], [], join(TEST_DIR, 'out.md'))

    const content = readFileSync(join(TEST_DIR, 'out.md'), 'utf-8')
    expect(content).toContain('What-If: TSMC Shock')
  })
})
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
npm test -- tests/reporter.test.ts
```

Expected: FAIL — `Cannot find module '../src/export/reporter.js'`

- [ ] **Step 3: Write `src/export/reporter.ts`**

```ts
import { writeFileSync } from 'fs'
import type { Position, Scenario, PortfolioAction } from '../types.js'

function fmtPnl(n: number): string {
  return n >= 0 ? `+$${n.toFixed(2)}` : `-$${Math.abs(n).toFixed(2)}`
}

function portfolioTable(positions: Position[]): string {
  if (positions.length === 0) return '_No positions recorded._\n'
  const header = '| Ticker | Shares | Avg Cost | Price | Value | Unrealized P&L |\n|--------|--------|----------|-------|-------|----------------|\n'
  const rows   = positions.map(p =>
    `| ${p.ticker} | ${p.shares} | $${p.avgCost.toFixed(2)} | $${p.currentPrice.toFixed(2)} | $${p.currentValue.toFixed(2)} | ${fmtPnl(p.unrealizedPnl)} |`
  ).join('\n')
  return header + rows + '\n'
}

function typeLabel(t: Scenario['scenarioType']): string {
  if (t === 'whatif') return 'What-If'
  return t.charAt(0).toUpperCase() + t.slice(1)
}

function scenarioSection(scenario: Scenario, actions: PortfolioAction[]): string {
  const lines: string[] = [
    `## ${typeLabel(scenario.scenarioType)}: ${scenario.title} (${scenario.probability}%, ${scenario.timeHorizon})`,
    '',
    scenario.narrative,
    '',
    '**Triggers:**',
    ...scenario.triggers.map(t => `- ${t}`),
    '',
    `**Regime Transition:** ${scenario.regimeTransition ? `→ ${scenario.regimeTransition}` : 'No change expected'}`,
  ]

  if (actions.length > 0) {
    lines.push('', '**Portfolio Actions:**')
    for (const a of actions) {
      const pct = a.allocationChangePct !== 0 ? ` ${a.allocationChangePct > 0 ? '+' : ''}${a.allocationChangePct}%` : ''
      lines.push(`- ${a.ticker}: **${a.action}${pct}** (${a.conviction} conviction) — ${a.rationale}`)
    }
  }

  return lines.join('\n')
}

export function generateReport(
  date: string,
  scenarios: Scenario[],
  actions: PortfolioAction[],
  positions: Position[],
  outputPath: string,
): void {
  const actionsByScenario = new Map<string, PortfolioAction[]>()
  for (const a of actions) {
    const list = actionsByScenario.get(a.scenarioId) ?? []
    list.push(a)
    actionsByScenario.set(a.scenarioId, list)
  }

  const parts: string[] = [
    `# Scenario Simulation — ${date}`,
    '',
    '## Current Portfolio',
    portfolioTable(positions),
  ]

  for (const s of scenarios) {
    parts.push(scenarioSection(s, actionsByScenario.get(s.id) ?? []))
    parts.push('')
  }

  writeFileSync(outputPath, parts.join('\n'), 'utf-8')
}
```

- [ ] **Step 4: Run tests to confirm they pass**

```bash
npm test -- tests/reporter.test.ts
```

Expected: 5 passed.

- [ ] **Step 5: Run all tests**

```bash
npm test
```

Expected: all tests across all test files pass.

- [ ] **Step 6: Commit**

```bash
git add scenario-simulator/src/export/reporter.ts scenario-simulator/tests/reporter.test.ts
git commit -m "feat: add reporter (writes data/reports/YYYY-MM-DD.md)"
```

---

### Task 10: CLI Files

**Files:**
- Create: `scenario-simulator/src/cli/cli-run.ts`
- Create: `scenario-simulator/src/cli/cli-whatif.ts`
- Create: `scenario-simulator/src/cli/cli-portfolio.ts`
- Create: `scenario-simulator/src/cli/cli-report.ts`
- Create: `scenario-simulator/src/cli/cli-schedule.ts`

- [ ] **Step 1: Write `src/cli/cli-run.ts`**

```ts
import 'dotenv/config'
import { join } from 'path'
import { mkdirSync, readFileSync } from 'fs'
import { randomUUID } from 'crypto'
import { createSimulationStore } from '../store/sqlite.js'
import { createPortfolioStore } from '../portfolio/portfolio-store.js'
import { fetchPrices } from '../portfolio/price-fetcher.js'
import { generateScenarios } from '../simulation/scenario-generator.js'
import { generateActions } from '../simulation/action-generator.js'
import { exportSimulation } from '../export/exporter.js'
import { generateReport } from '../export/reporter.js'
import type { AnalysisJSON, GraphJSON } from '../types.js'

const DATA_DIR      = join(process.cwd(), 'data')
const REPORTS_DIR   = join(DATA_DIR, 'reports')
const ANALYSIS_PATH = join(process.cwd(), '../ai-analysis-engine/data/analysis.json')
const GRAPH_PATH    = join(process.cwd(), '../dependency-graph-engine/data/graph.json')

async function run() {
  const startTime = Date.now()
  mkdirSync(DATA_DIR,    { recursive: true })
  mkdirSync(REPORTS_DIR, { recursive: true })

  const analysis: AnalysisJSON = JSON.parse(readFileSync(ANALYSIS_PATH, 'utf-8'))
  const graph: GraphJSON       = JSON.parse(readFileSync(GRAPH_PATH, 'utf-8'))

  const portfolioStore = createPortfolioStore(join(DATA_DIR, 'portfolio.db'))
  const simStore       = createSimulationStore(join(DATA_DIR, 'simulation.db'))

  try {
    const positions = portfolioStore.getPositions()
    if (positions.length > 0) {
      const prices = await fetchPrices(positions.map(p => p.ticker))
      if (Object.keys(prices).length > 0) portfolioStore.updatePrices(prices)
    }

    const runId = randomUUID()
    const today = new Date().toISOString().slice(0, 10)

    console.log(`[${new Date().toISOString()}] Stage 1: generating scenarios...`)
    const scenarios = await generateScenarios(analysis, graph, { runId })
    for (const s of scenarios) simStore.insertScenario(s)
    console.log(`  ${scenarios.length} scenario(s) generated`)

    const freshPositions = portfolioStore.getPositions()
    let actions: Awaited<ReturnType<typeof generateActions>> = []

    if (freshPositions.length > 0) {
      console.log(`[${new Date().toISOString()}] Stage 2: generating portfolio actions...`)
      actions = await generateActions(scenarios, freshPositions, { runId })
      for (const a of actions) simStore.insertAction(a)
      console.log(`  ${actions.length} action(s) generated`)
    } else {
      console.log('  No positions — skipping Stage 2')
    }

    simStore.insertRun({
      id: runId, date: today, type: 'daily', trigger: null,
      scenarioCount: scenarios.length, actionCount: actions.length,
      durationMs: Date.now() - startTime, createdAt: new Date().toISOString(),
    })

    exportSimulation(simStore, portfolioStore, join(DATA_DIR, 'simulation.json'))
    const reportPath = join(REPORTS_DIR, `${today}.md`)
    generateReport(today, scenarios, actions, freshPositions, reportPath)

    console.log(`\nDone in ${((Date.now() - startTime) / 1000).toFixed(1)}s`)
    console.log(`Report: ${reportPath}`)
  } finally {
    simStore.close()
    portfolioStore.close()
  }
}

run().catch(err => { console.error(err); process.exit(1) })
```

- [ ] **Step 2: Write `src/cli/cli-whatif.ts`**

```ts
import 'dotenv/config'
import { join } from 'path'
import { mkdirSync, readFileSync } from 'fs'
import { randomUUID } from 'crypto'
import { createSimulationStore } from '../store/sqlite.js'
import { createPortfolioStore } from '../portfolio/portfolio-store.js'
import { fetchPrices } from '../portfolio/price-fetcher.js'
import { generateScenarios } from '../simulation/scenario-generator.js'
import { generateActions } from '../simulation/action-generator.js'
import { exportSimulation } from '../export/exporter.js'
import { generateReport } from '../export/reporter.js'
import type { AnalysisJSON, GraphJSON } from '../types.js'

const DATA_DIR      = join(process.cwd(), 'data')
const REPORTS_DIR   = join(DATA_DIR, 'reports')
const ANALYSIS_PATH = join(process.cwd(), '../ai-analysis-engine/data/analysis.json')
const GRAPH_PATH    = join(process.cwd(), '../dependency-graph-engine/data/graph.json')

const args        = process.argv.slice(2)
const triggerIdx  = args.findIndex(a => a === '--trigger')
const trigger     = triggerIdx !== -1
  ? args[triggerIdx + 1]
  : args.find(a => a.startsWith('--trigger='))?.split('=').slice(1).join('=')

if (!trigger) {
  console.error('Usage: npm run whatif -- --trigger "TSMC cuts 2nm capacity by 30%"')
  process.exit(1)
}

async function run() {
  const startTime = Date.now()
  mkdirSync(DATA_DIR,    { recursive: true })
  mkdirSync(REPORTS_DIR, { recursive: true })

  const analysis: AnalysisJSON = JSON.parse(readFileSync(ANALYSIS_PATH, 'utf-8'))
  const graph: GraphJSON       = JSON.parse(readFileSync(GRAPH_PATH, 'utf-8'))

  const portfolioStore = createPortfolioStore(join(DATA_DIR, 'portfolio.db'))
  const simStore       = createSimulationStore(join(DATA_DIR, 'simulation.db'))

  try {
    const positions = portfolioStore.getPositions()
    if (positions.length > 0) {
      const prices = await fetchPrices(positions.map(p => p.ticker))
      if (Object.keys(prices).length > 0) portfolioStore.updatePrices(prices)
    }

    const runId = randomUUID()
    const today = new Date().toISOString().slice(0, 10)

    console.log(`[${new Date().toISOString()}] What-if: "${trigger}"`)
    const scenarios = await generateScenarios(analysis, graph, { trigger, runId })
    for (const s of scenarios) simStore.insertScenario(s)

    const freshPositions = portfolioStore.getPositions()
    let actions: Awaited<ReturnType<typeof generateActions>> = []

    if (freshPositions.length > 0) {
      actions = await generateActions(scenarios, freshPositions, { runId })
      for (const a of actions) simStore.insertAction(a)
    }

    simStore.insertRun({
      id: runId, date: today, type: 'whatif', trigger,
      scenarioCount: scenarios.length, actionCount: actions.length,
      durationMs: Date.now() - startTime, createdAt: new Date().toISOString(),
    })

    exportSimulation(simStore, portfolioStore, join(DATA_DIR, 'simulation.json'))
    const reportPath = join(REPORTS_DIR, `${today}-whatif.md`)
    generateReport(today, scenarios, actions, freshPositions, reportPath)

    console.log(`\nDone in ${((Date.now() - startTime) / 1000).toFixed(1)}s`)
    console.log(`Report: ${reportPath}`)
  } finally {
    simStore.close()
    portfolioStore.close()
  }
}

run().catch(err => { console.error(err); process.exit(1) })
```

- [ ] **Step 3: Write `src/cli/cli-portfolio.ts`**

```ts
import 'dotenv/config'
import { join } from 'path'
import { mkdirSync, readFileSync } from 'fs'
import { createPortfolioStore } from '../portfolio/portfolio-store.js'
import { fetchPrices } from '../portfolio/price-fetcher.js'

const DATA_DIR = join(process.cwd(), 'data')
const GRAPH_PATH = join(process.cwd(), '../dependency-graph-engine/data/graph.json')
mkdirSync(DATA_DIR, { recursive: true })

const args    = process.argv.slice(2)
const command = args[0]
const store   = createPortfolioStore(join(DATA_DIR, 'portfolio.db'))

async function run() {
  if (command === 'set') {
    const [, ticker, sharesStr, avgCostStr] = args
    if (!ticker || !sharesStr || !avgCostStr) {
      console.error('Usage: npm run portfolio -- set <TICKER> <shares> <avgCost>')
      process.exit(1)
    }
    const shares  = parseFloat(sharesStr)
    const avgCost = parseFloat(avgCostStr)
    if (isNaN(shares) || isNaN(avgCost)) {
      console.error('shares and avgCost must be numbers')
      process.exit(1)
    }
    let company = ticker
    try {
      const graph = JSON.parse(readFileSync(GRAPH_PATH, 'utf-8'))
      const node  = (graph.nodes as Array<{ ticker: string; company: string }>).find(n => n.ticker === ticker)
      if (node) company = node.company
    } catch { /* use ticker as fallback */ }
    store.upsertPosition(ticker, company, shares, avgCost)
    console.log(`Position set: ${ticker} — ${shares} shares @ $${avgCost.toFixed(2)} avg (${company})`)
  } else if (command === 'show') {
    const positions = store.getPositions()
    if (positions.length > 0) {
      const prices = await fetchPrices(positions.map(p => p.ticker))
      if (Object.keys(prices).length > 0) store.updatePrices(prices)
    }
    const fresh = store.getPositions()
    if (fresh.length === 0) {
      console.log('No positions. Use: npm run portfolio -- set <TICKER> <shares> <avgCost>')
    } else {
      console.log('\nPortfolio:\n')
      console.log('Ticker   Shares     Avg Cost    Price       Value        P&L')
      console.log('-------  ---------  ----------  ----------  -----------  ----------')
      for (const p of fresh) {
        const pnl = p.unrealizedPnl >= 0 ? `+$${p.unrealizedPnl.toFixed(2)}` : `-$${Math.abs(p.unrealizedPnl).toFixed(2)}`
        console.log(
          `${p.ticker.padEnd(8)} ${String(p.shares).padEnd(10)} $${p.avgCost.toFixed(2).padEnd(11)} $${p.currentPrice.toFixed(2).padEnd(11)} $${p.currentValue.toFixed(2).padEnd(12)} ${pnl}`
        )
      }
    }
  } else {
    console.log('Usage:')
    console.log('  npm run portfolio -- set <TICKER> <shares> <avgCost>')
    console.log('  npm run portfolio -- show')
  }
}

run()
  .catch(err => { console.error(err); process.exit(1) })
  .finally(() => store.close())
```

- [ ] **Step 4: Write `src/cli/cli-report.ts`**

```ts
import { join } from 'path'
import { readdirSync, readFileSync } from 'fs'

const REPORTS_DIR = join(process.cwd(), 'data', 'reports')

try {
  const files = readdirSync(REPORTS_DIR).filter(f => f.endsWith('.md')).sort()
  if (files.length === 0) {
    console.log('No reports found. Run: npm run simulate')
  } else {
    console.log(readFileSync(join(REPORTS_DIR, files[files.length - 1]), 'utf-8'))
  }
} catch {
  console.log('No reports directory. Run: npm run simulate')
}
```

- [ ] **Step 5: Write `src/cli/cli-schedule.ts`**

```ts
import 'dotenv/config'
import cron from 'node-cron'
import { join } from 'path'
import { mkdirSync, readFileSync } from 'fs'
import { randomUUID } from 'crypto'
import { createSimulationStore } from '../store/sqlite.js'
import { createPortfolioStore } from '../portfolio/portfolio-store.js'
import { fetchPrices } from '../portfolio/price-fetcher.js'
import { generateScenarios } from '../simulation/scenario-generator.js'
import { generateActions } from '../simulation/action-generator.js'
import { exportSimulation } from '../export/exporter.js'
import { generateReport } from '../export/reporter.js'
import type { AnalysisJSON, GraphJSON } from '../types.js'

const DATA_DIR      = join(process.cwd(), 'data')
const REPORTS_DIR   = join(DATA_DIR, 'reports')
const ANALYSIS_PATH = join(process.cwd(), '../ai-analysis-engine/data/analysis.json')
const GRAPH_PATH    = join(process.cwd(), '../dependency-graph-engine/data/graph.json')

async function runAnalysis() {
  const startTime = Date.now()
  const analysis: AnalysisJSON = JSON.parse(readFileSync(ANALYSIS_PATH, 'utf-8'))
  const graph: GraphJSON       = JSON.parse(readFileSync(GRAPH_PATH, 'utf-8'))

  const portfolioStore = createPortfolioStore(join(DATA_DIR, 'portfolio.db'))
  const simStore       = createSimulationStore(join(DATA_DIR, 'simulation.db'))

  try {
    const positions = portfolioStore.getPositions()
    if (positions.length > 0) {
      const prices = await fetchPrices(positions.map(p => p.ticker))
      if (Object.keys(prices).length > 0) portfolioStore.updatePrices(prices)
    }

    const runId      = randomUUID()
    const today      = new Date().toISOString().slice(0, 10)
    const scenarios  = await generateScenarios(analysis, graph, { runId })
    for (const s of scenarios) simStore.insertScenario(s)

    const freshPositions = portfolioStore.getPositions()
    let actions: Awaited<ReturnType<typeof generateActions>> = []
    if (freshPositions.length > 0) {
      actions = await generateActions(scenarios, freshPositions, { runId })
      for (const a of actions) simStore.insertAction(a)
    }

    simStore.insertRun({
      id: runId, date: today, type: 'daily', trigger: null,
      scenarioCount: scenarios.length, actionCount: actions.length,
      durationMs: Date.now() - startTime, createdAt: new Date().toISOString(),
    })

    exportSimulation(simStore, portfolioStore, join(DATA_DIR, 'simulation.json'))
    generateReport(today, scenarios, actions, freshPositions, join(REPORTS_DIR, `${today}.md`))
    console.log(`[${new Date().toISOString()}] Simulation complete: ${scenarios.length} scenarios, ${actions.length} actions`)
  } finally {
    simStore.close()
    portfolioStore.close()
  }
}

mkdirSync(DATA_DIR,    { recursive: true })
mkdirSync(REPORTS_DIR, { recursive: true })

console.log('Scenario Simulator scheduler started. Running daily at 06:30.')
cron.schedule('30 6 * * *', () => {
  runAnalysis().catch(err => console.error('Simulation failed:', err))
})
```

- [ ] **Step 6: Run all tests to verify nothing is broken**

```bash
npm test
```

Expected: all tests pass.

- [ ] **Step 7: Commit**

```bash
git add scenario-simulator/src/cli/
git commit -m "feat: add CLI entry points (simulate, whatif, portfolio, report, schedule)"
```

---

### Task 11: Integration Smoke Test

**Files:** None created — verify existing outputs.

This task verifies the full pipeline runs against real data.

- [ ] **Step 1: Copy the real API key from the analysis engine**

```bash
cat /Users/thanapold/Desktop/Projects/ai-analysis-engine/.env
```

Copy the `ANTHROPIC_API_KEY` value and write it to `scenario-simulator/.env`:
```
ANTHROPIC_API_KEY=<paste real key here>
FINANCIALDATA_API_KEY=REDACTED
```

- [ ] **Step 2: Verify sibling data files exist**

```bash
ls /Users/thanapold/Desktop/Projects/ai-analysis-engine/data/analysis.json && \
ls /Users/thanapold/Desktop/Projects/dependency-graph-engine/data/graph.json
```

Expected: both files exist.

- [ ] **Step 3: Run `npm run simulate`**

```bash
cd scenario-simulator && npm run simulate
```

Expected output (Stage 2 skipped — no positions yet):
```
[...] Stage 1: generating scenarios...
  3 scenario(s) generated
  No positions — skipping Stage 2
Done in Xs
Report: .../data/reports/YYYY-MM-DD.md
```

- [ ] **Step 4: Verify output files**

```bash
ls data/ && ls data/reports/
```

Expected: `portfolio.db  simulation.db  simulation.json  reports/` and at least one `.md` file.

- [ ] **Step 5: Print the report**

```bash
npm run report
```

Expected: Markdown with `# Scenario Simulation — YYYY-MM-DD`, three scenario sections, `_No positions recorded._`.

- [ ] **Step 6: Verify `simulation.json` shape**

```bash
node -e "
import('fs').then(({ readFileSync }) => {
  const j = JSON.parse(readFileSync('data/simulation.json', 'utf-8'));
  console.log('scenarios:', j.scenarios.length);
  console.log('actions:', j.actions.length);
  console.log('portfolio:', j.portfolio.length);
  console.log('keys:', Object.keys(j));
});"
```

Expected: `scenarios: 3`, `actions: 0`, `portfolio: 0`, `keys: [ 'exportedAt', 'portfolio', 'scenarios', 'actions' ]`.

- [ ] **Step 7: Add a position and run again**

```bash
npm run portfolio -- set NVDA 100 68.50
npm run simulate
```

Expected:
```
[...] Stage 1: generating scenarios...
  3 scenario(s) generated
[...] Stage 2: generating portfolio actions...
  3 action(s) generated
Done in Xs
```

- [ ] **Step 8: Verify actions appear in report**

```bash
npm run report
```

Expected: report now contains portfolio table with NVDA and action lines under each scenario.

- [ ] **Step 9: Run final test suite**

```bash
npm test
```

Expected: all tests pass.

- [ ] **Step 10: Commit**

```bash
git add scenario-simulator/
git commit -m "feat: scenario-simulator integration smoke test passing"
```
