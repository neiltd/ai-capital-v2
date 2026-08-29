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
