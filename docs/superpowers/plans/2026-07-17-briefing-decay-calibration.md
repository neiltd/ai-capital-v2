# Wire Signal Decay Into Briefing Self-Calibration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the briefing agent automatically see and react to "decaying signal" data (added in a prior feature) in its own self-calibration prompt, instead of requiring a human to read `backtest/report.md` and manually intervene.

**Architecture:** Widen two independently-duplicated type definitions (`loader.ts`, `types.ts`) with the same two optional fields the canonical `backtest-runner.ts` type already has, then extend `briefing-agent.ts`'s existing `calibrationBlock` prompt-builder with one more conditional clause that reads those fields safely (optional, with fallbacks) and renders a "Decaying signals" section in the same style as the block's existing lines.

**Tech Stack:** TypeScript, vitest.

Full design context: `docs/superpowers/specs/2026-07-17-briefing-decay-calibration-design.md`.

---

### Task 1: Widen the two duplicate calibration type definitions

**Files:**
- Modify: `apps/investment-analyst-agents/src/context/loader.ts:39-50`
- Modify: `apps/investment-analyst-agents/src/types.ts:161-172`

- [ ] **Step 1: Widen `loader.ts`'s local `CalibrationJSON` interface**

In `apps/investment-analyst-agents/src/context/loader.ts`, change:

```ts
interface CalibrationJSON {
  generatedAt:          string
  predictionsAnalyzed:  number
  scoredCalls:          number
  windows:              number[]
  byAction:             Record<string, Record<string, { accuracy: number; calls: number; avgReturn: number }>>
  byConviction:         Record<string, Record<string, { accuracy: number; calls: number; avgReturn: number }>>
  calibrationInverted:  boolean
  highConvictionPenalty:number
  bestEdge:             { signal: string; accuracy: number } | null
  worstSignal:          { signal: string; accuracy: number } | null
}
```

to:

```ts
interface CalibrationJSON {
  generatedAt:          string
  predictionsAnalyzed:  number
  scoredCalls:          number
  windows:              number[]
  byAction:             Record<string, Record<string, { accuracy: number; calls: number; avgReturn: number }>>
  byConviction:         Record<string, Record<string, { accuracy: number; calls: number; avgReturn: number }>>
  calibrationInverted:  boolean
  highConvictionPenalty:number
  bestEdge:             { signal: string; accuracy: number } | null
  worstSignal:          { signal: string; accuracy: number } | null
  decayWindowPredictions?: number
  decaying?: Array<{
    signal:          string
    allTimeAccuracy: number
    recentAccuracy:  number
    allTimeCalls:    number
    recentCalls:     number
  }>
}
```

Both new fields are **optional** — a `calibration.json` written before this feature existed (or on a day the `briefing-backtest` pipeline stage failed/was skipped) won't have these keys, and that must be a normal typed `undefined`, not a runtime error.

- [ ] **Step 2: Widen `types.ts`'s `CalibrationContext` — identically**

In `apps/investment-analyst-agents/src/types.ts`, change:

```ts
export interface CalibrationContext {
  generatedAt:           string
  predictionsAnalyzed:   number
  scoredCalls:           number
  windows:               number[]
  byAction:              Record<string, Record<string, { accuracy: number; calls: number; avgReturn: number }>>
  byConviction:          Record<string, Record<string, { accuracy: number; calls: number; avgReturn: number }>>
  calibrationInverted:   boolean
  highConvictionPenalty: number
  bestEdge:              { signal: string; accuracy: number } | null
  worstSignal:           { signal: string; accuracy: number } | null
}
```

to:

```ts
export interface CalibrationContext {
  generatedAt:           string
  predictionsAnalyzed:   number
  scoredCalls:           number
  windows:               number[]
  byAction:              Record<string, Record<string, { accuracy: number; calls: number; avgReturn: number }>>
  byConviction:          Record<string, Record<string, { accuracy: number; calls: number; avgReturn: number }>>
  calibrationInverted:   boolean
  highConvictionPenalty: number
  bestEdge:              { signal: string; accuracy: number } | null
  worstSignal:           { signal: string; accuracy: number } | null
  decayWindowPredictions?: number
  decaying?: Array<{
    signal:          string
    allTimeAccuracy: number
    recentAccuracy:  number
    allTimeCalls:    number
    recentCalls:     number
  }>
}
```

