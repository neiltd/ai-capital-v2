# AI-Powered News Paste Intake — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `pbpaste | npm run paste` to `apps/capital-intelligence-ingestion` — Claude extracts tickers, headline, and impact from any freeform text, then writes one drop file per ticker per story into `intake/drop/`.

**Architecture:** A thin CLI (`cli-paste.ts`) reads stdin, delegates to a pure extraction module (`paste-extractor.ts`) that calls the Anthropic API, then writes drop files in the same format the existing dropzone processor already handles. No changes to the pipeline, store, or types.

**Tech Stack:** TypeScript/tsx, `@anthropic-ai/sdk` (already installed), vitest, Node.js `fs`/`path`

---

## File Map

| Action | Path | Responsibility |
|---|---|---|
| Create | `src/intake/paste-extractor.ts` | Claude API call + JSON parsing, no file I/O |
| Create | `src/intake/paste-extractor.test.ts` | Unit tests for extractor (mock Anthropic) |
| Create | `src/intake/cli-paste.ts` | stdin → extractor → drop files → summary |
| Modify | `package.json` | Add `"paste"` script |

---

## Task 1: Extraction module with types

**Files:**
- Create: `src/intake/paste-extractor.ts`

- [ ] **Step 1: Create `src/intake/paste-extractor.ts`**

```typescript
import Anthropic from '@anthropic-ai/sdk'

export interface ExtractedStory {
  tickers: string[]       // e.g. ["NVDA", "MSFT"] or ["MACRO"]
  headline: string
  impact: string
  doc_type: string
}

const SYSTEM_PROMPT = `You are a financial news analyst. Extract structured data from the user's pasted text.

Return a JSON array of stories. Each story must have:
- tickers: array of stock tickers affected (use uppercase, e.g. "NVDA"). For companies with no listed ticker (private companies, Chinese firms without US listing), use "MACRO". A single story can affect multiple tickers.
- headline: concise English headline (max 120 chars)
- impact: one sentence explaining the investment significance
- doc_type: always "article"

Rules:
- Think about implied impacts too: an OpenAI cost-cut story affects NVDA (GPU demand) even if NVDA isn't mentioned
- If the same story affects multiple companies, list all tickers — it will be stored once per ticker
- Source attribution lines (e.g. "Source: Reuters, TechCrunch") are NOT stories — skip them
- Header/title lines (e.g. "📰 Tech News Daily — 1 July") are NOT stories — skip them

Return ONLY valid JSON with no markdown fences, no explanation. Example:
[{"tickers":["NVDA","MSFT"],"headline":"OpenAI cuts inference cost 50% via software","impact":"Reduces near-term GPU demand; MSFT benefits from lower OpenAI opex","doc_type":"article"}]`

export async function extractStories(
  text: string,
  apiKey: string,
): Promise<ExtractedStory[]> {
  const client = new Anthropic({ apiKey })

  const response = await client.messages.create({
    model:      'claude-haiku-4-5-20251001',
    max_tokens: 2048,
    system:     SYSTEM_PROMPT,
    messages:   [{ role: 'user', content: text }],
  })

  const raw = response.content.find(b => b.type === 'text')?.text ?? ''

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    // Retry with a stricter prompt
    const retry = await client.messages.create({
      model:      'claude-haiku-4-5-20251001',
      max_tokens: 2048,
      system:     SYSTEM_PROMPT,
      messages:   [
        { role: 'user',      content: text },
        { role: 'assistant', content: raw },
        { role: 'user',      content: 'Your response was not valid JSON. Return ONLY the JSON array, no other text.' },
      ],
    })
    const retryRaw = retry.content.find(b => b.type === 'text')?.text ?? ''
    parsed = JSON.parse(retryRaw)
  }

  if (!Array.isArray(parsed)) {
    throw new Error(`Expected JSON array from Claude, got: ${typeof parsed}`)
  }

  return parsed.map((item: unknown): ExtractedStory => {
    const s = item as Record<string, unknown>
    const tickers = Array.isArray(s['tickers'])
      ? (s['tickers'] as unknown[]).map(t => String(t).toUpperCase()).filter(Boolean)
      : ['MACRO']
    return {
      tickers:  tickers.length > 0 ? tickers : ['MACRO'],
      headline: String(s['headline'] ?? '').slice(0, 120),
      impact:   String(s['impact']   ?? ''),
      doc_type: String(s['doc_type'] ?? 'article'),
    }
  })
}
```

