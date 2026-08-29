# World-Intel Data Freshness Incident — Phase 1 investigation

**Investigation only. No repair, backfill, or production mutation.** Scheduler
still frozen, queues untouched, no notification infrastructure involved.

Evidence preserved at `~/ai-capital-evidence/2026-08-29-world-intel-freshness/`
(quota state, freshness export, world-map export, worker-log tail).

---

## A. Source health

Thresholds from `SOURCE_CONFIGS`; ages as of 2026-08-29 ~02:00Z.

| source | bound | last success | age | attempts this period | reachable now | state |
|---|---|---|---|---|---|---|
| **acled** | 24h | 2026-06-26 | **1538h** | 23 in Aug, **0 succeeded** | **yes** (auth OK) | **FAILING — recency embargo** |
| **gdelt** | 2h | 2026-08-27T15:08 | 35h | 570 | **NO — TLS cert expired** | **FAILING as of 2026-08-28T19:50Z** |
| eia | 36h | 2026-08-27T15:13 | 35h | 138 | not tested | within bound until 03:13Z today |
| worldbank | 336h | 2026-08-27T15:13 | 35h | 57 | not tested | current |
| ucdp | 336h | 2026-08-18T14:16 | 252h | 10 | not tested | current |
| ~~newsapi~~ | — | 2026-05-12 | 2600h | — | — | **orphaned** — not in `SOURCE_CONFIGS`, source was removed; stale state row remains |

*(Verified — quota state, source configs, live probes.)*

Two mechanical notes. `recordFetch` increments `dailyUsed`/`monthlyUsed` on
**every attempt** and only advances `lastSuccessfulFetch` on success, so
ACLED's `monthlyUsed: 23` with an unchanged timestamp is 23 consecutive
failures *(Verified)*. And **GDELT's 2h bound is unreachable by the daily DAG** —
only the 15-minute `npm run schedule` daemon could satisfy it, and that daemon
is deliberately stopped. The bound therefore reports "stale" as a matter of
architecture, independent of any failure.

---

## B. ACLED root cause — a recency embargo, and it never recovered

**The failure is not a 403, not authentication, and not the date format.**

Live probe, read-only, this session *(Verified)*:

| probe | result |
|---|---|
| OAuth token endpoint | HTTP 200, token acquired, `expires_in=86400` |
| `event_date >= 2026-08-01` | 200, `success=true`, **0 rows** |
| `event_date >= 2025-01-01` | 200, **3 rows**, dated 2025-01-06 |
| `event_date <= 2025-08-01` | 200, **3 rows**, dated 2019-03-06 |
| no date filter at all | 200, **5 rows**, dated 2019 |
| `data_query_restrictions.date_recency` | `{quantity: 12, unit: "Months", date: "2025-08-29"}` |

**The account is entitled only to data at least 12 months old.** The cut-off
reported by the API is 2025-08-29 — exactly twelve months back. The pipeline
always queries for recent events, which are always inside the embargo, so it
always receives an empty 200.

**This refutes the diagnosis written in the code.** `acled.ts:179-181` asserts
the empty 200 is "the account-level read-permission failure". Read permission is
intact — the account returns rows freely for older windows. It is a *recency*
restriction, and the distinction matters because it changes the fix: no query
change can retrieve recent ACLED data on this tier. **This is not repairable in
code.**

### Did the earlier 403 return, or never recover?

**It never actually recovered** *(Verified from logs)*.

| | |
|---|---|
| 2026-06-13T17:21 | first successful OAuth token — the auth migration lands |
| … through 2026-06-28T14:09 | last `HTTP 403` (28 occurrences) |
| 2026-07-03, 2026-07-05 | pipeline logs `acled: ok` — the only two successes on record |
| 2026-07-06 → 2026-08-27 | `Returned 0 events` × 176, every run |

The auth fix changed the failure from a **loud 403** into a **silent empty 200**.
Data access was never restored; the error simply became quieter and the pipeline
kept treating it as a per-run failure rather than a standing condition.

**Missing:** why 2026-07-03/05 succeeded at all. Plausibly a subscription or
tier change around that date — not verifiable from this side.

**Also observed:** the cursor is frozen at `2026-07-05T14:12:51.178Z` because
`setCursor` only runs on success, while quota's `lastSuccessfulFetch` reads
2026-06-26. The two disagree by nine days; both are downstream of the same
failure and neither is load-bearing here.

