# Backtest Signal Decay Tracking + PIT-Safe Price Fetch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix a point-in-time price-data bug in the briefing backtest (raw close instead of split-adjusted close) and add recent-vs-all-time signal decay tracking to `calibration.json`/`report.md`.

**Architecture:** Two changes to `apps/investment-analyst-agents/src/backtest/`: (1) `backtest-runner.ts`'s `fetchHistoricalClose` reads Yahoo's `adjclose` field instead of `close`; (2) `computeCalibration` (same file) gains a decay-detection pass that compares each existing accuracy bucket's all-time stats against a recent-15-prediction-dates slice, and `backtest-report.ts`'s `formatReport` renders the results as a new report section.

**Tech Stack:** TypeScript, vitest, Node `fetch` (mocked in tests via `vi.stubGlobal`).

Full design context: `docs/superpowers/specs/2026-07-15-backtest-signal-decay-design.md`.

---

### Task 1: PIT-safe price fetch — use adjclose, not raw close

**Files:**
- Modify: `apps/investment-analyst-agents/src/backtest/backtest-runner.ts:53-85`
- Create: `apps/investment-analyst-agents/tests/backtest-runner.test.ts`

- [ ] **Step 1: Export `fetchHistoricalClose` (visibility only, no behavior change)**

In `apps/investment-analyst-agents/src/backtest/backtest-runner.ts`, change line 53 from:

```ts
async function fetchHistoricalClose(ticker: string, date: string): Promise<number | null> {
```

to:

```ts
export async function fetchHistoricalClose(ticker: string, date: string): Promise<number | null> {
```

- [ ] **Step 2: Write the failing test**

Create `apps/investment-analyst-agents/tests/backtest-runner.test.ts`:

```ts
import { describe, it, expect, afterEach } from 'vitest'
import { fetchHistoricalClose } from '../src/backtest/backtest-runner.js'

function mockChartResponse(timestamps: number[], closes: (number | null)[], adjcloses: (number | null)[]) {
  return {
    chart: {
      result: [{
        timestamp: timestamps,
        indicators: {
          quote:    [{ close: closes }],
          adjclose: [{ adjclose: adjcloses }],
        },
      }],
    },
  }
}

describe('fetchHistoricalClose', () => {
  const originalFetch = global.fetch

  afterEach(() => {
    global.fetch = originalFetch
  })

  it('uses adjclose, not raw close, so a split inside the scored window does not show as a fake price cliff', async () => {
    // Simulates a ticker that did a 4:1 split shortly after this historical
    // date: Yahoo's raw `close` for this day is still pre-split-scale (400),
    // while `adjclose` has been retroactively divided by 4 (100) to stay
    // consistent with today's share count.
    const day = new Date('2026-01-05')
    const ts  = Math.floor(day.getTime() / 1000)
    global.fetch = (async () => ({
      ok:   true,
      json: async () => mockChartResponse([ts], [400], [100]),
    })) as unknown as typeof fetch

    const price = await fetchHistoricalClose('TEST', '2026-01-05')
    expect(price).toBe(100)
  })

  it('picks the trading day at or before the target date', async () => {
    const day1 = new Date('2026-01-05')
    const day2 = new Date('2026-01-06')
    const ts1  = Math.floor(day1.getTime() / 1000)
    const ts2  = Math.floor(day2.getTime() / 1000)
    global.fetch = (async () => ({
      ok:   true,
      json: async () => mockChartResponse([ts1, ts2], [400, 410], [100, 102.5]),
    })) as unknown as typeof fetch

    const price = await fetchHistoricalClose('TEST', '2026-01-06')
    expect(price).toBe(102.5)
  })

  it('returns null when the Yahoo response has no result', async () => {
    global.fetch = (async () => ({
      ok:   true,
      json: async () => ({ chart: { error: { code: 'Not Found' } } }),
    })) as unknown as typeof fetch

    const price = await fetchHistoricalClose('BOGUS', '2026-01-05')
    expect(price).toBeNull()
  })
})
```

