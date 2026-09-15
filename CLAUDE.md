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

## Repository topology

`apps/capital-intelligence-ingestion` is a **Git submodule**, separately
versioned at `github.com/neiltd/capital-intelligence-ingestion`. The supported
source unit is *this repository plus the exact pinned submodule revision* —
neither half is complete alone.

```bash
git clone --recurse-submodules <parent-remote>   # or, after an ordinary clone:
git submodule update --init --recursive
```

A plain `git clone` leaves that directory empty, and the workspace will not
install, typecheck, or test.

The submodule depends on parent workspace packages (`@common/db`,
`@common/pipeline-runs`) via `workspace:*`, which pnpm resolves only inside a
workspace. It is therefore installed, typechecked and tested **from this
workspace**, never as a standalone application — a bare clone of its own remote
cannot `pnpm install`. That is by design, not a defect.

**The restore contract covers source only.** `git checkout <ref> && git
submodule update --init --recursive` does not restore local SQLite/runtime DBs,
LanceDB indexes, `.env`, caches, `data/pipeline-runs.db`, BullMQ/Redis queue
state, Postgres contents, or any external service state.

**Historical limitation:** commits and tags created *before* this conversion —
including `pre-line-retirement` — are parent-only restore points and pin no
ingestion revision. They are deliberately not rewritten. Note also that the
submodule's working tree carried uncommitted production source until
2026-08-29, so no earlier point is fully reproducible: **`a48eb71` is the first
committed ingestion revision known to represent the previously running source
completely.**

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
- `com.thanapol.ai-capital.worker` — long-running BullMQ worker, auto-restarts via `KeepAlive`, uses `caffeinate -i` to survive sleep.
- `com.thanapol.ai-capital.daily` — triggers `daily-queue.sh`, which REQUIRES a live worker and submits the daily flow. It no longer starts one: if no live worker exists it logs FATAL, submits nothing and exits 3.
- `com.thanapol.ai-capital.alerts` — every 30 min during US/Thai market hours, runs `scripts/run-alerts.sh` (hot-ticker LINE alerts).

The tracked **source** for these agents is `ops/launchd/*.plist.template`. The
older `daily-queue.worker.plist`, `daily-alerts.plist`, `daily-catchup.plist`
and `ops/launchd-proposed/` are gone — each embedded a literal superuser
connection URL, and `daily-catchup.plist` additionally claimed the
`com.thanapol.ai-capital.daily` label. Three source tools now
render and inspect them, all inside `@common/queue`:

| Tool | Script | Role |
|---|---|---|
| renderer | `pnpm -F @common/queue render-plist` | substitutes path / Redis / credential-file **path** only; refuses a credential placeholder, parses its own output, publishes atomically with `link(2)` |
| installer | `pnpm -F @common/queue install-credential` | writes the credential file (0600) from a no-echo TTY or a pre-opened fd — never argv or stdout |
| inspector | `pnpm -F @common/queue inspect-plist` | parses an installed plist and **exits non-zero** on a forbidden key, a PostgreSQL literal or an unresolved placeholder; prints key names, never values |

**Nothing has been provisioned or installed.** No credential file exists, no
plist is installed, and no agent has been restarted. Production cutover to the
least-privilege credentials remains a separate, separately authorized action. If
Time Machine exclusion of the credential directory is approved, it must be
applied and verified **before** the credential file is first created — deleting
a file does not remove it from existing backup history.

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
fallback path, not the intended steady state.

**Who holds which credential (slice S4D).** Each consumer names its own variable
and there is no fallback between them:

| Process | Variable it reads | Notes |
|---|---|---|
| queue worker / structured worker | `PIPELINE_CREDENTIAL_FILE` | the launchd plists carry the **path** of a file holding the URL, never the URL. `requirePipelineCredential()` reads it in-process, validates the URL **and the exact `ai_capital_pipeline` role**, and keeps the value as a local — it is never written into `process.env`. Validated before any queue or Redis module is imported |
| stage children (every DAG stage) | `DATABASE_URL` | *derived* by `buildPipelineChildEnv()` from the validated value, after every inherited `PG*`, `*_DATABASE_URL` and authority variable is stripped |
| `scripts/run-alerts.sh`, `scripts/refresh-prices.sh` | `PIPELINE_CREDENTIAL_FILE` | via `packages/queue/bin/run-stage.ts`, same in-process load and validation; the scripts hold no default |
| dashboard API routes | `DASHBOARD_DATABASE_URL` | read-only role (S4A) |
| claim writer | `CLAIM_WRITER_DATABASE_URL` | (S4C) |
| `daily-queue.sh`, `daily-scheduler.sh`, `pipeline-watchdog.sh` | *none* | they submit to Redis and read the SQLite run ledger; they never connect to PostgreSQL |

