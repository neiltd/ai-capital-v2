# Investment Analyst Agents — Design Spec

**Date:** 2026-05-26
**Project:** AI Capital Flow & Technology Intelligence System (sub-project 7 of 7)
**Status:** Approved

---

## Overview

A standalone TypeScript project that synthesizes all upstream intelligence (macro regime, scenarios, portfolio actions, dependency graph, world events) into two outputs: (1) a daily Markdown briefing written by Claude that can be read in under 5 minutes, and (2) an interactive Q&A interface — both single-shot and loop mode — where Claude answers questions grounded in that day's briefing and the raw upstream data. All predictions and Q&A sessions are archived in append-only JSONL files for future scoring by a downstream autonomous investor agent (sub-project 8).

---

## Architecture

```
investment-analyst-agents/
  src/
    types.ts
    context/
      loader.ts              ← loads all upstream JSON + profile.md into one ContextBundle
    briefing/
      briefing-agent.ts      ← Claude generates the daily briefing Markdown
      briefing-writer.ts     ← writes briefings/YYYY-MM-DD.md
    qa/
      qa-agent.ts            ← Claude Q&A (briefing as primary ctx, raw JSON for drill-downs)
    archive/
      prediction-archiver.ts ← appends to archive/predictions.jsonl
      qa-archiver.ts         ← appends to archive/qa.jsonl
    cli/
      cli-brief.ts           ← npm run brief
      cli-ask.ts             ← npm run ask (single-shot + loop mode)
  briefings/                 ← YYYY-MM-DD.md (committed)
  archive/                   ← predictions.jsonl, qa.jsonl (gitignored)
  knowledge/                 ← profile.md (gitignored)
  data/
    exports                  ← symlink → ../../world-intelligence-data-hub-/exports
  package.json
  tsconfig.json
  .env
  .gitignore
  tests/
```

**Reads from (read-only):**
- `../ai-analysis-engine/data/analysis.json`
- `../scenario-simulator/data/simulation.json`
- `../dependency-graph-engine/data/graph.json`
- `data/exports/stock-project/intelligence.json`
- `data/exports/world-map/intelligence.json`
- `knowledge/profile.md`

**Writes to (own data only):**
- `briefings/YYYY-MM-DD.md`
- `archive/predictions.jsonl`
- `archive/qa.jsonl`

---

## Tech Stack

Matches existing sibling projects exactly:

| Dependency | Purpose |
|---|---|
| `typescript` + `tsx` | Language + runtime |
| `@anthropic-ai/sdk` | Claude Sonnet 4.6 for briefing + Q&A |
| `dotenv` | `ANTHROPIC_API_KEY` |
| `vitest` | Tests |

No SQLite, no scheduler, no HTTP library. Briefings are Markdown files. Archives are append-only JSONL.

---

## Data Model

### Types

```ts
interface ContextBundle {
  date:            string
  analysis:        AnalysisJSON        // from analysis.json
  simulation:      SimulationJSON      // from simulation.json
  graph:           GraphJSON           // from graph.json
  stockIntel:      StockIntelJSON      // from exports/stock-project/intelligence.json
  worldIntel:      WorldIntelJSON      // from exports/world-map/intelligence.json
  profile:         string              // raw Markdown from knowledge/profile.md; '' if missing
  profileMissing:  boolean             // true if profile.md was not found
}

interface PredictionEntry {
  date:      string
  regime:    string
  confidence: string
  scenarios: Array<{
    scenarioType:     string
    title:            string
    probability:      number
    timeHorizon:      string
    regimeTransition: string | null
    triggers:         string[]
  }>
  actions: Array<{
    ticker:              string
    scenarioType:        string
    action:              string
    conviction:          string
    allocationChangePct: number
  }>
}

interface QAEntry {
  date:      string
  timestamp: string
  mode:      'loop' | 'single'
  exchanges: Array<{ question: string; answer: string }>
}

// Re-used from sibling projects (imported via relative path or duplicated):
// AnalysisJSON, SimulationJSON, GraphJSON (from scenario-simulator/src/types.ts shapes)

interface StockIntelJSON {
  date:             string
  marketEvents:     Array<{ title: string; summary: string; eventType: string; severity: string; marketDirection: string }>
  macroRiskSignals: Array<{ riskType: string; intensity: string; primaryCountries: string[] }>
  sectorExposure:   Array<{ sector: string; exposure: string; maxSeverity: string }>
}

interface WorldIntelJSON {
  date:         string
  marketEvents: Array<{ title: string; summary: string; eventType: string; severity: string; countries: string[]; marketRelevance: string }>
}
```

