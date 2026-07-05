# Unified Platform Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create `unified-platform/` — a single Next.js 14 app serving Capital Intel, World Intelligence, and Creator Studio under one URL — plus a root `daily.sh` pipeline script that runs all data systems at 6:45 AM via cron.

**Architecture:** New `unified-platform/` Next.js app with a top-nav layout (Capital Intel | World Intelligence | Creator Studio). Each workspace has its own nested layout with a sidebar. Pages are migrated from `capital-intel-dashboard` and `creator-studio`; the world map is ported from `worldmaphistory_v2`. All existing projects remain untouched.

**Tech Stack:** Next.js 14 (App Router), TypeScript, Tailwind CSS, react-force-graph-2d (ssr:false), maplibre-gl + react-map-gl (ssr:false), @anthropic-ai/sdk, better-sqlite3, zustand, recharts, framer-motion, react-markdown + remark-gfm.

---

## File Map

```
unified-platform/
  src/
    app/
      layout.tsx                        ← HTML shell + top nav
      page.tsx                          ← redirect → /capital/briefing
      globals.css                       ← Tailwind directives + base styles
      capital/
        layout.tsx                      ← capital sidebar
        briefing/page.tsx
        portfolio/page.tsx
        discovery/page.tsx
        thesis/page.tsx                 ← NEW: reads thesis.db
        graph/
          page.tsx
          GraphClient.tsx               ← dynamic import (ssr:false)
        ask/page.tsx
      world/
        layout.tsx                      ← world sidebar
        intel/page.tsx                  ← market + world events panels
        map/
          page.tsx
          WorldMapClient.tsx            ← dynamic import (ssr:false)
      studio/
        layout.tsx                      ← studio sidebar
        dashboard/page.tsx
        archive/page.tsx
      api/
        briefing/route.ts
        context/route.ts
        ask/route.ts
        archive-qa/route.ts
        discovery/route.ts
        world/route.ts                  ← NEW: serves world intelligence files
        thesis/route.ts                 ← NEW: reads thesis.db via better-sqlite3
        studio/videos/route.ts
        studio/growth/route.ts
        studio/chat/route.ts
        studio/topic/route.ts
        studio/upload/route.ts
        studio/session/route.ts
    components/
      TopNav.tsx                        ← top workspace tab bar
      capital/
        CapitalSidebar.tsx
        RegimeBadge.tsx
        ScenarioCards.tsx
        ScenarioSummaryPills.tsx
        WorldEventCard.tsx
        ChatMessage.tsx
        PortfolioTable.tsx
        DiscoveryCandidateRow.tsx
      world/
        WorldSidebar.tsx
      studio/
        StudioSidebar.tsx
        (all creator-studio components migrated here)
    worldmap/                           ← worldmaphistory_v2/src/ copied verbatim
      App.tsx
      store/
      components/
      layers/
      data/
      types/
      utils/
      hooks/
    lib/
      data.ts                           ← readAnalysis, readSimulation, etc.
      thesis-db.ts                      ← NEW: reads thesis.db
      severity.ts
    types.ts
  public/
    (static assets)
  .env.local                            ← DATA_ROOT, ANTHROPIC_API_KEY
  package.json
  tailwind.config.ts
  tsconfig.json
  next.config.ts
daily.sh                                ← root-level pipeline script
logs/                                   ← gitignored, pipeline logs land here
```

---

## Task 1: Scaffold unified-platform

**Files:**
- Create: `unified-platform/package.json`
- Create: `unified-platform/tsconfig.json`
- Create: `unified-platform/next.config.ts`
- Create: `unified-platform/tailwind.config.ts`
- Create: `unified-platform/src/app/globals.css`
- Create: `unified-platform/.env.local`

- [ ] **Step 1: Initialise Next.js app**

```bash
cd /Users/thanapold/Desktop/Projects
npx create-next-app@14 unified-platform \
  --typescript --tailwind --app --no-eslint \
  --src-dir --import-alias "@/*"
```

- [ ] **Step 2: Install all dependencies**

```bash
cd unified-platform
npm install \
  react-markdown remark-gfm \
  react-force-graph-2d \
  maplibre-gl react-map-gl \
  @anthropic-ai/sdk \
  better-sqlite3 \
  zustand framer-motion recharts \
  react-simple-maps topojson-client fuse.js prop-types
npm install -D @types/better-sqlite3 @types/topojson-client @types/prop-types
```

- [ ] **Step 3: Write tailwind.config.ts**

```ts
// unified-platform/tailwind.config.ts
import type { Config } from 'tailwindcss'

const config: Config = {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        'bg-base':       '#0a0a0f',
        'bg-sidebar':    '#0d0d14',
        'bg-card':       '#111118',
        'border-subtle': '#1e1e2e',
        'accent-primary':'#6366f1',
        'accent-violet': '#8b5cf6',
        'text-primary':  '#e2e8f0',
        'text-secondary':'#c9d1d9',
        'text-muted':    '#6b7280',
        'text-inactive': '#4b5563',
        'green-signal':  '#4ade80',
        'amber-signal':  '#f59e0b',
        'red-signal':    '#f87171',
        'indigo-active': '#818cf8',
      },
    },
  },
  plugins: [],
}
export default config
```

- [ ] **Step 4: Write next.config.ts**

```ts
// unified-platform/next.config.ts
import type { NextConfig } from 'next'

const config: NextConfig = {
  webpack(cfg) {
    // maplibre-gl uses 'fs' module which doesn't exist in browser bundles
    cfg.resolve.fallback = { ...cfg.resolve.fallback, fs: false }
    return cfg
  },
}
export default config
```

