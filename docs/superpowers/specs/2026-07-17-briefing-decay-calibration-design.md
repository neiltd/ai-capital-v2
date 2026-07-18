# Wire signal decay into the briefing agent's self-calibration

## Context

The prior feature (`docs/superpowers/specs/2026-07-15-backtest-signal-decay-design.md`)
added signal decay tracking to `apps/investment-analyst-agents/src/backtest/backtest-runner.ts`:
`computeCalibration()` now returns two new fields — `decayWindowPredictions: number`
and `decaying: DecayEntry[]` — flagging action/conviction buckets whose accuracy
over the most recent 15 prediction dates has dropped 15+ percentage points below
their all-time accuracy (gated by a minimum 3-call sample size on both sides).
These fields are written into `backtest/calibration.json` and rendered as a
"Signal Decay" table in `backtest/report.md`, but nothing consumes them
programmatically yet — a human has to read the report to notice a decaying
signal.

This is a fast-follow the prior spec explicitly deferred: wiring `decaying`
into the actual decision-making agent so it self-adjusts, rather than requiring
a manual check every time.

**The mechanism to extend already exists and already works.**
`apps/investment-analyst-agents/src/briefing/briefing-agent.ts` builds a
"Briefing Self-Calibration" text block (a function-local IIFE, lines 130-163)
from the same `calibration.json` data and injects it directly into the
briefing agent's own LLM prompt — including a live directive:
`🔴 CALIBRATION INVERTED — high-conviction calls are {N}pp WORSE than medium.
Downgrade today's high-conviction labels unless concretely justified.`
This is not a new pattern to build; it's the established, working mechanism
this task extends with one more clause.

Independently verified (Fable subagent, 2026-07-16): the discovery agent has
its own *separate* self-calibration system (`apps/scenario-simulator/src/discovery/calibration.ts`),
based on closed paper-portfolio positions rather than backtest scoring. This
task does **not** touch that system — scope is briefing-agent.ts only, per
explicit decision during brainstorming, since the discovery system scores a
different thing (paper picks) with different data.

## Verified findings that shape this design

1. **`calibration.json`'s shape is hand-duplicated in three places**, none
   importing from another:
   - `backtest-runner.ts` — canonical source, exports `DecayEntry` (183-189)
     and `CalibrationJSON` (190-203), already includes the new fields.
   - `apps/investment-analyst-agents/src/context/loader.ts:39-50` — local,
     non-exported `interface CalibrationJSON`, missing the new fields.
   - `apps/investment-analyst-agents/src/types.ts:161-172` — exported
     `CalibrationContext`, used by `ContextBundle.calibration` and imported
     by `briefing-extractor.ts`, also missing the new fields.

   `loader.ts` returns its own `CalibrationJSON` into a slot typed as
   `CalibrationContext` — the two copies must stay structurally identical for
   this to typecheck at all, so extending both in lockstep is required, not
   optional. De-duplicating these three into one shared, imported type would
   be a cleaner long-term fix but is a separate, larger refactor — out of
   scope here per "don't propose unrelated restructuring."

2. **Real runtime-safety gap**: the on-disk `backtest/calibration.json` does
   not yet contain `decaying`/`decayWindowPredictions` (it predates this
   feature, and will also lag on any day the `briefing-backtest` pipeline
   stage fails or is skipped). `loadCalibration()` does an **unvalidated**
   `JSON.parse(...) as CalibrationJSON` cast. If the new fields were typed as
   required and `briefing-agent.ts` did `calibration.decaying.length > 0`
   directly, a briefing run against a stale/pre-feature `calibration.json`
   would throw a `TypeError` mid-pipeline — on a system where real money
   decisions ride on the daily brief actually being generated. This is the
   single most important thing this design must get right.

