# Design package — canonical business timezone and travel-independent scheduling

**Status: DESIGN ONLY. Nothing implemented, nothing installed.**

## 1. Recommendation: `BUSINESS_TIMEZONE = America/Los_Angeles`

Your hypothesis is confirmed by the repo, and by four independent lines of
evidence rather than by where the laptop is.

**a. The market-hours logic is PT-native for BOTH markets.**
`apps/unified-platform/src/lib/market-hours.ts` expresses the US session *and*
the Thai SET sessions in Pacific time, and says so: *"Mirrors the trading
windows that used to live in the crontab for scripts/refresh-prices.sh (US +
Thai SET sessions, in PT)."* The Thai session is written as *"19:00-22:30 PT
prior evening"* — Thai market hours are already defined relative to Pacific.
Adopting PT preserves every existing comparison; adopting anything else would
require rewriting the one file that encodes when markets are open.

**b. The observability layer already reports in Pacific.**
`scripts/morning-status.ts:28` renders `NOW_LOCAL` in `America/Los_Angeles`.

**c. The historical schedule was 07:00 PT, held for months.**
Every `daily-pipeline` run from 2026-08-08 to 2026-08-24 started at `14:00:0xZ`
= 07:00 America/Los_Angeles, on time, daily. The 2026-08-23 drift to 21:00
Bangkok was launchd continuing to fire at the *old* absolute instant after
`/etc/localtime` changed — the business time never actually moved.

**d. It is the only stable choice across the itinerary.**
Bangkok → Tokyo → Los Angeles are three machine zones over ~2 weeks. Pacific is
the home base and the market the book is primarily exposed to.

### Why not America/New_York, which is the exchange timezone

Defensible, and it would be the more orthodox choice for a US-equity system.
Rejected because it changes nothing and costs something: a US trading day
(09:30–16:00 ET = 06:30–13:00 PT) falls on the **same calendar date** in both
zones, so logical dates are identical, while switching would invalidate the PT
comments and constants in `market-hours.ts`. If the pipeline ever needs
per-exchange session logic, that belongs in `market-hours.ts` as an exchange
attribute — not in the business-day identity.

### Why not Asia/Bangkok

It is where the laptop is this month, which is precisely the input you told me
to ignore. The Thai holdings (PFM009, SCBCEH, K-ESGSI-THAIESG, SET50) are real
but their sessions are already expressed in PT, and two of the Thai funds
(KKP-US500-UH-E, KKP-NDQ100-UH-E) track US indices.

## 2. The scheduled business time: keep 07:00 `America/Los_Angeles`

At 07:00 PT the day's inputs stand as follows:

| Input | State at 07:00 PT |
|---|---|
| Previous US session | closed 13:00 PT yesterday — settled |
| Thai SET afternoon | closed 03:30 PT today — settled |
| Current US session | opened 06:30 PT — 30 minutes old |

So 07:00 PT captures the most recent *complete* session of both markets. That
is a coherent rationale for a Thai+US book, and it matches what the system did
for months.

**One open question for you, not a defect:** 07:00 PT is 30 minutes *after* the
US open. If you want the briefing to be actionable *before* the open, 06:00 PT
is the natural alternative. I am not changing it — the evidence supports 07:00,
and changing the cut without a stated reason would be me redesigning your
workflow.

## 3. `logical_date` definition

> **`logical_date` = the calendar date in `BUSINESS_TIMEZONE` of the instant the
> logical run became due.**

Concretely: the run due at 07:00 America/Los_Angeles on 2026-09-01 has
`logical_date = 2026-09-01`, whether it physically executes at 07:00 PT, at
23:00 PT after the laptop wakes, or at 21:00 Bangkok while you are travelling.

Properties this gives:

- **Machine-timezone independent.** Changing macOS timezone cannot redefine it.
- **DST-correct by construction** — resolved through the named IANA zone, never
  a hardcoded UTC offset. `America/Los_Angeles` shifts between UTC-8 and UTC-7
  and 07:00 PT stays 07:00 PT.
- **Stable under travel.** 07:00 PT is 21:00 Bangkok and 23:00 Tokyo. The
  business date is the same in all three.

### The existing inconsistency this replaces

The repo currently holds **three** competing notions of "today":

| Convention | Sites | Correct? |
|---|---|---|
| machine-local `toLocaleDateString('en-CA')` | 4 | **no** — breaks on travel |
| UTC `toISOString().slice(0,10)` | 97 | mostly fine (market *data* dates) |
| explicit `America/Los_Angeles` | 3 | yes |