- [ ] **Step 3: Run the tests to verify the first one fails**

Run: `cd apps/investment-analyst-agents && npx vitest run tests/backtest-runner.test.ts`

Expected: the first test (`uses adjclose...`) FAILS with an assertion error — `expected 400 to be 100` (the current code still reads raw `close`). The other two tests PASS already since they don't depend on the close/adjclose distinction.

- [ ] **Step 4: Fix `fetchHistoricalClose` to read adjclose**

In `apps/investment-analyst-agents/src/backtest/backtest-runner.ts`, replace lines 63-81 (from `const data = await res.json()` through the closing of the for-loop, i.e. everything up to `return bestIdx >= 0 ? closes[bestIdx] : null`) with:

```ts
    const data = await res.json() as {
      chart: {
        result?: Array<{
          timestamp: number[]
          indicators: {
            quote:    Array<{ close: (number | null)[] }>
            adjclose: Array<{ adjclose: (number | null)[] }>
          }
        }>
        error?: { code: string }
      }
    }
    if (data.chart.error || !data.chart.result?.length) return null
    const result = data.chart.result[0]
    // adjclose (split/dividend-adjusted), not raw close — a corporate action
    // inside the scored window would otherwise show up as a fake price cliff.
    // See docs/superpowers/specs/2026-07-15-backtest-signal-decay-design.md
    const closes  = result.indicators.adjclose[0]?.adjclose ?? []
    const targetTs = day.getTime() / 1000
    // Find the trading day at or just before the target date
    let bestIdx = -1
    let bestDiff = Infinity
    for (let i = 0; i < result.timestamp.length; i++) {
      if (result.timestamp[i] > targetTs) continue
      const diff = Math.abs(targetTs - result.timestamp[i])
      if (diff < bestDiff && closes[i] != null) {
        bestDiff = diff
        bestIdx = i
      }
    }
    return bestIdx >= 0 ? closes[bestIdx] : null
```

- [ ] **Step 5: Run the tests again to verify all three pass**

Run: `cd apps/investment-analyst-agents && npx vitest run tests/backtest-runner.test.ts`

Expected: all 3 tests PASS.

- [ ] **Step 6: Commit**