---

## C. GDELT root cause — two separate things, do not merge them

**1. The 35h staleness is the intentional scheduler freeze, not a source
failure** *(Verified)*. GDELT, EIA and WorldBank all last succeeded within five
minutes of each other on 2026-08-27T15:08–15:13Z — that is the last pipeline
run. Nothing was wrong with GDELT at that moment.

**2. GDELT is nevertheless hard-down now, for an unrelated reason.** Its TLS
certificate expired **2026-08-28T19:50:12Z** *(Verified)*:

```
subject=CN=*.gdeltproject.org
issuer=C=US, O=Let's Encrypt, CN=YR2
notBefore=May 30 19:50:13 2026 GMT
notAfter =Aug 28 19:50:12 2026 GMT
```

DNS resolves and TCP 443 connects; the handshake fails with
`TLS alert, certificate expired`. Confirmed independent of our trust store — the
macOS system CA bundle rejects it too, and Node fails with `CERT_HAS_EXPIRED`.

> **Consequence: restoring the daily scheduler today would not restore GDELT.**
> This is upstream, and it began *after* the last pipeline run, so no log
> anywhere records it.

**3. Separately**, several GDELT queries hit `Connect Timeout` on the 2026-08-27
run and were skipped, and that run normalized 0 GDELT events — so GDELT was
already contributing nothing on its final run, before the certificate expired.

---

## D. Blast radius

```
world-intel-pipeline → collect → score → report → dedup → link → memory → export
        ↓
   capital-ingestion → thesis-memory → ai-analysis-engine → … → investment-brief
        ↓
   exports/world-map/*.json → dashboard /world
   intelligence/outputs/events/*.json → briefing world-storylines
```

**Consumers** *(Verified)*: `investment-analyst-agents/src/briefing/world-storylines.ts`,
`briefing/briefing-agent.ts`, `context/loader.ts`, and
`ai-analysis-engine/src/analysis/regime-analyzer.ts` (which folds world events
into the macro regime call).

**What the data actually contains** *(Verified)*:

| store | contents |
|---|---|
| `store/normalized/events.json` | ucdp 12,978 (2025-05-28→2025-12-30) · gdelt 793 (2026-05-28→**2026-08-21**) · newsapi 2 · **acled 1 (2026-05-11)** |
| `exports/world-map/events.json` | 387 records, **all GDELT**, 2026-08-01→2026-08-21 |
| `intelligence/outputs/events/2026-08-27.json` | 21 events, `source: unknown` |

So recent geopolitical coverage has been **GDELT-only**. ACLED has contributed a
single event in the entire normalized store.

### Can consumers tell stale from current? No.

The export **already carries the answer** — `meta.sourceVersions` records each
source's last successful fetch, including `"acled": "2026-06-26T00:00:00.000Z"`,
and the exporter also computes a `staleSourcesPresent` flag. **Nothing reads
either.** A repo-wide search finds `sourceVersions` only in the world-intel
exporter that writes it *(Verified)*.

The briefing's own event files carry `source: unknown`, so even source
attribution is unavailable downstream.

**What this does NOT establish.** Briefings consumed whatever events were
present; those were dominated by GDELT and UCDP. Whether any specific briefing
or regime call was *wrong* because ACLED was absent is **Missing** — not
investigated, and not claimable from staleness alone. What is established is
that the absence was **invisible** to every consumer.

---

## E. Earliest affected date

| source | earliest affected | basis |
|---|---|---|
| **acled** | **2026-05-12** | last (and only) ACLED event in the normalized store is 2026-05-11 *(Verified)*. Definitively zero contribution from **2026-07-06** onward, when `Returned 0 events` begins *(Verified)*. |
| **gdelt** | **2026-08-22** | last GDELT event in the store is 2026-08-21; the 2026-08-27 run normalized 0 events *(Verified)*. Hard-down from **2026-08-28T19:50Z**. |

Conservative combined statement: **world-intel has had no live ACLED input since
2026-07-06 and no live GDELT input since 2026-08-22, and as of 2026-08-28 has no
reachable recent-events feed at all** (UCDP is an academic dataset whose latest
record is 2025-12-30; EIA and WorldBank are macro/energy series, not events).

---

## F. Repair options, ranked by risk

**None of these are approved or performed.**

