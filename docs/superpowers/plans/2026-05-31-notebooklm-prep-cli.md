# NotebookLM Prep CLI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `notebooklm` CLI to `capital-intelligence-ingestion` that exports document bundles ready to upload to NotebookLM notebooks for 4 use cases: per-ticker sources, drift review, macro intel, and trade post-mortem.

**Architecture:** Pure export functions in `src/notebooklm/exporters.ts` handle each bundle type and are tested independently. A thin CLI in `src/cli/cli-notebooklm.ts` parses args and routes to those functions. Output lands in `notebooklm-exports/<command>-<date>/` with one .md file per document plus a README with upload instructions and suggested questions.

**Tech Stack:** TypeScript/ESM, Node.js fs/path (already in project), `@lancedb/lancedb` (already installed), `vitest` (already installed), `tsx` (already installed)

---

## File Map

| File | Status | Purpose |
|------|--------|---------|
| `src/notebooklm/exporters.ts` | CREATE | Export functions + `groupChunksByDoc` helper |
| `src/notebooklm/exporters.test.ts` | CREATE | Unit tests for all sync export functions |
| `src/cli/cli-notebooklm.ts` | CREATE | CLI entry point: parse args, call exporters, print output paths |
| `package.json` | MODIFY | Add `"notebooklm": "tsx src/cli/cli-notebooklm.ts"` script |

---

## Task 1: Core export functions

**Files:**
- Create: `src/notebooklm/exporters.ts`

- [ ] **Step 1: Write the failing test**

Create `src/notebooklm/exporters.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import type { Chunk } from '../types.js'
import { groupChunksByDoc, exportDriftBundle, exportMacroBundle, exportPostmortemBundle } from './exporters.js'

let tmpDir: string

beforeEach(() => {
  tmpDir = join(tmpdir(), `notebooklm-test-${Date.now()}`)
  mkdirSync(tmpDir, { recursive: true })
})

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true })
})

describe('groupChunksByDoc', () => {
  it('groups chunks by parentDocId and sorts by chunkIndex', () => {
    const chunks: Partial<Chunk>[] = [
      { parentDocId: 'doc1', chunkIndex: 1, content: 'second' },
      { parentDocId: 'doc1', chunkIndex: 0, content: 'first' },
      { parentDocId: 'doc2', chunkIndex: 0, content: 'only' },
    ]
    const result = groupChunksByDoc(chunks as Chunk[])
    expect(result.size).toBe(2)
    expect(result.get('doc1')![0].content).toBe('first')
    expect(result.get('doc1')![1].content).toBe('second')
    expect(result.get('doc2')![0].content).toBe('only')
  })

  it('returns empty map for empty input', () => {
    expect(groupChunksByDoc([]).size).toBe(0)
  })
})

describe('exportDriftBundle', () => {
  it('returns 0 when briefings dir does not exist', () => {
    const count = exportDriftBundle('2026-01-01', '2026-01-31', join(tmpDir, 'no-dir'), join(tmpDir, 'out'))
    expect(count).toBe(0)
  })

  it('exports only briefings within the date range', () => {
    const briefingsDir = join(tmpDir, 'briefings')
    mkdirSync(briefingsDir)
    writeFileSync(join(briefingsDir, '2026-01-01.md'), '# Jan 1')
    writeFileSync(join(briefingsDir, '2026-01-15.md'), '# Jan 15')
    writeFileSync(join(briefingsDir, '2026-02-01.md'), '# Feb 1')

    const outDir = join(tmpDir, 'out')
    const count = exportDriftBundle('2026-01-01', '2026-01-31', briefingsDir, outDir)

    expect(count).toBe(2)
    expect(existsSync(join(outDir, '2026-01-01.md'))).toBe(true)
    expect(existsSync(join(outDir, '2026-01-15.md'))).toBe(true)
    expect(existsSync(join(outDir, '2026-02-01.md'))).toBe(false)
    expect(existsSync(join(outDir, 'README.md'))).toBe(true)
  })
})

describe('exportMacroBundle', () => {
  it('creates README even when both intel files are missing', () => {
    const outDir = join(tmpDir, 'out')
    exportMacroBundle(join(tmpDir, 'no.json'), join(tmpDir, 'no.json'), outDir)
    expect(existsSync(join(outDir, 'README.md'))).toBe(true)
  })

  it('exports stock intel events as markdown and returns count 1', () => {
    const stockPath = join(tmpDir, 'stock.json')
    writeFileSync(stockPath, JSON.stringify({
      date: '2026-05-31',
      marketEvents: [{ title: 'ARM rally', severity: 3, eventType: 'earnings', marketDirection: 'up', summary: 'ARM stock rallied 5%' }],
    }))
    const outDir = join(tmpDir, 'out')
    const count = exportMacroBundle(stockPath, join(tmpDir, 'no.json'), outDir)
    expect(count).toBe(1)
    const content = readFileSync(join(outDir, 'stock-intelligence.md'), 'utf8')
    expect(content).toContain('ARM rally')
    expect(content).toContain('3/5')
  })
})

describe('exportPostmortemBundle', () => {
  it('returns 0 when portfolio file is missing', () => {
    expect(exportPostmortemBundle('2026-05-01', join(tmpDir, 'no.json'), join(tmpDir, 'out'))).toBe(0)
  })

  it('includes only closed trades on or after fromDate', () => {
    const portfolioPath = join(tmpDir, 'portfolio.json')
    writeFileSync(portfolioPath, JSON.stringify({
      closedPositions: [
        { ticker: 'AAPL', entryPrice: 200, closePrice: 210, shares: 10, pnl: 100, openedAt: '2026-05-10T00:00:00Z', closedAt: '2026-05-15T00:00:00Z', signal: 'buy' },
        { ticker: 'NVDA', entryPrice: 100, closePrice: 90,  shares: 5,  pnl: -50, openedAt: '2026-04-01T00:00:00Z', closedAt: '2026-04-05T00:00:00Z', signal: 'sell' },
      ],
    }))
    const outDir = join(tmpDir, 'out')
    const count = exportPostmortemBundle('2026-05-01', portfolioPath, outDir)
    expect(count).toBe(1)
    const content = readFileSync(join(outDir, 'trades.md'), 'utf8')
    expect(content).toContain('AAPL')
    expect(content).not.toContain('NVDA')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd /Users/thanapold/Desktop/Projects/capital-intelligence-ingestion
npm test -- exporters
```

