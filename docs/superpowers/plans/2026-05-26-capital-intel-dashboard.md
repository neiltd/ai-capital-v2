# Capital Intel Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a local-first Next.js 14 dashboard that visualizes all upstream intelligence from the AI Capital Flow system in a dark-premium web UI with five sections: Briefing, Portfolio, World Intel, Graph, and Ask.

**Architecture:** Server-side API routes read from `$DATA_ROOT` filesystem paths and serve data to client-side React pages — the browser never touches the filesystem directly. This means migrating to hosted infra only requires changing what the route reads, with no frontend changes. A `.env.local` file supplies `ANTHROPIC_API_KEY` and `DATA_ROOT`.

**Tech Stack:** Next.js 14 (App Router), TypeScript, Tailwind CSS, react-markdown + remark-gfm, react-force-graph-2d, @anthropic-ai/sdk, dotenv

---

## File Map

```
capital-intel-dashboard/
  .env.local                        ← ANTHROPIC_API_KEY + DATA_ROOT (not committed)
  .gitignore
  next.config.ts
  package.json
  postcss.config.js
  tailwind.config.ts
  tsconfig.json
  src/
    types.ts                        ← TypeScript interfaces for all upstream JSON shapes
    lib/
      data.ts                       ← server-only helpers: readAnalysis, readSimulation, etc.
    app/
      globals.css                   ← Tailwind directives + dark base styles
      layout.tsx                    ← root layout: sidebar + dark theme + Inter font
      page.tsx                      ← redirect to /briefing
      briefing/
        page.tsx                    ← summary header + full Markdown briefing
      portfolio/
        page.tsx                    ← positions table + 3-column scenario cards
      world/
        page.tsx                    ← two panels: market events + world events
      graph/
        page.tsx                    ← shell with dynamic import guard
        GraphClient.tsx             ← 'use client' react-force-graph-2d wrapper
      ask/
        page.tsx                    ← streaming chat UI
    api/
      briefing/
        route.ts                    ← GET: reads briefing MD + simulation.json
      context/
        route.ts                    ← GET: reads all upstream JSON
      ask/
        route.ts                    ← POST: streams Claude response
      archive-qa/
        route.ts                    ← POST: appends to qa.jsonl
    components/
      Sidebar.tsx                   ← 'use client' persistent left nav
      RegimeBadge.tsx               ← regime label + confidence pill
      ScenarioSummaryPills.tsx      ← 3 probability pills (Best/Base/Disruption)
      ScenarioCards.tsx             ← 3-column scenario grid with action list
      WorldEventCard.tsx            ← event card with severity badge + tags
      ChatMessage.tsx               ← single chat bubble, Markdown rendered
```

---

## Task 1: Scaffold the Project

**Files:**
- Create: `capital-intel-dashboard/package.json`
- Create: `capital-intel-dashboard/tsconfig.json`
- Create: `capital-intel-dashboard/next.config.ts`
- Create: `capital-intel-dashboard/tailwind.config.ts`
- Create: `capital-intel-dashboard/postcss.config.js`
- Create: `capital-intel-dashboard/.gitignore`
- Create: `capital-intel-dashboard/.env.local` (not committed)

- [ ] **Step 1: Create project directory and package.json**

```bash
mkdir -p /Users/thanapold/Desktop/Projects/capital-intel-dashboard
```

Create `capital-intel-dashboard/package.json`:

```json
{
  "name": "capital-intel-dashboard",
  "version": "0.1.0",
  "private": true,
  "scripts": {
    "dev": "next dev",
    "build": "next build",
    "start": "next start"
  },
  "dependencies": {
    "@anthropic-ai/sdk": "^0.52.0",
    "next": "14.2.29",
    "react": "^18.3.1",
    "react-dom": "^18.3.1",
    "react-force-graph-2d": "^1.25.5",
    "react-markdown": "^9.0.3",
    "remark-gfm": "^4.0.1"
  },
  "devDependencies": {
    "@types/node": "^20.17.57",
    "@types/react": "^18.3.23",
    "@types/react-dom": "^18.3.7",
    "autoprefixer": "^10.4.21",
    "postcss": "^8.5.3",
    "tailwindcss": "^3.4.17",
    "typescript": "^5.8.3"
  }
}
```

- [ ] **Step 2: Create tsconfig.json**

Create `capital-intel-dashboard/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2017",
    "lib": ["dom", "dom.iterable", "esnext"],
    "allowJs": true,
    "skipLibCheck": true,
    "strict": true,
    "noEmit": true,
    "esModuleInterop": true,
    "module": "esnext",
    "moduleResolution": "bundler",
    "resolveJsonModule": true,
    "isolatedModules": true,
    "jsx": "preserve",
    "incremental": true,
    "plugins": [{ "name": "next" }],
    "paths": { "@/*": ["./src/*"] }
  },
  "include": ["next-env.d.ts", "**/*.ts", "**/*.tsx", ".next/types/**/*.ts"],
  "exclude": ["node_modules"]
}
```

- [ ] **Step 3: Create next.config.ts**

Create `capital-intel-dashboard/next.config.ts`:

```ts
import type { NextConfig } from 'next'

const nextConfig: NextConfig = {}

export default nextConfig
```

- [ ] **Step 4: Create tailwind.config.ts**

Create `capital-intel-dashboard/tailwind.config.ts`:

```ts
import type { Config } from 'tailwindcss'

const config: Config = {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        'bg-base': '#0a0a0f',
        'bg-sidebar': '#0d0d14',
        'bg-card': '#111118',
        'border-subtle': '#1e1e2e',
        'accent-primary': '#6366f1',
        'accent-violet': '#8b5cf6',
        'text-primary': '#e2e8f0',
        'text-secondary': '#c9d1d9',
        'text-muted': '#6b7280',
        'text-inactive': '#4b5563',
        'green-signal': '#4ade80',
        'amber-signal': '#f59e0b',
        'red-signal': '#f87171',
        'indigo-active': '#818cf8',
      },
    },
  },
  plugins: [],
}

export default config
```

- [ ] **Step 5: Create postcss.config.js**

Create `capital-intel-dashboard/postcss.config.js`:

```js
module.exports = {
  plugins: {
    tailwindcss: {},
    autoprefixer: {},
  },
}
```

- [ ] **Step 6: Create .gitignore**

Create `capital-intel-dashboard/.gitignore`:

```
.next/
node_modules/
.env.local
```

- [ ] **Step 7: Create .env.local**

Create `capital-intel-dashboard/.env.local`:

```
ANTHROPIC_API_KEY=sk-ant-YOUR_KEY_HERE
DATA_ROOT=/Users/thanapold/Desktop/Projects
```

- [ ] **Step 8: Install dependencies**

```bash
cd /Users/thanapold/Desktop/Projects/capital-intel-dashboard && npm install
```

Expected: `added N packages` with no errors.

- [ ] **Step 9: Initialize git and commit**

