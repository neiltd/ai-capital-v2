# Investment Analyst Agents Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a TypeScript project that generates a daily Claude-written investment briefing from all upstream intelligence, plus an interactive Q&A CLI grounded in that briefing, with append-only JSONL archives for predictions and sessions.

**Architecture:** Context loader reads six upstream sources into a single ContextBundle. Briefing agent calls Claude to generate Markdown, saved to `briefings/YYYY-MM-DD.md`. Q&A agent loads today's briefing as primary context plus raw `simulation.json` and `graph.json` for drill-downs. Both modes archive outputs to `archive/` JSONL files.

**Tech Stack:** TypeScript ESM + tsx, @anthropic-ai/sdk (Claude Sonnet 4.6 with prompt caching), dotenv, vitest. No SQLite, no scheduler, no HTTP library.

---

## File Map

```
investment-analyst-agents/
  src/
    types.ts                    — all interfaces (ContextBundle, PredictionEntry, QAEntry, upstream JSON shapes)
    context/
      loader.ts                 — loadContext(date, paths?) → ContextBundle
    briefing/
      briefing-agent.ts         — generateBriefing(ctx, options?) → Promise<string>
      briefing-writer.ts        — writeBriefing(date, content, briefingsDir) → string
    qa/
      qa-agent.ts               — askQuestion(question, briefing, context, history, options?) → Promise<string>
    archive/
      prediction-archiver.ts    — archivePrediction(entry, archivePath) → void
      qa-archiver.ts            — archiveQA(entry, archivePath) → void
    cli/
      cli-brief.ts              — npm run brief
      cli-ask.ts                — npm run ask [question]
  tests/
    loader.test.ts
    briefing-agent.test.ts
    briefing-writer.test.ts
    archivers.test.ts
    qa-agent.test.ts
  briefings/                    — committed; daily Markdown files accumulate here
  archive/                      — gitignored; predictions.jsonl + qa.jsonl
  knowledge/                    — gitignored; profile.md
  data/exports                  — symlink (already exists → world-intelligence-data-hub-/exports)
  package.json
  tsconfig.json
  vitest.config.ts
  .env
```

**Note:** `investment-analyst-agents/` has its own `.git` (standalone repo). All `git` commands in this plan run from inside `/Users/thanapold/Desktop/Projects/investment-analyst-agents/`.

---

### Task 1: Project Scaffold

**Files:**
- Create: `investment-analyst-agents/package.json`
- Create: `investment-analyst-agents/tsconfig.json`
- Create: `investment-analyst-agents/vitest.config.ts`
- Create: `investment-analyst-agents/.env`
- Modify: `investment-analyst-agents/.gitignore`
- Create: `investment-analyst-agents/briefings/.gitkeep`

- [ ] **Step 1: Create source directories**

Run from `/Users/thanapold/Desktop/Projects/investment-analyst-agents/`:
```bash
mkdir -p src/context src/briefing src/qa src/archive src/cli tests briefings archive knowledge
touch briefings/.gitkeep
```

- [ ] **Step 2: Create `package.json`**

```json
{
  "name": "investment-analyst-agents",
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "brief":      "tsx src/cli/cli-brief.ts",
    "ask":        "tsx src/cli/cli-ask.ts",
    "test":       "vitest run",
    "test:watch": "vitest"
  },
  "dependencies": {
    "@anthropic-ai/sdk": "^0.39.0",
    "dotenv":            "^16.0.0"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "tsx":         "^4.0.0",
    "typescript":  "^5.0.0",
    "vitest":      "^3.0.0"
  }
}
```

