# Expand Investment Universe Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add 8 companies (JPM, BAC, GS as `financials`; LLY, UNH, JNJ, ABBV, MRNA as `healthcare`) to the full thesis-tracking pipeline with per-company update frequency control (daily for financials, weekly for healthcare).

**Architecture:** Add a `thesis_update_days` column to the ingestion `watchlist` table, build a `cli-watchlist.ts` command to register companies, make thesis-memory respect the frequency before running Claude, then add the new nodes and edges to the dependency graph. The capital-intel-dashboard picks up the new companies automatically once data flows through.

**Tech Stack:** TypeScript, better-sqlite3 (SQLite), tsx, vitest — all already installed in both projects.

---

## File Map

```
capital-intelligence-ingestion/
  src/types.ts                           MODIFY — add thesisUpdateDays to Company
  src/store/sqlite.ts                    MODIFY — ALTER TABLE, update upsert + select
  src/intake/cli-watchlist.ts            CREATE — add / list / remove CLI
  package.json                           MODIFY — add "watchlist" script
  tests/store/sqlite.test.ts             MODIFY — extend with thesisUpdateDays tests
  tests/intake/cli-watchlist.test.ts     CREATE — test add/list/remove logic

thesis-memory/
  src/cli/update.ts                      MODIFY — load ingestion frequencies, skip if too recent
  tests/update-frequency.test.ts         CREATE — test frequency skip logic

dependency-graph-engine/
  data/graph.json                        MODIFY — add 8 nodes + 5 edges
```

---

### Task 1: Add `thesisUpdateDays` to ingestion types and schema

**Files:**
- Modify: `capital-intelligence-ingestion/src/types.ts`
- Modify: `capital-intelligence-ingestion/src/store/sqlite.ts`
- Modify: `capital-intelligence-ingestion/tests/store/sqlite.test.ts`

- [ ] **Step 1: Write the failing tests**

Open `capital-intelligence-ingestion/tests/store/sqlite.test.ts` and add these two tests inside the existing `describe('SQLiteStore', ...)` block:

```typescript
it('stores and retrieves thesisUpdateDays', () => {
  const company: Company = {
    ticker: 'JPM',
    company: 'JPMorgan Chase',
    cik: '0000019617',
    themes: ['financials'],
    newsOnly: false,
    irFeedUrl: null,
    irFeedStatus: 'pending',
    active: true,
    addedAt: '2026-01-01T00:00:00Z',
    newsSearchTerms: ['JPMorgan', 'JPM'],
    thesisUpdateDays: 1,
  }
  store.upsertCompany(company)
  const companies = store.getActiveCompanies()
  expect(companies[0].thesisUpdateDays).toBe(1)
})

it('defaults thesisUpdateDays to 1 for existing companies without the field', () => {
  // Insert directly without thesis_update_days to simulate pre-migration row
  const db = (store as unknown as { db: import('better-sqlite3').Database }).db
  db.prepare(
    `INSERT INTO watchlist (ticker, company, cik, themes, news_only, ir_feed_url, ir_feed_status, active, added_at, news_search_terms)
     VALUES ('OLD', 'OldCo', null, '[]', 0, null, 'pending', 1, '2026-01-01', '[]')`
  ).run()
  const companies = store.getActiveCompanies()
  const old = companies.find(c => c.ticker === 'OLD')
  expect(old?.thesisUpdateDays).toBe(1)
})
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd /Users/thanapold/Desktop/Projects/capital-intelligence-ingestion
npm test -- --reporter=verbose 2>&1 | grep -A3 "thesisUpdateDays\|FAIL\|PASS"
```

Expected: FAIL — `thesisUpdateDays` does not exist on `Company` type yet.

- [ ] **Step 3: Add `thesisUpdateDays` to the `Company` type**

In `src/types.ts`, add the field after `newsSearchTerms`:

```typescript
export interface Company {
  ticker: string
  company: string
  cik: string | null
  themes: string[]
  newsOnly: boolean
  irFeedUrl: string | null
  irFeedStatus: IRFeedStatus
  active: boolean
  addedAt: string
  newsSearchTerms: string[]
  thesisUpdateDays: number   // 1 = daily, 7 = weekly; defaults to 1
}
```

- [ ] **Step 4: Update `src/store/sqlite.ts` — schema migration + upsert + select**

Replace the `db.exec(...)` call that creates the `watchlist` table, and update `upsertCompany` and `getActiveCompanies`:

