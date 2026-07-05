# Unified Platform — Design Spec

**Date:** 2026-05-27
**Project:** Unified Intelligence Platform + Daily Pipeline
**Status:** Approved

---

## Overview

Two connected goals:

1. **Unified website** — a new `unified-platform/` Next.js app that brings every sub-project (Capital Intel, World Intelligence, Creator Studio) under a single URL and a single `npm run dev`.
2. **One pipeline command** — a root-level `daily.sh` shell script that runs all data systems in order every morning at 6:45 AM via cron, so the dashboard always wakes up with fresh data.

All existing sub-projects stay intact. `unified-platform/` is a new directory that migrates pages from `capital-intel-dashboard` and `creator-studio`, adds World Intelligence pages, and reads all upstream data through the same `DATA_ROOT` env pattern already in use.

---

## Architecture

### Unified Platform (`unified-platform/`)

```
unified-platform/
  src/
    app/
      layout.tsx                  ← root layout: top nav (Capital Intel | World Intelligence | Creator Studio)
      page.tsx                    ← redirect → /capital/briefing
      capital/
        layout.tsx                ← capital sidebar (Briefing, Portfolio, Discovery, Thesis, Graph, Ask)
        briefing/page.tsx
        portfolio/page.tsx
        discovery/page.tsx
        thesis/page.tsx
        graph/page.tsx
        ask/page.tsx
      world/
        layout.tsx                ← world sidebar (World Map, World Intel)
        map/page.tsx              ← maplibre-gl world map (ssr: false)
        intel/page.tsx            ← market events + geopolitical events panels
      studio/
        layout.tsx                ← studio sidebar (Dashboard, Archive)
        dashboard/page.tsx
        archive/page.tsx
      api/
        briefing/route.ts
        context/route.ts
        ask/route.ts
        archive-qa/route.ts
        world/route.ts            ← serves stock-project + world-map intelligence.json
        studio/route.ts           ← serves creator-studio data
  .env.local                      ← DATA_ROOT, ANTHROPIC_API_KEY
  package.json
  tailwind.config.ts
  tsconfig.json
  next.config.ts
```

### Navigation

Top-level nav bar with three workspace tabs:
- **Capital Intel** — briefing, portfolio, discovery, thesis, dependency graph, Ask chat
- **World Intelligence** — interactive world map, world + market events feed
- **Creator Studio** — dashboard, archive

Each workspace has its own left sidebar. Switching workspace tabs switches both the sidebar and the page content.

### Data reads (all read-only, via API routes)

| Route | Reads from |
|---|---|
| `/api/briefing` | `$DATA_ROOT/investment-analyst-agents/briefings/YYYY-MM-DD.md` |
| `/api/context` | analysis.json, simulation.json, graph.json, discovery.json |
| `/api/ask` | briefing + simulation.json + graph.json + profile.md |
| `/api/archive-qa` | writes to investment-analyst-agents/archive/qa.jsonl |
| `/api/world` | world-intelligence-data-hub-/exports/stock-project/intelligence.json + world-map/intelligence.json |
| `/api/studio` | creator-studio data files |

### Tech stack

| Dependency | Purpose |
|---|---|
| `next` 14 (App Router) | Framework |
| `react` + `typescript` | UI |
| `tailwindcss` | Styling — same dark premium theme as capital-intel-dashboard |
| `react-markdown` + `remark-gfm` | Briefing + chat Markdown rendering |
| `react-force-graph-2d` | Dependency graph (ssr: false) |
| `maplibre-gl` + `react-map-gl` | World map (ssr: false, migrated from worldmaphistory_v2) |
| `@anthropic-ai/sdk` | Claude Sonnet 4.6 streaming for Ask |
| `recharts` | Charts in world map and studio (migrated from worldmaphistory_v2) |
| `zustand` | State for world map component (migrated from worldmaphistory_v2) |

### Theme

Same as `capital-intel-dashboard`: deep dark background (`#0a0a0f`), indigo/violet accents (`#6366f1`, `#8b5cf6`), sidebar background `#0d0d14`, card background `#111118`, border `#1e1e2e`.

---

## Daily Pipeline (`daily.sh`)

### Execution order

