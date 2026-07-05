# Capital Intel Dashboard — Design Spec

**Date:** 2026-05-26
**Project:** AI Capital Flow & Technology Intelligence System — Web Dashboard
**Status:** Approved

---

## Overview

A local-first Next.js dashboard that visualizes all upstream intelligence from the AI Capital Flow system in a single dark-premium web UI. Five sections in the sidebar: daily briefing, portfolio + scenarios, world intelligence, dependency graph, and a live Ask chat grounded in today's briefing. Designed as a personal local tool (MVP), architected to migrate to a hosted web app by swapping filesystem reads for a database/S3 layer.

---

## Architecture

```
capital-intel-dashboard/
  src/
    app/
      layout.tsx               ← root layout: sidebar + dark theme + font
      page.tsx                 ← redirect to /briefing
      briefing/
        page.tsx               ← today's briefing (Markdown + summary header)
      portfolio/
        page.tsx               ← positions table + scenario cards + actions
      world/
        page.tsx               ← world events + stock market events (two panels)
      graph/
        page.tsx               ← interactive force-directed dependency graph
      ask/
        page.tsx               ← live chat UI (streaming Q&A)
    api/
      briefing/
        route.ts               ← GET: reads briefings/YYYY-MM-DD.md
      context/
        route.ts               ← GET: reads all upstream JSON (analysis, simulation, graph, intel)
      ask/
        route.ts               ← POST: streams Claude response
      archive-qa/
        route.ts               ← POST: appends exchange to archive/qa.jsonl
    components/
      Sidebar.tsx              ← persistent left nav with 5 sections
      RegimeBadge.tsx          ← regime label + confidence pill
      ScenarioCards.tsx        ← best/base/disruption 3-column grid
      WorldEventCard.tsx       ← single event with severity badge + country tags
      ChatMessage.tsx          ← single chat bubble (user or analyst), Markdown rendered
      GraphView.tsx            ← react-force-graph-2d wrapper + node detail panel
  .env.local                   ← ANTHROPIC_API_KEY, DATA_ROOT
  package.json
  tailwind.config.ts
  tsconfig.json
  next.config.ts
```

**Reads from (read-only):**
- `$DATA_ROOT/investment-analyst-agents/briefings/YYYY-MM-DD.md`
- `$DATA_ROOT/ai-analysis-engine/data/analysis.json`
- `$DATA_ROOT/scenario-simulator/data/simulation.json`
- `$DATA_ROOT/dependency-graph-engine/data/graph.json`
- `$DATA_ROOT/world-intelligence-data-hub-/exports/stock-project/intelligence.json`
- `$DATA_ROOT/world-intelligence-data-hub-/exports/world-map/intelligence.json`
- `$DATA_ROOT/investment-analyst-agents/knowledge/profile.md` (optional)

**Writes to:**
- `$DATA_ROOT/investment-analyst-agents/archive/qa.jsonl` (via archive-qa API route)

---

## Tech Stack

| Dependency | Purpose |
|---|---|
| `next` 14 (App Router) | Framework |
| `react` + `typescript` | UI |
| `tailwindcss` | Styling (dark premium theme) |
| `react-markdown` + `remark-gfm` | Briefing + chat answer Markdown rendering |
| `react-force-graph-2d` | Dependency graph visualization |
| `@anthropic-ai/sdk` | Claude Sonnet 4.6 streaming for Ask |
| `dotenv` | `.env.local` loading in API routes |

No database. No auth. No external API calls except Claude.

---

## Theme

Deep dark background (`#0a0a0f`) with indigo/violet accents (`#6366f1`, `#8b5cf6`). Sidebar background `#0d0d14`, card background `#111118`, border `#1e1e2e`. Typography: system font stack. Color conventions:
- **Green** (`#4ade80`) — positive P&L, best scenario
- **Amber** (`#f59e0b`) — base scenario, warnings
- **Red** (`#f87171`) — negative P&L, disruption scenario, high severity
- **Indigo** (`#818cf8`) — active nav item, section headings
- **Muted** (`#6b7280`) — secondary text, inactive nav

---

## Data Flow

All data reads happen in **server-side API routes** (`route.ts` files). The browser fetches from these routes — it never reads the filesystem directly. This means hosted migration only requires changing what the route reads (filesystem → database/S3), with no frontend changes.

`.env.local` supplies:
```
ANTHROPIC_API_KEY=sk-ant-...
DATA_ROOT=/Users/thanapold/Desktop/Projects
```

Routes resolve paths as `path.join(process.env.DATA_ROOT, 'scenario-simulator/data/simulation.json')` etc.

---

## Pages

### Briefing (`/briefing`)

**Data:** `GET /api/briefing` returns `{ date, markdown, regime, confidence, scenarios[] }`

**Layout:**
- **Summary header** (always visible): regime badge + confidence pill + 3 scenario probability pills (Best N% / Base N% / Disruption N%). Pulled from `simulation.json` so the header is data-driven even before reading the full Markdown.
- **Full briefing** below: rendered with `react-markdown` + `remark-gfm`. Tables, bold, headings all styled to match the dark theme.
- **No briefing fallback:** if today's `YYYY-MM-DD.md` doesn't exist, shows a notice: `No briefing for today — run npm run brief in investment-analyst-agents`.

