# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

"AI Capital" — a pnpm-workspace monorepo running a daily investment-intelligence
pipeline for the user's real personal portfolio (Thai + US equities). It ingests
news/filings/macro data, runs analysis, simulates portfolio scenarios, and
produces a daily markdown briefing plus LINE trade alerts. **Real money
decisions ride on this data** — favor correctness and observability over speed
when touching pipeline code.

Root: `/Users/thanapold/Desktop/Projects.nosync` (moved here from `Projects/`
specifically to get out of iCloud sync — never move it back under an
iCloud-synced path; iCloud eviction previously corrupted `node_modules`
hardlinks and broke the pnpm store).

## Commands

```bash
# Install / build / typecheck / test everything
pnpm install
pnpm -r --if-present build
pnpm -r --if-present typecheck
pnpm -r --if-present test

# Single package/app
pnpm --filter <app-name> typecheck
pnpm --filter <app-name> test          # vitest run
pnpm --filter <app-name> test:watch

# Run a single test file directly from an app dir
cd apps/<app-name> && npx vitest run path/to/file.test.ts
```

Apps are `tsx`-run CLIs (no build step needed for local dev — `npm run <script>`
inside the app dir invokes `tsx src/cli/...`). `unified-platform` and
`creator-studio` are Next.js apps (`dev`/`build`/`start`/`lint`).

### Running the daily pipeline manually

```bash
# Submit today's pipeline to the queue (requires a worker running — see below)
npx tsx packages/queue/bin/run-daily.ts

# Or block until it completes (ad-hoc/local runs)
pnpm --filter @common/queue submit

# Start a worker manually (normally launchd-managed, see below)
pnpm --filter @common/queue worker

# Smoke-test the queue/flow wiring without hitting real APIs
pnpm --filter @common/queue smoke
```

Production orchestration is launchd, not cron or a shell script directly:
- `com.thanapol.ai-capital.worker` — long-running BullMQ worker (`daily-queue.worker.plist`), auto-restarts via `KeepAlive`, uses `caffeinate -i` to survive sleep.
- `com.thanapol.ai-capital.daily` — triggers `daily-queue.sh`, which ensures the worker is up and submits the daily flow.
- `com.thanapol.ai-capital.alerts` — every 30 min during US/Thai market hours, runs `scripts/run-alerts.sh` (hot-ticker LINE alerts).

`daily.sh` (root) is the **legacy** pre-queue orchestrator kept for reference/rollback; it is not what runs in production anymore. When editing pipeline stage order or dependencies, edit `packages/queue/src/jobs.ts`, not `daily.sh`.

## Architecture

### The pipeline is a DAG, not a script

`packages/queue/src/jobs.ts` defines `DAILY_PIPELINE: JobSpec[]` — one entry per
stage, each with `cmd`, `cwd`, and a `dependsOn` edge (or array of edges) to
other stage names. `submit.ts`'s `buildDAGTree` walks these edges into a BullMQ
`FlowProducer` tree, so independent subtrees (e.g. `macro-asset-monitor` and
`government-flow-monitor`) run in parallel while dependent chains
(`world-intel-* → capital-ingestion → thesis-memory → ai-analysis-engine → ... →
investment-brief`) run in order. Some stages are Sunday-only (`skipIf: notSunday`)
— discovery, people-tweets, and correlation are weekly to save LLM cost.

To add/reorder/re-parent a pipeline stage: edit the `JobSpec` array in
`packages/queue/src/jobs.ts`. To change what a stage *does*: edit that app's own
CLI script (each stage just shells out to `npm run <script> --prefix <app>`).

### Data flow between apps (still JSON-envelope based, not HTTP)

Apps hand off state via typed JSON envelopes and shared DB tables, not APIs:

```
capital-intelligence-ingestion  → news/filings/13F/insider/short-interest/analyst-ratings → LanceDB/pgvector chunks
world-intelligence-data-hub-    → geopolitical events (GDELT/ACLED/EIA/WorldBank) → world-intel.json
ai-analysis-engine              → macro regime + propagation signals → analysis.json
scenario-simulator               → portfolio state + scenarios + discovery → simulation.json / discovery.json
thesis-memory                    → per-ticker thesis tracking (SQLite/Postgres)
dependency-graph-engine          → company relationship graph → graph.json
investment-analyst-agents        → briefing + backtest + correlation + tax + risk → daily briefing markdown
unified-platform                 → Next.js dashboard (port 3000) reading all of the above
```

