# LINE retirement audit — inventory and sequence

> **EXECUTED 2026-08-28.** The inventory below is the pre-retirement state and
> is kept as the record of what was removed and why. See **OUTCOME** near the end
> for what was actually done. The alerts agent and daily scheduler remain
> unloaded; LINE is not muted any more because there is no channel left to mute.

## The decision this serves

LINE is **not part of the production correctness boundary**. The system must be
fully correct with LINE unavailable, credentials absent, LINE code removed, and
no outbound notification channel configured at all. Production truth lives in
authoritative stores and the dashboard/briefing surfaces — never in notification
delivery.

Two invariants follow, and they are what the audit checks each path against:

1. **Detection must never depend on successful notification delivery.**
2. **Notification failure must never control whether authoritative business
   state advances.**

---

## The whole LINE surface — nine files

Verified by sweeping `api.line.me`, `sendLine`, `line-notifications-muted` and
`LINE_CHANNEL_ACCESS_TOKEN` across every extension outside `node_modules`,
`dist` and `.next`.

| File | Role |
|---|---|
| `apps/scenario-simulator/src/notify/line.ts` | the boundary: `sendLine` + 2 formatters |
| `apps/scenario-simulator/src/cli/cli-alerts.ts` | caller |
| `apps/scenario-simulator/src/cli/cli-discover.ts` | caller |
| `apps/scenario-simulator/src/cli/cli-run.ts` | caller |
| `apps/world-intelligence-data-hub-/run.ts` | own second implementation |
| `scripts/pipeline-watchdog.sh` | own third implementation (curl) |
| `scripts/daily-catchup.sh` | own fourth implementation (curl) |
| `packages/queue/src/isolation.ts` | `notificationPolicy()` — **dead code** |
| `packages/queue/tests/isolation-mode.test.ts` | its only importer |

Plus: `data/line-notifications-muted` (kill switch), `LINE_CHANNEL_ACCESS_TOKEN`
/ `LINE_USER_ID` in `apps/scenario-simulator/.env`,
`~/Library/LaunchAgents/com.thanapol.ai-capital.alerts.plist` and
`scripts/run-alerts.sh` (the alerts scheduler), and the two unmanaged
`npm run schedule` cron daemons that can reach senders outside the DAG.

---

## Per-path audit

### 1. `cli-alerts` — threshold alert · **CLASS C, and the only real blocker**

| | |
|---|---|
| Trigger | launchd `…alerts` every 30 min in market hours — **currently unloaded** |
| Condition detected | a holding crossed a price/news-velocity threshold |
| Authoritative persistence | **NONE** |
| LINE-specific side effects | `sendLine(message)`; `saveState()` → `alert-state.json` |
| Removing LINE changes business correctness? | **No** — it computes from the portfolio store and writes nothing back |
| Removing LINE changes dedupe/state progression? | **Yes, totally** — `alert-state.json` exists *only* to dedupe LINE |
| Safe retirement action | **Blocked.** Give the detection an authoritative sink and a surface first |

**This is the finding that matters.** `cli-alerts` writes exactly one file —
`alert-state.json`, the LINE dedupe — and **no surface anywhere reads it**
(verified: zero references to `alert-state` / `lastAlertPrice` in
`unified-platform` or `investment-analyst-agents`). The detected condition is
never persisted.

So LINE is not this detector's *notification channel* — it is its **only
output**. Delete LINE today and the stage computes thresholds and discards them.
That violates invariant 1 in the strongest possible way, and it is why this path
cannot be retired in the same step as the others.

*Also note the original incident lives here: `sendLine` returns `void` when
muted, the caller logs "sent" and calls `saveState()`, consuming the alert.*

### 2. `cli-discover` — discovered trade · **CLASS B**

| | |
|---|---|
| Trigger | Sunday DAG stage `scenario-discover`; also the unmanaged `npm run schedule` daemon at 06:45 |
| Condition detected | a paper position was opened |
| Authoritative persistence | **Yes** — `PaperPortfolio` (`discovery.db`), written *before* the send |
| LINE-specific side effects | `sendLine(formatDiscoveryBuy(...))` |
| Business correctness on removal | **Unchanged** |
| Dedupe/state progression on removal | **Unchanged** — no state is tied to the send |
| Safe retirement action | delete the `sendLine` call and the `formatDiscoveryBuy` import |

*Today stage retry silently destroys this notification — the retry re-reads open
tickers and skips the already-open position. Retiring the channel removes the
defect along with the channel.*