Expected: FAIL — `Cannot find module './exporters.js'`

- [ ] **Step 3: Implement exporters.ts**

Create `src/notebooklm/exporters.ts`:

```typescript
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { createLanceStore } from '../store/lancedb.js'
import type { Chunk } from '../types.js'

export function groupChunksByDoc(chunks: Chunk[]): Map<string, Chunk[]> {
  const byDoc = new Map<string, Chunk[]>()
  for (const chunk of chunks) {
    if (!byDoc.has(chunk.parentDocId)) byDoc.set(chunk.parentDocId, [])
    byDoc.get(chunk.parentDocId)!.push(chunk)
  }
  for (const [, docChunks] of byDoc) {
    docChunks.sort((a, b) => a.chunkIndex - b.chunkIndex)
  }
  return byDoc
}

export async function exportTickerBundle(
  ticker: string,
  lanceDbPath: string,
  outDir: string
): Promise<number> {
  const lanceStore = await createLanceStore(lanceDbPath)
  try {
    const chunks = await lanceStore.filterByTicker(ticker)
    if (chunks.length === 0) return 0

    const byDoc = groupChunksByDoc(chunks)
    mkdirSync(outDir, { recursive: true })

    const docLines: string[] = []
    for (const [, docChunks] of byDoc) {
      const first = docChunks[0]
      const slug = `${first.source}-${first.docType}-${first.publishedDate}`.replace(/[^a-zA-Z0-9-]/g, '-')
      const content = [
        `# ${first.company} — ${first.docType}`,
        '',
        `**Source:** ${first.source}`,
        `**Date:** ${first.publishedDate}`,
        `**URL:** ${first.url}`,
        '',
        '---',
        '',
        ...docChunks.map(c => c.content),
      ].join('\n')
      writeFileSync(join(outDir, `${slug}.md`), content, 'utf8')
      docLines.push(`- ${first.source} / ${first.docType} (${first.publishedDate})`)
    }

    const readme = [
      `# NotebookLM Sources: ${ticker}`,
      '',
      'Upload all .md files in this folder to a NotebookLM notebook.',
      '',
      '## Suggested questions',
      `- What is the current earnings growth trajectory for ${ticker}?`,
      `- What risks did management acknowledge in the most recent earnings call?`,
      `- How has guidance changed quarter over quarter?`,
      `- What competitive threats are mentioned across these filings?`,
      `- Is the investment thesis strengthening or weakening based on these documents?`,
      '',
      '## Documents included',
      ...docLines,
    ].join('\n')
    writeFileSync(join(outDir, 'README.md'), readme, 'utf8')

    return byDoc.size
  } finally {
    lanceStore.close()
  }
}