```bash
cd /Users/thanapold/Desktop/Projects/capital-intel-dashboard && git init && git add package.json tsconfig.json next.config.ts tailwind.config.ts postcss.config.js .gitignore && git commit -m "feat: scaffold capital-intel-dashboard"
```

---

## Task 2: Shared Types and Data Utilities

**Files:**
- Create: `src/types.ts`
- Create: `src/lib/data.ts`

- [ ] **Step 1: Create src/types.ts**

Create `capital-intel-dashboard/src/types.ts`:

```ts
export interface AnalysisJSON {
  date: string
  regime: string
  confidence: string
  signals: Array<{ name: string; direction: string; strength: string; description: string }>
  thingsToWatch: Array<{ item: string; reason: string }>
  tickers: string[]
}

export interface ScenarioAction {
  scenarioId: string
  scenarioType: string
  ticker: string
  action: string
  rationale: string
}

export interface SimulationScenario {
  scenarioId: string
  scenarioType: 'best' | 'base' | 'disruption'
  title: string
  probability: number
  timeHorizon: string
  narrative: string
}

export interface PortfolioPosition {
  ticker: string
  shares: number
  avgCost: number
  currentPrice: number
}

export interface SimulationJSON {
  date: string
  regime: string
  confidence: string
  scenarios: SimulationScenario[]
  actions: ScenarioAction[]
  portfolio: PortfolioPosition[]
}

export interface GraphNode {
  id: string
  ticker: string
  companyName: string
  themes: string[]
}

export interface GraphEdge {
  source: string
  target: string
  type: string
  strength: 'strong' | 'medium' | 'weak'
}

export interface GraphJSON {
  nodes: GraphNode[]
  edges: GraphEdge[]
}

export interface StockEvent {
  eventId: string
  title: string
  summary: string
  severity: 'Critical' | 'High' | 'Medium' | 'Low'
  eventType: string
  marketDirection: string
  tickers: string[]
  date: string
}

export interface StockIntelJSON {
  date: string
  events: StockEvent[]
}

export interface WorldEvent {
  eventId: string
  title: string
  summary: string
  severity: 'Critical' | 'High' | 'Medium' | 'Low'
  countries: string[]
  escalationPotential: string
  date: string
}

export interface WorldIntelJSON {
  date: string
  events: WorldEvent[]
  countrySignals: Array<{ country: string; signal: string; direction: string }>
}

export interface BriefingResponse {
  date: string
  markdown: string
  regime: string
  confidence: string
  scenarios: Array<{ scenarioType: string; title: string; probability: number; timeHorizon: string }>
  missing: boolean
}

export interface ContextResponse {
  analysis: AnalysisJSON
  simulation: SimulationJSON
  graph: GraphJSON
  stockIntel: StockIntelJSON
  worldIntel: WorldIntelJSON
}
```

- [ ] **Step 2: Create src/lib/data.ts**

Create `capital-intel-dashboard/src/lib/data.ts`:

```ts
import fs from 'fs'
import path from 'path'
import type { AnalysisJSON, SimulationJSON, GraphJSON, StockIntelJSON, WorldIntelJSON } from '@/types'

function dataRoot(): string {
  const root = process.env.DATA_ROOT
  if (!root) throw new Error('DATA_ROOT env var is not set')
  return root
}

function readJSON<T>(filePath: string): T {
  const raw = fs.readFileSync(filePath, 'utf-8')
  return JSON.parse(raw) as T
}

export function readAnalysis(): AnalysisJSON {
  return readJSON<AnalysisJSON>(
    path.join(dataRoot(), 'ai-analysis-engine/data/analysis.json')
  )
}

export function readSimulation(): SimulationJSON {
  return readJSON<SimulationJSON>(
    path.join(dataRoot(), 'scenario-simulator/data/simulation.json')
  )
}

export function readGraph(): GraphJSON {
  return readJSON<GraphJSON>(
    path.join(dataRoot(), 'dependency-graph-engine/data/graph.json')
  )
}

export function readStockIntel(): StockIntelJSON {
  return readJSON<StockIntelJSON>(
    path.join(dataRoot(), 'world-intelligence-data-hub-/exports/stock-project/intelligence.json')
  )
}

export function readWorldIntel(): WorldIntelJSON {
  return readJSON<WorldIntelJSON>(
    path.join(dataRoot(), 'world-intelligence-data-hub-/exports/world-map/intelligence.json')
  )
}

export function readBriefing(date: string): string | null {
  const p = path.join(dataRoot(), `investment-analyst-agents/briefings/${date}.md`)
  if (!fs.existsSync(p)) return null
  return fs.readFileSync(p, 'utf-8')
}

export function readProfile(): string {
  const p = path.join(dataRoot(), 'investment-analyst-agents/knowledge/profile.md')
  if (!fs.existsSync(p)) return ''
  return fs.readFileSync(p, 'utf-8')
}

export function qaArchivePath(): string {
  return path.join(dataRoot(), 'investment-analyst-agents/archive/qa.jsonl')
}
```

- [ ] **Step 3: Commit**

```bash
cd /Users/thanapold/Desktop/Projects/capital-intel-dashboard && mkdir -p src/lib && git add src/types.ts src/lib/data.ts && git commit -m "feat: add shared types and data utilities"
```

---

## Task 3: Root Layout and Sidebar

**Files:**
- Create: `src/app/globals.css`
- Create: `src/app/layout.tsx`
- Create: `src/app/page.tsx`
- Create: `src/components/Sidebar.tsx`

- [ ] **Step 1: Create src/app/globals.css**

Create `capital-intel-dashboard/src/app/globals.css`:

```css
@tailwind base;
@tailwind components;
@tailwind utilities;

html, body {
  background-color: #0a0a0f;
  color: #e2e8f0;
  height: 100%;
}

/* Prose styles for react-markdown inside briefing and chat */
.prose-dark h1, .prose-dark h2, .prose-dark h3 {
  color: #e2e8f0;
  margin-top: 1.25em;
  margin-bottom: 0.5em;
}
.prose-dark p { color: #c9d1d9; margin-bottom: 0.75em; }
.prose-dark ul, .prose-dark ol { color: #c9d1d9; padding-left: 1.5em; margin-bottom: 0.75em; }
.prose-dark li { margin-bottom: 0.25em; }
.prose-dark strong { color: #e2e8f0; }
.prose-dark table { width: 100%; border-collapse: collapse; margin-bottom: 1em; }
.prose-dark th { background: #1e1e2e; color: #818cf8; padding: 6px 10px; text-align: left; font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; }
.prose-dark td { padding: 6px 10px; border-bottom: 1px solid #1e1e2e; color: #c9d1d9; font-size: 13px; }
.prose-dark code { background: #1e1e2e; color: #818cf8; padding: 1px 5px; border-radius: 3px; font-size: 12px; }
.prose-dark blockquote { border-left: 3px solid #6366f1; padding-left: 12px; color: #6b7280; }
.prose-dark hr { border-color: #1e1e2e; margin: 1em 0; }
```