- [ ] **Step 2: Commit**

```bash
cd apps/capital-intelligence-ingestion
git add src/intake/paste-extractor.ts
git commit -m "feat(paste): extraction module with Claude API call"
```

---

## Task 2: Unit tests for extractor

**Files:**
- Create: `src/intake/paste-extractor.test.ts`

- [ ] **Step 1: Create `src/intake/paste-extractor.test.ts`**

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { extractStories } from './paste-extractor.js'

// Mock the Anthropic SDK so tests don't hit the real API
vi.mock('@anthropic-ai/sdk', () => {
  return {
    default: vi.fn().mockImplementation(() => ({
      messages: {
        create: vi.fn(),
      },
    })),
  }
})

import Anthropic from '@anthropic-ai/sdk'

function mockResponse(text: string) {
  const instance = new (Anthropic as ReturnType<typeof vi.fn>)()
  ;(instance.messages.create as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
    content: [{ type: 'text', text }],
  })
  return instance
}

describe('extractStories', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('parses a single-ticker story', async () => {
    const json = JSON.stringify([
      { tickers: ['RKLB'], headline: 'Rocket Lab buys Iridium for $8B', impact: 'Valuation re-rate catalyst', doc_type: 'article' },
    ])
    mockResponse(json)
    const stories = await extractStories('some text', 'fake-key')
    expect(stories).toHaveLength(1)
    expect(stories[0]!.tickers).toEqual(['RKLB'])
    expect(stories[0]!.headline).toBe('Rocket Lab buys Iridium for $8B')
  })

  it('parses a multi-ticker story', async () => {
    const json = JSON.stringify([
      { tickers: ['AAPL', 'GOOGL'], headline: 'UK CMA targets Apple and Google', impact: 'App Store revenue risk', doc_type: 'article' },
    ])
    mockResponse(json)
    const stories = await extractStories('some text', 'fake-key')
    expect(stories[0]!.tickers).toEqual(['AAPL', 'GOOGL'])
  })

  it('falls back to MACRO when tickers array is empty', async () => {
    const json = JSON.stringify([
      { tickers: [], headline: 'Meituan releases LongCat-2.0', impact: 'China AI chip independence', doc_type: 'article' },
    ])
    mockResponse(json)
    const stories = await extractStories('some text', 'fake-key')
    expect(stories[0]!.tickers).toEqual(['MACRO'])
  })

  it('uppercases tickers', async () => {
    const json = JSON.stringify([
      { tickers: ['nvda'], headline: 'NVIDIA announces H200', impact: 'Hardware demand', doc_type: 'article' },
    ])
    mockResponse(json)
    const stories = await extractStories('some text', 'fake-key')
    expect(stories[0]!.tickers).toEqual(['NVDA'])
  })

  it('parses multiple stories from a digest', async () => {
    const json = JSON.stringify([
      { tickers: ['CRCL'], headline: 'Open USD stablecoin coalition launches', impact: 'Circle down 16%', doc_type: 'article' },
      { tickers: ['AAPL'], headline: 'Supreme Court takes Apple contempt case', impact: 'App Store fee model at risk', doc_type: 'article' },
    ])
    mockResponse(json)
    const stories = await extractStories('some digest text', 'fake-key')
    expect(stories).toHaveLength(2)
    expect(stories[0]!.tickers).toEqual(['CRCL'])
    expect(stories[1]!.tickers).toEqual(['AAPL'])
  })

  it('throws when Claude returns invalid JSON after retry', async () => {
    const AnthropicMock = Anthropic as ReturnType<typeof vi.fn>
    const instance = new AnthropicMock()
    ;(instance.messages.create as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ content: [{ type: 'text', text: 'not json' }] })
      .mockResolvedValueOnce({ content: [{ type: 'text', text: 'still not json' }] })
    await expect(extractStories('bad text', 'fake-key')).rejects.toThrow()
  })
})
```

- [ ] **Step 2: Run tests — expect all to pass**

```bash
cd apps/capital-intelligence-ingestion
npm test -- src/intake/paste-extractor.test.ts
```

Expected: `5 tests passed`

- [ ] **Step 3: Commit**

```bash
git add src/intake/paste-extractor.test.ts
git commit -m "test(paste): unit tests for extraction module"
```

---

## Task 3: CLI entry point

**Files:**
- Create: `src/intake/cli-paste.ts`

- [ ] **Step 1: Create `src/intake/cli-paste.ts`**

```typescript
// AI-powered news paste intake.
// Usage: pbpaste | npm run paste
//
// Reads any freeform text from stdin (Thai digest, TradingView snippet,
// English article), calls Claude to extract structured stories with tickers,
// then writes one drop file per (story × ticker) into intake/drop/.
// Run `npm run pipeline` afterwards to ingest.

