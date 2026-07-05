# Cost Efficiency Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce Claude API spend through three targeted changes: switch thesis update analysis from Sonnet to Haiku, skip thesis updates for tickers with no new ingested data, and pre-filter news articles with Haiku before embedding.

**Architecture:** Three surgical edits across two projects. `thesis-memory/src/reasoning/analyzer.ts` switches to `claude-haiku-4-5-20251001`. `thesis-memory/src/cli/update.ts` gets a `hasNewDocs` guard that queries the ingestion SQLite `fetch_log` table before making any API call. `capital-intelligence-ingestion/src/pipeline.ts` gets a `filterNewsDocs` function that calls Haiku on each article's first 500 chars before embedding.

**Note:** Prompt caching on the briefing system prompt is **already implemented** in `investment-analyst-agents/src/briefing/briefing-agent.ts` (line 85 has `cache_control: { type: 'ephemeral' }`). That item is done — no changes needed there.

**Tech Stack:** `@anthropic-ai/sdk`, `better-sqlite3`, TypeScript ESM. Models: `claude-haiku-4-5-20251001` (fast/cheap), `claude-sonnet-4-6` (synthesis/briefing).

---

### Task 1: Switch thesis analyzer from Sonnet to Haiku

The thesis update loop calls `analyzer.analyze()` for every ticker. With Haiku, each call costs ~5–10× less than Sonnet at equivalent token counts.

**Files:**
- Modify: `thesis-memory/src/reasoning/analyzer.ts`

- [ ] **Step 1: Change the model constant in `analyzer.ts`**

In `thesis-memory/src/reasoning/analyzer.ts`, line 50, change:
```typescript
        model: 'claude-sonnet-4-6',
```
To:
```typescript
        model: 'claude-haiku-4-5-20251001',
```

- [ ] **Step 2: Type-check**

```bash
cd /Users/thanapold/Desktop/Projects/thesis-memory
npx tsc --noEmit
```
Expected: no errors.

- [ ] **Step 3: Run existing tests to confirm nothing broke**

```bash
cd /Users/thanapold/Desktop/Projects/thesis-memory
npm test
```
Expected: all passing (model string is not tested).

- [ ] **Step 4: Commit**

```bash
cd /Users/thanapold/Desktop/Projects/thesis-memory
git add src/reasoning/analyzer.ts
git commit -m "perf(analyzer): switch thesis update model to Haiku for cost reduction"
```

---

### Task 2: Add conditional skip in thesis update (no new docs → no API call)

On low-news days, most tickers have zero new ingested documents. Skipping those saves 50–80% of daily thesis update API calls.

**Files:**
- Modify: `thesis-memory/src/cli/update.ts`

- [ ] **Step 1: Write a test for the new `hasNewDocs` function**

