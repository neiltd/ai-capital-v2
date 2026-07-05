# Autonomous Discovery Agent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an autonomous discovery module to `scenario-simulator/` that surfaces new investment candidates daily, scores them with Claude, opens paper positions for high-conviction tickers, and exposes them in a new `/discovery` page in `capital-intel-dashboard`.

**Architecture:** Extends `scenario-simulator/src/` with a `discovery/` subdirectory (8 new files). Runs daily via `npm run discover` (cron 6:45 AM). Exports `data/discovery.json`. `capital-intel-dashboard` reads it via a new `GET /api/discovery` route and renders a new `/discovery` page.

**Tech Stack:** TypeScript + tsx, better-sqlite3, @anthropic-ai/sdk (Claude Sonnet 4.6), node-cron, vitest — all already installed in scenario-simulator. Next.js 14 (App Router) + Tailwind CSS in capital-intel-dashboard.

**Spec:** `docs/superpowers/specs/2026-05-27-autonomous-discovery-agent-design.md`

---

## File Map

**scenario-simulator — new files:**
- `src/discovery/types.ts` — all TypeScript interfaces for the discovery module
- `src/discovery/ingestion-reader.ts` — read-only access to capital-intelligence-ingestion SQLite DB
- `src/discovery/ticker-filter.ts` — dedup + filter candidates against open positions
- `src/discovery/ticker-extractor.ts` — Claude call: extract ticker mentions from news text
- `src/discovery/discovery-scorer.ts` — Claude call: batch score all candidates 0–100
- `src/discovery/discovery-analyzer.ts` — Claude call: deep 3-scenario + buy/watch per top scorer
- `src/discovery/paper-portfolio.ts` — CRUD for `discovery_positions` + `discovery_runs` in simulation.db
- `src/discovery/discovery-exporter.ts` — writes `data/discovery.json`
- `src/cli/cli-discover.ts` — entry point for `npm run discover`

**scenario-simulator — modified files:**
- `package.json` — add `"discover"` script
- `src/cli/cli-schedule.ts` — add 6:45 AM cron for discover
- `.env` — add `DISCOVERY_THRESHOLD`, `DISCOVERY_ALLOCATION`, `DISCOVERY_NEWS_DAYS`

**scenario-simulator — new test files:**
- `tests/discovery/ingestion-reader.test.ts`
- `tests/discovery/ticker-filter.test.ts`
- `tests/discovery/ticker-extractor.test.ts`
- `tests/discovery/discovery-scorer.test.ts`
- `tests/discovery/discovery-analyzer.test.ts`
- `tests/discovery/paper-portfolio.test.ts`
- `tests/discovery/discovery-exporter.test.ts`

**capital-intel-dashboard — new files:**
- `src/app/api/discovery/route.ts` — `GET /api/discovery`
- `src/components/DiscoveryCandidateRow.tsx`
- `src/app/discovery/page.tsx`

**capital-intel-dashboard — modified files:**
- `src/types.ts` — add `DiscoveryJSON`, `DiscoveryPosition`, `DiscoveryScenario`, `DiscoveryAction`, `DiscoveryCandidate`, `DiscoveryResponse`
- `src/lib/data.ts` — add `readDiscovery()`
- `src/components/Sidebar.tsx` — add Discovery nav entry

---

## Task 1: TypeScript types

**Files:**
- Create: `scenario-simulator/src/discovery/types.ts`

- [ ] **Step 1: Create types.ts**

```ts
// scenario-simulator/src/discovery/types.ts
export type DiscoverySource = 'companies_table' | 'news_mention'

export interface DiscoveryCandidate {
  ticker:      string
  company:     string
  source:      DiscoverySource
  newsSnippet: string | null   // null for companies_table source
}

export interface ScoredCandidate {
  ticker:    string
  company:   string
  source:    DiscoverySource
  score:     number            // 0–100
  rationale: string            // one sentence from Claude
}

export interface DiscoveryScenario {
  id:               string
  ticker:           string     // which discovery candidate this belongs to
  date:             string
  scenarioType:     'best' | 'base' | 'disruption'
  title:            string
  narrative:        string
  timeHorizon:      string
  probability:      number
  regimeTransition: string | null
  triggers:         string[]
  createdAt:        string
}

export interface DiscoveryAction {
  ticker:         string
  recommendation: 'buy' | 'watch'
  conviction:     'high' | 'medium' | 'low'
  rationale:      string
}

export interface DiscoveryPosition {
  ticker:        string
  company:       string
  shares:        number
  avgCost:       number
  currentPrice:  number
  currentValue:  number
  unrealizedPnl: number
  score:         number
  source:        DiscoverySource
  rationale:     string
  openedAt:      string        // ISO date
  updatedAt:     string        // ISO timestamp
}

export interface DiscoveryRun {
  id:              string
  date:            string
  candidatesFound: number
  passedFilter:    number
  positionsOpened: number
  threshold:       number
  durationMs:      number
  createdAt:       string
}

export interface DiscoveryExportCandidate {
  ticker:      string
  company:     string
  score:       number
  rationale:   string
  source:      DiscoverySource
  discoveredAt:string
  action:      'buy' | 'watch'
}

export interface DiscoveryJSON {
  exportedAt: string
  config: {
    threshold:       number
    paperAllocation: number
    newsDays:        number
  }
  candidates:         DiscoveryExportCandidate[]
  discoveryPortfolio: DiscoveryPosition[]
  scenarios:          DiscoveryScenario[]
  actions:            DiscoveryAction[]
}
```

- [ ] **Step 2: Commit**

```bash
cd scenario-simulator
git add src/discovery/types.ts
git commit -m "feat(discovery): add TypeScript types"
```

---

## Task 2: Ingestion reader

