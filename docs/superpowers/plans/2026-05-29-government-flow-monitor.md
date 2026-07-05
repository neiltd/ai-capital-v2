# Government Money Flow Monitor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `government-flow-monitor/` — fetches USASpending.gov contract awards and Congress.gov appropriations bills, summarizes with Claude Haiku, writes `govflow.json`, then wires it into `ai-analysis-engine` as a 4th signal source.

**Architecture:** Standalone TypeScript project with three fetchers (awards, agency flows, budget bills), a Claude Haiku summarizer with bill caching, an exporter orchestrator, and a CLI entry. ai-analysis-engine gets a new `GovFlowContext` interface, `formatGovFlow()`, and updated `analyzeRegime()` + `cli-run.ts`.

**Tech Stack:** TypeScript, tsx, vitest, better-sqlite3, node-fetch (via global fetch), @anthropic-ai/sdk, dotenv

---

### Task 1: Project scaffold — package.json, tsconfig, types

**Files:**
- Create: `government-flow-monitor/package.json`
- Create: `government-flow-monitor/tsconfig.json`
- Create: `government-flow-monitor/.env.example`
- Create: `government-flow-monitor/.gitignore`
- Create: `government-flow-monitor/src/types.ts`
- Create: `government-flow-monitor/tests/types.test.ts`

- [ ] **Step 1: Write failing type shape test**

```typescript
// government-flow-monitor/tests/types.test.ts
import { describe, it, expect } from 'vitest'
import type { WatchlistAward, AgencyFlow, BudgetSignal, GovFlowJSON } from '../src/types.js'

describe('types', () => {
  it('WatchlistAward has required fields', () => {
    const a: WatchlistAward = {
      ticker: 'NVDA', company: 'NVIDIA',
      total30d: 5_000_000, awardCount: 3,
      topAgency: 'Department of Defense',
      contracts: ['AI compute infrastructure'],
    }
    expect(a.ticker).toBe('NVDA')
    expect(a.total30d).toBe(5_000_000)
  })

  it('GovFlowJSON has all arrays', () => {
    const g: GovFlowJSON = {
      exportedAt: '2026-05-29T00:00:00.000Z',
      asOf: '2026-05-29',
      watchlistAwards: [],
      agencyFlows: [],
      budgetSignals: [],
    }
    expect(g.watchlistAwards).toHaveLength(0)
  })
})
```

- [ ] **Step 2: Run test, confirm it fails**

```bash
cd government-flow-monitor && npx vitest run tests/types.test.ts
# Expected: FAIL — module not found
```

- [ ] **Step 3: Create package.json**

```json
{
  "name": "government-flow-monitor",
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "fetch": "tsx src/cli/cli-fetch.ts",
    "test": "vitest run"
  },
  "dependencies": {
    "@anthropic-ai/sdk": "^0.39.0",
    "dotenv": "^16.4.5"
  },
  "devDependencies": {
    "tsx": "^4.19.2",
    "typescript": "^5.7.3",
    "vitest": "^3.1.3",
    "@types/node": "^22.15.21"
  }
}
```

- [ ] **Step 4: Create tsconfig.json**

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
    "skipLibCheck": true
  },
  "include": ["src/**/*", "tests/**/*"]
}
```

- [ ] **Step 5: Create .env.example**

```
CONGRESS_API_KEY=your_key_here
ANTHROPIC_API_KEY=your_key_here
```

- [ ] **Step 6: Create .gitignore**

```
node_modules/
dist/
data/
.env
```

- [ ] **Step 7: Create src/types.ts**

```typescript
export interface WatchlistAward {
  ticker:     string
  company:    string
  total30d:   number
  awardCount: number
  topAgency:  string
  contracts:  string[]
}

export interface AgencyFlow {
  agency:   string
  agencyId: string
  total30d: number
  trend:    'rising' | 'stable' | 'falling'
}

export interface BudgetSignal {
  billNumber:      string
  title:           string
  congress:        number
  status:          string
  date:            string
  summary:         string
  relevantTickers: string[]
  totalFunding:    number | null
  keyProvisions:   string[]
}

