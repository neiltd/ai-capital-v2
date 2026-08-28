# Incident — muted LINE alerts are consumed, not deferred

**Live at time of writing. Evidence preserved below BEFORE any containment.**
No alert state altered, nothing replayed.

## The defect chain

```
evaluate positions
  -> decide an alert qualifies
    -> sendLine(message)
         isMuted() true  ->  console.warn('[LINE] Notifications muted — skipping')
                             return            <-- Promise<void>, no signal
    -> caller cannot distinguish suppressed from delivered
    -> console.log('[alerts] LINE message sent (N alerts) and state updated')
    -> saveState(state)                        <-- alert marked consumed, dedupe advances
```

`apps/scenario-simulator/src/notify/line.ts:17` — `sendLine` returns
`Promise<void>` and returns early when muted (line 19) or when credentials are
missing (line 26). Both are silent to the caller.

`apps/scenario-simulator/src/cli/cli-alerts.ts:185-187` — awaits `sendLine`,
then unconditionally calls `saveState(state)` and logs *"LINE message sent"*.

## The two adjacent log lines that show it

```
[LINE] Notifications muted (data/line-notifications-muted) — skipping
[alerts] LINE message sent (1 alerts) and state updated
```

The first line is the truth. The second is written anyway, and the state save
next to it is what makes the loss permanent: a suppressed alert is recorded as
delivered and deduped out of future runs.

## Why this is not merely a logging bug

The system conflates **delivery attempted** with **delivery accepted**. Those
are different states, and only one of them may advance dedupe. A muted alert
does not get re-offered later — it is gone.

Same shape as the watchdog logging `LINE alert sent` while curl received an
empty body, and the same shape the `pending -> accepted / terminal_failure`
ledger design exists to prevent.

## Preserved evidence

Captured before stopping anything. See the sibling capture block appended by
the containment step for exact values.

## Deliberately NOT determined yet

- which alerts were evaluated while muted;
- which were marked sent;
- which would otherwise have qualified for later delivery;
- whether reconstruction from `alerts.log` plus the state file is possible.

These need the delivery-state model first. Replaying now would re-fire alerts
whose market conditions have long since changed.

## The eventual invariant

> **muted / failed / unknown delivery != accepted.**
> Only an accepted delivery — or another explicitly defined terminal
> disposition — may advance dedupe state.

Belongs with the `pending -> accepted` ledger work. Not built here.

## Containment applied 2026-08-28

The 30-minute execution agent was stopped. Nothing else was changed: alert state
was **not** altered, and no alert was replayed.

```
launchctl bootout gui/501/com.thanapol.ai-capital.alerts
```

**Why stopping rather than fixing.** Every 30-minute cycle that crosses a
threshold consumes that alert permanently — `alert-state.json` records it as
delivered and the dedupe suppresses it thereafter. The loss is irreversible and
accrues on a timer, so the cheapest correct move is to stop the timer, not to
race a fix against it. The repair belongs to the LINE delivery ledger, which is
frozen.

**State at containment** (all figures from the preserved copies):

| | |
|---|---|
| evaluations logged | 3,044 |
| `LINE message sent` lines | 155 |
| `Notifications muted — skipping` lines | 122 |
| error lines | 159 |
| tickers holding a dedupe entry | 12 |
| most recent consumed alert | `LLY` @ 1176.1, 2026-08-28T02:29:06Z |

The 155-vs-122 gap is not the count of lost alerts — a "sent" line is written on
every threshold crossing, muted or not, and the two counters cover overlapping
but not identical conditions. It is only evidence that the two lines disagree
about the same event. **How many real alerts were consumed while muted is not
yet determined**, and determining it requires the delivery ledger work.

**Restore path**, when the ledger repair lands and LINE is unmuted:

```
launchctl bootstrap gui/501 ~/Library/LaunchAgents/com.thanapol.ai-capital.alerts.plist
```

The plist is untouched on disk. Restoring the agent before the delivery ledger
exists would resume consuming alerts under the same defect.

## Note on the mute path itself

`isMuted()` resolves `join(process.cwd(), '..', '..', 'data', 'line-notifications-muted')`.
That is correct **only** because `scripts/run-alerts.sh:16` does
`cd "$ROOT/apps/scenario-simulator"` first. From the repo root the same
expression resolves to `/Users/thanapold/data/line-notifications-muted`, which
does not exist — so the kill switch would read as OFF. The mute currently works
by accident of one line in one script.