- [ ] **Step 2: Create src/app/layout.tsx**

Create `capital-intel-dashboard/src/app/layout.tsx`:

```tsx
import type { Metadata } from 'next'
import './globals.css'
import { Sidebar } from '@/components/Sidebar'

export const metadata: Metadata = {
  title: 'Capital Intel Dashboard',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="flex h-screen overflow-hidden bg-bg-base text-text-primary" style={{ fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" }}>
        <Sidebar />
        <main className="flex-1 overflow-y-auto p-6">
          {children}
        </main>
      </body>
    </html>
  )
}
```

- [ ] **Step 3: Create src/app/page.tsx**

Create `capital-intel-dashboard/src/app/page.tsx`:

```tsx
import { redirect } from 'next/navigation'

export default function Home() {
  redirect('/briefing')
}
```

- [ ] **Step 4: Create src/components/Sidebar.tsx**

Create `capital-intel-dashboard/src/components/Sidebar.tsx`:

```tsx
'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'

const NAV = [
  { href: '/briefing', icon: '📋', label: 'Briefing' },
  { href: '/portfolio', icon: '💼', label: 'Portfolio' },
  { href: '/world', icon: '🌍', label: 'World Intel' },
  { href: '/graph', icon: '🕸', label: 'Graph' },
  { href: '/ask', icon: '💬', label: 'Ask' },
]

export function Sidebar() {
  const pathname = usePathname()
  const today = new Date().toISOString().split('T')[0]

  return (
    <aside className="w-44 flex-shrink-0 bg-bg-sidebar border-r border-border-subtle flex flex-col">
      <div className="px-4 py-4 border-b border-border-subtle">
        <div
          className="text-sm font-bold"
          style={{ background: 'linear-gradient(90deg,#6366f1,#8b5cf6)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }}
        >
          ⬡ Capital Intel
        </div>
        <div className="text-[10px] text-text-inactive mt-0.5">{today}</div>
      </div>

      <nav className="flex-1 px-2 py-3 space-y-0.5">
        {NAV.map(({ href, icon, label }) => {
          const active = pathname === href || pathname.startsWith(href + '/')
          return (
            <Link
              key={href}
              href={href}
              className={`flex items-center gap-1.5 px-2.5 py-2 rounded text-xs transition-colors ${
                active
                  ? 'bg-border-subtle text-indigo-active border-l-2 border-accent-primary'
                  : 'text-text-inactive hover:text-text-muted'
              }`}
            >
              <span>{icon}</span>
              <span className={active ? 'font-medium' : ''}>{label}</span>
            </Link>
          )
        })}
      </nav>

      <div className="px-4 py-3 border-t border-border-subtle">
        <div className="text-[10px] text-text-inactive">Local dashboard</div>
      </div>
    </aside>
  )
}
```

- [ ] **Step 5: Commit**

```bash
cd /Users/thanapold/Desktop/Projects/capital-intel-dashboard && mkdir -p src/app src/components && git add src/app/globals.css src/app/layout.tsx src/app/page.tsx src/components/Sidebar.tsx && git commit -m "feat: add root layout and sidebar navigation"
```

---

## Task 4: API Routes

**Files:**
- Create: `src/api/briefing/route.ts`
- Create: `src/api/context/route.ts`
- Create: `src/api/ask/route.ts`
- Create: `src/api/archive-qa/route.ts`

- [ ] **Step 1: Create src/app/api/briefing/route.ts**

Create `capital-intel-dashboard/src/app/api/briefing/route.ts`:

```ts
import { NextResponse } from 'next/server'
import { readBriefing, readSimulation } from '@/lib/data'

export async function GET() {
  const today = new Date().toISOString().split('T')[0]

  try {
    const simulation = readSimulation()
    const markdown = readBriefing(today)

    if (!markdown) {
      return NextResponse.json({
        date: today,
        markdown: '',
        regime: simulation.regime,
        confidence: simulation.confidence,
        scenarios: simulation.scenarios.map(s => ({
          scenarioType: s.scenarioType,
          title: s.title,
          probability: s.probability,
          timeHorizon: s.timeHorizon,
        })),
        missing: true,
      })
    }

    return NextResponse.json({
      date: today,
      markdown,
      regime: simulation.regime,
      confidence: simulation.confidence,
      scenarios: simulation.scenarios.map(s => ({
        scenarioType: s.scenarioType,
        title: s.title,
        probability: s.probability,
        timeHorizon: s.timeHorizon,
      })),
      missing: false,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
```

- [ ] **Step 2: Create src/app/api/context/route.ts**

Create `capital-intel-dashboard/src/app/api/context/route.ts`:

```ts
import { NextResponse } from 'next/server'
import { readAnalysis, readSimulation, readGraph, readStockIntel, readWorldIntel } from '@/lib/data'

export async function GET() {
  try {
    const [analysis, simulation, graph, stockIntel, worldIntel] = await Promise.all([
      Promise.resolve(readAnalysis()),
      Promise.resolve(readSimulation()),
      Promise.resolve(readGraph()),
      Promise.resolve(readStockIntel()),
      Promise.resolve(readWorldIntel()),
    ])
    return NextResponse.json({ analysis, simulation, graph, stockIntel, worldIntel })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
```

- [ ] **Step 3: Create src/app/api/ask/route.ts**

Create `capital-intel-dashboard/src/app/api/ask/route.ts`:

```ts
import { NextRequest } from 'next/server'
import Anthropic from '@anthropic-ai/sdk'
import { readBriefing, readSimulation, readGraph, readProfile } from '@/lib/data'

export async function POST(req: NextRequest) {
  const today = new Date().toISOString().split('T')[0]

  const briefing = readBriefing(today)
  if (!briefing) {
    return new Response(
      JSON.stringify({ error: 'No briefing for today — run npm run brief' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } }
    )
  }

  const body = await req.json() as { question: string }
  if (!body.question?.trim()) {
    return new Response(
      JSON.stringify({ error: 'question is required' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } }
    )
  }

  const simulation = readSimulation()
  const graph = readGraph()
  const profile = readProfile()

  const systemPrompt = `You are an AI investment analyst assistant. Answer questions grounded in today's briefing.
${profile ? `\nInvestor profile:\n${profile}` : ''}

Today's briefing:
${briefing}

Simulation data (regime: ${simulation.regime}, confidence: ${simulation.confidence}):
${JSON.stringify(simulation.scenarios, null, 2)}

Portfolio positions: ${JSON.stringify(simulation.portfolio, null, 2)}
Recommended actions: ${JSON.stringify(simulation.actions, null, 2)}

Dependency graph nodes: ${simulation.portfolio.map(p => p.ticker).join(', ')}

