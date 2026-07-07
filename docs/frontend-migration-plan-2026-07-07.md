# Frontend Migration Plan — unified-platform → design-redesign-2026-07

**Date:** 2026-07-07
**Scope:** Migrate `apps/unified-platform` (Next.js 14.2.35, App Router) to the redesigned
frontend in `design-redesign-2026-07/`. This plan was written after reading both sides in
full: every screen build and spec in the proposal folder, `backend-gaps.md`,
`design-system.md`, and the current app's routes, components, `src/lib/data.ts`,
`tailwind.config.ts`, `globals.css`, layouts, and middleware — plus the *actual current
state* of the backends the screens read (notably `apps/scenario-simulator/src/discovery/`,
which changed substantially after the discovery mockup was written; see §5).

**Audience:** an implementing agent. Every phase below is independently shippable and
independently rollbackable. The app is used daily for real-money decisions — the plan's
overriding rule is: **new screens land at new URLs alongside the old ones; nothing that
Neil reads tomorrow morning is modified until its replacement has been used for real.**

---

## 0. Ground truth — what exists on each side

### The proposal folder (`design-redesign-2026-07/`)

- `screens/_shared/` — drop-in infra: `tokens.css` (CSS variables + tailwind
  `theme.extend` snippet in its header), `format.ts`, `types.ts` (view-model types;
  duplicates of `@common/types` are marked for merge), `ui.tsx` (server-component-safe
  primitives: `SectionCard`, `StatTile`, `Delta`, `Label`, `AsOf`, badges/chips, `Th`/`Td`),
  `charts.tsx` (SVG: `Sparkline`, `AllocationDonut`, `HBar`, `ProbBar`).
- 11 fully-built screens (page + `data.ts` loader contract with real sample data, plus
  screen-specific client components): `briefing`, `portfolio`, `risk`, `discovery`
  (+ `sizing-rationale.tsx`, `promote-dialog.tsx`, `performance.tsx`), `theses`
  (+ `thesis-board.tsx`), `waves`, `trade`, `macro` (+ `macro-grid.tsx`), `gov`
  (+ `awards-table.tsx`), `world` (+ `world-tabs.tsx`, `map-tab.tsx`, `map-layers.ts`),
  `studio` (+ `studio-tokens.css`, `.studio-theme` scoped).
- 4 written specs (no code): `screens/specs/tax.md`, `dependency-graph.md`, `ask.md`,
  `admin-pipeline.md`.
- **No nav shell exists as code.** The IA (sidebar sections, global status strip, ⌘K)
  is specified in `design-system.md` §1/§5 only. The shell must be built new (§2, Phase 0).

### The current app (`apps/unified-platform/`)

- Routes: `/` (domain-summary landing), `/capital/{briefing,portfolio,discovery,thesis,graph,macro,waves,waves/[ticker],trade,gov,ask}`,
  `/world/{intel,map}`, `/studio/{,dashboard,archive}`, `/admin/pipeline`.
- Shell: root `src/app/layout.tsx` renders a global `TopNav` (workspace switcher:
  Capital / World / Studio) for **every** route; `src/app/capital/layout.tsx` adds
  `components/capital/Sidebar.tsx` (4 sections, 10 items). `src/app/world/layout.tsx`
  and `src/app/studio/layout.tsx` add their own sidebars.
- Data access: `src/lib/data.ts` reads envelopes directly off disk via `DATA_ROOT`
  (`readSimulation`, `readAnalysis`, `readBriefing`, `readDiscovery`, `readMacro`,
  `readWaves`, `readWaveActions`, `readWavePortfolio`, `readGovFlow`, `readWorldIntel`,
  `readStockIntel`, `readGraph`). Pages are mostly server components with
  `export const dynamic = 'force-dynamic'` reading these directly — API routes exist
  only where interaction demands them.
- Types: `src/types.ts` is app-local and does **not** import `@common/types` at all.
  Its `DiscoveryJSON` is stale vs. the producer (§5).