export interface GovFlowJSON {
  exportedAt:      string
  asOf:            string
  watchlistAwards: WatchlistAward[]
  agencyFlows:     AgencyFlow[]
  budgetSignals:   BudgetSignal[]
}
```

- [ ] **Step 8: Install dependencies**

```bash
cd government-flow-monitor && npm install
```

- [ ] **Step 9: Run test, confirm it passes**

```bash
cd government-flow-monitor && npm test
# Expected: PASS
```

- [ ] **Step 10: Commit**

```bash
git add government-flow-monitor/
git commit -m "feat(govflow): scaffold project with types"
```

---

### Task 2: awards-fetcher.ts — USASpending.gov contract awards

**Files:**
- Create: `government-flow-monitor/src/fetchers/awards-fetcher.ts`
- Create: `government-flow-monitor/tests/awards-fetcher.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// government-flow-monitor/tests/awards-fetcher.test.ts
import { describe, it, expect, vi } from 'vitest'
import { computeAwardTrend, normalizeAwards } from '../src/fetchers/awards-fetcher.js'

describe('computeAwardTrend', () => {
  it('returns rising when current > prior * 1.1', () => {
    expect(computeAwardTrend(1100, 1000)).toBe('rising')
  })

  it('returns falling when current < prior * 0.9', () => {
    expect(computeAwardTrend(800, 1000)).toBe('falling')
  })

  it('returns stable in the middle', () => {
    expect(computeAwardTrend(1000, 1000)).toBe('stable')
  })

  it('returns stable when prior is 0', () => {
    expect(computeAwardTrend(500, 0)).toBe('stable')
  })
})

describe('normalizeAwards', () => {
  it('truncates contracts to 120 chars', () => {
    const long = 'A'.repeat(200)
    const result = normalizeAwards([{ ticker: 'X', company: 'XCo', description: long, amount: 1000, agency: 'DoD' }])
    expect(result[0].contracts[0].length).toBeLessThanOrEqual(120)
  })

  it('groups multiple awards for same ticker', () => {
    const rows = [
      { ticker: 'NVDA', company: 'NVIDIA', description: 'GPU contract', amount: 1_000_000, agency: 'DoD' },
      { ticker: 'NVDA', company: 'NVIDIA', description: 'AI compute', amount: 2_000_000, agency: 'DARPA' },
    ]
    const result = normalizeAwards(rows)
    expect(result).toHaveLength(1)
    expect(result[0].total30d).toBe(3_000_000)
    expect(result[0].awardCount).toBe(2)
  })
})
```

- [ ] **Step 2: Run to confirm failure**

```bash
cd government-flow-monitor && npm test
# Expected: FAIL
```

- [ ] **Step 3: Implement awards-fetcher.ts**

```typescript
// government-flow-monitor/src/fetchers/awards-fetcher.ts
import type { WatchlistAward, AgencyFlow } from '../types.js'

const USA_SPENDING = 'https://api.usaspending.gov/api/v2'

const FALLBACK_COMPANIES = [
  { ticker: 'MSFT', searchName: 'MICROSOFT' },
  { ticker: 'NVDA', searchName: 'NVIDIA' },
  { ticker: 'GOOGL', searchName: 'GOOGLE' },
  { ticker: 'AMZN', searchName: 'AMAZON' },
  { ticker: 'META', searchName: 'META PLATFORMS' },
  { ticker: 'AAPL', searchName: 'APPLE' },
  { ticker: 'PLTR', searchName: 'PALANTIR' },
  { ticker: 'JPM', searchName: 'JPMORGAN' },
  { ticker: 'BAC', searchName: 'BANK OF AMERICA' },
  { ticker: 'GS', searchName: 'GOLDMAN SACHS' },
]

function dateRange(daysAgo: number): { start: string; end: string } {
  const end = new Date()
  const start = new Date(end.getTime() - daysAgo * 86_400_000)
  return {
    start: start.toISOString().slice(0, 10),
    end: end.toISOString().slice(0, 10),
  }
}

export type AwardRow = { ticker: string; company: string; description: string; amount: number; agency: string }

export function normalizeAwards(rows: AwardRow[]): WatchlistAward[] {
  const map = new Map<string, WatchlistAward>()
  for (const row of rows) {
    const existing = map.get(row.ticker)
    const contract = row.description.slice(0, 120)
    if (existing) {
      existing.total30d += row.amount
      existing.awardCount += 1
      if (!existing.contracts.includes(contract) && existing.contracts.length < 3) {
        existing.contracts.push(contract)
      }
    } else {
      map.set(row.ticker, {
        ticker: row.ticker, company: row.company,
        total30d: row.amount, awardCount: 1,
        topAgency: row.agency, contracts: [contract],
      })
    }
  }
  return Array.from(map.values())
}

export function computeAwardTrend(current: number, prior: number): 'rising' | 'stable' | 'falling' {
  if (prior === 0) return 'stable'
  if (current > prior * 1.1) return 'rising'
  if (current < prior * 0.9) return 'falling'
  return 'stable'
}

