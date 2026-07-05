# System State — 2026-06-06 (after Phase 2)

> Use this doc to start a fresh conversation about the AI Capital system.
> Everything here reflects the state after Phase 0 + 1 + 2 (see ROADMAP.md).

---

## 1. What this system does

A multi-project investment intelligence pipeline for Neil's personal portfolio.
The pipeline runs daily via `daily.sh` and produces:

- **Daily briefing** (Markdown) — macro regime, portfolio health, scenario probabilities, recommended actions
- **Discovery picks** (weekly) — autonomous paper-portfolio agent that screens news and opens positions with bull+bear review
- **LINE alerts** — trade signals, hot ticker alerts, discovery BUYs pushed to a personal Thai LINE account

## 2. Current monthly cost

| Service | Cost | Notes |
|---|---|---|
| Anthropic Claude API | ~$8/mo | Briefing + analysis + adversarial review |
| twitterapi.io | ~$2/mo | Event-driven sentiment + weekly people-tweets |
| FinancialData.net | $0 | Free tier (fundamentals only, prices via Yahoo) |
| LINE Messaging API | $0 | Personal account |
| All news (Yahoo + Google RSS + IR + SEC EDGAR) | $0 | Free |
| ACLED | $0 | Non-commercial license |
| **Total** | **~$12/mo** | Against weekly realized P&L of $3,400+ this week |

## 3. Architecture (which project does what)

```
/Users/thanapold/Desktop/Projects/
├─ capital-intelligence-ingestion/   # News, SEC, IR, transcripts, Twitter, 13F ingestion → LanceDB
├─ ai-analysis-engine/               # Macro regime + propagation signals + people events → analysis.json
├─ scenario-simulator/               # Portfolio state + scenarios + actions + discovery agent → simulation.json + discovery.json
├─ thesis-memory/                    # Per-ticker thesis tracking (SQLite)
├─ dependency-graph-engine/          # Company relationship graph → graph.json
├─ world-intelligence-data-hub-/     # Geopolitical event ingestion → world-intel.json (weekly)
├─ investment-analyst-agents/        # Briefing + backtest + correlation + tax + risk → briefing markdown
├─ unified-platform/                 # Next.js dashboard on port 3000 (active)
├─ macro-asset-monitor/              # Prices + FRED + macro signals
├─ government-flow-monitor/          # US fed AI contract awards
├─ wave-analyzer/                    # Trading signal layer
└─ docs/
   ├─ ROADMAP.md                     # Multi-phase plan + checkboxes
   └─ SYSTEM-STATE.md                # This doc
```

Daily cron at 00:00 runs `daily.sh` which orchestrates all projects in dependency order.

## 4. Commands cheat-sheet

```bash
# Re-run today's briefing manually after new data is ingested
cd investment-analyst-agents && npm run brief -- --force

# Briefing self-awareness loop (runs in daily.sh)
npm run backtest      # ⇒ writes backtest/calibration.json
npm run correlation   # ⇒ writes correlation/report.md
npm run tax           # ⇒ writes tax/harvest.json
npm run risk          # ⇒ writes risk/risk.json

# Discovery (weekly — Sundays in daily.sh)
cd scenario-simulator && npm run discover

# Hot ticker alerts (cron every 30 min, see ROADMAP for cron line)
cd scenario-simulator && npm run alerts

# Manual portfolio edits
cd scenario-simulator
npm run portfolio -- log buy <TICKER> <shares> <price> [reason]
npm run portfolio -- log sell <TICKER> <shares> <price> [reason]
npm run portfolio -- set <TICKER> <shares> <avgCost> [--class <c>] [--currency <c>]
npm run portfolio -- remove <TICKER>
npm run portfolio -- strategy <TICKER> <tactical|dca|tax_locked>

# Discord / LINE / paper batch intake
cd capital-intelligence-ingestion
npm run discord       # accepts batch via stdin, [TICKER|CHANNEL|AUTHOR] header format
npm run add -- --file=path/to/report.pdf --ticker=NVDA --type=10-K

# 13F holdings refresh (quarterly)
cd capital-intelligence-ingestion && npm run 13f

# Weekly people-tweets (Sundays in daily.sh)
cd capital-intelligence-ingestion && npm run people-tweets
```

