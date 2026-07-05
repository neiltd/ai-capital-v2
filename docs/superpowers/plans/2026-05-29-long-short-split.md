# Long/Short Split Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a short-term Elliott Wave trading layer: action-generator computes entry/stop/target from wave pivots, Claude Haiku writes narratives with caching, trade portfolio tracked in SQLite, exposed via wave-actions.json and wave-portfolio.json, surfaced in a new `/trade` page in capital-intel-dashboard and TradePlanCard on the unified-platform wave detail page.

**Architecture:** Three existing projects (wave-analyzer, unified-platform, capital-intel-dashboard) gain new files. No new project.

**Tech Stack:** TypeScript, better-sqlite3, @anthropic-ai/sdk, Next.js (App Router)

---

### Task A-1: Add types to wave-analyzer/src/types.ts

**Files:**
- Modify: `wave-analyzer/src/types.ts`
- Create: `wave-analyzer/tests/types-trade.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
// wave-analyzer/tests/types-trade.test.ts
import { describe, it, expect } from 'vitest'
import type { TradeAction, TradePosition, WaveActionsJSON, WavePortfolioJSON } from '../src/types.js'

describe('trade types', () => {
  it('TradeAction has all required fields', () => {
    const a: TradeAction = {
      ticker: 'NVDA', label: 'NVIDIA',
      currentWave: '3', waveDirection: 'up',
      confidence: 72, signal: 'buy',
      entryZone: { low: 1080, high: 1120 },
      stopLoss: 980, target: 1380, riskReward: 2.5,
      narrative: 'Wave 3 in progress targeting 1.618 extension.',
      narrativeKey: 'NVDA:3:70',
      generatedAt: '2026-05-29T00:00:00.000Z',
    }
    expect(a.signal).toBe('buy')
    expect(a.riskReward).toBe(2.5)
  })

  it('WaveActionsJSON has exportedAt, asOf, actions', () => {
    const j: WaveActionsJSON = {
      exportedAt: '2026-05-29T00:00:00.000Z',
      asOf: '2026-05-29',
      actions: [],
    }
    expect(j.actions).toHaveLength(0)
  })
})
```

- [ ] **Step 2: Run test, confirm failure**

```bash
cd wave-analyzer && npm test -- --reporter=verbose 2>&1 | grep -A5 'FAIL\|Error'
```

- [ ] **Step 3: Add types to wave-analyzer/src/types.ts**

At the end of the existing file, append:

```typescript
export type TradeSignal = 'buy' | 'sell' | 'watch' | 'no-signal'

export interface TradeAction {
  ticker:        string
  label:         string
  currentWave:   string | null
  waveDirection: 'up' | 'down' | null
  confidence:    number
  signal:        TradeSignal
  entryZone:     { low: number; high: number } | null
  stopLoss:      number | null
  target:        number | null
  riskReward:    number | null
  narrative:     string
  narrativeKey:  string
  generatedAt:   string
}

export interface WaveActionsJSON {
  exportedAt: string
  asOf:       string
  actions:    TradeAction[]
}

export interface TradePosition {
  id:          string
  ticker:      string
  signal:      'buy' | 'sell'
  entryPrice:  number
  stopLoss:    number
  target:      number
  shares:      number
  openedAt:    string
  closedAt:    string | null
  closePrice:  number | null
  pnl:         number | null
  status:      'open' | 'closed' | 'stopped'
}

export interface WavePortfolioJSON {
  exportedAt:      string
  openPositions:   TradePosition[]
  closedPositions: TradePosition[]
  totalPnl:        number
}
```

- [ ] **Step 4: Run test, confirm pass**

```bash
cd wave-analyzer && npm test
```

- [ ] **Step 5: Commit**

```bash
git add wave-analyzer/src/types.ts wave-analyzer/tests/types-trade.test.ts
git commit -m "feat(trade): add TradeAction, TradePosition types to wave-analyzer"
```

---

### Task A-2: Implement action-generator.ts (deterministic signal logic)

**Files:**
- Create: `wave-analyzer/src/actions/action-generator.ts`
- Create: `wave-analyzer/tests/action-generator.test.ts`

The signal logic is deterministic. Narrative generation (Claude Haiku) is tested with a mock.

- [ ] **Step 1: Write failing tests**