Be concise and direct. Cite specific data from the briefing. Use Markdown formatting.`

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

  const stream = client.messages.stream({
    model: 'claude-sonnet-4-6',
    max_tokens: 2048,
    system: systemPrompt,
    messages: [{ role: 'user', content: body.question }],
  })

  const readable = new ReadableStream({
    async start(controller) {
      try {
        for await (const event of stream) {
          if (
            event.type === 'content_block_delta' &&
            event.delta.type === 'text_delta'
          ) {
            controller.enqueue(new TextEncoder().encode(event.delta.text))
          }
        }
      } finally {
        controller.close()
      }
    },
  })

  return new Response(readable, {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  })
}
```

- [ ] **Step 4: Create src/app/api/archive-qa/route.ts**

Create `capital-intel-dashboard/src/app/api/archive-qa/route.ts`:

```ts
import { NextRequest, NextResponse } from 'next/server'
import fs from 'fs'
import path from 'path'
import { qaArchivePath } from '@/lib/data'

export async function POST(req: NextRequest) {
  const body = await req.json() as { question: string; answer: string }
  if (!body.question || !body.answer) {
    return NextResponse.json({ error: 'question and answer required' }, { status: 400 })
  }

  const archivePath = qaArchivePath()
  fs.mkdirSync(path.dirname(archivePath), { recursive: true })

  const entry = {
    date: new Date().toISOString().split('T')[0],
    timestamp: new Date().toISOString(),
    question: body.question,
    answer: body.answer,
  }
  fs.appendFileSync(archivePath, JSON.stringify(entry) + '\n', 'utf-8')

  return NextResponse.json({ ok: true })
}
```

- [ ] **Step 5: Commit**

```bash
cd /Users/thanapold/Desktop/Projects/capital-intel-dashboard && mkdir -p src/app/api/briefing src/app/api/context src/app/api/ask src/app/api/archive-qa && git add src/app/api/ && git commit -m "feat: add API routes (briefing, context, ask, archive-qa)"
```

---

## Task 5: Briefing Page

**Files:**
- Create: `src/components/RegimeBadge.tsx`
- Create: `src/components/ScenarioSummaryPills.tsx`
- Create: `src/app/briefing/page.tsx`

- [ ] **Step 1: Create src/components/RegimeBadge.tsx**

Create `capital-intel-dashboard/src/components/RegimeBadge.tsx`:

```tsx
interface Props {
  regime: string
  confidence: string
}

const CONFIDENCE_COLORS: Record<string, string> = {
  high: 'bg-green-signal/10 text-green-signal',
  medium: 'bg-amber-signal/10 text-amber-signal',
  low: 'bg-red-signal/10 text-red-signal',
}

export function RegimeBadge({ regime, confidence }: Props) {
  const key = confidence.toLowerCase().replace(/\s+/g, ' ')
  const confClass = Object.keys(CONFIDENCE_COLORS).find(k => key.includes(k))
  const colorClass = confClass ? CONFIDENCE_COLORS[confClass] : 'bg-text-inactive/10 text-text-muted'

  return (
    <div className="flex items-center gap-2 flex-wrap">
      <span className="bg-accent-primary/10 text-indigo-active rounded px-2 py-0.5 text-xs font-medium">
        {regime}
      </span>
      <span className={`rounded px-2 py-0.5 text-xs font-medium ${colorClass}`}>
        {confidence}
      </span>
    </div>
  )
}
```

- [ ] **Step 2: Create src/components/ScenarioSummaryPills.tsx**

Create `capital-intel-dashboard/src/components/ScenarioSummaryPills.tsx`:

```tsx
interface Scenario {
  scenarioType: string
  title: string
  probability: number
  timeHorizon: string
}

interface Props {
  scenarios: Scenario[]
}

const TYPE_COLORS: Record<string, string> = {
  best: 'bg-green-signal/10 text-green-signal',
  base: 'bg-amber-signal/10 text-amber-signal',
  disruption: 'bg-red-signal/10 text-red-signal',
}

export function ScenarioSummaryPills({ scenarios }: Props) {
  return (
    <div className="flex items-center gap-2 flex-wrap">
      {scenarios.map(s => {
        const colorClass = TYPE_COLORS[s.scenarioType] ?? 'bg-text-inactive/10 text-text-muted'
        const label = s.scenarioType.charAt(0).toUpperCase() + s.scenarioType.slice(1)
        return (
          <span key={s.scenarioType} className={`rounded px-2 py-0.5 text-xs font-medium ${colorClass}`}>
            {label} {Math.round(s.probability)}%
          </span>
        )
      })}
    </div>
  )
}
```

- [ ] **Step 3: Create src/app/briefing/page.tsx**

Create `capital-intel-dashboard/src/app/briefing/page.tsx`:

```tsx
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { RegimeBadge } from '@/components/RegimeBadge'
import { ScenarioSummaryPills } from '@/components/ScenarioSummaryPills'
import type { BriefingResponse } from '@/types'

async function getBriefing(): Promise<BriefingResponse> {
  const res = await fetch('http://localhost:3000/api/briefing', { cache: 'no-store' })
  if (!res.ok) throw new Error('Failed to load briefing')
  return res.json()
}

export default async function BriefingPage() {
  let data: BriefingResponse
  let fetchError: string | null = null

  try {
    data = await getBriefing()
  } catch {
    fetchError = 'Could not load briefing data. Is the dev server running?'
    data = { date: '', markdown: '', regime: '', confidence: '', scenarios: [], missing: true }
  }

  return (
    <div className="max-w-3xl">
      <div className="flex items-start justify-between mb-4 gap-4 flex-wrap">
        <div>
          <h1 className="text-base font-bold text-text-primary">Investment Briefing</h1>
          <p className="text-[11px] text-text-inactive mt-0.5">{data.date || 'No date'}</p>
        </div>
        <div className="flex flex-col gap-2">
          {data.regime && <RegimeBadge regime={data.regime} confidence={data.confidence} />}
          {data.scenarios.length > 0 && <ScenarioSummaryPills scenarios={data.scenarios} />}
        </div>
      </div>

      {fetchError && (
        <div className="bg-red-signal/10 border border-red-signal/20 rounded-lg p-4 text-sm text-red-signal mb-4">
          {fetchError}
        </div>
      )}

      {data.missing && !fetchError && (
        <div className="bg-bg-card border border-border-subtle rounded-lg p-6 text-center text-text-muted text-sm">
          No briefing for today — run{' '}
          <code className="bg-border-subtle text-indigo-active px-1.5 py-0.5 rounded text-xs">
            npm run brief
          </code>{' '}
          in investment-analyst-agents.
        </div>
      )}

      {!data.missing && data.markdown && (
        <div className="bg-bg-card border border-border-subtle rounded-lg p-6 prose-dark">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{data.markdown}</ReactMarkdown>
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 4: Commit**

```bash
cd /Users/thanapold/Desktop/Projects/capital-intel-dashboard && mkdir -p src/app/briefing && git add src/components/RegimeBadge.tsx src/components/ScenarioSummaryPills.tsx src/app/briefing/page.tsx && git commit -m "feat: add briefing page with regime badge and scenario pills"
```

---

## Task 6: Portfolio Page

**Files:**
- Create: `src/components/ScenarioCards.tsx`
- Create: `src/app/portfolio/page.tsx`

- [ ] **Step 1: Create src/components/ScenarioCards.tsx**

Create `capital-intel-dashboard/src/components/ScenarioCards.tsx`:

```tsx
import type { SimulationScenario, ScenarioAction } from '@/types'

