# Brainstorm CLI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an interactive terminal brainstorm session (`npm run brainstorm -- --ticker ARM`) where the investor streams their thinking, then a single Anthropic Sonnet call at the end synthesizes 3–5 thesis legs with evidence from LanceDB, which are saved to thesis-memory SQLite.

**Architecture:** A `readline`-based CLI in `thesis-memory/src/cli/cli-brainstorm.ts`. During the session, the user types freely — all input is recorded in a `messages` array in memory with zero API calls. On `done`, one `Anthropic.messages.create` call receives the full transcript + top LanceDB chunks for the ticker, and returns structured thesis legs. Legs are saved using the existing `createManualThesis` helper. The session transcript is optionally saved as a personal note.

**Tech Stack:** Node.js `readline`, `@anthropic-ai/sdk`, `@lancedb/lancedb`, `better-sqlite3`, existing `createThesisStore`, `createRetriever`, `createManualThesis` from `thesis-memory/src`.

---

### Task 1: Build and test the synthesis leg parser

**Files:**
- Create: `thesis-memory/src/cli/cli-brainstorm.ts`
- Create: `thesis-memory/src/cli/brainstorm.test.ts`

- [ ] **Step 1: Write failing test for the leg parser**

Create `src/cli/brainstorm.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { parseSynthesisLegs } from './cli-brainstorm.js'

describe('parseSynthesisLegs', () => {
  it('extracts legs from a structured response', () => {
    const text = `
Leg 1: AI royalty volume expansion
  Thesis: Hyperscaler design win cycle drives unit volume
  Evidence: Q3 FY26 transcript — royalty revenue up 37% YoY
  Weakens if: Custom RISC-V adoption exceeds 15%

Leg 2: v9 architecture pricing power
  Thesis: Mandatory v9 migration adds royalty premium per chip
  Evidence: Analyst day 2025 — confirmed v9 ASP uplift of 8-12%
  Weakens if: Hyperscalers negotiate exemptions at volume
`
    const legs = parseSynthesisLegs(text)
    expect(legs).toHaveLength(2)
    expect(legs[0]).toContain('AI royalty volume expansion')
    expect(legs[1]).toContain('v9 architecture pricing power')
  })

  it('returns a single leg when no numbered format present', () => {
    const text = 'ARM benefits from AI chip proliferation because every new accelerator uses ARM ISA.'
    const legs = parseSynthesisLegs(text)
    expect(legs).toHaveLength(1)
    expect(legs[0]).toBe(text.trim())
  })

  it('handles empty string gracefully', () => {
    const legs = parseSynthesisLegs('')
    expect(legs).toHaveLength(0)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd /Users/thanapold/Desktop/Projects/thesis-memory
npx vitest run src/cli/brainstorm.test.ts
```
Expected: FAIL — `cli-brainstorm.js` not found.

- [ ] **Step 3: Implement `cli-brainstorm.ts`**

Create `src/cli/cli-brainstorm.ts`:

```typescript
// src/cli/cli-brainstorm.ts
import 'dotenv/config'
import { join } from 'path'
import * as readline from 'readline'
import Anthropic from '@anthropic-ai/sdk'
import { createThesisStore } from '../store/sqlite.js'
import { createRetriever } from '../reasoning/retriever.js'
import { createManualThesis } from '../thesis/creator.js'

const DATA_DIR = join(process.cwd(), 'data')
const INGESTION_PATH = process.env.INGESTION_STORE_PATH
  ?? join(process.cwd(), '..', 'capital-intelligence-ingestion', 'data')

const args = process.argv.slice(2)
const get = (flag: string) => args.find(a => a.startsWith(`${flag}=`))?.split('=').slice(1).join('=')

export function parseSynthesisLegs(text: string): string[] {
  if (!text.trim()) return []
  // Split on "Leg N:" headers
  const parts = text.split(/(?=^Leg \d+:)/m).map(p => p.trim()).filter(Boolean)
  if (parts.length > 1) return parts
  return [text.trim()]
}

async function askQuestion(rl: readline.Interface, prompt: string): Promise<string> {
  return new Promise(resolve => rl.question(prompt, resolve))
}

async function main() {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) { console.error('ANTHROPIC_API_KEY not set'); process.exit(1) }

  const ticker = get('--ticker')
  if (!ticker) { console.error('Usage: npm run brainstorm -- --ticker=ARM'); process.exit(1) }

  const client = new Anthropic({ apiKey })
  const store = createThesisStore(join(DATA_DIR, 'thesis.db'))
  const retriever = await createRetriever(INGESTION_PATH)

  // Load company context from LanceDB
  console.log(`\nLoading ${ticker} context...`)
  const contextChunks = await retriever.search(ticker, ticker, 20)
  const contextText = contextChunks
    .map(c => `[${c.docType} ${c.publishedDate.slice(0, 10)}] ${c.content}`)
    .join('\n\n')
  console.log(`${contextChunks.length} document chunks loaded\n`)

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })

  console.log(`Thesis brainstorm for ${ticker}. Share your thinking — type freely.`)
  console.log(`Type 'done' to synthesize thesis legs. Ctrl+C to exit without saving.\n`)
  console.log('─'.repeat(62))

  const transcript: string[] = []

  process.on('SIGINT', () => {
    console.log('\n\nExiting without saving.')
    rl.close()
    store.close()
    process.exit(0)
  })

  // Recording loop — no API calls here
  while (true) {
    const input = await askQuestion(rl, '\nYou: ')
    const trimmed = input.trim()
    if (!trimmed) continue
    if (trimmed.toLowerCase() === 'done') break
    transcript.push(trimmed)
  }

  if (transcript.length === 0) {
    console.log('No input recorded. Exiting.')
    rl.close()
    store.close()
    return
  }

  console.log('\nSynthesizing thesis legs from your conversation...\n')

  // One API call with full transcript + company context
  const transcriptText = transcript.map((t, i) => `[${i + 1}] ${t}`).join('\n\n')

  const systemPrompt = `You are a senior investment analyst. Extract 3–5 thesis legs from the investor's notes about ${ticker}.