## 5. Key files to know about

| Path | Purpose |
|---|---|
| `daily.sh` | The single cron entrypoint that runs everything |
| `investment-analyst-agents/archive/predictions.jsonl` | Every briefing's actions archived for backtesting |
| `investment-analyst-agents/backtest/calibration.json` | Feeds calibration into next briefing |
| `investment-analyst-agents/tax/harvest.json` | Wash sale + harvest opportunities |
| `investment-analyst-agents/risk/risk.json` | VAR/Sharpe/β/per-ticker exposure |
| `scenario-simulator/data/portfolio.db` | Source of truth for current positions + trade log |
| `scenario-simulator/data/simulation.db` | Discovery paper portfolio + analysis cache |
| `capital-intelligence-ingestion/data/sqlite.db` | Watchlist + document dedup |
| `capital-intelligence-ingestion/data/lancedb/` | All embedded chunks |
| `capital-intelligence-ingestion/data/tracked-people.json` | 31 accounts incl. Trump + Musk with interpretation notes |
| `capital-intelligence-ingestion/src/discovery/themes.config.ts` | 17 themes, 116 tickers |

## 6. Portfolio state as of this session end

| Bucket | Holdings | Strategy | Note |
|---|---|---|---|
| Locked social security | PFM009 | tax_locked | ฿457K NAV |
| Thai equity | AOT.BK, GULF.BK, SCB.BK | tactical | AOT.BK -$2,574 USD, biggest loser |
| Thai funds (DCA) | KFINDIA-A, SCBCEH, K-VIETNAM | dca | underwater = strategy working |
| Thai funds (tax-locked) | K-ESGSI-THAIESG, K-TNZ-THAIESG | tax_locked | never sell |
| US equity (remaining) | LLY, CRWD, NET, UNH | tactical | 4 positions after week-of-trims |
| Gold | GOLD_OZ | tactical | physical MTS |
| Cash | ~$23K USD + ฿421K THB | — | ~35-40% of portfolio |

**Key risk to remember:** AOT.BK is **58% of portfolio risk** (per risk dashboard). Phase 2 onward should consider whether to trim aggressively when oil de-escalates.

## 7. Key insights surfaced this session

1. **Trim signals are the only briefing edge** (66.7% accuracy vs ~50% baseline)
2. **High-conviction labels are inverted** — high underperforms medium; the briefing prompt now self-corrects via the calibration loop
3. **Portfolio is essentially uncorrelated to S&P** (β=-0.12) — the user is really a Thai/EM investor with US side bets
4. **CRWD vs GULF.BK is a natural hedge** (-37% correlation)
5. **AOT.BK = 58% concentration** — all US AI risk-off campaigns barely moved the portfolio risk needle
6. **Briefing's three-vector AI thesis attack** (CRWD billings miss + AVGO Q3 guide miss + DeepSeek $7.4B raise + EU CADA) was real and predicted what's now playing out

## 8. Known limitations / open bugs

| Item | Severity | Notes |
|---|---|---|
| YTD-realized doesn't count removed positions | medium | NVO/NOW/APP/ARM/NET/META show $0 because avg_cost lost when `portfolio remove` runs. Fix: persist avg_cost into trade_log at sell time. |
| Pipeline reliability | low | Was 10+ hr stuck pre-parallelization; now ~15-20 min. Still has occasional Yahoo News rate-limits. |
| Daily.sh recovery | low | When it does stall, manual recovery is `kill <PID> && analyze && simulate && brief --force`. Phase 3 architecture refactor solves this. |
| 5 of 20 13F funds | low | Different XML namespace causes 0 positions parsed. Backlog. |
| Thai mutual fund NAV correlation | low | Correlation engine excludes funds (PFM009/SCBCEH/etc.) because they have no Yahoo symbol. Needs a NAV reader. |

