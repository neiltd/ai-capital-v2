# Personal Notes Layer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add personal notes as a first-class document type in the ingestion pipeline, with a quick-capture CLI and a dashboard form — so the investor's own thinking lands in LanceDB alongside market data.

**Architecture:** New `src/intake/notes-processor.ts` reads `.md` files with YAML frontmatter from `intake/personal-notes/`, returning `RawDocument[]` that the pipeline embeds via the existing `processDocuments` path. A `cli-note.ts` script writes + immediately embeds a note without waiting for the next pipeline run. A Next.js route + page in the dashboard provides a form-based capture path (file write only; embedding happens on next pipeline run).

**Tech Stack:** TypeScript ESM, Node.js `fs`, `readline`, existing `createLanceStore` / `createEmbedder` / `createSQLiteStore`, Next.js 14 App Router, Tailwind CSS.

---

### Task 1: Add `personal_note` and `note` to ingestion types

**Files:**
- Modify: `capital-intelligence-ingestion/src/types.ts`

- [ ] **Step 1: Open `src/types.ts` and update the two union types**

Change line 1 from:
```typescript
export type SourceType = 'sec_filing' | 'earnings_transcript' | 'news' | 'ir_page' | 'manual' | 'financialdata'
export type DocType = '10-K' | '10-Q' | '8-K' | 'transcript' | 'article' | 'ir_release' | 'manual' | 'press_release' | 'financial_statement'
```
To:
```typescript
export type SourceType = 'sec_filing' | 'earnings_transcript' | 'news' | 'ir_page' | 'manual' | 'financialdata' | 'personal_note'
export type DocType = '10-K' | '10-Q' | '8-K' | 'transcript' | 'article' | 'ir_release' | 'manual' | 'press_release' | 'financial_statement' | 'note'
```

- [ ] **Step 2: Run the type-check to confirm no downstream breaks**

```bash
cd /Users/thanapold/Desktop/Projects/capital-intelligence-ingestion
npx tsc --noEmit
```
Expected: no errors (both types are union extensions, all existing usage still valid).

- [ ] **Step 3: Commit**

```bash
cd /Users/thanapold/Desktop/Projects/capital-intelligence-ingestion
git add src/types.ts
git commit -m "feat(types): add personal_note source and note doc type"
```

---

### Task 2: Create the personal-notes folder and processor

**Files:**
- Create: `capital-intelligence-ingestion/intake/personal-notes/.gitkeep`
- Create: `capital-intelligence-ingestion/src/intake/notes-processor.ts`
- Create: `capital-intelligence-ingestion/src/intake/notes-processor.test.ts`

- [ ] **Step 1: Create the intake folder**

```bash
mkdir -p /Users/thanapold/Desktop/Projects/capital-intelligence-ingestion/intake/personal-notes
touch /Users/thanapold/Desktop/Projects/capital-intelligence-ingestion/intake/personal-notes/.gitkeep
```

- [ ] **Step 2: Write the failing tests first**

Create `src/intake/notes-processor.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { processPersonalNotes } from './notes-processor.js'

describe('processPersonalNotes', () => {
  let dir: string

  beforeEach(() => {
    dir = join(tmpdir(), `notes-test-${Date.now()}`)
    mkdirSync(dir, { recursive: true })
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('returns empty array when directory is empty', async () => {
    const docs = await processPersonalNotes(dir)
    expect(docs).toEqual([])
  })

  it('parses a note with ticker and type frontmatter', async () => {
    writeFileSync(join(dir, 'arm-trade.md'), [
      '---',
      'ticker: ARM',
      'type: trade_rationale',
      'date: 2026-05-31',
      '---',
      'I bought because x86 displacement is underpriced.',
    ].join('\n'))

    const docs = await processPersonalNotes(dir)
    expect(docs).toHaveLength(1)
    expect(docs[0].ticker).toBe('ARM')
    expect(docs[0].source).toBe('personal_note')
    expect(docs[0].docType).toBe('note')
    expect(docs[0].publishedDate).toBe('2026-05-31')
    expect(docs[0].content).toContain('x86 displacement')
  })

  it('uses UNKNOWN ticker when frontmatter has no ticker', async () => {
    writeFileSync(join(dir, 'journal.md'), [
      '---',
      'type: journal',
      'date: 2026-05-31',
      '---',
      'Markets feel stretched.',
    ].join('\n'))

    const docs = await processPersonalNotes(dir)
    expect(docs).toHaveLength(1)
    expect(docs[0].ticker).toBe('UNKNOWN')
  })

  it('falls back to today for notes without a date field', async () => {
    writeFileSync(join(dir, 'nvda-note.md'), [
      '---',
      'ticker: NVDA',
      '---',
      'Jensen doubled down on sovereign AI.',
    ].join('\n'))

    const docs = await processPersonalNotes(dir)
    expect(docs).toHaveLength(1)
    expect(docs[0].publishedDate).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('skips files without .md extension', async () => {
    writeFileSync(join(dir, 'note.txt'), 'plain text')
    const docs = await processPersonalNotes(dir)
    expect(docs).toEqual([])
  })

  it('skips .gitkeep', async () => {
    writeFileSync(join(dir, '.gitkeep'), '')
    const docs = await processPersonalNotes(dir)
    expect(docs).toEqual([])
  })
})
```