```typescript
export function createSQLiteStore(dbPath: string): SQLiteStore {
  const db = new Database(dbPath)
  db.pragma('journal_mode = WAL')

  db.exec(`
    CREATE TABLE IF NOT EXISTS watchlist (
      ticker TEXT PRIMARY KEY,
      company TEXT NOT NULL,
      cik TEXT,
      themes TEXT NOT NULL,
      news_only INTEGER NOT NULL DEFAULT 0,
      ir_feed_url TEXT,
      ir_feed_status TEXT NOT NULL DEFAULT 'pending',
      active INTEGER NOT NULL DEFAULT 1,
      added_at TEXT NOT NULL,
      news_search_terms TEXT NOT NULL
    );
    /* ... rest of CREATE TABLE statements unchanged ... */
  `)

  // Migrate existing DBs: add thesis_update_days if missing
  try {
    db.exec('ALTER TABLE watchlist ADD COLUMN thesis_update_days INTEGER NOT NULL DEFAULT 1')
  } catch {
    // Column already exists — that's fine
  }

  return {
    upsertCompany(company: Company) {
      db.prepare(`
        INSERT INTO watchlist (ticker, company, cik, themes, news_only, ir_feed_url, ir_feed_status, active, added_at, news_search_terms, thesis_update_days)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(ticker) DO UPDATE SET
          company = excluded.company,
          cik = excluded.cik,
          themes = excluded.themes,
          news_only = excluded.news_only,
          active = excluded.active,
          news_search_terms = excluded.news_search_terms,
          thesis_update_days = excluded.thesis_update_days
      `).run(
        company.ticker, company.company, company.cik,
        JSON.stringify(company.themes), company.newsOnly ? 1 : 0,
        company.irFeedUrl, company.irFeedStatus, company.active ? 1 : 0,
        company.addedAt, JSON.stringify(company.newsSearchTerms),
        company.thesisUpdateDays ?? 1
      )
    },

    getActiveCompanies(): Company[] {
      const rows = db.prepare('SELECT * FROM watchlist WHERE active = 1').all() as Record<string, unknown>[]
      return rows.map(row => ({
        ticker: row.ticker as string,
        company: row.company as string,
        cik: row.cik as string | null,
        themes: JSON.parse(row.themes as string),
        newsOnly: (row.news_only as number) === 1,
        irFeedUrl: row.ir_feed_url as string | null,
        irFeedStatus: row.ir_feed_status as IRFeedStatus,
        active: (row.active as number) === 1,
        addedAt: row.added_at as string,
        newsSearchTerms: JSON.parse(row.news_search_terms as string),
        thesisUpdateDays: (row.thesis_update_days as number) ?? 1,
      }))
    },

    // ... all other methods unchanged ...
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
cd /Users/thanapold/Desktop/Projects/capital-intelligence-ingestion
npm test -- --reporter=verbose 2>&1 | grep -E "✓|✗|PASS|FAIL"
```

Expected: all tests pass including the two new ones.

- [ ] **Step 6: Commit**

```bash
cd /Users/thanapold/Desktop/Projects/capital-intelligence-ingestion
git add src/types.ts src/store/sqlite.ts tests/store/sqlite.test.ts
git commit -m "feat(ingestion): add thesisUpdateDays field to Company schema"
```

---

### Task 2: Build watchlist CLI

