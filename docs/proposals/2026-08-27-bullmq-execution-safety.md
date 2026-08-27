# P0 decision package — BullMQ execution safety

**Status: INVESTIGATION ONLY. Nothing implemented. No production mutation.**

## 1. Lock-renewal root cause: macOS suspends the worker; the lock is wall-clock

**It is not a blocked event loop, not CPU-bound synchronous work, and not
child-process interference.** `processor.ts` runs stages via `spawn()` wrapped in
a Promise — fully async, the loop stays free.

The stack trace says renewal *ran and was rejected*:

```
Error: Missing lock for job ... moveToDelayed
  at async LockManager.extendLocks (bullmq/dist/cjs/classes/lock-manager.js:32)
  at async Timeout._onTimeout        (bullmq/dist/cjs/classes/lock-manager.js:80)
```

The timer fired; the lock was already gone. Cause:

| | |
|---|---|
| `lockDuration` | 30 s (BullMQ default — `createWorker` passes only `connection` + `concurrency`) |
| renewal interval | 15 s (`lockDuration / 2`) |
| **Sleep events on 2026-08-26** | **41** |
| **Sleeps during the single 40-min `world-intel-pipeline` stage** | **10** |
| Sleep inside the duplicate `scenario-simulate` window (22:20–22:27) | yes, 22:21:00 |

macOS suspends the worker process. Its renewal timer stops. Redis TTLs are
**absolute wall-clock**, so the 30-second lock expires during the suspension even
though nothing executed. On wake, `extendLocks` finds no lock, and the
stalled-checker (`maxStalledCount = 1`) re-delivers the job — while the original
child process is often still running.

`caffeinate -i` in the worker plist prevents *idle* sleep only. These are
`Sleep Service` / `Maintenance Sleep` / lid-close transitions, which `-i` does
not block.

**Consequence for the repair:** raising `lockDuration` treats the symptom and
helps for short sleeps, but no finite value survives an overnight suspension.
The durable property must be *idempotence under re-delivery*, not a longer lock.

## 2. Stages proven to have executed twice

Repeats where **both executions SUCCEEDED** — the only ones that can duplicate a
side effect. Everything else in the "×3" counts is ordinary retry-after-failure.

| date | stage | executions |
|---|---|---|
| 2026-08-26 | `scenario-simulate` | 15:20:59, 15:25:06 |
| 2026-08-25 | `scenario-refresh` | 17:17:30, 18:44:12 |
| 2026-08-24 | `macro-asset-monitor` | 14:40:47, 14:49:42 |
| 2026-08-24 | `wave-analyzer` | 14:23:24, 14:55:59 |
| 2026-08-12 | `scenario-refresh` | 14:08:27, 14:41:01 |
| 2026-07-27 | `scenario-refresh` | 14:01:23, 14:03:50 |
| 2026-07-26 | `scenario-refresh` | 14:08:55, 14:14:51 |
| 2026-07-25 | `scenario-refresh` | 14:01:37, 15:08:33 |

**Eight events, four distinct stages, in all recorded history.**

**Correction to the earlier framing:** `ai-analysis-engine ×3` and
`capital-ingestion ×2` are `failed,failed,failed` / `success,failed` — retries,
not duplicate successes. **No stage in the priority list has ever executed
successfully twice.**

## 3. Stage table

