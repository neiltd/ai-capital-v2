# Backend gaps — what the redesign needs that the pipeline doesn't produce yet

Numbered for cross-reference from screen code/specs (`// GAP #n`). Ranked
list at the bottom.

## By screen

### /today — Briefing
1. **Structured briefing JSON** (`briefing.json` alongside the markdown):
   regime, calibration numbers, grouped actions (with harvestable/wash-sale
   joins), watch-items with kind+tickers, world-event references by eventId,
   thesis-status rows. Today all of that exists only as prose in
   `briefings/YYYY-MM-DD.md`; the redesign stitches 5 envelopes to fake it.
   One emitter in `investment-analyst-agents` (the model already produces
   sections — emit JSON first, render markdown from it).
2. *(shared)* Calibration export: `backtest/calibration.json` needs a stable
   documented schema (accuracy by action × horizon × conviction) so
   `ConvictionBadge` can show per-action accuracy everywhere.

### /portfolio — Holdings
3. **Day change**: store previous close per priceSymbol (one extra column at
   refresh-prices time) → portfolio day Δ and per-position day Δ.
4. *(shared, biggest lever)* **Time-series store**: daily close per held
   symbol + daily portfolio/net-worth USD snapshot table. Unlocks: header
   sparkline, position sparklines, drawdown chart, discovery-vs-SPY, risk
   trends. The risk runner already fetches 90d history from Yahoo daily and
   throws it away — persist it.
5. **Target allocation config**: the 2026 plan's bucket targets
   (45/11/20/5/12.5…) as `targets.json` or a table, so drift bars aren't
   hardcoded.
6. **Refresh-prices API**: `POST /api/portfolio/refresh-prices` + job status
   (wraps `scripts/refresh-prices.sh`; must set DATABASE_URL — the CRWD-split
   lesson).
7. Trade-log read API for the expanded row / position panel.

### /portfolio/risk
8. **correlation.json**: full pairwise matrix + detected clusters + top
   pairs as data (engine computes it; only a markdown report survives).
   Unlocks the heatmap and data-driven cluster banners.
9. Thai fund NAV series reader (SYSTEM-STATE known-limitation) so funds stop
   being excluded from vol/β — until then the UI keeps the "priced subset"
   honesty banner.

### /portfolio/tax
10. Fix realized-loss undercount: persist avg_cost into trade_log at sell
    time (SYSTEM-STATE bug #1).
11. Marginal-rate config (Thai PIT bracket) for "plan harvest" offset math.
12. Harvest history (what was harvested, realized benefit YTD).

### /portfolio/theses
13. **Thesis API/export** from thesis-memory: thesis text, status, dated
    status history with evidence quotes, and thesis-change *proposals* as
    first-class rows with accept/reject endpoints + audit log. Currently
    SQLite-internal and narrated only in briefing prose.

### /discover — Discovery
14. **Promote-to-real endpoint**: `POST /api/portfolio/promote` — wash-sale +
    jurisdiction pre-check, writes trade_log BUY, closes paper position,
    seeds thesis-memory with the discovery rationale.
15. **Persist the bear**: adversarial reviewer's rationale text + verdict
    (only `bearScore` number survives today); score history per candidate;
    watch/dismiss states.
16. Paper-portfolio daily value series + SPY benchmark (folds into #4).

### /discover/graph
17. Theme-exposure aggregation (held USD per theme) in graph.json; edge
    `asOf` provenance.

### /markets — Macro & Prices
18. Macro series history endpoint (`/api/macro/:metric?range=`) with a
    cache table — snapshots exist, history doesn't (folds into #4).
19. `watch-thresholds.json` shared by briefing prompt and UI tripwires.
20. SET index / THB pair ingestion in macro-asset-monitor.

### /markets/waves
21. Typed `WaveJSON` envelope in `@common/types`; wave-signal backtest/hit
    -rate aggregation (reuse predictions.jsonl pattern); briefing-vs-wave
    conflict join (needs #1).

### /markets/gov
22. Vendor→ticker mapping table; monthly award aggregation endpoint;
    bill-status fetcher (congress.gov) for the NDAA stepper.

### /world
23. Real geocoding for GDELT events (most lat/lng null; centroid-quality
    flag already exists — good); storyline causal links as edges
    (`{from,to,relation}`); briefing↔event backlinks (needs #1's eventId
    references).
23b. Map tab — renderers for the 3 registry layers whose datasets exist but
    nothing reads them in the current app (verified 2026-07-06):
    `energy-mix` (validated/energy-mix.json, 60 countries),
    `water-stress` (validated/water-stress.json, 194 countries — the heatmap's
    waterStressScore uses the coarser utilities.json instead), and
    `investment-signals` (validated/investment-signals.json, 240 signals with
    watchTickers). The redesign's Map tab renders all three from those files
    and flags them with the ◌ provenance glyph; per-layer source paths in
    `screens/world/map-layers.ts`. Everything else on the Map tab is backed:
    2 pipeline-live layers (intelligence-events via hub exports,
    portfolio-trade via /api/trade-graph) + 16 curated in-repo datasets.

### Ask (⌘K + /ask)
24. Read-only tool-calling agent endpoint over the envelopes + pgvector
    retrieval, returning typed payloads with provenance (source envelope +
    date per number); thread persistence; SSE streaming; per-month cost cap.

### /system/pipeline
25. `GET /api/pipeline/dag` (serialize DAILY_PIPELINE with dependsOn/skipIf)
    and `GET /api/pipeline/runs?days=7`; `POST /api/pipeline/run[/:stage]`
    guarded to localhost; per-stage median-duration stats.

### /studio
26. Board status column, post-performance entry, media attachments —
    isolated in creator-studio's own Prisma DB.

## Top 5, ranked by dashboard impact

1. **#1 Structured briefing JSON** — the home screen is currently
   un-renderable except as a markdown blob; this single emitter turns the
   system's most valuable artifact into UI, enables calibrated badges,
   wave-conflict checks, and world-event backlinks.
2. **#4 Time-series store** (daily closes + NW snapshots) — one table feeds
   sparklines, day change, drawdown, discovery-vs-SPY, and macro history;
   the data is already fetched daily and discarded.
3. **#14+#15 Discovery promote endpoint + persisted bear rationale** — turns
   the discovery agent from a report into a workflow, and preserves the
   adversarial review that is the feature's whole safety mechanism.
4. **#13 Thesis API with proposals** — "why do I hold this" becomes
   reviewable state instead of prose; the accept/reject queue is the
   highest-leverage human-in-the-loop surface in the app.
5. **#8 correlation.json** — cheap (engine already computes it) and directly
   powers the risk screen's cluster warnings and heatmap, the second-most
   consulted screen after the briefing.