| # | Option | Risk | Notes |
|---|---|---|---|
| 1 | **Nothing — record and re-check** | lowest | GDELT's certificate is upstream and will likely be renewed within days. Costs only more stale days. |
| 2 | **Make `sourceVersions` / `staleSourcesPresent` actually consumed** | low | Surfaces the condition to briefing and dashboard. Does not fix a feed, but ends the invisibility that let ACLED go unnoticed for months. Pure read-side. |
| 3 | **Add an upstream reachability pre-check** to the pipeline | low | Would have caught the GDELT certificate the moment it expired instead of at the next run. |
| 4 | **Retire ACLED from the pipeline** | medium | Honest: the account cannot serve recent data. Removes a permanently failing source and the misleading in-code diagnosis. Loses ACLED coverage permanently unless the subscription changes. |
| 5 | **Change the ACLED subscription tier** | medium, external | The only route to recent ACLED data. Cost and procurement decision, not an engineering one. |
| 6 | **Backfill GDELT once the certificate is renewed** | medium | GDELT's API supports historical windows; 2026-08-22→now is recoverable. Requires a pipeline run, i.e. unfreezing something. |
| 7 | **Backfill ACLED** | **not possible** | The embargo blocks the entire missing window on this tier. |
| 8 | **Disable TLS verification to reach GDELT** | **unacceptable** | Listed only to rule it out: it would silence a real upstream signal and weaken every other request the process makes. |

### What I did not do

No scheduler restart, no historical flow retry, no backfill, no queue cleanup, no
freshness-implementation change, no portfolio mutation, no outbound
notification. The only writes this session were the evidence copies outside the
repo. Working tree clean.


---

# Phase 2 — provenance made part of analytical truth

Implemented 2026-08-29. **No source repair, scheduler restart, backfill, queue
mutation, notification work or portfolio mutation.**

## Availability semantics

Five states, in `@common/types/provenance.ts`, classified from one injected clock:

| state | meaning |
|---|---|
| `current` | refreshed inside its bound |
| `stale` | past its bound, **cause deliberately not diagnosed** — a producer that was never scheduled looks identical to a dead feed from here, and guessing is how a frozen scheduler gets reported as an outage |
| `unavailable` | an **observed** transport failure. Requires evidence |
| `restricted` | upstream answers successfully but withholds what we need, by entitlement. **Declared, never inferred**, and outranks every other state so it can never read as retryable |
| `unknown` | no basis for a claim — the honest default |

Live classification: **acled `restricted`**, **gdelt `unavailable`** (carrying the
certificate evidence), **eia `stale`** with cause explicitly undiagnosed,
worldbank/ucdp `current`.

Declared evidence is **self-expiring**: an observed failure is ignored once the
source succeeds more recently than the failure was observed, so a one-off
finding cannot harden into permanent fiction.

## Propagation to the bounded consumer set

| consumer | change |
|---|---|
| **regime analyzer** | `formatWorldIntel` returned `'No significant world intelligence events.'` **unconditionally**. Under restricted/unavailable coverage that is a false statement handed to the model as a calm backdrop. It now reports missing coverage explicitly, and prepends a PARTIAL-view banner when events exist but coverage is degraded. The system prompt instructs that missing evidence must *lower* confidence and never lower geopolitical risk. |
| **cli-run (analysis)** | loads provenance at analysis time and attaches `coverage`; unreadable provenance yields `complete: false`, never assumed-healthy |
| **context loader** | carries `worldCoverage` into `ContextBundle`, evaluated at read time |
| **briefing-agent** | compact caveat **only** when coverage is degraded or the block is empty. No source-health boilerplate on a healthy day |
| **dashboard `/system/pipeline`** | five states with distinct styling; `restricted` is annotated "not fixable by retry" |

## Freshness self-awareness (carried B1/B2)

**B1** — read surfaces compute the age of the *classification itself*. A record
older than 30h cannot assert that anything is `current`; time-dependent verdicts
downgrade to `unknown`, while `restricted` survives because an entitlement is a
standing fact rather than an observation. The dashboard says so in a banner.

**B2** — one injected clock throughout. `classifySource` takes `now`; nothing
reads `Date.now()` internally, so a record can no longer contradict itself.
Producer and consumer contract covered by 14 tests in `common-types`, 5 in the
regime analyzer, 12 on the dashboard surfaces.

## ACLED — restriction, not repair

Recorded in `RESTRICTIONS.acled` with the upstream evidence quoted.