Envelope types (`AnalysisJSON`, `SimulationJSON`, `DiscoveryJSON`, `GraphJSON`,
`IntelligenceJSON`, `Position`, `AssetClass`, etc.) live in
`packages/common-types` and are imported as `@common/types` — this replaced
per-app duplicate type definitions during the monorepo migration. All envelopes
carry a `schemaVersion`; loaders warn (not fail) on mismatch.

### Storage: Postgres/pgvector-first, SQLite fallback

`packages/db` (`@common/db`) exposes `usePostgres()` (true iff `DATABASE_URL` is
set) and `getPool()`. When `DATABASE_URL` is unset, callers fall back to local
SQLite (`better-sqlite3`) and LanceDB for vectors — this is the migration
fallback path, not the intended steady state. The launchd worker plist sets
`DATABASE_URL=postgres://thanapold@localhost:5432/ai_capital`; **local ad-hoc
CLI runs outside that plist won't have it set** unless you export it yourself,
which silently sends embeddings to on-disk LanceDB instead of Postgres.

`packages/pipeline-runs` (`@common/pipeline-runs`) is the structured
observability layer: every stage calls `recordStart`/`recordEnd` around its
work, writing to `data/pipeline-runs.db` (path overridable via
`PIPELINE_RUNS_DB`). `unified-platform`'s `/admin/pipeline` page and
`scripts/morning-status.ts` (last DAG stage — writes a non-LLM digest) both
read this table. If a pipeline stage errors mysteriously, check
`pipeline_runs` for the failing stage's `error_message`/`error_stack` before
re-deriving from logs.

### Known cross-app landmine: shared Prisma client

`unified-platform` and `creator-studio` both use Prisma with no custom `output`
path in `schema.prisma`, so they share one generated `@prisma/client` in the
pnpm store — whichever ran `npx prisma generate` most recently wins, and the
other app's types go stale silently. Before working on `creator-studio`, run
`cd apps/creator-studio && npx prisma generate` (and regenerate for
`unified-platform` again before returning to it).

### Apps at a glance

| App | Role |
|---|---|
| `capital-intelligence-ingestion` | News/SEC/IR/transcripts/Twitter/13F/Form-4/short-interest/analyst-ratings ingestion |
| `world-intelligence-data-hub-` | Geopolitical event ingestion (GDELT/ACLED/EIA/WorldBank) + dedup/link/memory-agent enrichment |
| `ai-analysis-engine` | Macro regime + propagation signals |
| `scenario-simulator` | Portfolio state, what-if scenarios, autonomous discovery agent (paper portfolio) |
| `thesis-memory` | Per-ticker thesis tracking |
| `dependency-graph-engine` | Company relationship graph |
| `trade-graph` | Trade dependency ingestion/review |
| `wave-analyzer` | Trading signal layer |
| `macro-asset-monitor` | Prices + FRED + macro signals |
| `government-flow-monitor` | US federal AI contract awards (USASpending.gov) |
| `investment-analyst-agents` | Briefing generation + backtest + correlation + tax-harvest + risk metrics |
| `unified-platform` | Next.js dashboard (`/capital/*`, `/world/*`, `/studio/*`, `/admin/*`) |
| `creator-studio` | Content/creator tooling (separate Prisma DB — see landmine above) |

Trace a feature by starting from `packages/queue/src/jobs.ts` to see which app
produces the data, then that app's `src/cli/*.ts` entry point.

### TypeScript conventions

`tsconfig.base.json` sets `strict: true`, `noUnusedLocals`,
`noUnusedParameters`, `noFallthroughCasesInSwitch`, ESM (`module: ESNext`,
`moduleResolution: Bundler`). Every app/package extends this — keep new code
clean under these flags rather than loosening them.

## Documentation

- `docs/ROADMAP.md` — phased plan with checkboxes; Phase 3 (monorepo + Postgres
  + queue + observability) is the architecture generation this repo is
  currently in, though the doc's checkboxes predate its completion — trust the
  code (`packages/queue`, `packages/db`, `packages/pipeline-runs` all exist and
  are wired up) over the checkbox state.
- `docs/SYSTEM-STATE.md` — snapshot from 2026-06-06 (pre-monorepo-migration);
  useful for portfolio/business context but architecturally stale — the
  `daily.sh`-centric description there has been superseded by the BullMQ queue
  described above.
- `docs/superpowers/plans/` and `docs/superpowers/specs/` — per-feature design
  docs from when each app was originally built.
