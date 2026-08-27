# Incident — 2026-08-27 autonomous daily run parked; third consecutive occurrence

**Read-only evidence record. The run and its queue state are preserved untouched.**

## What happened

The **then-installed** `com.thanapol.ai-capital.daily` LaunchAgent fired on its
own and submitted a daily pipeline. Nobody asked it to; it was operating on the
stale Pacific-cached 07:00 PT calendar trigger, which now lands at ~21:00
Asia/Bangkok.

```
[2026-08-27 21:09:21 +07] no daily-pipeline row for today — triggering catch-up run
[run-daily] submitting daily pipeline at 2026-08-27T14:23:54.788Z
```

The agent was booted out immediately afterwards
(`launchctl bootout gui/501/com.thanapol.ai-capital.daily`) as an intentional
temporary production safety action. Its plist remains on disk for restore.

## Outcome

It progressed **further than 2026-08-26** — `capital-ingestion` and
`thesis-memory` both succeeded — and then died the same way.

| | |
|---|---|
| logical run | 2026-08-27, submitted `14:23:54.788Z` (21:23 +07) |
| parent `daily-pipeline` | **still `running`** — never closed |
| stages executed | 24 |
| stages recorded `failed` | **0** |
| BullMQ failed set | **39 → 41** |
| `waiting-children` | **221 → 228** |
| briefing produced | **none** — latest remains `2026-08-25.md` |
| queue after | `active=0 wait=0 delayed=0` — nothing runnable |

### Seven downstream stages never ran

Parked in `waiting-children`, permanently:
`ai-analysis-engine`, `scenario-simulate`, `briefing-backtest`, `risk-metrics`,
`tax-harvest`, `investment-brief`, `morning-status`.

### THE DISTINCTION THAT MATTERS

> A `pipeline_runs` row reading `success` describes ONE delivery of that stage.
> It does **not** mean the stage was executed exactly once.

**Zero stages recorded `failed`, yet the BullMQ failed set grew by two.** Two
jobs died at the queue level without the processor ever writing a row — the
stalled-job path bypassing `processor.ts` entirely. The persisted record and the
queue's reality disagreed, and the persisted record was the optimistic one.

### Three stages executed twice, both times successfully

| stage | first | second |
|---|---|---|
| `macro-asset-monitor` | 14:24:15 | 14:28:17 |
| `government-flow-monitor` | 14:26:31 | 14:56:07 |
| `scenario-refresh` | 14:28:19 | 14:38:38 |

Each appears in `pipeline_runs` as two independent `success` rows. This is
re-delivery after a lost lock, not retry-after-failure — a failed attempt would
have carried a `failed` status.

## Why this run is useful evidence

It is the first occurrence observed while instrumented, and it confirms all four
defects simultaneously and independently of 2026-08-26:

1. parent lifecycle does not converge (`running` with an idle queue);
2. queue-level failure is invisible to `pipeline_runs`;
3. at-least-once delivery is real and current, not historical;
4. `waiting-children` grows monotonically with every dead flow.

**Preserved untouched** for validating terminal reconciliation: the parent row,
the seven parked jobs, the two new failed-set entries, and all 228
`waiting-children`.