| stage | runs | avg | max | failed | dup-success | side effects | idempotent? | consequence if duplicated |
|---|---|---|---|---|---|---|---|---|
| `world-intel-pipeline` | 82 | 24 m | **745 m** | 32 | 0 | writes `quota/state.json`, world-intel exports | yes (overwrite) | none observed; **it is the stall epicentre** |
| `capital-ingestion` | 74 | 12 m | 96 m | 11 (+2 killed) | **0** | **INSERTs** `capital.documents` / `chunks`; advances `fetch_log` | **dedup by `doc_hash`** | duplicate docs suppressed by hash; chunk re-embed cost only |
| `scenario-refresh` | 84 | 2 m | 32 m | 2 | **5** | `portfolio.positions` via `ON CONFLICT (ticker) DO UPDATE` | **yes** | none — last write wins with identical data |
| `scenario-simulate` | 95 | 2 m | 22 m | 30 | **1** | writes `reports/YYYY-MM-DD.md`, `simulation.json` | **yes** (overwrite same path) | none |
| `ai-analysis-engine` | 77 | 2 m | 6 m | 21 | 0 | writes `analysis.json` | yes | none |
| `investment-brief` | 55 | 2 m | 3 m | 0 | 0 | writes briefing **+ LINE push** | **NO — LINE is a send** | duplicate briefing notification. Currently masked: LINE muted since 2026-07-10 |
| `morning-status` | 55 | <1 m | <1 m | 0 | 0 | writes digest | yes | none |
| `thesis-memory` | 61 | <1 m | <1 m | 0 | 0 | per-ticker thesis rows | needs audit | **unknown — not yet verified** |

**`investment-brief` is the one stage where duplication is genuinely harmful,
and it has never duplicated** — its max runtime is 3 minutes, far inside the
30-second-lock/renewal window's tolerance for a short suspension. The stages
that *do* duplicate are the long ones.

## 4. Has duplicate execution corrupted production? **No.**

Direct tests:

- `portfolio.trade_log`: **0 duplicate rows** across all 40 rows
  (`group by trade_date, ticker, action, shares, price having count(*) > 1`).
- `logTrade()` — the only non-idempotent `INSERT` in the portfolio store — is
  **never called by any duplicated stage**; `cli-refresh` does not touch it.
- `portfolio.positions`: 0 duplicate tickers.
- Every duplicated stage's write path is an upsert or a whole-file overwrite.

The duplicates landed exclusively on idempotent paths. This is luck, not design.

## 5. Isolated reproduction of the trim/resurrection hazard: **CONFIRMED**

Run against a throwaway `redis-server` on port 6399 (separate dir, no
persistence). Production Redis on 6379 was never touched — verified before and
after: 39 failed / 221 waiting-children, unchanged.

```
AFTER CHILD FAILS
  parent state     : waiting-children
  failed set size  : 1

PUSHING 5 MORE FAILURES (cap=3) ...
  !!! PARENT EXECUTED: parent id=1544b894 data={"parentRunId":"JUNE-RUN-ID"}

AFTER TRIMMING
  parent state     : completed
  waiting-children : 0

VERDICT: RESURRECTION REPRODUCED
```

The parked parent was moved to `wait` and **executed by the live worker**,
carrying its original stale `parentRunId`. Warden's reading of the Lua is
correct and is now demonstrated rather than argued.

### Production blast radius

61 more failures reach the cap. Recent daily failure counts: 10, 6, 5, 4, 3, 3.

What is parked (221 jobs, 22 flows, oldest 2026-06-23):

```
22 morning-status      16 thesis-memory      15 capital-ingestion
22 investment-brief    16 ai-analysis-engine  15 briefing-backtest
15 tax-harvest         15 risk-metrics        14 world-intel-export   ...
```

The two highest-side-effect stages are the two most numerous. The oldest cohort
carries `parentRunId = b89842f2-…`, a `daily-pipeline` row from **2026-06-23**
already recorded `failed` — so resurrected stages would append children to a run
closed two months ago, and `investment-brief` would generate a briefing from
June's inputs.

## 6. Proposed DAG lifecycle policy (structural, not a bigger number)

Raising `count` only postpones the same event. Proposed instead:

1. **`removeOnFail: false` for flow jobs.** A failed job that pins a parent must
   never be evicted by a size cap. Retention becomes explicit, not incidental.
2. **Explicit terminal cleanup.** When a DAG reaches a terminal state, remove the
   *whole flow* — parent and children together — so nothing is left parked. This
   is what should have happened on 2026-06-23 and 21 times since.
3. **Age-based sweep, not count-based**, for anything that still escapes: remove
   flows whose root is older than N days *as a unit*, never leaf-by-leaf.
4. **An invariant to assert:** `waiting-children` should be empty whenever no run
   is in flight. Today it holds 221. That single check would have caught this in
   June.