```typescript
// wave-analyzer/tests/action-generator.test.ts
import { describe, it, expect, vi } from 'vitest'
import { computeSignal, computePrices, roundConfidence } from '../src/actions/action-generator.js'
import type { WaveAsset } from '../src/types.js'

const baseAsset: WaveAsset = {
  ticker: 'NVDA', label: 'NVIDIA', close: 1100,
  currentWave: '3', waveDirection: 'up', confidence: 72,
  wavePivots: [
    { label: '0', price: 800, date: '2026-01-01' },
    { label: '1', price: 1000, date: '2026-02-01' },
    { label: '2', price: 900, date: '2026-03-01' },
  ],
  thesisSummary: null, analysisDate: '2026-05-29',
}

describe('computeSignal', () => {
  it('returns buy for up wave 3 with confidence >= 50', () => {
    expect(computeSignal('3', 'up', 72)).toBe('buy')
  })

  it('returns buy for up wave 5', () => {
    expect(computeSignal('5', 'up', 60)).toBe('buy')
  })

  it('returns sell for down wave 3', () => {
    expect(computeSignal('3', 'down', 65)).toBe('sell')
  })

  it('returns watch for corrective wave 2', () => {
    expect(computeSignal('2', 'up', 70)).toBe('watch')
  })

  it('returns no-signal when confidence < 50', () => {
    expect(computeSignal('3', 'up', 45)).toBe('no-signal')
  })

  it('returns no-signal when currentWave is null', () => {
    expect(computeSignal(null, 'up', 70)).toBe('no-signal')
  })
})

describe('computePrices', () => {
  it('computes entry zone as close ± 2%', () => {
    const result = computePrices('3', 'up', 1100, baseAsset.wavePivots)
    expect(result.entryZone?.low).toBeCloseTo(1078, 0)
    expect(result.entryZone?.high).toBeCloseTo(1122, 0)
  })

  it('computes stop loss from wave 2 low for up wave 3', () => {
    const result = computePrices('3', 'up', 1100, baseAsset.wavePivots)
    expect(result.stopLoss).toBe(900) // Wave 2 pivot price
  })

  it('computes target as wave 2 low + wave 1 height * 1.618', () => {
    // Wave 1 height = 1000 - 800 = 200, target = 900 + 200*1.618 = 900 + 323.6 = 1223.6
    const result = computePrices('3', 'up', 1100, baseAsset.wavePivots)
    expect(result.target).toBeCloseTo(1223.6, 0)
  })

  it('returns null prices when pivots insufficient', () => {
    const result = computePrices('3', 'up', 1100, [])
    expect(result.stopLoss).toBeNull()
    expect(result.target).toBeNull()
  })
})

describe('roundConfidence', () => {
  it('rounds 72 to 70', () => expect(roundConfidence(72)).toBe(70))
  it('rounds 75 to 75', () => expect(roundConfidence(75)).toBe(75))
  it('rounds 53 to 55', () => expect(roundConfidence(53)).toBe(55))
})
```

- [ ] **Step 2: Run to confirm failure**

```bash
cd wave-analyzer && npm test 2>&1 | tail -5
```

- [ ] **Step 3: First check the WaveAsset type**

Read `wave-analyzer/src/types.ts` to see the WaveAsset interface shape — specifically `wavePivots`, `currentWave`, `waveDirection`, `confidence`, `close` fields. Adjust the test's `WaveAsset` import and mock to match the actual type.

- [ ] **Step 4: Implement action-generator.ts**

```typescript
// wave-analyzer/src/actions/action-generator.ts
import Anthropic from '@anthropic-ai/sdk'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { join, dirname } from 'path'
import type { WaveAsset, TradeAction, TradeSignal } from '../types.js'

export function roundConfidence(c: number): number {
  return Math.round(c / 5) * 5
}

export function computeSignal(
  currentWave: string | null,
  waveDirection: 'up' | 'down' | null,
  confidence: number,
): TradeSignal {
  if (!currentWave || confidence < 50) return 'no-signal'
  const wave = currentWave.toString()
  if (wave === '3' || wave === '5') {
    if (waveDirection === 'up')   return 'buy'
    if (waveDirection === 'down') return 'sell'
  }
  if (['2', '4', 'A', 'B', 'C'].includes(wave)) return 'watch'
  return 'no-signal'
}

type Pivot = { label: string; price: number; date: string }

export function computePrices(
  currentWave: string,
  waveDirection: 'up' | 'down' | null,
  close: number,
  pivots: Pivot[],
): { entryZone: { low: number; high: number } | null; stopLoss: number | null; target: number | null; riskReward: number | null } {
  const pivot = (label: string) => pivots.find(p => p.label === label)?.price ?? null

  const entryZone = { low: close * 0.98, high: close * 1.02 }

  let stopLoss: number | null = null
  let target: number | null = null

  if (currentWave === '3' && waveDirection === 'up') {
    const w0 = pivot('0'), w1 = pivot('1'), w2 = pivot('2')
    if (w2 !== null) stopLoss = w2
    if (w0 !== null && w1 !== null && w2 !== null) {
      target = w2 + (w1 - w0) * 1.618
    }
  } else if (currentWave === '5' && waveDirection === 'up') {
    const w0 = pivot('0'), w1 = pivot('1'), w4 = pivot('4')
    if (w4 !== null) stopLoss = w4
    if (w0 !== null && w1 !== null && w4 !== null) {
      target = w4 + (w1 - w0) * 1.618
    }
  } else if (currentWave === '3' && waveDirection === 'down') {
    const w0 = pivot('0'), w1 = pivot('1'), w2 = pivot('2')
    if (w2 !== null) stopLoss = w2
    if (w0 !== null && w1 !== null && w2 !== null) {
      target = w2 - (w0 - w1) * 1.618
    }
  } else if (currentWave === '5' && waveDirection === 'down') {
    const w0 = pivot('0'), w1 = pivot('1'), w4 = pivot('4')
    if (w4 !== null) stopLoss = w4
    if (w0 !== null && w1 !== null && w4 !== null) {
      target = w4 - (w0 - w1) * 1.618
    }
  }

  if (stopLoss === null || target === null) {
    return { entryZone, stopLoss, target, riskReward: null }
  }

  const entryMid = (entryZone.low + entryZone.high) / 2
  const rr = Math.abs(target - entryMid) / Math.abs(entryMid - stopLoss)
  const riskReward = rr > 0 ? Number(rr.toFixed(2)) : null

  return { entryZone, stopLoss, target, riskReward }
}

type NarrativeCache = Record<string, string>

function loadNarrativeCache(cachePath: string): NarrativeCache {
  try {
    if (!existsSync(cachePath)) return {}
    return JSON.parse(readFileSync(cachePath, 'utf-8'))
  } catch { return {} }
}

function saveNarrativeCache(cachePath: string, cache: NarrativeCache): void {
  mkdirSync(dirname(cachePath), { recursive: true })
  writeFileSync(cachePath, JSON.stringify(cache, null, 2))
}

async function generateNarrative(
  asset: WaveAsset,
  action: Omit<TradeAction, 'narrative'>,
  client: Anthropic,
): Promise<string> {
  const pivotLines = (asset.wavePivots ?? [])
    .map((p: Pivot) => `Wave ${p.label}: $${p.price} (${p.date})`)
    .join(', ')

  const prompt = `You are a technical analyst. Write a 3-sentence trade rationale for this Elliott Wave setup.