> **Recent ACLED data requires a subscription/procurement change, not an
> engineering repair.** The account may only read events at least 12 months old.
> No query change, retry, backfill or code fix can obtain recent events on this
> entitlement. The integration is preserved and marked `restricted`.

## GDELT cadence — unresolved architecture decision

The configured bound is **2h**; the only producer in the DAG runs **daily**. The
bound is therefore unsatisfiable by design and reports `stale` as a matter of
architecture, independent of any failure.

**Not silently relaxed, and the 15-minute daemon was not restarted.**

Evidence gathered for the decision: **nothing consumes world-intel at sub-daily
cadence.** The DAG chain runs daily; no shell script references world-intel; the
30-minute alerts agent uses prices only. The only ≤2h-capable producer was the
unmanaged `npm run schedule` daemon, which is stopped and separately recorded as
an untrusted execution surface.

So the choice is between relaxing the bound to match the daily DAG, or
identifying a genuine ≤2h consumer that does not currently exist. **Decision
deferred to Neil.**

## Historical impact inventory — for later decision only

**No re-analysis performed. These conclusions are NOT labelled wrong.**

| window | basis | analytical artifacts in range |
|---|---|---|
| ACLED, from **2026-05-12** | last ACLED event in the normalized store is 2026-05-11 | **71 briefings** (2026-05-26 → 2026-08-25) |
| ACLED definitive zero, from **2026-07-06** | `Returned 0 events` begins, 176 consecutive | **39 briefings** |
| GDELT, from **2026-08-22** | last GDELT event is 2026-08-21 | **1 briefing** (2026-08-25) |

Also in range: `analysis.json` regime calls produced by those runs, and 49
world-intel daily event files.

What is established is that these artifacts consumed world-intel **and could not
see that coverage was incomplete** — no consumer read `meta.sourceVersions`, and
the event files carry `source: unknown`. Whether any specific conclusion was
materially affected is **Missing** and requires the deferred re-analysis
decision.


---

## Phase 2 verification — **DEFECTIVE**, two escapes recorded not repaired

Warden verified five of the seven properties clean. Two paths still deliver
"coverage complete / no events" without it being true. Both are mine, both
reproduced independently.

### D1 — the world section is dropped entirely, caveat and all

`regime-analyzer.ts:371-373`:

```ts
const worldSection = options.worldIntel
  ? `\n\n## World Intelligence (live macro events)\n${formatWorldIntel(options.worldIntel)}`
  : ''