### 3. `cli-run` — scenario signal · **CLASS B**

| | |
|---|---|
| Trigger | DAG stage `scenario-simulate` |
| Condition detected | actionable trade signals for the day |
| Authoritative persistence | **Yes** — markdown report under `reports/`, plus `simulation.db` scenarios and refreshed prices in `portfolio.db` |
| LINE-specific side effects | `sendLine(formatTradeSignals(...))` |
| Business correctness on removal | **Unchanged** |
| Dedupe/state progression on removal | **Unchanged** — fire-and-forget |
| Safe retirement action | delete the `sendLine` call and the `formatTradeSignals` import |

### 4. `world-intel` — stale source · **CLASS B, small C**

| | |
|---|---|
| Trigger | DAG `world-intel-pipeline`; also the unmanaged daemon, ~96×/day for GDELT |
| Condition detected | a source has had no successful fetch in longer than expected |
| Authoritative persistence | **Yes** — `quota/quota-tracker.ts` persists `lastSuccessfulFetch` per source; `isStale()` derives from it |
| LINE-specific side effects | own `fetch`, own `.env` regex parser, own cwd-dependent mute check, and `quota/stale-alerted-{date}.json` marker |
| Business correctness on removal | **Unchanged** — staleness is durable and independently derivable |
| Dedupe/state progression on removal | Marker disappears with the channel. **Small C:** the marker is currently written after non-OK and throw, so it advances on failure |
| Safe retirement action | delete `alertOnStaleSourcesOnce` entirely — implementation, env parser, mute check and marker together |

### 5. `pipeline-watchdog.sh` · **CLASS B, C on visibility**

| | |
|---|---|
| Trigger | scheduled, outside the pipeline by design |
| Condition detected | daily pipeline missing / stale / failed, via `packages/pipeline-runs/bin/daily-run-status.ts` |
| Authoritative persistence | **Yes, upstream** — `pipeline_runs`, written by the stages themselves. The watchdog only reads |
| LINE-specific side effects | curl, credential load from `apps/scenario-simulator/.env`, mute check, `data/.watchdog-alerted-{logical}-{state}` marker |
| Business correctness on removal | **Unchanged** |
| Dedupe/state progression on removal | Marker is LINE-only. **Existing defect:** `touch "$MARKER"` runs *before* the isolation gate and the mute check, so a muted watchdog burns its marker permanently |
| Safe retirement action | delete the LINE block and the marker; **keep detection and the log line** |

**The C part:** the dashboard already reads the run store
(`/admin/pipeline`, `/system/pipeline`), so pipeline state *is* surfaced — but
by **pull**, not push. `daily-run-status.ts` is consumed only by shell scripts.
Removing LINE means a broken pipeline is visible when you look, not when it
happens. That is an accepted consequence of the architectural decision, but it
should be a decision, not a discovery.

### 6. `daily-catchup.sh` · **CLASS B, same C**

| | |
|---|---|
| Trigger | wake/login guard |
| Condition detected | today's daily pipeline has already failed N times |
| Authoritative persistence | **Yes, upstream** — reads `pipeline_runs` read-only |
| LINE-specific side effects | curl, credential load, mute check, `data/daily-catchup-alerted-{date}` marker |
| Business correctness on removal | **Unchanged** |
| Dedupe/state progression on removal | Marker is LINE-only. **Same marker-before-mute defect** |
| Safe retirement action | delete the LINE block and the marker; keep detection and the log line |

### 7. Raw-curl senders · **CLASS B**

Both live inside paths 5 and 6 and retire with them. Between them they own two
independent mute checks, two credential loads and two "sent" log lines, none of
which observes the HTTP result.

### 8. Other implementations and schedulers

| Surface | Class | Action |
|---|---|---|
| `notificationPolicy()` in `isolation.ts` | **B — dead** | imported only by its own test; delete both |
| `data/line-notifications-muted` | B | delete last, after every sender is gone |
| LINE creds in `apps/scenario-simulator/.env` | B | remove last |
| alerts plist + `scripts/run-alerts.sh` | **C** | it schedules the *detector*, not the channel. Retire only once cli-alerts has an authoritative sink, or rehost the detection in the DAG |
| the two `npm run schedule` cron daemons | **C, separate** | they bypass launchd, the DAG, `pipeline_runs`, isolation and locking. Retirement is a separate decision already recorded; both remain stopped |

---

## What would break if LINE disappeared today