Focus on: (1) what wave structure is forming, (2) why the entry zone makes sense, (3) what invalidates the trade. Be specific with price levels. No fluff.

Ticker: ${action.ticker}
Current wave: ${action.currentWave} (${action.waveDirection})
Entry zone: $${action.entryZone?.low.toFixed(0)} – $${action.entryZone?.high.toFixed(0)}
Stop loss: $${action.stopLoss?.toFixed(0) ?? 'N/A'}
Target: $${action.target?.toFixed(0) ?? 'N/A'}
R:R: ${action.riskReward ?? 'N/A'}x
Confidence: ${action.confidence}%
Wave pivots: ${pivotLines}`

  try {
    const res = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 300,
      messages: [{ role: 'user', content: prompt }],
    })
    return res.content.find(b => b.type === 'text')?.text ?? 'Elliott Wave structure in progress.'
  } catch {
    return 'Elliott Wave structure in progress.'
  }
}

export async function generateActions(assets: WaveAsset[], cachePath: string): Promise<TradeAction[]> {
  const eligible = assets.filter(a => a.confidence >= 50 && a.currentWave != null)
  if (eligible.length === 0) return assets.map(a => ({
    ticker: a.ticker, label: a.label,
    currentWave: a.currentWave ?? null, waveDirection: a.waveDirection ?? null,
    confidence: a.confidence, signal: 'no-signal' as TradeSignal,
    entryZone: null, stopLoss: null, target: null, riskReward: null,
    narrative: '', narrativeKey: `${a.ticker}:null:0`,
    generatedAt: new Date().toISOString(),
  }))

  const client = new Anthropic()
  const cache = loadNarrativeCache(cachePath)
  const results: TradeAction[] = []
  let cacheUpdated = false

  for (const a of assets) {
    const signal = computeSignal(a.currentWave ?? null, a.waveDirection ?? null, a.confidence)
    const prices = (signal !== 'no-signal' && a.currentWave)
      ? computePrices(a.currentWave, a.waveDirection ?? null, a.close, a.wavePivots ?? [])
      : { entryZone: null, stopLoss: null, target: null, riskReward: null }

    const narrativeKey = `${a.ticker}:${a.currentWave ?? 'null'}:${roundConfidence(a.confidence)}`
    let narrative = ''

    if (signal === 'buy' || signal === 'sell') {
      if (cache[narrativeKey]) {
        narrative = cache[narrativeKey]
      } else {
        const partial: Omit<TradeAction, 'narrative'> = {
          ticker: a.ticker, label: a.label,
          currentWave: a.currentWave ?? null, waveDirection: a.waveDirection ?? null,
          confidence: a.confidence, signal, narrativeKey,
          generatedAt: new Date().toISOString(),
          ...prices,
        }
        narrative = await generateNarrative(a, partial, client)
        cache[narrativeKey] = narrative
        cacheUpdated = true
      }
    }

    results.push({
      ticker: a.ticker, label: a.label,
      currentWave: a.currentWave ?? null, waveDirection: a.waveDirection ?? null,
      confidence: a.confidence, signal, narrativeKey,
      generatedAt: new Date().toISOString(),
      narrative,
      ...prices,
    })
  }

  if (cacheUpdated) saveNarrativeCache(cachePath, cache)
  return results
}
```

**IMPORTANT:** Before writing this file, read `wave-analyzer/src/types.ts` to verify the exact field names of `WaveAsset` (especially `wavePivots`, `waveDirection`, `close`, `currentWave`, `confidence`). Adjust field access to match the actual type.

- [ ] **Step 5: Run tests**

```bash
cd wave-analyzer && npm test
```

- [ ] **Step 6: Commit**

```bash
git add wave-analyzer/src/actions/action-generator.ts wave-analyzer/tests/action-generator.test.ts
git commit -m "feat(trade): add action-generator with deterministic signal logic"
```

---

### Task A-3: Implement trade-portfolio.ts (SQLite)