3. **`briefing-agent.ts`'s `calibrationBlock` is a function-local IIFE, not
   exported** — only `generateBriefing` is. Tests must exercise it indirectly
   through `generateBriefing`, the same way the existing `profileMissing` test
   already does (`tests/briefing-agent.test.ts:36-52`): mock the Anthropic
   client to capture the outgoing prompt, call `generateBriefing` with a
   crafted `ContextBundle`, assert on the captured message content.

4. **Zero existing test coverage of `calibrationBlock`** at all — the current
   3 tests in `briefing-agent.test.ts` don't even set `calibration` in
   `baseCtx`. This task adds the *first* tests for this logic, not just tests
   for the new decay clause.

## Design

### 1. Widen the two duplicate type definitions — fields optional

In both `apps/investment-analyst-agents/src/context/loader.ts` (the local
`CalibrationJSON` interface) and `apps/investment-analyst-agents/src/types.ts`
(`CalibrationContext`), add:

```ts
decayWindowPredictions?: number
decaying?: Array<{
  signal:          string
  allTimeAccuracy: number
  recentAccuracy:  number
  allTimeCalls:    number
  recentCalls:     number
}>
```

**Optional, not required** — this is the fix for finding #2. A
`calibration.json` written before this feature (or on a day the backtest
stage didn't run) simply won't have these keys; optional fields mean that's a
normal, typed, non-throwing state (`undefined`), not a runtime error.

### 2. Extend `calibrationBlock` in `briefing-agent.ts`

Add a new clause after the existing `worstSignal` line (after line 161 in the
current file), guarded so a missing/empty array renders nothing:

```ts
const decayLines = (calibration.decaying ?? [])
  .map(d => `  - ${d.signal}: was ${fmtPct(d.allTimeAccuracy)} accurate all-time (${d.allTimeCalls} calls), only ${fmtPct(d.recentAccuracy)} over the last ${calibration.decayWindowPredictions ?? '?'} predictions (${d.recentCalls} calls) — treat with caution, don't lean on this signal right now.`)
  .join('\n')
```

...appended to the block's output array as:

```ts
decayLines ? `\n### ⚠️ Decaying signals\n${decayLines}` : '',
```

This reuses the existing `fmtPct` helper (already defined at line 129) and
mirrors `backtest-report.ts`'s decay table (ticker/signal name, both accuracy
percentages, both call counts) so the same signal reads consistently whether
a human sees it in `report.md` or the LLM sees it in its own prompt — per
Fable's explicit recommendation to keep formatting consistent across the two
surfaces.

Placement matches the existing block's own internal ordering: verdict lines
first (calibration-inverted or not), then best-edge/worst-signal (existing),
then decaying signals (new) — each additive, none restructured.

### 3. Tests

Add to `apps/investment-analyst-agents/tests/briefing-agent.test.ts`, following
the existing `profileMissing` test's exact pattern (mock client captures
`params.messages`, call `generateBriefing`, assert on captured content):

- A `CalibrationContext` fixture with `decaying: []` (or field omitted
  entirely, to also cover the pre-feature/stale-file case from finding #2) →
  assert the prompt does **not** contain `"Decaying signals"`.
- A fixture with one `decaying` entry → assert the prompt contains
  `"Decaying signals"`, the signal name, and both formatted percentages.
- A fixture where `calibration` itself is `undefined` (the existing
  `if (!calibration) return ''` early-return path) → assert the prompt
  contains neither the calibration block nor the decay section, confirming
  the new code doesn't break the pre-existing no-calibration case.

### Out of scope

- The discovery agent's separate calibration system
  (`scenario-simulator/src/discovery/calibration.ts`) — different data
  source, explicitly excluded during brainstorming.
- De-duplicating the three independent `CalibrationJSON`/`CalibrationContext`
  copies into one shared, imported type — real tech debt, but a larger,
  unrelated refactor.
- Any change to how `decaying` is *computed* — that logic (in
  `backtest-runner.ts`) is already built, tested, and merged; this task only
  wires its already-correct output into one more consumer.