**Why both, kept as separate independent copies:** `loader.ts` returns its own
`CalibrationJSON` into a slot (`ContextBundle.calibration`) typed as
`CalibrationContext` from `types.ts` — the two shapes must stay structurally
identical for this to typecheck at all. They are two independent
hand-duplicated copies (not an import of one shared type) — this is
pre-existing in the codebase; de-duplicating them into one shared import is a
larger, separate refactor and out of scope here.

- [ ] **Step 3: Typecheck to confirm nothing broke**

Run: `cd apps/investment-analyst-agents && npx tsc --noEmit`

Expected: no errors. (These are additive optional fields — nothing that reads
`CalibrationContext`/`CalibrationJSON` today references them, so existing code
is unaffected.)

- [ ] **Step 4: Commit**

```bash
cd /Users/thanapold/Desktop/Projects.nosync
git add apps/investment-analyst-agents/src/context/loader.ts apps/investment-analyst-agents/src/types.ts
git commit -m "$(cat <<'EOF'
feat(investment-analyst-agents): widen calibration types with signal-decay fields

Adds optional decayWindowPredictions/decaying fields to the two
independently-duplicated calibration type definitions (context/loader.ts
and types.ts), matching the canonical shape already exported by
backtest-runner.ts. Optional, not required — a calibration.json written
before this feature (or on a day briefing-backtest failed/was skipped)
won't have these keys, and that must stay a normal undefined, not a
runtime error given real money rides on the daily brief actually
generating.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Render decaying signals in the briefing agent's self-calibration block

**Files:**
- Modify: `apps/investment-analyst-agents/src/briefing/briefing-agent.ts:145-163`
- Modify: `apps/investment-analyst-agents/tests/briefing-agent.test.ts`

- [ ] **Step 1: Write the failing test**

In `apps/investment-analyst-agents/tests/briefing-agent.test.ts`, add this
import at the top alongside the existing ones:

```ts
import type { ContextBundle, CalibrationContext } from '../src/types.js'
```

(This replaces the existing `import type { ContextBundle } from '../src/types.js'` line — just widen it to also import `CalibrationContext`.)

Then add a base calibration fixture near the top of the file, right after the
existing `baseCtx` constant:

```ts
const baseCalibration: CalibrationContext = {
  generatedAt:           '2026-07-16',
  predictionsAnalyzed:   44,
  scoredCalls:           612,
  windows:               [7, 30, 90],
  byAction:              {},
  byConviction:          {},
  calibrationInverted:   false,
  highConvictionPenalty: 0,
  bestEdge:              null,
  worstSignal:           null,
}
```

Then append these 3 tests inside the existing `describe('generateBriefing', ...)` block, after the current last test (`'throws when Claude returns no text block'`):

```ts
  it('omits both the calibration block and the Decaying signals section when calibration is undefined', async () => {
    let capturedMessages: any[] = []
    const mockClient = {
      messages: {
        create: vi.fn().mockImplementation(async (params: any) => {
          capturedMessages = params.messages
          return { content: [{ type: 'text', text: 'Briefing.' }] }
        }),
      },
    } as unknown as Anthropic

    // baseCtx never sets `calibration` — it's undefined, exercising the
    // pre-existing `if (!calibration) return ''` early-return path in
    // calibrationBlock. This confirms the new decay-rendering code added in
    // this task doesn't change that existing no-calibration behavior.
    await generateBriefing(baseCtx, { client: mockClient })
    const userMsg = capturedMessages.find((m: any) => m.role === 'user')
    const text = userMsg.content[0].text
    expect(text).not.toContain('Briefing Self-Calibration')
    expect(text).not.toContain('Decaying signals')
  })

  it('omits the Decaying signals section when calibration has no decaying field', async () => {
    let capturedMessages: any[] = []
    const mockClient = {
      messages: {
        create: vi.fn().mockImplementation(async (params: any) => {
          capturedMessages = params.messages
          return { content: [{ type: 'text', text: 'Briefing.' }] }
        }),
      },
    } as unknown as Anthropic

    await generateBriefing({ ...baseCtx, calibration: baseCalibration }, { client: mockClient })
    const userMsg = capturedMessages.find((m: any) => m.role === 'user')
    expect(userMsg.content[0].text).not.toContain('Decaying signals')
  })

  it('omits the Decaying signals section when decaying is an empty array', async () => {
    let capturedMessages: any[] = []
    const mockClient = {
      messages: {
        create: vi.fn().mockImplementation(async (params: any) => {
          capturedMessages = params.messages
          return { content: [{ type: 'text', text: 'Briefing.' }] }
        }),
      },
    } as unknown as Anthropic

    await generateBriefing(
      { ...baseCtx, calibration: { ...baseCalibration, decayWindowPredictions: 15, decaying: [] } },
      { client: mockClient },
    )
    const userMsg = capturedMessages.find((m: any) => m.role === 'user')
    expect(userMsg.content[0].text).not.toContain('Decaying signals')
  })

  it('includes a Decaying signals section with signal name and both accuracies when populated', async () => {
    let capturedMessages: any[] = []
    const mockClient = {
      messages: {
        create: vi.fn().mockImplementation(async (params: any) => {
          capturedMessages = params.messages
          return { content: [{ type: 'text', text: 'Briefing.' }] }
        }),
      },
    } as unknown as Anthropic

    await generateBriefing(
      {
        ...baseCtx,
        calibration: {
          ...baseCalibration,
          decayWindowPredictions: 15,
          decaying: [
            { signal: 'trim (30d)', allTimeAccuracy: 0.75, recentAccuracy: 0.2, allTimeCalls: 12, recentCalls: 5 },
          ],
        },
      },
      { client: mockClient },
    )
    const userMsg = capturedMessages.find((m: any) => m.role === 'user')
    const text = userMsg.content[0].text
    expect(text).toContain('Decaying signals')
    expect(text).toContain('trim (30d)')
    expect(text).toContain('75.0%')
    expect(text).toContain('20.0%')
  })