```

**All the coverage logic lives inside `formatWorldIntel`, which is never called
when `worldIntel` is undefined.** The prompt then carries no world section and no
coverage statement at all.

Reachable two ways: `cli-run.ts` `loadWorldIntel()` returns `undefined` when
either export file is missing or unparseable — its careful `loadCoverage` catch
is bypassed because the *outer* catch returns first — and `cli-schedule.ts:26`
calls `analyzeRegime(health)` with no options whatsoever (a legacy standalone
cron daemon, not in `jobs.ts`, writing the same `analysis.db`/`analysis.json`).

**Aggravating, and the part I got wrong:** the system prompt I added says the
feed "may be INCOMPLETE, **and it says so when it is**". On this path it says
nothing — so I handed the model an explicit guarantee that silence means
coverage was fine. The promise is worse than the original omission.

### D2 — a flat 30h grace ignores each source's own bound

`provenance.ts:147-160`. `readProvenance` compares the record's age against one
`maxRecordAgeHours` and, if under it, returns every verdict and `ageHours`
**exactly as the producer wrote them** — it never recomputes age from
`lastSuccessfulFetch` against the read clock.

Reproduced: a 29h-old record (inside the 30h bound) reports gdelt

```
at classify time: current | refreshed 1h ago, inside the 2h bound
at read time    : current | ageHours field: 1
TRUE age at read: 30h vs bound 2h
coverageIsComplete: true | absenceCaveat: null
```

which renders the exact sentence the invariant exists to prevent.

**This is the normal case, not an edge case.** GDELT's bound is 2h and the daily
DAG can never satisfy it, so the moment the certificate is renewed and GDELT
succeeds once, every read between 2h and 30h after the run reports `current`.
Today both GDELT and ACLED are masked by their declared `unavailable` /
`restricted` states, which is the only reason this is not already live.

None of the 14 provenance tests straddle a source's own bound — the
"stale record cannot assert current" test only exercises the `> 30h` side.

**Fix direction, not applied:** recompute `ageHours` from `lastSuccessfulFetch`
against the injected `now` in `readProvenance` and re-derive the time-dependent
verdict; or minimally downgrade any source with
`maxStalenessHours < recordAgeHours` to `unknown`. `restricted` and
`unavailable` handling is unaffected.

### Verified clean

Restricted/unavailable never read as current · every path *through*
`formatWorldIntel` is correct and the caveat genuinely reaches the rendered
prompt · ACLED reads as entitlement-restricted on both the model prompt and the
dashboard · `stale` asserts no failure and the GDELT declaration self-expires on
recovery · one injected clock with no `Date.now()` in any classification path ·
**no scheduler, source, backfill, queue or portfolio mutation** (tree clean, last
`pipeline_runs` row 2026-08-27, only the pre-existing worker loaded).

### Carried findings, outside the seven

- `ingestion/clients/acled.ts:179-181` still carries the diagnosis this document
  refuted — "the account-level read-permission failure". Read permission is
  intact; it is a recency embargo. A human reading that comment would try a
  credentials fix.
- `ingestion/scheduler.ts:43` still schedules acled daily, and
  `scripts/backfill.ts` documents an ACLED backfill window entirely inside the
  embargo. Retiring ACLED was option 4 and is not approved, so this is a note.
- **`unavailable` has no automatic producer.** `QuotaTracker.recordFetch`
  discards the failure reason, so `lastFailure` can only ever come from the
  hardcoded `OBSERVED_FAILURES` map. A future real outage will classify as
  `stale`, and `unavailable` stays only as accurate as someone remembers to
  hand-edit it.


---

## Phase 2 corrective pass — D1 and D2 repaired

### D1 — coverage survives event-load failure, by construction

The fix is architectural, not another conditional. **Coverage is no longer a
property of the event payload.** `WorldCoverage` is its own type, passed to
`analyzeRegime` as `options.worldCoverage`, and the world section is now rendered
**unconditionally**:

```ts
const worldSection = `\n\n## World Intelligence …\n${formatWorldIntel(options.worldIntel, options.worldCoverage)}`
```

All four combinations are representable and tested against the **rendered model
input**, not helper returns:

| events | coverage | rendered |
|---|---|---|
| available | complete | plain list, no caveat |
| available | degraded | PARTIAL banner *before* the events |
| unavailable | known/degraded | `EVENTS COULD NOT BE LOADED` + the coverage summary |
| unavailable | unknown | `EVENTS COULD NOT BE LOADED` + `Coverage: UNKNOWN` |

Callers audited: `cli-run` now loads coverage **independently** of the events, so
the outer event-load catch can no longer discard it; `cli-schedule` — the legacy
standalone daemon writing the same `analysis.json` — now passes real coverage
instead of nothing. A test asserts that even `analyzeRegime(health)` with no
options at all produces a prompt containing a world section and a coverage
statement.

**The prompt contract was corrected.** It previously promised the feed
"says so when it is incomplete" — which the program did not structurally
guarantee, and on the broken path the silence read as an assurance. Replaced with
the invariant the program does enforce: *absence or unreadability of
world-intelligence is MISSING EVIDENCE, never evidence of a quiet world.*

### D2 — every time-dependent verdict recomputed at read time

`readProvenance` no longer passes producer verdicts through. Each source is
re-derived from the evidence the record already carries —
`now − lastSuccessfulFetch` against **that source's own** `maxStalenessHours`.
No second global grace period.

- **Standing restrictions survive** record aging and keep outranking everything.
- **Observed failures keep self-expiring** — applied until a success postdates them.
- `recordAgeHours` / `recordStale` are still reported, but now as a *separate*
  signal about whether observational facts may be obsolete. They no longer gate
  classification.

A record classified at T0 with GDELT `current` reads `current` at +1h and
**`stale` at +3h**, while WorldBank's 336h bound stays `current` from the same
record — and a 29h-old record inside the 30h grace still reports GDELT `stale`,
which is the case that was broken.

### Known-false contracts corrected

- **`ingestion/clients/acled.ts`** — the "account-level read-permission failure"
  diagnosis is replaced with the observed behaviour: successful authenticated
  reads subject to an account-level **recency embargo**, with the probe evidence
  and a pointer here. It sent readers after a credentials fix.
- **`scripts/backfill.ts`** — its usage example targets a window entirely inside
  the embargo. Marked: any ACLED window inside the last twelve months returns
  `200 success=true` with zero rows, so a backfill over it **silently succeeds
  having imported nothing**.
- **`ingestion/scheduler.ts`** — annotated, **behaviour deliberately unchanged**.

### Smallest safe proposal for entitlement-aware scheduling — NOT implemented

Gate the ACLED schedule on the declared restriction rather than deleting the
integration: if `RESTRICTIONS[source]` is present and its
`accessibleOlderThanDays` excludes the window the scheduler would request, skip
the run and record it as `restricted` rather than attempting and failing.

Two properties make this the smallest safe version: the restriction is already
declared in one place with evidence, and **an entitlement change re-enables the
schedule automatically** — remove the declaration and the source resumes, with no
second switch to remember. Requires no new state, no new subsystem, and no change
to any other source.

### FUTURE — structured source-attempt/failure provenance

`QuotaTracker.recordFetch(source, success)` discards the failure reason, so
`lastFailure` can only ever come from the hardcoded `OBSERVED_FAILURES` map. **A
future real outage will classify as `stale`, not `unavailable`**, and
`unavailable` stays only as accurate as someone remembers to hand-edit it.

Fixing that means recording attempt outcome, timestamp and failure kind per
source — an operational subsystem, deliberately **not** built during a D1/D2
repair. Carried.


---

## Phase 2 verification — **LIMITED**. One defect, and it is mine and new.

Six of seven properties verified. One fails, on a defect **introduced by the D1
fix itself** (`ac5fc9b`). Recorded and stopped per the no-third-loop rule.

### The defect (#6) — an import with a production side effect

`cli-schedule.ts:9` imports `loadCoverage` from `cli-run.ts`. **`cli-run.ts` is
an entrypoint, not a library:** its module body ends in a bare
`run().catch(err => { … process.exit(1) })` with no `import.meta` main guard.
ESM evaluates an imported module's body, so merely *starting* the legacy daemon
now executes `cli-run`'s entire `run()` — `collectHealth`, a real
`client.messages.create` **(billable)**, `store.insertRegime`,
`analyzePropagation`, and writes to `analysis.json`, `analysis.db` and the daily
report — **at import time, before cron is ever consulted**, and again at 06:00
from its own schedule. Any failure inside that import-time run calls
`process.exit(1)` and kills the daemon before it can reach its schedule.

Reproduced from an isolated cwd, aborting before any network call; the stack is
unambiguous:

```
AI Analysis Engine scheduler started. Running daily at 06:00.
Error: ENOENT: … /scratchpad/dependency-graph-engine/data/graph.json
    at run (…/src/cli/cli-run.ts:148:39)
    at <anonymous> (…/src/cli/cli-run.ts:238:1)