The root `.env` is no longer sourced wholesale by the queue: `ensurePipelineEnv()`
parses it in memory and copies only `ANTHROPIC_API_KEY` and `SEC_FUND_API_KEY`.
`ensurePipelineEnv()` runs in ten bins and is deliberately **credential-free**;
only `requirePipelineCredential()` — called by `worker`, `structured-worker` and
`run-stage` — ever reads a credential.
Scheduled structured ingestion remains **dormant and unregistered**.

**Per-app ad-hoc CLI runs
(e.g. `npm run portfolio` inside an app dir) still won't have it set** unless
you export it yourself — without it they silently read/write the stale SQLite
fallback stores instead of Postgres (this is exactly how the CRWD 4:1 split
adjustment got lost on 2026-07-05).

**Production runtime root (S4F, in transition).** Two roots are protected as
production: `/Users/thanapold/ai-capital-runtime` — the **proposed canonical
runtime root, which does not exist yet and which nothing points at** — and
`/Users/thanapold/Desktop/Projects.nosync`, the legacy root, which **remains
protected and authoritative** during the transition. Both are frozen literals in
`packages/queue/src/destinations.ts`; neither is ever derived from the module's
location, `cwd`, `HOME`, `AI_CAPITAL_ROOT` or Git metadata, because a derived
root would make every temp worktree declare itself production. `PRODUCTION_REPO`
still exists and now resolves to the runtime root, so unset isolation defaults
resolve there. Scripts under `scripts/` derive `ROOT` from `BASH_SOURCE[0]`.
Dropping the legacy root's protection requires a later, separately approved
retirement change; the current slice performs **no relocation and no cutover**.

`packages/pipeline-runs` (`@common/pipeline-runs`) is the structured
observability layer: every stage calls `recordStart`/`recordEnd` around its
work, writing to `data/pipeline-runs.db` (path overridable via
`PIPELINE_RUNS_DB`). `unified-platform`'s `/admin/pipeline` page and
`scripts/morning-status.ts` (last DAG stage — writes a non-LLM digest) both
read this table. If a pipeline stage errors mysteriously, check
`pipeline_runs` for the failing stage's `error_message`/`error_stack` before
re-deriving from logs.

### Cross-app Prisma clients (defused 2026-07-06)

`unified-platform` and `creator-studio` each generate their Prisma client to an
app-local `output` path (`src/generated/prisma` and `lib/generated/prisma`
respectively — both gitignored), so the old shared-client landmine (last
`prisma generate` wins, other app's types silently stale) is gone. Import
`PrismaClient` from the generated path (see each app's `lib/**/db.ts`), never
from `@prisma/client`. After editing a `schema.prisma`, run `npx prisma
generate` in that app's directory.

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
`moduleResolution: Bundler`).

**Correction (2026-08-26): NOT every app/package extends this.** Only 4 of 18
projects do; twelve set `target` explicitly instead, and `apps/unified-platform`
set neither — so it defaulted to ES5, and a `[...new Set()]` in
`packages/db/src/pool.ts` (pulled in via `transpilePackages`) broke the
dashboard BUILD for three days without any test noticing. The believed-universal
`extends` is why nobody looked. When touching shared `packages/*` code, run
`pnpm -r --if-present typecheck` AND `pnpm --filter unified-platform build` —
the test suite does not cover compilation. Keep new code
clean under these flags rather than loosening them.

### Validation must not share `.next` with a running dev server

`pnpm --filter unified-platform build` and a running `next dev` both write
`apps/unified-platform/.next`. Running the gate build while the dev server is up
empties the vendor chunks underneath it and every route starts returning 500 —
which reads as a code defect and cost real time during the 2026-08-28 W4 audit
(see `docs/findings/2026-08-28-D8-build-dev-next-state.md`).

Before running a gate build, either stop the dev server, give the build its own
`distDir`, or plan to restart the server afterwards. A verification step must not
perturb the thing being verified.

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