```
Business correctness .......................... nothing breaks
  cli-discover  -> discovery.db written before the send
  cli-run       -> report + simulation.db written before the send
  world-intel   -> quota tracker holds lastSuccessfulFetch
  watchdog      -> reads pipeline_runs, writes nothing
  catchup       -> reads pipeline_runs, writes nothing

Operator visibility ........................... three losses
  threshold alerts  -> NO surface at all          <-- blocker
  watchdog state    -> pull-only via dashboard    <-- accepted, but decide
  catchup failures  -> log only                   <-- accepted, but decide

Dedupe/state progression ...................... only LINE-scoped state
  alert-state.json, 3 marker families — all exist solely to dedupe LINE
  and are deleted with it
```

The dependency is one-directional and shallow: **no authoritative store is
written by a notification path**, with the single exception that `cli-alerts`
has no authoritative store at all.

---

## Proposed minimal retirement sequence

**Rollback point:** tag `pre-line-retirement` at the current HEAD. Every step is
code-only — no schema change, no data migration, no production-state mutation.
Steps 1–7 are individually revertible by `git revert`; step 8 is the only one
touching credentials and configuration and should be last.

| # | Step | Class | Risk |
|---|---|---|---|
| **0** | Decide the two visibility questions: does watchdog/catchup state need a push channel at all, and where do threshold alerts land? | — | **prerequisite** |
| **1** | Give `cli-alerts` an authoritative sink (an alert-event record) and a read surface | **C** | prerequisite for step 6 |
| 2 | Remove `sendLine` from `cli-run` | B | none — no state tied to the send |
| 3 | Remove `sendLine` from `cli-discover` | B | none |
| 4 | Delete `alertOnStaleSourcesOnce` from `world-intel/run.ts` | B | removes the failure-path marker defect |
| 5 | Delete the LINE blocks and markers from both shell scripts, keep detection + logging | B | removes the marker-before-mute defect |
| 6 | Remove `sendLine` and `saveState` from `cli-alerts`; detection writes to the sink from step 1 | C | **the incident path** — do last among callers |
| 7 | Delete `notify/line.ts`, `notificationPolicy()` and its test | B | formatters die with it — keep them if a future adapter or the briefing wants the wording |
| 8 | Delete the mute file, remove credentials from `.env`, unload/remove the alerts plist if detection has been rehosted | B | last, and separately revertible |

**Not in scope of the sequence:** the two cron daemons (separate decision, both
stopped), and the frozen items — daily scheduler, queue cleanup, reconciler,
historical flows.

---

## Preserved evidence — NOT REMEDIATED

Revision 4 of `2026-08-28-line-delivery-authority.md` and Warden's architecture
attack are kept as design evidence. **These issues were never fixed; the channel
was retired before implementation.** Recorded so that anyone reviving an
outbound channel starts from what was already found rather than rediscovering it.

| ID | Issue | Status |
|---|---|---|
| **F1** | episode/event terminal-state ambiguity — the 24h abandon branch is unreachable under bounded retry, and attempt exhaustion marks the *event* terminal, so a transient blip causes permanent silence | **NOT REMEDIATED — channel retired before implementation** |
| **F2** | mute cannot preempt a live episode; no state cell for "operator muted mid-episode" | **NOT REMEDIATED** |
| **F3** | watchdog durability when Postgres is unavailable — best-effort persistence and persist-before-send are mutually exclusive, and the degraded path is the correlated one | **NOT REMEDIATED** |
| **F4** | business freshness is shorter than transport retry lifetime, so the recovery sweep can ship a stale frozen payload | **NOT REMEDIATED** |
| **F5** | severity/event identity — a terminal event can be resurrected, and escalation within a day is silently dropped | **NOT REMEDIATED** |
| **U1–U6** | concurrent episode creation, unowned expiry/mootness, unstored observation and attempt layers, 429 with no circuit breaker, superseded L6 DDL still present, Thai session straddling the LA date boundary | **NOT REMEDIATED** |

Warden's independently verified positive result is also worth keeping: the
`discovery:{positionId}` identity is collision-safe — positions use
`randomUUID()` into a `TEXT PRIMARY KEY`, not an autoincrement rowid.

---

## OUTCOME — retired 2026-08-28

Executed. Rollback tag `pre-line-retirement`.