```

**Blast radius is bounded and it is currently dormant.** The DAG stage runs
`npm run analyze` → `cli-run.ts` directly, so the production pipeline is
unaffected; only `npm run schedule` triggers this, and that daemon is one of the
unmanaged cron surfaces already stopped. No test covers it, which is why a
892-test green gate said nothing.

The coverage invariant itself is not violated on either path. What broke is the
legacy caller the D1 fix was editing — I reached into an entrypoint for a helper
instead of extracting the helper to a module. **A one-line revert of that import
removes it** (the section still renders `Coverage: UNKNOWN` without it, which is
honest); the durable fix is to move `loadCoverage` out of `cli-run.ts`.

### Verified

**#1** exactly two writers of `analysis.json`/`analysis.db`, both passing
coverage; `worldSection` unconditional; `loadCoverage` cannot throw into its
caller. **#2** analytical paths caveat empty and partial lists correctly.
**#3** every stored verdict discarded and re-derived — confirmed live on
`/system/pipeline`, ages rendering against read-time `now`, each against its own
bound. **#4** the ACLED restriction declared with verbatim upstream evidence,
outranking everything and surviving record aging. **#5** self-expiry identical on
producer and read paths. **#7** no scheduler, source, backfill, queue, portfolio
or notification mutation; tree clean; launchd unchanged.

### Carried

- **The dashboard world surfaces still state absence as absence.**
  `(next)/world/page.tsx` renders an event count described as "the feed that
  today's regime call and briefing were built from" with no provenance;
  `(next)/today/data.ts` swallows a world-intel read failure into an empty list;
  `(legacy)/world/intel/page.tsx` renders "No events recorded". Coverage reaches
  only `/system/pipeline`. **Pre-existing and not claimed by this pass** — but it
  is exactly the class of statement removed elsewhere, live while ACLED is
  restricted and GDELT unavailable.
- **Two of my own comments became false under D2.**
  `source-freshness.tsx` still tells the reader that stale-record verdicts "read
  *unknown* rather than being asserted as current" — under recomputation they no
  longer do, and once the record passes 30h that banner will sit above a table
  showing `current`. `lib/data.ts` carries the same claim. `PROVENANCE_MAX_AGE_HOURS`
  is now inert in both model-facing consumers. Same shape as the C1 finding
  earlier, inverted: I updated the code and left the record describing the old
  behaviour.

### Disclosure

`quota/freshness.json` was rewritten during this session by running
`bin/export-freshness.ts` against the production quota surface
(`classifiedAt 2026-08-29T07:55:35Z`). It is a derived export and outside the
prohibited list, and regenerating it was the point of the surface — but it **is**
a production-artifact write inside the incident window, and any later forensic
pass working from a "no writes" brief needs it on the list.


---

## Containment patch — entrypoint import side effect

Scope: the one defect. **No provenance semantics changed.**

**Invariant:** importing any module must never execute analysis, make a
model/API call, write analytical state, or terminate the process.

**Fix.** `loadCoverage` extracted from `cli-run.ts` into
`src/analysis/load-coverage.ts`, a side-effect-free library imported by both
`cli-run.ts` and `cli-schedule.ts`. `cli-run.ts` remains the executable
entrypoint. **No executable entrypoint is imported by anything.** Verified: the
scheduler daemon now starts printing only its own line, with no `run()` in the
stack.

**Regression tests** (5, in `src/analysis/import-is-inert.test.ts`) run the
import in a **child process** rather than behind mocks — a mock proves the mock
was not called; a child process proves the real module does nothing. They assert
zero model/API call, zero `insertRegime`, zero writes to `analysis.json` /
`analysis.db` / the daily report (by mtime snapshot of the whole `data/` tree),
zero `process.exit`, and zero scheduler execution. A structural test generalises
the rule — no module may import a module with a top-level call — with a
non-vacuity guard asserting `cli-run.ts` is still detected as an entrypoint.

### Incident during this patch — I triggered the very effect being contained

Checking that the child probe was non-vacuous, I pointed it at `cli-run.ts`.
**That executed a real analysis**, reaching "Stage 2a: classifying macro
regime" — the model call. A billable call very likely went out.

My guard was `ANTHROPIC_API_KEY: ''` in the child env. **`cli-run.ts` imports
`dotenv/config`, which repopulated it from `.env`.** An env-var guard that the
program overwrites is not a guard, and I have written that same sentence about
other people's code twice in this session.

Bounded: no analytical state was written — `analysis.json`, `analysis.db`,
`people-events.json` and the reports all retain their 2026-08-25 mtimes, and no
process survived. The run died before its write stage.

The test's guard is now **structural, not environmental**: an assertion that the
probed module's transitive import graph contains no LLM SDK and no
`dotenv/config`, so it cannot bill regardless of environment.

### Repo-wide scan — one other module imports an executable entrypoint

493 modules scanned. One offender, **pre-existing and not introduced here**:

```
apps/capital-intelligence-ingestion/src/scheduler.ts
  -> apps/capital-intelligence-ingestion/src/pipeline.ts
```

`pipeline.ts` ends in a bare `runPipeline(…).catch(err => { … process.exit(1) })`
with no main guard — the **identical defect**, so starting that scheduler would
run a full ingestion at import time.

**Deliberately NOT patched.** `pipeline.ts` is the live `capital-ingestion` DAG
stage; a mis-written main guard would turn production ingestion into a silent
no-op, which is a worse failure than the dormant one it fixes. Recommended fix,
for a separate decision: extract `runPipeline` into a library exactly as
`loadCoverage` was, rather than guarding in place.

### Stale contracts corrected

Three statements described pre-D2 behaviour and were false under it: the
`source-freshness.tsx` banner and its JSX comment, and the `lib/data.ts` header.
All now say what the code does — each source recomputed against **its own**
bound at read time, with record age bearing only on the *observed* facts the
record carries.

**Gate:** typecheck 0 errors, **897 tests**, 0 failing suites. No scheduler
restart, source fetch, backfill, queue operation, portfolio mutation,
notification, or historical re-analysis.