- [ ] **Step 3: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target":                     "ES2022",
    "module":                     "NodeNext",
    "moduleResolution":           "NodeNext",
    "strict":                     true,
    "outDir":                     "dist",
    "rootDir":                    "src",
    "esModuleInterop":            true,
    "allowSyntheticDefaultImports": true,
    "resolveJsonModule":          true,
    "skipLibCheck":               true,
    "types":                      ["vitest/globals"]
  },
  "include": ["src/**/*", "tests/**/*"],
  "exclude": ["node_modules", "dist"]
}
```

- [ ] **Step 4: Create `vitest.config.ts`**

```ts
import { defineConfig } from 'vitest/config'
export default defineConfig({ test: { globals: true, environment: 'node' } })
```

- [ ] **Step 5: Create `.env`**

```
ANTHROPIC_API_KEY=your_key_here
```

- [ ] **Step 6: Update `.gitignore`**

Replace the existing `.gitignore` with:
```
node_modules/
dist/
.env
knowledge/profile.md
archive/*.jsonl
```

- [ ] **Step 7: Install dependencies**

```bash
cd /Users/thanapold/Desktop/Projects/investment-analyst-agents && npm install
```

Expected: `node_modules/` created, no errors.

- [ ] **Step 8: Commit**

```bash
cd /Users/thanapold/Desktop/Projects/investment-analyst-agents
git add package.json tsconfig.json vitest.config.ts .gitignore briefings/.gitkeep
git commit -m "chore: scaffold investment-analyst-agents project"
```

---

### Task 2: Types

**Files:**
- Create: `investment-analyst-agents/src/types.ts`

- [ ] **Step 1: Write `src/types.ts`**

```ts
// Upstream data shapes — mirrors sibling project types without cross-project imports

export interface AnalysisJSON {
  exportedAt:    string
  latestRegime: {
    id:              string
    date:            string
    regime:          string
    confidence:      string
    rationale:       string
    keyIndicators:   string[]
    affectedTickers: string[]
    createdAt:       string
  }
  latestSignals: Array<{
    id:            string
    date:          string
    sourceTicker:  string
    targetTicker:  string
    signalType:    string
    direction:     string
    magnitude:     string
    sentiment:     string
    description:   string
    evidenceQuote: string | null
    createdAt:     string
  }>
  companySummaries: Array<{
    ticker:        string
    company:       string
    healthScore:   string
    thesisSummary: string
  }>
}

export interface SimulationJSON {
  exportedAt: string
  portfolio:  Array<{
    ticker:        string
    company:       string
    shares:        number
    avgCost:       number
    currentPrice:  number
    currentValue:  number
    unrealizedPnl: number
    updatedAt:     string
  }>
  scenarios: Array<{
    id:               string
    runId:            string
    date:             string
    scenarioType:     'best' | 'base' | 'disruption' | 'whatif'
    title:            string
    narrative:        string
    timeHorizon:      string
    probability:      number
    regimeTransition: string | null
    triggers:         string[]
    createdAt:        string
  }>
  actions: Array<{
    id:                  string
    runId:               string
    scenarioId:          string
    ticker:              string
    action:              'buy' | 'hold' | 'trim' | 'exit'
    conviction:          'high' | 'medium' | 'low'
    allocationChangePct: number
    rationale:           string
    createdAt:           string
  }>
}

export interface GraphJSON {
  exportedAt: string
  nodes: Array<{ ticker: string; company: string; themes: string[] }>
  edges: Array<{
    from:          string
    to:            string
    type:          string
    strength:      string
    description:   string
    evidenceQuote: string | null
  }>
}

export interface StockIntelJSON {
  date:             string
  marketEvents:     Array<{
    title:           string
    summary:         string
    eventType:       string
    severity:        string
    marketDirection: string
  }>
  macroRiskSignals: Array<{
    riskType:          string
    intensity:         string
    primaryCountries:  string[]
  }>
  sectorExposure:   Array<{
    sector:      string
    exposure:    string
    maxSeverity: string
  }>
}

export interface WorldIntelJSON {
  date:   string
  events: Array<{
    title:                 string
    summary:               string
    eventType:             string
    severity:              string
    countries:             string[]
    geopoliticalRelevance: string
    marketRelevance:       string
    escalationPotential:   string
  }>
  countrySignals: Array<{
    country:           string
    maxSeverity:       string
    dominantEventType: string
  }>
}

export interface ContextBundle {
  date:           string
  analysis:       AnalysisJSON
  simulation:     SimulationJSON
  graph:          GraphJSON
  stockIntel:     StockIntelJSON
  worldIntel:     WorldIntelJSON
  profile:        string    // raw Markdown from knowledge/profile.md; '' if missing
  profileMissing: boolean   // true when profile.md was not found
}

export interface PredictionEntry {
  date:       string
  regime:     string
  confidence: string
  scenarios:  Array<{
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

export interface QAEntry {
  date:      string
  timestamp: string
  mode:      'loop' | 'single'
  exchanges: Array<{ question: string; answer: string }>
}
```

- [ ] **Step 2: Commit**

```bash
cd /Users/thanapold/Desktop/Projects/investment-analyst-agents
git add src/types.ts
git commit -m "feat: add shared types for investment-analyst-agents"
```

---

### Task 3: Context Loader

**Files:**
- Create: `investment-analyst-agents/src/context/loader.ts`
- Test: `investment-analyst-agents/tests/loader.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/loader.test.ts`:
```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import { loadContext } from '../src/context/loader.js'

const TMP = 'tests/tmp-loader'

const mockAnalysis = {
  exportedAt: '', latestRegime: { id: 'r1', date: '', regime: 'AI Acceleration', confidence: 'high', rationale: '', keyIndicators: [], affectedTickers: [], createdAt: '' },
  latestSignals: [], companySummaries: [],
}
const mockSimulation = { exportedAt: '', portfolio: [], scenarios: [], actions: [] }
const mockGraph      = { exportedAt: '', nodes: [], edges: [] }
const mockStockIntel = { date: '', marketEvents: [], macroRiskSignals: [], sectorExposure: [] }
const mockWorldIntel = { date: '', events: [], countrySignals: [] }

function writeMockFiles(dir: string, includeProfile = false) {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'analysis.json'),    JSON.stringify(mockAnalysis))
  writeFileSync(join(dir, 'simulation.json'),  JSON.stringify(mockSimulation))
  writeFileSync(join(dir, 'graph.json'),       JSON.stringify(mockGraph))
  writeFileSync(join(dir, 'stock-intel.json'), JSON.stringify(mockStockIntel))
  writeFileSync(join(dir, 'world-intel.json'), JSON.stringify(mockWorldIntel))
  if (includeProfile) writeFileSync(join(dir, 'profile.md'), '# My Profile\nRisk: moderate')
}

const paths = (dir: string) => ({
  analysisPath:   join(dir, 'analysis.json'),
  simulationPath: join(dir, 'simulation.json'),
  graphPath:      join(dir, 'graph.json'),
  stockIntelPath: join(dir, 'stock-intel.json'),
  worldIntelPath: join(dir, 'world-intel.json'),
  profilePath:    join(dir, 'profile.md'),
})

beforeEach(() => { mkdirSync(TMP, { recursive: true }) })
afterEach(() => { try { rmSync(TMP, { recursive: true }) } catch {} })

describe('loadContext', () => {
  it('returns a full ContextBundle when all files are present including profile', () => {
    writeMockFiles(TMP, true)
    const ctx = loadContext('2026-05-26', paths(TMP))
    expect(ctx.date).toBe('2026-05-26')
    expect(ctx.profileMissing).toBe(false)
    expect(ctx.profile).toContain('My Profile')
    expect(ctx.analysis.latestRegime.regime).toBe('AI Acceleration')
  })

  it('returns profileMissing:true and empty string when profile.md is absent', () => {
    writeMockFiles(TMP, false)
    const ctx = loadContext('2026-05-26', paths(TMP))
    expect(ctx.profileMissing).toBe(true)
    expect(ctx.profile).toBe('')
  })

  it('throws when a required JSON file is missing', () => {
    mkdirSync(TMP, { recursive: true })
    // analysis.json intentionally not written
    expect(() => loadContext('2026-05-26', paths(TMP))).toThrow()
  })
})
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
cd /Users/thanapold/Desktop/Projects/investment-analyst-agents && npm test -- tests/loader.test.ts
```

Expected: FAIL — `Cannot find module '../src/context/loader.js'`

- [ ] **Step 3: Write `src/context/loader.ts`**

```ts
import { readFileSync, existsSync } from 'fs'
import { join } from 'path'
import type { ContextBundle, AnalysisJSON, SimulationJSON, GraphJSON, StockIntelJSON, WorldIntelJSON } from '../types.js'

interface LoaderPaths {
  analysisPath?:   string
  simulationPath?: string
  graphPath?:      string
  stockIntelPath?: string
  worldIntelPath?: string
  profilePath?:    string
}

const defaults = () => ({
  analysisPath:   join(process.cwd(), '../ai-analysis-engine/data/analysis.json'),
  simulationPath: join(process.cwd(), '../scenario-simulator/data/simulation.json'),
  graphPath:      join(process.cwd(), '../dependency-graph-engine/data/graph.json'),
  stockIntelPath: join(process.cwd(), 'data/exports/stock-project/intelligence.json'),
  worldIntelPath: join(process.cwd(), 'data/exports/world-map/intelligence.json'),
  profilePath:    join(process.cwd(), 'knowledge/profile.md'),
})

export function loadContext(date: string, paths: LoaderPaths = {}): ContextBundle {
  const p = { ...defaults(), ...paths }

  const analysis:   AnalysisJSON   = JSON.parse(readFileSync(p.analysisPath, 'utf-8'))
  const simulation: SimulationJSON = JSON.parse(readFileSync(p.simulationPath, 'utf-8'))
  const graph:      GraphJSON      = JSON.parse(readFileSync(p.graphPath, 'utf-8'))
  const stockIntel: StockIntelJSON = JSON.parse(readFileSync(p.stockIntelPath, 'utf-8'))
  const worldIntel: WorldIntelJSON = JSON.parse(readFileSync(p.worldIntelPath, 'utf-8'))

  let profile        = ''
  let profileMissing = false
  if (existsSync(p.profilePath)) {
    profile = readFileSync(p.profilePath, 'utf-8')
  } else {
    profileMissing = true
    console.warn('⚠ No profile found at knowledge/profile.md — proceeding without personal context')
  }

  return { date, analysis, simulation, graph, stockIntel, worldIntel, profile, profileMissing }
}
```

- [ ] **Step 4: Run tests to confirm they pass**

```bash
npm test -- tests/loader.test.ts
```

Expected: 3 passed.

- [ ] **Step 5: Commit**

```bash
cd /Users/thanapold/Desktop/Projects/investment-analyst-agents
git add src/context/loader.ts tests/loader.test.ts
git commit -m "feat: add context loader"
```

---

### Task 4: Briefing Agent

**Files:**
- Create: `investment-analyst-agents/src/briefing/briefing-agent.ts`
- Test: `investment-analyst-agents/tests/briefing-agent.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/briefing-agent.test.ts`:
```ts
import { describe, it, expect, vi } from 'vitest'
import Anthropic from '@anthropic-ai/sdk'
import { generateBriefing } from '../src/briefing/briefing-agent.js'
import type { ContextBundle } from '../src/types.js'

const baseCtx: ContextBundle = {
  date: '2026-05-26',
  analysis: {
    exportedAt: '',
    latestRegime: { id: 'r1', date: '', regime: 'AI Acceleration', confidence: 'high', rationale: 'GPU demand strong.', keyIndicators: ['NVDA up 80%'], affectedTickers: ['NVDA'], createdAt: '' },
    latestSignals: [],
    companySummaries: [{ ticker: 'NVDA', company: 'NVIDIA', healthScore: 'positive', thesisSummary: 'AI leader.' }],
  },
  simulation: { exportedAt: '', portfolio: [], scenarios: [], actions: [] },
  graph: { exportedAt: '', nodes: [], edges: [] },
  stockIntel: { date: '', marketEvents: [], macroRiskSignals: [], sectorExposure: [] },
  worldIntel: { date: '', events: [], countrySignals: [] },
  profile: 'Risk: moderate.',
  profileMissing: false,
}

describe('generateBriefing', () => {
  it('returns the text content from Claude', async () => {
    const mockClient = {
      messages: {
        create: vi.fn().mockResolvedValue({
          content: [{ type: 'text', text: '# Investment Briefing — 2026-05-26\n## Macro Regime\nAI Acceleration.' }],
        }),
      },
    } as unknown as Anthropic

    const result = await generateBriefing(baseCtx, { client: mockClient })
    expect(result).toContain('# Investment Briefing')
  })

  it('includes "No investor profile found" in user message when profileMissing is true', async () => {
    let capturedMessages: any[] = []
    const mockClient = {
      messages: {
        create: vi.fn().mockImplementation(async (params: any) => {
          capturedMessages = params.messages
          return { content: [{ type: 'text', text: 'Briefing.' }] }
        }),
      },
    } as unknown as Anthropic

    await generateBriefing({ ...baseCtx, profile: '', profileMissing: true }, { client: mockClient })
    const userMsg = capturedMessages.find((m: any) => m.role === 'user')
    expect(userMsg.content).toContain('No investor profile found')
  })

  it('throws when Claude returns no text block', async () => {
    const mockClient = {
      messages: {
        create: vi.fn().mockResolvedValue({ content: [{ type: 'tool_use', input: {} }] }),
      },
    } as unknown as Anthropic

    await expect(generateBriefing(baseCtx, { client: mockClient }))
      .rejects.toThrow('Expected text response from Claude')
  })
})
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
cd /Users/thanapold/Desktop/Projects/investment-analyst-agents && npm test -- tests/briefing-agent.test.ts
```

Expected: FAIL — `Cannot find module '../src/briefing/briefing-agent.js'`

- [ ] **Step 3: Write `src/briefing/briefing-agent.ts`**

```ts
import Anthropic from '@anthropic-ai/sdk'
import type { ContextBundle } from '../types.js'

const SYSTEM_PROMPT = `You are a senior technology investment analyst.
Write a concise daily investment briefing in Markdown.
Ground every claim in the provided data — cite specific tickers, signals, and events.
Each section must be tight: the full briefing should be readable in under 5 minutes.
Do not add generic market commentary not supported by the data.

Produce exactly these sections in this order:
# Investment Briefing — {date}
## Macro Regime
## World Intelligence
## Portfolio Health
## Scenario Outlook
## Today's Recommended Actions
## Things to Watch`

function formatContext(ctx: ContextBundle): string {
  const { analysis, simulation, graph, stockIntel, worldIntel, profile, profileMissing } = ctx

  const profileBlock = profileMissing
    ? 'No investor profile found — proceeding without personal context.'
    : `## Investor Profile\n${profile}`

  const r       = analysis.latestRegime
  const signals = analysis.latestSignals.length
    ? analysis.latestSignals.map(s => `  ${s.sourceTicker} → ${s.targetTicker} (${s.signalType}, ${s.direction}): ${s.description}`).join('\n')
    : '  None'
  const health  = analysis.companySummaries.map(c => `  ${c.ticker}: ${c.healthScore}`).join('\n') || '  None'

  const scenarios = simulation.scenarios.map(s =>
    `### ${s.scenarioType}: ${s.title} (${s.probability}%, ${s.timeHorizon})\n${s.narrative.slice(0, 400)}\nTriggers: ${s.triggers.join('; ')}\nRegime → ${s.regimeTransition ?? 'unchanged'}`
  ).join('\n\n') || '  No scenarios (run npm run simulate first)'

  const portfolio = simulation.portfolio.length
    ? simulation.portfolio.map(p =>
        `  ${p.ticker}: ${p.shares} shares @ $${p.avgCost.toFixed(2)} | current $${p.currentPrice.toFixed(2)} | P&L ${p.unrealizedPnl >= 0 ? '+' : ''}$${p.unrealizedPnl.toFixed(2)}`
      ).join('\n')
    : '  No positions held'

  const actions = simulation.actions.length
    ? simulation.actions.map(a =>
        `  ${a.ticker} [${a.conviction}]: ${a.action} ${a.allocationChangePct > 0 ? '+' : ''}${a.allocationChangePct}% — ${a.rationale.slice(0, 100)}`
      ).join('\n')
    : '  None'

  const edges = graph.edges.slice(0, 15).map(e =>
    `  ${e.from} → ${e.to} [${e.type}, ${e.strength}]`
  ).join('\n') || '  None'

  const stockEvents = stockIntel.marketEvents.slice(0, 5).map(e =>
    `  [${e.severity}] ${e.title}: ${e.summary.slice(0, 150)}`
  ).join('\n') || '  None'

  const worldEvents = worldIntel.events.slice(0, 5).map(e =>
    `  [${e.severity}] ${e.title}: ${e.summary.slice(0, 150)}`
  ).join('\n') || '  None'

  return [
    profileBlock,
    `\n## Macro Regime: ${r.regime} (${r.confidence} confidence)\n${r.rationale}\nKey Indicators:\n${r.keyIndicators.map(i => `  - ${i}`).join('\n')}`,
    `\n## Propagation Signals:\n${signals}`,
    `\n## Company Health:\n${health}`,
    `\n## Portfolio:\n${portfolio}`,
    `\n## Scenarios:\n${scenarios}`,
    `\n## Portfolio Actions:\n${actions}`,
    `\n## Dependency Graph (key edges):\n${edges}`,
    `\n## Stock Market Events:\n${stockEvents}`,
    `\n## World Events:\n${worldEvents}`,
  ].join('\n')
}

export async function generateBriefing(
  ctx: ContextBundle,
  options: { client?: Anthropic } = {},
): Promise<string> {
  const client = options.client ?? new Anthropic()

  const message = await client.messages.create({
    model:      'claude-sonnet-4-6',
    max_tokens: 4096,
    system:     [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
    messages:   [{
      role:    'user',
      content: `Write today's investment briefing for ${ctx.date}.\n\n${formatContext(ctx)}`,
    }],
  })

  const block = message.content.find(b => b.type === 'text')
  if (!block || block.type !== 'text') throw new Error('Expected text response from Claude')
  return block.text
}
```

- [ ] **Step 4: Run tests to confirm they pass**

```bash
npm test -- tests/briefing-agent.test.ts
```

Expected: 3 passed.

- [ ] **Step 5: Commit**

```bash
cd /Users/thanapold/Desktop/Projects/investment-analyst-agents
git add src/briefing/briefing-agent.ts tests/briefing-agent.test.ts
git commit -m "feat: add briefing-agent (Claude-generated daily Markdown briefing)"
```

---

### Task 5: Briefing Writer

**Files:**
- Create: `investment-analyst-agents/src/briefing/briefing-writer.ts`
- Test: `investment-analyst-agents/tests/briefing-writer.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/briefing-writer.test.ts`:
```ts
import { describe, it, expect, afterEach } from 'vitest'
import { readFileSync, rmSync, existsSync } from 'fs'
import { join } from 'path'
import { writeBriefing } from '../src/briefing/briefing-writer.js'

const TMP = 'tests/tmp-writer'

afterEach(() => { try { rmSync(TMP, { recursive: true }) } catch {} })

describe('writeBriefing', () => {
  it('creates the directory and writes the file', () => {
    const path = writeBriefing('2026-05-26', '# Test Briefing', TMP)
    expect(existsSync(path)).toBe(true)
    expect(readFileSync(path, 'utf-8')).toBe('# Test Briefing')
  })

  it('returns the correct file path', () => {
    const path = writeBriefing('2026-05-26', 'content', TMP)
    expect(path).toBe(join(TMP, '2026-05-26.md'))
  })

  it('overwrites existing file on same date', () => {
    writeBriefing('2026-05-26', 'first', TMP)
    writeBriefing('2026-05-26', 'second', TMP)
    expect(readFileSync(join(TMP, '2026-05-26.md'), 'utf-8')).toBe('second')
  })
})
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
cd /Users/thanapold/Desktop/Projects/investment-analyst-agents && npm test -- tests/briefing-writer.test.ts
```

Expected: FAIL — `Cannot find module '../src/briefing/briefing-writer.js'`

- [ ] **Step 3: Write `src/briefing/briefing-writer.ts`**

```ts
import { writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'

export function writeBriefing(date: string, content: string, briefingsDir: string): string {
  mkdirSync(briefingsDir, { recursive: true })
  const outputPath = join(briefingsDir, `${date}.md`)
  writeFileSync(outputPath, content, 'utf-8')
  return outputPath
}
```

- [ ] **Step 4: Run tests to confirm they pass**

```bash
npm test -- tests/briefing-writer.test.ts
```

Expected: 3 passed.

- [ ] **Step 5: Run all tests**

```bash
npm test
```

Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
cd /Users/thanapold/Desktop/Projects/investment-analyst-agents
git add src/briefing/briefing-writer.ts tests/briefing-writer.test.ts
git commit -m "feat: add briefing-writer (saves briefings/YYYY-MM-DD.md)"
```

---

### Task 6: Archivers

**Files:**
- Create: `investment-analyst-agents/src/archive/prediction-archiver.ts`
- Create: `investment-analyst-agents/src/archive/qa-archiver.ts`
- Test: `investment-analyst-agents/tests/archivers.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/archivers.test.ts`:
```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { readFileSync, mkdirSync, rmSync } from 'fs'
import { join } from 'path'
import { archivePrediction } from '../src/archive/prediction-archiver.js'
import { archiveQA }         from '../src/archive/qa-archiver.js'
import type { PredictionEntry, QAEntry } from '../src/types.js'

const TMP = 'tests/tmp-archivers'

const mockPrediction: PredictionEntry = {
  date: '2026-05-26', regime: 'AI Acceleration', confidence: 'high',
  scenarios: [{ scenarioType: 'best', title: 'AI Boom', probability: 65, timeHorizon: '3-6 months', regimeTransition: null, triggers: ['NVDA beats'] }],
  actions:   [{ ticker: 'NVDA', scenarioType: 'best', action: 'buy', conviction: 'high', allocationChangePct: 25 }],
}

const mockQA: QAEntry = {
  date: '2026-05-26', timestamp: '2026-05-26T08:00:00Z', mode: 'single',
  exchanges: [{ question: 'What is the regime?', answer: 'AI Acceleration.' }],
}

beforeEach(() => { mkdirSync(TMP, { recursive: true }) })
afterEach(() => { try { rmSync(TMP, { recursive: true }) } catch {} })

describe('archivePrediction', () => {
  it('creates directory and writes a valid JSONL line', () => {
    const path = join(TMP, 'sub', 'predictions.jsonl')
    archivePrediction(mockPrediction, path)
    const lines = readFileSync(path, 'utf-8').trim().split('\n')
    expect(lines).toHaveLength(1)
    expect(JSON.parse(lines[0]).date).toBe('2026-05-26')
    expect(JSON.parse(lines[0]).scenarios).toHaveLength(1)
  })

  it('appends a second entry on a second call', () => {
    const path = join(TMP, 'predictions.jsonl')
    archivePrediction(mockPrediction, path)
    archivePrediction({ ...mockPrediction, date: '2026-05-27' }, path)
    const lines = readFileSync(path, 'utf-8').trim().split('\n')
    expect(lines).toHaveLength(2)
    expect(JSON.parse(lines[1]).date).toBe('2026-05-27')
  })
})

describe('archiveQA', () => {
  it('creates directory and writes a valid JSONL line', () => {
    const path = join(TMP, 'sub', 'qa.jsonl')
    archiveQA(mockQA, path)
    const lines = readFileSync(path, 'utf-8').trim().split('\n')
    expect(lines).toHaveLength(1)
    const parsed = JSON.parse(lines[0])
    expect(parsed.mode).toBe('single')
    expect(parsed.exchanges[0].question).toBe('What is the regime?')
  })

  it('appends a second entry on a second call', () => {
    const path = join(TMP, 'qa.jsonl')
    archiveQA(mockQA, path)
    archiveQA({ ...mockQA, timestamp: '2026-05-26T09:00:00Z' }, path)
    const lines = readFileSync(path, 'utf-8').trim().split('\n')
    expect(lines).toHaveLength(2)
  })
})
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
cd /Users/thanapold/Desktop/Projects/investment-analyst-agents && npm test -- tests/archivers.test.ts
```

Expected: FAIL — `Cannot find module '../src/archive/prediction-archiver.js'`

- [ ] **Step 3: Write `src/archive/prediction-archiver.ts`**

```ts
import { appendFileSync, mkdirSync } from 'fs'
import { dirname } from 'path'
import type { PredictionEntry } from '../types.js'

export function archivePrediction(entry: PredictionEntry, archivePath: string): void {
  mkdirSync(dirname(archivePath), { recursive: true })
  appendFileSync(archivePath, JSON.stringify(entry) + '\n', 'utf-8')
}
```

- [ ] **Step 4: Write `src/archive/qa-archiver.ts`**

```ts
import { appendFileSync, mkdirSync } from 'fs'
import { dirname } from 'path'
import type { QAEntry } from '../types.js'

export function archiveQA(entry: QAEntry, archivePath: string): void {
  mkdirSync(dirname(archivePath), { recursive: true })
  appendFileSync(archivePath, JSON.stringify(entry) + '\n', 'utf-8')
}
```

- [ ] **Step 5: Run tests to confirm they pass**

```bash
npm test -- tests/archivers.test.ts
```

Expected: 4 passed.

- [ ] **Step 6: Commit**

```bash
cd /Users/thanapold/Desktop/Projects/investment-analyst-agents
git add src/archive/prediction-archiver.ts src/archive/qa-archiver.ts tests/archivers.test.ts
git commit -m "feat: add prediction-archiver and qa-archiver (append-only JSONL)"
```

---

### Task 7: Q&A Agent

**Files:**
- Create: `investment-analyst-agents/src/qa/qa-agent.ts`
- Test: `investment-analyst-agents/tests/qa-agent.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/qa-agent.test.ts`:
```ts
import { describe, it, expect, vi } from 'vitest'
import Anthropic from '@anthropic-ai/sdk'
import { askQuestion } from '../src/qa/qa-agent.js'
import type { SimulationJSON, GraphJSON } from '../src/types.js'

const mockSimulation: SimulationJSON = {
  exportedAt: '',
  portfolio: [{ ticker: 'NVDA', company: 'NVIDIA', shares: 100, avgCost: 68.50, currentPrice: 92.00, currentValue: 9200, unrealizedPnl: 2350, updatedAt: '' }],
  scenarios: [],
  actions:   [],
}

const mockGraph: GraphJSON = {
  exportedAt: '',
  nodes: [],
  edges: [{ from: 'NVDA', to: 'TSM', type: 'supply_chain', strength: 'strong', description: 'NVDA depends on TSM for 3nm fab.', evidenceQuote: null }],
}

const mockContext = { simulation: mockSimulation, graph: mockGraph, profile: 'Risk: moderate.' }
const briefing    = '# Investment Briefing — 2026-05-26\n## Macro Regime\nAI Acceleration (high confidence).'

describe('askQuestion', () => {
  it('returns the text answer from Claude', async () => {
    const mockClient = {
      messages: {
        create: vi.fn().mockResolvedValue({
          content: [{ type: 'text', text: 'AI Acceleration is the current regime.' }],
        }),
      },
    } as unknown as Anthropic

    const answer = await askQuestion('What is the regime?', briefing, mockContext, [], { client: mockClient })
    expect(answer).toBe('AI Acceleration is the current regime.')
  })

  it('places history turns before the current question', async () => {
    let capturedMessages: any[] = []
    const mockClient = {
      messages: {
        create: vi.fn().mockImplementation(async (params: any) => {
          capturedMessages = params.messages
          return { content: [{ type: 'text', text: 'Answer.' }] }
        }),
      },
    } as unknown as Anthropic

    const history: Array<{ role: 'user' | 'assistant'; content: string }> = [
      { role: 'user',      content: 'Prior question.' },
      { role: 'assistant', content: 'Prior answer.' },
    ]
    await askQuestion('Follow-up.', briefing, mockContext, history, { client: mockClient })

    const last       = capturedMessages[capturedMessages.length - 1]
    const secondLast = capturedMessages[capturedMessages.length - 2]
    expect(last.role).toBe('user')
    expect(last.content).toBe('Follow-up.')
    expect(secondLast.role).toBe('assistant')
    expect(secondLast.content).toBe('Prior answer.')
  })

  it('throws when Claude returns no text block', async () => {
    const mockClient = {
      messages: {
        create: vi.fn().mockResolvedValue({ content: [] }),
      },
    } as unknown as Anthropic

    await expect(askQuestion('question', briefing, mockContext, [], { client: mockClient }))
      .rejects.toThrow('Expected text response from Claude')
  })
})
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
cd /Users/thanapold/Desktop/Projects/investment-analyst-agents && npm test -- tests/qa-agent.test.ts
```

Expected: FAIL — `Cannot find module '../src/qa/qa-agent.js'`

- [ ] **Step 3: Write `src/qa/qa-agent.ts`**

```ts
import Anthropic from '@anthropic-ai/sdk'
import type { SimulationJSON, GraphJSON } from '../types.js'

const SYSTEM_PROMPT = `You are an investment analyst assistant.
Answer questions grounded strictly in the provided briefing and data.
Cite specific evidence — tickers, signals, graph edges, scenario narratives.
Do not invent tickers, edges, or relationships not present in the data.
If a question requires real-time price data not available in context, say so explicitly.`

function formatQAContext(
  briefing:   string,
  simulation: SimulationJSON,
  graph:      GraphJSON,
  profile:    string,
): string {
  const portfolio = simulation.portfolio.map(p =>
    `  ${p.ticker}: ${p.shares} shares @ $${p.avgCost.toFixed(2)} | current $${p.currentPrice.toFixed(2)}`
  ).join('\n') || '  None'

  const edges = graph.edges.map(e =>
    `  ${e.from} → ${e.to} [${e.type}, ${e.strength}]: ${e.description.slice(0, 100)}`
  ).join('\n') || '  None'

  return [
    profile ? `## Investor Profile\n${profile}` : '',
    `## Today's Briefing\n${briefing}`,
    `## Portfolio Positions\n${portfolio}`,
    `## Dependency Graph Edges\n${edges}`,
  ].filter(Boolean).join('\n\n')
}

export async function askQuestion(
  question:  string,
  briefing:  string,
  context:   { simulation: SimulationJSON; graph: GraphJSON; profile: string },
  history:   Array<{ role: 'user' | 'assistant'; content: string }>,
  options:   { client?: Anthropic } = {},
): Promise<string> {
  const client = options.client ?? new Anthropic()

  const systemContext = formatQAContext(briefing, context.simulation, context.graph, context.profile)

  const messages: Array<{ role: 'user' | 'assistant'; content: string }> = [
    { role: 'user',      content: `Context:\n${systemContext}` },
    { role: 'assistant', content: 'Understood. I have read the briefing, portfolio positions, and dependency graph. Ask your questions.' },
    ...history,
    { role: 'user',      content: question },
  ]

  const message = await client.messages.create({
    model:      'claude-sonnet-4-6',
    max_tokens: 2048,
    system:     [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
    messages,
  })

  const block = message.content.find(b => b.type === 'text')
  if (!block || block.type !== 'text') throw new Error('Expected text response from Claude')
  return block.text
}
```

- [ ] **Step 4: Run tests to confirm they pass**

```bash
npm test -- tests/qa-agent.test.ts
```

Expected: 3 passed.

- [ ] **Step 5: Run all tests**

```bash
npm test
```

Expected: all tests pass (13 total).

- [ ] **Step 6: Commit**

```bash
cd /Users/thanapold/Desktop/Projects/investment-analyst-agents
git add src/qa/qa-agent.ts tests/qa-agent.test.ts
git commit -m "feat: add qa-agent (briefing-grounded Q&A with conversation history)"
```

---

### Task 8: CLI Files

**Files:**
- Create: `investment-analyst-agents/src/cli/cli-brief.ts`
- Create: `investment-analyst-agents/src/cli/cli-ask.ts`

No dedicated tests — CLI behaviour is covered by the integration smoke test in Task 9.

- [ ] **Step 1: Write `src/cli/cli-brief.ts`**

```ts
import 'dotenv/config'
import { join } from 'path'
import { loadContext }         from '../context/loader.js'
import { generateBriefing }   from '../briefing/briefing-agent.js'
import { writeBriefing }      from '../briefing/briefing-writer.js'
import { archivePrediction }  from '../archive/prediction-archiver.js'
import type { PredictionEntry } from '../types.js'

const BRIEFINGS_DIR  = join(process.cwd(), 'briefings')
const ARCHIVE_PATH   = join(process.cwd(), 'archive', 'predictions.jsonl')

async function run() {
  const today = new Date().toISOString().slice(0, 10)

  console.log(`[${new Date().toISOString()}] Loading context...`)
  const ctx = loadContext(today)

  console.log(`[${new Date().toISOString()}] Generating briefing...`)
  const briefing = await generateBriefing(ctx)

  const outputPath = writeBriefing(today, briefing, BRIEFINGS_DIR)
  console.log(`\nBriefing written to: ${outputPath}\n`)
  console.log(briefing)

  const entry: PredictionEntry = {
    date:       today,
    regime:     ctx.analysis.latestRegime.regime,
    confidence: ctx.analysis.latestRegime.confidence,
    scenarios:  ctx.simulation.scenarios.map(s => ({
      scenarioType:     s.scenarioType,
      title:            s.title,
      probability:      s.probability,
      timeHorizon:      s.timeHorizon,
      regimeTransition: s.regimeTransition,
      triggers:         s.triggers,
    })),
    actions: ctx.simulation.actions.map(a => {
      const scenario = ctx.simulation.scenarios.find(s => s.id === a.scenarioId)
      return {
        ticker:              a.ticker,
        scenarioType:        scenario?.scenarioType ?? 'unknown',
        action:              a.action,
        conviction:          a.conviction,
        allocationChangePct: a.allocationChangePct,
      }
    }),
  }
  archivePrediction(entry, ARCHIVE_PATH)
  console.log(`Prediction archived to: ${ARCHIVE_PATH}`)
}

run().catch(err => { console.error(err); process.exit(1) })
```

- [ ] **Step 2: Write `src/cli/cli-ask.ts`**

```ts
import 'dotenv/config'
import { readFileSync, existsSync } from 'fs'
import { join } from 'path'
import * as readline from 'readline'
import { askQuestion } from '../qa/qa-agent.js'
import { archiveQA }   from '../archive/qa-archiver.js'
import type { SimulationJSON, GraphJSON, QAEntry } from '../types.js'

const BRIEFINGS_DIR   = join(process.cwd(), 'briefings')
const SIMULATION_PATH = join(process.cwd(), '../scenario-simulator/data/simulation.json')
const GRAPH_PATH      = join(process.cwd(), '../dependency-graph-engine/data/graph.json')
const PROFILE_PATH    = join(process.cwd(), 'knowledge/profile.md')
const QA_ARCHIVE_PATH = join(process.cwd(), 'archive', 'qa.jsonl')

const today        = new Date().toISOString().slice(0, 10)
const briefingPath = join(BRIEFINGS_DIR, `${today}.md`)

if (!existsSync(briefingPath)) {
  console.error(`No briefing for today (${today}). Run: npm run brief`)
  process.exit(1)
}

const briefing:    string          = readFileSync(briefingPath, 'utf-8')
const simulation:  SimulationJSON  = JSON.parse(readFileSync(SIMULATION_PATH, 'utf-8'))
const graph:       GraphJSON       = JSON.parse(readFileSync(GRAPH_PATH, 'utf-8'))
const profile:     string          = existsSync(PROFILE_PATH) ? readFileSync(PROFILE_PATH, 'utf-8') : ''
const context = { simulation, graph, profile }

const question = process.argv.slice(2).join(' ').trim()

async function runSingle() {
  const answer = await askQuestion(question, briefing, context, [])
  console.log(`\n${answer}\n`)
  const entry: QAEntry = {
    date:      today,
    timestamp: new Date().toISOString(),
    mode:      'single',
    exchanges: [{ question, answer }],
  }
  archiveQA(entry, QA_ARCHIVE_PATH)
}

async function runLoop() {
  const history: Array<{ role: 'user' | 'assistant'; content: string }> = []
  const exchanges: Array<{ question: string; answer: string }>           = []

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  console.log("Investment Analyst ready. Type your question (or 'exit' to quit).\n")

  const prompt = () => {
    rl.question('You: ', async (input) => {
      const q = input.trim()
      if (!q || q.toLowerCase() === 'exit') {
        rl.close()
        if (exchanges.length > 0) {
          archiveQA({ date: today, timestamp: new Date().toISOString(), mode: 'loop', exchanges }, QA_ARCHIVE_PATH)
          console.log(`\nSession archived to: ${QA_ARCHIVE_PATH}`)
        }
        return
      }
      try {
        const answer = await askQuestion(q, briefing, context, history)
        console.log(`\nAnalyst: ${answer}\n`)
        history.push({ role: 'user',      content: q })
        history.push({ role: 'assistant', content: answer })
        exchanges.push({ question: q, answer })
      } catch (err) {
        console.error('Error:', err)
      }
      prompt()
    })
  }
  prompt()
}

if (question) {
  runSingle().catch(err => { console.error(err); process.exit(1) })
} else {
  runLoop().catch(err => { console.error(err); process.exit(1) })
}
```

- [ ] **Step 3: Verify all tests still pass**

```bash
cd /Users/thanapold/Desktop/Projects/investment-analyst-agents && npm test
```

Expected: 13 tests pass.

- [ ] **Step 4: Commit**

```bash
cd /Users/thanapold/Desktop/Projects/investment-analyst-agents
git add src/cli/cli-brief.ts src/cli/cli-ask.ts
git commit -m "feat: add CLI entry points (brief + ask)"
```

---

### Task 9: Integration Smoke Test

**Files:** None created — verify the pipeline end-to-end.

- [ ] **Step 1: Copy the real API key**

```bash
cat /Users/thanapold/Desktop/Projects/ai-analysis-engine/.env
```

Copy `ANTHROPIC_API_KEY` and write to `investment-analyst-agents/.env`:
```
ANTHROPIC_API_KEY=<paste real key here>
```

- [ ] **Step 2: Verify all upstream data files exist**

```bash
ls /Users/thanapold/Desktop/Projects/ai-analysis-engine/data/analysis.json && \
ls /Users/thanapold/Desktop/Projects/scenario-simulator/data/simulation.json && \
ls /Users/thanapold/Desktop/Projects/dependency-graph-engine/data/graph.json && \
ls /Users/thanapold/Desktop/Projects/investment-analyst-agents/data/exports/stock-project/intelligence.json && \
ls /Users/thanapold/Desktop/Projects/investment-analyst-agents/data/exports/world-map/intelligence.json
```

Expected: all five files exist. If any is missing, stop and fix before continuing.

- [ ] **Step 3: Run `npm run brief`**

```bash
cd /Users/thanapold/Desktop/Projects/investment-analyst-agents && npm run brief
```

Expected output:
```
[...] Loading context...
[...] Generating briefing...

Briefing written to: .../briefings/YYYY-MM-DD.md

# Investment Briefing — YYYY-MM-DD
## Macro Regime
...
## World Intelligence
...
## Portfolio Health
...
## Scenario Outlook
...
## Today's Recommended Actions
...
## Things to Watch
...

Prediction archived to: .../archive/predictions.jsonl
```

- [ ] **Step 4: Verify output files**

```bash
ls /Users/thanapold/Desktop/Projects/investment-analyst-agents/briefings/ && \
ls /Users/thanapold/Desktop/Projects/investment-analyst-agents/archive/
```

Expected: `YYYY-MM-DD.md` in briefings, `predictions.jsonl` in archive.

- [ ] **Step 5: Verify predictions.jsonl is valid JSONL**

```bash
cd /Users/thanapold/Desktop/Projects/investment-analyst-agents && \
node -e "
import('fs').then(({ readFileSync }) => {
  const lines = readFileSync('archive/predictions.jsonl', 'utf-8').trim().split('\n');
  const entry = JSON.parse(lines[lines.length - 1]);
  console.log('date:', entry.date);
  console.log('regime:', entry.regime);
  console.log('scenarios:', entry.scenarios.length);
  console.log('actions:', entry.actions.length);
});"
```

Expected: `date: YYYY-MM-DD`, `regime: <something>`, `scenarios: 3` (or 0 if no simulation run).

- [ ] **Step 6: Run single-shot Q&A**

```bash
cd /Users/thanapold/Desktop/Projects/investment-analyst-agents && \
npm run ask -- "What is the current macro regime and what does it mean for my portfolio?"
```

Expected: A grounded answer referencing the regime from the briefing. Should NOT make up information.

- [ ] **Step 7: Verify qa.jsonl is valid JSONL**

```bash
node -e "
import('fs').then(({ readFileSync }) => {
  const lines = readFileSync('archive/qa.jsonl', 'utf-8').trim().split('\n');
  const entry = JSON.parse(lines[lines.length - 1]);
  console.log('mode:', entry.mode);
  console.log('exchanges:', entry.exchanges.length);
  console.log('question:', entry.exchanges[0].question.slice(0, 60));
});"
```

Expected: `mode: single`, `exchanges: 1`, question matches what was asked.

- [ ] **Step 8: Run all tests one final time**

```bash
npm test
```

Expected: 13 tests pass.

- [ ] **Step 9: Commit the briefing**

```bash
cd /Users/thanapold/Desktop/Projects/investment-analyst-agents
git add briefings/
git commit -m "feat: investment-analyst-agents integration smoke test passing"
```

Note: `archive/` files are gitignored and will not be staged. `briefings/` IS committed.
