# Fix fabricated oil-price figures in the daily briefing

## Context

Two consecutive daily briefings (`apps/investment-analyst-agents/briefings/2026-07-20.md`
and `2026-07-21.md`) asserted specific dollar-denominated oil prices that do
not match the real WTI price for that day, and used those wrong numbers to
justify the top-priority action item (AOT.BK: "jet fuel headwind"). This
directly affects a real trade decision, discovered while asking Atlas
(macro subagent) and Ledger (portfolio subagent) for a pulse-check on
2026-07-20's briefing.

- **2026-07-20**: briefing says "WTI above $90" (repeated 6 times: Macro
  Regime, World Intelligence, AOT.BK thesis, Scenario Outlook's own
  "$85-95" trigger band, and the PRIORITY action item). Real WTI close that
  day: **$81.46**, down 12.4% over 30 days — a tailwind for jet fuel costs,
  not the headwind the thesis is built on.
- **2026-07-21**: briefing says "Oil above $88-95" (World Intelligence
  table, GULF.BK/AOT.BK/KFINDIA-A thesis notes, action items) plus
  invented scenario thresholds (<$80 best case, >$110 disruption, >$95
  recovery ceiling). Real WTI close that day: **$84.66**, up 1.72% on the
  day — actually *below* the "$88-95" floor the brief claims it's "above."

## Root cause — two independent failure points, confirmed by tracing both days

**2026-07-20's number was fabricated in `ai-analysis-engine`.**
`apps/ai-analysis-engine/src/cli/cli-run.ts:127-132` loads the real, live
WTI price from `apps/macro-asset-monitor/data/macro.json` (via
`formatMacroAssets()`, `apps/ai-analysis-engine/src/analysis/regime-analyzer.ts:141-172`)
and renders it into the classification prompt as a plain number with
**no `$` sign** (e.g. `WTI Crude Oil 81.46(-0.62% -12.45% 30d ↓)`). The
`classify_macro_regime` tool's `rationale`/`keyIndicators` fields
(`regime-analyzer.ts:85-99`) are free text with **no instruction
constraining the model to only cite figures present in the supplied
data** — the `SYSTEM_PROMPT` (`regime-analyzer.ts:57-83`) has no
anti-fabrication guardrail at all. Confirmed via
`apps/ai-analysis-engine/data/reports/2026-07-20.md:4,10`, which contains
the exact hallucinated text ("oil above $90", "gasoline above $4/gallon")
even though **no gasoline price series exists anywhere in this repo** —
grepped every fetcher in `macro-asset-monitor` and every export in
`world-intelligence-data-hub-`, zero hits. "17 American casualties"
similarly appears in no world-intel export that day. This is textbook
LLM narrative embellishment on a vague "war is escalating" signal, not a
stale cache: grepping every report in `apps/ai-analysis-engine/data/reports/*.md`
for this pattern shows it occurred exactly once (07-20); 07-21's own
`analysis.json` rationale correctly reverts to percentage framing ("WTI
+1.72% on the day," matching real `changePct1d: 1.72` in `macro.json`).

**2026-07-21's number was fabricated one stage downstream, in
`investment-analyst-agents`, which changes the fix required.** Confirmed
`ai-analysis-engine` was clean that day (rationale says only "+1.72% on
the day," no dollar figure). But `apps/investment-analyst-agents/src/context/loader.ts`
has **no macro-asset-monitor path at all** (verified: `defaults()` at
`loader.ts:24-37` lists `analysisPath`, `simulationPath`, `graphPath`,
`stockIntelPath`, `worldIntelPath`, `profilePath`, `thesisDbPath`,
`peopleEventsPath`, `calibrationPath`, `taxHarvestPath`, `riskPath`,
`correlationReportPath` — never a macro/price path). And
`apps/investment-analyst-agents/src/briefing/briefing-agent.ts:300` builds
the "Macro Regime" prompt section purely from
`analysis.latestRegime.rationale`/`.keyIndicators` — prose only. With zero
numeric price ever reaching this second LLM call, and its own system
prompt (`briefing-agent.ts:15-19`) giving it license to write "a concise
daily investment briefing" grounded only in "the provided data," the
model invented a plausible-sounding "$88-95" range from nothing — no
percentage to inherit, no upstream error to blame, pure fabrication under
prompt pressure to sound precise about a thesis (AOT.BK jet fuel costs)
that three different position theses lean on.

**This means fixing only `ai-analysis-engine`'s prompt (the obvious fix
after day 1) would not have prevented day 2's occurrence.** The durable
fix needs both: a grounding guardrail at the stage that already has real
data (stop new fabrication at the source), and giving
`investment-analyst-agents` its own live number to check against (stop
blind trust of upstream prose, which is architecturally why this
propagated to the investor-facing document unchanged on both days).

## Verified evidence

- `apps/macro-asset-monitor/data/macro.json` today (`asOf: 2026-07-21`)
  confirms `{"ticker":"CL=F","label":"WTI Crude Oil","close":84.66,"changePct1d":1.72,"changePct30d":-6.49}`
  — the real number, correctly fetched, sitting one directory over from
  `investment-analyst-agents` and never read by it.
- `apps/ai-analysis-engine/src/types.ts` `MacroRegime` (referenced from
  `regime-analyzer.ts`) has no structured price field — `rationale` and
  `keyIndicators` are `string`/`string[]`, so there is no numeric value in
  `analysis.json` to validate against even if we wanted to; the dollar
  figure only ever exists as prose.
- `apps/investment-analyst-agents/src/types.ts:1` already documents the
  house convention: "Upstream data shapes — mirrors sibling project types
  without cross-project imports" (matches `AnalysisJSON`, `SimulationJSON`
  etc. all being locally re-declared, not imported from
  `macro-asset-monitor` or `@common/types`) — the fix below follows this
  existing pattern rather than introducing a new cross-app import.