import { writeFileSync, existsSync, mkdirSync } from 'fs'
import { join } from 'path'
import { extractStories } from './paste-extractor.js'

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) {
    console.error('Usage: pbpaste | npm run paste')
    console.error('       echo "news text" | npm run paste')
    process.exit(1)
  }
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf-8').trim()
}

function writeDropFile(
  ticker: string,
  story: { tickers: string[]; headline: string; impact: string; doc_type: string },
  storyIdx: number,
  tickerIdx: number,
  dropDir: string,
): string {
  const now = new Date().toISOString()
  const filename = `${ticker}-paste-${Date.now()}-${storyIdx}-${tickerIdx}.txt`

  const relatedTickers = story.tickers.filter(t => t !== ticker)
  const content = [
    `[Paste Intake] ${now}`,
    `Tickers: ${story.tickers.join(', ')}`,
    '',
    story.headline,
    `[impact] ${story.impact}`,
  ].join('\n')

  const meta = {
    ticker,
    company:         ticker,
    doc_type:        story.doc_type,
    tags:            ['paste', ...(relatedTickers.length > 0 ? ['multi-ticker'] : [])],
    related_tickers: relatedTickers,
  }

  writeFileSync(join(dropDir, filename), content)
  writeFileSync(join(dropDir, `${filename}.meta.json`), JSON.stringify(meta, null, 2))
  return filename
}

async function run(): Promise<void> {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) {
    console.error('ANTHROPIC_API_KEY is not set in .env')
    process.exit(1)
  }

  const text = await readStdin()
  if (!text) {
    console.error('No text received on stdin.')
    process.exit(1)
  }

  console.log('Extracting stories via Claude...')

  let stories: Awaited<ReturnType<typeof extractStories>>
  try {
    stories = await extractStories(text, apiKey)
  } catch (err) {
    console.error('Extraction failed:', err instanceof Error ? err.message : String(err))
    process.exit(1)
  }

  if (stories.length === 0) {
    console.log('No stories found in the pasted text.')
    process.exit(0)
  }

  const dropDir = join(process.cwd(), 'intake', 'drop')
  if (!existsSync(dropDir)) mkdirSync(dropDir, { recursive: true })

  let fileCount = 0
  for (let si = 0; si < stories.length; si++) {
    const story = stories[si]!
    for (let ti = 0; ti < story.tickers.length; ti++) {
      const ticker = story.tickers[ti]!
      writeDropFile(ticker, story, si, ti, dropDir)
      fileCount++
    }
  }

  console.log(`\n${stories.length} stories → ${fileCount} drop files queued:\n`)
  for (const story of stories) {
    console.log(`  [${story.tickers.join('/')}] ${story.headline}`)
  }
  console.log(`\nRun 'npm run pipeline' to ingest.`)
}