async function searchAwards(searchName: string, startDate: string, endDate: string): Promise<number> {
  const body = {
    filters: {
      time_period: [{ start_date: startDate, end_date: endDate }],
      recipient_search_text: [searchName],
      award_type_codes: ['A', 'B', 'C', 'D'],
    },
    fields: ['Award Amount'],
    limit: 100,
    page: 1,
    sort: 'Award Amount',
    order: 'desc',
    subawards: false,
  }
  const res = await fetch(`${USA_SPENDING}/search/spending_by_award/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) return 0
  const data = await res.json() as any
  const results = data.results ?? []
  return results.reduce((s: number, r: any) => s + (r['Award Amount'] ?? 0), 0)
}

async function searchAwardDetail(searchName: string, startDate: string, endDate: string, ticker: string, company: string): Promise<AwardRow[]> {
  const body = {
    filters: {
      time_period: [{ start_date: startDate, end_date: endDate }],
      recipient_search_text: [searchName],
      award_type_codes: ['A', 'B', 'C', 'D'],
    },
    fields: ['Award Amount', 'Description', 'Awarding Agency'],
    limit: 5,
    page: 1,
    sort: 'Award Amount',
    order: 'desc',
    subawards: false,
  }
  try {
    const res = await fetch(`${USA_SPENDING}/search/spending_by_award/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!res.ok) return []
    const data = await res.json() as any
    return (data.results ?? []).map((r: any) => ({
      ticker, company,
      description: (r['Description'] ?? '').slice(0, 120),
      amount: r['Award Amount'] ?? 0,
      agency: r['Awarding Agency'] ?? 'Unknown',
    }))
  } catch { return [] }
}

export async function fetchWatchlistAwards(): Promise<WatchlistAward[]> {
  const { start, end } = dateRange(30)
  const rows: AwardRow[] = []
  for (const { ticker, searchName } of FALLBACK_COMPANIES) {
    try {
      const details = await searchAwardDetail(searchName, start, end, ticker, searchName)
      rows.push(...details)
    } catch { /* skip */ }
  }
  return normalizeAwards(rows)
}

export async function fetchAgencyFlows(): Promise<AgencyFlow[]> {
  const current = dateRange(30)
  const prior30End = new Date(new Date().getTime() - 30 * 86_400_000)
  const prior30Start = new Date(prior30End.getTime() - 30 * 86_400_000)
  const prior = {
    start: prior30Start.toISOString().slice(0, 10),
    end: prior30End.toISOString().slice(0, 10),
  }

  async function getTopAgencies(startDate: string, endDate: string) {
    try {
      const body = {
        category: 'awarding_agency',
        filters: {
          time_period: [{ start_date: startDate, end_date: endDate }],
          award_type_codes: ['A', 'B', 'C', 'D'],
        },
        limit: 10,
        page: 1,
      }
      const res = await fetch(`${USA_SPENDING}/search/spending_by_category/awarding_agency/`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) return []
      const data = await res.json() as any
      return (data.results ?? []) as Array<{ name: string; id: string; amount: number }>
    } catch { return [] }
  }

  const [currentResults, priorResults] = await Promise.all([
    getTopAgencies(current.start, current.end),
    getTopAgencies(prior.start, prior.end),
  ])

  const priorMap = new Map(priorResults.map(r => [r.id, r.amount]))

  return currentResults.slice(0, 8).map(r => ({
    agency: r.name,
    agencyId: String(r.id),
    total30d: r.amount,
    trend: computeAwardTrend(r.amount, priorMap.get(r.id) ?? 0),
  }))
}
```

- [ ] **Step 4: Run tests**

```bash
cd government-flow-monitor && npm test
# Expected: 5 tests PASS
```

- [ ] **Step 5: Commit**

```bash
git add government-flow-monitor/src/fetchers/awards-fetcher.ts government-flow-monitor/tests/awards-fetcher.test.ts
git commit -m "feat(govflow): add awards-fetcher with USASpending.gov"
```

---

### Task 3: budget-fetcher.ts — Congress.gov bill filtering

**Files:**
- Create: `government-flow-monitor/src/fetchers/budget-fetcher.ts`
- Create: `government-flow-monitor/tests/budget-fetcher.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// government-flow-monitor/tests/budget-fetcher.test.ts
import { describe, it, expect } from 'vitest'
import { isRelevantBill } from '../src/fetchers/budget-fetcher.js'