- [ ] **Step 5: Write globals.css**

```css
/* unified-platform/src/app/globals.css */
@tailwind base;
@tailwind components;
@tailwind utilities;

/* maplibre-gl styles — must be global */
@import 'maplibre-gl/dist/maplibre-gl.css';

body {
  background: #0a0a0f;
  color: #e2e8f0;
}
```

- [ ] **Step 6: Write .env.local**

```
DATA_ROOT=/Users/thanapold/Desktop/Projects
ANTHROPIC_API_KEY=<your key from capital-intel-dashboard/.env.local>
```

- [ ] **Step 7: Verify app starts**

```bash
cd unified-platform && npm run dev
```
Expected: Next.js dev server starts on http://localhost:3000 with no errors.

- [ ] **Step 8: Commit**

```bash
git add unified-platform/
git commit -m "feat(unified-platform): scaffold Next.js 14 app with dark theme"
```

---

## Task 2: Root layout with top nav

**Files:**
- Create: `unified-platform/src/components/TopNav.tsx`
- Create: `unified-platform/src/app/layout.tsx`
- Create: `unified-platform/src/app/page.tsx`

- [ ] **Step 1: Write TopNav component**

```tsx
// unified-platform/src/components/TopNav.tsx
'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'

const WORKSPACES = [
  { href: '/capital/briefing', label: 'Capital Intel',       prefix: '/capital' },
  { href: '/world/intel',      label: 'World Intelligence',  prefix: '/world'   },
  { href: '/studio/dashboard', label: 'Creator Studio',      prefix: '/studio'  },
]

export function TopNav() {
  const pathname = usePathname()
  return (
    <header className="flex items-center gap-1 px-4 border-b border-border-subtle bg-bg-sidebar flex-shrink-0 h-10">
      <span className="text-xs font-bold mr-4"
        style={{ background: 'linear-gradient(90deg,#6366f1,#8b5cf6)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>
        ⬡ Intelligence Hub
      </span>
      {WORKSPACES.map(({ href, label, prefix }) => {
        const active = pathname.startsWith(prefix)
        return (
          <Link key={href} href={href}
            className={`px-3 py-1 text-xs rounded transition-colors ${
              active
                ? 'bg-border-subtle text-text-primary font-medium'
                : 'text-text-inactive hover:text-text-muted'
            }`}>
            {label}
          </Link>
        )
      })}
    </header>
  )
}
```

- [ ] **Step 2: Write root layout**

```tsx
// unified-platform/src/app/layout.tsx
import type { Metadata } from 'next'
import './globals.css'
import { TopNav } from '@/components/TopNav'

export const metadata: Metadata = { title: 'Intelligence Hub' }

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="flex flex-col h-screen overflow-hidden bg-bg-base text-text-primary"
        style={{ fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" }}>
        <TopNav />
        <div className="flex-1 overflow-hidden">
          {children}
        </div>
      </body>
    </html>
  )
}
```

- [ ] **Step 3: Write root page (redirect)**

```tsx
// unified-platform/src/app/page.tsx
import { redirect } from 'next/navigation'
export default function Home() { redirect('/capital/briefing') }
```

- [ ] **Step 4: Verify top nav renders**

```bash
npm run dev
```
Open http://localhost:3000 — should redirect to /capital/briefing and show the top nav bar with three workspace links.

- [ ] **Step 5: Commit**

```bash
git add unified-platform/src/
git commit -m "feat(unified-platform): add root layout with top nav"
```

---

## Task 3: Copy lib, types, and shared components

**Files:**
- Create: `unified-platform/src/lib/data.ts`
- Create: `unified-platform/src/lib/severity.ts`
- Create: `unified-platform/src/types.ts`
- Create: `unified-platform/src/components/capital/` (all components)

- [ ] **Step 1: Copy lib and types verbatim**

```bash
cp /Users/thanapold/Desktop/Projects/capital-intel-dashboard/src/lib/data.ts \
   /Users/thanapold/Desktop/Projects/unified-platform/src/lib/data.ts

cp /Users/thanapold/Desktop/Projects/capital-intel-dashboard/src/lib/severity.ts \
   /Users/thanapold/Desktop/Projects/unified-platform/src/lib/severity.ts

cp /Users/thanapold/Desktop/Projects/capital-intel-dashboard/src/types.ts \
   /Users/thanapold/Desktop/Projects/unified-platform/src/types.ts

mkdir -p /Users/thanapold/Desktop/Projects/unified-platform/src/components/capital
```

- [ ] **Step 2: Copy all capital components verbatim**

```bash
for f in RegimeBadge ScenarioCards ScenarioSummaryPills WorldEventCard ChatMessage PortfolioTable DiscoveryCandidateRow Sidebar; do
  cp /Users/thanapold/Desktop/Projects/capital-intel-dashboard/src/components/${f}.tsx \
     /Users/thanapold/Desktop/Projects/unified-platform/src/components/capital/${f}.tsx
done
```

- [ ] **Step 3: Rename Sidebar to CapitalSidebar and update its nav hrefs**

Edit `unified-platform/src/components/capital/Sidebar.tsx`. Change nav href values from `/briefing` → `/capital/briefing`, `/portfolio` → `/capital/portfolio`, etc.:

```tsx
// unified-platform/src/components/capital/Sidebar.tsx
'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'

const NAV = [
  { href: '/capital/briefing',  icon: '📋', label: 'Briefing'  },
  { href: '/capital/portfolio', icon: '💼', label: 'Portfolio' },
  { href: '/capital/discovery', icon: '✦',  label: 'Discovery' },
  { href: '/capital/thesis',    icon: '🧠', label: 'Thesis'    },
  { href: '/capital/graph',     icon: '🕸', label: 'Graph'     },
  { href: '/capital/ask',       icon: '💬', label: 'Ask'       },
]

export function Sidebar() {
  const pathname = usePathname()
  const today = new Date().toISOString().split('T')[0]

  return (
    <aside className="w-44 flex-shrink-0 bg-bg-sidebar border-r border-border-subtle flex flex-col">
      <div className="px-4 py-4 border-b border-border-subtle">
        <div className="text-sm font-bold"
          style={{ background: 'linear-gradient(90deg,#6366f1,#8b5cf6)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>
          Capital Intel
        </div>
        <div className="text-[10px] text-text-inactive mt-0.5">{today}</div>
      </div>
      <nav className="flex-1 px-2 py-3 space-y-0.5">
        {NAV.map(({ href, icon, label }) => {
          const active = pathname === href || pathname.startsWith(href + '/')
          return (
            <Link key={href} href={href}
              className={`flex items-center gap-1.5 px-2.5 py-2 rounded text-xs transition-colors ${
                active
                  ? 'bg-border-subtle text-indigo-active border-l-2 border-accent-primary'
                  : 'text-text-inactive hover:text-text-muted'
              }`}>
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

- [ ] **Step 4: Verify TypeScript compiles**

```bash
cd unified-platform && npx tsc --noEmit
```
Expected: no errors (or only errors from pages not yet created — those are fine).

- [ ] **Step 5: Commit**

```bash
git add unified-platform/src/
git commit -m "feat(unified-platform): copy lib, types, capital components"
```

---

## Task 4: Capital workspace layout + API routes

**Files:**
- Create: `unified-platform/src/app/capital/layout.tsx`
- Create: `unified-platform/src/app/api/briefing/route.ts`
- Create: `unified-platform/src/app/api/context/route.ts`
- Create: `unified-platform/src/app/api/ask/route.ts`
- Create: `unified-platform/src/app/api/archive-qa/route.ts`
- Create: `unified-platform/src/app/api/discovery/route.ts`

- [ ] **Step 1: Write capital layout**

```tsx
// unified-platform/src/app/capital/layout.tsx
import { Sidebar } from '@/components/capital/Sidebar'

export default function CapitalLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full">
      <Sidebar />
      <main className="flex-1 overflow-y-auto p-6">
        {children}
      </main>
    </div>
  )
}
```

- [ ] **Step 2: Copy API routes verbatim**

```bash
mkdir -p /Users/thanapold/Desktop/Projects/unified-platform/src/app/api/{briefing,context,ask,archive-qa,discovery}

for route in briefing context ask archive-qa discovery; do
  cp /Users/thanapold/Desktop/Projects/capital-intel-dashboard/src/app/api/${route}/route.ts \
     /Users/thanapold/Desktop/Projects/unified-platform/src/app/api/${route}/route.ts
done
```

- [ ] **Step 3: Verify dev server loads without route errors**

```bash
npm run dev
```
Open http://localhost:3000/api/context — should return JSON (or a 500 with a clear DATA_ROOT error if data files don't exist yet, which is fine).

- [ ] **Step 4: Commit**

```bash
git add unified-platform/src/app/capital/ unified-platform/src/app/api/
git commit -m "feat(unified-platform): capital layout and API routes"
```

---

## Task 5: Capital pages

**Files:**
- Create: `unified-platform/src/app/capital/briefing/page.tsx`
- Create: `unified-platform/src/app/capital/portfolio/page.tsx`
- Create: `unified-platform/src/app/capital/discovery/page.tsx`
- Create: `unified-platform/src/app/capital/graph/page.tsx`
- Create: `unified-platform/src/app/capital/graph/GraphClient.tsx`
- Create: `unified-platform/src/app/capital/ask/page.tsx`

- [ ] **Step 1: Copy pages and graph client verbatim, adjusting import paths**

```bash
mkdir -p /Users/thanapold/Desktop/Projects/unified-platform/src/app/capital/{briefing,portfolio,discovery,graph,ask}

for page in briefing portfolio discovery ask; do
  cp /Users/thanapold/Desktop/Projects/capital-intel-dashboard/src/app/${page}/page.tsx \
     /Users/thanapold/Desktop/Projects/unified-platform/src/app/capital/${page}/page.tsx
done

cp /Users/thanapold/Desktop/Projects/capital-intel-dashboard/src/app/graph/page.tsx \
   /Users/thanapold/Desktop/Projects/unified-platform/src/app/capital/graph/page.tsx

cp /Users/thanapold/Desktop/Projects/capital-intel-dashboard/src/app/graph/GraphClient.tsx \
   /Users/thanapold/Desktop/Projects/unified-platform/src/app/capital/graph/GraphClient.tsx
```

- [ ] **Step 2: Fix fetch URLs in pages that call localhost**

Search each copied page for `localhost:3000`. Replace with relative fetch paths or direct lib/data.ts calls. Server components should call lib functions directly, not fetch. 

For any page using `fetch('http://localhost:3000/api/context', ...)`, replace with direct imports:

```tsx
// Example fix pattern — apply to each affected page
import { readSimulation, readAnalysis } from '@/lib/data'

// Instead of: const res = await fetch('http://localhost:3000/api/context')
// Do:
const simulation = readSimulation()
const analysis = readAnalysis()
```

- [ ] **Step 3: Fix component import paths**

In each copied page, update imports from `@/components/Foo` → `@/components/capital/Foo`.

Example: `import { RegimeBadge } from '@/components/RegimeBadge'` → `import { RegimeBadge } from '@/components/capital/RegimeBadge'`

Run find-replace across all copied pages:
```bash
cd unified-platform
sed -i '' "s|from '@/components/|from '@/components/capital/|g" \
  src/app/capital/briefing/page.tsx \
  src/app/capital/portfolio/page.tsx \
  src/app/capital/discovery/page.tsx \
  src/app/capital/graph/page.tsx \
  src/app/capital/graph/GraphClient.tsx \
  src/app/capital/ask/page.tsx