- [ ] **Step 3: Run tests to verify they fail**

```bash
cd /Users/thanapold/Desktop/Projects/capital-intelligence-ingestion
npx vitest run src/intake/notes-processor.test.ts
```
Expected: FAIL — `notes-processor.js` not found.

- [ ] **Step 4: Implement `notes-processor.ts`**

Create `src/intake/notes-processor.ts`:

```typescript
import { readdirSync, readFileSync } from 'fs'
import { join, extname } from 'path'
import { randomUUID } from 'crypto'
import type { RawDocument } from '../types.js'

function parseFrontmatter(raw: string): { ticker?: string; type?: string; date?: string; body: string } {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/)
  if (!match) return { body: raw }
  const yaml = match[1]
  const body = match[2].trim()
  const ticker = yaml.match(/^ticker:\s*(.+)$/m)?.[1]?.trim()
  const type = yaml.match(/^type:\s*(.+)$/m)?.[1]?.trim()
  const date = yaml.match(/^date:\s*(.+)$/m)?.[1]?.trim()
  return { ticker, type, date, body }
}

export async function processPersonalNotes(notesDir: string): Promise<RawDocument[]> {
  const today = new Date().toISOString().slice(0, 10)

  let files: string[]
  try {
    files = readdirSync(notesDir).filter(f => f !== '.gitkeep' && extname(f) === '.md')
  } catch {
    return []
  }

  const results: RawDocument[] = []

  for (const file of files) {
    try {
      const raw = readFileSync(join(notesDir, file), 'utf-8')
      const { ticker, date, body } = parseFrontmatter(raw)
      const resolvedTicker = ticker ?? 'UNKNOWN'
      const resolvedDate = date ?? today
      const filePath = join(notesDir, file)

      results.push({
        id: randomUUID(),
        ticker: resolvedTicker,
        company: resolvedTicker,
        source: 'personal_note',
        docType: 'note',
        publishedDate: resolvedDate,
        fiscalPeriod: null,
        url: `file://${filePath}`,
        content: body,
      })
    } catch (err) {
      console.error(`[PersonalNotes] Failed to read ${file}:`, err)
    }
  }

  return results
}
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
cd /Users/thanapold/Desktop/Projects/capital-intelligence-ingestion
npx vitest run src/intake/notes-processor.test.ts
```
Expected: 6/6 PASS.

- [ ] **Step 6: Commit**

```bash
cd /Users/thanapold/Desktop/Projects/capital-intelligence-ingestion
git add intake/personal-notes/.gitkeep src/intake/notes-processor.ts src/intake/notes-processor.test.ts
git commit -m "feat(notes): add personal-notes intake processor"
```

---

### Task 3: Wire notes processor into the pipeline

**Files:**
- Modify: `capital-intelligence-ingestion/src/pipeline.ts`

- [ ] **Step 1: Add the import and call in `pipeline.ts`**

In `src/pipeline.ts`, add the import after the `processDropZone` import (around line 21):

```typescript
import { processPersonalNotes } from './intake/notes-processor.js'
```

Then add this block immediately after the dropzone block (after line ~96, where `dropDocs` block ends):

```typescript
  // Personal notes (always processed, files stay in place, dedup handles reruns)
  const notesDocs = await processPersonalNotes(join(INTAKE_DIR, 'personal-notes'))
  if (notesDocs.length > 0) {
    const chunks = await processDocuments(notesDocs, sqliteStore, lanceStore, embedder)
    console.log(`[PersonalNotes] ${notesDocs.length} notes → ${chunks} new chunks`)
    totalDocs += notesDocs.length
    totalChunks += chunks
  }