**Files:**
- Create: `capital-intelligence-ingestion/src/intake/cli-watchlist.ts`
- Modify: `capital-intelligence-ingestion/package.json`
- Create: `capital-intelligence-ingestion/tests/intake/cli-watchlist.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/intake/cli-watchlist.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createSQLiteStore } from '../../src/store/sqlite.js'
import type { Company } from '../../src/types.js'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { addCompany, listCompanies, removeCompany } from '../../src/intake/cli-watchlist.js'

let tmpDir: string
let dbPath: string

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'wl-test-'))
  dbPath = join(tmpDir, 'test.db')
})

afterEach(() => {
  rmSync(tmpDir, { recursive: true })
})

describe('addCompany', () => {
  it('registers a new company with all fields', () => {
    addCompany(dbPath, { ticker: 'JPM', company: 'JPMorgan Chase', theme: 'financials', cik: '0000019617', freq: 1 })
    const store = createSQLiteStore(dbPath)
    const companies = store.getActiveCompanies()
    store.close()
    expect(companies).toHaveLength(1)
    expect(companies[0].ticker).toBe('JPM')
    expect(companies[0].themes).toContain('financials')
    expect(companies[0].thesisUpdateDays).toBe(1)
    expect(companies[0].newsSearchTerms).toContain('JPM')
    expect(companies[0].newsSearchTerms).toContain('JPMorgan Chase')
  })

  it('sets freq=7 for weekly companies', () => {
    addCompany(dbPath, { ticker: 'LLY', company: 'Eli Lilly', theme: 'healthcare', cik: '0000059478', freq: 7 })
    const store = createSQLiteStore(dbPath)
    const companies = store.getActiveCompanies()
    store.close()
    expect(companies[0].thesisUpdateDays).toBe(7)
  })
})

describe('removeCompany', () => {
  it('sets active=false for existing company', () => {
    addCompany(dbPath, { ticker: 'JPM', company: 'JPMorgan Chase', theme: 'financials', cik: '0000019617', freq: 1 })
    removeCompany(dbPath, 'JPM')
    const store = createSQLiteStore(dbPath)
    const companies = store.getActiveCompanies()
    store.close()
    expect(companies).toHaveLength(0)
  })
})

describe('listCompanies', () => {
  it('returns all active companies', () => {
    addCompany(dbPath, { ticker: 'JPM', company: 'JPMorgan Chase', theme: 'financials', cik: '0000019617', freq: 1 })
    addCompany(dbPath, { ticker: 'LLY', company: 'Eli Lilly', theme: 'healthcare', cik: '0000059478', freq: 7 })
    const companies = listCompanies(dbPath)
    expect(companies).toHaveLength(2)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd /Users/thanapold/Desktop/Projects/capital-intelligence-ingestion
npm test -- tests/intake/cli-watchlist.test.ts --reporter=verbose 2>&1 | tail -10
```

Expected: FAIL — `cli-watchlist.js` does not exist yet.

- [ ] **Step 3: Create `src/intake/cli-watchlist.ts`**

```typescript
// src/intake/cli-watchlist.ts
import { join } from 'path'
import { createSQLiteStore } from '../store/sqlite.js'
import type { Company } from '../types.js'

interface AddOptions {
  ticker: string
  company: string
  theme: string
  cik: string
  freq: number
}

export function addCompany(dbPath: string, opts: AddOptions): void {
  const store = createSQLiteStore(dbPath)
  const company: Company = {
    ticker: opts.ticker.toUpperCase(),
    company: opts.company,
    cik: opts.cik || null,
    themes: [opts.theme],
    newsOnly: false,
    irFeedUrl: null,
    irFeedStatus: 'pending',
    active: true,
    addedAt: new Date().toISOString(),
    newsSearchTerms: [opts.ticker.toUpperCase(), opts.company],
    thesisUpdateDays: opts.freq,
  }
  store.upsertCompany(company)
  store.close()
  console.log(`✓ Added ${company.ticker} — ${company.company} [${opts.theme}, freq=${opts.freq}d]`)
}

export function removeCompany(dbPath: string, ticker: string): void {
  const store = createSQLiteStore(dbPath)
  const companies = store.getActiveCompanies()
  const found = companies.find(c => c.ticker === ticker.toUpperCase())
  if (!found) { store.close(); console.log(`Not found: ${ticker}`); return }
  store.upsertCompany({ ...found, active: false })
  store.close()
  console.log(`✓ Removed ${ticker.toUpperCase()}`)
}

export function listCompanies(dbPath: string): Company[] {
  const store = createSQLiteStore(dbPath)
  const companies = store.getActiveCompanies()
  store.close()
  return companies
}

// CLI entry point
const args = process.argv.slice(2)
const subcommand = args[0]

if (!subcommand || !['add', 'remove', 'list'].includes(subcommand)) {
  console.error('Usage:')
  console.error('  npm run watchlist -- add --ticker=JPM --company="JPMorgan Chase" --theme=financials --cik=0000019617 --freq=1')
  console.error('  npm run watchlist -- list')
  console.error('  npm run watchlist -- remove --ticker=JPM')
  process.exit(1)
}

const get = (flag: string) => args.find(a => a.startsWith(`${flag}=`))?.split('=').slice(1).join('=') ?? ''
const DB_PATH = join(process.cwd(), 'data', 'sqlite.db')

if (subcommand === 'add') {
  const ticker  = get('--ticker')
  const company = get('--company')
  const theme   = get('--theme')
  const cik     = get('--cik')
  const freq    = parseInt(get('--freq') || '1', 10)

  if (!ticker || !company || !theme) {
    console.error('--ticker, --company, and --theme are required')
    process.exit(1)
  }
  addCompany(DB_PATH, { ticker, company, theme, cik, freq })
}

if (subcommand === 'remove') {
  const ticker = get('--ticker')
  if (!ticker) { console.error('--ticker is required'); process.exit(1) }
  removeCompany(DB_PATH, ticker)
}

if (subcommand === 'list') {
  const companies = listCompanies(DB_PATH)
  if (companies.length === 0) { console.log('No active companies.'); process.exit(0) }
  console.log(`\n${'Ticker'.padEnd(8)} ${'Freq'.padEnd(6)} ${'Themes'.padEnd(20)} Company`)
  console.log('─'.repeat(70))
  for (const c of companies.sort((a, b) => a.ticker.localeCompare(b.ticker))) {
    console.log(`${c.ticker.padEnd(8)} ${String(c.thesisUpdateDays + 'd').padEnd(6)} ${c.themes.join(',').padEnd(20)} ${c.company}`)
  }
  console.log(`\n${companies.length} active companies`)
}
```