```

- [ ] **Step 2: Run the tests to verify the new "populated" test fails**

Run: `cd apps/investment-analyst-agents && npx vitest run tests/briefing-agent.test.ts`

Expected: 6 of 7 tests PASS (the 3 pre-existing ones, plus the three new
"omits" tests — since nothing renders a decay section yet, "not.toContain"
already holds true in all three of those cases). The new **"includes a
Decaying signals section..."** test FAILS, since `calibrationBlock` doesn't
render anything from `decaying` yet.

- [ ] **Step 3: Implement the decay clause in `calibrationBlock`**

In `apps/investment-analyst-agents/src/briefing/briefing-agent.ts`, find this
code (current lines 145-163):

```ts
    const verdict = calibration.calibrationInverted
      ? `🔴 CALIBRATION INVERTED — high-conviction calls are ${(calibration.highConvictionPenalty * 100).toFixed(1)} pp WORSE than medium. Downgrade today's high-conviction labels unless concretely justified.`
      : `✅ Conviction labels are correctly calibrated (high outperforms medium).`
    return [
      `\n## Briefing Self-Calibration (from your prior recommendations)`,
      `Predictions analyzed: ${calibration.predictionsAnalyzed} | Scored calls: ${calibration.scoredCalls}`,
      ``,
      `### Accuracy by action type`,
      actionLines || '  (not enough data yet)',
      ``,
      `### Accuracy by conviction level`,
      convictionLines || '  (not enough data yet)',
      ``,
      `### Verdict`,
      verdict,
      calibration.bestEdge ? `Best edge: ${calibration.bestEdge.signal} = ${fmtPct(calibration.bestEdge.accuracy)} accurate — lean on this signal.` : '',
      calibration.worstSignal && calibration.worstSignal.accuracy < 0.5 ? `Worst signal: ${calibration.worstSignal.signal} = ${fmtPct(calibration.worstSignal.accuracy)} — treat as coin flip.` : '',
    ].filter(Boolean).join('\n')
  })()