```bash
#!/bin/bash
set -e   # stop on first failure — no step runs on stale upstream data
ROOT="$(cd "$(dirname "$0")" && pwd)"
mkdir -p "$ROOT/logs"
LOG="$ROOT/logs/daily-$(date +%F).log"

echo "[$(date)] Starting daily pipeline" | tee -a "$LOG"

cd "$ROOT/world-intelligence-data-hub-"
npm run observe 2>&1 | tee -a "$LOG"          # 1. collect world intel

cd "$ROOT/capital-intelligence-ingestion"
npm run pipeline 2>&1 | tee -a "$LOG"         # 2. ingest news + financials

cd "$ROOT/ai-analysis-engine"
npm run analyze 2>&1 | tee -a "$LOG"          # 3. macro regime + signals

cd "$ROOT/scenario-simulator"
npm run simulate 2>&1 | tee -a "$LOG"         # 4. best/base/disruption scenarios
npm run discover 2>&1 | tee -a "$LOG"         # 5. discover + score new tickers

cd "$ROOT/dependency-graph-engine"
npm run scan 2>&1 | tee -a "$LOG"             # 6a. scan AI stack
npm run export 2>&1 | tee -a "$LOG"           # 6b. export graph.json

cd "$ROOT/thesis-memory"
npm run update 2>&1 | tee -a "$LOG"           # 7. refresh conviction tracking

cd "$ROOT/investment-analyst-agents"
npm run brief 2>&1 | tee -a "$LOG"            # 8. Claude generates daily briefing

echo "[$(date)] ✓ Daily pipeline complete" | tee -a "$LOG"
```

### Error handling

`set -e` stops execution immediately on any non-zero exit code. If step 2 (ingestion) fails, steps 3–8 do not run — they would otherwise operate on yesterday's stale data. The log captures stdout and stderr for every step.

### Cron setup (one-time)

```bash
crontab -e
# Add:
45 6 * * * /Users/thanapold/Desktop/Projects/daily.sh >> /Users/thanapold/Desktop/Projects/logs/daily-cron.log 2>&1
```

Runs at 6:45 AM every day. Can also be triggered manually at any time: `./daily.sh`.

### Stale data indicator

The dashboard shows a `⚠ Stale data` badge in the top nav if today's briefing file (`briefings/YYYY-MM-DD.md`) does not exist when the page is opened — meaning the pipeline has not run yet today or failed at step 8.

---

## Migration Plan

### Phase 1 — Scaffold + Capital workspace

1. Create `unified-platform/` — Next.js 14, Tailwind, dark theme, `.env.local`
2. Add root `layout.tsx` with top-nav (Capital Intel | World Intelligence | Creator Studio)
3. Copy all pages from `capital-intel-dashboard/src/app/` → `unified-platform/src/app/capital/`
4. Copy all API routes from `capital-intel-dashboard/src/app/api/` → `unified-platform/src/app/api/`
5. Copy shared components (Sidebar, RegimeBadge, ScenarioCards, etc.)
6. Verify Capital workspace works end-to-end (`npm run dev`, open `/capital/briefing`)

### Phase 2 — World Intelligence workspace

1. Add `src/app/world/intel/page.tsx` — two-panel layout (market events left, world events right), reads `/api/world`
2. Add `api/world/route.ts` — serves both `intelligence.json` files from `world-intelligence-data-hub-/exports/`
3. Migrate `worldmaphistory_v2` map component to `src/app/world/map/`
4. Wrap maplibre-gl entry with `dynamic(() => import(...), { ssr: false })` to handle WebGL SSR constraint

### Phase 3 — Creator Studio workspace

1. Copy `creator-studio/app/dashboard/page.tsx` → `src/app/studio/dashboard/page.tsx`
2. Copy `creator-studio/app/archive/page.tsx` → `src/app/studio/archive/page.tsx`
3. Copy any API routes and components from creator-studio
4. Add `src/app/studio/layout.tsx` with studio sidebar

### Phase 4 — Pipeline

1. Write `daily.sh` at repo root (full script as above)
2. `chmod +x daily.sh`
3. Create `logs/` directory, add `logs/` to root `.gitignore`
4. Register cron entry at 6:45 AM

---

## What happens to existing projects

All existing projects are **kept as-is**. Nothing is deleted or broken:

- `capital-intel-dashboard` — remains runnable on port 3001; serves as the migration source of truth
- `creator-studio` — remains runnable standalone; pages are copied (not moved) into unified-platform
- `worldmaphistory_v2` — Vite app kept as reference; map component migrated into world/map/
- All backend projects (`capital-intelligence-ingestion`, `ai-analysis-engine`, etc.) — unchanged; `daily.sh` calls their existing npm scripts

---

## Running locally

```bash
# Start unified platform
cd unified-platform
npm install
# Set DATA_ROOT and ANTHROPIC_API_KEY in .env.local
npm run dev
# Open http://localhost:3000

# Run pipeline manually
./daily.sh
```

---

## Key design constraints

- **DATA_ROOT in env** — never hardcode absolute paths; always resolve via `process.env.DATA_ROOT`
- **SSR disabled for map + graph** — maplibre-gl and react-force-graph-2d both require `window`; both wrapped with `dynamic(..., { ssr: false })`
- **Read-only API routes** — all filesystem reads in API routes; browser never reads files directly
- **No auth for MVP** — localhost only
- **set -e in pipeline** — fail fast; never run downstream steps on stale upstream data
- **Existing projects untouched** — unified-platform is additive only