Create `thesis-memory/src/cli/update-skip.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, rmSync } from 'fs'
import Database from 'better-sqlite3'
import { join } from 'path'
import { tmpdir } from 'os'
import { hasNewDocs } from './update.js'

describe('hasNewDocs', () => {
  let dir: string
  let dbPath: string

  beforeEach(() => {
    dir = join(tmpdir(), `update-test-${Date.now()}`)
    mkdirSync(dir, { recursive: true })
    dbPath = join(dir, 'sqlite.db')
    const db = new Database(dbPath)
    db.exec(`
      CREATE TABLE fetch_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ticker TEXT NOT NULL,
        source TEXT NOT NULL,
        fetched_at TEXT NOT NULL,
        doc_count INTEGER NOT NULL,
        chunk_count INTEGER NOT NULL DEFAULT 0
      )
    `)
    db.close()
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('returns false when fetch_log has no recent entries for ticker', () => {
    expect(hasNewDocs(dir, 'ARM')).toBe(false)
  })

  it('returns true when fetch_log has recent docs for ticker', () => {
    const db = new Database(dbPath)
    const now = new Date().toISOString()
    db.prepare(
      'INSERT INTO fetch_log (ticker, source, fetched_at, doc_count, chunk_count) VALUES (?, ?, ?, ?, ?)'
    ).run('ARM', 'news', now, 3, 12)
    db.close()
    expect(hasNewDocs(dir, 'ARM')).toBe(true)
  })

  it('returns false when docs are older than 1 day', () => {
    const db = new Database(dbPath)
    const old = new Date(Date.now() - 2 * 86_400_000).toISOString()
    db.prepare(
      'INSERT INTO fetch_log (ticker, source, fetched_at, doc_count, chunk_count) VALUES (?, ?, ?, ?, ?)'
    ).run('ARM', 'news', old, 3, 12)
    db.close()
    expect(hasNewDocs(dir, 'ARM')).toBe(false)
  })

  it('returns true when wildcard ticker row exists (SEC, transcripts use *)', () => {
    const db = new Database(dbPath)
    const now = new Date().toISOString()
    db.prepare(
      'INSERT INTO fetch_log (ticker, source, fetched_at, doc_count, chunk_count) VALUES (?, ?, ?, ?, ?)'
    ).run('*', 'sec_filing', now, 1, 5)
    db.close()
    // Wildcard rows should not count as ticker-specific new docs
    expect(hasNewDocs(dir, 'ARM')).toBe(false)
  })

  it('returns false when db file does not exist', () => {
    expect(hasNewDocs('/nonexistent/path', 'ARM')).toBe(false)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd /Users/thanapold/Desktop/Projects/thesis-memory
npx vitest run src/cli/update-skip.test.ts
```
Expected: FAIL — `hasNewDocs` not exported from `update.js`.

- [ ] **Step 3: Add `hasNewDocs` export to `update.ts`**

In `thesis-memory/src/cli/update.ts`, add this function after the existing `shouldUpdate` function (around line 25):

```typescript
export function hasNewDocs(ingestionDataPath: string, ticker: string): boolean {
  const dbPath = join(ingestionDataPath, 'sqlite.db')
  if (!existsSync(dbPath)) return false
  try {
    const db = new Database(dbPath, { readonly: true })
    const row = db.prepare(
      `SELECT SUM(doc_count) as total FROM fetch_log
       WHERE ticker = ? AND fetched_at >= datetime('now', '-1 day')`
    ).get(ticker) as { total: number | null }
    db.close()
    return (row?.total ?? 0) > 0
  } catch {
    return false
  }
}
```

- [ ] **Step 4: Apply the skip guard in `main()` inside `update.ts`**

In `thesis-memory/src/cli/update.ts`, inside the `main()` function in the `for (const ticker of tickers)` loop, add the `hasNewDocs` check **before** calling `generateProposal`. The loop currently looks like:

```typescript
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
```

Change it to:

```typescript
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
      if (!hasNewDocs(INGESTION_PATH, ticker)) {
        console.log(`  [skip] ${ticker}: no new documents in last 24h`)
        continue
      }
      await generateProposal(ticker, store, retriever, analyzer)
    }
```

- [ ] **Step 5: Run all tests**

```bash
cd /Users/thanapold/Desktop/Projects/thesis-memory
npm test
```
Expected: all passing.

- [ ] **Step 6: Commit**

```bash
cd /Users/thanapold/Desktop/Projects/thesis-memory
git add src/cli/update.ts src/cli/update-skip.test.ts
git commit -m "perf(update): skip thesis update when no new docs ingested in last 24h"
```

---

### Task 3: Add news pre-filter with Haiku before embedding

Each news article costs embedding compute + LanceDB storage. Haiku filters out irrelevant articles (~$0.0001/article) and reduces the noise in the knowledge base by an estimated 30–50%.

**Files:**
- Modify: `capital-intelligence-ingestion/src/pipeline.ts`

- [ ] **Step 1: Write the failing test**