```

- [ ] **Step 4: Verify Capital workspace end-to-end**

```bash
npm run dev
```
Open http://localhost:3000/capital/briefing — briefing page should load (or show "No briefing for today" if briefing file doesn't exist). Check /capital/portfolio, /capital/discovery, /capital/graph, /capital/ask. All should render without console errors.

- [ ] **Step 5: Commit**

```bash
git add unified-platform/src/app/capital/
git commit -m "feat(unified-platform): capital pages migrated from capital-intel-dashboard"
```

---

## Task 6: Thesis page + API route

**Files:**
- Create: `unified-platform/src/lib/thesis-db.ts`
- Create: `unified-platform/src/app/api/thesis/route.ts`
- Create: `unified-platform/src/app/capital/thesis/page.tsx`

- [ ] **Step 1: Write thesis-db.ts**

```ts
// unified-platform/src/lib/thesis-db.ts
import Database from 'better-sqlite3'
import path from 'path'

function dataRoot(): string {
  const root = process.env.DATA_ROOT
  if (!root) throw new Error('DATA_ROOT env var is not set')
  return root
}

export interface ThesisRow {
  id: string
  ticker: string
  type: 'company' | 'theme'
  positionSize: 'core' | 'satellite' | 'watchlist' | 'none'
  updatedAt: string
}

export interface AssumptionRow {
  id: string
  thesisId: string
  label: string
  status: 'strengthening' | 'stable' | 'weakening' | 'broken'
  lastEvidenceSummary: string | null
  updatedAt: string
}

export function readTheses(): { theses: ThesisRow[]; assumptions: AssumptionRow[] } {
  const dbPath = path.join(dataRoot(), 'thesis-memory/data/thesis.db')
  const db = new Database(dbPath, { readonly: true })
  try {
    const theses = db.prepare('SELECT id, ticker, type, positionSize, updatedAt FROM theses ORDER BY updatedAt DESC').all() as ThesisRow[]
    const assumptions = db.prepare('SELECT id, thesisId, label, status, lastEvidenceSummary, updatedAt FROM assumptions ORDER BY updatedAt DESC').all() as AssumptionRow[]
    return { theses, assumptions }
  } finally {
    db.close()
  }
}
```

- [ ] **Step 2: Write thesis API route**

```ts
// unified-platform/src/app/api/thesis/route.ts
export const dynamic = 'force-dynamic'

import { NextResponse } from 'next/server'
import { readTheses } from '@/lib/thesis-db'

