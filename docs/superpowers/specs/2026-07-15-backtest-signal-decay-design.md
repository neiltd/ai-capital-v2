# Backtest signal decay tracking + PIT-safe price fetch

## Context

`apps/investment-analyst-agents/src/backtest/backtest-runner.ts` scores the
daily briefing's archived buy/watch/trim/exit calls against actual price
returns over 7/30/90-day windows, and aggregates accuracy into
`backtest/calibration.json` (consumed by the briefing prompt) and
`backtest/report.md` (human-readable).

Prompted by reviewing an open-source LLM trading agent
([HKUDS/Vibe-Trading](https://github.com/HKUDS/Vibe-Trading)) which tracks
"point-in-time-safe factor decay" for its quantitative factor library. This
codebase has no quantitative factor library — its only scored signal is the
LLM's own action+conviction call — so the concept is reinterpreted for that
context. This is a from-scratch reimplementation of the *concept*; no code or
data is shared with or pulled from that project.

Two independent problems, bundled because the decay feature is only
trustworthy once the underlying price data is stable:

1. **PIT-safety bug**: historical prices are re-fetched from Yahoo on every
   backtest run using the raw `close` field. If a stock splits *within* a
   scored window (e.g. CRWD's 4:1 split — the same failure class that lost
   the CRWD split adjustment in the portfolio tracker per `CLAUDE.md`), the
   raw close shows an artificial ~75% cliff, corrupting that call's
   correctness score and everything aggregated from it. Confirmed via a live
   call to Yahoo's `v8/finance/chart` endpoint that it already returns an
   `adjclose` (split/dividend-adjusted) array in the same response at no
   extra cost.
2. **No decay tracking**: `calibration.json` is a single all-time snapshot.
   There's no way to tell whether a signal that was historically accurate
   (e.g. "trim + high conviction") has recently gotten worse — exactly the
   drift a real trading system needs to catch before it keeps weighting a
   decayed signal.

## Current data volume (as of 2026-07-15)

- 44 archived daily predictions, 602 scored calls total.
- Heavily skewed toward `hold` (331 calls @ 7d, 226 @ 30d). `buy`/`trim` are
  thin: 5–17 calls per bucket.
- This shapes the decay design: calendar-based (monthly) cohorts would have
  too few data points per bucket to mean anything yet. A recent-N-vs-all-time
  split, gated by a minimum sample size, is the right granularity until more
  history accumulates.

## Design

### 1. PIT-safe price fetch

In `fetchHistoricalClose` (`backtest-runner.ts`), switch from reading
`data.chart.result[0].indicators.quote[0].close` to
`data.chart.result[0].indicators.adjclose[0].adjclose`. Same response shape,
same call site, no new request. This makes every return calculation
split/dividend-safe regardless of what happens to the ticker between the call
date and today.

No behavior change for tickers with no corporate action in the scored window
(confirmed identical values in that case via a live test call). No fallback
needed — `adjclose` is present in the API response whenever `quote` is.

### 2. Signal decay tracking

Extend `computeCalibration()` in `backtest-runner.ts`:

- Add a `RECENT_PREDICTIONS_WINDOW = 15` constant (last 15 *prediction dates*,
  not scored rows — since one prediction date produces up to 3 windows ×
  N tickers of scored rows).
- For each existing `byAction` / `byConviction` bucket (these remain two
  separate dictionaries, matching the current data model — not a new
  combined action×conviction cross-tab), compute a second `CalibStats`
  restricted to rows whose `date` falls within the most recent 15 prediction
  dates.
- A bucket is flagged as **decaying** only if both the all-time and recent
  slices have ≥ 3 scored calls (reusing the existing `bestEdge` threshold
  convention) *and* recent accuracy is ≥ 15 percentage points below all-time
  accuracy. Buckets that don't meet the minimum sample size on either side
  are omitted from decay output entirely — not shown as "no decay", just not
  reported, so thin buckets don't produce false confidence either way.
- Add to `CalibrationJSON`:
  ```ts
  interface DecayEntry {
    // Matches the existing bestEdge/worstSignal naming convention:
    // "<action> (<window>)" from byAction, "<conviction> (<window>)" from byConviction.
    signal:          string  // e.g. "trim (30d)" or "high (30d)"
    allTimeAccuracy: number
    recentAccuracy:  number
    allTimeCalls:    number
    recentCalls:     number
  }
  decayWindowPredictions: number   // 15, recorded so the JSON is self-describing
  decaying: DecayEntry[]           // sorted worst-drop-first
  ```
- `backtest-report.ts`: add a "Signal Decay" section to the markdown report,
  rendered only when `decaying.length > 0`, one row per flagged signal in the
  same table style as the existing accuracy tables.

### Data flow

No new inputs. `predictions.jsonl` and the Yahoo chart fetch are the only
data sources, unchanged. Output surface is additive only —
`calibration.json` gains two new top-level fields, `report.md` gains one
optional section. Nothing existing is removed or restructured, so the
briefing agent's existing consumption of `calibration.json` keeps working
untouched; it simply has more fields available to reference if a future
prompt change wants to use them (out of scope here — this task is the
tracking/reporting only, not wiring `decaying` into the briefing prompt).

### Testing

`apps/investment-analyst-agents` uses vitest. Add unit tests for:
- `computeCalibration`'s new decay logic: synthetic `BacktestRow[]` fixtures
  covering (a) a bucket with a real accuracy drop that should flag, (b) a
  bucket with a drop but insufficient sample size that should be omitted,
  (c) a bucket with no drop that should not flag.
- No new test needed for the `adjclose` switch itself (it's a one-line field
  read, not new logic) — but existing tests, if any, mocking the Yahoo
  response shape should include an `adjclose` field so they don't silently
  pass against a shape the real API wouldn't return the old way either.

### Out of scope

- Building an actual quantitative factor library (momentum, valuation,
  fundamentals) — the user confirmed decay tracking should apply to the
  existing action/conviction signals, not a new factor system.
- Calendar/monthly decay cohorts — revisit once prediction history is deep
  enough (several months) for monthly buckets to carry statistical weight.
- Wiring `decaying` output into the briefing agent's prompt so it actively
  avoids decayed signals — this task only adds the tracking/reporting layer.
