# Proposal — bounded lookback for the pipeline watchdog

**Status: PROPOSAL. Not implemented.** Warden's pre-install attack found four
blocking defects in the scheduler/watchdog, so no design change is being made
until those are resolved and this proposal is approved.

## The gap

`assessDailyRun` evaluates `logicalRunDate(now)` — today only. The 2026-08-26
stale orphan is therefore invisible to the component built to report stale runs.
The first real stale run in the system would never be reported by it.

## Window: 7 prior logical days

Grounded in the record, not chosen for roundness:

- Over the last 30 logical days: 11 failed, 1 absent, 1 stale, the rest success.
  A ~38% non-success rate means a long window would carry a permanent backlog
  and every alert would arrive pre-ignored.
- Exactly one `running` orphan exists in the entire history, so orphans are rare
  events worth one loud notification, not a recurring digest.
- Seven days covers a full operational cycle including the Sunday-only stages
  (discovery, people-tweets, correlation), so a weekly stage that failed is
  still inside the window on the next occurrence.

Beyond 7 days an unresolved run is **backlog**, not an operational alert. It
belongs on the dashboard, not on a phone.

## Alertable states in the lookback window

For a PRIOR day the state space collapses — `not_due` and `no_opportunity`
cannot apply, because the day is past and the machine has demonstrably been
awake since.

| State | Alert in lookback? | Why |
|---|---|---|
| `success` | no | resolved |
| `stale` | **yes** | unresolved orphan; needs a human decision (retry / close / ignore) |
| `failed` | **yes, once** | it already alerted on the day; the lookback alert exists only so a failure that happened while the phone was off is not lost forever |
| `missing` | **yes, once** | a day that produced no run at all |
| `running` | n/a | on a prior day it is past the stale threshold by definition |

## Resolution — when an item stops being operationally relevant

Three ways out, any one sufficient:

1. **Resolved** — a `success` row exists for that logical date.
2. **Acknowledged** — an explicit ack (see below). This is the escape hatch for
   "I have seen it and chosen not to act", which is a legitimate outcome for the
   08-26 orphan.
3. **Aged out** — older than the 7-day window.

Deliberately NOT a fourth: "the row was rewritten". The dashboard's
`reapOrphans()` already rewrites `running` to `timeout` on render, which would
silently resolve an item nobody looked at. An automatic rewrite must not count
as acknowledgement.

## Deduplication

The current marker scheme is `data/.watchdog-alerted-<date>-<state>`, written
**before** delivery is attempted — so a single transient failure permanently
consumes the alert (Warden H6), and the global mute consumes it too (Blocker 2).
Both must be fixed before lookback is added, or lookback multiplies the bug
across seven days instead of one.

Proposed:

- Key alerts on `(logicalDate, state)`, as now.
- **Write the marker only after confirmed delivery** — check curl's exit status.
- A **state transition is new information** and re-alerts: `missing → stale`,
  `failed → stale`. The same state is never re-sent.
- Prior-day items are never sent individually. They are rolled into **at most
  one backlog notification per calendar day**, and only when the SET of
  unresolved dates changes. An unchanged set is silent.

## Anti-spam, concretely

The orphan case, end to end:

```
day 1, first poll after it goes stale  -> one alert naming 2026-08-26
day 1, every subsequent poll           -> silent (set unchanged)
day 2..7, all polls                    -> silent (set unchanged)
a second day goes stale                -> one alert (set changed)
2026-08-26 acked or aged out           -> silent, permanently
```

Worst case for a completely dead week: **one notification per day**, naming the
whole unresolved set — not one per poll per day, which at a 30-minute interval
would be 48/day/item.

## Acknowledgement mechanism — needs a decision

Simplest is a file: `data/.pipeline-ack-<logical-date>`, created by an operator
or by an explicit command. No schema change, works when Postgres is down, and is
greppable.

The alternative is a column on `pipeline_runs`. That is cleaner to query from
the dashboard but is a schema change to the observability layer, and it competes
with the `logical_date` unique-index question already open from Warden's H7.
**Recommend deciding both together rather than adding two columns in two passes.**

## Cost

`findRunForDate` is one indexed query per date; a 7-day window is 7 queries per
poll against a local SQLite file. At a 30-minute interval this is negligible and
needs no caching.

## Preconditions

Do not implement until:

1. Blocker 1 (LINE payload is silently empty under bash 3.2) is fixed — otherwise
   lookback produces seven days of alerts that cannot be delivered.
2. Blocker 2 (global mute consumes the alert before the marker check) is fixed.
3. Blocker 3 (watchdog writes no heartbeat, so a dead scheduler is silent) is
   fixed — lookback does not help if the watchdog cannot tell "nothing ran" from
   "machine asleep".
4. Blocker 4 (`timeout`/`killed` fall through to `missing` + eligible) is fixed —
   `timeout` is exactly what `reapOrphans()` writes to the rows lookback reads.