**Files:**
- Create: `wave-analyzer/src/portfolio/trade-portfolio.ts`
- Create: `wave-analyzer/tests/trade-portfolio.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
// wave-analyzer/tests/trade-portfolio.test.ts
import { describe, it, expect, afterEach } from 'vitest'
import { rmSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { createTradePortfolio } from '../src/portfolio/trade-portfolio.js'

const DB_PATH = join(tmpdir(), `trade-test-${Date.now()}.db`)

afterEach(() => { rmSync(DB_PATH, { force: true }) })

describe('trade-portfolio', () => {
  it('opens and closes a trade', () => {
    const p = createTradePortfolio(DB_PATH)
    const trade = p.openTrade({ ticker: 'NVDA', signal: 'buy', entryPrice: 1100, stopLoss: 980, target: 1380, shares: 10, openedAt: '2026-05-29T00:00:00.000Z' })
    expect(trade.status).toBe('open')
    expect(trade.id).toMatch(/^[0-9a-f-]{36}$/)

    const closed = p.closeTrade(trade.id, 1350)
    expect(closed.status).toBe('closed')
    expect(closed.pnl).toBeCloseTo((1350 - 1100) * 10, 2)
    p.close()
  })

  it('returns open positions', () => {
    const p = createTradePortfolio(DB_PATH)
    p.openTrade({ ticker: 'AAPL', signal: 'buy', entryPrice: 200, stopLoss: 185, target: 230, shares: 5, openedAt: '2026-05-29T00:00:00.000Z' })
    expect(p.getOpenPositions()).toHaveLength(1)
    p.close()
  })

  it('returns closed positions', () => {
    const p = createTradePortfolio(DB_PATH)
    const t = p.openTrade({ ticker: 'MSFT', signal: 'sell', entryPrice: 450, stopLoss: 470, target: 410, shares: 8, openedAt: '2026-05-29T00:00:00.000Z' })
    p.closeTrade(t.id, 420)
    expect(p.getClosedPositions()).toHaveLength(1)
    expect(p.getClosedPositions()[0].pnl).toBeCloseTo((450 - 420) * 8, 2)
    p.close()
  })
})
```

- [ ] **Step 2: Run to confirm failure**

```bash
cd wave-analyzer && npm test 2>&1 | tail -5
```

- [ ] **Step 3: Check if better-sqlite3 is in wave-analyzer dependencies**

```bash
cat wave-analyzer/package.json | grep sqlite
```

If not present, add it:
```bash
cd wave-analyzer && npm install better-sqlite3 && npm install --save-dev @types/better-sqlite3
```

- [ ] **Step 4: Implement trade-portfolio.ts**