The four machine-local sites are exactly the business-day identity sites:
`cli-brief.ts:21` (names the briefing file), `cli-ask.ts:16`,
`data.ts:20` (dashboard lookup), `morning-status.ts:27`.

`scripts/morning-status.ts` proves the problem in two adjacent lines: `TODAY`
(line 27) is machine-local while `NOW_LOCAL` (line 28) is Pacific. In Bangkok
they disagree by a full calendar date for seven hours a day. Today, right now,
the machine date is 2026-08-27 while the Pacific date is also 2026-08-27 — but
between 00:00 and 07:00 Bangkok they differ, and the dashboard would look for a
briefing filename that does not exist.

**Migration caution:** briefings on disk (`2026-08-20.md`, `2026-08-21.md`,
`2026-08-25.md`) were written under the machine-local convention *while the
machine was in Pacific*, so their names already equal their PT dates. Adopting
PT is therefore backward-compatible for existing files. Any briefing generated
between 2026-08-23 and the fix, while the machine was in Bangkok, could be
misnamed — there are none, because no briefing has been produced since 08-25.

## 4. Travel-independent scheduling semantics

Four concepts, deliberately separated:

| Concept | Definition | Source of truth |
|---|---|---|
| `BUSINESS_TIMEZONE` | `America/Los_Angeles` | a constant in code |
| scheduled business time | 07:00 in that zone | `DUE_HOUR` + `BUSINESS_TIMEZONE` |
| machine timezone | whatever macOS says | **never consulted for identity** |
| actual execution time | when it really ran | `pipeline_runs.started_at` (UTC) |

The launchd trigger stops encoding business time entirely — it supplies
opportunities (`StartInterval`), and eligibility is computed from
`BUSINESS_TIMEZONE`. This is what makes the design immune to the failure that
started this: launchd cached a calendar trigger in the old zone and kept firing
at the old instant. A `StartInterval` has no timezone to cache.

**Consequence worth stating plainly:** while you are in Asia, the pipeline will
fire at ~21:00 Bangkok / ~23:00 Tokyo, which is when it has actually been firing
since 08-23. Adopting PT does not change current observed behaviour — it makes
it intentional.

## 5. Sleep/wake catch-up semantics

Unchanged in shape, restated against `BUSINESS_TIMEZONE`:

- `due = 07:00 BUSINESS_TIMEZONE` on the logical date.
- Every execution opportunity asks: does a run exist for this `logical_date`?
- If not, and we are past due, run it — **once**, regardless of how late.
- The laptop being asleep at 07:00 PT is normal, not a failure. It is only a
  failure when the machine has demonstrably been available past the grace period
  and still nothing ran.
- A late catch-up **does not** create a second logical run: identity is the
  business date, not the execution time.

Cross-midnight case, explicitly: a run that starts 23:50 PT and finishes 00:30
PT belongs to the *starting* logical date. (Note: the current code does not
handle this — see the deferred list.)

## 6. Structural duplicate prevention

Duplicates are **not hypothetical in this system**. Production record:

```
2026-08-21   two runs starting 3 minutes apart (18:00:37Z, 18:03:00Z), overlapping 31 min
2026-06-12   6 runs      2026-06-13   7 runs      2026-06-14   4 runs
```

Today the only protection is an advisory lock file, and three submitters do not
share it: `daily-catchup.sh` (different lock — and it is what the *currently
installed* agent runs), `./daily-queue.sh` (no lock), `pnpm --filter
@common/queue submit` (no lock). BullMQ sets no `jobId`, so two submissions are
two independent flows.

**Proposed structural invariant:**

```sql
ALTER TABLE pipeline_runs ADD COLUMN logical_date TEXT;   -- set by recordStart
CREATE UNIQUE INDEX ux_daily_logical_date ON pipeline_runs(logical_date)
  WHERE stage = 'daily-pipeline' AND logical_date IS NOT NULL;
```

`recordStart` computes `logical_date` from `BUSINESS_TIMEZONE`, never from the
machine. Verified on a throwaway DB: first insert OK, duplicate same-date insert
rejected, next day OK, other stages unaffected.

**Trap to avoid:** the obvious `CREATE UNIQUE INDEX ON
(date(started_at,'localtime'))` is accepted at DDL time and then breaks *every*
insert into the table with `non-deterministic use of date() in an index`. It
would also be machine-timezone dependent, which is the bug we are removing.

## 7. Deliberate retry semantics

A hard uniqueness constraint blocks a legitimate manual retry after a failure.
That tension needs an explicit answer rather than a silent one:

**Recommended:** `logical_date` is unique among **non-superseded** rows. A
deliberate retry marks the prior row `superseded_at` and inserts a new one, so
the constraint becomes:

