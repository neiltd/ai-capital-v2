# Thailand Read in the Daily Briefing — Implementation Plan (Phase 2)

**Goal:** The daily analysis/briefing carries a short, grounded **Thailand read** — not just the US/global regime — since the real portfolio is ~59% THB and the owner's human capital is 100% THB.

**Architecture:** Fold a grounded `thailandRead` string into the **existing** `analyzeRegime` LLM call (no new pipeline stage, no new API call, no cost delta). Phase 1 already put TH indicators (household debt, real-effective baht) into `macro.json`; SET Index + USD/THB were already there. This phase gives the model those TH signals in a clean dedicated section and asks for a 2-3 sentence Thai read, then surfaces it in the briefing. A fully separate Thai regime classifier is a possible future refinement; deliberately out of scope here (YAGNI).

**Grounding:** Reuse the existing GROUNDING RULE — the Thai read may only cite numbers that appear in the supplied TH data (this is the same discipline that fixed the oil-price fabrication).

---

## Task 1 — Envelope field (common-types)
- **Modify:** `packages/common-types/src/envelopes.ts` — add `thailandRead?: string` to `AnalysisJSON.latestRegime` (optional → backward-compatible with existing `analysis.json` files; loaders warn-not-fail on schema drift anyway).

## Task 2 — Domain type (ai-analysis-engine)
- **Modify:** `apps/ai-analysis-engine/src/types.ts` — add `thailandRead: string` to `MacroRegime`.

## Task 3 — Analyzer (ai-analysis-engine)
- **Modify:** `apps/ai-analysis-engine/src/analysis/regime-analyzer.ts`
  - Add `region?: string` to the `MacroContext.economicIndicators` inline type (so TH indicators can be filtered).
  - Add `formatThailand(macro)`: pull `economicIndicators` where `region === 'TH'` plus the SET Index (`^SET.BK`) and USD/THB (`THB=X`) market assets into a clean `## Thailand Snapshot` section. If none present, omit the section.
  - Extend `SYSTEM_PROMPT`: instruct the model to also produce `thailandRead` — a 2-3 sentence read of Thai macro/market conditions relevant to a THB-heavy book (household-debt trajectory, baht direction, SET tone), obeying the existing grounding rule. If no Thai data is supplied, return `"No Thai data available this run."`
  - Add `thailandRead: { type: 'string' }` to `CLASSIFY_TOOL` properties + `required`.
  - Include the Thailand section in the user message (after the macro section).
  - Return `thailandRead: input.thailandRead` in the `MacroRegime` result.

## Task 4 — Briefing render (investment-analyst-agents)
- **Modify:** `apps/investment-analyst-agents/src/briefing/briefing-agent.ts` — after the `## Macro Regime` block (~line 334), add a `## Thailand` block rendering `r.thailandRead` when present. Keeps the Thai read visible in the prose the owner actually reads.

## Verification
- `pnpm --filter @common/types typecheck` + typecheck ai-analysis-engine + investment-analyst-agents — all green.
- Targeted runtime check: a throwaway script calling `analyzeRegime([], { macroAssets })` with the live `macro.json` (which now carries TH indicators) → confirm `thailandRead` comes back non-empty and only cites supplied TH numbers. (One API call; `ANTHROPIC_API_KEY` exported from root `.env`.)

## Out of scope (future)
- A standalone Thai regime classifier / separate `latestThailandRegime` object.
- BoT policy rate + auto production (need BoT/FTI sources, not FRED).
- Dashboard rendering of the Thai read (briefing prose first).