describe('isRelevantBill', () => {
  it('matches appropriations in title', () => {
    expect(isRelevantBill('Department of Defense Appropriations Act')).toBe(true)
  })

  it('matches CHIPS in title (case-insensitive)', () => {
    expect(isRelevantBill('chips and science act reauthorization')).toBe(true)
  })

  it('matches artificial intelligence', () => {
    expect(isRelevantBill('National Artificial Intelligence Initiative Act')).toBe(true)
  })

  it('rejects unrelated bill', () => {
    expect(isRelevantBill('Post Office Renaming Act')).toBe(false)
  })
})
```

- [ ] **Step 2: Run to confirm failure**

```bash
cd government-flow-monitor && npm test
```

- [ ] **Step 3: Implement budget-fetcher.ts**

```typescript
// government-flow-monitor/src/fetchers/budget-fetcher.ts
const CONGRESS_BASE = 'https://api.congress.gov/v3'

const RELEVANT_KEYWORDS = [
  'appropriations', 'defense authorization', 'infrastructure',
  'artificial intelligence', 'chips', 'energy', 'semiconductor',
  'cybersecurity', 'national security',
]

export function isRelevantBill(title: string): boolean {
  const lower = title.toLowerCase()
  return RELEVANT_KEYWORDS.some(kw => lower.includes(kw))
}

export interface RawBill {
  number:  string
  title:   string
  url:     string
  status:  string
  date:    string
  congress: number
}

export async function fetchRecentBills(): Promise<RawBill[]> {
  const apiKey = process.env.CONGRESS_API_KEY
  if (!apiKey) {
    console.log('[govflow] CONGRESS_API_KEY not set — skipping budget signals')
    return []
  }

  const results: RawBill[] = []

  async function fetchBillType(billType: 'hr' | 's'): Promise<void> {
    try {
      const url = `${CONGRESS_BASE}/bill?congress=119&billType=${billType}&sort=updateDate+desc&limit=50&api_key=${apiKey}`
      const res = await fetch(url)
      if (!res.ok) return
      const data = await res.json() as any
      const bills = (data.bills ?? []) as Array<{
        number: string; title: string; url: string; updateDateIncludingText: string; latestAction?: { text: string }
      }>
      for (const b of bills) {
        if (!isRelevantBill(b.title)) continue
        results.push({
          number: b.number,
          title: b.title,
          url: b.url,
          status: b.latestAction?.text ?? 'unknown',
          date: (b.updateDateIncludingText ?? '').slice(0, 10),
          congress: 119,
        })
      }
    } catch { /* skip */ }
  }

  await Promise.all([fetchBillType('hr'), fetchBillType('s')])

  return results
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, 10)
}
```

- [ ] **Step 4: Run tests**

```bash
cd government-flow-monitor && npm test
# Expected: 4 tests PASS
```

- [ ] **Step 5: Commit**

```bash
git add government-flow-monitor/src/fetchers/budget-fetcher.ts government-flow-monitor/tests/budget-fetcher.test.ts
git commit -m "feat(govflow): add budget-fetcher with Congress.gov filtering"
```

---

### Task 4: summarizer.ts — Claude Haiku bill summarizer with cache

**Files:**
- Create: `government-flow-monitor/src/summarizer.ts`
- Create: `government-flow-monitor/tests/summarizer.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// government-flow-monitor/tests/summarizer.test.ts
import { describe, it, expect, vi } from 'vitest'
import { buildNarrativeKey, mergeCacheEntry } from '../src/summarizer.js'
import type { BudgetSignal } from '../src/types.js'

describe('buildNarrativeKey', () => {
  it('builds key from billNumber and date', () => {
    expect(buildNarrativeKey('HR2670', '2026-05-01')).toBe('HR2670:2026-05-01')
  })
})

describe('mergeCacheEntry', () => {
  it('returns cached signal when key matches', () => {
    const cached: BudgetSignal = {
      billNumber: 'HR2670', title: 'Test Bill', congress: 119,
      status: 'passed', date: '2026-05-01',
      summary: 'Cached summary',
      relevantTickers: ['NVDA'], totalFunding: 1e9, keyProvisions: ['AI compute'],
    }
    const result = mergeCacheEntry('HR2670:2026-05-01', { 'HR2670:2026-05-01': cached })
    expect(result).toBe(cached)
  })

  it('returns null when key not found', () => {
    const result = mergeCacheEntry('HR9999:2026-05-01', {})
    expect(result).toBeNull()
  })
})
```

- [ ] **Step 2: Run to confirm failure**

```bash
cd government-flow-monitor && npm test
```

- [ ] **Step 3: Implement summarizer.ts**

```typescript
// government-flow-monitor/src/summarizer.ts
import Anthropic from '@anthropic-ai/sdk'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { join, dirname } from 'path'
import type { BudgetSignal } from './types.js'
import type { RawBill } from './fetchers/budget-fetcher.js'

