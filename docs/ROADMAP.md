# AI Capital System — Roadmap

> Living roadmap for evolving the AI Capital investment intelligence system.
> Check off items as they ship; commit this file alongside the work.

**Started:** 2026-06-06
**Current monthly cost:** ~$8.40
**Current realized return on system (this week):** +$3,440 from briefing-driven exits
**Guiding principle:** every line item must demonstrably outperform its cost.

---

## How to use this doc

- One phase per weekend or Claude Code session
- Brief Claude with: "I'm working on Phase X, item Y" — keeps context tight
- Mark each item `[x]` when shipped and link the commit SHA
- Skip phases ruthlessly if priorities change

---

## Phase 0 — Quick wins ✅ COMPLETE (2026-06-06)
**Goal:** Capture value from data we already have. Read-only on existing state.

- [x] **Backtesting dashboard** — Reads `archive/predictions.jsonl`, fetches actual Yahoo prices over 7/30/90d, aggregates accuracy by action/conviction. Outputs `backtest/report.md`. **First findings: 50% overall, trim 66.7% (real edge), high conviction inverted vs medium.** Commit `e263df7`
- [x] **Position correlation engine** — Pairwise Pearson on 90d returns across portfolio. Cluster detection at correlation ≥ 0.7. **Findings: no >0.7 clusters; CRWD+NET (+47%) is residual AI bet; CRWD/GULF.BK (-37%) is natural hedge.** Commit `00586d3`
- [x] **Conviction calibration loop** — `calibration.json` produced by backtest is read by briefing context loader and surfaced in the briefing prompt with explicit "downgrade high conviction" rule. `daily.sh` now runs backtest before brief. Commit `5b9a2c0`, `2f95839`
- [x] **Schema versioning** — `schemaVersion: "1.0"` on analysis/simulation/discovery/graph/people-events. Loader warns (doesn't fail) on mismatch. Commits `4fb4f76`, `5878f2d`, `0599982`, scenario-simulator commit
- [x] **Strict TypeScript pass** — Added `noUnusedLocals`, `noUnusedParameters`, `noFallthroughCasesInSwitch` across 6 projects. Codebase passed clean (0 errors). `strict: true` was already on.

---

## Phase 1 — Smart insights ✅ COMPLETE (2026-06-06)
**Goal:** Make the briefing 10x sharper.

- [x] **Tax-loss harvesting flags** — Wash sale rules, US/Thai/tax-locked jurisdiction logic, YTD realized P&L. `tax/harvest.json` flows into briefing. First-run findings: $592 harvestable, 20 wash-sale windows, $2,574 AOT.BK paper loss correctly flagged NOT harvestable. Commit `705a9be`
- [x] **Risk metrics dashboard** — VAR, Sharpe, max drawdown, beta vs VOO, per-ticker risk. `risk/risk.json` flows into briefing. First-run findings: Sharpe 2.32 (excellent), β -0.12 (uncorrelated to S&P), AOT.BK at 58% portfolio concentration. Commit `836b80c`
- [x] **Real-time hot ticker alerts** — Cron-able CLI that watches positions for ≥5% drops AND >3 article volume in 6h. De-duped via alert-state.json, sends consolidated LINE message. First-run fired on CRWD post-earnings. Commit `855a384`
- [x] **People-following activation** — 30 tracked accounts (Altman, Amodei, Musk, Pichai, Cook, Nadella, Jassy, Su, Cathie Wood, Ackman, Cramer, Hassabis, etc.). Trump added with interpretation note ("read for subtext, not surface"). Musk note flags discounting his own-venture pump statements. `cli-people-tweets` runs Sundays, ~$0.55/mo. Commits `7d0bf56`, `3776462`
- [x] **Adversarial discovery review** — Second Claude Sonnet call plays devil's advocate after analyzeCandidate. Bear score 0-100; adjusts conviction (≥40) or flips to watch (≥55) or rejects (≥75). Catches AVGO-style "everything looks great until you ask the bear" trap. ~$2.40/mo. Commit `9688eef`

---

## Phase 2 — New data sources ✅ COMPLETE (2026-06-06)
**Goal:** Higher-quality signal from underused free sources.

- [x] **Form 4 insider trading** — `sec-form4.ts` pulls Form 4 filings from SEC EDGAR submissions JSON, parses XML for transactions (P/S/A/M/G/D codes), ranks by signal strength. Commit `a50d251`. First run: 14 docs → 43 chunks
- [x] **Short interest data** — `short-interest.ts` pulls FINRA CNMS daily short volume, stores time-series in new `short_interest` sqlite table, computes 30d trend with elevated/receding/normal status flags. Commit `ee3a4c6`. First run: 89 watchlist tickers ingested
- [x] **Sell-side analyst ratings** — `analyst-ratings.ts` uses Yahoo crumb-cookie pattern to access quoteSummary endpoint, emits consensus rating + target prices + month-over-month rating distribution delta. Commit `9001e97`. First run: 86 docs → 86 chunks across US watchlist

---

## Phase 3 — Architecture refactor (4-6 weekends, ~50 hours) ⚠️ BIG
**Goal:** Foundation that lets the system deploy and scale beyond personal-use.

- [ ] **Monorepo migration** — `pnpm workspaces` + shared `@common/types` package. All projects pull types from one place. Refactors stop requiring N-file edits. **~12 hr**
- [ ] **Postgres + pgvector migration** — Replace SQLite + LanceDB with one Postgres database. Deployable to Neon (free tier 3GB) or Supabase. **~12 hr**
- [ ] **Pipeline observability** — OpenTelemetry or structured per-stage logs with a simple HTML dashboard showing "last successful run, errors, duration." We lost 3 days to the "stuck pipeline" mystery — this prevents it forever. **~10 hr**
- [ ] **Event-driven queue** — BullMQ + Redis (or SQLite-backed Bree). Each pipeline stage subscribes to its inputs; automatic retries with backoff. No more bash orchestration. **~8 hr**
- [ ] **Health endpoints per project** — Every project exposes `/health` returning last successful run, error log, queue depth. **~4 hr**
- [ ] **API-first redesign** — Replace JSON-file-passing between projects with HTTP APIs. Cleaner contracts, versionable, testable. **~6 hr**

---

## Phase 4 — Cleanup (1-2 weekends, ~8 hours, $0 cost)
**Goal:** Reduce maintenance burden.

- [ ] **Archive deprecated worldmap repos** — `worldmaphistory_v1`, `worldmaphistory_v2`, `Worldmap/` are already DEPRECATED-tagged but still on disk. Move to `_archive/` folder. **~1 hr**
- [ ] **Re-evaluate `dependency-graph-engine`** — Decide: keep, remove, or merge as a relationship table in main DB. Currently unclear how much it actually affects briefing decisions. **~3 hr**
- [ ] **Re-evaluate `wave-analyzer`** — Same exercise. Keep only if it provides signal beyond regime-analyzer. **~2 hr**
- [ ] **Simplify `world-intelligence-data-hub-`** — Extract just the ACLED fetcher + export logic into a small Cloudflare Worker or single script. **~2 hr**

---

## Phase 5 — Premium features (variable, ~$30-60/mo if all adopted)
**Goal:** Capabilities worth paying for.

- [ ] **Multi-broker aggregation** — Plaid Investments API or similar. Auto-pulls positions/trades from all brokerages. ~$0.50/account/mo. **~8 hr**
- [ ] **Options strategy modeling** — Instead of "sell META," output "buy 6mo $580 puts as hedge" or "sell covered calls at $700." ~$2/mo extra LLM. **~6 hr**
- [ ] **Earnings call audio transcripts** — Replicate / AssemblyAI for full transcripts. Currently rely on Motley Fool web scrape (lossy). ~$5/mo. **~4 hr**
- [ ] **Options flow data** — Unusual Whales-style feed of big options trades. $30/mo. Only add if it pays for itself. **0 hr to integrate, signal evaluation only**

---

## Phase 6 — Online deployment (2-3 weekends, ~15 hours, +$35-50/mo running cost)
**Goal:** Go live.

- [ ] **Domain registration** — Cloudflare Registrar (at-cost). ~$12/yr. Pick a name. **~1 hr**
- [ ] **Vercel Pro for unified-platform** — $20/mo. Custom domain + SSL. **~2 hr**
- [ ] **Neon Postgres production tier** — $19/mo. Daily backups. **~1 hr**
- [ ] **GitHub Actions cron** — Free tier covers the daily pipeline. **~4 hr**
- [ ] **LINE webhook receiver** — Inbound LINE messages → dropzone. **~4 hr**
- [ ] **Git history purge** — Strip the leaked DB files from history before publishing. **~2 hr**
- [ ] **Backup strategy** — Automated daily Postgres + chunks snapshot to S3/R2. **~1 hr**

---

## Minimum viable trajectory (if only 4 weekends)

1. Phase 0 — backtesting + correlation (weekend 1)
2. Phase 1 — adversarial review + people-following + hot alerts (weekends 2–3)
3. Phase 2 — Form 4 insider trading only (weekend 4)

Gets 80% of intelligence value at 20% of total work.

---

## Skip criteria

| Phase | Skip if |
|---|---|
| Phase 3 (architecture) | Staying personal-use forever — SQLite + cron works fine |
| Phase 5 (premium) | Not trading options; only one brokerage |
| Phase 6 (deployment) | Personal use only forever |

---

## Cost ceilings

| Milestone | Cumulative monthly cost |
|---|---|
| Today | $8.40 |
| After Phase 1 | ~$12 |
| After Phase 5 (all) | ~$65 |
| After Phase 6 (deployed) | ~$100 |

The cap principle: **never let total monthly cost exceed 10% of the realized monthly value of the system**. This week alone realized ~$3,400 — that's a 40x buffer above current spend.