```

- [ ] **Step 2: Run a dry-run to confirm pipeline starts without errors**

```bash
cd /Users/thanapold/Desktop/Projects/capital-intelligence-ingestion
npx tsc --noEmit
```
Expected: no type errors.

- [ ] **Step 3: Commit**

```bash
cd /Users/thanapold/Desktop/Projects/capital-intelligence-ingestion
git add src/pipeline.ts
git commit -m "feat(pipeline): add personal-notes processor call"
```

---

### Task 4: Build `cli-note.ts` — quick capture with immediate embedding

**Files:**
- Create: `capital-intelligence-ingestion/src/cli/cli-note.ts`
- Modify: `capital-intelligence-ingestion/package.json`

- [ ] **Step 1: Create `src/cli/cli-note.ts`**

```typescript
// src/cli/cli-note.ts
import 'dotenv/config'
import { join } from 'path'
import { mkdirSync, writeFileSync } from 'fs'
import { randomUUID } from 'crypto'
import { createSQLiteStore } from '../store/sqlite.js'
import { createLanceStore } from '../store/lancedb.js'
import { createEmbedder } from '../pipeline/embedder.js'
import { chunkDocument } from '../pipeline/chunker.js'
import { buildChunkMetadata } from '../pipeline/metadata.js'
import { docHash } from '../store/dedup.js'
import type { RawDocument, Chunk } from '../types.js'

const DATA_DIR = join(process.cwd(), 'data')
const NOTES_DIR = join(process.cwd(), 'intake', 'personal-notes')

const args = process.argv.slice(2)
function getFlag(flag: string): string | undefined {
  const i = args.indexOf(flag)
  return i >= 0 ? args[i + 1] : undefined
}

const ticker = getFlag('--ticker')
const noteType = getFlag('--type') ?? (ticker ? 'thesis_observation' : 'journal')
const content = args.filter((a, i) => {
  if (a.startsWith('--')) return false
  const prev = args[i - 1]
  if (prev === '--ticker' || prev === '--type') return false
  return true
}).join(' ').trim()

if (!content) {
  console.error('Usage: npm run note -- [--ticker ARM] [--type trade_rationale] "Your note content"')
  process.exit(1)
}

async function main() {
  mkdirSync(NOTES_DIR, { recursive: true })
  mkdirSync(DATA_DIR, { recursive: true })

  const today = new Date().toISOString().slice(0, 10)
  const resolvedTicker = ticker ?? 'UNKNOWN'
  const slug = ticker ? `${ticker.toLowerCase()}-${noteType}-${today}` : `journal-${today}`
  const filename = `${slug}.md`
  const filePath = join(NOTES_DIR, filename)

  const frontmatter = [
    '---',
    ticker ? `ticker: ${ticker}` : null,
    `type: ${noteType}`,
    `date: ${today}`,
    '---',
    '',
    content,
  ].filter(l => l !== null).join('\n')

  writeFileSync(filePath, frontmatter, 'utf-8')
  console.log(`[Note] Written: ${filename}`)

  const doc: RawDocument = {
    id: randomUUID(),
    ticker: resolvedTicker,
    company: resolvedTicker,
    source: 'personal_note',
    docType: 'note',
    publishedDate: today,
    fiscalPeriod: null,
    url: `file://${filePath}`,
    content,
  }

  const sqliteStore = createSQLiteStore(join(DATA_DIR, 'sqlite.db'))
  const lanceStore = await createLanceStore(join(DATA_DIR, 'lancedb'))
  const embedder = createEmbedder()

  try {
    const hash = docHash(doc.ticker, doc.docType, doc.publishedDate, doc.url)
    if (sqliteStore.documentExists(hash)) {
      console.log('[Note] Already embedded — skipping')
      return
    }

    const chunkContents = chunkDocument(doc)
    if (chunkContents.length === 0) { console.log('[Note] No chunks produced'); return }

    const texts = chunkContents.map(c => c.content)
    const embeddings = await embedder.embed(texts)

    const chunks: Chunk[] = []
    for (let i = 0; i < chunkContents.length; i++) {
      const meta = buildChunkMetadata(doc, chunkContents[i])
      const exists = await lanceStore.chunkExists(meta.contentHash)
      if (!exists) chunks.push({ ...meta, content: chunkContents[i].content, embedding: embeddings[i] })
    }

    if (chunks.length > 0) await lanceStore.insertChunks(chunks)
    sqliteStore.markDocumentFetched(doc.ticker, hash)

    console.log(`[Note] Embedded: ${chunks.length} chunk(s) → searchable in /api/ask immediately`)
  } finally {
    sqliteStore.close()
  }
}