run().catch(err => {
  console.error('Fatal:', err instanceof Error ? err.message : String(err))
  process.exit(1)
})
```

- [ ] **Step 2: Commit**

```bash
git add src/intake/cli-paste.ts
git commit -m "feat(paste): CLI entry point — stdin → drop files"
```

---

## Task 4: Wire up package.json and smoke test

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Add paste script to package.json**

In `apps/capital-intelligence-ingestion/package.json`, add one line to the `"scripts"` object (after the `"discord"` line):

```json
"paste": "tsx src/intake/cli-paste.ts",
```

Full scripts section after the change:
```json
"scripts": {
  "pipeline":      "tsx src/pipeline.ts",
  "add":           "tsx src/intake/cli-add.ts",
  "discord":       "tsx src/intake/cli-discord.ts",
  "paste":         "tsx src/intake/cli-paste.ts",
  "config":        "tsx src/intake/cli-config.ts",
  "search":        "tsx src/query/cli-search.ts",
  "schedule":      "tsx src/scheduler.ts",
  "watchlist":     "tsx src/intake/cli-watchlist.ts",
  "notebooklm":   "tsx src/cli/cli-notebooklm.ts",
  "note":          "tsx src/cli/cli-note.ts",
  "13f":           "tsx src/cli/cli-13f.ts",
  "people-tweets": "tsx src/cli/cli-people-tweets.ts",
  "gmail-auth":    "tsx src/cli/cli-gmail-auth.ts",
  "test":          "vitest run",
  "test:watch":    "vitest",
  "typecheck":     "tsc --noEmit"
}
```

- [ ] **Step 2: Run typecheck — expect no errors**

```bash
cd apps/capital-intelligence-ingestion
npm run typecheck
```

Expected: no output, exit 0.

- [ ] **Step 3: Smoke test with the real digest**

```bash
cd apps/capital-intelligence-ingestion
echo '💰 $CRCL — Visa, Mastercard, Stripe, BlackRock, Coinbase and 140+ partners launch Open USD stablecoin — Circle drops -16%

⚖️ $AAPL/$GOOGL — UK CMA proposes forcing Apple to open NFC access — Google already compliant, Apple still negotiating

☁️ OpenAI — engineers find software optimization cutting inference cost by 50% — implications for NVIDIA datacenter demand' | npm run paste
```

Expected output (approximate):
```
Extracting stories via Claude...

3 stories → 5 drop files queued:

  [CRCL] Open USD stablecoin coalition launches, Circle drops 16%
  [AAPL/GOOGL] UK CMA targets Apple NFC and App Store payment steering
  [NVDA/OPENAI] OpenAI 50% inference cost reduction via software optimization

Run 'npm run pipeline' to ingest.
```

Verify files landed in `intake/drop/`:
```bash
ls intake/drop/ | grep paste
```

Expected: 5 files (`.txt` + `.meta.json` pairs, one per ticker per story).

- [ ] **Step 4: Run full test suite — all tests pass**

```bash
npm test
```

Expected: all tests pass (no regressions).

- [ ] **Step 5: Commit**

```bash
git add package.json
git commit -m "feat(paste): add npm run paste command — AI news intake from stdin"
```

---

## Self-Review Checklist (completed inline)

- **Spec coverage:** Command (`npm run paste`) ✓, Claude extraction ✓, multi-ticker drop files ✓, MACRO fallback ✓, retry on bad JSON ✓, no auto-pipeline ✓
- **Placeholder scan:** No TBDs, all code blocks complete
- **Type consistency:** `ExtractedStory` defined in Task 1, used in Tasks 2 and 3 with matching field names (`tickers`, `headline`, `impact`, `doc_type`)
- **Model ID:** `claude-haiku-4-5-20251001` matches what pipeline.ts already uses