```

Replace it with:

```ts
    const verdict = calibration.calibrationInverted
      ? `🔴 CALIBRATION INVERTED — high-conviction calls are ${(calibration.highConvictionPenalty * 100).toFixed(1)} pp WORSE than medium. Downgrade today's high-conviction labels unless concretely justified.`
      : `✅ Conviction labels are correctly calibrated (high outperforms medium).`
    const decayLines = (calibration.decaying ?? [])
      .map(d => `  - ${d.signal}: was ${fmtPct(d.allTimeAccuracy)} accurate all-time (${d.allTimeCalls} calls), only ${fmtPct(d.recentAccuracy)} over the last ${calibration.decayWindowPredictions ?? '?'} predictions (${d.recentCalls} calls) — treat with caution, don't lean on this signal right now.`)
      .join('\n')
    return [
      `\n## Briefing Self-Calibration (from your prior recommendations)`,
      `Predictions analyzed: ${calibration.predictionsAnalyzed} | Scored calls: ${calibration.scoredCalls}`,
      ``,
      `### Accuracy by action type`,
      actionLines || '  (not enough data yet)',
      ``,
      `### Accuracy by conviction level`,
      convictionLines || '  (not enough data yet)',
      ``,
      `### Verdict`,
      verdict,
      calibration.bestEdge ? `Best edge: ${calibration.bestEdge.signal} = ${fmtPct(calibration.bestEdge.accuracy)} accurate — lean on this signal.` : '',
      calibration.worstSignal && calibration.worstSignal.accuracy < 0.5 ? `Worst signal: ${calibration.worstSignal.signal} = ${fmtPct(calibration.worstSignal.accuracy)} — treat as coin flip.` : '',
      decayLines ? `\n### ⚠️ Decaying signals\n${decayLines}` : '',
    ].filter(Boolean).join('\n')
  })()
```

This reuses the existing `fmtPct` helper (defined earlier in the same IIFE
scope, line 129) and mirrors `backtest-report.ts`'s own decay table format
(signal name, both accuracy percentages, both call counts) so the same data
reads consistently whether a human sees it in `report.md` or the LLM sees it
in its own prompt.

- [ ] **Step 4: Run the tests to verify all 6 pass**

Run: `cd apps/investment-analyst-agents && npx vitest run tests/briefing-agent.test.ts`

Expected: all 7 tests PASS.

- [ ] **Step 5: Run the full app test suite and typecheck**

Run: `cd apps/investment-analyst-agents && npx vitest run && npx tsc --noEmit`

Expected: all tests PASS (should be 31 total: 24 from before this feature +
7 new), no type errors.

- [ ] **Step 6: Commit**

```bash
cd /Users/thanapold/Desktop/Projects.nosync
git add apps/investment-analyst-agents/src/briefing/briefing-agent.ts apps/investment-analyst-agents/tests/briefing-agent.test.ts
git commit -m "$(cat <<'EOF'
feat(investment-analyst-agents): surface decaying signals in briefing self-calibration

briefing-agent.ts's existing self-calibration prompt block now renders
a "Decaying signals" section when computeCalibration has flagged any
action/conviction bucket's recent accuracy as having dropped well below
its all-time accuracy — using the same optional, safely-defaulted
fields added to the calibration types in the prior task. This closes
the loop the backtest signal-decay feature deferred: the briefing agent
now sees and can react to its own decaying signals automatically,
without a human reading backtest/report.md and intervening manually.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Verify against the real (pre-feature) calibration.json

**Files:** none modified — manual verification pass, no commit.

- [ ] **Step 1: Confirm the real on-disk calibration.json still loads safely**

Run:
```bash
cd apps/investment-analyst-agents
node -e "
const { readFileSync } = require('fs');
const cal = JSON.parse(readFileSync('backtest/calibration.json', 'utf-8'));
console.log('decaying present:', 'decaying' in cal);
console.log('decayWindowPredictions present:', 'decayWindowPredictions' in cal);
"
```

Expected: this file currently has neither key (it predates this feature, or
reflects a run from before the prior feature's Task 4 real-data verification
was re-run). This is fine and expected — Task 1's optional fields mean this
is a valid, safely-typed state, not an error.

- [ ] **Step 2: Confirm `npm run brief` doesn't need to be run for real to validate this**

This step is intentionally a sanity check, not a live run: `npm run brief`
calls the real Anthropic API and costs real money per the project's
cost-consciousness — don't run it just to verify this change. The unit tests
in Task 2 (specifically the "omits the Decaying signals section when
calibration has no decaying field" test, which uses a fixture with no
`decaying` key at all — the exact real-world shape confirmed in Step 1 above)
already prove the code path handles today's actual `calibration.json` safely.
No further action needed for this task.