export function exportDriftBundle(
  fromDate: string,
  toDate: string,
  briefingsDir: string,
  outDir: string
): number {
  if (!existsSync(briefingsDir)) return 0

  const files = readdirSync(briefingsDir)
    .filter(f => f.endsWith('.md') && f >= `${fromDate}.md` && f <= `${toDate}.md`)
    .sort()

  if (files.length === 0) return 0

  mkdirSync(outDir, { recursive: true })
  for (const file of files) {
    writeFileSync(join(outDir, file), readFileSync(join(briefingsDir, file), 'utf8'), 'utf8')
  }

  const readme = [
    `# NotebookLM Drift Review: ${fromDate} to ${toDate}`,
    '',
    'Upload all .md files to a NotebookLM notebook.',
    '',
    '## Suggested questions',
    '- Which positions showed thesis deterioration across this period?',
    '- What were the key macro regime changes?',
    '- Which scenario (base/disruption/best) gained or lost probability over time?',
    '- What were the recurring risk factors mentioned?',
    '- Which positions were recommended for trimming/exit and why?',
    '',
    '## Files included',
    ...files.map(f => `- ${f}`),
  ].join('\n')
  writeFileSync(join(outDir, 'README.md'), readme, 'utf8')

  return files.length
}

export function exportMacroBundle(
  stockIntelPath: string,
  worldIntelPath: string,
  outDir: string
): number {
  mkdirSync(outDir, { recursive: true })
  let count = 0

  if (existsSync(stockIntelPath)) {
    const intel = JSON.parse(readFileSync(stockIntelPath, 'utf8')) as {
      date?: string
      marketEvents?: Array<{ title: string; severity: number; eventType: string; marketDirection?: string; summary: string }>
    }
    const lines = [`# Stock Market Intelligence\n\n**Date:** ${intel.date ?? 'unknown'}\n`]
    for (const e of intel.marketEvents ?? []) {
      lines.push(`\n## ${e.title}\n\n**Severity:** ${e.severity}/5  \n**Type:** ${e.eventType}  \n**Direction:** ${e.marketDirection ?? 'unknown'}\n\n${e.summary}\n\n---`)
    }
    writeFileSync(join(outDir, 'stock-intelligence.md'), lines.join('\n'), 'utf8')
    count++
  }

  if (existsSync(worldIntelPath)) {
    const intel = JSON.parse(readFileSync(worldIntelPath, 'utf8')) as {
      date?: string
      events?: Array<{ title: string; severity: number; escalationPotential?: number; countries?: string[]; summary: string }>
    }
    const lines = [`# World Intelligence Events\n\n**Date:** ${intel.date ?? 'unknown'}\n`]
    for (const e of intel.events ?? []) {
      lines.push(`\n## ${e.title}\n\n**Severity:** ${e.severity}/5  \n**Escalation:** ${((e.escalationPotential ?? 0) * 100).toFixed(0)}%  \n**Countries:** ${(e.countries ?? []).join(', ')}\n\n${e.summary}\n\n---`)
    }
    writeFileSync(join(outDir, 'world-intelligence.md'), lines.join('\n'), 'utf8')
    count++
  }

  const readme = [
    '# NotebookLM Macro & Geopolitical Notebook',
    '',
    'Upload all .md files to a NotebookLM notebook.',
    '',
    '## Suggested questions',
    '- What geopolitical events pose the highest risk to energy markets?',
    '- Which market events are most likely to trigger a disruption scenario?',
    '- What sectors are most exposed to the highest-severity events?',
    '- How do current events compare to historical escalation patterns?',
    '- What is the combined probability weight for supply shock scenarios?',
  ].join('\n')
  writeFileSync(join(outDir, 'README.md'), readme, 'utf8')

  return count
}