## 9. Backlog (open before deployment)

- Git history purge of leaked DB files (only matters if pushing public)
- Domain registration (when ready to deploy)
- Hosting strategy decision (Vercel + GitHub Actions vs VPS)
- SQLite → Postgres migration (only if deploying)
- Multi-broker Plaid integration (Phase 5)

## 10. Phase 2 — DONE

Three new free data sources are live:

| Item | Client | Trigger | Notes |
|---|---|---|---|
| Form 4 insider trading | `src/clients/sec-form4.ts` | `--source=insider` | 14 docs → 43 chunks on first run. New `'insider_form4'` DocType. Bug fix during build: SEC's `primaryDocument` field includes an `xslF345X06/` prefix that must be stripped to get raw XML. |
| FINRA short interest | `src/clients/short-interest.ts` | `--source=short` | New `short_interest` sqlite table tracks daily snapshots. Trend = current vs 30d avg with ±5pp threshold for elevated/receding flags. |
| Yahoo analyst ratings | `src/clients/analyst-ratings.ts` | `--source=analyst` | Uses Yahoo crumb-cookie pattern via `tough-cookie` + `axios-cookiejar-support`. 86 docs across US watchlist; skips `.BK` tickers (no coverage). |

All three flow through `processDocuments` into LanceDB; briefing will surface their signals starting tomorrow.

---

## 11. Phase 3 prep — architecture refactor

**Goal:** Foundation that lets the system deploy beyond personal use AND eliminates the manual-recovery pattern when daily.sh stalls.

⚠️ **This is the biggest phase by far (~50 hrs).** It touches every project. Plan to do it across 4-6 weekends. Take the risk seriously — keep main working at each milestone and use feature branches.

### Item 3.1 — Monorepo migration (~12 hr, do first)

**Why first:** every later item touches multiple projects and shared types. Having a `@common/types` package makes the rest 2-3x faster.

- Convert root `Projects/` into a `pnpm` workspace with `pnpm-workspace.yaml`
- Move all 12 projects into `apps/` subdirectories (no path changes inside each project)
- Create `packages/common-types/` exporting: `Position`, `AssetClass`, `Currency`, `Strategy`, `ChunkMetadata`, `RawDocument`, `SourceType`, `DocType`, all the JSON envelopes (`AnalysisJSON`, `SimulationJSON`, `DiscoveryJSON`, `GraphJSON`, `IntelligenceJSON`)
- Each app: replace local copies with `import from '@common/types'`
- Set up `turbo.json` to cache `tsc --noEmit` and tests
- Keep `daily.sh` working — paths to npm scripts need `--filter` updates
- Acceptance: `pnpm -r build && pnpm -r typecheck` passes everywhere

### Item 3.2 — Pipeline observability (~10 hr, do second)

**Why second:** safety net for everything in Phase 3 — when stuff breaks, you need to see why.

- Add `pino` (or similar) to each project for structured logging
- Each pipeline stage logs: `{ stage, start_ts, end_ts, status, doc_count, chunk_count, error?, ticker_count, source }` as JSON
- Tail logs into a `pipeline_runs` Postgres table (created in 3.3) — for now write to local SQLite
- Simple HTML dashboard at `unified-platform/src/app/admin/pipeline/page.tsx` showing last 7 runs per stage
- Acceptance: when daily.sh runs, dashboard shows green checks for each stage with duration. When a stage fails, red box with error.

### Item 3.3 — Postgres + pgvector migration (~12 hr)

**Why mid-Phase:** depends on (3.1) shared types, enables (3.4) event queue.