```sql
CREATE UNIQUE INDEX ux_daily_logical_date ON pipeline_runs(logical_date)
  WHERE stage = 'daily-pipeline' AND logical_date IS NOT NULL AND superseded_at IS NULL;
```

This keeps the invariant structural, preserves the full history (a retried day
shows both attempts), and makes retry an explicit, recorded act rather than an
accident. It mirrors the supersession pattern already used in
`desk.agent_claims`.

**Rejected alternative:** a `retry_seq` column with uniqueness on
`(logical_date, retry_seq)`. It permits duplicates by default — anything that
forgets to increment gets a fresh row — which is the failure mode we are trying
to make impossible.

## 8. B1–B4 remediation design

| | Defect | Fix |
|---|---|---|
| **B1** | bash 3.2 brace-expands the nested-quote LINE payload; curl gets an empty body; success is logged regardless | Build the payload on its own line via a **quoted heredoc** (`python3 - "$USER_ID" "$MSG" <<'PY'`), assign to `PAYLOAD`, pass `-d "$PAYLOAD"`, add `--max-time 20`, and **check `$?` before logging success**. `daily-catchup.sh` already does this correctly with `printf` — B1 is a regression I introduced. |
| **B2** | Global mute consumes the alert: the dedup marker is touched *before* the mute check | Move the mute check **above** the marker write. Separately: `data/line-notifications-muted` has been in place since 2026-07-10 — decide whether it should survive. Any watchdog shipped while it exists is silent by construction. |
| **B3** | Only the scheduler writes heartbeats, so a dead/hung scheduler is indistinguishable from a sleeping laptop → permanent silence | The **watchdog also appends** to the same heartbeat file. It runs from a separate agent and also proves the machine was awake, so a dead scheduler yields heartbeats + no run → `missing` → alert. Preserves the stated semantics (heartbeat = *opportunity*, never *health*). Also: two current tests assert the blind spot as a PASS and must be inverted. |
| **B4** | `timeout`/`killed` fall through to `missing` + `eligibleToRun: true`; `/admin/pipeline` writes `timeout` on every render, so opening a page could resubmit a full day | Make the status switch **total**: anything not in `{success, running, failed}` is terminal-not-success → `eligibleToRun: false`, `shouldAlert: true`, its own state. Also reconcile the dashboard's 6h reap threshold with `STALE_AFTER_MIN = 90` — they currently disagree about what an orphan is. |

Plus, before install: mark-after-send (H6), lock staleness on SIGKILL (H5),
watchdog must fail **loud** on unparseable status (M8 — it currently logs
"healthy, no alert"), `daily-run-status.ts` must open the DB **read-only** (M9 —
it currently creates DBs, which is how a decoy got committed), pin
`PATH`/`PIPELINE_RUNS_DB` in both plists (M10), an install runbook that boots out
the old agent whose label the new plist reuses (M11), and re-anchor the test
harness, which is time-of-day dependent and green only after ~09:00 local (M12).

## 9. Watchdog lookback and acknowledgement

Specified separately in `docs/proposals/2026-08-27-watchdog-lookback.md`.
Summary: 7 prior logical days; alertable states `stale`/`failed`/`missing`;
resolution by success, explicit acknowledgement, or ageing out; prior-day items
rolled into at most one backlog notification per calendar day, sent only when
the *set* of unresolved dates changes.

Acknowledgement mechanism is an open decision — a file
(`data/.pipeline-ack-<date>`, works when Postgres is down) versus a column on
`pipeline_runs`. **Recommend deciding it together with `logical_date` and
`superseded_at`**, so the observability schema changes once rather than three
times.

## 10. Deferred — explicitly not P1

1. **BullMQ stalled-job path bypasses parent-close.** `failedReason: "job stalled
   more than allowable limit"` (`atm=1 ats=3 stc=2`, stage exit 143/SIGTERM).
   The parent closes only on root success or a throw inside the processor; a
   stall takes neither, so the parent stays `running` forever.
2. **`waiting-children` buildup** — 221 jobs across 22 distinct days, oldest
   2026-06-23. 3.56 MB, no memory pressure; an accurate count of dead DAG days.
3. **`world-intel-pipeline` 36–40 minute runtime** — what triggers the stall.
4. **Cross-midnight overrun** — a run started 23:50 and still `running` at 09:00
   next day does not block the new logical date, so a second full pipeline can
   be submitted while the first is live.
5. **The 97 UTC date sites** — mostly correct for market data, but they have
   never been audited against business-day identity.