- [ ] **Step 4: Add `"watchlist"` script to `package.json`**

In `capital-intelligence-ingestion/package.json`, add inside `"scripts"`:

```json
"watchlist": "tsx src/intake/cli-watchlist.ts"
```

So `"scripts"` becomes:
```json
"scripts": {
  "pipeline": "tsx src/pipeline.ts",
  "add": "tsx src/intake/cli-add.ts",
  "config": "tsx src/intake/cli-config.ts",
  "watchlist": "tsx src/intake/cli-watchlist.ts",
  "search": "tsx src/query/cli-search.ts",
  "schedule": "tsx src/scheduler.ts",
  "test": "vitest run",
  "test:watch": "vitest"
}
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
cd /Users/thanapold/Desktop/Projects/capital-intelligence-ingestion
npm test -- --reporter=verbose 2>&1 | grep -E "✓|✗|PASS|FAIL"
```

Expected: all tests pass including the 3 new `cli-watchlist` tests.

- [ ] **Step 6: Smoke-test the CLI manually**

```bash
cd /Users/thanapold/Desktop/Projects/capital-intelligence-ingestion
npm run watchlist -- list
```

Expected output:
```
No active companies.
```
(No errors — DB created successfully if it doesn't exist yet, or runs against existing DB.)

- [ ] **Step 7: Commit**

```bash
git add src/types.ts src/store/sqlite.ts src/intake/cli-watchlist.ts package.json tests/intake/cli-watchlist.test.ts
git commit -m "feat(ingestion): add cli-watchlist with add/list/remove and thesisUpdateDays"
```

---

### Task 3: Add frequency check to thesis-memory

**Files:**
- Modify: `thesis-memory/src/cli/update.ts`
- Create: `thesis-memory/tests/update-frequency.test.ts`

- [ ] **Step 1: Write the failing test**

Create `thesis-memory/tests/update-frequency.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { shouldUpdate } from '../src/cli/update.js'

describe('shouldUpdate', () => {
  it('returns true when lastUpdated is older than thesisUpdateDays', () => {
    const tenDaysAgo = new Date(Date.now() - 10 * 86_400_000).toISOString()
    expect(shouldUpdate(tenDaysAgo, 7)).toBe(true)
  })

  it('returns false when lastUpdated is within thesisUpdateDays', () => {
    const twoDaysAgo = new Date(Date.now() - 2 * 86_400_000).toISOString()
    expect(shouldUpdate(twoDaysAgo, 7)).toBe(false)
  })

  it('returns true for daily company updated yesterday', () => {
    const yesterday = new Date(Date.now() - 25 * 3_600_000).toISOString()
    expect(shouldUpdate(yesterday, 1)).toBe(true)
  })

  it('returns false for daily company updated 2 hours ago', () => {
    const twoHoursAgo = new Date(Date.now() - 2 * 3_600_000).toISOString()
    expect(shouldUpdate(twoHoursAgo, 1)).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd /Users/thanapold/Desktop/Projects/thesis-memory
npm test -- tests/update-frequency.test.ts --reporter=verbose 2>&1 | tail -10
```

Expected: FAIL — `shouldUpdate` is not exported from `update.ts` yet.

- [ ] **Step 3: Add `shouldUpdate` + frequency loading to `src/cli/update.ts`**

Add these exports and imports at the top of the file (before `generateProposal`):

```typescript
import Database from 'better-sqlite3'
import { existsSync } from 'fs'

// Exported for testing
export function shouldUpdate(lastUpdatedIso: string, thesisUpdateDays: number): boolean {
  const daysSince = (Date.now() - new Date(lastUpdatedIso).getTime()) / 86_400_000
  return daysSince >= thesisUpdateDays
}

function loadIngestionFrequencies(ingestionDataPath: string): Map<string, number> {
  const dbPath = join(ingestionDataPath, 'sqlite.db')
  if (!existsSync(dbPath)) return new Map()
  try {
    const db = new Database(dbPath, { readonly: true })
    const rows = db.prepare(
      'SELECT ticker, thesis_update_days FROM watchlist WHERE active = 1'
    ).all() as Array<{ ticker: string; thesis_update_days: number | null }>
    db.close()
    return new Map(rows.map(r => [r.ticker, r.thesis_update_days ?? 1]))
  } catch {
    return new Map()
  }
}
```

Then in the `main()` function, add frequency loading and the skip check. Replace the section from `let tickers: string[] = []` through the `for (const ticker of tickers)` loop:

```typescript
async function main() {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) { console.error('ANTHROPIC_API_KEY not set'); process.exit(1) }

  const store = createThesisStore(join(DATA_DIR, 'thesis.db'))
  const retriever = await createRetriever(INGESTION_PATH)
  const analyzer = createAnalyzer(apiKey)
  const frequencies = loadIngestionFrequencies(INGESTION_PATH)

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
      const thesis = store.getThesis(ticker)
      if (thesis) {
        const freq = frequencies.get(ticker) ?? 1
        if (!shouldUpdate(thesis.updatedAt, freq)) {
          const daysSince = (Date.now() - new Date(thesis.updatedAt).getTime()) / 86_400_000
          const daysUntil = freq - daysSince
          console.log(`  [skip] ${ticker}: updated ${daysSince.toFixed(1)}d ago, next in ${daysUntil.toFixed(1)}d`)
          continue
        }
      }
      await generateProposal(ticker, store, retriever, analyzer)
    }

    const pending = store.getPendingProposals()
    console.log(`\nDone. ${pending.length} proposal(s) pending review. Run: npm run review`)
  } finally {
    store.close()
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd /Users/thanapold/Desktop/Projects/thesis-memory
npm test -- --reporter=verbose 2>&1 | grep -E "✓|✗|PASS|FAIL"
```

Expected: all tests pass including the 4 new `shouldUpdate` tests.

- [ ] **Step 5: Commit**

```bash
cd /Users/thanapold/Desktop/Projects/thesis-memory
git add src/cli/update.ts tests/update-frequency.test.ts
git commit -m "feat(thesis-memory): respect thesisUpdateDays frequency from ingestion DB"
```

---

### Task 4: Update dependency graph with new nodes and edges

**Files:**
- Modify: `dependency-graph-engine/data/graph.json`

- [ ] **Step 1: Add 8 new nodes and 5 edges to graph.json**

Open `dependency-graph-engine/data/graph.json`. Add to the `"nodes"` array:

```json
{ "ticker": "JPM",  "company": "JPMorgan Chase",     "themes": ["financials"] },
{ "ticker": "BAC",  "company": "Bank of America",     "themes": ["financials"] },
{ "ticker": "GS",   "company": "Goldman Sachs",       "themes": ["financials"] },
{ "ticker": "LLY",  "company": "Eli Lilly",           "themes": ["healthcare"] },
{ "ticker": "UNH",  "company": "UnitedHealth Group",  "themes": ["healthcare"] },
{ "ticker": "JNJ",  "company": "Johnson & Johnson",   "themes": ["healthcare"] },
{ "ticker": "ABBV", "company": "AbbVie",              "themes": ["healthcare"] },
{ "ticker": "MRNA", "company": "Moderna",             "themes": ["healthcare"] }
```

Add to the `"edges"` array:

```json
{ "from": "JPM",  "to": "NVDA", "type": "customer",    "strength": "moderate", "description": "JPMorgan is a major AI infrastructure spender; NVDA supplies the compute" },
{ "from": "GS",   "to": "MSFT", "type": "customer",    "strength": "weak",     "description": "Goldman uses Azure and OpenAI for internal AI tooling" },
{ "from": "LLY",  "to": "MRNA", "type": "competitive", "strength": "moderate", "description": "Competing mRNA-based drug platforms across multiple therapeutic areas" },
{ "from": "MRNA", "to": "NVDA", "type": "customer",    "strength": "weak",     "description": "AI-accelerated drug discovery relies on GPU compute" },
{ "from": "UNH",  "to": "JNJ",  "type": "customer",    "strength": "moderate", "description": "UnitedHealth insures patients who use J&J medical devices and drugs" }
```

Also update `"exportedAt"` to today's date: `"2026-05-29T00:00:00.000Z"`.

- [ ] **Step 2: Validate JSON is well-formed**

```bash
cd /Users/thanapold/Desktop/Projects/dependency-graph-engine
node -e "const g = require('./data/graph.json'); console.log('nodes:', g.nodes.length, 'edges:', g.edges.length)"
```

Expected output:
```
nodes: 42  edges: 47
```
(Previous: 34 nodes, 42 edges. +8 nodes, +5 edges.)

- [ ] **Step 3: Commit**

```bash
cd /Users/thanapold/Desktop/Projects/dependency-graph-engine
git add data/graph.json
git commit -m "feat(graph): add financials + healthcare nodes and cross-theme edges"
```

---

### Task 5: Bootstrap — register 8 companies and create initial theses

**Files:** No code changes — runs CLI commands against the live DB.

- [ ] **Step 1: Register all 8 companies**

```bash
cd /Users/thanapold/Desktop/Projects/capital-intelligence-ingestion

npm run watchlist -- add --ticker=JPM --company="JPMorgan Chase"      --theme=financials --cik=0000019617 --freq=1
npm run watchlist -- add --ticker=BAC --company="Bank of America"     --theme=financials --cik=0000070858 --freq=1
npm run watchlist -- add --ticker=GS  --company="Goldman Sachs"       --theme=financials --cik=0000886982 --freq=1
npm run watchlist -- add --ticker=LLY --company="Eli Lilly"           --theme=healthcare --cik=0000059478 --freq=7
npm run watchlist -- add --ticker=UNH --company="UnitedHealth Group"  --theme=healthcare --cik=0000731766 --freq=7
npm run watchlist -- add --ticker=JNJ --company="Johnson & Johnson"   --theme=healthcare --cik=0000200406 --freq=7
npm run watchlist -- add --ticker=ABBV --company="AbbVie"             --theme=healthcare --cik=0001551152 --freq=7
npm run watchlist -- add --ticker=MRNA --company="Moderna"            --theme=healthcare --cik=0001682852 --freq=7
```

Expected: 8 lines of `✓ Added ... ` output, no errors.

- [ ] **Step 2: Verify all 8 are registered**

```bash
npm run watchlist -- list
```

Expected: table showing all 8 companies with their themes and frequencies (JPM/BAC/GS with `1d`, LLY/UNH/JNJ/ABBV/MRNA with `7d`).

- [ ] **Step 3: Run initial ingestion pipeline for the new companies**

```bash
npm run pipeline
```

This fetches SEC filings, news, and transcripts for all active companies. For new companies it will pull historical filings. Expect this to take 5–15 minutes for 8 new companies.

Expected output includes lines like:
```
[sec] JPM: fetched N filings
[news] LLY: fetched N articles
```

- [ ] **Step 4: Create initial theses in thesis-memory**

```bash
cd /Users/thanapold/Desktop/Projects/thesis-memory

npm run thesis -- create JPM
npm run thesis -- create BAC
npm run thesis -- create GS
npm run thesis -- create LLY
npm run thesis -- create UNH
npm run thesis -- create JNJ
npm run thesis -- create ABBV
npm run thesis -- create MRNA
```

Each creates a thesis with initial assumptions and narrative. Expect each to take 30–60 seconds (Claude Sonnet call + embedding).

Expected per company:
```
Creating thesis for JPM...
✓ Thesis created for JPMorgan Chase
```

- [ ] **Step 5: Verify thesis-memory frequency skip works**

```bash
# Run update immediately — all 8 should be skipped since they were just created
npm run update 2>&1 | grep -E "skip|skip"
```

Expected: lines like `[skip] JPM: updated 0.0d ago, next in 1.0d` for financials and `[skip] LLY: updated 0.0d ago, next in 7.0d` for healthcare.

- [ ] **Step 6: Final verification — check graph node count**

```bash
node -e "const g = require('/Users/thanapold/Desktop/Projects/dependency-graph-engine/data/graph.json'); console.log('nodes:', g.nodes.length, 'edges:', g.edges.length)"
```

Expected: `nodes: 42  edges: 47`

- [ ] **Step 7: Commit bootstrap state**

```bash
cd /Users/thanapold/Desktop/Projects
git add -p  # review changes if any tracked data files changed
git commit -m "feat: bootstrap financials + healthcare companies in ingestion + thesis-memory"
```