## Design

### 1. Anti-fabrication guardrail in `ai-analysis-engine`'s regime prompt

In `apps/ai-analysis-engine/src/analysis/regime-analyzer.ts`, append to
`SYSTEM_PROMPT` (after the existing regime-taxonomy examples, still inside
the same template literal, `regime-analyzer.ts:57-83`):

```
GROUNDING RULE: Only state a specific numeric price, dollar threshold, or
count (e.g. a commodity price, a casualty figure, a specific dollar
level) if that exact figure appears in the Macro Asset Prices, Economic
Indicators, World Intelligence, Liquidity, or Government Flow data
supplied above. If a data source describes an event qualitatively (e.g.
"war escalating," "gasoline prices rising") without giving you a number,
describe it qualitatively in your rationale too — do not invent a
specific-sounding number to make it read as more precise than the source
data supports.
```

This is additive-only — no change to `CLASSIFY_TOOL`'s schema or to
`formatMacroAssets()`'s existing (already-correct, un-prefixed) rendering.

### 2. Wire live macro data into `investment-analyst-agents`

**`apps/investment-analyst-agents/src/types.ts`** — add a local mirror
type (following the file's own stated convention, header comment at
`types.ts:1`) and extend `ContextBundle` (`types.ts:212-227`):

```ts
export interface MacroSnapshot {
  asOf:         string
  marketAssets: Array<{
    ticker:       string
    label:        string
    close:        number
    changePct1d:  number
    changePct30d: number
  }>
}
```

Add `macro?: MacroSnapshot | null` to `ContextBundle`, alongside the
existing `calibration?`/`taxHarvest?`/`risk?` optional fields — same
"optional, null until available" convention already used for those three.

**`apps/investment-analyst-agents/src/context/loader.ts`**:
- Add `macroPath?: string` to `LoaderPaths` (`loader.ts:9-22`) and a
  default of `join(process.cwd(), '../macro-asset-monitor/data/macro.json')`
  in `defaults()` (`loader.ts:24-37`) — matching the existing sibling-app
  relative-path convention used by every other path in this function.
- Add a `loadMacro(path): MacroSnapshot | null` function, modeled directly
  on the existing `loadCalibration`/`loadRisk` pattern (`loader.ts:60-64`,
  `102-106`): returns `null` if the file doesn't exist or fails to parse,
  never throws — this is optional context, not a required envelope (unlike
  `analysis`/`simulation`/`graph`/`stockIntel`/`worldIntel`, which already
  throw via plain `JSON.parse(readFileSync(...))` at `loadContext`'s top,
  `loader.ts:150-154`, and should stay required).
- Call it in `loadContext()` (`loader.ts:147-183`) alongside the other
  optional loads (`loader.ts:177-180`) and add `macro` to the returned
  object (`loader.ts:182`).

**`apps/investment-analyst-agents/src/briefing/briefing-agent.ts`**:
- Destructure `macro` from `ctx` where `risk`/`correlationReport`/etc. are
  already destructured (near `briefing-agent.ts:195` area).
- Build a `macroBlock` string, formatted similarly to
  `ai-analysis-engine`'s `formatMacroAssets` (numbers, no `$` prefix, to
  avoid inviting the model to treat the labels as literal currency
  strings it can freely restate): `WTI Crude Oil 84.66 (+1.72% 1d, -6.49%
  30d)`, one line per `marketAssets` entry.
- Add `macroBlock` to the prompt-section array right before the existing
  Macro Regime line (`briefing-agent.ts:300`), so the model sees the real
  numbers immediately next to its own upstream regime narrative — makes
  a mismatch visually adjacent and checkable, and gives it a concrete
  number to cite instead of inventing one.
- Append the same GROUNDING RULE text from section 1 above to
  `SYSTEM_PROMPT` (`briefing-agent.ts:15-19`), adapted to reference the
  new "Live Market Data" section by name: "Only cite a specific
  commodity/rate/index price if it appears in the Live Market Data
  section below — use that exact figure, not a number implied by the
  Macro Regime rationale text."

### Out of scope

- Retroactively correcting the two already-published briefings
  (`2026-07-20.md`, `2026-07-21.md`) — historical documents, not live
  data; no code or DB change fixes a past file, and the pipeline
  overwrites the briefing daily so there's nothing to backfill.
- A general-purpose numeric-fact validator/linter that cross-checks every
  figure an LLM writes against source data across all pipeline stages —
  Compass separately flagged this as a broader follow-up (auditing other
  forced-`tool_choice` Sonnet stages for the same class of risk); this
  spec fixes the two concrete instances found, not a general framework.
- Gasoline price data — no source for it exists anywhere in this repo and
  none is being added; the fix is to stop the model from citing a
  gasoline price at all (covered by the grounding rule), not to source
  real gasoline data.
- `world-intelligence-data-hub-`'s stale Brent/WTI benchmark
  (`veryStale`, dated 2026-05-12, flagged separately by Sentinel) — a
  different oil-price signal used for geopolitical storyline linking, not
  the one feeding the briefing's Macro Regime section. Not touched here.