**Decision 1 — threshold alerts kept, with an authoritative record.**
`apps/scenario-simulator/src/alerts/alert-store.ts` records that a condition
EXISTED: `alert_id, rule_id, instrument, direction, severity, observed_value,
threshold, detected_at, last_observed_at, status, resolved_at, business_date,
evidence`. No delivery state, no retry key, no channel — deliberately not a
notification ledger. Dedupe is a business question: identity is
`(rule, instrument, business_date)`, a condition holding across runs is one
alert whose observation updates, and it resolves when it stops holding. An
instrument that could not be priced is left alone rather than wrongly resolved.
Detection is unconditional — the old cooldown gated detection itself. Surfaced
read-only on `/portfolio`; the file is directly readable by Glenn.

**Decision 2 — no push replacement.** Watchdog and daily-catchup keep their
detection and their derived interpretation of the state, and log it. Their
markers are gone with the channel.

> **PRODUCT LIMITATION, accepted:** a pipeline failure is visible in
> authoritative status surfaces — `/admin/pipeline`, `/system/pipeline`, and the
> script logs — but **does not currently page the operator.** Operational
> awareness is pull-based. Revisit only if usage shows pull-only is
> insufficient; do not solve it by building another outbound system.

**Decision 3 — both formatters deleted.** `formatTradeSignals` and
`formatDiscoveryBuy` composed LINE message text whose business content already
exists in the daily report and `discovery.json`. Dead formatting was not kept
against a hypothetical future consumer.

**Removed:** `notify/line.ts`; the sends in `cli-run`, `cli-discover`,
`cli-alerts`; `alertOnStaleSourcesOnce` with its hand-rolled `.env` parser and
cwd-dependent mute check; both shell LINE blocks with their marker-before-mute
behaviour; `notificationPolicy()` and its tests; `alert-state.json`; the
watchdog, catch-up and stale-source markers; the mute file; and the LINE
credentials.

**Preserved:** `daily-catchup`'s `exit 0` — business logic, not notification: do
not auto-resubmit a pipeline that already failed today.

### C — the daily-catchup change was NOT preservation (correction)

I previously reported `daily-catchup`'s `exit 0` as "preserved, unchanged". That
was wrong, and the correction matters because it is the incident shape again.

The old guard was `[ "$FAILED_COUNT" -gt 0 ] && [ ! -f "$ALERT_MARKER" ]`. The
marker existed to stop LINE repeating itself — but it also gated the `exit 0`.
So on a **second** same-day fire the marker was present, the whole branch was
skipped, and a pipeline that had already failed today was **auto-resubmitted**.

A notification-dedupe marker was deciding whether a failed pipeline could be
retried. That is precisely the coupling this retirement exists to remove, and it
was found only because the channel was being pulled out.

It is now unconditional on `FAILED_COUNT > 0`. **Recorded as an intentional
business-correctness change discovered during retirement**, not as preservation.

### B — world-intel staleness: detection kept, surfaced by pull

Warden established that removing `alertOnStaleSourcesOnce` removed the only
human-facing consumer of `quota.isStale()`. That is a visibility regression
distinct from the accepted "pipeline failures are pull-based" limitation, and it
is not accepted — that control exists because ACLED was 403-broken for nine days
unnoticed.

`quota/freshness.ts` now exports per-source freshness — source identity, last
successful fetch, the bound it is judged against, age, stale/current, and a
plain-language reason — written every pipeline run and surfaced read-only on
`/system/pipeline`. It is built from the tracker's **own** `isStale`, so the
threshold stays defined in one place rather than being re-implemented in the
dashboard where it could drift.

No notification delivery state, no retry state, no markers, no outbound
messaging.

**The first export immediately found two dead feeds:** ACLED last succeeded
1538h ago against a 24h bound (64 days), and GDELT 35h against a 2h bound.
Neither was visible anywhere before this.

**Verified against the real detector**, not fixtures: 19 positions checked, LLY
opened at −6.88% intraday; a second run reported `0 opened, 1 continuing` with
`detected_at` preserved and `last_observed_at` advanced.

---

## What I need decided before any implementation

1. **Where do threshold alerts land?** This is the blocker. Options: a durable
   alert-event table surfaced on the dashboard; a section in the daily briefing;
   or accept that threshold detection retires with the channel. The third is
   legitimate but should be chosen rather than fallen into.
2. **Do watchdog and catchup need push at all?** Their detection survives and the
   dashboard shows pipeline state, but only when looked at. A pipeline that
   silently stops is the failure this whole effort began with.
3. **Keep or delete the formatters?** `formatTradeSignals` and
   `formatDiscoveryBuy` are message-composition, not transport, and may be worth
   keeping for the briefing.