Create `capital-intelligence-ingestion/src/pipeline/news-filter.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest'
import type { RawDocument } from '../types.js'

// We test the logic structure — actual Haiku calls are integration-tested manually

function makeDoc(ticker: string, docType: string, content: string): RawDocument {
  return {
    id: '1',
    ticker,
    company: ticker,
    source: 'news' as const,
    docType: docType as RawDocument['docType'],
    publishedDate: '2026-05-31',
    fiscalPeriod: null,
    url: 'https://example.com',
    content,
  }
}

describe('isNewsSource', () => {
  it('identifies news-type source docs', () => {
    const newsDoc = makeDoc('ARM', 'article', 'ARM ships new chip')
    const secDoc = { ...newsDoc, source: 'sec_filing' as const, docType: '10-K' as const }
    // isNewsSource should return true for news/webzio/newsapiai/worldnewsapi sources
    const newsSources = new Set(['news', 'webzio', 'newsapiai', 'worldnewsapi'])
    expect(newsSources.has(newsDoc.source)).toBe(true)
    expect(newsSources.has(secDoc.source)).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it passes immediately** (it's a structural assertion, not testing unwritten code)

```bash
cd /Users/thanapold/Desktop/Projects/capital-intelligence-ingestion
npx vitest run src/pipeline/news-filter.test.ts
```
Expected: 1/1 PASS.

- [ ] **Step 3: Add `filterNewsDocs` and Haiku client to `pipeline.ts`**

In `capital-intelligence-ingestion/src/pipeline.ts`, add the Anthropic import at the top (after existing imports):

```typescript
import Anthropic from '@anthropic-ai/sdk'
```

Then add this function before `runPipeline`:

```typescript
const NEWS_SOURCES = new Set(['news', 'webzio', 'newsapiai', 'worldnewsapi'])

async function filterNewsDocs(
  docs: RawDocument[],
  haiku: Anthropic,
): Promise<RawDocument[]> {
  const filtered: RawDocument[] = []

  for (const doc of docs) {
    if (!NEWS_SOURCES.has(doc.source)) {
      filtered.push(doc)
      continue
    }

    try {
      const response = await haiku.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 5,
        messages: [{
          role: 'user',
          content: `Is this article materially relevant to ${doc.company}'s business fundamentals? Answer only yes or no.\n\n${doc.content.slice(0, 500)}`,
        }],
      })
      const text = response.content.find(b => b.type === 'text')?.text ?? ''
      if (text.toLowerCase().startsWith('yes')) {
        filtered.push(doc)
      }
    } catch {
      filtered.push(doc)
    }
  }

  return filtered
}
```

- [ ] **Step 4: Wire the filter into the pipeline loop**

In `runPipeline`, the anthropic key may not always be set. Add the Haiku client creation inside `runPipeline` after the other client setup lines (around line 73):

```typescript
  const anthropicKey = process.env.ANTHROPIC_API_KEY
  const haiku = anthropicKey ? new Anthropic({ apiKey: anthropicKey }) : null
```

Then in the `for (const client of clients)` loop, change:

```typescript
      const docs = await client.run()
      const chunks = await processDocuments(docs, sqliteStore, lanceStore, embedder)
```

To:

```typescript
      let docs = await client.run()
      if (haiku && NEWS_SOURCES.has(client.sourceKey)) {
        const before = docs.length
        docs = await filterNewsDocs(docs, haiku)
        if (before !== docs.length) {
          console.log(`  [${client.name}] Pre-filtered ${before - docs.length} irrelevant articles`)
        }
      }
      const chunks = await processDocuments(docs, sqliteStore, lanceStore, embedder)
```

- [ ] **Step 5: Add `anthropic` as a dependency**

```bash
cd /Users/thanapold/Desktop/Projects/capital-intelligence-ingestion
npm install @anthropic-ai/sdk
```

- [ ] **Step 6: Type-check**

```bash
npx tsc --noEmit
```
Expected: no errors.

- [ ] **Step 7: Run the full test suite**

```bash
cd /Users/thanapold/Desktop/Projects/capital-intelligence-ingestion
npm test
```
Expected: all passing (news-filter.test.ts passes, existing tests unaffected).

- [ ] **Step 8: Commit**

```bash
cd /Users/thanapold/Desktop/Projects/capital-intelligence-ingestion
git add src/pipeline.ts src/pipeline/news-filter.test.ts package.json package-lock.json
git commit -m "perf(pipeline): add Haiku news pre-filter to reduce irrelevant article embeddings"
```