Company context (from SEC filings, earnings transcripts, and news):
${contextText}

For each leg, structure it as:
Leg N: [Short title]
  Thesis: [One sentence core thesis statement]
  Evidence: [Specific quote or data point from the company context above]
  Weakens if: [Specific falsifiable condition]

Ground every leg in the company context above. Do not invent evidence.`

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 2048,
    system: systemPrompt,
    messages: [
      {
        role: 'user',
        content: `Here are my notes on ${ticker}:\n\n${transcriptText}\n\nExtract the thesis legs grounded in the company documents.`,
      },
    ],
  })

  const block = response.content.find(b => b.type === 'text')
  if (!block || block.type !== 'text') {
    console.error('No text response from Claude')
    rl.close()
    store.close()
    return
  }

  const synthesisText = block.text
  const legs = parseSynthesisLegs(synthesisText)

  console.log(`${ticker} Thesis Draft`)
  console.log('─'.repeat(62))
  console.log(synthesisText)
  console.log('─'.repeat(62))

  const save = await askQuestion(rl, `\nSave these ${legs.length} legs to thesis-memory? (y/n): `)
  rl.close()

  if (save.trim().toLowerCase() !== 'y') {
    console.log('Not saved.')
    store.close()
    return
  }

  const existing = store.getThesis(ticker)
  if (existing) {
    console.log(`\nThesis for ${ticker} already exists. Legs were NOT overwritten.`)
    console.log(`To update, run: npm run update -- --ticker=${ticker}`)
  } else {
    createManualThesis(ticker, 'company', 'watchlist', legs, synthesisText, store)
    console.log(`\n✓ ${legs.length} legs saved to thesis-memory for ${ticker}`)
  }

  // Save transcript as personal note if ingestion path is accessible
  try {
    const { writeFileSync, mkdirSync } = await import('fs')
    const notesDir = join(INGESTION_PATH, '..', 'intake', 'personal-notes')
    mkdirSync(notesDir, { recursive: true })
    const today = new Date().toISOString().slice(0, 10)
    const noteFile = join(notesDir, `${ticker.toLowerCase()}-thesis_observation-${today}-brainstorm.md`)
    const noteContent = [
      '---',
      `ticker: ${ticker}`,
      'type: thesis_observation',
      `date: ${today}`,
      '---',
      '',
      `## Brainstorm Session — ${today}`,
      '',
      transcript.map((t, i) => `**[${i + 1}]** ${t}`).join('\n\n'),
      '',
      '## Synthesized Thesis',
      '',
      synthesisText,
    ].join('\n')
    writeFileSync(noteFile, noteContent, 'utf-8')
    console.log(`✓ Session transcript saved as personal note (will embed on next pipeline run)`)
  } catch {
    // non-fatal — ingestion path may not be available
  }

  store.close()
}

main().catch(err => { console.error(err); process.exit(1) })
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd /Users/thanapold/Desktop/Projects/thesis-memory
npx vitest run src/cli/brainstorm.test.ts
```
Expected: 3/3 PASS.

- [ ] **Step 5: Add `brainstorm` script to `package.json`**

In `thesis-memory/package.json`, add inside `"scripts"`:
```json
"brainstorm": "tsx src/cli/cli-brainstorm.ts"
```

- [ ] **Step 6: Type-check**

```bash
cd /Users/thanapold/Desktop/Projects/thesis-memory
npx tsc --noEmit
```
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
cd /Users/thanapold/Desktop/Projects/thesis-memory
git add src/cli/cli-brainstorm.ts src/cli/brainstorm.test.ts package.json
git commit -m "feat(brainstorm): add interactive thesis brainstorm CLI"
```

---

### Task 2: Smoke-test the full brainstorm session

This is a manual integration test. Run it yourself — it requires a live Anthropic API key and existing LanceDB data for a ticker you've ingested.

- [ ] **Step 1: Start a session for a ticker with existing data**

```bash
cd /Users/thanapold/Desktop/Projects/thesis-memory
npm run brainstorm -- --ticker=ARM
```

Expected output:
```
Loading ARM context...
14 document chunks loaded

Thesis brainstorm for ARM. Share your thinking — type freely.
Type 'done' to synthesize thesis legs. Ctrl+C to exit without saving.

──────────────────────────────────────────────────────────────

You: _
```

- [ ] **Step 2: Enter 2–3 thoughts, then type `done`**

Example:
```
You: I think ARM benefits from AI chip proliferation because every accelerator uses ARM ISA
You: The v9 royalty uplift is a structural pricing improvement they don't get credit for
You: done
```

Expected: Claude synthesizes 3–5 legs, shows them, prompts to save.

- [ ] **Step 3: Type `y` to save and verify**

```bash
npm run thesis -- show --ticker=ARM
```
Expected: shows the newly created thesis with the brainstormed legs as assumptions.