### Archive formats

**`archive/predictions.jsonl`** — one line per daily brief run:
```json
{"date":"2026-05-26","regime":"AI Acceleration","confidence":"high","scenarios":[...],"actions":[...]}
```

**`archive/qa.jsonl`** — one line per session (loop) or question (single-shot):
```json
{"date":"2026-05-26","timestamp":"2026-05-26T08:15:00Z","mode":"loop","exchanges":[{"question":"...","answer":"..."}]}
```

---

## Context Loader (`context/loader.ts`)

Loads all upstream data into a `ContextBundle`. Missing files throw with a clear message — except `profile.md` which logs a warning and sets `profileMissing: true` with `profile: ''`.

```ts
export function loadContext(date: string): ContextBundle
```

Paths are resolved relative to `process.cwd()`:
- `../ai-analysis-engine/data/analysis.json`
- `../scenario-simulator/data/simulation.json`
- `../dependency-graph-engine/data/graph.json`
- `data/exports/stock-project/intelligence.json`
- `data/exports/world-map/intelligence.json`
- `knowledge/profile.md` — warn and continue if missing

---

## Briefing Agent (`briefing/briefing-agent.ts`)

Calls Claude Sonnet 4.6 with a cached system prompt. Receives the full `ContextBundle` formatted as a structured user message. Returns the briefing as a Markdown string.

**System prompt (cached):** Role as senior technology investment analyst. Instructions to ground every claim in the provided data, keep each section tight (briefing readable in under 5 minutes), cite specific tickers and signals rather than generic commentary.

**Briefing structure Claude must produce:**

```markdown
# Investment Briefing — YYYY-MM-DD

## Macro Regime
[regime label, confidence level, 2-3 sentence rationale, key indicators]

## World Intelligence
[3-5 bullet points — relevant market/geopolitical events from stock + world-map exports]

## Portfolio Health
[per held position: health score, thesis status, note any broken assumptions]
[if no positions: note that portfolio is empty]

## Scenario Outlook
### Best: [title] ([probability]%, [timeHorizon])
[narrative + key triggers]

### Base: [title] ([probability]%, [timeHorizon])
...

### Disruption: [title] ([probability]%, [timeHorizon])
...

## Today's Recommended Actions
[one line per position per scenario — or summary across scenarios if clear consensus]

## Things to Watch
[3-5 specific events, data releases, or signals to monitor this week]
```

If `profileMissing` is true, a note is prepended to the user message: "No investor profile found at knowledge/profile.md — proceeding without personal context."

**Tool use:** Not used. Claude returns the briefing as a plain text response.

---

## Briefing Writer (`briefing/briefing-writer.ts`)

Writes the Claude-generated Markdown to `briefings/YYYY-MM-DD.md`. Creates the directory if needed. Returns the output path.

```ts
export function writeBriefing(date: string, content: string, briefingsDir: string): string
```

---

## Q&A Agent (`qa/qa-agent.ts`)

Answers questions using a multi-turn conversation. Context loaded once per session:

**Always included:**
- Today's briefing (from `briefings/YYYY-MM-DD.md`) — primary context
- `simulation.json` — for scenario/action drill-downs
- `graph.json` — for dependency path questions
- `profile.md` — to frame answers relative to the user's positions and style