export async function GET() {
  try {
    const data = readTheses()
    return NextResponse.json(data)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
```

- [ ] **Step 3: Write thesis page**

```tsx
// unified-platform/src/app/capital/thesis/page.tsx
import type { ThesisRow, AssumptionRow } from '@/lib/thesis-db'
import { readTheses } from '@/lib/thesis-db'

const STATUS_COLOR: Record<string, string> = {
  strengthening: 'text-green-signal',
  stable:        'text-text-muted',
  weakening:     'text-amber-signal',
  broken:        'text-red-signal',
}

export default function ThesisPage() {
  let data: { theses: ThesisRow[]; assumptions: AssumptionRow[] } | null = null
  let error: string | null = null

  try {
    data = readTheses()
  } catch (e) {
    error = e instanceof Error ? e.message : 'Failed to load thesis data'
  }

  if (error || !data) {
    return (
      <div className="max-w-3xl">
        <h1 className="text-base font-bold text-text-primary mb-4">Thesis Memory</h1>
        <div className="bg-red-signal/10 border border-red-signal/20 rounded-lg p-4 text-sm text-red-signal">
          {error ?? 'No thesis data'} — run <code className="font-mono">npm run thesis</code> in thesis-memory to create your first thesis.
        </div>
      </div>
    )
  }

  const assumptionsByThesis = data.assumptions.reduce<Record<string, AssumptionRow[]>>((acc, a) => {
    ;(acc[a.thesisId] ??= []).push(a)
    return acc
  }, {})

  return (
    <div className="max-w-3xl space-y-4">
      <h1 className="text-base font-bold text-text-primary">Thesis Memory</h1>
      {data.theses.length === 0 && (
        <p className="text-sm text-text-muted">No theses yet — run <code className="font-mono">npm run thesis</code> in thesis-memory.</p>
      )}
      {data.theses.map(thesis => {
        const assumptions = assumptionsByThesis[thesis.id] ?? []
        return (
          <div key={thesis.id} className="bg-bg-card border border-border-subtle rounded-lg p-4">
            <div className="flex items-center gap-3 mb-3">
              <span className="text-sm font-bold text-text-primary">{thesis.ticker}</span>
              <span className="text-[10px] uppercase tracking-widest text-text-inactive">{thesis.type}</span>
              <span className="text-[10px] uppercase tracking-widest text-indigo-active">{thesis.positionSize}</span>
              <span className="ml-auto text-[10px] text-text-inactive">{thesis.updatedAt.slice(0, 10)}</span>
            </div>
            {assumptions.length === 0 && <p className="text-xs text-text-inactive">No assumptions recorded.</p>}
            <div className="space-y-2">
              {assumptions.map(a => (
                <div key={a.id} className="flex flex-col gap-0.5">
                  <div className="flex items-center gap-2">
                    <span className={`text-xs font-medium ${STATUS_COLOR[a.status] ?? 'text-text-muted'}`}>
                      {a.status}
                    </span>
                    <span className="text-xs text-text-secondary">{a.label}</span>
                  </div>
                  {a.lastEvidenceSummary && (
                    <p className="text-[11px] text-text-inactive pl-0">{a.lastEvidenceSummary}</p>
                  )}
                </div>
              ))}
            </div>
          </div>
        )
      })}
    </div>
  )
}
```

- [ ] **Step 4: Verify thesis page loads**

```bash
npm run dev
```
Open http://localhost:3000/capital/thesis — should show thesis cards or the "No theses yet" message. No console errors.

- [ ] **Step 5: Commit**

```bash
git add unified-platform/src/lib/thesis-db.ts unified-platform/src/app/api/thesis/ unified-platform/src/app/capital/thesis/
git commit -m "feat(unified-platform): thesis page reads thesis-memory SQLite DB"
```

---

## Task 7: World Intelligence workspace

**Files:**
- Create: `unified-platform/src/components/world/WorldSidebar.tsx`
- Create: `unified-platform/src/app/world/layout.tsx`
- Create: `unified-platform/src/app/api/world/route.ts`
- Create: `unified-platform/src/app/world/intel/page.tsx`

- [ ] **Step 1: Write WorldSidebar**

```tsx
// unified-platform/src/components/world/WorldSidebar.tsx
'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'

const NAV = [
  { href: '/world/intel', icon: '🌐', label: 'World Intel' },
  { href: '/world/map',   icon: '🗺', label: 'World Map'  },
]

export function WorldSidebar() {
  const pathname = usePathname()
  return (
    <aside className="w-44 flex-shrink-0 bg-bg-sidebar border-r border-border-subtle flex flex-col">
      <div className="px-4 py-4 border-b border-border-subtle">
        <div className="text-sm font-bold"
          style={{ background: 'linear-gradient(90deg,#8b5cf6,#6366f1)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>
          World Intel
        </div>
      </div>
      <nav className="flex-1 px-2 py-3 space-y-0.5">
        {NAV.map(({ href, icon, label }) => {
          const active = pathname === href || pathname.startsWith(href + '/')
          return (
            <Link key={href} href={href}
              className={`flex items-center gap-1.5 px-2.5 py-2 rounded text-xs transition-colors ${
                active
                  ? 'bg-border-subtle text-indigo-active border-l-2 border-accent-violet'
                  : 'text-text-inactive hover:text-text-muted'
              }`}>
              <span>{icon}</span>
              <span className={active ? 'font-medium' : ''}>{label}</span>
            </Link>
          )
        })}
      </nav>
    </aside>
  )
}
```

- [ ] **Step 2: Write world layout**

```tsx
// unified-platform/src/app/world/layout.tsx
import { WorldSidebar } from '@/components/world/WorldSidebar'

export default function WorldLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full">
      <WorldSidebar />
      <main className="flex-1 overflow-y-auto p-6">{children}</main>
    </div>
  )
}
```

- [ ] **Step 3: Write world API route**

```ts
// unified-platform/src/app/api/world/route.ts
export const dynamic = 'force-dynamic'

import { NextResponse } from 'next/server'
import { readStockIntel, readWorldIntel } from '@/lib/data'

export async function GET() {
  try {
    const stockIntel = readStockIntel()
    const worldIntel = readWorldIntel()
    return NextResponse.json({ stockIntel, worldIntel })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
```

- [ ] **Step 4: Write world intel page**

```tsx
// unified-platform/src/app/world/intel/page.tsx
import { readStockIntel, readWorldIntel } from '@/lib/data'
import { StockEventCard, WorldEventCard } from '@/components/capital/WorldEventCard'
import type { StockEvent, WorldEvent } from '@/types'

function sortBySeverity<T extends { severity: number }>(events: T[]): T[] {
  return [...events].sort((a, b) => b.severity - a.severity)
}

export default function WorldIntelPage() {
  let stockEvents: StockEvent[] = []
  let worldEvents: WorldEvent[] = []
  let error: string | null = null

  try {
    stockEvents = sortBySeverity(readStockIntel().marketEvents ?? [])
    worldEvents = sortBySeverity(readWorldIntel().events ?? [])
  } catch (e) {
    error = e instanceof Error ? e.message : 'Failed to load world intel'
  }

  if (error) {
    return (
      <div className="max-w-5xl">
        <h1 className="text-base font-bold text-text-primary mb-4">World Intel</h1>
        <div className="bg-red-signal/10 border border-red-signal/20 rounded-lg p-4 text-sm text-red-signal">{error}</div>
      </div>
    )
  }

  return (
    <div className="max-w-5xl">
      <h1 className="text-base font-bold text-text-primary mb-4">World Intel</h1>
      <div className="grid grid-cols-2 gap-6">
        <div>
          <h2 className="text-xs uppercase tracking-widest text-text-inactive mb-3">Market Events</h2>
          {stockEvents.length === 0
            ? <p className="text-sm text-text-muted">No market events recorded.</p>
            : stockEvents.map((e, i) => <StockEventCard key={i} event={e} />)}
        </div>
        <div>
          <h2 className="text-xs uppercase tracking-widest text-text-inactive mb-3">World Events</h2>
          {worldEvents.length === 0
            ? <p className="text-sm text-text-muted">No world events recorded.</p>
            : worldEvents.map((e, i) => <WorldEventCard key={i} event={e} />)}
        </div>
      </div>
    </div>
  )
}
```

- [ ] **Step 5: Verify world intel page loads**

```bash
npm run dev
```
Open http://localhost:3000/world/intel — should show two panels or empty state. No errors.

- [ ] **Step 6: Commit**

```bash
git add unified-platform/src/components/world/ unified-platform/src/app/world/ unified-platform/src/app/api/world/
git commit -m "feat(unified-platform): world intelligence workspace — intel page"
```

---

## Task 8: World Map migration

**Files:**
- Create: `unified-platform/src/worldmap/` (copied from worldmaphistory_v2/src/)
- Create: `unified-platform/src/app/world/map/WorldMapClient.tsx`
- Create: `unified-platform/src/app/world/map/page.tsx`

- [ ] **Step 1: Copy worldmap source directory**

```bash
cp -r /Users/thanapold/Desktop/Projects/worldmaphistory_v2/src/ \
      /Users/thanapold/Desktop/Projects/unified-platform/src/worldmap/
```

- [ ] **Step 2: Write WorldMapClient (wraps the Vite App component)**

```tsx
// unified-platform/src/app/world/map/WorldMapClient.tsx
'use client'

import App from '@/worldmap/App'
import '@/worldmap/index.css'

export default function WorldMapClient() {
  return (
    <div style={{ width: '100%', height: 'calc(100vh - 40px)' }}>
      <App />
    </div>
  )
}
```

- [ ] **Step 3: Write world map page with dynamic import**

```tsx
// unified-platform/src/app/world/map/page.tsx
import dynamic from 'next/dynamic'

const WorldMapClient = dynamic(() => import('./WorldMapClient'), { ssr: false })

export default function WorldMapPage() {
  return <WorldMapClient />
}
```

- [ ] **Step 4: Copy worldmap CSS if it exists**

```bash
# Check if index.css exists in worldmaphistory_v2/src/
ls /Users/thanapold/Desktop/Projects/worldmaphistory_v2/src/index.css 2>/dev/null && \
  cp /Users/thanapold/Desktop/Projects/worldmaphistory_v2/src/index.css \
     /Users/thanapold/Desktop/Projects/unified-platform/src/worldmap/index.css || \
  touch /Users/thanapold/Desktop/Projects/unified-platform/src/worldmap/index.css
```

- [ ] **Step 5: Fix Vite-specific import patterns that break in Next.js**

Vite allows importing JSON files directly. In Next.js with App Router these should work too, but check for any `import data from './data/foo.json'` with `.json` imports missing the `assert { type: 'json' }`. Run:

```bash
cd unified-platform && npx tsc --noEmit 2>&1 | grep worldmap | head -30
```

Fix any TypeScript errors in worldmap files. Common issues:
- `import maplibregl from 'maplibre-gl'` — works as-is in Next.js
- `process.env.VITE_*` env vars — replace with `process.env.NEXT_PUBLIC_*` or hardcoded values

- [ ] **Step 6: Verify world map page loads**

```bash
npm run dev
```
Open http://localhost:3000/world/map — the map should render (may take a moment for WebGL to initialize). No SSR errors.

- [ ] **Step 7: Commit**

```bash
git add unified-platform/src/worldmap/ unified-platform/src/app/world/map/
git commit -m "feat(unified-platform): world map migrated from worldmaphistory_v2"
```

---

## Task 9: Creator Studio workspace

**Files:**
- Create: `unified-platform/src/components/studio/StudioSidebar.tsx`
- Create: `unified-platform/src/components/studio/` (all creator-studio components)
- Create: `unified-platform/src/app/studio/layout.tsx`
- Create: `unified-platform/src/app/studio/dashboard/page.tsx`
- Create: `unified-platform/src/app/studio/archive/page.tsx`
- Create: `unified-platform/src/app/api/studio/` (all creator-studio API routes)

- [ ] **Step 1: Copy studio components**

```bash
mkdir -p /Users/thanapold/Desktop/Projects/unified-platform/src/components/studio
cp -r /Users/thanapold/Desktop/Projects/creator-studio/components/. \
      /Users/thanapold/Desktop/Projects/unified-platform/src/components/studio/
```

- [ ] **Step 2: Write StudioSidebar**

```tsx
// unified-platform/src/components/studio/StudioSidebar.tsx
'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'

const NAV = [
  { href: '/studio/dashboard', icon: '📊', label: 'Dashboard' },
  { href: '/studio/archive',   icon: '🗂',  label: 'Archive'   },
]

export function StudioSidebar() {
  const pathname = usePathname()
  return (
    <aside className="w-44 flex-shrink-0 bg-bg-sidebar border-r border-border-subtle flex flex-col">
      <div className="px-4 py-4 border-b border-border-subtle">
        <div className="text-sm font-bold"
          style={{ background: 'linear-gradient(90deg,#f59e0b,#f97316)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>
          Creator Studio
        </div>
      </div>
      <nav className="flex-1 px-2 py-3 space-y-0.5">
        {NAV.map(({ href, icon, label }) => {
          const active = pathname === href || pathname.startsWith(href + '/')
          return (
            <Link key={href} href={href}
              className={`flex items-center gap-1.5 px-2.5 py-2 rounded text-xs transition-colors ${
                active
                  ? 'bg-border-subtle text-amber-signal border-l-2 border-amber-signal'
                  : 'text-text-inactive hover:text-text-muted'
              }`}>
              <span>{icon}</span>
              <span className={active ? 'font-medium' : ''}>{label}</span>
            </Link>
          )
        })}
      </nav>
    </aside>
  )
}
```

- [ ] **Step 3: Write studio layout**

```tsx
// unified-platform/src/app/studio/layout.tsx
import { StudioSidebar } from '@/components/studio/StudioSidebar'

export default function StudioLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full">
      <StudioSidebar />
      <main className="flex-1 overflow-y-auto p-6">{children}</main>
    </div>
  )
}
```

- [ ] **Step 4: Copy studio pages and fix component import paths**

```bash
mkdir -p /Users/thanapold/Desktop/Projects/unified-platform/src/app/studio/{dashboard,archive}

cp /Users/thanapold/Desktop/Projects/creator-studio/app/dashboard/page.tsx \
   /Users/thanapold/Desktop/Projects/unified-platform/src/app/studio/dashboard/page.tsx

cp /Users/thanapold/Desktop/Projects/creator-studio/app/archive/page.tsx \
   /Users/thanapold/Desktop/Projects/unified-platform/src/app/studio/archive/page.tsx
```

Update component imports in both copied pages from `@/components/` → `@/components/studio/`:

```bash
sed -i '' "s|from '@/components/|from '@/components/studio/|g" \
  /Users/thanapold/Desktop/Projects/unified-platform/src/app/studio/dashboard/page.tsx \
  /Users/thanapold/Desktop/Projects/unified-platform/src/app/studio/archive/page.tsx
```

- [ ] **Step 4b: Copy creator-studio lib directory if it exists**

```bash
if [ -d /Users/thanapold/Desktop/Projects/creator-studio/lib ]; then
  mkdir -p /Users/thanapold/Desktop/Projects/unified-platform/src/lib/studio
  cp -r /Users/thanapold/Desktop/Projects/creator-studio/lib/. \
        /Users/thanapold/Desktop/Projects/unified-platform/src/lib/studio/
  # Then update imports in studio pages: from '@/lib/' → '@/lib/studio/'
fi
```

- [ ] **Step 5: Copy studio API routes**

```bash
mkdir -p /Users/thanapold/Desktop/Projects/unified-platform/src/app/api/studio/{chat,growth,session,topic,upload,videos,visuals/card,visuals/chart,visuals/illustration}

for route in chat session topic upload videos; do
  cp /Users/thanapold/Desktop/Projects/creator-studio/app/api/${route}/route.ts \
     /Users/thanapold/Desktop/Projects/unified-platform/src/app/api/studio/${route}/route.ts
done

cp /Users/thanapold/Desktop/Projects/creator-studio/app/api/growth/route.ts \
   /Users/thanapold/Desktop/Projects/unified-platform/src/app/api/studio/growth/route.ts
cp /Users/thanapold/Desktop/Projects/creator-studio/app/api/growth/manual/route.ts \
   /Users/thanapold/Desktop/Projects/unified-platform/src/app/api/studio/growth/manual/route.ts
cp /Users/thanapold/Desktop/Projects/creator-studio/app/api/growth/sync/route.ts \
   /Users/thanapold/Desktop/Projects/unified-platform/src/app/api/studio/growth/sync/route.ts

for vis in card chart illustration; do
  cp /Users/thanapold/Desktop/Projects/creator-studio/app/api/visuals/${vis}/route.ts \
     /Users/thanapold/Desktop/Projects/unified-platform/src/app/api/studio/visuals/${vis}/route.ts
done
```

- [ ] **Step 6: Fix API route references in studio pages**

Studio pages call `/api/chat`, `/api/videos` etc. — these paths have moved to `/api/studio/chat`, `/api/studio/videos` etc. Update all fetch paths in the studio pages:

```bash
sed -i '' \
  -e "s|/api/chat|/api/studio/chat|g" \
  -e "s|/api/videos|/api/studio/videos|g" \
  -e "s|/api/growth|/api/studio/growth|g" \
  -e "s|/api/topic|/api/studio/topic|g" \
  -e "s|/api/upload|/api/studio/upload|g" \
  -e "s|/api/session|/api/studio/session|g" \
  -e "s|/api/visuals|/api/studio/visuals|g" \
  /Users/thanapold/Desktop/Projects/unified-platform/src/app/studio/dashboard/page.tsx \
  /Users/thanapold/Desktop/Projects/unified-platform/src/app/studio/archive/page.tsx
```

- [ ] **Step 7: Verify studio workspace loads**

```bash
npm run dev
```
Open http://localhost:3000/studio/dashboard — dashboard page renders. Open /studio/archive. No console errors.

- [ ] **Step 8: Commit**

```bash
git add unified-platform/src/components/studio/ unified-platform/src/app/studio/ unified-platform/src/app/api/studio/
git commit -m "feat(unified-platform): creator studio workspace migrated"
```

---

## Task 10: Stale data badge in top nav

**Files:**
- Modify: `unified-platform/src/components/TopNav.tsx`
- Create: `unified-platform/src/app/api/status/route.ts`

- [ ] **Step 1: Write status API route**

```ts
// unified-platform/src/app/api/status/route.ts
export const dynamic = 'force-dynamic'

import { NextResponse } from 'next/server'
import fs from 'fs'
import path from 'path'

export async function GET() {
  const root = process.env.DATA_ROOT
  if (!root) return NextResponse.json({ stale: true, reason: 'DATA_ROOT not set' })

  const today = new Date().toISOString().split('T')[0]
  const briefingPath = path.join(root, `investment-analyst-agents/briefings/${today}.md`)
  const stale = !fs.existsSync(briefingPath)
  return NextResponse.json({ stale, date: today })
}
```

- [ ] **Step 2: Update TopNav to fetch status and show badge**

```tsx
// unified-platform/src/components/TopNav.tsx
'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useEffect, useState } from 'react'

const WORKSPACES = [
  { href: '/capital/briefing', label: 'Capital Intel',      prefix: '/capital' },
  { href: '/world/intel',      label: 'World Intelligence', prefix: '/world'   },
  { href: '/studio/dashboard', label: 'Creator Studio',     prefix: '/studio'  },
]

export function TopNav() {
  const pathname = usePathname()
  const [stale, setStale] = useState(false)

  useEffect(() => {
    fetch('/api/status')
      .then(r => r.json())
      .then(d => setStale(d.stale))
      .catch(() => {})
  }, [])

  return (
    <header className="flex items-center gap-1 px-4 border-b border-border-subtle bg-bg-sidebar flex-shrink-0 h-10">
      <span className="text-xs font-bold mr-4"
        style={{ background: 'linear-gradient(90deg,#6366f1,#8b5cf6)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>
        ⬡ Intelligence Hub
      </span>
      {WORKSPACES.map(({ href, label, prefix }) => {
        const active = pathname.startsWith(prefix)
        return (
          <Link key={href} href={href}
            className={`px-3 py-1 text-xs rounded transition-colors ${
              active
                ? 'bg-border-subtle text-text-primary font-medium'
                : 'text-text-inactive hover:text-text-muted'
            }`}>
            {label}
          </Link>
        )
      })}
      {stale && (
        <span className="ml-auto text-[10px] text-amber-signal border border-amber-signal/30 rounded px-2 py-0.5">
          ⚠ Stale data — run ./daily.sh
        </span>
      )}
    </header>
  )
}
```

- [ ] **Step 3: Verify badge appears/disappears**

```bash
npm run dev
```
Open http://localhost:3000 — if today's briefing doesn't exist, badge should show. Badge disappears once a briefing for today exists.

- [ ] **Step 4: Commit**

```bash
git add unified-platform/src/components/TopNav.tsx unified-platform/src/app/api/status/
git commit -m "feat(unified-platform): stale data badge in top nav"
```

---

## Task 11: daily.sh pipeline script

**Files:**
- Create: `daily.sh` (repo root)
- Create: `.gitignore` update (add `logs/`)

- [ ] **Step 1: Write daily.sh**

```bash
# /Users/thanapold/Desktop/Projects/daily.sh
#!/bin/bash
set -e

ROOT="$(cd "$(dirname "$0")" && pwd)"
mkdir -p "$ROOT/logs"
LOG="$ROOT/logs/daily-$(date +%F).log"

log() { echo "[$(date '+%H:%M:%S')] $*" | tee -a "$LOG"; }

log "=== Daily pipeline starting ==="

log "[1/8] World Intelligence — observe"
cd "$ROOT/world-intelligence-data-hub-"
npm run observe 2>&1 | tee -a "$LOG"

log "[2/8] Capital Intelligence — pipeline"
cd "$ROOT/capital-intelligence-ingestion"
npm run pipeline 2>&1 | tee -a "$LOG"

log "[3/8] AI Analysis Engine — analyze"
cd "$ROOT/ai-analysis-engine"
npm run analyze 2>&1 | tee -a "$LOG"

log "[4/8] Scenario Simulator — simulate"
cd "$ROOT/scenario-simulator"
npm run simulate 2>&1 | tee -a "$LOG"

log "[5/8] Scenario Simulator — discover"
npm run discover 2>&1 | tee -a "$LOG"

log "[6/8] Dependency Graph — scan + export"
cd "$ROOT/dependency-graph-engine"
npm run scan 2>&1 | tee -a "$LOG"
npm run export 2>&1 | tee -a "$LOG"

log "[7/8] Thesis Memory — update"
cd "$ROOT/thesis-memory"
npm run update 2>&1 | tee -a "$LOG"

log "[8/8] Investment Analyst — brief"
cd "$ROOT/investment-analyst-agents"
npm run brief 2>&1 | tee -a "$LOG"

log "=== Daily pipeline complete ==="
```

- [ ] **Step 2: Make executable**

```bash
chmod +x /Users/thanapold/Desktop/Projects/daily.sh
```

- [ ] **Step 3: Add logs/ to root .gitignore**

Edit the root `.gitignore` to add:
```
logs/
```

- [ ] **Step 4: Test the script runs (dry sanity check)**

```bash
cd /Users/thanapold/Desktop/Projects
bash -n daily.sh
```
Expected: no output (bash -n checks syntax without executing).

- [ ] **Step 5: Commit**

```bash
git add daily.sh .gitignore
git commit -m "feat: add daily.sh pipeline script — runs all 8 systems in order"
```

---

## Task 12: Register cron + final verification

**Files:** No files — system configuration only.

- [ ] **Step 1: Register cron job**

```bash
crontab -e
```

Add this line (save and exit):
```
45 6 * * * /Users/thanapold/Desktop/Projects/daily.sh >> /Users/thanapold/Desktop/Projects/logs/daily-cron.log 2>&1
```

- [ ] **Step 2: Verify cron is registered**

```bash
crontab -l | grep daily.sh
```
Expected: the line above appears.

- [ ] **Step 3: Full end-to-end verification**

```bash
# Start the unified platform
cd /Users/thanapold/Desktop/Projects/unified-platform
npm run dev
```

Check all 8 pages load without errors:
- http://localhost:3000/capital/briefing
- http://localhost:3000/capital/portfolio
- http://localhost:3000/capital/discovery
- http://localhost:3000/capital/thesis
- http://localhost:3000/capital/graph
- http://localhost:3000/capital/ask
- http://localhost:3000/world/intel
- http://localhost:3000/world/map
- http://localhost:3000/studio/dashboard
- http://localhost:3000/studio/archive

- [ ] **Step 4: Final commit**

```bash
git add .
git commit -m "feat: unified platform complete — all workspaces + daily.sh pipeline"
```