**Files:**
- Create: `scenario-simulator/src/discovery/ingestion-reader.ts`
- Create: `scenario-simulator/tests/discovery/ingestion-reader.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// scenario-simulator/tests/discovery/ingestion-reader.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, rmSync } from 'fs'
import { join } from 'path'
import Database from 'better-sqlite3'
import { createIngestionReader } from '../../src/discovery/ingestion-reader.js'

const TEST_DIR = 'tests/tmp-ingestion'
const DB_PATH  = join(TEST_DIR, 'ingestion-test.db')

function makeTestDb() {
  const db = new Database(DB_PATH)
  db.exec(`
    CREATE TABLE companies (
      ticker TEXT PRIMARY KEY, company TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE raw_documents (
      id TEXT PRIMARY KEY, ticker TEXT NOT NULL, company TEXT NOT NULL,
      source TEXT NOT NULL, doc_type TEXT NOT NULL,
      published_date TEXT NOT NULL, content TEXT NOT NULL
    );
  `)
  db.prepare('INSERT INTO companies VALUES (?,?,?)').run('NVDA', 'NVIDIA', 1)
  db.prepare('INSERT INTO companies VALUES (?,?,?)').run('MSFT', 'Microsoft', 1)
  db.prepare('INSERT INTO companies VALUES (?,?,?)').run('INTC', 'Intel', 0)
  db.prepare('INSERT INTO raw_documents VALUES (?,?,?,?,?,?,?)').run(
    'doc1', 'NVDA', 'NVIDIA', 'news', 'article',
    new Date().toISOString().slice(0, 10), 'NVDA article content'
  )
  db.prepare('INSERT INTO raw_documents VALUES (?,?,?,?,?,?,?)').run(
    'doc2', 'MSFT', 'Microsoft', 'news', 'article',
    '2020-01-01', 'Old article'
  )
  db.close()
}

beforeEach(() => { mkdirSync(TEST_DIR, { recursive: true }); makeTestDb() })
afterEach(() => { try { rmSync(TEST_DIR, { recursive: true }) } catch {} })

describe('IngestionReader', () => {
  it('returns active companies excluding filtered tickers', () => {
    const reader = createIngestionReader(DB_PATH)
    const candidates = reader.getTrackedTickers(['NVDA'])
    reader.close()
    expect(candidates).toHaveLength(1)
    expect(candidates[0].ticker).toBe('MSFT')
    expect(candidates[0].source).toBe('companies_table')
    expect(candidates[0].newsSnippet).toBeNull()
  })

  it('skips inactive companies', () => {
    const reader = createIngestionReader(DB_PATH)
    const candidates = reader.getTrackedTickers([])
    reader.close()
    const tickers = candidates.map(c => c.ticker)
    expect(tickers).not.toContain('INTC')
  })

  it('returns recent news within daysBack window', () => {
    const reader = createIngestionReader(DB_PATH)
    const news = reader.getRecentNews(7)
    reader.close()
    expect(news).toHaveLength(1)
    expect(news[0].ticker).toBe('NVDA')
  })

  it('throws if DB file does not exist', () => {
    expect(() => createIngestionReader('/nonexistent/path.db')).toThrow()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd scenario-simulator && npx vitest run tests/discovery/ingestion-reader.test.ts
```

Expected: FAIL — `createIngestionReader` not found.

- [ ] **Step 3: Implement ingestion-reader.ts**

```ts
// scenario-simulator/src/discovery/ingestion-reader.ts
import Database from 'better-sqlite3'
import { existsSync } from 'fs'
import type { DiscoveryCandidate } from './types.js'

export interface IngestionReader {
  getTrackedTickers(excludeTickers: string[]): DiscoveryCandidate[]
  getRecentNews(daysBack: number): Array<{ ticker: string; company: string; content: string; publishedDate: string }>
  close(): void
}

export function createIngestionReader(dbPath: string): IngestionReader {
  if (!existsSync(dbPath)) throw new Error(`Ingestion DB not found: ${dbPath}`)
  const db = new Database(dbPath, { readonly: true })

  return {
    getTrackedTickers(excludeTickers) {
      const placeholders = excludeTickers.length
        ? excludeTickers.map(() => '?').join(',')
        : 'NULL'
      const sql = excludeTickers.length
        ? `SELECT ticker, company FROM companies WHERE active = 1 AND ticker NOT IN (${placeholders})`
        : `SELECT ticker, company FROM companies WHERE active = 1`
      type Row = { ticker: string; company: string }
      const rows = (excludeTickers.length
        ? db.prepare(sql).all(...excludeTickers)
        : db.prepare(sql).all()) as Row[]
      return rows.map(r => ({ ticker: r.ticker, company: r.company, source: 'companies_table', newsSnippet: null }))
    },

    getRecentNews(daysBack) {
      type Row = { ticker: string; company: string; content: string; published_date: string }
      const rows = db.prepare(`
        SELECT ticker, company, SUBSTR(content, 1, 500) AS content, published_date
        FROM raw_documents
        WHERE source = 'news'
          AND published_date >= date('now', '-' || ? || ' days')
        ORDER BY published_date DESC
      `).all(daysBack) as Row[]
      return rows.map(r => ({
        ticker: r.ticker, company: r.company,
        content: r.content, publishedDate: r.published_date,
      }))
    },

    close() { db.close() },
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd scenario-simulator && npx vitest run tests/discovery/ingestion-reader.test.ts
```

Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
cd scenario-simulator
git add src/discovery/ingestion-reader.ts tests/discovery/ingestion-reader.test.ts
git commit -m "feat(discovery): add ingestion-reader with read-only SQLite access"
```

---

## Task 3: Ticker filter

**Files:**
- Create: `scenario-simulator/src/discovery/ticker-filter.ts`
- Create: `scenario-simulator/tests/discovery/ticker-filter.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// scenario-simulator/tests/discovery/ticker-filter.test.ts
import { describe, it, expect } from 'vitest'
import { filterCandidates } from '../../src/discovery/ticker-filter.js'
import type { DiscoveryCandidate } from '../../src/discovery/types.js'

const make = (ticker: string, source: 'companies_table' | 'news_mention' = 'companies_table'): DiscoveryCandidate =>
  ({ ticker, company: `${ticker} Corp`, source, newsSnippet: null })

describe('filterCandidates', () => {
  it('removes duplicates keeping first occurrence', () => {
    const input = [make('NVDA'), make('NVDA', 'news_mention'), make('MSFT')]
    const result = filterCandidates(input, new Set())
    expect(result).toHaveLength(2)
    expect(result[0].ticker).toBe('NVDA')
    expect(result[0].source).toBe('companies_table')
  })

  it('removes tickers already in open discovery positions', () => {
    const input = [make('NVDA'), make('MSFT'), make('AAPL')]
    const result = filterCandidates(input, new Set(['NVDA', 'MSFT']))
    expect(result).toHaveLength(1)
    expect(result[0].ticker).toBe('AAPL')
  })

  it('returns empty array when all candidates are filtered', () => {
    const input = [make('NVDA')]
    expect(filterCandidates(input, new Set(['NVDA']))).toHaveLength(0)
  })

  it('returns all candidates when nothing to filter', () => {
    const input = [make('NVDA'), make('MSFT')]
    expect(filterCandidates(input, new Set())).toHaveLength(2)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd scenario-simulator && npx vitest run tests/discovery/ticker-filter.test.ts
```

Expected: FAIL — `filterCandidates` not found.

- [ ] **Step 3: Implement ticker-filter.ts**

```ts
// scenario-simulator/src/discovery/ticker-filter.ts
import type { DiscoveryCandidate } from './types.js'

export function filterCandidates(
  candidates: DiscoveryCandidate[],
  openDiscoveryTickers: Set<string>,
): DiscoveryCandidate[] {
  const seen = new Set<string>()
  const result: DiscoveryCandidate[] = []
  for (const c of candidates) {
    if (!seen.has(c.ticker) && !openDiscoveryTickers.has(c.ticker)) {
      seen.add(c.ticker)
      result.push(c)
    }
  }
  return result
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd scenario-simulator && npx vitest run tests/discovery/ticker-filter.test.ts
```

Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
cd scenario-simulator
git add src/discovery/ticker-filter.ts tests/discovery/ticker-filter.test.ts
git commit -m "feat(discovery): add ticker-filter dedup utility"
```

---

## Task 4: Ticker extractor (Claude call)

**Files:**
- Create: `scenario-simulator/src/discovery/ticker-extractor.ts`
- Create: `scenario-simulator/tests/discovery/ticker-extractor.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// scenario-simulator/tests/discovery/ticker-extractor.test.ts
import { describe, it, expect, vi } from 'vitest'
import { extractTickers } from '../../src/discovery/ticker-extractor.js'

const mockClient = {
  messages: {
    create: vi.fn().mockResolvedValue({
      content: [{
        type: 'tool_use',
        input: {
          mentions: [
            { ticker: 'SMCI', company: 'Super Micro Computer', snippet: 'SMCI benefits from AI server demand' },
            { ticker: 'CRUS', company: 'Cirrus Logic', snippet: 'CRUS wins Apple audio chip contract' },
          ],
        },
      }],
    }),
  },
}

describe('extractTickers', () => {
  it('returns DiscoveryCandidate[] with source news_mention', async () => {
    const news = [
      { ticker: 'NVDA', company: 'NVIDIA', content: 'SMCI benefits from AI server demand', publishedDate: '2026-05-27' },
      { ticker: 'AAPL', company: 'Apple', content: 'CRUS wins Apple audio chip contract', publishedDate: '2026-05-27' },
    ]
    // @ts-expect-error mock
    const results = await extractTickers(news, ['NVDA', 'AAPL'], { client: mockClient })
    expect(results).toHaveLength(2)
    expect(results[0].ticker).toBe('SMCI')
    expect(results[0].source).toBe('news_mention')
    expect(results[0].newsSnippet).toBe('SMCI benefits from AI server demand')
    expect(results[1].ticker).toBe('CRUS')
  })

  it('returns empty array when Claude returns no mentions', async () => {
    const emptyClient = {
      messages: { create: vi.fn().mockResolvedValue({ content: [{ type: 'tool_use', input: { mentions: [] } }] }) },
    }
    // @ts-expect-error mock
    const results = await extractTickers([], [], { client: emptyClient })
    expect(results).toHaveLength(0)
  })

  it('throws if Claude does not return tool_use', async () => {
    const badClient = {
      messages: { create: vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'oops' }] }) },
    }
    // @ts-expect-error mock
    await expect(extractTickers([{ ticker: 'X', company: 'X', content: 'x', publishedDate: '2026-05-27' }], [], { client: badClient }))
      .rejects.toThrow('Expected tool_use')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd scenario-simulator && npx vitest run tests/discovery/ticker-extractor.test.ts
```

Expected: FAIL — `extractTickers` not found.

- [ ] **Step 3: Implement ticker-extractor.ts**

```ts
// scenario-simulator/src/discovery/ticker-extractor.ts
import Anthropic from '@anthropic-ai/sdk'
import type { DiscoveryCandidate } from './types.js'

const SYSTEM_PROMPT = `You are a financial research analyst. Extract US-listed stock ticker symbols mentioned in the provided news documents that could be investment candidates. Only include tickers that appear to be publicly traded US equities with clear investment relevance. Do not include tickers in the provided exclusion list.`

const EXTRACT_TICKERS_TOOL: Anthropic.Tool = {
  name: 'extract_tickers',
  description: 'Extract ticker symbols of US-listed stocks mentioned in the news documents',
  input_schema: {
    type: 'object',
    properties: {
      mentions: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            ticker:  { type: 'string', description: 'US stock ticker symbol, e.g. SMCI' },
            company: { type: 'string', description: 'Full company name' },
            snippet: { type: 'string', description: '1-2 sentence excerpt mentioning this ticker' },
          },
          required: ['ticker', 'company', 'snippet'],
        },
      },
    },
    required: ['mentions'],
  },
}

export async function extractTickers(
  news: Array<{ ticker: string; company: string; content: string; publishedDate: string }>,
  excludeTickers: string[],
  options: { client?: Anthropic },
): Promise<DiscoveryCandidate[]> {
  if (news.length === 0) return []

  const client = options.client ?? new Anthropic()

  const grouped = new Map<string, string>()
  for (const doc of news) {
    if (!grouped.has(doc.ticker)) grouped.set(doc.ticker, doc.content.slice(0, 500))
  }

  const docsText = Array.from(grouped.entries())
    .map(([ticker, content]) => `[${ticker}] ${content}`)
    .join('\n\n')

  const userContent = [
    `Exclusion list (do not extract these): ${excludeTickers.join(', ') || 'none'}`,
    '',
    'News documents to analyze:',
    docsText,
  ].join('\n')

  const message = await client.messages.create({
    model:       'claude-sonnet-4-6',
    max_tokens:  2048,
    system:      [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
    tools:       [EXTRACT_TICKERS_TOOL],
    tool_choice: { type: 'tool', name: 'extract_tickers' },
    messages:    [{ role: 'user', content: userContent }],
  })

  const toolUse = message.content.find(b => b.type === 'tool_use')
  if (!toolUse || toolUse.type !== 'tool_use') throw new Error('Expected tool_use response from Claude')

  const input = toolUse.input as {
    mentions: Array<{ ticker: string; company: string; snippet: string }>
  }

  return input.mentions.map(m => ({
    ticker:      m.ticker.toUpperCase(),
    company:     m.company,
    source:      'news_mention',
    newsSnippet: m.snippet,
  }))
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd scenario-simulator && npx vitest run tests/discovery/ticker-extractor.test.ts
```

Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
cd scenario-simulator
git add src/discovery/ticker-extractor.ts tests/discovery/ticker-extractor.test.ts
git commit -m "feat(discovery): add ticker-extractor Claude call"
```

---

## Task 5: Discovery scorer (Claude light filter)

**Files:**
- Create: `scenario-simulator/src/discovery/discovery-scorer.ts`
- Create: `scenario-simulator/tests/discovery/discovery-scorer.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// scenario-simulator/tests/discovery/discovery-scorer.test.ts
import { describe, it, expect, vi } from 'vitest'
import { scoreCandidates } from '../../src/discovery/discovery-scorer.js'
import type { DiscoveryCandidate } from '../../src/discovery/types.js'

const candidates: DiscoveryCandidate[] = [
  { ticker: 'SMCI', company: 'Super Micro Computer', source: 'news_mention', newsSnippet: 'AI server demand' },
  { ticker: 'CRUS', company: 'Cirrus Logic', source: 'companies_table', newsSnippet: null },
]

const mockClient = {
  messages: {
    create: vi.fn().mockResolvedValue({
      content: [{
        type: 'tool_use',
        input: {
          scores: [
            { ticker: 'SMCI', score: 82, rationale: 'Strong AI infrastructure signal' },
            { ticker: 'CRUS', score: 45, rationale: 'Limited recent catalyst' },
          ],
        },
      }],
    }),
  },
}

const regime = { regime: 'AI Acceleration', confidence: 'high' }

describe('scoreCandidates', () => {
  it('returns ScoredCandidate[] with score and rationale', async () => {
    // @ts-expect-error mock
    const results = await scoreCandidates(candidates, regime, { client: mockClient })
    expect(results).toHaveLength(2)
    expect(results[0].ticker).toBe('SMCI')
    expect(results[0].score).toBe(82)
    expect(typeof results[0].rationale).toBe('string')
    expect(results[0].source).toBe('news_mention')
  })

  it('preserves source and company from input candidates', async () => {
    // @ts-expect-error mock
    const results = await scoreCandidates(candidates, regime, { client: mockClient })
    expect(results[1].source).toBe('companies_table')
    expect(results[1].company).toBe('Cirrus Logic')
  })

  it('throws if Claude does not return tool_use', async () => {
    const badClient = {
      messages: { create: vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'oops' }] }) },
    }
    // @ts-expect-error mock
    await expect(scoreCandidates(candidates, regime, { client: badClient }))
      .rejects.toThrow('Expected tool_use')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd scenario-simulator && npx vitest run tests/discovery/discovery-scorer.test.ts
```

Expected: FAIL — `scoreCandidates` not found.

- [ ] **Step 3: Implement discovery-scorer.ts**

```ts
// scenario-simulator/src/discovery/discovery-scorer.ts
import Anthropic from '@anthropic-ai/sdk'
import type { DiscoveryCandidate, ScoredCandidate } from './types.js'

const SYSTEM_PROMPT = `You are a technology investment analyst screening stocks for portfolio fit. The investor focuses on AI infrastructure, semiconductors, and emerging tech. Score each ticker 0–100 based on: recent news signal strength, sector fit, momentum, and data availability. Be conservative — only score ≥ 70 if there is a clear, specific reason to investigate further.`

const SCORE_TOOL: Anthropic.Tool = {
  name: 'score_candidates',
  description: 'Score each candidate ticker for investment relevance',
  input_schema: {
    type: 'object',
    properties: {
      scores: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            ticker:    { type: 'string' },
            score:     { type: 'integer', minimum: 0, maximum: 100 },
            rationale: { type: 'string', description: 'One sentence explaining the score' },
          },
          required: ['ticker', 'score', 'rationale'],
        },
      },
    },
    required: ['scores'],
  },
}

export async function scoreCandidates(
  candidates: DiscoveryCandidate[],
  regime: { regime: string; confidence: string },
  options: { client?: Anthropic },
): Promise<ScoredCandidate[]> {
  const client = options.client ?? new Anthropic()

  const candidateText = candidates.map(c => {
    const snippet = c.newsSnippet ? `\n  Snippet: ${c.newsSnippet}` : '\n  Source: tracked companies list'
    return `- ${c.ticker} (${c.company}) [${c.source}]${snippet}`
  }).join('\n')

  const userContent = [
    `Current macro regime: ${regime.regime} (${regime.confidence} confidence)`,
    '',
    'Candidates to score:',
    candidateText,
  ].join('\n')

  const message = await client.messages.create({
    model:       'claude-sonnet-4-6',
    max_tokens:  2048,
    system:      [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
    tools:       [SCORE_TOOL],
    tool_choice: { type: 'tool', name: 'score_candidates' },
    messages:    [{ role: 'user', content: userContent }],
  })

  const toolUse = message.content.find(b => b.type === 'tool_use')
  if (!toolUse || toolUse.type !== 'tool_use') throw new Error('Expected tool_use response from Claude')

  const input = toolUse.input as {
    scores: Array<{ ticker: string; score: number; rationale: string }>
  }

  const candidateMap = new Map(candidates.map(c => [c.ticker, c]))

  return input.scores.map(s => {
    const c = candidateMap.get(s.ticker) ?? { ticker: s.ticker, company: s.ticker, source: 'news_mention' as const, newsSnippet: null }
    return { ticker: s.ticker, company: c.company, source: c.source, score: s.score, rationale: s.rationale }
  })
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd scenario-simulator && npx vitest run tests/discovery/discovery-scorer.test.ts
```

Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
cd scenario-simulator
git add src/discovery/discovery-scorer.ts tests/discovery/discovery-scorer.test.ts
git commit -m "feat(discovery): add discovery-scorer batch Claude call"
```

---

## Task 6: Discovery analyzer (Claude deep analysis)

**Files:**
- Create: `scenario-simulator/src/discovery/discovery-analyzer.ts`
- Create: `scenario-simulator/tests/discovery/discovery-analyzer.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// scenario-simulator/tests/discovery/discovery-analyzer.test.ts
import { describe, it, expect, vi } from 'vitest'
import { analyzeTicker } from '../../src/discovery/discovery-analyzer.js'
import type { ScoredCandidate } from '../../src/discovery/types.js'

const candidate: ScoredCandidate = {
  ticker: 'SMCI', company: 'Super Micro Computer',
  source: 'news_mention', score: 82, rationale: 'AI server demand',
}

const mockClient = {
  messages: {
    create: vi.fn().mockResolvedValue({
      content: [{
        type: 'tool_use',
        input: {
          scenarios: [
            { scenarioType: 'best',       title: 'AI Supercycle',      narrative: 'Hyperscalers...', timeHorizon: '3-6 months', probability: 60, regimeTransition: null, triggers: ['capex beat'] },
            { scenarioType: 'base',       title: 'Steady Growth',      narrative: 'Modest revenue...', timeHorizon: '6-12 months', probability: 50, regimeTransition: null, triggers: ['stable orders'] },
            { scenarioType: 'disruption', title: 'Audit Risk Returns', narrative: 'SEC reopens...', timeHorizon: '3-6 months', probability: 20, regimeTransition: null, triggers: ['SEC inquiry'] },
          ],
          action: { recommendation: 'buy', conviction: 'high', rationale: 'Strong AI server tailwind' },
        },
      }],
    }),
  },
}

const analysis = {
  latestRegime: { regime: 'AI Acceleration', confidence: 'high', rationale: '', keyIndicators: [], affectedTickers: [] },
  latestSignals: [],
  companySummaries: [],
  exportedAt: '',
}

describe('analyzeTicker', () => {
  it('returns exactly 3 DiscoveryScenario objects with the ticker field set', async () => {
    // @ts-expect-error mock
    const result = await analyzeTicker(candidate, 195.31, analysis, { client: mockClient })
    expect(result.scenarios).toHaveLength(3)
    expect(result.scenarios.every(s => s.ticker === 'SMCI')).toBe(true)
    expect(result.scenarios.map(s => s.scenarioType)).toEqual(['best', 'base', 'disruption'])
  })

  it('returns a DiscoveryAction with recommendation buy or watch', async () => {
    // @ts-expect-error mock
    const result = await analyzeTicker(candidate, 195.31, analysis, { client: mockClient })
    expect(['buy', 'watch']).toContain(result.action.recommendation)
    expect(['high', 'medium', 'low']).toContain(result.action.conviction)
  })

  it('throws if Claude does not return tool_use', async () => {
    const badClient = {
      messages: { create: vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'oops' }] }) },
    }
    // @ts-expect-error mock
    await expect(analyzeTicker(candidate, 195.31, analysis, { client: badClient }))
      .rejects.toThrow('Expected tool_use')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd scenario-simulator && npx vitest run tests/discovery/discovery-analyzer.test.ts
```

Expected: FAIL — `analyzeTicker` not found.

- [ ] **Step 3: Implement discovery-analyzer.ts**

```ts
// scenario-simulator/src/discovery/discovery-analyzer.ts
import Anthropic from '@anthropic-ai/sdk'
import { randomUUID } from 'crypto'
import type { ScoredCandidate, DiscoveryScenario, DiscoveryAction } from './types.js'
import type { AnalysisJSON } from '../types.js'

const SYSTEM_PROMPT = `You are a forward-looking technology investment strategist. Generate scenarios using the analyze_discovery_ticker tool based on the provided macro regime and the ticker's specific news signal. Ground each scenario in specific evidence from the provided context. Produce exactly 3 scenarios: best, base, disruption.`

const ANALYZE_TOOL: Anthropic.Tool = {
  name: 'analyze_discovery_ticker',
  description: 'Generate 3 scenarios and a buy/watch recommendation for a discovery candidate',
  input_schema: {
    type: 'object',
    properties: {
      scenarios: {
        type: 'array',
        description: 'Exactly 3 scenarios: best, base, disruption',
        items: {
          type: 'object',
          properties: {
            scenarioType:     { type: 'string', enum: ['best', 'base', 'disruption'] },
            title:            { type: 'string' },
            narrative:        { type: 'string', description: '2-3 paragraph forward-looking description' },
            timeHorizon:      { type: 'string' },
            probability:      { type: 'integer', minimum: 0, maximum: 100 },
            regimeTransition: { type: ['string', 'null'] },
            triggers:         { type: 'array', items: { type: 'string' } },
          },
          required: ['scenarioType', 'title', 'narrative', 'timeHorizon', 'probability', 'regimeTransition', 'triggers'],
        },
      },
      action: {
        type: 'object',
        properties: {
          recommendation: { type: 'string', enum: ['buy', 'watch'] },
          conviction:     { type: 'string', enum: ['high', 'medium', 'low'] },
          rationale:      { type: 'string', description: '1-2 sentences explaining the recommendation' },
        },
        required: ['recommendation', 'conviction', 'rationale'],
      },
    },
    required: ['scenarios', 'action'],
  },
}

export async function analyzeTicker(
  candidate: ScoredCandidate,
  currentPrice: number,
  analysis: AnalysisJSON,
  options: { client?: Anthropic },
): Promise<{ scenarios: DiscoveryScenario[]; action: DiscoveryAction }> {
  const client = options.client ?? new Anthropic()
  const today  = new Date().toISOString().slice(0, 10)
  const now    = new Date().toISOString()

  const regime = analysis.latestRegime
  const userContent = [
    `Ticker: ${candidate.ticker} (${candidate.company})`,
    `Score: ${candidate.score} — ${candidate.rationale}`,
    candidate.newsSnippet ? `News context: ${candidate.newsSnippet}` : 'Source: tracked companies list',
    `Current price: $${currentPrice.toFixed(2)}`,
    '',
    `Current macro regime: ${regime.regime} (${regime.confidence} confidence)`,
    regime.rationale ? `Rationale: ${regime.rationale}` : '',
    regime.keyIndicators?.length ? `Key indicators: ${regime.keyIndicators.join(', ')}` : '',
  ].filter(Boolean).join('\n')

  const message = await client.messages.create({
    model:       'claude-sonnet-4-6',
    max_tokens:  4096,
    system:      [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
    tools:       [ANALYZE_TOOL],
    tool_choice: { type: 'tool', name: 'analyze_discovery_ticker' },
    messages:    [{ role: 'user', content: userContent }],
  })

  const toolUse = message.content.find(b => b.type === 'tool_use')
  if (!toolUse || toolUse.type !== 'tool_use') throw new Error('Expected tool_use response from Claude')

  const input = toolUse.input as {
    scenarios: Array<{
      scenarioType: string; title: string; narrative: string; timeHorizon: string
      probability: number; regimeTransition: string | null; triggers: string[]
    }>
    action: { recommendation: string; conviction: string; rationale: string }
  }

  const scenarios: DiscoveryScenario[] = input.scenarios.map(s => ({
    id:               randomUUID(),
    ticker:           candidate.ticker,
    date:             today,
    scenarioType:     s.scenarioType as DiscoveryScenario['scenarioType'],
    title:            s.title,
    narrative:        s.narrative,
    timeHorizon:      s.timeHorizon,
    probability:      s.probability,
    regimeTransition: typeof s.regimeTransition === 'string' ? s.regimeTransition : null,
    triggers:         s.triggers,
    createdAt:        now,
  }))

  const action: DiscoveryAction = {
    ticker:         candidate.ticker,
    recommendation: input.action.recommendation as 'buy' | 'watch',
    conviction:     input.action.conviction as 'high' | 'medium' | 'low',
    rationale:      input.action.rationale,
  }

  return { scenarios, action }
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd scenario-simulator && npx vitest run tests/discovery/discovery-analyzer.test.ts
```

Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
cd scenario-simulator
git add src/discovery/discovery-analyzer.ts tests/discovery/discovery-analyzer.test.ts
git commit -m "feat(discovery): add discovery-analyzer deep Claude call"
```

---

## Task 7: Paper portfolio

**Files:**
- Create: `scenario-simulator/src/discovery/paper-portfolio.ts`
- Create: `scenario-simulator/tests/discovery/paper-portfolio.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// scenario-simulator/tests/discovery/paper-portfolio.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, rmSync } from 'fs'
import { join } from 'path'
import { createPaperPortfolio } from '../../src/discovery/paper-portfolio.js'

const TEST_DIR = 'tests/tmp-paper-portfolio'
const DB_PATH  = join(TEST_DIR, 'sim-test.db')

beforeEach(() => { mkdirSync(TEST_DIR, { recursive: true }) })
afterEach(() => { try { rmSync(TEST_DIR, { recursive: true }) } catch {} })

describe('PaperPortfolio', () => {
  it('opens a paper position and reads it back', () => {
    const pp = createPaperPortfolio(DB_PATH)
    pp.openPosition('SMCI', 'Super Micro Computer', 5.12, 195.31, 82, 'news_mention', 'AI server demand')
    const positions = pp.getPositions()
    pp.close()

    expect(positions).toHaveLength(1)
    expect(positions[0].ticker).toBe('SMCI')
    expect(positions[0].shares).toBe(5.12)
    expect(positions[0].avgCost).toBe(195.31)
    expect(positions[0].score).toBe(82)
    expect(positions[0].source).toBe('news_mention')
    expect(positions[0].currentPrice).toBe(0)
  })

  it('openPosition is a no-op if ticker already exists', () => {
    const pp = createPaperPortfolio(DB_PATH)
    pp.openPosition('SMCI', 'Super Micro', 5.12, 195.31, 82, 'news_mention', 'first')
    pp.openPosition('SMCI', 'Super Micro', 10.0, 200.00, 90, 'companies_table', 'second')
    const positions = pp.getPositions()
    pp.close()

    expect(positions).toHaveLength(1)
    expect(positions[0].shares).toBe(5.12)   // original preserved
    expect(positions[0].rationale).toBe('first')
  })

  it('updatePrices recomputes currentValue and unrealizedPnl', () => {
    const pp = createPaperPortfolio(DB_PATH)
    pp.openPosition('SMCI', 'Super Micro Computer', 5.12, 195.31, 82, 'news_mention', 'AI demand')
    pp.updatePrices({ SMCI: 210.50 })
    const positions = pp.getPositions()
    pp.close()

    expect(positions[0].currentPrice).toBe(210.50)
    expect(positions[0].currentValue).toBeCloseTo(5.12 * 210.50)
    expect(positions[0].unrealizedPnl).toBeCloseTo(5.12 * (210.50 - 195.31))
  })

  it('getOpenTickers returns a Set of all held ticker symbols', () => {
    const pp = createPaperPortfolio(DB_PATH)
    pp.openPosition('SMCI', 'Super Micro', 5, 195, 82, 'news_mention', 'x')
    pp.openPosition('CRUS', 'Cirrus Logic', 10, 98, 74, 'companies_table', 'y')
    const tickers = pp.getOpenTickers()
    pp.close()

    expect(tickers.has('SMCI')).toBe(true)
    expect(tickers.has('CRUS')).toBe(true)
    expect(tickers.size).toBe(2)
  })

  it('insertRun records a discovery run row', () => {
    const pp = createPaperPortfolio(DB_PATH)
    pp.insertRun({ id: 'run-1', date: '2026-05-27', candidatesFound: 12, passedFilter: 3, positionsOpened: 2, threshold: 70, durationMs: 5000, createdAt: new Date().toISOString() })
    pp.close()
    // no error = pass; no reader needed for this test
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd scenario-simulator && npx vitest run tests/discovery/paper-portfolio.test.ts
```

Expected: FAIL — `createPaperPortfolio` not found.

- [ ] **Step 3: Implement paper-portfolio.ts**

```ts
// scenario-simulator/src/discovery/paper-portfolio.ts
import Database from 'better-sqlite3'
import type { DiscoveryPosition, DiscoveryRun, DiscoverySource } from './types.js'

export interface PaperPortfolio {
  openPosition(ticker: string, company: string, shares: number, avgCost: number, score: number, source: DiscoverySource, rationale: string): void
  updatePrices(prices: Record<string, number>): void
  getPositions(): DiscoveryPosition[]
  getOpenTickers(): Set<string>
  insertRun(run: DiscoveryRun): void
  close(): void
}

export function createPaperPortfolio(dbPath: string): PaperPortfolio {
  const db = new Database(dbPath)
  db.pragma('journal_mode = WAL')

  db.exec(`
    CREATE TABLE IF NOT EXISTS discovery_positions (
      ticker          TEXT PRIMARY KEY,
      company         TEXT NOT NULL,
      shares          REAL NOT NULL,
      avg_cost        REAL NOT NULL,
      current_price   REAL NOT NULL DEFAULT 0,
      current_value   REAL NOT NULL DEFAULT 0,
      unrealized_pnl  REAL NOT NULL DEFAULT 0,
      score           INTEGER NOT NULL,
      source          TEXT NOT NULL,
      rationale       TEXT NOT NULL,
      opened_at       TEXT NOT NULL,
      updated_at      TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS discovery_runs (
      id               TEXT PRIMARY KEY,
      date             TEXT NOT NULL,
      candidates_found INTEGER NOT NULL,
      passed_filter    INTEGER NOT NULL,
      positions_opened INTEGER NOT NULL,
      threshold        INTEGER NOT NULL,
      duration_ms      INTEGER NOT NULL,
      created_at       TEXT NOT NULL
    );
  `)

  const insertStmt = db.prepare(`
    INSERT OR IGNORE INTO discovery_positions
      (ticker, company, shares, avg_cost, current_price, current_value, unrealized_pnl, score, source, rationale, opened_at, updated_at)
    VALUES (?, ?, ?, ?, 0, 0, 0, ?, ?, ?, ?, ?)
  `)

  const priceStmt = db.prepare(`
    UPDATE discovery_positions SET
      current_price  = ?,
      current_value  = shares * ?,
      unrealized_pnl = (shares * ?) - (shares * avg_cost),
      updated_at     = ?
    WHERE ticker = ?
  `)

  return {
    openPosition(ticker, company, shares, avgCost, score, source, rationale) {
      const now = new Date().toISOString()
      insertStmt.run(ticker, company, shares, avgCost, score, source, rationale, now.slice(0, 10), now)
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
        current_price: number; current_value: number; unrealized_pnl: number
        score: number; source: string; rationale: string; opened_at: string; updated_at: string
      }
      return (db.prepare('SELECT * FROM discovery_positions ORDER BY ticker').all() as Row[]).map(r => ({
        ticker:        r.ticker,
        company:       r.company,
        shares:        r.shares,
        avgCost:       r.avg_cost,
        currentPrice:  r.current_price,
        currentValue:  r.current_value,
        unrealizedPnl: r.unrealized_pnl,
        score:         r.score,
        source:        r.source as DiscoverySource,
        rationale:     r.rationale,
        openedAt:      r.opened_at,
        updatedAt:     r.updated_at,
      }))
    },

    getOpenTickers() {
      type Row = { ticker: string }
      const rows = db.prepare('SELECT ticker FROM discovery_positions').all() as Row[]
      return new Set(rows.map(r => r.ticker))
    },

    insertRun(run) {
      db.prepare(`
        INSERT INTO discovery_runs (id, date, candidates_found, passed_filter, positions_opened, threshold, duration_ms, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(run.id, run.date, run.candidatesFound, run.passedFilter, run.positionsOpened, run.threshold, run.durationMs, run.createdAt)
    },

    close() { db.close() },
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd scenario-simulator && npx vitest run tests/discovery/paper-portfolio.test.ts
```

Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
cd scenario-simulator
git add src/discovery/paper-portfolio.ts tests/discovery/paper-portfolio.test.ts
git commit -m "feat(discovery): add paper-portfolio SQLite CRUD"
```

---

## Task 8: Discovery exporter

**Files:**
- Create: `scenario-simulator/src/discovery/discovery-exporter.ts`
- Create: `scenario-simulator/tests/discovery/discovery-exporter.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// scenario-simulator/tests/discovery/discovery-exporter.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, rmSync, readFileSync } from 'fs'
import { join } from 'path'
import { exportDiscovery } from '../../src/discovery/discovery-exporter.js'
import type { DiscoveryPosition, DiscoveryScenario, DiscoveryAction, DiscoveryExportCandidate } from '../../src/discovery/types.js'

const TEST_DIR = 'tests/tmp-exporter'

beforeEach(() => { mkdirSync(TEST_DIR, { recursive: true }) })
afterEach(() => { try { rmSync(TEST_DIR, { recursive: true }) } catch {} })

const positions: DiscoveryPosition[] = [{
  ticker: 'SMCI', company: 'Super Micro Computer', shares: 5.12,
  avgCost: 195.31, currentPrice: 210.50, currentValue: 1077.76, unrealizedPnl: 77.76,
  score: 82, source: 'news_mention', rationale: 'AI demand',
  openedAt: '2026-05-27', updatedAt: '2026-05-27T06:45:00Z',
}]

const scenarios: DiscoveryScenario[] = [{
  id: 'scen-1', ticker: 'SMCI', date: '2026-05-27',
  scenarioType: 'best', title: 'AI Supercycle', narrative: 'Hyperscalers...',
  timeHorizon: '3-6 months', probability: 60, regimeTransition: null,
  triggers: ['capex beat'], createdAt: '2026-05-27T06:45:00Z',
}]

const actions: DiscoveryAction[] = [{
  ticker: 'SMCI', recommendation: 'buy', conviction: 'high', rationale: 'Strong tailwind',
}]

const candidates: DiscoveryExportCandidate[] = [{
  ticker: 'SMCI', company: 'Super Micro Computer', score: 82,
  rationale: 'AI demand', source: 'news_mention', discoveredAt: '2026-05-27', action: 'buy',
}]

describe('exportDiscovery', () => {
  it('writes valid JSON with the expected top-level keys', () => {
    const outPath = join(TEST_DIR, 'discovery.json')
    exportDiscovery({ positions, scenarios, actions, candidates, config: { threshold: 70, paperAllocation: 1000, newsDays: 7 } }, outPath)

    const raw = JSON.parse(readFileSync(outPath, 'utf-8'))
    expect(raw.exportedAt).toBeDefined()
    expect(raw.config.threshold).toBe(70)
    expect(raw.discoveryPortfolio).toHaveLength(1)
    expect(raw.scenarios).toHaveLength(1)
    expect(raw.actions).toHaveLength(1)
    expect(raw.candidates).toHaveLength(1)
  })

  it('candidates[] includes both buy and watch entries', () => {
    const mixed: DiscoveryExportCandidate[] = [
      { ticker: 'SMCI', company: 'SMCI', score: 82, rationale: 'x', source: 'news_mention', discoveredAt: '2026-05-27', action: 'buy' },
      { ticker: 'MRVL', company: 'Marvell', score: 71, rationale: 'y', source: 'news_mention', discoveredAt: '2026-05-27', action: 'watch' },
    ]
    const outPath = join(TEST_DIR, 'discovery2.json')
    exportDiscovery({ positions: [], scenarios: [], actions: [], candidates: mixed, config: { threshold: 70, paperAllocation: 1000, newsDays: 7 } }, outPath)

    const raw = JSON.parse(readFileSync(outPath, 'utf-8'))
    expect(raw.candidates).toHaveLength(2)
    expect(raw.candidates.map((c: { action: string }) => c.action)).toContain('watch')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd scenario-simulator && npx vitest run tests/discovery/discovery-exporter.test.ts
```

Expected: FAIL — `exportDiscovery` not found.

- [ ] **Step 3: Implement discovery-exporter.ts**

```ts
// scenario-simulator/src/discovery/discovery-exporter.ts
import { writeFileSync, mkdirSync } from 'fs'
import { dirname } from 'path'
import type { DiscoveryPosition, DiscoveryScenario, DiscoveryAction, DiscoveryExportCandidate, DiscoveryJSON } from './types.js'

interface ExportInput {
  positions:  DiscoveryPosition[]
  scenarios:  DiscoveryScenario[]
  actions:    DiscoveryAction[]
  candidates: DiscoveryExportCandidate[]
  config: {
    threshold:       number
    paperAllocation: number
    newsDays:        number
  }
}

export function exportDiscovery(input: ExportInput, outPath: string): void {
  mkdirSync(dirname(outPath), { recursive: true })

  const payload: DiscoveryJSON = {
    exportedAt:         new Date().toISOString(),
    config:             input.config,
    candidates:         input.candidates,
    discoveryPortfolio: input.positions,
    scenarios:          input.scenarios,
    actions:            input.actions,
  }

  writeFileSync(outPath, JSON.stringify(payload, null, 2), 'utf-8')
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd scenario-simulator && npx vitest run tests/discovery/discovery-exporter.test.ts
```

Expected: PASS (2 tests).

- [ ] **Step 5: Run the full test suite to confirm no regressions**

```bash
cd scenario-simulator && npx vitest run
```

Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
cd scenario-simulator
git add src/discovery/discovery-exporter.ts tests/discovery/discovery-exporter.test.ts
git commit -m "feat(discovery): add discovery-exporter JSON writer"
```

---

## Task 9: CLI, npm script, scheduler, .env

**Files:**
- Create: `scenario-simulator/src/cli/cli-discover.ts`
- Modify: `scenario-simulator/package.json`
- Modify: `scenario-simulator/src/cli/cli-schedule.ts`
- Modify: `scenario-simulator/.env` (add three vars)

- [ ] **Step 1: Add env vars to .env**

Add to `scenario-simulator/.env`:
```
DISCOVERY_THRESHOLD=70
DISCOVERY_ALLOCATION=1000
DISCOVERY_NEWS_DAYS=7
```

- [ ] **Step 2: Create cli-discover.ts**

```ts
// scenario-simulator/src/cli/cli-discover.ts
import 'dotenv/config'
import { join } from 'path'
import { mkdirSync, readFileSync } from 'fs'
import { randomUUID } from 'crypto'
import { createIngestionReader } from '../discovery/ingestion-reader.js'
import { filterCandidates } from '../discovery/ticker-filter.js'
import { extractTickers } from '../discovery/ticker-extractor.js'
import { scoreCandidates } from '../discovery/discovery-scorer.js'
import { analyzeTicker } from '../discovery/discovery-analyzer.js'
import { createPaperPortfolio } from '../discovery/paper-portfolio.js'
import { exportDiscovery } from '../discovery/discovery-exporter.js'
import { createPortfolioStore } from '../portfolio/portfolio-store.js'
import { fetchPrices } from '../portfolio/price-fetcher.js'
import type { AnalysisJSON } from '../types.js'
import type { DiscoveryExportCandidate, DiscoveryScenario, DiscoveryAction } from '../discovery/types.js'

const DATA_DIR        = join(process.cwd(), 'data')
const ANALYSIS_PATH   = join(process.cwd(), '../ai-analysis-engine/data/analysis.json')
const INGESTION_DB    = join(process.cwd(), '../capital-intelligence-ingestion/data/capital_intelligence.db')
const DISCOVERY_OUT   = join(DATA_DIR, 'discovery.json')
const SIM_DB          = join(DATA_DIR, 'simulation.db')
const PORTFOLIO_DB    = join(DATA_DIR, 'portfolio.db')

const THRESHOLD   = parseInt(process.env.DISCOVERY_THRESHOLD  ?? '70', 10)
const ALLOCATION  = parseFloat(process.env.DISCOVERY_ALLOCATION ?? '1000')
const NEWS_DAYS   = parseInt(process.env.DISCOVERY_NEWS_DAYS  ?? '7', 10)

async function run() {
  const startTime = Date.now()
  mkdirSync(DATA_DIR, { recursive: true })

  console.log(`[${new Date().toISOString()}] Discovery run starting (threshold=${THRESHOLD}, allocation=$${ALLOCATION}, news_days=${NEWS_DAYS})`)

  const analysis: AnalysisJSON = JSON.parse(readFileSync(ANALYSIS_PATH, 'utf-8'))
  const regime = analysis.latestRegime

  const portfolioStore = createPortfolioStore(PORTFOLIO_DB)
  const realTickers = portfolioStore.getPositions().map(p => p.ticker)
  portfolioStore.close()

  const pp = createPaperPortfolio(SIM_DB)
  const openTickers = pp.getOpenTickers()

  const excludeFromDiscovery = [...new Set([...realTickers, ...Array.from(openTickers)])]

  const reader = createIngestionReader(INGESTION_DB)
  const trackedCandidates = reader.getTrackedTickers(excludeFromDiscovery)
  const recentNews = reader.getRecentNews(NEWS_DAYS)
  reader.close()

  console.log(`  Tracked candidates: ${trackedCandidates.length}`)
  console.log(`  News documents to scan: ${recentNews.length}`)

  const newsMentions = recentNews.length > 0
    ? await extractTickers(recentNews, excludeFromDiscovery, {})
    : []
  console.log(`  Ticker mentions extracted: ${newsMentions.length}`)

  const allCandidates = filterCandidates([...trackedCandidates, ...newsMentions], openTickers)
  console.log(`  Candidates after dedup/filter: ${allCandidates.length}`)

  if (allCandidates.length === 0) {
    console.log('  No candidates to score — exiting early')
    exportDiscovery({ positions: pp.getPositions(), scenarios: [], actions: [], candidates: [], config: { threshold: THRESHOLD, paperAllocation: ALLOCATION, newsDays: NEWS_DAYS } }, DISCOVERY_OUT)
    pp.insertRun({ id: randomUUID(), date: new Date().toISOString().slice(0, 10), candidatesFound: 0, passedFilter: 0, positionsOpened: 0, threshold: THRESHOLD, durationMs: Date.now() - startTime, createdAt: new Date().toISOString() })
    pp.close()
    return
  }

  const priceTickers = allCandidates.map(c => c.ticker)
  const prices = await fetchPrices(priceTickers)

  console.log(`[${new Date().toISOString()}] Scoring ${allCandidates.length} candidates...`)
  const scored = await scoreCandidates(allCandidates, regime, {})
  const topScorers = scored.filter(c => c.score >= THRESHOLD)
  console.log(`  Passed threshold (≥${THRESHOLD}): ${topScorers.length}`)

  const exportCandidates: DiscoveryExportCandidate[] = []
  const allScenarios: DiscoveryScenario[] = []
  const allActions: DiscoveryAction[] = []
  let positionsOpened = 0
  const today = new Date().toISOString().slice(0, 10)

  for (const candidate of topScorers) {
    const price = prices[candidate.ticker] ?? 0
    console.log(`  Analyzing ${candidate.ticker} (score=${candidate.score}, price=$${price})...`)

    try {
      const { scenarios, action } = await analyzeTicker(candidate, price, analysis, {})
      allScenarios.push(...scenarios)
      allActions.push(action)

      if (action.recommendation === 'buy' && price > 0 && !openTickers.has(candidate.ticker)) {
        const shares = parseFloat((ALLOCATION / price).toFixed(4))
        pp.openPosition(candidate.ticker, candidate.company, shares, price, candidate.score, candidate.source, candidate.rationale)
        openTickers.add(candidate.ticker)
        positionsOpened++
        console.log(`    → Paper position opened: ${shares} shares @ $${price}`)
      }

      exportCandidates.push({
        ticker:      candidate.ticker,
        company:     candidate.company,
        score:       candidate.score,
        rationale:   candidate.rationale,
        source:      candidate.source,
        discoveredAt:today,
        action:      action.recommendation,
      })
    } catch (err) {
      console.error(`    ✗ Analysis failed for ${candidate.ticker}:`, err instanceof Error ? err.message : err)
    }
  }

  if (prices && Object.keys(prices).length > 0) {
    const positionPrices: Record<string, number> = {}
    for (const pos of pp.getPositions()) {
      if (prices[pos.ticker]) positionPrices[pos.ticker] = prices[pos.ticker]
    }
    if (Object.keys(positionPrices).length > 0) pp.updatePrices(positionPrices)
  }

  exportDiscovery({
    positions:  pp.getPositions(),
    scenarios:  allScenarios,
    actions:    allActions,
    candidates: exportCandidates,
    config: { threshold: THRESHOLD, paperAllocation: ALLOCATION, newsDays: NEWS_DAYS },
  }, DISCOVERY_OUT)

  pp.insertRun({
    id:              randomUUID(),
    date:            today,
    candidatesFound: allCandidates.length,
    passedFilter:    topScorers.length,
    positionsOpened,
    threshold:       THRESHOLD,
    durationMs:      Date.now() - startTime,
    createdAt:       new Date().toISOString(),
  })

  pp.close()

  console.log(`\nDone in ${((Date.now() - startTime) / 1000).toFixed(1)}s`)
  console.log(`Candidates found: ${allCandidates.length} | Passed: ${topScorers.length} | New positions: ${positionsOpened}`)
  console.log(`Output: ${DISCOVERY_OUT}`)
}

run().catch(err => { console.error(err); process.exit(1) })
```

- [ ] **Step 3: Add discover script to package.json**

In `scenario-simulator/package.json`, add to the `"scripts"` block:
```json
"discover": "tsx src/cli/cli-discover.ts"
```

Final scripts block:
```json
"scripts": {
  "simulate":   "tsx src/cli/cli-run.ts",
  "whatif":     "tsx src/cli/cli-whatif.ts",
  "portfolio":  "tsx src/cli/cli-portfolio.ts",
  "report":     "tsx src/cli/cli-report.ts",
  "schedule":   "tsx src/cli/cli-schedule.ts",
  "discover":   "tsx src/cli/cli-discover.ts",
  "test":       "vitest run",
  "test:watch": "vitest"
}
```

- [ ] **Step 4: Add 6:45 AM cron to cli-schedule.ts**

In `scenario-simulator/src/cli/cli-schedule.ts`, add these imports at the top alongside the existing ones:

```ts
import { join as joinPath } from 'path'
import { mkdirSync as mkd } from 'fs'
```

Actually, the imports are already there. Just add the cron job. After the existing `cron.schedule(...)` call, add:

```ts
cron.schedule('45 6 * * *', () => {
  import('../discovery/discovery-runner.js')
    .then(m => m.runDiscovery().catch((err: unknown) => console.error('Discovery failed:', err)))
    .catch((err: unknown) => console.error('Discovery import failed:', err))
})
```

Wait — a cleaner approach is to extract the discover logic into a shared function rather than using dynamic imports. Instead, modify `cli-schedule.ts` to import `cli-discover.ts`'s logic as a function. The cleanest way: extract the core `run()` function from `cli-discover.ts` into a `src/discovery/discovery-runner.ts` helper and import it from both `cli-discover.ts` and `cli-schedule.ts`.

**Revised Step 4:** Extract discover logic into `src/discovery/discovery-runner.ts`:

```ts
// scenario-simulator/src/discovery/discovery-runner.ts
import { join } from 'path'
import { mkdirSync, readFileSync } from 'fs'
import { randomUUID } from 'crypto'
import { createIngestionReader } from './ingestion-reader.js'
import { filterCandidates } from './ticker-filter.js'
import { extractTickers } from './ticker-extractor.js'
import { scoreCandidates } from './discovery-scorer.js'
import { analyzeTicker } from './discovery-analyzer.js'
import { createPaperPortfolio } from './paper-portfolio.js'
import { exportDiscovery } from './discovery-exporter.js'
import { createPortfolioStore } from '../portfolio/portfolio-store.js'
import { fetchPrices } from '../portfolio/price-fetcher.js'
import type { AnalysisJSON } from '../types.js'
import type { DiscoveryExportCandidate, DiscoveryScenario, DiscoveryAction } from './types.js'

interface RunnerConfig {
  dataDir:      string
  analysisPath: string
  ingestionDb:  string
  threshold:    number
  allocation:   number
  newsDays:     number
}

export async function runDiscovery(cfg: RunnerConfig): Promise<void> {
  // ... (same logic as cli-discover.ts run() body, parameterized by cfg)
}
```

This is more complexity than needed. **Simpler approach:** Keep `cli-discover.ts` as-is. Update `cli-schedule.ts` to spawn a child process or just import the env + logic inline. The simplest: add a second cron job that calls `tsx src/cli/cli-discover.ts` via `child_process.spawn`.

**Final Step 4: Modify cli-schedule.ts**

Add to `scenario-simulator/src/cli/cli-schedule.ts` after the existing imports:

```ts
import { spawn } from 'child_process'
```

And after the existing `cron.schedule('30 6 * * *', ...)` block:

```ts
cron.schedule('45 6 * * *', () => {
  console.log(`[${new Date().toISOString()}] Starting discovery run...`)
  const proc = spawn('npx', ['tsx', 'src/cli/cli-discover.ts'], {
    cwd: process.cwd(),
    stdio: 'inherit',
    env: process.env,
  })
  proc.on('error', err => console.error('Discovery process error:', err))
  proc.on('close', code => {
    if (code !== 0) console.error(`Discovery process exited with code ${code}`)
  })
})
```

Also update the console log line at the bottom:
```ts
console.log('Scenario Simulator scheduler started. Simulate: 06:30. Discover: 06:45.')
```

- [ ] **Step 5: Verify the discover script works (dry-run)**

```bash
cd scenario-simulator && npx tsx src/cli/cli-discover.ts
```

Expected: runs and either exits with "No candidates" (if ingestion DB is empty/missing) or completes with discovery output. If the ingestion DB doesn't exist yet, it will throw — that's expected behavior (clear error message).

- [ ] **Step 6: Run full test suite**

```bash
cd scenario-simulator && npx vitest run
```

Expected: all tests pass.

- [ ] **Step 7: Commit**

```bash
cd scenario-simulator
git add src/cli/cli-discover.ts src/cli/cli-schedule.ts package.json .env
git commit -m "feat(discovery): add cli-discover entry point and 6:45 AM scheduler"
```

---

## Task 10: Dashboard — types, data.ts, API route

**Files:**
- Modify: `capital-intel-dashboard/src/types.ts`
- Modify: `capital-intel-dashboard/src/lib/data.ts`
- Create: `capital-intel-dashboard/src/app/api/discovery/route.ts`

- [ ] **Step 1: Add DiscoveryJSON types to types.ts**

Append to the end of `capital-intel-dashboard/src/types.ts`:

```ts
export type DiscoverySource = 'companies_table' | 'news_mention'

export interface DiscoveryPosition {
  ticker:        string
  company:       string
  shares:        number
  avgCost:       number
  currentPrice:  number
  currentValue:  number
  unrealizedPnl: number
  score:         number
  source:        DiscoverySource
  rationale:     string
  openedAt:      string
  updatedAt:     string
}

export interface DiscoveryScenario {
  id:               string
  ticker:           string
  date:             string
  scenarioType:     'best' | 'base' | 'disruption'
  title:            string
  narrative:        string
  timeHorizon:      string
  probability:      number
  regimeTransition: string | null
  triggers:         string[]
  createdAt:        string
}

export interface DiscoveryAction {
  ticker:         string
  recommendation: 'buy' | 'watch'
  conviction:     'high' | 'medium' | 'low'
  rationale:      string
}

export interface DiscoveryExportCandidate {
  ticker:      string
  company:     string
  score:       number
  rationale:   string
  source:      DiscoverySource
  discoveredAt:string
  action:      'buy' | 'watch'
}

export interface DiscoveryJSON {
  exportedAt: string
  config: {
    threshold:       number
    paperAllocation: number
    newsDays:        number
  }
  candidates:         DiscoveryExportCandidate[]
  discoveryPortfolio: DiscoveryPosition[]
  scenarios:          DiscoveryScenario[]
  actions:            DiscoveryAction[]
}

export interface DiscoveryResponse {
  discovery: DiscoveryJSON | null
  missing:   boolean
}
```

- [ ] **Step 2: Add readDiscovery() to data.ts**

In `capital-intel-dashboard/src/lib/data.ts`, add this function at the end:

```ts
export function readDiscovery(): DiscoveryJSON | null {
  const p = path.join(dataRoot(), 'scenario-simulator/data/discovery.json')
  if (!fs.existsSync(p)) return null
  return readJSON<DiscoveryJSON>(p)
}
```

Also add the import at the top:
```ts
import type { AnalysisJSON, SimulationJSON, GraphJSON, StockIntelJSON, WorldIntelJSON, DiscoveryJSON } from '@/types'
```

- [ ] **Step 3: Create GET /api/discovery route**

```ts
// capital-intel-dashboard/src/app/api/discovery/route.ts
export const dynamic = 'force-dynamic'

import { NextResponse } from 'next/server'
import { readDiscovery } from '@/lib/data'
import type { DiscoveryResponse } from '@/types'

export async function GET(): Promise<NextResponse<DiscoveryResponse>> {
  const discovery = readDiscovery()
  return NextResponse.json({ discovery, missing: discovery === null })
}
```

- [ ] **Step 4: Verify the route builds without TypeScript errors**

```bash
cd capital-intel-dashboard && npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
cd capital-intel-dashboard
git add src/types.ts src/lib/data.ts src/app/api/discovery/route.ts
git commit -m "feat(dashboard): add discovery types, data reader, and API route"
```

---

## Task 11: Dashboard — Sidebar, component, and /discovery page

**Files:**
- Modify: `capital-intel-dashboard/src/components/Sidebar.tsx`
- Create: `capital-intel-dashboard/src/components/DiscoveryCandidateRow.tsx`
- Create: `capital-intel-dashboard/src/app/discovery/page.tsx`

- [ ] **Step 1: Add Discovery to Sidebar NAV**

In `capital-intel-dashboard/src/components/Sidebar.tsx`, add to the `NAV` array:

```ts
const NAV = [
  { href: '/briefing', icon: '📋', label: 'Briefing' },
  { href: '/portfolio', icon: '💼', label: 'Portfolio' },
  { href: '/world', icon: '🌍', label: 'World Intel' },
  { href: '/graph', icon: '🕸', label: 'Graph' },
  { href: '/ask', icon: '💬', label: 'Ask' },
  { href: '/discovery', icon: '✦', label: 'Discovery' },
]
```

- [ ] **Step 2: Create DiscoveryCandidateRow component**

```tsx
// capital-intel-dashboard/src/components/DiscoveryCandidateRow.tsx
import type { DiscoveryExportCandidate } from '@/types'

interface Props {
  candidate: DiscoveryExportCandidate
}

export function DiscoveryCandidateRow({ candidate }: Props) {
  const scoreBg = candidate.score >= 80 ? 'bg-green-signal/10 text-green-signal' : 'bg-amber-signal/10 text-amber-signal'
  const actionBg = candidate.action === 'buy'
    ? 'bg-green-signal/10 text-green-signal'
    : 'bg-border-subtle text-text-muted'

  return (
    <div className="flex items-center justify-between py-2.5 px-4 border-b border-border-subtle last:border-0">
      <div className="flex items-center gap-3 min-w-0">
        <span className="text-xs font-bold text-accent-primary w-14 shrink-0">{candidate.ticker}</span>
        <span className={`text-xs px-2 py-0.5 rounded font-mono ${scoreBg}`}>{candidate.score}</span>
        <span className="text-xs text-text-muted truncate max-w-xs">{candidate.rationale}</span>
      </div>
      <div className="flex items-center gap-2 shrink-0 ml-4">
        <span className="text-[10px] text-text-inactive">{candidate.source === 'news_mention' ? 'news' : 'tracked'}</span>
        <span className={`text-[10px] px-2 py-0.5 rounded font-medium ${actionBg}`}>
          → {candidate.action}
        </span>
      </div>
    </div>
  )
}
```

- [ ] **Step 3: Create /discovery page**

```tsx
// capital-intel-dashboard/src/app/discovery/page.tsx
import type { DiscoveryResponse, DiscoveryScenario, DiscoveryPosition } from '@/types'
import { DiscoveryCandidateRow } from '@/components/DiscoveryCandidateRow'

async function getDiscovery(): Promise<DiscoveryResponse> {
  const res = await fetch('http://localhost:3000/api/discovery', { cache: 'no-store' })
  if (!res.ok) throw new Error('Failed to load discovery data')
  return res.json()
}

function ScenarioStrip({ ticker, scenarios }: { ticker: string; scenarios: DiscoveryScenario[] }) {
  const tickerScenarios = scenarios.filter(s => s.ticker === ticker)
  if (tickerScenarios.length === 0) return null

  const borderColor = { best: 'border-t-green-signal', base: 'border-t-amber-signal', disruption: 'border-t-red-signal' } as const
  const labelColor  = { best: 'text-green-signal', base: 'text-amber-signal', disruption: 'text-red-signal' } as const

  return (
    <div className="grid grid-cols-3 divide-x divide-border-subtle">
      {tickerScenarios.map(s => (
        <div key={s.id} className={`p-3 border-t-2 ${borderColor[s.scenarioType]}`}>
          <div className={`text-[10px] font-bold uppercase tracking-wide mb-1 ${labelColor[s.scenarioType]}`}>
            {s.scenarioType} · {s.probability}%
          </div>
          <div className="text-xs font-semibold text-text-primary mb-1">{s.title}</div>
          <div className="text-[11px] text-text-muted leading-relaxed line-clamp-3">{s.narrative}</div>
        </div>
      ))}
    </div>
  )
}

function PnlCell({ value }: { value: number }) {
  const color = value >= 0 ? 'text-green-signal' : 'text-red-signal'
  const sign  = value >= 0 ? '+' : ''
  return <span className={color}>{sign}${value.toFixed(2)}</span>
}

function ScoreBadge({ score }: { score: number }) {
  const cls = score >= 80
    ? 'bg-green-signal/10 text-green-signal'
    : 'bg-amber-signal/10 text-amber-signal'
  return <span className={`text-xs px-2 py-0.5 rounded font-mono ${cls}`}>{score}</span>
}

export default async function DiscoveryPage() {
  let data: DiscoveryResponse | null = null
  let fetchError: string | null = null

  try {
    data = await getDiscovery()
  } catch (e) {
    fetchError = e instanceof Error ? e.message : 'Failed to load discovery data'
  }

  if (fetchError || !data) {
    return (
      <div className="max-w-4xl">
        <h1 className="text-base font-bold text-text-primary mb-4">Discovery Portfolio</h1>
        <div className="bg-red-signal/10 border border-red-signal/20 rounded-lg p-4 text-sm text-red-signal">
          {fetchError ?? 'Failed to load data'}
        </div>
      </div>
    )
  }

  if (data.missing || !data.discovery) {
    return (
      <div className="max-w-4xl">
        <h1 className="text-base font-bold text-text-primary mb-4">Discovery Portfolio</h1>
        <div className="bg-bg-card border border-border-subtle rounded-lg p-6 text-center">
          <p className="text-sm text-text-muted">No discovery data yet.</p>
          <p className="text-xs text-text-inactive mt-1">Runs daily at 6:45 AM — or run <code className="font-mono">npm run discover</code> in scenario-simulator.</p>
        </div>
      </div>
    )
  }

  const { discovery } = data
  const { discoveryPortfolio, candidates, scenarios, config } = discovery
  const [selectedTicker, setSelectedTicker] = [
    discoveryPortfolio[0]?.ticker ?? null,
  ]

  return (
    <div className="max-w-5xl space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h1 className="text-base font-bold text-text-primary">Discovery Portfolio</h1>
        <div className="flex gap-2 text-xs text-text-muted">
          <span className="bg-bg-card border border-border-subtle px-2 py-1 rounded">Threshold: {config.threshold}</span>
          <span className="bg-bg-card border border-border-subtle px-2 py-1 rounded">${config.paperAllocation}/position</span>
        </div>
      </div>

      {/* Paper Positions Table */}
      <div>
        <h2 className="text-xs font-semibold uppercase tracking-wide text-accent-primary mb-3">Paper Positions</h2>
        <div className="bg-bg-card border border-border-subtle rounded-lg overflow-hidden">
          {discoveryPortfolio.length === 0 ? (
            <p className="text-sm text-text-muted p-4">No paper positions yet — discovery runs daily at 6:45 AM.</p>
          ) : (
            <>
              <div className="grid grid-cols-8 text-[10px] text-text-inactive uppercase tracking-wide px-4 py-2 border-b border-border-subtle">
                <span>Ticker</span><span>Company</span><span className="text-right">Score</span>
                <span className="text-right">Avg Cost</span><span className="text-right">Price</span>
                <span className="text-right">P&amp;L</span><span>Source</span><span>Opened</span>
              </div>
              {discoveryPortfolio.map((pos: DiscoveryPosition) => (
                <div key={pos.ticker} className="grid grid-cols-8 items-center px-4 py-2.5 border-b border-border-subtle last:border-0 text-sm hover:bg-border-subtle/30 transition-colors">
                  <span className="font-bold text-accent-primary">{pos.ticker}</span>
                  <span className="text-text-muted text-xs truncate">{pos.company}</span>
                  <span className="text-right"><ScoreBadge score={pos.score} /></span>
                  <span className="text-right text-text-muted text-xs">${pos.avgCost.toFixed(2)}</span>
                  <span className="text-right text-text-primary text-xs">${pos.currentPrice.toFixed(2)}</span>
                  <span className="text-right text-xs"><PnlCell value={pos.unrealizedPnl} /></span>
                  <span className="text-[10px] text-text-inactive">{pos.source === 'news_mention' ? 'news' : 'tracked'}</span>
                  <span className="text-[10px] text-text-inactive">{pos.openedAt}</span>
                </div>
              ))}
            </>
          )}
        </div>
      </div>

      {/* Scenario strip for first position */}
      {selectedTicker && scenarios.some(s => s.ticker === selectedTicker) && (
        <div>
          <h2 className="text-xs font-semibold uppercase tracking-wide text-accent-primary mb-3">{selectedTicker} — Scenarios</h2>
          <div className="bg-bg-card border border-border-subtle rounded-lg overflow-hidden">
            <ScenarioStrip ticker={selectedTicker} scenarios={scenarios} />
          </div>
        </div>
      )}

      {/* Today's candidates */}
      {candidates.length > 0 && (
        <div>
          <h2 className="text-xs font-semibold uppercase tracking-wide text-accent-primary mb-3">Today&apos;s Candidates</h2>
          <div className="bg-bg-card border border-border-subtle rounded-lg overflow-hidden">
            {candidates
              .slice()
              .sort((a, b) => b.score - a.score)
              .map(c => <DiscoveryCandidateRow key={c.ticker} candidate={c} />)}
          </div>
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 4: TypeScript check**

```bash
cd capital-intel-dashboard && npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 5: Start the dev server and verify the page loads**

```bash
cd capital-intel-dashboard && npm run dev
```

Open **http://localhost:3000/discovery** in the browser.

Expected: if `discovery.json` doesn't exist → "No discovery data yet" message. If it exists → paper positions table and candidates list render correctly with no console errors.

Also verify the sidebar now shows "✦ Discovery" as the 6th entry, and clicking it navigates to `/discovery`.

- [ ] **Step 6: Run a real discover to generate discovery.json, then refresh**

```bash
cd scenario-simulator && npm run discover
```

Refresh http://localhost:3000/discovery — paper positions table and candidates section should populate.

- [ ] **Step 7: Commit**

```bash
cd capital-intel-dashboard
git add src/types.ts src/lib/data.ts src/app/api/discovery/route.ts \
  src/components/Sidebar.tsx src/components/DiscoveryCandidateRow.tsx \
  src/app/discovery/page.tsx
git commit -m "feat(dashboard): add /discovery page with paper positions and candidate list"
```

---

## Self-Review Checklist

Spec requirements vs plan tasks:

| Spec requirement | Task |
|---|---|
| DiscoveryCandidate, ScoredCandidate, DiscoveryPosition, DiscoveryRun types | Task 1 |
| Read ingestion DB companies table (active=1, exclude real portfolio) | Task 2 |
| Read ingestion DB raw_documents (news, last N days) | Task 2 |
| Dedup candidates, skip open discovery positions | Task 3 |
| Claude extracts ticker mentions from news text | Task 4 |
| Claude batch scores all candidates 0–100 in one call | Task 5 |
| Claude deep analysis: 3 scenarios + buy/watch per top scorer | Task 6 |
| discovery_positions + discovery_runs tables in simulation.db | Task 7 |
| openPosition is idempotent (INSERT OR IGNORE) | Task 7 |
| Prompt caching (cache_control: ephemeral) on all 3 Claude calls | Tasks 4, 5, 6 |
| writes data/discovery.json with correct shape | Task 8 |
| npm run discover CLI entry point | Task 9 |
| 6:45 AM cron (after simulate at 6:30 AM) | Task 9 |
| DISCOVERY_THRESHOLD, DISCOVERY_ALLOCATION, DISCOVERY_NEWS_DAYS env vars | Task 9 |
| dashboard GET /api/discovery route | Task 10 |
| dashboard returns { missing: true } if file absent | Task 10 |
| dashboard /discovery page with 3 sections | Task 11 |
| DiscoveryCandidateRow component | Task 11 |
| Sidebar Discovery entry | Task 11 |
| discovery-runner.ts extraction (scheduler re-use) | Task 9 (handled via spawn) |
| DiscoveryScenario has ticker field, no runId | Task 1, 6 |
| paper allocation formula: shares = allocation / price | Task 7 (openPosition), Task 9 (cli) |