---

### Portfolio (`/portfolio`)

**Data:** `GET /api/context` → `simulation.json`

**Layout (two sections):**

1. **Positions table** — columns: Ticker, Shares, Avg Cost, Current Price, Unrealized P&L. P&L cell is green if positive, red if negative. If portfolio is empty, shows "No positions — add positions via scenario-simulator."

2. **Scenario cards** — 3-column grid. Each card:
   - Top border color: green (best) / amber (base) / red (disruption)
   - Label + probability (e.g. "Base · 45%")
   - Scenario title and 2-line narrative excerpt
   - Recommended actions for that scenario (from `simulation.json` actions filtered by scenarioId)

---

### World Intel (`/world`)

**Data:** `GET /api/context` → `stock-project/intelligence.json` + `world-map/intelligence.json`

**Layout:** Two panels side by side.

- **Left — Market Events** (from stock-project): each card shows title, summary, severity badge (color-coded), eventType tag, marketDirection indicator. Sorted by severity: Critical → High → Medium → Low.
- **Right — World Events** (from world-map): each card shows title, summary, severity badge, country tags, escalationPotential label. Same sort order.

If either source is empty, the panel shows "No events recorded."

---

### Graph (`/graph`)

**Data:** `GET /api/context` → `graph.json`

**Layout:** Full-width canvas with a collapsible right panel.

- **Force graph canvas** (react-force-graph-2d): loaded with `dynamic(() => import(...), { ssr: false })` since it requires `window`. Nodes are tickers, edges are dependency relationships. Node size scales with degree (number of connections). Edge thickness reflects `strength` field (strong > medium > weak). Node color is a deterministic color hash of the ticker string (consistent across renders).
- **Node detail panel** (appears on click): ticker, company name, themes list, all edges in/out with their type and strength.
- Graph is interactive: drag nodes, zoom/pan, click to inspect.

---

### Ask (`/ask`)

**Data:** `POST /api/ask` with `{ question: string }` → streaming text response

**Layout:** Chat interface.
- Message list scrolls. User messages right-aligned. Analyst responses left-aligned, rendered as Markdown.
- Input box at the bottom with a send button. Disabled while streaming.
- Typing indicator (animated dots) while the stream is in progress.
- Each completed exchange is archived to `qa.jsonl` via `POST /api/archive-qa`.

**No briefing fallback:** if today's briefing doesn't exist, the Ask input is disabled and shows: "Ask requires today's briefing — run npm run brief first."

No conversation history persists across page refreshes (MVP). Each question is single-shot.

---

## API Routes

### `GET /api/briefing`

Reads `$DATA_ROOT/investment-analyst-agents/briefings/YYYY-MM-DD.md` (today's date). Also reads `simulation.json` for scenario summary data. Returns:
```ts
{
  date: string
  markdown: string           // full briefing text
  regime: string
  confidence: string
  scenarios: Array<{ scenarioType, title, probability, timeHorizon }>
  missing: boolean           // true if no briefing for today
}
```

### `GET /api/context`

Reads all upstream JSON files. Returns them as-is merged into one object:
```ts
{
  analysis: AnalysisJSON
  simulation: SimulationJSON
  graph: GraphJSON
  stockIntel: StockIntelJSON
  worldIntel: WorldIntelJSON
}
```
Missing files return a 500 with a clear message identifying which file is absent.

### `POST /api/ask`

Body: `{ question: string }`

1. Reads today's briefing (errors with 400 if missing, message: "No briefing for today — run npm run brief")
2. Reads `simulation.json`, `graph.json`, `profile.md` (optional)
3. Calls Claude Sonnet 4.6 with `stream: true`, using the same system prompt as `qa-agent.ts`
4. Returns `Response` with `Content-Type: text/plain; charset=utf-8` streaming the text tokens

### `POST /api/archive-qa`

Body: `{ question: string, answer: string }`

Appends a single-exchange `QAEntry` to `$DATA_ROOT/investment-analyst-agents/archive/qa.jsonl` using `appendFileSync` directly (same logic as `archiveQA()` — two lines, no cross-project import needed). Returns `{ ok: true }`.

---

## Key Design Constraints

- **Local-first, hosted-ready** — all data access in API routes only; frontend is pure client-side React
- **No auth for MVP** — localhost only; add NextAuth or Clerk when hosting
- **No conversation history across refreshes** — single-shot Ask in MVP
- **Read-only siblings** — never writes to ai-analysis-engine, scenario-simulator, dependency-graph-engine, or world-intelligence-data-hub directories
- **DATA_ROOT in env** — never hardcode absolute paths in source files; always resolve from `process.env.DATA_ROOT`
- **Streaming Ask** — use native Next.js `Response` streaming (no Vercel AI SDK dependency needed for MVP)
- **No tests for MVP** — visual/interactive app; verify by running `npm run dev` and checking each page

---

## Running Locally

```bash
cd capital-intel-dashboard
npm install
# Copy .env.local and set DATA_ROOT + ANTHROPIC_API_KEY
npm run dev
# Open http://localhost:3000
```

The dashboard reads live from whatever data files exist at `DATA_ROOT`. Running `npm run brief` in `investment-analyst-agents` and then refreshing the browser shows the new briefing immediately.