```bash
cd /Users/thanapold/Desktop/Projects.nosync
git add apps/investment-analyst-agents/src/backtest/backtest-runner.ts apps/investment-analyst-agents/tests/backtest-runner.test.ts
git commit -m "$(cat <<'EOF'
fix(investment-analyst-agents): use split-adjusted close in backtest price fetch

fetchHistoricalClose read Yahoo's raw close, so a stock split inside a
scored 7/30/90d window showed up as a fake price cliff and corrupted
that call's correctness score — the same failure class that lost the
CRWD split adjustment in the portfolio tracker. Switched to adjclose,
which Yahoo's chart endpoint already returns in the same response.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Signal decay tracking in `computeCalibration`

**Files:**
- Modify: `apps/investment-analyst-agents/src/backtest/backtest-runner.ts:169-241`
- Modify: `apps/investment-analyst-agents/tests/backtest-runner.test.ts` (append)

- [ ] **Step 1: Export the calibration types and function (visibility only)**

In `apps/investment-analyst-agents/src/backtest/backtest-runner.ts`, change:

```ts
interface CalibStats { accuracy: number; calls: number; avgReturn: number }
interface CalibrationJSON {
```

to:

```ts
export interface CalibStats { accuracy: number; calls: number; avgReturn: number }
export interface DecayEntry {
  signal:          string
  allTimeAccuracy: number
  recentAccuracy:  number
  allTimeCalls:    number
  recentCalls:     number
}
export interface CalibrationJSON {
```

and change:

```ts
function computeCalibration(rows: BacktestRow[], totalPredictions: number): CalibrationJSON {
```

to:

```ts
export function computeCalibration(rows: BacktestRow[], totalPredictions: number): CalibrationJSON {
```

Also add two new fields to the `CalibrationJSON` interface, right after `worstSignal`:

```ts
  bestEdge:             { signal: string; accuracy: number } | null
  worstSignal:          { signal: string; accuracy: number } | null
  decayWindowPredictions: number
  decaying:               DecayEntry[]
}
```

- [ ] **Step 2: Write the failing tests**

Append to `apps/investment-analyst-agents/tests/backtest-runner.test.ts` (add this import at the top alongside the existing one):

```ts
import { computeCalibration } from '../src/backtest/backtest-runner.js'
import type { BacktestRow } from '../src/backtest/backtest-runner.js'
```

Then append this describe block at the end of the file:

```ts
function makeRow(overrides: Partial<BacktestRow>): BacktestRow {
  return {
    date:         '2026-01-01',
    ticker:       'TEST',
    action:       'hold',
    conviction:   'medium',
    scenarioType: 'base',
    pctChange:    0,
    priceAtCall:  100,
    priceLater:   100,
    windowDays:   7,
    return:       0,
    correct:      true,
    ...overrides,
  }
}

function dateAt(dayOfMonth: number): string {
  return `2026-01-${String(dayOfMonth).padStart(2, '0')}`
}

describe('computeCalibration - signal decay tracking', () => {
  it('flags a signal whose recent accuracy has dropped well below its all-time accuracy', () => {
    const rows: BacktestRow[] = []

    // 5 older dates (outside the most-recent-15-date window), all correct
    for (let d = 1; d <= 5; d++) {
      rows.push(makeRow({ date: dateAt(d), action: 'trim', conviction: 'high', windowDays: 30, correct: true }))
    }
    // 10 recent dates (inside the most-recent-15-date window), all incorrect
    for (let d = 6; d <= 15; d++) {
      rows.push(makeRow({ date: dateAt(d), action: 'trim', conviction: 'high', windowDays: 30, correct: false }))
    }
    // Filler dates so the dataset has 20 distinct dates total, putting the
    // most-recent-15-date window exactly on 2026-01-06..2026-01-20.
    for (let d = 16; d <= 20; d++) {
      rows.push(makeRow({ date: dateAt(d), action: 'hold', conviction: 'low', windowDays: 7, correct: true }))
    }

    const calibration = computeCalibration(rows, rows.length)

    const trimDecay = calibration.decaying.find(e => e.signal === 'trim (30d)')
    expect(trimDecay).toBeDefined()
    expect(trimDecay!.allTimeCalls).toBe(15)
    expect(trimDecay!.allTimeAccuracy).toBeCloseTo(5 / 15, 5)
    expect(trimDecay!.recentCalls).toBe(10)
    expect(trimDecay!.recentAccuracy).toBe(0)

    const highDecay = calibration.decaying.find(e => e.signal === 'high (30d)')
    expect(highDecay).toBeDefined()
  })

  it('does not flag a signal with too few calls to be statistically meaningful', () => {
    const rows: BacktestRow[] = [
      makeRow({ date: dateAt(1),  action: 'buy', conviction: 'low', windowDays: 90, correct: true }),
      makeRow({ date: dateAt(18), action: 'buy', conviction: 'low', windowDays: 90, correct: false }),
      ...Array.from({ length: 18 }, (_, i) =>
        makeRow({ date: dateAt(i + 1), action: 'hold', conviction: 'medium', windowDays: 7, correct: true })),
    ]

    const calibration = computeCalibration(rows, rows.length)

    expect(calibration.decaying.find(e => e.signal === 'buy (90d)')).toBeUndefined()
    expect(calibration.decaying.find(e => e.signal === 'low (90d)')).toBeUndefined()
  })

  it('does not flag a signal whose recent accuracy is close to its all-time accuracy', () => {
    const rows: BacktestRow[] = []
    for (let d = 1; d <= 5; d++) {
      rows.push(makeRow({ date: dateAt(d), action: 'hold', conviction: 'medium', windowDays: 7, correct: true }))
    }
    for (let d = 6; d <= 15; d++) {
      rows.push(makeRow({ date: dateAt(d), action: 'hold', conviction: 'medium', windowDays: 7, correct: d !== 6 }))
    }
    for (let d = 16; d <= 20; d++) {
      rows.push(makeRow({ date: dateAt(d), action: 'trim', conviction: 'high', windowDays: 30, correct: true }))
    }

    const calibration = computeCalibration(rows, rows.length)

    expect(calibration.decaying.find(e => e.signal === 'hold (7d)')).toBeUndefined()
    expect(calibration.decaying.find(e => e.signal === 'medium (7d)')).toBeUndefined()
  })
})
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd apps/investment-analyst-agents && npx vitest run tests/backtest-runner.test.ts`

Expected: FAIL — `calibration.decaying` is `undefined`, so `.find(...)` throws `TypeError: Cannot read properties of undefined (reading 'find')`.

- [ ] **Step 4: Implement the decay logic**

In `apps/investment-analyst-agents/src/backtest/backtest-runner.ts`, inside `computeCalibration`, insert this block right after the `highConvictionPenalty` computation and before the `// Best edge = ...` comment:

```ts
  // Signal decay: compare each bucket's all-time accuracy against just the
  // most recent RECENT_PREDICTIONS_WINDOW prediction dates. Flags only when
  // both slices have enough calls to be meaningful — with 44 predictions and
  // heavily skewed action counts (buy/trim: 5-17 calls total), a fixed
  // calendar window would produce noise on the thin buckets.
  const RECENT_PREDICTIONS_WINDOW = 15
  const MIN_CALLS_FOR_DECAY       = 3
  const DECAY_THRESHOLD_PP        = 15

  const recentDates = new Set(
    Array.from(new Set(scoredRows.map(r => r.date))).sort().slice(-RECENT_PREDICTIONS_WINDOW)
  )

  function bucketRecent(filter: (r: BacktestRow) => boolean): CalibStats {
    return bucket(r => filter(r) && recentDates.has(r.date))
  }

  function toDecayEntry(signal: string, allTime: CalibStats, recent: CalibStats): DecayEntry | null {
    if (allTime.calls < MIN_CALLS_FOR_DECAY || recent.calls < MIN_CALLS_FOR_DECAY) return null
    const dropPP = (allTime.accuracy - recent.accuracy) * 100
    if (dropPP < DECAY_THRESHOLD_PP) return null
    return {
      signal,
      allTimeAccuracy: allTime.accuracy,
      recentAccuracy:  recent.accuracy,
      allTimeCalls:    allTime.calls,
      recentCalls:     recent.calls,
    }
  }

  const decaying: DecayEntry[] = []
  for (const a of actions) {
    for (const w of windows) {
      const entry = toDecayEntry(
        `${a} (${w}d)`,
        byAction[a][`${w}d`],
        bucketRecent(r => r.action === a && r.windowDays === w),
      )
      if (entry) decaying.push(entry)
    }
  }
  for (const c of ['high', 'medium', 'low']) {
    for (const w of windows) {
      const entry = toDecayEntry(
        `${c} (${w}d)`,
        byConviction[c][`${w}d`],
        bucketRecent(r => r.conviction === c && r.windowDays === w),
      )
      if (entry) decaying.push(entry)
    }
  }
  decaying.sort((x, y) => (y.allTimeAccuracy - y.recentAccuracy) - (x.allTimeAccuracy - x.recentAccuracy))
```

Note: this block references `actions`, `windows`, `byAction`, `byConviction`, and `bucket` — all already defined earlier in `computeCalibration`, so no new parameters are needed.

Then update the function's `return` statement to include the two new fields:

```ts
  return {
    generatedAt:           new Date().toISOString().slice(0, 10),
    predictionsAnalyzed:   totalPredictions,
    scoredCalls:           scoredRows.length,
    windows,
    byAction,
    byConviction,
    calibrationInverted,
    highConvictionPenalty,
    bestEdge,
    worstSignal,
    decayWindowPredictions: RECENT_PREDICTIONS_WINDOW,
    decaying,
  }
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd apps/investment-analyst-agents && npx vitest run tests/backtest-runner.test.ts`

Expected: all 6 tests PASS (3 from Task 1 + 3 from this task).

- [ ] **Step 6: Commit**

```bash
cd /Users/thanapold/Desktop/Projects.nosync
git add apps/investment-analyst-agents/src/backtest/backtest-runner.ts apps/investment-analyst-agents/tests/backtest-runner.test.ts
git commit -m "$(cat <<'EOF'
feat(investment-analyst-agents): track signal decay in backtest calibration

computeCalibration now compares each action/conviction bucket's all-time
accuracy against just the most recent 15 prediction dates, flagging
buckets where recent accuracy has dropped >=15pp — gated by a minimum
sample size on both sides so thin buckets (buy/trim currently have only
5-17 calls total) don't produce noise. Reinterprets "factor decay
tracking" for a system whose only scored signal is the briefing agent's
own action+conviction call, not a quantitative factor library.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Render Signal Decay in the markdown report

**Files:**
- Modify: `apps/investment-analyst-agents/src/backtest/backtest-report.ts`
- Modify: `apps/investment-analyst-agents/src/backtest/backtest-runner.ts` (the `run()` function)
- Create: `apps/investment-analyst-agents/tests/backtest-report.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `apps/investment-analyst-agents/tests/backtest-report.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { formatReport } from '../src/backtest/backtest-report.js'
import type { BacktestRow, DecayEntry } from '../src/backtest/backtest-runner.js'

const sampleRows: BacktestRow[] = [
  {
    date: '2026-01-01', ticker: 'TEST', action: 'hold', conviction: 'medium',
    scenarioType: 'base', pctChange: 0, priceAtCall: 100, priceLater: 101,
    windowDays: 7, return: 1, correct: true,
  },
]

describe('formatReport - signal decay section', () => {
  it('omits the Signal Decay section when nothing is decaying', () => {
    const report = formatReport(sampleRows, 1, [], 15)
    expect(report).not.toContain('Signal Decay')
  })

  it('renders a Signal Decay table row for each flagged signal', () => {
    const decaying: DecayEntry[] = [
      { signal: 'trim (30d)', allTimeAccuracy: 0.75, recentAccuracy: 0.2, allTimeCalls: 12, recentCalls: 5 },
    ]
    const report = formatReport(sampleRows, 1, decaying, 15)
    expect(report).toContain('Signal Decay')
    expect(report).toContain('trim (30d)')
    expect(report).toContain('75.0%')
    expect(report).toContain('20.0%')
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/investment-analyst-agents && npx vitest run tests/backtest-report.test.ts`

Expected: FAIL to compile — `formatReport` doesn't accept 3rd/4th arguments yet (TS error: "Expected 2 arguments, but got 4").

- [ ] **Step 3: Update `formatReport`'s signature and render the new section**

In `apps/investment-analyst-agents/src/backtest/backtest-report.ts`, change the import line at the top from:

```ts
import type { BacktestRow } from './backtest-runner.js'
```

to:

```ts
import type { BacktestRow, DecayEntry } from './backtest-runner.js'
```

Change the `formatReport` function signature from:

```ts
export function formatReport(rows: BacktestRow[], totalPredictions: number): string {
```

to:

```ts
export function formatReport(
  rows: BacktestRow[],
  totalPredictions: number,
  decaying: DecayEntry[] = [],
  decayWindowPredictions = 0,
): string {
```

Then, right after the "Top 10 worst" block's `out.push('')` and before the `// ── Recommendation ──` comment, insert:

```ts
  // ── Signal decay ─────────────────────────────────────────────────────────
  if (decaying.length > 0) {
    out.push(`## ⚠️ Signal Decay (recent ${decayWindowPredictions} predictions vs. all-time)\n`)
    out.push('| Signal | All-time Accuracy | Recent Accuracy | All-time Calls | Recent Calls |')
    out.push('|---|---|---|---|---|')
    for (const d of decaying) {
      out.push(`| ${d.signal} | ${(d.allTimeAccuracy * 100).toFixed(1)}% | ${(d.recentAccuracy * 100).toFixed(1)}% | ${d.allTimeCalls} | ${d.recentCalls} |`)
    }
    out.push('')
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/investment-analyst-agents && npx vitest run tests/backtest-report.test.ts`

Expected: both tests PASS.

- [ ] **Step 5: Wire the new arguments through `run()`**

In `apps/investment-analyst-agents/src/backtest/backtest-runner.ts`, replace:

```ts
  const report = formatReport(rows, predictions.length)
  mkdirSync(join(process.cwd(), 'backtest'), { recursive: true })
  writeFileSync(REPORT_PATH, report, 'utf-8')

  // Structured calibration for the briefing prompt to ingest.
  const calibration = computeCalibration(rows, predictions.length)
  writeFileSync(CALIB_PATH, JSON.stringify(calibration, null, 2), 'utf-8')
```

with:

```ts
  // Structured calibration computed first so its decay findings can be
  // rendered into the markdown report below.
  const calibration = computeCalibration(rows, predictions.length)

  const report = formatReport(rows, predictions.length, calibration.decaying, calibration.decayWindowPredictions)
  mkdirSync(join(process.cwd(), 'backtest'), { recursive: true })
  writeFileSync(REPORT_PATH, report, 'utf-8')
  writeFileSync(CALIB_PATH, JSON.stringify(calibration, null, 2), 'utf-8')
```

- [ ] **Step 6: Run the full test suite and typecheck for this app**

Run: `cd apps/investment-analyst-agents && npx vitest run && npx tsc --noEmit`

Expected: all tests PASS, typecheck reports no errors.

- [ ] **Step 7: Commit**

```bash
cd /Users/thanapold/Desktop/Projects.nosync
git add apps/investment-analyst-agents/src/backtest/backtest-report.ts apps/investment-analyst-agents/src/backtest/backtest-runner.ts apps/investment-analyst-agents/tests/backtest-report.test.ts
git commit -m "$(cat <<'EOF'
feat(investment-analyst-agents): render signal decay in backtest report.md

formatReport now accepts the decay findings from computeCalibration and
renders them as a "Signal Decay" table, shown only when at least one
signal has flagged. run() now computes calibration before generating
the report so the decay data is available to pass through.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Verify against the real archive

**Files:** none modified — this is a manual verification pass against real data.

- [ ] **Step 1: Run the real backtest**

Run: `cd apps/investment-analyst-agents && npm run backtest`

Expected: completes without errors, prints `Report: .../backtest/report.md` and `Calibration JSON: .../backtest/calibration.json`.

- [ ] **Step 2: Confirm the new fields are present in the real output**

Run: `cd apps/investment-analyst-agents && python3 -c "
import json
d = json.load(open('backtest/calibration.json'))
print('decayWindowPredictions:', d['decayWindowPredictions'])
print('decaying:', json.dumps(d['decaying'], indent=2))
"`

Expected: `decayWindowPredictions` is `15`; `decaying` is a JSON array (may be empty — with only 44 predictions and thin buy/trim buckets, it's plausible nothing meets the ≥3-calls-on-both-sides gate yet, and that's a correct, not broken, result).

- [ ] **Step 3: Confirm report.md renders correctly either way**

Run: `grep -A5 "Signal Decay" apps/investment-analyst-agents/backtest/report.md || echo "No Signal Decay section — nothing flagged, which is valid given current data volume"`

Expected: either a rendered table, or the fallback echo — both are acceptable outcomes; this step is a sanity check that the code path doesn't crash on real data, not a hardcoded expectation of what it should find.

No commit needed for this task — `backtest/report.md` and `backtest/calibration.json` are pipeline-generated outputs regenerated daily, not something to hand-commit here.