type BillCache = Record<string, BudgetSignal>

export function buildNarrativeKey(billNumber: string, date: string): string {
  return `${billNumber}:${date}`
}

export function mergeCacheEntry(key: string, cache: BillCache): BudgetSignal | null {
  return cache[key] ?? null
}

function loadCache(cachePath: string): BillCache {
  try {
    if (!existsSync(cachePath)) return {}
    return JSON.parse(readFileSync(cachePath, 'utf-8'))
  } catch { return {} }
}

function saveCache(cachePath: string, cache: BillCache): void {
  mkdirSync(dirname(cachePath), { recursive: true })
  writeFileSync(cachePath, JSON.stringify(cache, null, 2))
}

export async function summarizeBill(
  bill: RawBill,
  watchlistTickers: string[],
  client: Anthropic,
): Promise<BudgetSignal> {
  const res = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 400,
    tools: [{
      name: 'extract_bill_signal',
      description: 'Extract structured investment signals from a congressional bill',
      input_schema: {
        type: 'object' as const,
        properties: {
          summary:         { type: 'string', description: '2-3 sentence plain-English summary' },
          relevantTickers: { type: 'array', items: { type: 'string' }, description: 'Watchlist tickers that benefit' },
          totalFunding:    { type: 'number', description: 'Total funding amount in dollars, or null' },
          keyProvisions:   { type: 'array', items: { type: 'string' }, description: '2-4 key provisions' },
        },
        required: ['summary', 'relevantTickers', 'keyProvisions'],
      },
    }],
    tool_choice: { type: 'tool', name: 'extract_bill_signal' },
    system: 'You are a government spending analyst. Extract structured investment signals from congressional bill information.',
    messages: [{
      role: 'user',
      content: `Bill: ${bill.number} — ${bill.title}\nStatus: ${bill.status} as of ${bill.date}\nWatchlist companies: ${watchlistTickers.join(', ')}\n\nExtract: (1) 2-3 sentence plain-English summary, (2) which watchlist tickers benefit, (3) total funding if mentioned, (4) 2-4 key provisions.`,
    }],
  })

  const toolBlock = res.content.find(b => b.type === 'tool_use')
  if (!toolBlock || toolBlock.type !== 'tool_use') {
    return {
      billNumber: bill.number, title: bill.title, congress: bill.congress,
      status: bill.status, date: bill.date,
      summary: bill.title, relevantTickers: [], totalFunding: null, keyProvisions: [],
    }
  }

  const input = toolBlock.input as any
  return {
    billNumber: bill.number, title: bill.title, congress: bill.congress,
    status: bill.status, date: bill.date,
    summary: input.summary ?? bill.title,
    relevantTickers: input.relevantTickers ?? [],
    totalFunding: input.totalFunding ?? null,
    keyProvisions: input.keyProvisions ?? [],
  }
}

export async function summarizeBills(
  bills: RawBill[],
  watchlistTickers: string[],
  cachePath: string,
): Promise<BudgetSignal[]> {
  if (bills.length === 0) return []

  const client = new Anthropic()
  const cache = loadCache(cachePath)
  const results: BudgetSignal[] = []
  let cacheUpdated = false

  for (const bill of bills) {
    const key = buildNarrativeKey(bill.number, bill.date)
    const cached = mergeCacheEntry(key, cache)
    if (cached) {
      results.push(cached)
      continue
    }
    try {
      const signal = await summarizeBill(bill, watchlistTickers, client)
      cache[key] = signal
      cacheUpdated = true
      results.push(signal)
    } catch (e) {
      console.error(`[govflow] Failed to summarize ${bill.number}:`, e)
    }
  }

  if (cacheUpdated) saveCache(cachePath, cache)
  return results
}
```

- [ ] **Step 4: Run tests**

```bash
cd government-flow-monitor && npm test
# Expected: 3 tests PASS
```

- [ ] **Step 5: Commit**

```bash
git add government-flow-monitor/src/summarizer.ts government-flow-monitor/tests/summarizer.test.ts
git commit -m "feat(govflow): add Haiku bill summarizer with cache"
```

---

### Task 5: exporter.ts + cli-fetch.ts

**Files:**
- Create: `government-flow-monitor/src/exporter.ts`
- Create: `government-flow-monitor/src/cli/cli-fetch.ts`
- Create: `government-flow-monitor/tests/exporter.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
// government-flow-monitor/tests/exporter.test.ts
import { describe, it, expect } from 'vitest'
import { buildGovFlow } from '../src/exporter.js'
import type { WatchlistAward, AgencyFlow, BudgetSignal } from '../src/types.js'