```typescript
// wave-analyzer/src/portfolio/trade-portfolio.ts
import Database from 'better-sqlite3'
import { randomUUID } from 'crypto'
import { mkdirSync, dirname } from 'path' // Note: import dirname from path, not 'fs'
import type { TradePosition } from '../types.js'

// Note: mkdirSync is from 'fs', dirname is from 'path'
import { mkdirSync as fsMkdir } from 'fs'
import { dirname as pathDirname } from 'path'

export interface TradePortfolio {
  openTrade(t: Omit<TradePosition, 'id' | 'closedAt' | 'closePrice' | 'pnl' | 'status'>): TradePosition
  closeTrade(id: string, closePrice: number): TradePosition
  getOpenPositions(): TradePosition[]
  getClosedPositions(limit?: number): TradePosition[]
  close(): void
}

export function createTradePortfolio(dbPath: string): TradePortfolio {
  fsMkdir(pathDirname(dbPath), { recursive: true })
  const db = new Database(dbPath)

  db.exec(`
    CREATE TABLE IF NOT EXISTS trades (
      id          TEXT PRIMARY KEY,
      ticker      TEXT NOT NULL,
      signal      TEXT NOT NULL,
      entry_price REAL NOT NULL,
      stop_loss   REAL NOT NULL,
      target      REAL NOT NULL,
      shares      REAL NOT NULL,
      opened_at   TEXT NOT NULL,
      closed_at   TEXT,
      close_price REAL,
      pnl         REAL,
      status      TEXT NOT NULL DEFAULT 'open'
    )
  `)

  function rowToPosition(row: any): TradePosition {
    return {
      id: row.id, ticker: row.ticker, signal: row.signal,
      entryPrice: row.entry_price, stopLoss: row.stop_loss,
      target: row.target, shares: row.shares,
      openedAt: row.opened_at, closedAt: row.closed_at ?? null,
      closePrice: row.close_price ?? null,
      pnl: row.pnl ?? null,
      status: row.status,
    }
  }

  return {
    openTrade(t) {
      const id = randomUUID()
      db.prepare(`
        INSERT INTO trades (id, ticker, signal, entry_price, stop_loss, target, shares, opened_at, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open')
      `).run(id, t.ticker, t.signal, t.entryPrice, t.stopLoss, t.target, t.shares, t.openedAt)
      return rowToPosition(db.prepare('SELECT * FROM trades WHERE id = ?').get(id))
    },

    closeTrade(id, closePrice) {
      const row = db.prepare('SELECT * FROM trades WHERE id = ?').get(id) as any
      if (!row) throw new Error(`Trade ${id} not found`)
      const pnl = row.signal === 'buy'
        ? (closePrice - row.entry_price) * row.shares
        : (row.entry_price - closePrice) * row.shares
      db.prepare(`
        UPDATE trades SET closed_at = ?, close_price = ?, pnl = ?, status = 'closed' WHERE id = ?
      `).run(new Date().toISOString(), closePrice, pnl, id)
      return rowToPosition(db.prepare('SELECT * FROM trades WHERE id = ?').get(id))
    },

    getOpenPositions() {
      return (db.prepare("SELECT * FROM trades WHERE status = 'open'").all() as any[]).map(rowToPosition)
    },

    getClosedPositions(limit = 20) {
      return (db.prepare("SELECT * FROM trades WHERE status = 'closed' ORDER BY closed_at DESC LIMIT ?").all(limit) as any[]).map(rowToPosition)
    },

    close() { db.close() },
  }
}
```

Note: Fix the import issue — `mkdirSync` is from `fs` and `dirname` is from `path`. The implementation above uses renamed imports to avoid collision.

- [ ] **Step 5: Run tests**

```bash
cd wave-analyzer && npm test
```

- [ ] **Step 6: Commit**

```bash
git add wave-analyzer/src/portfolio/trade-portfolio.ts wave-analyzer/tests/trade-portfolio.test.ts
git commit -m "feat(trade): add SQLite trade portfolio"
```

---

### Task A-4: Update exporter.ts to generate wave-actions.json + wave-portfolio.json

**Files:**
- Modify: `wave-analyzer/src/exporter.ts`

- [ ] **Step 1: Read current exporter.ts to understand its structure**

```bash
cat wave-analyzer/src/exporter.ts
```

- [ ] **Step 2: Check current test coverage of exporter**

```bash
cat wave-analyzer/tests/exporter.test.ts 2>/dev/null || echo "no test"
```

- [ ] **Step 3: Understand output paths — read wave-analyzer/src/cli/ to see how exporter is called**

- [ ] **Step 4: Modify exporter.ts**

After `buildWaveAssets()` completes and the main `waves.json` is written, also:

```typescript
// At top, add imports:
import { generateActions } from './actions/action-generator.js'
import { createTradePortfolio } from './portfolio/trade-portfolio.js'
import type { WaveActionsJSON, WavePortfolioJSON } from './types.js'

// After writing waves.json, add:
const ACTIONS_PATH    = join(dirname(outputPath), 'wave-actions.json')
const PORTFOLIO_PATH  = join(dirname(outputPath), 'wave-portfolio.json')
const NARRATIVE_CACHE = join(dirname(outputPath), 'narrative-cache.json')
const TRADES_DB       = join(dirname(outputPath), 'trades.db')

const actions = await generateActions(assets, NARRATIVE_CACHE)
const waveActionsJson: WaveActionsJSON = {
  exportedAt: new Date().toISOString(),
  asOf: new Date().toISOString().slice(0, 10),
  actions,
}
writeFileSync(ACTIONS_PATH, JSON.stringify(waveActionsJson, null, 2))

const portfolio = createTradePortfolio(TRADES_DB)
const openPositions   = portfolio.getOpenPositions()
const closedPositions = portfolio.getClosedPositions(50)
const totalPnl        = closedPositions.reduce((s, p) => s + (p.pnl ?? 0), 0)
const wavePortfolioJson: WavePortfolioJSON = { exportedAt: new Date().toISOString(), openPositions, closedPositions, totalPnl }
writeFileSync(PORTFOLIO_PATH, JSON.stringify(wavePortfolioJson, null, 2))
portfolio.close()

console.log(`[wave] Trade actions: ${actions.filter(a => a.signal !== 'no-signal').length} signals`)
```

**IMPORTANT:** Read the actual `wave-analyzer/src/exporter.ts` before editing to see the real structure. Look for: how assets are built, what the output path variable is named, where `writeFileSync` is called for waves.json. Match the existing code style.

- [ ] **Step 5: Run all wave-analyzer tests**

```bash
cd wave-analyzer && npm test
```

- [ ] **Step 6: Commit**

```bash
git add wave-analyzer/src/exporter.ts
git commit -m "feat(trade): wire action-generator into wave-analyzer exporter"
```

---

### Task A-5: Add TradePlanCard to unified-platform

**Files:**
- Modify: `unified-platform/src/lib/data.ts`
- Create: `unified-platform/src/components/capital/TradePlanCard.tsx`
- Modify: `unified-platform/src/app/capital/waves/[ticker]/page.tsx`

- [ ] **Step 1: Read current data.ts to understand the existing readWaves() pattern**

```bash
head -80 unified-platform/src/lib/data.ts
```

- [ ] **Step 2: Read the wave detail page to understand current structure**

```bash
cat "unified-platform/src/app/capital/waves/[ticker]/page.tsx"
```

- [ ] **Step 3: Add readWaveActions() to unified-platform/src/lib/data.ts**

Find where `DATA_ROOT` is defined and where other read functions are. Add after the last existing read function:

```typescript
export function readWaveActions(): import('@/types').WaveActionsJSON | null {
  try {
    return JSON.parse(readFileSync(join(DATA_ROOT, 'wave-analyzer/data/wave-actions.json'), 'utf-8'))
  } catch { return null }
}
```

Check if `WaveActionsJSON` and related types are in `unified-platform/src/types.ts`. If not, add them (same as wave-analyzer types: `TradeSignal`, `TradeAction`, `WaveActionsJSON`).

- [ ] **Step 4: Create TradePlanCard.tsx**

```tsx
// unified-platform/src/components/capital/TradePlanCard.tsx
import type { TradeAction } from '@/types'

export function TradePlanCard({ action }: { action: TradeAction }) {
  if (action.signal === 'no-signal') return null

  const signalColor =
    action.signal === 'buy'   ? 'text-green-signal' :
    action.signal === 'sell'  ? 'text-red-signal'   : 'text-amber-signal'

  const USD = (n: number) => `$${n.toLocaleString('en-US', { maximumFractionDigits: 2 })}`

  return (
    <div className="mt-5">
      <h2 className="text-[11px] font-semibold text-[#8a8f98] uppercase tracking-wider mb-2">Trade Plan</h2>
      <div className="bg-[#111318] border border-[#23252a] rounded-lg p-4 space-y-3">
        <div className="flex items-center gap-2 flex-wrap">
          <span className={`text-[11px] font-semibold uppercase tracking-wide rounded px-2 py-0.5 ${signalColor}`}
            style={{ backgroundColor: 'rgb(var(--signal-bg) / 0.13)' }}>
            {action.signal.toUpperCase()}
          </span>
          {action.riskReward != null && (
            <span className="text-[11px] text-amber-signal bg-amber-signal/10 rounded px-2 py-0.5">
              R:R {action.riskReward.toFixed(1)}×
            </span>
          )}
          <span className="text-[11px] text-text-inactive">
            Wave {action.currentWave} · {action.confidence}% confidence
          </span>
        </div>

        {action.signal !== 'watch' && action.entryZone != null && (
          <div className="grid grid-cols-3 gap-2 text-center">
            <div className="bg-[#1a2a1a] border border-green-signal/20 rounded p-2">
              <div className="text-[10px] text-text-inactive uppercase">Entry Zone</div>
              <div className="text-xs font-semibold text-green-signal mt-0.5">
                {USD(action.entryZone.low)} – {USD(action.entryZone.high)}
              </div>
            </div>
            <div className="bg-[#2a1a1a] border border-red-signal/20 rounded p-2">
              <div className="text-[10px] text-text-inactive uppercase">Stop Loss</div>
              <div className="text-xs font-semibold text-red-signal mt-0.5">
                {action.stopLoss != null ? USD(action.stopLoss) : '—'}
              </div>
            </div>
            <div className="bg-[#1a1a2a] border border-accent-primary/20 rounded p-2">
              <div className="text-[10px] text-text-inactive uppercase">Target</div>
              <div className="text-xs font-semibold text-accent-primary mt-0.5">
                {action.target != null ? USD(action.target) : '—'}
              </div>
            </div>
          </div>
        )}

        {action.narrative && (
          <p className="text-xs text-text-secondary leading-relaxed">{action.narrative}</p>
        )}
      </div>
    </div>
  )
}
```

- [ ] **Step 5: Add TradePlanCard to wave detail page**

In `unified-platform/src/app/capital/waves/[ticker]/page.tsx`, after the existing imports, add:
```tsx
import { readWaveActions } from '@/lib/data'
import { TradePlanCard } from '@/components/capital/TradePlanCard'
```

In the component body (after `readWaves()` call), add:
```tsx
const waveActions = readWaveActions()
const tradeAction = waveActions?.actions.find(a => a.ticker === ticker) ?? null
```

In the JSX, near the end of the page content (after the fib section), add:
```tsx
{tradeAction && <TradePlanCard action={tradeAction} />}
```

**IMPORTANT:** Read the actual file before editing — find the right place to inject the import, data loading, and JSX.

- [ ] **Step 6: TypeScript check**

```bash
cd unified-platform && npx tsc --noEmit 2>&1 | head -20
```

Fix any type errors.

- [ ] **Step 7: Commit**

```bash
git add unified-platform/src/lib/data.ts unified-platform/src/components/capital/TradePlanCard.tsx "unified-platform/src/app/capital/waves/[ticker]/page.tsx"
git commit -m "feat(trade): add TradePlanCard to unified-platform wave detail page"
```

---

### Task A-6: Add /trade page to capital-intel-dashboard

**Files:**
- Modify: `capital-intel-dashboard/src/lib/data.ts`
- Create: `capital-intel-dashboard/src/app/trade/page.tsx`
- Create: `capital-intel-dashboard/src/components/TradeSignalRow.tsx`
- Create: `capital-intel-dashboard/src/components/TradePositionRow.tsx`
- Modify: `capital-intel-dashboard/src/components/Sidebar.tsx`

- [ ] **Step 1: Read current capital-intel-dashboard/src/lib/data.ts**

```bash
cat capital-intel-dashboard/src/lib/data.ts
```

- [ ] **Step 2: Read Sidebar.tsx to understand the nav item format**

```bash
cat capital-intel-dashboard/src/components/Sidebar.tsx
```

- [ ] **Step 3: Add readWaveActions() and readWavePortfolio() to data.ts**

Add after existing read functions:

```typescript
export function readWaveActions(): import('../types').WaveActionsJSON | null {
  try {
    const p = join(DATA_ROOT, '../wave-analyzer/data/wave-actions.json')
    return JSON.parse(readFileSync(p, 'utf-8'))
  } catch { return null }
}

export function readWavePortfolio(): import('../types').WavePortfolioJSON | null {
  try {
    const p = join(DATA_ROOT, '../wave-analyzer/data/wave-portfolio.json')
    return JSON.parse(readFileSync(p, 'utf-8'))
  } catch { return null }
}
```

Check `capital-intel-dashboard/src/types.ts` — add `TradeSignal`, `TradeAction`, `WaveActionsJSON`, `TradePosition`, `WavePortfolioJSON` if not already there (same definitions as wave-analyzer).

- [ ] **Step 4: Create TradeSignalRow.tsx**

```tsx
// capital-intel-dashboard/src/components/TradeSignalRow.tsx
import type { TradeAction } from '../types'

const USD = (n: number) => `$${n.toLocaleString('en-US', { maximumFractionDigits: 2 })}`

export function TradeSignalRow({ action }: { action: TradeAction }) {
  const signalColor =
    action.signal === 'buy'   ? 'text-green-signal' :
    action.signal === 'sell'  ? 'text-red-signal'   : 'text-amber-signal'

  return (
    <tr className="border-b border-[#1e2026] hover:bg-[#111318]">
      <td className="px-4 py-3 text-sm font-semibold">{action.ticker}</td>
      <td className="px-4 py-3">
        <span className={`text-[11px] font-semibold uppercase rounded px-2 py-0.5 ${signalColor}`}
          style={{ backgroundColor: 'rgb(0 0 0 / 0.2)' }}>
          {action.signal}
        </span>
      </td>
      <td className="px-4 py-3 text-sm text-text-secondary">Wave {action.currentWave}</td>
      <td className="px-4 py-3 text-sm text-text-secondary">{action.confidence}%</td>
      <td className="px-4 py-3 text-sm text-text-secondary">
        {action.riskReward != null ? `${action.riskReward.toFixed(1)}×` : '—'}
      </td>
      <td className="px-4 py-3 text-xs text-text-inactive">
        {action.entryZone ? `${USD(action.entryZone.low)} – ${USD(action.entryZone.high)}` : '—'}
      </td>
      <td className="px-4 py-3 text-xs text-red-signal">
        {action.stopLoss != null ? USD(action.stopLoss) : '—'}
      </td>
      <td className="px-4 py-3 text-xs text-accent-primary">
        {action.target != null ? USD(action.target) : '—'}
      </td>
    </tr>
  )
}
```

- [ ] **Step 5: Create TradePositionRow.tsx**

```tsx
// capital-intel-dashboard/src/components/TradePositionRow.tsx
import type { TradePosition } from '../types'

const USD = (n: number) => `$${n.toLocaleString('en-US', { maximumFractionDigits: 2 })}`
const PNL = (n: number | null) => n == null ? '—' : (
  <span className={n >= 0 ? 'text-green-signal' : 'text-red-signal'}>
    {n >= 0 ? '+' : ''}{USD(n)}
  </span>
)

export function TradePositionRow({ position }: { position: TradePosition }) {
  return (
    <tr className="border-b border-[#1e2026] hover:bg-[#111318]">
      <td className="px-4 py-3 text-sm font-semibold">{position.ticker}</td>
      <td className="px-4 py-3 text-sm">
        <span className={position.signal === 'buy' ? 'text-green-signal' : 'text-red-signal'}>
          {position.signal.toUpperCase()}
        </span>
      </td>
      <td className="px-4 py-3 text-sm text-text-secondary">{USD(position.entryPrice)}</td>
      <td className="px-4 py-3 text-sm text-red-signal">{USD(position.stopLoss)}</td>
      <td className="px-4 py-3 text-sm text-accent-primary">{USD(position.target)}</td>
      <td className="px-4 py-3 text-sm text-text-secondary">{position.shares}</td>
      <td className="px-4 py-3 text-sm">{PNL(position.pnl)}</td>
    </tr>
  )
}
```

- [ ] **Step 6: Create /trade page**

```tsx
// capital-intel-dashboard/src/app/trade/page.tsx
export const dynamic = 'force-dynamic'

import { readWaveActions, readWavePortfolio } from '../../lib/data'
import { TradeSignalRow } from '../../components/TradeSignalRow'
import { TradePositionRow } from '../../components/TradePositionRow'

export default function TradePage() {
  const waveActions   = readWaveActions()
  const wavePortfolio = readWavePortfolio()

  const signals = (waveActions?.actions ?? []).filter(a => a.signal !== 'no-signal')
    .sort((a, b) => b.confidence - a.confidence || (b.riskReward ?? 0) - (a.riskReward ?? 0))

  const openPositions   = wavePortfolio?.openPositions ?? []
  const closedPositions = wavePortfolio?.closedPositions ?? []
  const totalPnl        = wavePortfolio?.totalPnl ?? 0

  return (
    <div className="p-8 max-w-7xl mx-auto space-y-8">
      <div>
        <h1 className="text-xl font-semibold text-text-primary">Trade</h1>
        <p className="text-sm text-text-inactive mt-1">Elliott Wave trade signals and open positions</p>
      </div>

      {/* Stat cards */}
      <div className="grid grid-cols-3 gap-4">
        <div className="bg-[#0e1116] border border-[#1e2026] rounded-lg p-4">
          <div className="text-[11px] text-text-inactive uppercase tracking-wider">Active Signals</div>
          <div className="text-2xl font-semibold text-text-primary mt-1">{signals.length}</div>
        </div>
        <div className="bg-[#0e1116] border border-[#1e2026] rounded-lg p-4">
          <div className="text-[11px] text-text-inactive uppercase tracking-wider">Open Positions</div>
          <div className="text-2xl font-semibold text-text-primary mt-1">{openPositions.length}</div>
        </div>
        <div className="bg-[#0e1116] border border-[#1e2026] rounded-lg p-4">
          <div className="text-[11px] text-text-inactive uppercase tracking-wider">Closed P&L</div>
          <div className={`text-2xl font-semibold mt-1 ${totalPnl >= 0 ? 'text-green-signal' : 'text-red-signal'}`}>
            {totalPnl >= 0 ? '+' : ''}${totalPnl.toLocaleString('en-US', { maximumFractionDigits: 0 })}
          </div>
        </div>
      </div>

      {/* Signals table */}
      {signals.length > 0 && (
        <div>
          <h2 className="text-[11px] font-semibold text-[#8a8f98] uppercase tracking-wider mb-3">Trade Signals</h2>
          <div className="bg-[#0e1116] border border-[#1e2026] rounded-lg overflow-hidden">
            <table className="w-full text-left">
              <thead>
                <tr className="border-b border-[#1e2026] text-[10px] text-text-inactive uppercase tracking-wider">
                  <th className="px-4 py-2">Ticker</th>
                  <th className="px-4 py-2">Signal</th>
                  <th className="px-4 py-2">Wave</th>
                  <th className="px-4 py-2">Confidence</th>
                  <th className="px-4 py-2">R:R</th>
                  <th className="px-4 py-2">Entry Zone</th>
                  <th className="px-4 py-2">Stop</th>
                  <th className="px-4 py-2">Target</th>
                </tr>
              </thead>
              <tbody>
                {signals.map(a => <TradeSignalRow key={a.ticker} action={a} />)}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Open positions */}
      {openPositions.length > 0 && (
        <div>
          <h2 className="text-[11px] font-semibold text-[#8a8f98] uppercase tracking-wider mb-3">Open Positions</h2>
          <div className="bg-[#0e1116] border border-[#1e2026] rounded-lg overflow-hidden">
            <table className="w-full text-left">
              <thead>
                <tr className="border-b border-[#1e2026] text-[10px] text-text-inactive uppercase tracking-wider">
                  <th className="px-4 py-2">Ticker</th>
                  <th className="px-4 py-2">Direction</th>
                  <th className="px-4 py-2">Entry</th>
                  <th className="px-4 py-2">Stop</th>
                  <th className="px-4 py-2">Target</th>
                  <th className="px-4 py-2">Shares</th>
                  <th className="px-4 py-2">P&L</th>
                </tr>
              </thead>
              <tbody>
                {openPositions.map(p => <TradePositionRow key={p.id} position={p} />)}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Closed trades */}
      {closedPositions.length > 0 && (
        <div>
          <h2 className="text-[11px] font-semibold text-[#8a8f98] uppercase tracking-wider mb-3">Closed Trades (last 20)</h2>
          <div className="bg-[#0e1116] border border-[#1e2026] rounded-lg overflow-hidden">
            <table className="w-full text-left">
              <thead>
                <tr className="border-b border-[#1e2026] text-[10px] text-text-inactive uppercase tracking-wider">
                  <th className="px-4 py-2">Ticker</th>
                  <th className="px-4 py-2">Direction</th>
                  <th className="px-4 py-2">Entry</th>
                  <th className="px-4 py-2">Stop</th>
                  <th className="px-4 py-2">Target</th>
                  <th className="px-4 py-2">Shares</th>
                  <th className="px-4 py-2">P&L</th>
                </tr>
              </thead>
              <tbody>
                {closedPositions.map(p => <TradePositionRow key={p.id} position={p} />)}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {signals.length === 0 && openPositions.length === 0 && (
        <div className="text-text-inactive text-sm text-center py-12">
          No wave signals or positions yet. Run <code className="font-mono text-text-secondary">npm run analyze</code> in wave-analyzer to generate signals.
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 7: Add "Trade" to Sidebar.tsx**

Read the sidebar to find the nav items array. Add `{ href: '/trade', label: 'Trade' }` between Portfolio and Discovery (or after Portfolio if Discovery is not present).

- [ ] **Step 8: TypeScript check**

```bash
cd capital-intel-dashboard && npx tsc --noEmit 2>&1 | head -30
```

Fix any type errors.

- [ ] **Step 9: Commit**

```bash
git add capital-intel-dashboard/src/lib/data.ts capital-intel-dashboard/src/app/trade/page.tsx capital-intel-dashboard/src/components/TradeSignalRow.tsx capital-intel-dashboard/src/components/TradePositionRow.tsx capital-intel-dashboard/src/components/Sidebar.tsx
git commit -m "feat(trade): add /trade page to capital-intel-dashboard"
```

---

### Task A-7: Run daily pipeline update

**This task runs the full pipeline to produce today's analysis.**

- [ ] **Step 1: Run government-flow-monitor fetch**

```bash
cd government-flow-monitor && npm run fetch
# Expected: awards: N companies, agency flows: 8, budget signals: M
# Note: budget signals may be 0 if CONGRESS_API_KEY not set — that's OK
```

- [ ] **Step 2: Verify govflow.json was created**

```bash
node -e "const g=JSON.parse(require('fs').readFileSync('government-flow-monitor/data/govflow.json','utf-8')); console.log('asOf:', g.asOf, 'awards:', g.watchlistAwards.length, 'agencies:', g.agencyFlows.length)"
```

- [ ] **Step 3: Run capital-intelligence-ingestion pipeline**

```bash
cd capital-intelligence-ingestion && npm run pipeline
# This fetches news for all watchlist companies (respects thesisUpdateDays frequency)
```

- [ ] **Step 4: Run ai-analysis-engine analysis**

```bash
cd ai-analysis-engine && npm run analyze
# Expected log output: 4 signal sources (world intel, macro assets, liquidity, gov flow)
# Produces: data/analysis.json, data/reports/2026-05-29.md
```

- [ ] **Step 5: Verify report was generated**

```bash
cat ai-analysis-engine/data/reports/2026-05-29.md | head -20
```

- [ ] **Step 6: Commit any data changes if applicable**

Do not commit data/ files. Just verify the pipeline ran.
