# AI Capital — Frontend Redesign Proposal (2026-07)

Clean-slate design for `unified-platform`, grounded in the pipeline's real
data envelopes and the system's purpose (docs/ROADMAP.md, SYSTEM-STATE.md,
financial-plan-2026-07-06.md) — **not** derived from the current UI. Nothing
here touches `apps/unified-platform/`; this folder is a reviewable proposal.

## Contents

| Path | What it is |
|---|---|
| `design-system.md` | IA / nav structure, validated color system, typography, spacing, component patterns, Creator Studio decision |
| `backend-gaps.md` | Everything the design needs that the backend doesn't produce yet, by screen, with a ranked top-5 |
| `screens/_shared/` | Drop-in code: `tokens.css` (+ tailwind wiring), `format.ts`, `types.ts`, `ui.tsx` (primitives), `charts.tsx` (SVG charts) |
| `screens/briefing/` | **Full build** — /today home route (page + data contract) |
| `screens/portfolio/` | **Full build** — holdings, allocation donut, target drift, refresh-prices, grouped expandable table, **agent view** (the investment agent's positioning belief, next action, and scenario playbook for the REAL book, cross-linked with /today) |
| `screens/risk/` | **Full build** — honesty banner, stat row, weight bars w/ 30% limit, vol×weight scatter, correlation section |
| `screens/discovery/` | **Full build** — paper stats, bull/bear candidate queue + **sizing rationale** (cli-discover allocation chain rendered term-by-term), **agent's book view** (the discovery agent's own paper-book positioning, theme concentration, exit triggers — self-contained, no real-portfolio references), promote-to-real dialog, paper table w/ size bands, **decision-quality section** (realized vs unrealized split, closed-only win rate, benchmark gap, score-calibration scatter — honest about zero closed positions) |
| `screens/theses/` | **Full build** — /portfolio/theses: proposal review queue (diff-style), held board + drawer (assumptions, evidence timeline), watchlist/exited history, graph-derived related names |
| `screens/waves/` | **Full build** — /markets/waves: Elliott-Wave signal scan, confidence/fib columns, briefing-conflict banners, watching strip |
| `screens/trade/` | **Full build** — /markets/waves/trade: signal-only paper trader; every position shows triggering signal + risk-math sizing; closed-trade outcomes; keep-or-kill audit panel |
| `screens/macro/` | **Full build** — /markets: regime strip, grouped indicator tiles w/ tripwires (sentiment 44.8 crossed), click-to-expand detail chart |
| `screens/gov/` | **Full build** — /markets/gov: 30d award stats, monthly flow bars w/ held segment, filterable awards table, NDAA legislation stepper, PLTR watch-trigger progress |
| `screens/world/` | **Full build** — /world: List ⇄ Map ⇄ Storylines tabs, shared inspector; every event carries its **consumption state** (regime context block / briefing top-5) — the two-consumer linkage is the screen's whole point |
| `screens/studio/` | **Full build** — /studio: Creator Studio pipeline board + week calendar + post analytics in its own deliberately distinct theme (`studio-tokens.css`, `.studio-theme` scope) |
| `screens/specs/*.md` | Written specs for the 4 remaining areas: tax, dependency-graph, ask, admin-pipeline. (theses / wave-signals / macro-markets / gov-contracts / world-intel / creator-studio specs are superseded by the builds above — their content now lives in the screens' header comments.) |

## How to adopt a screen

1. Copy `screens/_shared/` into `apps/unified-platform/src/` (merge
   `types.ts` with `@common/types` imports — the duplicates are marked).
2. Add the token block from `tokens.css` and the tailwind `theme.extend`
   snippet in its header comment.
3. Copy the screen folder to the matching App Router route; replace each
   `data.ts` sample loader with real envelope reads (paths documented in
   each file's header).
4. Chart palettes were validated with the dataviz six-check validator on
   2026-07-06 (4-slot categorical: PASS dark, PASS-with-relief light — direct
   labels are mandatory on allocation charts, already built in).

## Reading order for review

`design-system.md` → `screens/briefing/page.tsx` → `screens/portfolio/` →
`backend-gaps.md` (ranked top-5 at the bottom decides what to build first).