main().catch(err => { console.error(err); process.exit(1) })
```

- [ ] **Step 2: Add the `note` script to `package.json`**

In `capital-intelligence-ingestion/package.json`, add inside the `"scripts"` object:
```json
"note": "tsx src/cli/cli-note.ts"
```

- [ ] **Step 3: Type-check**

```bash
cd /Users/thanapold/Desktop/Projects/capital-intelligence-ingestion
npx tsc --noEmit
```
Expected: no errors.

- [ ] **Step 4: Smoke-test the CLI**

```bash
cd /Users/thanapold/Desktop/Projects/capital-intelligence-ingestion
npm run note -- --ticker ARM --type trade_rationale "Test note: ARM royalty model is being repriced by hyperscaler custom silicon"
```
Expected output:
```
[Note] Written: arm-trade_rationale-2026-05-31.md
[Note] Embedded: 1 chunk(s) → searchable in /api/ask immediately
```

- [ ] **Step 5: Commit**

```bash
cd /Users/thanapold/Desktop/Projects/capital-intelligence-ingestion
git add src/cli/cli-note.ts package.json
git commit -m "feat(cli): add cli-note quick-capture with immediate embedding"
```

---

### Task 5: Dashboard API route — POST /api/notes

**Files:**
- Create: `capital-intel-dashboard/src/app/api/notes/route.ts`

- [ ] **Step 1: Create `src/app/api/notes/route.ts`**

```typescript
import { NextRequest, NextResponse } from 'next/server'
import { writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'

const DATA_ROOT = process.env.DATA_ROOT ?? join(process.cwd(), '..', 'capital-intelligence-ingestion')
const NOTES_DIR = join(DATA_ROOT, 'intake', 'personal-notes')

export async function POST(req: NextRequest): Promise<NextResponse> {
  let body: { ticker?: string; type?: string; content?: string }
  try {
    body = await req.json() as { ticker?: string; type?: string; content?: string }
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const content = body.content?.trim()
  if (!content) {
    return NextResponse.json({ error: 'content is required' }, { status: 400 })
  }

  const ticker = body.ticker?.trim().toUpperCase() || undefined
  const noteType = body.type?.trim() || (ticker ? 'thesis_observation' : 'journal')
  const today = new Date().toISOString().slice(0, 10)
  const slug = ticker ? `${ticker.toLowerCase()}-${noteType}-${today}` : `journal-${today}`
  const filename = `${slug}.md`

  const frontmatter = [
    '---',
    ticker ? `ticker: ${ticker}` : null,
    `type: ${noteType}`,
    `date: ${today}`,
    '---',
    '',
    content,
  ].filter((l): l is string => l !== null).join('\n')

  try {
    mkdirSync(NOTES_DIR, { recursive: true })
    writeFileSync(join(NOTES_DIR, filename), frontmatter, 'utf-8')
  } catch (err) {
    console.error('[POST /api/notes] Write failed:', err)
    return NextResponse.json({ error: 'Failed to write note' }, { status: 500 })
  }

  return NextResponse.json({ ok: true, filename })
}
```

- [ ] **Step 2: Type-check the dashboard**

```bash
cd /Users/thanapold/Desktop/Projects/capital-intel-dashboard
npx tsc --noEmit
```
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
cd /Users/thanapold/Desktop/Projects/capital-intel-dashboard
git add src/app/api/notes/route.ts
git commit -m "feat(dashboard): add POST /api/notes write endpoint"
```

---

### Task 6: Dashboard notes page

**Files:**
- Create: `capital-intel-dashboard/src/app/notes/page.tsx`

- [ ] **Step 1: Create `src/app/notes/page.tsx`**

```tsx
'use client'
import { useState } from 'react'

const NOTE_TYPES = [
  { value: 'trade_rationale', label: 'Trade Rationale' },
  { value: 'thesis_observation', label: 'Thesis Observation' },
  { value: 'market_thought', label: 'Market Thought' },
  { value: 'post_trade', label: 'Post-Trade' },
  { value: 'journal', label: 'Journal' },
]

export default function NotesPage() {
  const [ticker, setTicker] = useState('')
  const [noteType, setNoteType] = useState('thesis_observation')
  const [content, setContent] = useState('')
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const [errorMsg, setErrorMsg] = useState('')

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!content.trim()) return
    setStatus('saving')
    setErrorMsg('')

    try {
      const res = await fetch('/api/notes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ticker: ticker.trim().toUpperCase() || undefined,
          type: noteType,
          content: content.trim(),
        }),
      })
      if (!res.ok) {
        const data = await res.json() as { error?: string }
        throw new Error(data.error ?? 'Save failed')
      }
      setStatus('saved')
      setContent('')
      setTicker('')
      setTimeout(() => setStatus('idle'), 3000)
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Save failed')
      setStatus('error')
    }
  }

  return (
    <div className="max-w-2xl space-y-6">
      <h1 className="text-base font-bold text-text-primary">Capture a Note</h1>
      <p className="text-xs text-text-secondary">
        Notes are written to <code className="font-mono">intake/personal-notes/</code> and embedded on the next pipeline run.
        For immediate embedding, use <code className="font-mono">npm run note</code> in the terminal.
      </p>

      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-xs font-medium text-text-secondary mb-1">Ticker (optional)</label>
            <input
              type="text"
              value={ticker}
              onChange={e => setTicker(e.target.value)}
              placeholder="ARM"
              maxLength={10}
              className="w-full bg-bg-secondary border border-border-primary rounded px-3 py-2 text-sm text-text-primary placeholder-text-tertiary focus:outline-none focus:border-accent-primary"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-text-secondary mb-1">Type</label>
            <select
              value={noteType}
              onChange={e => setNoteType(e.target.value)}
              className="w-full bg-bg-secondary border border-border-primary rounded px-3 py-2 text-sm text-text-primary focus:outline-none focus:border-accent-primary"
            >
              {NOTE_TYPES.map(t => (
                <option key={t.value} value={t.value}>{t.label}</option>
              ))}
            </select>
          </div>
        </div>

        <div>
          <label className="block text-xs font-medium text-text-secondary mb-1">Note</label>
          <textarea
            value={content}
            onChange={e => setContent(e.target.value)}
            placeholder="Your thinking about this position, market observation, or trade rationale..."
            rows={6}
            className="w-full bg-bg-secondary border border-border-primary rounded px-3 py-2 text-sm text-text-primary placeholder-text-tertiary focus:outline-none focus:border-accent-primary resize-none"
          />
        </div>

        <div className="flex items-center gap-3">
          <button
            type="submit"
            disabled={status === 'saving' || !content.trim()}
            className="px-4 py-2 bg-accent-primary text-bg-primary text-sm font-medium rounded hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {status === 'saving' ? 'Saving...' : 'Save Note'}
          </button>
          {status === 'saved' && (
            <span className="text-xs text-green-400">Saved — will embed on next pipeline run</span>
          )}
          {status === 'error' && (
            <span className="text-xs text-red-400">{errorMsg}</span>
          )}
        </div>
      </form>
    </div>
  )
}
```

- [ ] **Step 2: Type-check**

```bash
cd /Users/thanapold/Desktop/Projects/capital-intel-dashboard
npx tsc --noEmit
```
Expected: no errors.

- [ ] **Step 3: Run dev server and verify the page renders**

```bash
cd /Users/thanapold/Desktop/Projects/capital-intel-dashboard
npm run dev
```
Navigate to `http://localhost:3000/notes`. Verify:
- Ticker input, type selector, textarea, and Save button render correctly.
- Submitting a note shows "Saved — will embed on next pipeline run" confirmation.
- A `.md` file appears in `capital-intelligence-ingestion/intake/personal-notes/`.

- [ ] **Step 4: Commit**

```bash
cd /Users/thanapold/Desktop/Projects/capital-intel-dashboard
git add src/app/notes/page.tsx
git commit -m "feat(dashboard): add notes capture page"
```