interface Props {
  scenarios: SimulationScenario[]
  actions: ScenarioAction[]
}

const SCENARIO_STYLES: Record<string, { border: string; label: string; text: string }> = {
  best: { border: 'border-t-green-signal', label: 'text-green-signal', text: 'Best' },
  base: { border: 'border-t-amber-signal', label: 'text-amber-signal', text: 'Base' },
  disruption: { border: 'border-t-red-signal', label: 'text-red-signal', text: 'Disruption' },
}

export function ScenarioCards({ scenarios, actions }: Props) {
  const ORDER = ['best', 'base', 'disruption']
  const sorted = [...scenarios].sort(
    (a, b) => ORDER.indexOf(a.scenarioType) - ORDER.indexOf(b.scenarioType)
  )

  return (
    <div className="grid grid-cols-3 gap-4">
      {sorted.map(scenario => {
        const style = SCENARIO_STYLES[scenario.scenarioType] ?? {
          border: 'border-t-text-muted', label: 'text-text-muted', text: scenario.scenarioType,
        }
        const scenarioActions = actions.filter(a => a.scenarioId === scenario.scenarioId)

        return (
          <div
            key={scenario.scenarioId}
            className={`bg-bg-card border border-border-subtle rounded-lg p-4 border-t-2 ${style.border}`}
          >
            <div className={`text-[10px] font-semibold uppercase tracking-wide mb-1 ${style.label}`}>
              {style.text} · {Math.round(scenario.probability)}%
            </div>
            <div className="text-xs font-medium text-text-primary mb-1">{scenario.title}</div>
            <div className="text-[11px] text-text-muted mb-3 line-clamp-3">{scenario.narrative}</div>
            {scenarioActions.length > 0 && (
              <div className="border-t border-border-subtle pt-2 space-y-1">
                {scenarioActions.map((a, i) => (
                  <div key={i} className="text-[10px] text-text-secondary">
                    <span className={`font-medium ${style.label}`}>{a.ticker}</span>{' '}
                    {a.action}
                  </div>
                ))}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
```

- [ ] **Step 2: Create src/app/portfolio/page.tsx**

Create `capital-intel-dashboard/src/app/portfolio/page.tsx`:

```tsx
import { ScenarioCards } from '@/components/ScenarioCards'
import type { ContextResponse } from '@/types'

async function getContext(): Promise<ContextResponse> {
  const res = await fetch('http://localhost:3000/api/context', { cache: 'no-store' })
  if (!res.ok) throw new Error('Failed to load context')
  return res.json()
}

export default async function PortfolioPage() {
  let data: ContextResponse | null = null
  let fetchError: string | null = null

  try {
    data = await getContext()
  } catch (e) {
    fetchError = e instanceof Error ? e.message : 'Failed to load portfolio data'
  }

  if (fetchError || !data) {
    return (
      <div className="max-w-4xl">
        <h1 className="text-base font-bold text-text-primary mb-4">Portfolio</h1>
        <div className="bg-red-signal/10 border border-red-signal/20 rounded-lg p-4 text-sm text-red-signal">
          {fetchError ?? 'Failed to load data'}
        </div>
      </div>
    )
  }

  const { simulation } = data
  const positions = simulation.portfolio ?? []

  return (
    <div className="max-w-4xl space-y-6">
      <h1 className="text-base font-bold text-text-primary">Portfolio</h1>

      {/* Positions table */}
      <div className="bg-bg-card border border-border-subtle rounded-lg overflow-hidden">
        <div className="px-4 py-3 border-b border-border-subtle">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-accent-primary">Positions</h2>
        </div>
        {positions.length === 0 ? (
          <div className="p-6 text-center text-text-muted text-sm">
            No positions — add positions via scenario-simulator.
          </div>
        ) : (
          <table className="w-full">
            <thead>
              <tr className="text-[11px] text-text-muted uppercase tracking-wide border-b border-border-subtle">
                <th className="px-4 py-2 text-left">Ticker</th>
                <th className="px-4 py-2 text-right">Shares</th>
                <th className="px-4 py-2 text-right">Avg Cost</th>
                <th className="px-4 py-2 text-right">Current</th>
                <th className="px-4 py-2 text-right">Unrealized P&L</th>
              </tr>
            </thead>
            <tbody>
              {positions.map(p => {
                const pnl = (p.currentPrice - p.avgCost) * p.shares
                const pnlPct = ((p.currentPrice - p.avgCost) / p.avgCost) * 100
                const isPos = pnl >= 0
                return (
                  <tr key={p.ticker} className="border-b border-border-subtle last:border-0">
                    <td className="px-4 py-2.5 text-xs font-semibold text-indigo-active">{p.ticker}</td>
                    <td className="px-4 py-2.5 text-xs text-text-secondary text-right">{p.shares}</td>
                    <td className="px-4 py-2.5 text-xs text-text-secondary text-right">${p.avgCost.toFixed(2)}</td>
                    <td className="px-4 py-2.5 text-xs text-text-secondary text-right">${p.currentPrice.toFixed(2)}</td>
                    <td className={`px-4 py-2.5 text-xs text-right font-medium ${isPos ? 'text-green-signal' : 'text-red-signal'}`}>
                      {isPos ? '+' : ''}{pnl.toFixed(2)} ({isPos ? '+' : ''}{pnlPct.toFixed(1)}%)
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* Scenario cards */}
      <div>
        <h2 className="text-xs font-semibold uppercase tracking-wide text-accent-primary mb-3">Scenarios</h2>
        <ScenarioCards scenarios={simulation.scenarios} actions={simulation.actions} />
      </div>
    </div>
  )
}
```

- [ ] **Step 3: Commit**

```bash
cd /Users/thanapold/Desktop/Projects/capital-intel-dashboard && mkdir -p src/app/portfolio && git add src/components/ScenarioCards.tsx src/app/portfolio/page.tsx && git commit -m "feat: add portfolio page with positions table and scenario cards"
```

---

## Task 7: World Intel Page

**Files:**
- Create: `src/components/WorldEventCard.tsx`
- Create: `src/app/world/page.tsx`

- [ ] **Step 1: Create src/components/WorldEventCard.tsx**

Create `capital-intel-dashboard/src/components/WorldEventCard.tsx`:

```tsx
const SEVERITY_STYLES: Record<string, string> = {
  Critical: 'bg-red-signal/10 text-red-signal border-red-signal/20',
  High: 'bg-amber-signal/10 text-amber-signal border-amber-signal/20',
  Medium: 'bg-indigo-active/10 text-indigo-active border-indigo-active/20',
  Low: 'bg-text-muted/10 text-text-muted border-text-muted/20',
}

interface StockCardProps {
  title: string
  summary: string
  severity: string
  eventType?: string
  marketDirection?: string
  tickers?: string[]
}

interface WorldCardProps {
  title: string
  summary: string
  severity: string
  countries?: string[]
  escalationPotential?: string
}

export function StockEventCard({ title, summary, severity, eventType, marketDirection, tickers }: StockCardProps) {
  const badgeClass = SEVERITY_STYLES[severity] ?? SEVERITY_STYLES.Low
  return (
    <div className="bg-bg-card border border-border-subtle rounded-lg p-4 space-y-2">
      <div className="flex items-start justify-between gap-2">
        <div className="text-xs font-semibold text-text-primary leading-tight">{title}</div>
        <span className={`border text-[10px] font-medium px-1.5 py-0.5 rounded flex-shrink-0 ${badgeClass}`}>
          {severity}
        </span>
      </div>
      <p className="text-[11px] text-text-muted leading-relaxed">{summary}</p>
      <div className="flex items-center gap-2 flex-wrap">
        {eventType && (
          <span className="bg-border-subtle text-text-muted text-[10px] px-1.5 py-0.5 rounded">{eventType}</span>
        )}
        {marketDirection && (
          <span className="bg-border-subtle text-text-muted text-[10px] px-1.5 py-0.5 rounded">{marketDirection}</span>
        )}
        {tickers?.map(t => (
          <span key={t} className="text-indigo-active text-[10px] font-medium">{t}</span>
        ))}
      </div>
    </div>
  )
}

export function WorldEventCard({ title, summary, severity, countries, escalationPotential }: WorldCardProps) {
  const badgeClass = SEVERITY_STYLES[severity] ?? SEVERITY_STYLES.Low
  return (
    <div className="bg-bg-card border border-border-subtle rounded-lg p-4 space-y-2">
      <div className="flex items-start justify-between gap-2">
        <div className="text-xs font-semibold text-text-primary leading-tight">{title}</div>
        <span className={`border text-[10px] font-medium px-1.5 py-0.5 rounded flex-shrink-0 ${badgeClass}`}>
          {severity}
        </span>
      </div>
      <p className="text-[11px] text-text-muted leading-relaxed">{summary}</p>
      <div className="flex items-center gap-2 flex-wrap">
        {countries?.map(c => (
          <span key={c} className="bg-border-subtle text-text-muted text-[10px] px-1.5 py-0.5 rounded">{c}</span>
        ))}
        {escalationPotential && (
          <span className="text-amber-signal text-[10px]">{escalationPotential}</span>
        )}
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Create src/app/world/page.tsx**

Create `capital-intel-dashboard/src/app/world/page.tsx`:

```tsx
import { StockEventCard, WorldEventCard } from '@/components/WorldEventCard'
import type { ContextResponse, StockEvent, WorldEvent } from '@/types'

const SEVERITY_ORDER = ['Critical', 'High', 'Medium', 'Low']

function sortBySeverity<T extends { severity: string }>(events: T[]): T[] {
  return [...events].sort(
    (a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity)
  )
}

async function getContext(): Promise<ContextResponse> {
  const res = await fetch('http://localhost:3000/api/context', { cache: 'no-store' })
  if (!res.ok) throw new Error('Failed to load context')
  return res.json()
}

export default async function WorldPage() {
  let data: ContextResponse | null = null
  let fetchError: string | null = null

  try {
    data = await getContext()
  } catch (e) {
    fetchError = e instanceof Error ? e.message : 'Failed to load world intel'
  }

  if (fetchError || !data) {
    return (
      <div className="max-w-5xl">
        <h1 className="text-base font-bold text-text-primary mb-4">World Intel</h1>
        <div className="bg-red-signal/10 border border-red-signal/20 rounded-lg p-4 text-sm text-red-signal">
          {fetchError ?? 'Failed to load data'}
        </div>
      </div>
    )
  }

  const stockEvents: StockEvent[] = sortBySeverity(data.stockIntel.events ?? [])
  const worldEvents: WorldEvent[] = sortBySeverity(data.worldIntel.events ?? [])

  return (
    <div className="max-w-5xl">
      <h1 className="text-base font-bold text-text-primary mb-4">World Intel</h1>
      <div className="grid grid-cols-2 gap-6">
        {/* Market Events */}
        <div>
          <h2 className="text-xs font-semibold uppercase tracking-wide text-accent-primary mb-3">Market Events</h2>
          {stockEvents.length === 0 ? (
            <div className="bg-bg-card border border-border-subtle rounded-lg p-6 text-center text-text-muted text-sm">
              No events recorded.
            </div>
          ) : (
            <div className="space-y-3">
              {stockEvents.map(e => (
                <StockEventCard
                  key={e.eventId}
                  title={e.title}
                  summary={e.summary}
                  severity={e.severity}
                  eventType={e.eventType}
                  marketDirection={e.marketDirection}
                  tickers={e.tickers}
                />
              ))}
            </div>
          )}
        </div>

        {/* World Events */}
        <div>
          <h2 className="text-xs font-semibold uppercase tracking-wide text-accent-primary mb-3">World Events</h2>
          {worldEvents.length === 0 ? (
            <div className="bg-bg-card border border-border-subtle rounded-lg p-6 text-center text-text-muted text-sm">
              No events recorded.
            </div>
          ) : (
            <div className="space-y-3">
              {worldEvents.map(e => (
                <WorldEventCard
                  key={e.eventId}
                  title={e.title}
                  summary={e.summary}
                  severity={e.severity}
                  countries={e.countries}
                  escalationPotential={e.escalationPotential}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
```

- [ ] **Step 3: Commit**

```bash
cd /Users/thanapold/Desktop/Projects/capital-intel-dashboard && mkdir -p src/app/world && git add src/components/WorldEventCard.tsx src/app/world/page.tsx && git commit -m "feat: add world intel page with market and world event panels"
```

---

## Task 8: Graph Page

**Files:**
- Create: `src/app/graph/GraphClient.tsx`
- Create: `src/app/graph/page.tsx`

- [ ] **Step 1: Create src/app/graph/GraphClient.tsx**

Create `capital-intel-dashboard/src/app/graph/GraphClient.tsx`:

```tsx
'use client'

import { useCallback, useRef, useState } from 'react'
import dynamic from 'next/dynamic'
import type { GraphJSON, GraphNode, GraphEdge } from '@/types'

const ForceGraph2D = dynamic(() => import('react-force-graph-2d'), { ssr: false })

function tickerColor(ticker: string): string {
  const palette = ['#6366f1', '#8b5cf6', '#ec4899', '#f59e0b', '#10b981', '#06b6d4', '#f87171']
  let hash = 0
  for (const c of ticker) hash = (hash * 31 + c.charCodeAt(0)) & 0xffffffff
  return palette[Math.abs(hash) % palette.length]
}

interface NodeObject {
  id: string
  ticker: string
  companyName: string
  themes: string[]
  degree: number
}

interface LinkObject {
  source: string
  target: string
  type: string
  strength: string
}

interface Props {
  data: GraphJSON
}

export function GraphClient({ data }: Props) {
  const [selectedNode, setSelectedNode] = useState<NodeObject | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)

  const degreeMap = new Map<string, number>()
  for (const e of data.edges) {
    degreeMap.set(e.source, (degreeMap.get(e.source) ?? 0) + 1)
    degreeMap.set(e.target, (degreeMap.get(e.target) ?? 0) + 1)
  }

  const nodes: NodeObject[] = data.nodes.map(n => ({
    ...n,
    degree: degreeMap.get(n.id) ?? 0,
  }))

  const links: LinkObject[] = data.edges.map(e => ({
    source: e.source,
    target: e.target,
    type: e.type,
    strength: e.strength,
  }))

  const STRENGTH_WIDTH: Record<string, number> = { strong: 2.5, medium: 1.5, weak: 0.8 }

  const handleNodeClick = useCallback((node: object) => {
    setSelectedNode(node as NodeObject)
  }, [])

  const nodeEdges = selectedNode
    ? data.edges.filter(e => e.source === selectedNode.id || e.target === selectedNode.id)
    : []

  return (
    <div className="flex h-full gap-4">
      <div className="flex-1 bg-bg-card border border-border-subtle rounded-lg overflow-hidden" ref={containerRef}>
        <ForceGraph2D
          graphData={{ nodes, links }}
          nodeId="id"
          nodeLabel="ticker"
          nodeColor={(node: object) => tickerColor((node as NodeObject).ticker)}
          nodeVal={(node: object) => Math.max(3, (node as NodeObject).degree * 2 + 4)}
          linkWidth={(link: object) => STRENGTH_WIDTH[(link as LinkObject).strength] ?? 1}
          linkColor={() => '#1e1e2e'}
          backgroundColor="#111118"
          onNodeClick={handleNodeClick}
          nodeCanvasObjectMode={() => 'after'}
          nodeCanvasObject={(node: object, ctx: CanvasRenderingContext2D, globalScale: number) => {
            const n = node as NodeObject & { x?: number; y?: number }
            if (!n.x || !n.y) return
            const label = n.ticker
            const fontSize = Math.max(8, 12 / globalScale)
            ctx.font = `${fontSize}px sans-serif`
            ctx.fillStyle = '#e2e8f0'
            ctx.textAlign = 'center'
            ctx.fillText(label, n.x, n.y + Math.max(3, (n.degree * 2 + 4)) + fontSize)
          }}
          width={containerRef.current?.clientWidth ?? 600}
          height={500}
        />
      </div>

      {selectedNode && (
        <div className="w-64 bg-bg-card border border-border-subtle rounded-lg p-4 flex-shrink-0 overflow-y-auto">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-xs font-bold text-text-primary">{selectedNode.ticker}</h3>
            <button
              onClick={() => setSelectedNode(null)}
              className="text-text-muted text-xs hover:text-text-primary"
            >
              ✕
            </button>
          </div>
          <p className="text-[11px] text-text-secondary mb-3">{selectedNode.companyName}</p>
          {selectedNode.themes?.length > 0 && (
            <div className="mb-3">
              <div className="text-[10px] uppercase tracking-wide text-text-muted mb-1">Themes</div>
              <div className="flex flex-wrap gap-1">
                {selectedNode.themes.map(t => (
                  <span key={t} className="bg-border-subtle text-text-muted text-[10px] px-1.5 py-0.5 rounded">{t}</span>
                ))}
              </div>
            </div>
          )}
          {nodeEdges.length > 0 && (
            <div>
              <div className="text-[10px] uppercase tracking-wide text-text-muted mb-1">Edges ({nodeEdges.length})</div>
              <div className="space-y-1.5">
                {nodeEdges.map((e, i) => (
                  <div key={i} className="text-[10px] text-text-secondary">
                    <span className="text-indigo-active font-medium">
                      {e.source === selectedNode.id ? e.target : e.source}
                    </span>
                    {' · '}{e.type}{' · '}{e.strength}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 2: Create src/app/graph/page.tsx**

Create `capital-intel-dashboard/src/app/graph/page.tsx`:

```tsx
import { GraphClient } from './GraphClient'
import type { ContextResponse } from '@/types'

async function getContext(): Promise<ContextResponse> {
  const res = await fetch('http://localhost:3000/api/context', { cache: 'no-store' })
  if (!res.ok) throw new Error('Failed to load context')
  return res.json()
}

export default async function GraphPage() {
  let data: ContextResponse | null = null
  let fetchError: string | null = null

  try {
    data = await getContext()
  } catch (e) {
    fetchError = e instanceof Error ? e.message : 'Failed to load graph data'
  }

  if (fetchError || !data) {
    return (
      <div className="max-w-5xl">
        <h1 className="text-base font-bold text-text-primary mb-4">Dependency Graph</h1>
        <div className="bg-red-signal/10 border border-red-signal/20 rounded-lg p-4 text-sm text-red-signal">
          {fetchError ?? 'Failed to load data'}
        </div>
      </div>
    )
  }

  return (
    <div className="h-[calc(100vh-3rem)]">
      <h1 className="text-base font-bold text-text-primary mb-4">Dependency Graph</h1>
      <GraphClient data={data.graph} />
    </div>
  )
}
```

- [ ] **Step 3: Commit**

```bash
cd /Users/thanapold/Desktop/Projects/capital-intel-dashboard && mkdir -p src/app/graph && git add src/app/graph/GraphClient.tsx src/app/graph/page.tsx && git commit -m "feat: add dependency graph page with force-directed visualization"
```

---

## Task 9: Ask Page

**Files:**
- Create: `src/components/ChatMessage.tsx`
- Create: `src/app/ask/page.tsx`

- [ ] **Step 1: Create src/components/ChatMessage.tsx**

Create `capital-intel-dashboard/src/components/ChatMessage.tsx`:

```tsx
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

interface Props {
  role: 'user' | 'analyst'
  content: string
  streaming?: boolean
}

export function ChatMessage({ role, content, streaming }: Props) {
  if (role === 'user') {
    return (
      <div className="flex justify-end">
        <div className="bg-accent-primary/10 border border-accent-primary/20 rounded-lg px-4 py-2.5 max-w-[70%]">
          <p className="text-xs text-text-primary">{content}</p>
        </div>
      </div>
    )
  }

  return (
    <div className="flex justify-start">
      <div className="bg-bg-card border border-border-subtle rounded-lg px-4 py-3 max-w-[85%]">
        <div className="text-[10px] text-indigo-active font-semibold uppercase tracking-wide mb-2">
          Analyst {streaming && <span className="animate-pulse">·</span>}
        </div>
        <div className="prose-dark text-xs">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
        </div>
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Create src/app/ask/page.tsx**

Create `capital-intel-dashboard/src/app/ask/page.tsx`:

```tsx
'use client'

import { useEffect, useRef, useState } from 'react'
import { ChatMessage } from '@/components/ChatMessage'

interface Message {
  role: 'user' | 'analyst'
  content: string
}

export default function AskPage() {
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [streaming, setStreaming] = useState(false)
  const [currentAnswer, setCurrentAnswer] = useState('')
  const [briefingMissing, setBriefingMissing] = useState(false)
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    fetch('/api/briefing')
      .then(r => r.json())
      .then(d => { if (d.missing) setBriefingMissing(true) })
      .catch(() => {})
  }, [])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, currentAnswer])

  async function sendMessage() {
    const q = input.trim()
    if (!q || streaming) return

    setInput('')
    setMessages(prev => [...prev, { role: 'user', content: q }])
    setStreaming(true)
    setCurrentAnswer('')

    try {
      const res = await fetch('/api/ask', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: q }),
      })

      if (!res.ok) {
        const err = await res.json() as { error: string }
        setMessages(prev => [...prev, { role: 'analyst', content: `Error: ${err.error}` }])
        setStreaming(false)
        return
      }

      const reader = res.body!.getReader()
      const decoder = new TextDecoder()
      let answer = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        answer += decoder.decode(value, { stream: true })
        setCurrentAnswer(answer)
      }

      setMessages(prev => [...prev, { role: 'analyst', content: answer }])
      setCurrentAnswer('')

      // Archive the exchange
      fetch('/api/archive-qa', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: q, answer }),
      }).catch(() => {})
    } catch {
      setMessages(prev => [...prev, { role: 'analyst', content: 'Connection error. Is the server running?' }])
    } finally {
      setStreaming(false)
    }
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      sendMessage()
    }
  }

  return (
    <div className="flex flex-col h-[calc(100vh-3rem)] max-w-3xl">
      <h1 className="text-base font-bold text-text-primary mb-4 flex-shrink-0">Ask the Analyst</h1>

      {briefingMissing && (
        <div className="bg-amber-signal/10 border border-amber-signal/20 rounded-lg p-3 text-xs text-amber-signal mb-4 flex-shrink-0">
          Ask requires today's briefing — run{' '}
          <code className="bg-border-subtle px-1 rounded">npm run brief</code> first.
        </div>
      )}

      {/* Message list */}
      <div className="flex-1 overflow-y-auto space-y-4 mb-4 pr-1">
        {messages.length === 0 && !streaming && (
          <div className="text-center text-text-muted text-sm mt-12">
            Ask anything about today's briefing, portfolio, or market conditions.
          </div>
        )}
        {messages.map((m, i) => (
          <ChatMessage key={i} role={m.role} content={m.content} />
        ))}
        {streaming && currentAnswer && (
          <ChatMessage role="analyst" content={currentAnswer} streaming />
        )}
        {streaming && !currentAnswer && (
          <div className="flex justify-start">
            <div className="bg-bg-card border border-border-subtle rounded-lg px-4 py-3">
              <div className="flex gap-1 items-center">
                <span className="w-1.5 h-1.5 bg-indigo-active rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
                <span className="w-1.5 h-1.5 bg-indigo-active rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
                <span className="w-1.5 h-1.5 bg-indigo-active rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
              </div>
            </div>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {/* Input */}
      <div className="flex-shrink-0 flex gap-2">
        <input
          type="text"
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={streaming || briefingMissing}
          placeholder={briefingMissing ? 'Run npm run brief first' : 'Ask about today\'s briefing...'}
          className="flex-1 bg-bg-card border border-border-subtle rounded-lg px-4 py-2.5 text-xs text-text-primary placeholder-text-inactive focus:outline-none focus:border-accent-primary disabled:opacity-50"
        />
        <button
          onClick={sendMessage}
          disabled={streaming || briefingMissing || !input.trim()}
          className="bg-accent-primary text-white rounded-lg px-4 py-2.5 text-xs font-medium hover:bg-accent-primary/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          Send
        </button>
      </div>
    </div>
  )
}
```

- [ ] **Step 3: Commit**

```bash
cd /Users/thanapold/Desktop/Projects/capital-intel-dashboard && mkdir -p src/app/ask && git add src/components/ChatMessage.tsx src/app/ask/page.tsx && git commit -m "feat: add streaming ask chat page with archive-on-complete"
```

---

## Task 10: Integration Smoke Test

**Files:** No new files. Verify each page loads correctly.

- [ ] **Step 1: Start the dev server**

```bash
cd /Users/thanapold/Desktop/Projects/capital-intel-dashboard && npm run dev
```

Expected: `ready - started server on 0.0.0.0:3000, url: http://localhost:3000`

- [ ] **Step 2: Verify / redirects to /briefing**

Open `http://localhost:3000` in a browser. Should redirect to `/briefing` and show:
- Regime badge with regime name
- Confidence pill (colored appropriately)
- 3 scenario probability pills
- Full briefing Markdown rendered with dark-themed headings, tables, bold

If briefing is missing, should show the "run npm run brief" notice.

- [ ] **Step 3: Verify /portfolio**

Open `http://localhost:3000/portfolio`. Should show:
- Positions table with ticker, shares, avg cost, current price, P&L (green/red)
- 3 scenario cards in a grid (best=green top border, base=amber, disruption=red)
- Recommended actions inside each card

- [ ] **Step 4: Verify /world**

Open `http://localhost:3000/world`. Should show:
- Two side-by-side panels: Market Events and World Events
- Events sorted Critical → High → Medium → Low
- Severity badges colored appropriately

- [ ] **Step 5: Verify /graph**

Open `http://localhost:3000/graph`. Should show:
- Force-directed graph canvas with colored nodes and edges
- Clicking a node opens the detail panel on the right with ticker, company name, themes, edges
- X button closes the panel

- [ ] **Step 6: Verify /ask streaming**

Open `http://localhost:3000/ask`. Type a question and press Enter. Should show:
- Typing indicator (animated dots) while waiting
- Streamed analyst response appearing token-by-token
- Markdown rendered in the response
- Input disabled while streaming
- After completion, exchange archived to `$DATA_ROOT/investment-analyst-agents/archive/qa.jsonl`

Verify archive:

```bash
tail -1 /Users/thanapold/Desktop/Projects/investment-analyst-agents/archive/qa.jsonl
```

Expected: a valid JSON line with `date`, `timestamp`, `question`, `answer`.

- [ ] **Step 7: Verify sidebar navigation**

Click each sidebar item. The active item should have:
- Indigo text color (`#818cf8`)
- Indigo left border accent
- Darker background highlight

Inactive items should be muted (`#4b5563`).

- [ ] **Step 8: Final commit**

```bash
cd /Users/thanapold/Desktop/Projects/capital-intel-dashboard && git add -A && git status
# Should show nothing to commit (all already staged above)
# If there are any leftover files, commit them:
git commit -m "feat: complete capital-intel-dashboard MVP" || echo "nothing to commit"
```