- Create Neon Postgres account (free tier: 3GB, plenty for personal use)
- Schema: convert each project's SQLite to Postgres tables. Most are simple — `documents`, `watchlist`, `positions`, `trade_log`, `short_interest`, etc.
- Vector chunks: enable `pgvector` extension, migrate LanceDB → `chunks` table with `embedding vector(384)` column
- Migration scripts: `packages/db-migrate/` with one-shot Node scripts that read SQLite and write Postgres
- Each app: replace `better-sqlite3` + `@lancedb/lancedb` with `pg` + pgvector queries
- Keep `.env` switch: `DATABASE_URL` for Postgres, fall back to SQLite if unset — lets you roll back during the transition
- Acceptance: full daily.sh runs end-to-end against Postgres; briefing markdown identical to pre-migration

### Item 3.4 — Event-driven queue (~8 hr)

**Why later:** depends on (3.2) observability and (3.3) Postgres.

- Add BullMQ + Redis (or `bree` with SQLite-backed for simpler setup)
- Replace `daily.sh` shell orchestration with TypeScript job definitions
- Jobs subscribe to predecessor completion: `analyze` waits for `capital-ingestion` done event
- Each job has retry policy (exponential backoff, max 3 attempts) and per-stage timeout
- Failed jobs land in a dead-letter queue inspectable from the observability dashboard
- Acceptance: kill any single stage and verify the queue retries it without manual intervention

### Item 3.5 — Health endpoints per project (~4 hr)

- Each project exports a `health()` function that returns `{ lastRunAt, lastSuccess, lastError, queueDepth }`
- Single `/health` endpoint per project (Express/Fastify on a free port)
- Aggregator at `unified-platform/src/app/api/health/route.ts` polls all sub-projects
- Display in `/admin/health` page with green/yellow/red lights

### Item 3.6 — API-first redesign (~6 hr, optional polish)

- Replace JSON-file passing between projects with HTTP endpoints
- Example: `ai-analysis-engine` exposes `GET /api/analysis/latest` instead of writing `analysis.json`
- Investment-analyst-agents loader calls `fetch(EVENT_HUB)` instead of `readFileSync`
- Backwards-compat: keep writing JSON files too for one cycle, then deprecate

### Phase 3 acceptance criteria

- [ ] All 12 apps in a single pnpm workspace with shared types
- [ ] Pipeline observability dashboard shows healthy / degraded / failed per stage
- [ ] Postgres + pgvector in use; SQLite + LanceDB deprecated (kept for fallback for 1 release)
- [ ] Job queue handles automatic retries; no more "is daily.sh stuck for 10 hours"
- [ ] Each project exposes /health with last-success timestamps
- [ ] Daily pipeline runs ≤ 20 minutes end-to-end with no manual recovery this week

### Risks and warnings for Phase 3

| Risk | Mitigation |
|---|---|
| Phase 3 breaks the daily pipeline mid-migration | Always keep `daily.sh` working. Migrate one app at a time. Tag the last green commit before each item. |
| Postgres pg_dump backups not set up before migration | Set up Neon's daily snapshots BEFORE running the migration script. Verify restore works on a scratch DB. |
| LanceDB → pgvector lossy on embedding precision | The migration script must read float32 from LanceDB, write float32 to pgvector. Test by comparing query results pre/post. |
| User loses access during the transition | unified-platform can serve a banner during deployment. Keep prior data files for at least 1 week. |
| Monorepo migration breaks IDE / VSCode workspace | Re-create `.vscode/settings.json` with `typescript.tsdk` pointing to root `node_modules`. |

### How to start Phase 3 in a fresh session

Paste this opener:

> "I'm starting Phase 3 of the AI Capital roadmap (docs/ROADMAP.md). Read docs/SYSTEM-STATE.md
> first for full context (especially section 11). Begin with item 3.1 — monorepo migration. Do NOT
> touch daily.sh logic until I confirm the workspace builds. Tag the last commit as 'pre-phase-3'
> before you start so I can roll back if needed."

The new session does NOT need this conversation's history. Section 11 above and ROADMAP.md are sufficient.

---
*Generated 2026-06-06 at the end of Phase 2. Phase 3 begins next session.*