The existing 221 are **not** to be cleaned yet — that is a separate approved
action, and doing it wrongly (deleting failed leaves first) triggers the exact
resurrection this document describes. **Correct order: remove parents first, or
remove each flow atomically.**

## 7. Parent-run reconciliation design

Today the parent row closes on exactly two paths: root-job success, and a throw
inside `processor.ts` after exhausted attempts. A stall takes neither, so the
parent stays `running` forever — the 2026-08-26 orphan.

Proposed: reconcile from **queue terminal events**, not from the processor's
control flow. Attach `QueueEvents` listeners in the worker for
`completed` / `failed` / `stalled` / `removed`, and on any terminal event for a
job whose `parentRunId` has no closed row, evaluate the flow as a whole:

- root succeeded → parent `success`
- any job permanently failed / stalled-out → parent `failed`, recording which
  stage and why
- flow removed → parent `failed` (`"flow removed before completion"`)

Plus a **sweeper as backstop**: any `daily-pipeline` row in `running` past the
stale threshold with no live job in the queue is closed `timeout` **by a process
that owns that responsibility** — not by a dashboard page render, which is the
current accidental owner.

Objective stated as an invariant: *queue execution state and persisted pipeline
state converge even when the processor exits abnormally.*

## 8. Test isolation — three independent dimensions

The harness isolated the database and nothing else, so it wrote a **fake
`state=success logical=2026-08-27`** into the production scheduler log, which
then misled Warden into suspecting a wrong-database production run. That cost
real review time and is exactly the class of artifact a test must never create.

| dimension | today | proposed |
|---|---|---|
| **database** | `PIPELINE_RUNS_DB` env — isolated | keep |
| **Redis** | not isolated at all | `REDIS_URL` honoured by every entry point; tests use a throwaway server (demonstrated above on :6399) |
| **filesystem / logs** | `ROOT` hardcoded in `daily-scheduler.sh` / `pipeline-watchdog.sh` | `AI_CAPITAL_ROOT` env, defaulting to the real root; all logs, locks, markers and heartbeats resolve beneath it |

Two additional rules:

- **Tests set all three or refuse to run.** A harness that isolates two of three
  is more dangerous than one that isolates none, because its output looks real.
- **Test-produced artifacts are self-identifying.** Every line a test writes
  carries a `[TEST]` prefix, so no operator or auditor can mistake it for
  production evidence even if isolation fails.

## 9. Smallest BullMQ repair

Ordered by ratio of risk removed to change made:

1. **`removeOnFail: false` on flow jobs** — one line in `submit.ts`. Disarms the
   resurrection hazard entirely. Nothing else on this list matters if a June
   `investment-brief` can fire.
2. **Terminal-event reconciliation + sweeper** (§7) — makes orphans
   self-resolving and removes `/admin/pipeline` as the accidental reaper.
3. **`lockDuration` sized to the real workload, with `maxStalledCount` raised.**
   Max observed runtime is 745 minutes; 30 s is off by three orders of
   magnitude. This *reduces* re-delivery but cannot eliminate it under sleep, so
   it is third, not first.
4. **Idempotency audit of `thesis-memory`**, the one priority stage whose write
   path I have not verified.

Deliberately **not** proposed: making the machine stay awake. Sleep is a
property of this deployment, and the fix must tolerate it.

## 10. What must be true before a fresh daily pipeline is safe

1. `removeOnFail: false` (or the 221 parked flows removed **atomically**), so a
   run's own failures cannot resurrect June.
2. Parent reconciliation exists, so a stalled run does not leave a third orphan.
3. Blocker 4 fixed — `timeout`/`killed` must not yield `eligibleToRun: true`
   beside a non-null `runId`. Composed with the dashboard reaper this is a
   duplicate-submission trigger for the *new* run.
4. `/admin/pipeline` must not be loaded during the run, until 3 is fixed.
5. Submit via `npx tsx packages/queue/bin/run-daily.ts` — **not** `daily-queue.sh`,
   whose >12 h zombie sweep would rewrite the 2026-08-26 row before submitting.
6. `thesis-memory` idempotency confirmed.

Items 1–3 are code changes and remain unimplemented pending approval.