**Not re-loaded for Q&A:**
- `analysis.json`, world-intelligence exports — already distilled into the briefing

**System prompt (cached):** Role as investment analyst assistant. Instructions to: cite specific evidence from the briefing or data, not invent tickers or graph edges not present in the data, flag when a question requires information not available in context (e.g., real-time prices).

```ts
export async function askQuestion(
  question: string,
  briefing: string,                       // today's Markdown briefing (primary context)
  context: Pick<ContextBundle, 'simulation' | 'graph' | 'profile'>,  // raw data for drill-downs
  history: Array<{ role: 'user' | 'assistant'; content: string }>,   // prior turns for loop mode
  options: { client?: Anthropic },
): Promise<string>
```

History is empty for single-shot mode. Accumulated across turns for loop mode.

---

## Prediction Archiver (`archive/prediction-archiver.ts`)

Appends a `PredictionEntry` to `archive/predictions.jsonl` after each briefing run. Creates the file if it doesn't exist.

```ts
export function archivePrediction(entry: PredictionEntry, archivePath: string): void
```

---

## Q&A Archiver (`archive/qa-archiver.ts`)

Appends a `QAEntry` to `archive/qa.jsonl` after each session (loop) or question (single-shot). Creates the file if it doesn't exist.

```ts
export function archiveQA(entry: QAEntry, archivePath: string): void
```

---

## CLI Commands

### `cli-brief.ts` — `npm run brief`

1. Load context via `loadContext(today)`
2. If `profileMissing`, print warning: `⚠ No profile found at knowledge/profile.md — briefing will proceed without personal context`
3. Call `briefingAgent(context)` → Markdown string
4. Call `writeBriefing(today, markdown, briefingsDir)` → print path
5. Call `archivePrediction(entry, archivePath)`
6. Print the briefing to stdout

### `cli-ask.ts` — `npm run ask` and `npm run ask -- "question"`

**Single-shot** (argument provided):
1. Load today's briefing from `briefings/YYYY-MM-DD.md` — error if not found with message: `No briefing for today. Run: npm run brief`
2. Load `simulation.json`, `graph.json`, `profile.md`
3. Call `askQuestion(question, context, [], options)`
4. Print answer
5. Archive single-exchange QAEntry

**Loop mode** (no argument):
1. Same context loading
2. Print: `Investment Analyst ready. Type your question (or 'exit' to quit).`
3. Read questions from stdin in a loop
4. Accumulate history across turns
5. On exit: archive the full session as one QAEntry

Both modes fail with a clear message if today's briefing doesn't exist.

---

## Testing

- Unit tests for `loader.ts` — missing files throw, missing profile warns and returns empty string
- Unit tests for `briefing-writer.ts` — writes file to correct path, creates directory
- Unit tests for `briefing-agent.ts` — mock Claude, verify Markdown contains expected section headings
- Unit tests for `qa-agent.ts` — mock Claude, verify history is passed correctly across turns
- Unit tests for `prediction-archiver.ts` — appends correct JSONL line
- Unit tests for `qa-archiver.ts` — appends correct JSONL line
- No live Claude API calls or file system side effects in test suite

---

## Key Design Constraints

- **Read-only siblings** — never writes to ai-analysis-engine, scenario-simulator, dependency-graph-engine, or world-intelligence-data-hub directories
- **Prompt caching** — system prompts for both Claude calls use `cache_control: { type: 'ephemeral' }`
- **Briefing-first** — Q&A refuses to run if today's briefing does not exist; `npm run brief` must be run first
- **Profile is optional** — missing `profile.md` logs a warning and proceeds; never throws
- **Machine-readable archive** — `predictions.jsonl` entries structured for sub-project 8 scoring (date, regime, scenario probabilities, action recommendations)
- **Briefings are committed** — `briefings/` is not gitignored; daily briefings accumulate as a historical record
- **Archives are gitignored** — `archive/` is gitignored; personal Q&A and prediction logs stay local