const award: WatchlistAward = { ticker: 'NVDA', company: 'NVIDIA', total30d: 5e6, awardCount: 2, topAgency: 'DoD', contracts: ['AI compute'] }
const agency: AgencyFlow = { agency: 'DoD', agencyId: '097', total30d: 80e9, trend: 'rising' }
const bill: BudgetSignal = { billNumber: 'HR2670', title: 'NDAA', congress: 119, status: 'passed', date: '2026-05-01', summary: 'Defense spending', relevantTickers: ['NVDA'], totalFunding: 850e9, keyProvisions: ['AI compute'] }

describe('buildGovFlow', () => {
  it('builds GovFlowJSON with correct shape', () => {
    const result = buildGovFlow([award], [agency], [bill])
    expect(result.watchlistAwards).toHaveLength(1)
    expect(result.agencyFlows).toHaveLength(1)
    expect(result.budgetSignals).toHaveLength(1)
    expect(result.exportedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(result.asOf).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('handles empty arrays', () => {
    const result = buildGovFlow([], [], [])
    expect(result.watchlistAwards).toHaveLength(0)
  })
})
```

- [ ] **Step 2: Run to confirm failure**

```bash
cd government-flow-monitor && npm test
```

- [ ] **Step 3: Implement exporter.ts**

```typescript
// government-flow-monitor/src/exporter.ts
import { writeFileSync, mkdirSync } from 'fs'
import { dirname, join } from 'path'
import { fetchWatchlistAwards, fetchAgencyFlows } from './fetchers/awards-fetcher.js'
import { fetchRecentBills } from './fetchers/budget-fetcher.js'
import { summarizeBills } from './summarizer.js'
import type { WatchlistAward, AgencyFlow, BudgetSignal, GovFlowJSON } from './types.js'

const WATCHLIST_TICKERS = ['MSFT','NVDA','GOOGL','AMZN','META','AAPL','PLTR','JPM','BAC','GS','LLY','UNH','JNJ','ABBV','MRNA']

export function buildGovFlow(
  watchlistAwards: WatchlistAward[],
  agencyFlows: AgencyFlow[],
  budgetSignals: BudgetSignal[],
): GovFlowJSON {
  return {
    exportedAt: new Date().toISOString(),
    asOf: new Date().toISOString().slice(0, 10),
    watchlistAwards,
    agencyFlows,
    budgetSignals,
  }
}

export async function exportGovFlow(outputPath: string): Promise<void> {
  const cachePath = join(dirname(outputPath), 'budget-cache.json')

  const [watchlistAwards, agencyFlows, rawBills] = await Promise.all([
    fetchWatchlistAwards(),
    fetchAgencyFlows(),
    fetchRecentBills(),
  ])

  const budgetSignals = await summarizeBills(rawBills, WATCHLIST_TICKERS, cachePath)

  const result = buildGovFlow(watchlistAwards, agencyFlows, budgetSignals)
  mkdirSync(dirname(outputPath), { recursive: true })
  writeFileSync(outputPath, JSON.stringify(result, null, 2))

  console.log(`[govflow] awards: ${watchlistAwards.length} companies, agency flows: ${agencyFlows.length}, budget signals: ${budgetSignals.length}`)
  console.log(`[govflow] Exported to ${outputPath}`)
}
```

- [ ] **Step 4: Create cli-fetch.ts**

```typescript
// government-flow-monitor/src/cli/cli-fetch.ts
import 'dotenv/config'
import { join } from 'path'
import { exportGovFlow } from '../exporter.js'

const OUTPUT = join(process.cwd(), 'data', 'govflow.json')
exportGovFlow(OUTPUT).catch(err => { console.error('[govflow] Fatal:', err); process.exit(1) })
```

- [ ] **Step 5: Run tests**

```bash
cd government-flow-monitor && npm test
# Expected: 3 tests PASS
```

- [ ] **Step 6: Commit**

```bash
git add government-flow-monitor/src/exporter.ts government-flow-monitor/src/cli/cli-fetch.ts government-flow-monitor/tests/exporter.test.ts
git commit -m "feat(govflow): add exporter and CLI"
```

---

### Task 6: Wire GovFlowContext into ai-analysis-engine

**Files:**
- Modify: `ai-analysis-engine/src/analysis/regime-analyzer.ts`
- Modify: `ai-analysis-engine/src/cli/cli-run.ts`
- Modify: `ai-analysis-engine/tests/regime-analyzer.test.ts`

- [ ] **Step 1: Write failing test for formatGovFlow**

Add to `ai-analysis-engine/tests/regime-analyzer.test.ts`:

```typescript
import type { GovFlowContext } from '../src/analysis/regime-analyzer.js'

const mockGovFlow: GovFlowContext = {
  asOf: '2026-05-29',
  watchlistAwards: [{
    ticker: 'NVDA', company: 'NVIDIA',
    total30d: 5_000_000, awardCount: 2,
    topAgency: 'Department of Defense',
    contracts: ['AI compute infrastructure for JAIC'],
  }],
  agencyFlows: [{
    agency: 'Department of Defense', total30d: 80_000_000_000, trend: 'rising',
  }],
  budgetSignals: [{
    billNumber: 'HR2670', title: 'National Defense Authorization Act',
    summary: 'The NDAA 2025 authorizes $850B for defense including AI programs.',
    relevantTickers: ['NVDA', 'PLTR'], totalFunding: 850_000_000_000,
    keyProvisions: ['AI Task Force', 'Cyber Command expansion'],
  }],
}

describe('formatGovFlow', () => {
  it('includes header with asOf date', () => {
    const result = formatGovFlow(mockGovFlow)
    expect(result).toContain('2026-05-29')
    expect(result).toContain('Government Capital Flows')
  })

  it('shows award dollar amount', () => {
    const result = formatGovFlow(mockGovFlow)
    expect(result).toContain('NVDA')
    expect(result).toContain('$5.0M')
  })

  it('shows rising trend arrow for agency', () => {
    const result = formatGovFlow(mockGovFlow)
    expect(result).toContain('↑')
  })

  it('includes bill number and tickers', () => {
    const result = formatGovFlow(mockGovFlow)
    expect(result).toContain('HR2670')
    expect(result).toContain('NVDA')
  })
})
```

Also add test for `govFlowContext` passed to `analyzeRegime`:

```typescript
it('passes govFlowContext without error', async () => {
  const mockClient = {
    messages: {
      create: vi.fn().mockResolvedValue({
        content: [{
          type: 'tool_use',
          name: 'classify_macro_regime',
          input: {
            regime: 'Defense Spending Surge', confidence: 'medium',
            rationale: 'DoD AI budget expanding.',
            keyIndicators: ['NDAA passed'], affectedTickers: ['NVDA'],
          },
        }],
      }),
    },
  }
  const result = await analyzeRegime(mockHealth, { client: mockClient as any, govFlowContext: mockGovFlow })
  expect(result.regime).toBe('Defense Spending Surge')
})
```

- [ ] **Step 2: Run to confirm failure**

```bash
cd ai-analysis-engine && npm test
```

- [ ] **Step 3: Add GovFlowContext interface and formatGovFlow to regime-analyzer.ts**

In `ai-analysis-engine/src/analysis/regime-analyzer.ts`, add after `LiquidityContext`:

```typescript
export interface GovFlowContext {
  asOf: string
  watchlistAwards: Array<{
    ticker: string; company: string; total30d: number; topAgency: string; contracts: string[]
  }>
  agencyFlows: Array<{
    agency: string; total30d: number; trend: string
  }>
  budgetSignals: Array<{
    billNumber: string; title: string; summary: string
    relevantTickers: string[]; totalFunding: number | null; keyProvisions: string[]
  }>
}
```

Add `export function formatGovFlow(gov: GovFlowContext): string` alongside `formatLiquidity`:

```typescript
export function formatGovFlow(gov: GovFlowContext): string {
  const USD = (n: number) => n >= 1e9 ? `$${(n / 1e9).toFixed(1)}B` : `$${(n / 1e6).toFixed(0)}M`
  const TREND = (t: string) => t === 'rising' ? '↑' : t === 'falling' ? '↓' : '→'

  const awardLines = gov.watchlistAwards
    .filter(a => a.total30d > 0)
    .sort((a, b) => b.total30d - a.total30d)
    .map(a => `  ${a.ticker.padEnd(6)}: ${USD(a.total30d)} from ${a.topAgency} — ${a.contracts[0] ?? ''}`)
    .join('\n')

  const agencyLines = gov.agencyFlows
    .sort((a, b) => b.total30d - a.total30d)
    .slice(0, 5)
    .map(a => `  ${a.agency.padEnd(30)}: ${USD(a.total30d)} ${TREND(a.trend)}`)
    .join('\n')

  const budgetLines = gov.budgetSignals
    .map(b => [
      `  [${b.billNumber}] ${b.title}`,
      `  ${b.summary}`,
      b.relevantTickers.length ? `  Watchlist impact: ${b.relevantTickers.join(', ')}` : '',
    ].filter(Boolean).join('\n'))
    .join('\n\n')

  const parts = [`## Government Capital Flows (as of ${gov.asOf})`]
  if (awardLines) parts.push(`### Recent Contract Awards (30d)\n${awardLines}`)
  if (agencyLines) parts.push(`### Top Agencies by Spend (30d)\n${agencyLines}`)
  if (budgetLines) parts.push(`### Budget & Appropriations Signals\n${budgetLines}`)
  return parts.join('\n\n')
}
```

Update `SYSTEM_PROMPT` to add 4th signal source:

```
4. Government capital flows — recent federal contract awards to watchlist companies and top agencies,
   plus forward-looking budget and appropriations signals. Government spending is a leading indicator:
   a DoD AI budget increase precedes contracts by 6-12 months. When watchlist companies are winning
   significant government contracts or relevant appropriations bills have passed, factor this into
   your regime assessment and mention it in the rationale.
```

Update `analyzeRegime` signature to add `govFlowContext?: GovFlowContext` to options.

Update prompt construction to inject `govFlowSection` after `liquiditySection`:

```typescript
const govFlowSection = options?.govFlowContext
  ? `\n\n${formatGovFlow(options.govFlowContext)}`
  : ''
// in prompt: `${formatHealth(health)}${macroSection}${liquiditySection}${govFlowSection}${worldSection}`
```

- [ ] **Step 4: Update cli-run.ts**

Add import:
```typescript
import type { WorldIntelContext, LiquidityContext, GovFlowContext } from '../analysis/regime-analyzer.js'
```

Add constant after `MACRO_PATH`:
```typescript
const GOV_FLOW_PATH = join(process.cwd(), '../government-flow-monitor/data/govflow.json')
```

Add function after `loadLiquidityContext()`:
```typescript
function loadGovFlow(): GovFlowContext | undefined {
  try {
    if (!existsSync(GOV_FLOW_PATH)) return undefined
    return JSON.parse(readFileSync(GOV_FLOW_PATH, 'utf-8'))
  } catch { return undefined }
}
```

Add in `run()` after liquidityContext block:
```typescript
const govFlowContext = loadGovFlow()
if (govFlowContext) {
  console.log(`  Gov flow: ${govFlowContext.watchlistAwards.length} companies, ${govFlowContext.budgetSignals.length} budget signals (as of ${govFlowContext.asOf})`)
} else {
  console.log('  Gov flow: not available')
}
```

Update analyzeRegime call:
```typescript
const regime = await analyzeRegime(health, { worldIntel, macroAssets, liquidityContext, govFlowContext })
```

- [ ] **Step 5: Run all tests**

```bash
cd ai-analysis-engine && npm test
# Expected: all pass
```

- [ ] **Step 6: Commit**

```bash
git add ai-analysis-engine/src/analysis/regime-analyzer.ts ai-analysis-engine/src/cli/cli-run.ts ai-analysis-engine/tests/regime-analyzer.test.ts
git commit -m "feat(analysis): add GovFlowContext as 4th signal source"
```

---

### Task 7: Update dependency graph

**Files:**
- Modify: `dependency-graph-engine/data/graph.json`

- [ ] **Step 1: Add government-flow-monitor nodes and edges**

In `dependency-graph-engine/data/graph.json`, add nodes:
- `{ "id": "government-flow-monitor", "label": "Government Flow Monitor", "type": "data-service" }`

Add edges:
- `{ "from": "government-flow-monitor", "to": "ai-analysis-engine", "label": "govflow.json" }`

- [ ] **Step 2: Verify JSON parses**

```bash
node -e "JSON.parse(require('fs').readFileSync('dependency-graph-engine/data/graph.json','utf-8')); console.log('OK')"
```

- [ ] **Step 3: Commit**

```bash
git add dependency-graph-engine/data/graph.json
git commit -m "feat(graph): add government-flow-monitor node"
```