interface ClosedPosition {
  ticker: string
  signal?: string
  entryPrice: number
  closePrice: number
  shares: number
  pnl: number
  openedAt: string
  closedAt: string
}

export function exportPostmortemBundle(
  fromDate: string,
  wavePortfolioPath: string,
  outDir: string
): number {
  if (!existsSync(wavePortfolioPath)) return 0

  const portfolio = JSON.parse(readFileSync(wavePortfolioPath, 'utf8')) as {
    closedPositions?: ClosedPosition[]
  }

  const closed = (portfolio.closedPositions ?? []).filter(
    p => (p.closedAt ?? '').slice(0, 10) >= fromDate
  )

  if (closed.length === 0) return 0

  mkdirSync(outDir, { recursive: true })

  const lines = [
    `# Trade Post-Mortem: from ${fromDate}`,
    '',
    `**Total trades:** ${closed.length}  `,
    `**Total P&L:** $${closed.reduce((s, p) => s + p.pnl, 0).toFixed(2)}`,
    '',
    '## Individual Trades',
    '',
  ]

  for (const trade of closed) {
    const outcome = trade.pnl >= 0 ? 'WIN' : 'LOSS'
    lines.push(
      `### ${trade.ticker} — ${outcome} ($${trade.pnl >= 0 ? '+' : ''}${trade.pnl.toFixed(2)})`,
      '',
      `- **Entry:** $${trade.entryPrice} on ${trade.openedAt.slice(0, 10)}`,
      `- **Exit:** $${trade.closePrice} on ${trade.closedAt.slice(0, 10)}`,
      `- **Shares:** ${trade.shares}`,
      `- **Signal:** ${trade.signal ?? 'unknown'}`,
      '',
    )
  }

  writeFileSync(join(outDir, 'trades.md'), lines.join('\n'), 'utf8')

  const readme = [
    '# Trade Post-Mortem NotebookLM Bundle',
    '',
    'Upload trades.md to a NotebookLM notebook.',
    '',
    '## Suggested questions',
    '- What patterns preceded the losing trades?',
    '- Were there common entry signals among winning trades?',
    '- Which tickers had the highest win rate?',
    '- What was the average holding period for wins vs losses?',
    '- Was there a time-of-day or day-of-week pattern in profitable entries?',
  ].join('\n')
  writeFileSync(join(outDir, 'README.md'), readme, 'utf8')

  return 1
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd /Users/thanapold/Desktop/Projects/capital-intelligence-ingestion
npm test -- exporters
```

Expected:
```
✓ groupChunksByDoc > groups chunks by parentDocId and sorts by chunkIndex
✓ groupChunksByDoc > returns empty map for empty input
✓ exportDriftBundle > returns 0 when briefings dir does not exist
✓ exportDriftBundle > exports only briefings within the date range
✓ exportMacroBundle > creates README even when both intel files are missing
✓ exportMacroBundle > exports stock intel events as markdown and returns count 1
✓ exportPostmortemBundle > returns 0 when portfolio file is missing
✓ exportPostmortemBundle > includes only closed trades on or after fromDate
Tests: 8 passed
```

- [ ] **Step 5: Commit**

```bash
cd /Users/thanapold/Desktop/Projects/capital-intelligence-ingestion
git add src/notebooklm/exporters.ts src/notebooklm/exporters.test.ts
git commit -m "feat(notebooklm): add export functions for ticker, drift, macro, postmortem bundles"
```

---

## Task 2: CLI entry point

**Files:**
- Create: `src/cli/cli-notebooklm.ts`
- Modify: `package.json`

- [ ] **Step 1: Implement cli-notebooklm.ts**

Create `src/cli/cli-notebooklm.ts`:

```typescript
import 'dotenv/config'
import { join } from 'path'
import {
  exportTickerBundle,
  exportDriftBundle,
  exportMacroBundle,
  exportPostmortemBundle,
} from '../notebooklm/exporters.js'

const DATA_ROOT = process.env.DATA_ROOT ?? join(process.cwd(), '..')
const LANCE_DB = join(process.cwd(), 'data', 'lancedb')
const BRIEFINGS_DIR = join(DATA_ROOT, 'investment-analyst-agents', 'briefings')
const STOCK_INTEL = join(DATA_ROOT, 'world-intelligence-data-hub-', 'exports', 'stock-project', 'intelligence.json')
const WORLD_INTEL = join(DATA_ROOT, 'world-intelligence-data-hub-', 'exports', 'world-map', 'intelligence.json')
const WAVE_PORTFOLIO = join(DATA_ROOT, 'wave-analyzer', 'data', 'wave-portfolio.json')
const OUT_ROOT = join(process.cwd(), 'notebooklm-exports')

const args = process.argv.slice(2)
const cmd = args[0]

function getArg(flag: string): string | null {
  const idx = args.indexOf(flag)
  return idx >= 0 && args[idx + 1] ? args[idx + 1] : null
}

function today(): string {
  return new Date().toISOString().slice(0, 10)
}

function daysAgo(n: number): string {
  return new Date(Date.now() - n * 86400000).toISOString().slice(0, 10)
}

async function main() {
  switch (cmd) {
    case 'ticker': {
      const ticker = getArg('--ticker')
      if (!ticker) {
        console.error('Usage: notebooklm ticker --ticker <TICKER>')
        process.exit(1)
      }
      const outDir = join(OUT_ROOT, `ticker-${ticker}-${today()}`)
      const count = await exportTickerBundle(ticker.toUpperCase(), LANCE_DB, outDir)
      if (count === 0) {
        console.log(`[ticker] No documents found for ${ticker}`)
      } else {
        console.log(`[ticker] ${ticker}: ${count} docs exported`)
        console.log(`→ Upload folder to NotebookLM: ${outDir}`)
      }
      break
    }

    case 'drift': {
      const from = getArg('--from') ?? daysAgo(90)
      const to = getArg('--to') ?? today()
      const outDir = join(OUT_ROOT, `drift-${from}-to-${to}`)
      const count = exportDriftBundle(from, to, BRIEFINGS_DIR, outDir)
      if (count === 0) {
        console.log(`[drift] No briefings found between ${from} and ${to}`)
      } else {
        console.log(`[drift] ${count} briefings exported`)
        console.log(`→ Upload folder to NotebookLM: ${outDir}`)
      }
      break
    }

    case 'macro': {
      const outDir = join(OUT_ROOT, `macro-${today()}`)
      const count = exportMacroBundle(STOCK_INTEL, WORLD_INTEL, outDir)
      console.log(`[macro] ${count} intel files exported`)
      console.log(`→ Upload folder to NotebookLM: ${outDir}`)
      break
    }

    case 'postmortem': {
      const from = getArg('--from') ?? daysAgo(30)
      const outDir = join(OUT_ROOT, `postmortem-${from}-to-${today()}`)
      const count = exportPostmortemBundle(from, WAVE_PORTFOLIO, outDir)
      if (count === 0) {
        console.log(`[postmortem] No closed trades found since ${from}`)
      } else {
        console.log(`[postmortem] Trade bundle exported`)
        console.log(`→ Upload folder to NotebookLM: ${outDir}`)
      }
      break
    }

    default:
      console.log(`Usage: npm run notebooklm -- <command> [options]

Commands:
  ticker --ticker <TICKER>          Bundle all ingested docs for a ticker
  drift [--from YYYY-MM-DD] [--to YYYY-MM-DD]
                                    Bundle daily briefings for a date range (default: last 90d)
  macro                             Bundle world intelligence exports
  postmortem [--from YYYY-MM-DD]    Bundle closed trade log (default: last 30d)

Examples:
  npm run notebooklm -- ticker --ticker ARM
  npm run notebooklm -- drift --from 2026-03-01 --to 2026-05-31
  npm run notebooklm -- macro
  npm run notebooklm -- postmortem --from 2026-05-01
`)
      process.exit(1)
  }
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
```

- [ ] **Step 2: Add script to package.json**

In `package.json`, add to the `scripts` object:

```json
"notebooklm": "tsx src/cli/cli-notebooklm.ts"
```

Full scripts block becomes:
```json
"scripts": {
  "pipeline": "tsx src/pipeline.ts",
  "add": "tsx src/intake/cli-add.ts",
  "config": "tsx src/intake/cli-config.ts",
  "search": "tsx src/query/cli-search.ts",
  "schedule": "tsx src/scheduler.ts",
  "watchlist": "tsx src/intake/cli-watchlist.ts",
  "notebooklm": "tsx src/cli/cli-notebooklm.ts",
  "test": "vitest run",
  "test:watch": "vitest"
}
```

- [ ] **Step 3: Smoke-test the CLI**

```bash
cd /Users/thanapold/Desktop/Projects/capital-intelligence-ingestion
npm run notebooklm -- macro
```

Expected output:
```
[macro] 2 intel files exported
→ Upload folder to NotebookLM: /Users/thanapold/Desktop/Projects/capital-intelligence-ingestion/notebooklm-exports/macro-2026-05-31
```

Then verify the folder exists:
```bash
ls notebooklm-exports/macro-*/
```

Expected: `README.md  stock-intelligence.md  world-intelligence.md`

- [ ] **Step 4: Smoke-test drift export**

```bash
npm run notebooklm -- drift --from 2026-05-26 --to 2026-05-31
```

Expected:
```
[drift] 6 briefings exported
→ Upload folder to NotebookLM: .../notebooklm-exports/drift-2026-05-26-to-2026-05-31
```

- [ ] **Step 5: Commit**

```bash
cd /Users/thanapold/Desktop/Projects/capital-intelligence-ingestion
git add src/cli/cli-notebooklm.ts package.json
git commit -m "feat(notebooklm): add CLI for exporting document bundles"
```

---

## Task 3: Add notebooklm-exports to .gitignore

**Files:**
- Modify: `.gitignore`

- [ ] **Step 1: Check what .gitignore currently contains**

```bash
cat /Users/thanapold/Desktop/Projects/capital-intelligence-ingestion/.gitignore
```

- [ ] **Step 2: Add notebooklm-exports to .gitignore**

Append this line to `.gitignore`:
```
notebooklm-exports/
```

- [ ] **Step 3: Commit**

```bash
cd /Users/thanapold/Desktop/Projects/capital-intelligence-ingestion
git add .gitignore
git commit -m "chore: ignore notebooklm-exports directory"
```

---

## Self-Review

**Spec coverage:**
- ✅ Use case 1 (ticker bundle): `exportTickerBundle` + `ticker` command
- ✅ Use case 3 (drift review): `exportDriftBundle` + `drift` command
- ✅ Use case 4 (macro): `exportMacroBundle` + `macro` command
- ✅ Use case 5/6 (pre-earnings/watchlist): same `ticker` command, different ticker arg
- ✅ Use case 8 (postmortem): `exportPostmortemBundle` + `postmortem` command
- ✅ Use case 2 (briefing audio): covered by `drift --from <today> --to <today>` or just copying the file

**No placeholders:** All functions have complete implementations with real field names from the actual data schemas.

**Type consistency:** `ClosedPosition` interface matches actual `wave-portfolio.json` fields (`closedAt`, `closePrice`, `openedAt`, `pnl`).