- Existing API routes worth keeping: `POST /api/portfolio/refresh` (already wraps
  `cli-refresh.ts` with the correct `DATABASE_URL` — this **is** backend gap #6, done),
  `/api/status` (briefing-file staleness only), `/api/ask`, `/api/thesis-proposals`
  (LLM-generated proposals on demand, not persisted — *not* gap #13),
  `/api/trade-graph`, `/api/world-intel/causal-tree`, `/api/studio/*`.
- `src/middleware.ts` gates `/admin/*`, `/studio/*`, `/api/studio/*`,
  `/api/thesis-proposals` behind `APP_ACCESS_KEY` (Basic auth / `x-api-key`). Any new
  **mutating** route added by this migration (promote, thesis accept/reject, pipeline
  re-run) must be added to its `matcher`.
- Styling: Tailwind 3.4 config with a Linear-inspired palette under compound key names
  (`bg-base`, `text-primary`, `accent-primary`, `green-signal`, …); `globals.css` sets
  `body { background:#010102 }` and `.briefing-prose` markdown styles; maplibre CSS
  imported globally.

### Current data files on disk (verified 2026-07-07)

| Envelope | Exists | Notes |
|---|---|---|
| `scenario-simulator/data/simulation.json` | ✓ | portfolio + usdThb |
| `scenario-simulator/data/discovery.json` | ✓ | **schemaVersion 1.0, now has `closedPositions[]` — and is EMPTY (cohort 0 archived 2026-07-07, see §5)** |
| `scenario-simulator/data/discovery-cohort-0-archive.json` | ✓ | the 16-position book the mockup renders |
| `scenario-simulator/data/discovery-calibration.json` | ✗ not yet | write path exists in `cli-discover.ts` (`CALIBRATION_JSON_PATH`); appears after next Sunday run |
| `investment-analyst-agents/risk/risk.json` | ✓ | matches the mockup's `RiskJSON` |
| `investment-analyst-agents/tax/harvest.json` | ✓ | matches the tax spec |
| `investment-analyst-agents/correlation/report.md` | ✓ (md only) | gap #8: no `correlation.json` |
| `investment-analyst-agents/backtest/calibration.json` | ✓ | byAction × {7d,30d} × {calls,accuracy,avgReturn} + byConviction — **gap #2 is de-facto closed; needs only a documented schema** |
| `macro-asset-monitor/data/macro.json` | ✓ | snapshots only, no history (gaps #18/#4) |
| `wave-analyzer/data/{waves,wave-actions,wave-portfolio}.json` + `trades.db` | ✓ | already read by current app |
| `government-flow-monitor/data/govflow.json` | ✓ | |
| `world-intelligence-data-hub-/exports/world-map/intelligence.json` | ✓ | |
| `investment-analyst-agents/briefings/YYYY-MM-DD.md` | ✓ (md only) | gap #1: no `briefing.json` |
| thesis-memory SQLite | ✓ (read via `src/lib/thesis-db.ts`) | gap #13: no API, no persisted proposals |

---

## 1. Strategy decisions (read first — everything else follows from these)

### 1.1 New URL space, coexisting routes — NOT in-place replacement

The redesign defines its own IA (`/today`, `/portfolio`, `/portfolio/risk`,
`/portfolio/tax`, `/portfolio/theses`, `/markets`, `/markets/waves`,
`/markets/waves/trade`, `/markets/gov`, `/world`, `/discover`, `/discover/graph`,
`/system/pipeline`, `/studio`). **None of these paths collide with a current route**
(current app uses `/capital/*`, `/world/intel`, `/world/map`, `/admin/pipeline` —
the only overlaps are `/studio` and `/world`, handled in their phases). So the natural
migration is: each new screen lands at its redesign URL as a net-new route; the old
`/capital/*` route keeps working untouched. Cutover per screen = adding a redirect from
the old path; rollback = deleting the redirect. Nothing is ever "swapped".

### 1.2 Route groups to split the shells (the one global change)

The current root `layout.tsx` renders `TopNav` for every route, and the redesigned
screens must NOT show it (they get the new sidebar + status strip instead). Next.js
App Router route groups solve this without URL changes:

```
src/app/
  layout.tsx              ← slimmed: <html><body> + globals.css + tokens.css only
  (legacy)/               ← move: page.tsx, capital/, world/, studio/, admin/
    layout.tsx            ← renders <ErrorFilter/> + <TopNav/> (moved from root)
    capital/... world/... studio/... admin/...  (unchanged files, just relocated)
  (next)/                 ← new shell
    layout.tsx            ← <AppShell> = new sidebar + status strip, bg-page text-ink
    today/page.tsx
    portfolio/...  markets/...  world/...  discover/...  system/...
```

Route groups don't affect URLs, so `/capital/briefing` etc. keep working. This is the
single highest-blast-radius change in the plan (it touches every existing page's layout
chain) and is why Phase 0 must be verified end-to-end (visit every legacy route, check
`next build` passes) before anything else lands.

**Conflict to resolve in Phase 0:** `/world` — the current app has `world/intel` and
`world/map` pages (no `world/page.tsx`, so `/world` itself currently 404s — verify this;
if a redirect exists in `next.config.mjs` check it). The redesign's `/world` is a single
tabbed page. Plan: legacy pages stay at `/world/intel` and `/world/map` inside
`(legacy)/`; the new tabbed screen lands at `/world` inside `(next)/`. Next.js allows the
same URL segment to exist in only one route group — `world/` must therefore live in only
one group per path segment: put `(next)/world/page.tsx` and keep
`(legacy)/world/{intel,map}/page.tsx`; they resolve to different paths so this works, but
**verify with `next build`** — if Next complains about the split `world` segment across
groups, fall back to hosting the new page at `(next)/world/page.tsx` and moving the two
legacy pages under it in the same group with the legacy layout applied via nested layout.

### 1.3 Design tokens: no collision, but verify by building

`tokens.css` defines only CSS custom properties (`--page`, `--surface`, `--ink`,
`--accent`, `--gain`, `--cat-1`…) plus one `.tnum` class — safe to import globally in the
root layout (CSS variables are inert until referenced).

The tailwind wiring (header of `screens/_shared/tokens.css`) adds `theme.extend.colors`
keys: `page`, `surface{,2}`, `ink{,2,3}`, `hairline`, `grid`, `accent`, `gain`, `loss`,
`status.{good,warning,serious,critical}`, `cat.{1..4,cash}`, and
`borderRadius: {card, chip}`. I compared these against the existing
`tailwind.config.ts`: current keys are `bg-base`, `bg-card`, `border-subtle`,
`accent-primary`, `text-primary`, `green-signal`, etc. — **zero exact key overlaps**, so
both sets can live in one `theme.extend.colors` block. Two things I could not fully
determine by reading and must be checked by building:

1. `accent` (new, string value) vs `accent-primary`/`accent-violet`/`accent-cyan`
   (existing flat keys). Tailwind resolves the longest-match key, so `bg-accent-primary`
   should still hit the old color and `bg-accent` the new one — but confirm by building
   and visually spot-checking one legacy page (e.g. `/capital/briefing`, which uses
   `accent-primary` in `Sidebar.tsx`).
2. `grid` as a color name coexists with the `.grid` display utility (different utility
   namespaces — `bg-grid` vs `grid`), expected fine; confirm nothing in legacy CSS uses
   an arbitrary `grid` color.

Also: `globals.css` sets `body { background:#010102; color:#f7f8f8 }`. Don't fight it
globally — the `(next)/layout.tsx` wraps children in
`<div className="min-h-screen bg-page text-ink">`. Later (Phase 8) body styles move to
tokens. Light mode: legacy screens are dark-hardcoded, so the theme toggle (`data-theme`
on `<html>`) ships only when legacy routes are retired, or scoped so `(legacy)` always
renders dark.

Font: redesign specifies Inter with system fallback. Root layout currently inlines
`-apple-system…` via `style`. In Phase 0, load Inter via `next/font/google` in the
`(next)` layout only (or accept the system fallback — `design-system.md` allows it).

### 1.4 Types: converge on the producers

Three divergent `DiscoveryJSON` declarations exist (see §5). Migration rule: new screens'
loaders type envelope reads from `@common/types` (`packages/common-types/src/envelopes.ts`),
and **`@common/types` gets updated to match the producers first** (it's currently stale —
missing `closedPositions`, `stopPrice`, etc.). `screens/_shared/types.ts` view-model
types are copied into `src/lib/next/types.ts` minus the marked duplicates. Add
`"@common/types": "workspace:*"` to unified-platform's `package.json` (it doesn't import
it today).

### 1.5 Data loading pattern: keep direct disk reads

The current server-component + `src/lib/data.ts` disk-read pattern is good and matches the
redesign's `data.ts` loader contracts one-to-one. New screens replace each proposal
`data.ts` SAMPLE with reads through `src/lib/data.ts` (extending it with `readRisk()`,
`readHarvest()`, `readCorrelation()`, `readBriefingJson()`, `readGovFlow()` already
exists, etc.). New **API routes** are added only for mutation (promote, accept/reject,
re-run) and for client-fetched series (macro history) — listed per screen below.

---

## 2. Phase 0 — Foundations (no user-visible screen yet)

Everything later depends on this landing once, not per-screen.

1. **Route-group split** per §1.2. Verify: `pnpm --filter unified-platform build`,
   then manually load `/`, `/capital/briefing`, `/capital/portfolio`, `/world/intel`,
   `/world/map`, `/studio/dashboard`, `/admin/pipeline`.
2. **Tokens**: copy `screens/_shared/tokens.css` → `src/app/tokens.css`, import in root
   layout after `globals.css`. Merge the header's `theme.extend` snippet into
   `tailwind.config.ts`. Build + spot-check per §1.3.
3. **Shared primitives**: copy `screens/_shared/{ui.tsx,charts.tsx,format.ts}` →
   `src/components/next/` (or `src/lib/next/` for `format.ts`), and `types.ts` →
   `src/lib/next/types.ts` with `@common/types` imports substituted for the marked
   duplicates. These files have no external deps beyond React — they are drop-in.
4. **New shell** `src/app/(next)/layout.tsx` + `src/components/next/AppShell.tsx`:
   sidebar with the `design-system.md` §1 sections (TODAY / PORTFOLIO / MARKETS / WORLD /
   DISCOVER / SYSTEM + Creator Studio app-switcher footer), and the **global status
   strip**. During migration, add a temporary "Legacy UI" link so both UIs are one click
   apart.
5. **Status strip v1** needs an extended `GET /api/status` returning:
   `{ netWorthUsd, usdThb, washSale: [{ticker, daysRemaining}], freshness: {lastRunAt, ok} }`.
   All of that is already on disk: NW + FX from `simulation.json`, wash-sale from
   `tax/harvest.json` (`washSaleAlerts`), freshness from `@common/pipeline-runs`
   (`data/pipeline-runs.db` — unified-platform already depends on the package; the
   `/admin/pipeline` page shows how to read it). Day-change renders `—` until gap #3.
   Extend the existing route rather than adding a second one; keep the `stale` field so
   the legacy `TopNav` keeps working.
6. **⌘K palette v1** (screens + ticker jump only, `fuse.js` is already a dependency;
   free-text ask defers to the Ask phase). Optional in Phase 0 — do not block screens on it.

**Rollback:** revert the route-group commit. Nothing else in the app changed behavior.

---

## 3. Screen-by-screen order and rationale

Ordering principles: (a) data-ready + net-new-URL screens first (zero risk, immediate
value); (b) the briefing — highest value — goes as soon as its one blocking backend
emitter exists; (c) screens whose mockups are stale vs. tonight's backend (discovery,
trade) get their data-model rework *in the plan*, not discovered mid-build; (d) screens
blocked on missing APIs (theses) are scheduled after their backend work; (e) studio last —
different theme, different audience, zero coupling.

| # | Screen | New route | Blocking backend | Why this position |
|---|--------|-----------|------------------|-------------------|
| 1 | Risk | `/portfolio/risk` | none for v1 (`risk.json` exists); #8 for heatmap/clusters | **Net-new route** — no current risk page exists at all. Zero rollback risk, real data ready, second-most-consulted content per backend-gaps. |
| 2 | Portfolio | `/portfolio` | none for v1; #3/#4 for day-change + sparklines; #5 targets | Same `simulation.json` the current page reads; refresh API already exists. High value, data fully ready. |
| 3 | Macro | `/markets` | none for tiles; #18 (needs #4) for 90d series; #19 thresholds; #20 SET/THB | `macro.json` read exists (`readMacro`). Tiles ship real, sparklines render `null`-state until the series endpoint exists (the mockup's contract already handles `series90d: null`). |
| 4 | Briefing | `/today` | **#1 structured briefing JSON** (emitter in investment-analyst-agents) | The home screen and the point of the system. Do NOT ship it on the 5-envelope stitch — build the emitter first (see §4); the markdown fallback renders in the meantime at `/capital/briefing` untouched. |
| 5 | Waves | `/markets/waves` | none for v1 (`waves.json`/`wave-actions.json` exist); #21 hit-rate + conflict join (conflict needs #1) | Data ready; conflict banners degrade to hidden until #1+#21. Replaces `/capital/waves`; the `[ticker]` detail page is kept as-is initially (link out). |
| 6 | Trade | `/markets/waves/trade` | none to read (`trades.db` via better-sqlite3, already a dep); #21b sizing-policy adoption in `cli-trade.ts` | Read-only paper-trade audit. Mockup's sizing panel renders *back-computed* risk (`shares × |entry−stop|`) — honest today even before the CLI adopts the policy. |
| 7 | Gov | `/markets/gov` | none for awards table (`govflow.json`); #22 monthly aggregation + bill-status fetcher for the stepper | Awards table + 30d stats ship real; monthly bars + NDAA stepper render behind an explicit "pending #22" empty state, or the stepper ships static-curated with an "as of" stamp (it's briefing-narrated data). |
| 8 | Discovery | `/discover` | mockup rework vs. new backend (§5) + #14 promote + #15 bear persistence + #16 series | **Deliberately later than its round-1 build order**: the screen needs a data-model revision first (§5). Ship read-only v1 (no promote) matching the new backend; promote dialog in v2 gated on #14. |
| 9 | World | `/world` | none for list/storylines v1; #23 geocoding/backlinks; #23b unwired-layer renderers | Big screen (3 tabs + map). Reuses the existing worldmap layer components/registry (`src/worldmap/`) inside the new Map tab — port, don't rewrite. Briefing↔event backlinks upgrade from title-join to eventId-join when #1 lands. |
| 10 | Theses | `/portfolio/theses` | **#13 thesis API + persisted proposals with accept/reject** | The screen's whole point is the review queue; without #13 it's a worse version of the current `/capital/thesis`. Backend first, then screen. |
| 11 | Studio | `/studio` | #26 board status column + performance entries (creator-studio Prisma) | Isolated theme (`studio-tokens.css`, `.studio-theme`), separate Prisma DB, gated by middleware. Zero interaction with investment screens — safe to do last, or in parallel by a second agent. |

**Spec-only screens** (build after the 11, in this order):
- **Tax** `/portfolio/tax` — `harvest.json` exists and matches the spec; ship early if
  capacity allows (it's actually data-ready; only #10/#11/#12 refinements pending). Can
  slot in right after Portfolio.
- **Pipeline** `/system/pipeline` — needs #25 (`GET /api/pipeline/dag` serializing
  `packages/queue/src/jobs.ts` `DAILY_PIPELINE`, `GET /api/pipeline/runs`); the current
  `/admin/pipeline` page stays until then. Note the DAG endpoint is cheap: `jobs.ts` is
  importable data (24 stages with `dependsOn`/`skipIf`).
- **Dependency graph** `/discover/graph` — port `GraphClient.tsx`
  (react-force-graph-2d already a dep) to the ego-network-first spec; needs #17 for the
  theme-exposure footer.
- **Ask** (⌘K escalation + `/ask`) — mostly backend (#24); keep `/capital/ask` alive
  until the tool-calling endpoint exists. Do not retire the old page before this.

**Nav-shell dependency answer:** yes, the shell (Phase 0) must exist before *any* screen
ships, because every redesigned page assumes the sidebar + status strip and the
`bg-page` wrapper. But it does NOT need to be complete — status-strip v1 with `—` for
day change and a screens-only ⌘K is enough. The shell is additive (route group), so it is
not an all-or-nothing swap with the old nav: old and new shells coexist for the entire
migration, one per route group.

---

## 4. Backend work mapped to screens, in build order

Gap numbers are from `design-redesign-2026-07/backend-gaps.md` (verified — the list has
25+ numbered gaps; the ranked top-5 at its bottom is #1, #4, #14+#15, #13, #8).

**Status changes since backend-gaps.md was written (tonight's discovery work):**
- Gap #2 (calibration export): **effectively done** — `backtest/calibration.json` exists
  with `byAction`/`byConviction` × 7d/30d accuracy. Remaining work: document the schema
  and wire `ConvictionBadge` to it. Unblocks calibrated badges everywhere *now*.
- Gap #16 (paper benchmark): **half done** — `benchmarkPriceAtOpen/AtClose` per position
  landed; the daily paper-value *series* still needs #4.
- New artifact not in backend-gaps.md: `discovery-calibration.json`
  (`DiscoveryCalibration` from `src/discovery/calibration.ts` — score-band win rates)
  will appear at `scenario-simulator/data/` after the next Sunday run. The Discovery
  screen's decision-quality section should read it instead of recomputing.
- Gap #15 (persist the bear): **still open but changed shape** — `AdversarialReview`
  (bearScore, topConcerns, bearNarrative) is generated in `discovery-reviewer.ts` but only
  survives inline in `rationale` strings (`"[ADVERSARIAL: bear score 41, …]"`). The clean
  fix is now: add bear fields to `DiscoveryExportCandidate` + a `discovery_reviews` table.

**Build order (sequenced so each screen's data precedes or accompanies its frontend):**

| Order | Backend item | Gap # | Where | Unblocks screen(s) |
|---|---|---|---|---|
| B0 | `correlation.json` emitter (matrix + clusters + top pairs) alongside `report.md` | #8 | `apps/investment-analyst-agents/src/correlation/correlation-runner.ts` (it already computes the matrix; add a `writeFileAtomic` of JSON next to `REPORT_PATH`) | Risk (heatmap + cluster banners; Risk v1 ships without it) |
| B1 | Calibration schema doc + `ConvictionBadge` join | #2 | document `backtest/calibration.json`; loader in unified-platform | Briefing, Portfolio agent-view, everywhere |
| B2 | **Structured briefing JSON** — emit `briefings/YYYY-MM-DD.json` from the same model pass that writes the markdown | #1 | `apps/investment-analyst-agents` briefing agent | Briefing (blocking), Waves conflict-join, World backlinks, Theses status rows |
| B3 | **Time-series store** — daily close per held symbol + daily NW snapshot (the risk runner already fetches 90d from Yahoo daily and discards it) | #4 (+#3, #18, #16-series) | new table via `@common/db` (Postgres, SQLite fallback), written by `risk-metrics` or `scenario-refresh` stage in `packages/queue/src/jobs.ts` | Portfolio (day change, sparklines), Macro (`GET /api/macro/:id?range=90d`), Discovery (vs-SPY strip), status strip day-Δ |
| B4 | Target-allocation config (`targets.json` or table) | #5 | investment-analyst-agents or scenario-simulator data dir | Portfolio drift bars (v1 can hardcode the 2026-plan targets exactly as the mockup does, flagged) |
| B5 | Discovery bear persistence + score history + watch/dismiss states | #15 | scenario-simulator (`discovery_reviews` table + export fields) | Discovery v1.5 |
| B6 | **Promote-to-real endpoint** `POST /api/portfolio/promote` (wash-sale + jurisdiction pre-check → trade_log BUY → `closePosition(ticker, price, 'promoted to real')` → seed thesis-memory) | #14 | unified-platform API route shelling to a new scenario-simulator CLI (follow the `api/portfolio/refresh` pattern incl. the `DATABASE_URL` fix; add route to middleware matcher) | Discovery v2 (promote dialog) |
| B7 | **Thesis API** — `GET /api/theses` (thesis + assumptions + dated status history), persisted proposals as rows, `POST .../proposals/:id/(accept\|reject)` + audit log | #13 | thesis-memory (add an export or let unified-platform extend `src/lib/thesis-db.ts` for reads; writes need a thesis-memory CLI or direct-DB write with care) | Theses |
| B8 | Gov: vendor→ticker map + monthly aggregation + bill-status fetcher | #22 | government-flow-monitor | Gov v2 (stepper + monthly bars) |
| B9 | Wave hit-rate aggregation + typed `WaveJSON` in `@common/types`; `cli-trade.ts` adopts fixed-fractional sizing | #21, #21b | wave-analyzer | Waves v2, Trade v2 |
| B10 | World: storyline causal edges, geocoding improvements | #23 | world-intelligence-data-hub- | World v2 |
| B11 | Pipeline DAG/runs/re-run endpoints | #25 | unified-platform reading `packages/queue/src/jobs.ts` + `@common/pipeline-runs` | Pipeline screen |
| B12 | Ask agent endpoint (read-only tools + pgvector retrieval + SSE + cost cap) | #24 | new — biggest single backend item after #1/#4 | Ask |
| B13 | Studio schema: board `status`, post-performance, media | #26 | creator-studio `prisma/schema.prisma` (+ `npx prisma generate` in-app, per CLAUDE.md) | Studio |
| B14 | Tax: persist `avg_cost` into trade_log at sell (realized-loss undercount), marginal-rate config, harvest history | #10–12 | scenario-simulator / investment-analyst-agents | Tax refinements (screen ships before these) |

Also do early (cheap, correctness): **sync `@common/types` `DiscoveryJSON`** to
`apps/scenario-simulator/src/discovery/types.ts` (add `closedPositions`,
`benchmarkPriceAtOpen`, `stopPrice`, `targetPrice`, `adjustedConviction`), and have
unified-platform import it instead of its stale local copy (§1.4).

---

## 5. Discovery/Trade/Waves: mockup vs. tonight's upgraded backend (verified mismatches)

The discovery screens were built **before** tonight's backend upgrade. I diffed the
mockup contracts against `apps/scenario-simulator/src/discovery/` as it exists now:

1. **The paper book is EMPTY.** `data/discovery.json` (exported 2026-07-07T06:48Z) has 0
   positions, 0 closed, 0 candidates; the 16-position cohort the mockup renders was
   archived to `data/discovery-cohort-0-archive.json` ("Cohort 0 reset — …produced
   exactly one decision datapoint"). The screen's *primary launch state* is therefore an
   empty book awaiting cohort 1 under the new policy — the mockup's empty states exist
   but were designed as edge cases. The v1 screen should render the cohort-0 archive as
   an explicit "previous cohort" history section (the archive file has
   `{archivedAt, reason, positions, runsHistory}`), not pretend the book was never filled.
2. **`closePosition()` now exists** (`paper-portfolio.ts`), with automated exits wired in
   `cli-discover.ts`: `checkMechanicalExits` (stop hit, 180-day time-stop from
   `exit-checks.ts`) and LLM thesis re-review exits ("thesis broken"). The mockup's
   `exitNote` ("the agent literally cannot exit today"), the `watching[]` copy about
   being read-only, and `performance.closed = []` commentary are **stale — delete/replace**
   during integration. Exit triggers should render the real constants
   (`TIME_STOP_DAYS = 180`, `THESIS_CHECK_DOWN_PCT = 0.10`, `THESIS_CHECK_HELD_DAYS = 90`)
   instead of the mockup's aspirational rules (which differ: mockup says 90-day
   time-stop and −25% drawdown).
3. **Sizing model changed.** The mockup's `computeSizing()` and `sizing-rationale.tsx`
   replay the old score-band-only allocator (12%/8%/5% of maxDeployable). The real
   allocator (`risk-sizing.ts` + `cli-discover.ts`) is now:
   `riskBudget = budget × RISK_PER_TRADE_PCT (0.02)`;
   `stop = entry × (1 − 2σ_daily√5)`; `notional = min(riskBudget/(entry−stop) × entry,
   scoreBandCap) × CONVICTION_MULTIPLIER[adjustedConviction]` — with two further gates:
   theme-concentration cap (`THEME_CONCENTRATION_CAP = 0.30` of paper deployable, from
   `theme-tracker.ts`) and a 50% haircut when the theme already exceeds 25% of the *real*
   portfolio. The `SizingRationale` interface and `SizingBlock` term-chain UI must be
   extended to render this richer derivation (σ, stop, target, conviction multiplier,
   theme-cap/haircut annotations). The design *principle* (render every term) carries over
   unchanged; the terms don't.
4. **New per-position fields to render:** `stopPrice`, `targetPrice`,
   `adjustedConviction`, `benchmarkPriceAtOpen` on `DiscoveryPosition`;
   `DiscoveryClosedPosition` has `exitReason`, `benchmarkPriceAtClose`. Mockup's
   `ClosedPaperPosition` is close but uses `scoreAtOpen` (real: `score`) and lacks the
   benchmark/stop fields. Decision-quality section should compute per-trade
   vs-SPY from the benchmark columns and read `discovery-calibration.json` (band win
   rates, `MIN_N_FOR_VERDICT = 5`) once it exists.
5. **Theme view has a real source now**: `theme-tracker.ts` +
   `capital-intelligence-ingestion/data/themes-map.json` — the `AgentBookView.themes`
   aggregation should use the same `themesMap`, not a hand-grouped list.
6. **Trade screen** (`screens/trade/`): its honesty note (#21b) is still accurate —
   verified `wave-analyzer/src/cli/cli-trade.ts` still requires manual `--shares`. The
   proposed 2%-fixed-fractional policy now has an in-repo precedent
   (`RISK_PER_TRADE_PCT` in discovery), strengthening the case to adopt it in B9. The
   screen's back-computed risk display works today regardless.
7. **Waves screen**: no backend drift — `waves.json`/`wave-actions.json` shapes match;
   conflict banners stay hidden until #1 lands (the join needs structured briefing
   actions).

---

## 6. Concrete integration guidance per screen

Common pattern for every screen: copy `screens/<name>/` → `src/app/(next)/<route>/`,
rewrite `data.ts` to read real envelopes via `src/lib/data.ts` (delete SAMPLE constants),
change `../_shared/*` imports to `@/components/next/*` / `@/lib/next/*`, keep the page a
server component with `export const dynamic = 'force-dynamic'` (matching current-app
convention so envelope reads are never cached stale).

### 6.1 Risk — `/portfolio/risk` (new file: `src/app/(next)/portfolio/risk/page.tsx`)
- Add `readRisk(): RiskJSON` to `src/lib/data.ts`
  (path `investment-analyst-agents/risk/risk.json`).
- `totalNetWorthUsd` for the honesty banner: compute from `readSimulation()` the same way
  `/capital/portfolio` and `/` do (`inUsd` helper) — do not hardcode.
- `topPairs`/`clusters` render an explicit "correlation matrix pending (#8)" section
  until B0 lands; then `readCorrelation()`.
- Keep: nothing replaced — there is no existing risk page. Add a "Risk" link to the
  legacy sidebar too (cheap cross-link, optional).

### 6.2 Portfolio — `/portfolio`
- Loader: `readSimulation()` (positions + `usdThb`). `dayChangeUsd`/`netWorthSeries30d`
  stay `null` (mockup handles it) until B3.
- `targets`: hardcode the 2026-plan buckets exactly as the mockup does with a
  "hardcoded — gap #5" footnote, or land B4 first.
- Agent view: reads the same briefing envelope as `/today` after B2; before B2, derive
  from `simulation.json` actions (same source the current portfolio page uses) and omit
  the calibration line.
- Refresh-prices button (`refresh-prices.tsx`): wire to the **existing**
  `POST /api/portfolio/refresh` — do not create a new route; it already handles
  market-hours 409 and the `DATABASE_URL` pitfall.
- Existing `/capital/portfolio` and its components (`PortfolioTable`,
  `PortfolioOverview`, `AllocationChart`, `RefreshPricesButton`) remain untouched until
  cutover.

### 6.3 Macro — `/markets`
- Loader: `readMacro()` + `readAnalysis().latestRegime` for the regime strip.
- `series90d: null` until B3 exposes `GET /api/macro/:id?range=90d` (new API route
  reading the time-series table; client-side fetch on tile expand).
- Thresholds (#19): v1 hardcodes the four briefing tripwires (VIX>20, 10Y>4.7,
  sentiment<45, WTI>100) in one exported constant with a `// GAP #19` marker so the
  eventual `watch-thresholds.json` swap is one-line.
- SET/THB tile renders the mockup's explicit `gap` state (#20).
- Replaces `/capital/macro` at cutover; keep `EconomicIndicatorGroups`/
  `LiquidityIndicatorCards`/`MacroAssetCard` components until then.

### 6.4 Briefing — `/today` (after B2)
- Loader: `readBriefingJson(date)` (new, `briefings/YYYY-MM-DD.json`) + fallback: if JSON
  missing but markdown exists (pre-B2 days, or emitter failure), render the markdown-only
  legacy view inside the new chrome — never a blank home screen. Keep `todayLocal()`
  (the en-CA local-date lesson is encoded there).
- `narrativeMd` = the markdown file, rendered with the existing `react-markdown` +
  `remark-gfm` + `.briefing-prose` styles (port `.briefing-prose` colors to token vars
  when convenient; keep as-is initially).
- Wash-sale panel: `readHarvest().washSaleAlerts`; pulse: `readRisk()`; world top:
  from briefing JSON eventIds joined against `readWorldIntel()`.
- `ConvictionBadge` accuracy: from `backtest/calibration.json` (B1).
- Cutover (later): make `/` redirect to `/today` and `/capital/briefing` redirect too —
  this is the **last** cutover in the whole plan (§7).

### 6.5 Waves — `/markets/waves` and 6.6 Trade — `/markets/waves/trade`
- Waves loader: `readWaves()` + `readWaveActions()`; `held`/`paper` flags by joining
  `readSimulation().portfolio` and `readDiscovery().discoveryPortfolio` tickers
  (incl. the GC=F ↔ GOLD_OZ proxy mapping — put it in one exported constant).
- Trade loader: read `wave-analyzer/data/trades.db` with `better-sqlite3` (already a
  dependency) or `readWavePortfolio()` if it carries the full trade rows — prefer the
  JSON envelope if sufficient, DB only if the envelope lacks stops/outcomes.
- Keep `/capital/waves/[ticker]` (lightweight-charts detail) as-is; link to it from the
  new table rows. Port it into `(next)` only in a cleanup pass.

### 6.7 Gov — `/markets/gov`
- Loader: `readGovFlow()`. `held`/`paper` flags as in Waves. Monthly bars and NDAA
  stepper: render only if B8 data exists; otherwise the awards table + 30d StatTiles
  ship alone (they're the daily-use part).

### 6.8 Discovery — `/discover` (after the §5 rework; two stages)
- **v1 (read-only):** loader reads `discovery.json` (new shape incl. `closedPositions`),
  `discovery-cohort-0-archive.json` (history section), `discovery-calibration.json`
  (decision quality; tolerate absence), and replays sizing with the **new** derivation
  (§5.3) — port `computeRiskBasedAllocation`/constants into the loader or re-export them
  from a small shared module rather than duplicating (they live in scenario-simulator;
  simplest correct option: copy the pure functions and constants with a header comment
  naming the source file, since unified-platform shouldn't import app-internal code
  across apps — or move them to `@common/types`-style shared package if drift risk
  matters more).
- **v2:** `promote-dialog.tsx` wired to B6's `POST /api/portfolio/promote`; add the
  route to `middleware.ts` matcher; dialog already requires typing the ticker to confirm.
- Replaces `/capital/discovery` at cutover.

### 6.9 World — `/world`
- List + Storylines tabs: loader per `screens/world/data.ts` header —
  `readWorldIntel()` + memory-agent enrichment files
  (`world-intelligence-data-hub-/intelligence/outputs/events/<date>.json`, joined by
  title exactly as `investment-analyst-agents/src/briefing/world-storylines.ts` does) +
  ticker exposure via the existing `/api/trade-graph` pg route.
- Consumption chips: regime-side from `analysis.json`'s world-intel context (verify the
  field exists in `AnalysisJSON`; if the regime prompt's event list isn't exported,
  that's a small addition to ai-analysis-engine — flag it, don't fake it);
  briefing-side title-join pre-B2, eventId-join post-B2.
- Map tab: reuse `src/worldmap/` layer components and
  `layers/_core/registry.ts` (the redesign's `map-layers.ts` copies its metadata
  verbatim and documents per-layer provenance). Implement the two registry changes the
  redesign specifies: decouple `conflict-zones` from `conflicts` visibility, and add
  renderers for the 3 unwired datasets (`energy-mix`, `water-stress`,
  `investment-signals` from `data/validated/` — gap #23b).
- Keep `/world/intel` + `/world/map` alive until the tabbed page has been used across a
  few real mornings — the map stack (maplibre + react-simple-maps + zustand stores) is
  the most complex UI in the app and the likeliest place for regressions. Mind §1.2's
  route-group caveat about the shared `world` segment.

### 6.10 Theses — `/portfolio/theses` (after B7)
- Loader: B7's `GET /api/theses` (or direct read through an extended
  `src/lib/thesis-db.ts` for v1 board + drawer, with the review queue appearing only
  once proposals persist). Related-names panel: `readGraph()` edges.
- The existing `/api/thesis-proposals` (on-demand LLM proposals) is a different feature;
  B7 should *persist* proposals (generated by the pipeline's thesis-memory stage or by
  that route) so the queue survives reloads. Accept/reject routes go in the middleware
  matcher.
- Replaces `/capital/thesis` at cutover.

### 6.11 Studio — `/studio`
- The redesign targets unified-platform's `/studio/*` (own Prisma client at
  `src/generated/prisma`, per the defused cross-app landmine — import from there, never
  `@prisma/client`). Schema changes (B13) happen in **apps/creator-studio's**
  `schema.prisma`? No — verify which schema owns these tables: unified-platform has its
  own `prisma/schema.prisma` (modified in git status) and `src/lib/studio/db.ts` reads
  the app-local client, so the board/performance models belong to
  **unified-platform's** schema; creator-studio's separate DB is a different app.
  Confirm before migrating (`prisma/schema.prisma` in both apps; run
  `npx prisma generate` in whichever app's schema changes).
- `studio-tokens.css` is `.studio-theme`-scoped — import it in the studio route's layout
  only; it cannot leak. The new board coexists with `/studio/dashboard` +
  `/studio/archive` (keep the chat/growth features; the redesign board replaces the
  landing `/studio/page.tsx` only).
- Already behind `APP_ACCESS_KEY` middleware — no auth work.

---

## 7. Risk / rollback

### Risk tiers

- **Tier 0 (safe, ship freely):** everything in `(next)/` before cutover — net-new URLs
  nobody's workflow depends on. Rollback = delete the route directory. This is tiers
  for ALL 11 screens as initially shipped.
- **Tier 1 (global but mechanical):** Phase 0 route-group split, tailwind extend, tokens
  import, `/api/status` extension. These touch every page's build. Mitigation: single PR,
  full `next build`, manual smoke of every legacy route, and the status route stays
  backward-compatible (`stale` field kept for legacy `TopNav`). Rollback = revert commit.
- **Tier 2 (touches real-money write paths):** promote endpoint (B6), thesis
  accept/reject (B7), pipeline re-run (#25). Each writes to trade_log/thesis-memory/queue.
  Mitigations already in the design: confirm dialogs show exactly what will be written,
  wash-sale pre-check, type-the-ticker confirmation. Additionally: middleware-gate all
  three, and have B6's CLI write an audit line (append-only JSONL) before the DB write.
  Rollback: these are additive endpoints — disable by removing the route file; data
  written is inspectable/reversible via trade_log rows.
- **Tier 3 (the actual cutovers, one screen at a time, LAST for each screen):** redirect
  old URL → new URL (`next.config.mjs` `redirects()` or a page-level `redirect()`).
  Order cutovers by confidence, not by build order: Risk/Tax (no old page — nothing to
  cut), then Macro/Waves/Gov/Trade, then Portfolio/Discovery, then World, then
  Briefing + `/` last (the morning-read route changes only after every downstream link
  target it references already lives in the new UI). Rollback of any cutover = remove
  the redirect; the legacy page code is still in the tree. **Do not delete
  `(legacy)/capital/*` code until all cutovers have survived at least a week of real
  morning use.**

### Specific watch-items

- **Route-group `world` segment split** (§1.2) — the one Next.js-mechanics unknown in
  this plan; resolve empirically in Phase 0.
- **Tailwind key adjacency** (`accent` vs `accent-primary`) — verify at build (§1.3).
- **`force-dynamic` + disk reads**: keep this convention on all new pages; a statically
  cached briefing is the exact class of silently-stale failure this system is designed
  against.
- **`DATABASE_URL` for any new route that shells to a CLI**: copy the
  `api/portfolio/refresh/route.ts` env block verbatim (it exists because of the CRWD-split
  incident — per-app CLIs silently fall back to stale SQLite without it).
- **Discovery cohort-1 timing**: the book refills on Sunday runs; if Discovery v1 ships
  mid-week it must look intentional when empty (§5.1).
- Light mode ships only post-cutover (legacy pages are dark-hardcoded; §1.3).

---

## 8. Phase summary (hand-off checklist)

1. **P0** Foundations: route groups, tokens+tailwind, `_shared` port, shell + status
   strip, `/api/status` v2. Verify every legacy route.
2. **P1** Risk (+B0 correlation.json follows), Portfolio, Tax (spec), Macro. All
   data-ready; all net-new or coexisting.
3. **P2** B2 structured briefing JSON → Briefing at `/today`. B1 calibration join.
4. **P3** Waves, Trade, Gov (v1 scope per §6).
5. **P4** §5 discovery rework + Discovery v1 (read-only); B3 time-series store lands in
   parallel (feeds Portfolio/Macro/Discovery retrofits); then B6 promote → Discovery v2.
6. **P5** World (reusing `src/worldmap/` layers), then B7 thesis API → Theses.
7. **P6** Studio (+B13), Pipeline (`/system/pipeline`, +B11), Dependency graph.
8. **P7** Ask (+B12), ⌘K free-text escalation.
9. **P8** Cutovers per Tier 3 order; retire `(legacy)` after a week of clean use;
   enable light-mode toggle; delete stale local types.

Backend items B4/B5/B8/B9/B10/B14 slot into whichever phase has capacity — none of them
block a screen's v1.
