# Design decisions — thesis-memory concurrency, brief delivery, lock tuning

**Status: DESIGN. Items 4, 5 and 8 are proposals. No migration applied, no LINE
configuration changed, no lock settings changed.**

## 4. thesis-memory under concurrent redelivery

### Correction to my own audit

I classified thesis-memory as "read-then-write, unsafe under concurrent
redelivery". That was **partly wrong**: `thesis.theses` already carries

```
"theses_ticker_key" UNIQUE CONSTRAINT, btree (ticker)
```

So duplicate thesis creation is *already* structurally impossible — a
concurrent second insert fails on the constraint rather than creating a
duplicate. The read-then-write there is backed by a real invariant.

### What is genuinely missing

| table | business identity | constraint today | concurrent duplicate possible? |
|---|---|---|---|
| `thesis.theses` | **one thesis per ticker** | `UNIQUE (ticker)` | **no — already safe** |
| `thesis.assumptions` | **one assumption per (thesis, label)** — an assumption *is* its label within a thesis | only `btree (thesis_id)`, non-unique | **yes** |
| `thesis.narratives` | **one row per (thesis, version)** — a version number identifies a version | `btree (thesis_id, version DESC)`, non-unique | **yes** |

These keys come from the domain, not from the generated `id` columns. `id` is a
random surrogate: two deliveries generate two different ids and collide on
nothing, which is exactly why uniqueness must be expressed on the business key.

### Smallest design

```sql
ALTER TABLE thesis.assumptions ADD CONSTRAINT assumptions_thesis_label_key
  UNIQUE (thesis_id, label);
ALTER TABLE thesis.narratives  ADD CONSTRAINT narratives_thesis_version_key
  UNIQUE (thesis_id, version);
```

Both can be added **cleanly today** — verified against production: 0 duplicate
`(thesis_id, label)`, 0 duplicate `(thesis_id, version)`.

Then the two writers become conflict-aware, which is what turns a constraint
from an error into convergence:

- `createAssumption` → `ON CONFLICT (thesis_id, label) DO UPDATE SET status,
  last_evidence_summary, updated_at` — a redelivery refreshes the assumption
  instead of duplicating or failing.
- `createNarrative` → `ON CONFLICT (thesis_id, version) DO NOTHING` — a
  redelivery of the same version is a no-op. Version allocation itself must move
  inside a transaction (`SELECT max(version) … FOR UPDATE` on the thesis row, or
  simply let the constraint reject and retry), because read-max-then-insert is
  racy however it is spelled.

The constraint is the invariant; the `ON CONFLICT` is only ergonomics. With the
constraint alone, concurrent delivery converges — one write wins, the other
errors, and no duplicate state exists.

## 5. investment-brief delivery

### LINE *does* provide an idempotency primitive, and this repo does not use it

The Messaging API accepts an **`X-Line-Retry-Key`** header (a UUID). A repeated
push carrying the same key inside LINE's retry window is not re-delivered.
`grep` across the repo: **zero occurrences**. All four push sites
(`apps/scenario-simulator/src/notify/line.ts`,
`apps/world-intelligence-data-hub-/run.ts`, `scripts/daily-catchup.sh`,
`scripts/pipeline-watchdog.sh`) send without one.

### Delivery ledger

Identity of a delivery:

```
(logical_date, briefing_identity, destination, delivery_type)
```

where `briefing_identity` is a content hash of the briefing actually being sent,
so that a *regenerated, changed* briefing is a legitimately different delivery
while a redelivery of the same content is not.

**Order matters, and it is the whole solution to the crash problem:**

1. **Before sending**, insert the ledger row with a generated `retry_key` and
   `status = 'intended'`. This write is the commitment.
2. Send, passing that `retry_key` as `X-Line-Retry-Key`.
3. Mark `status = 'sent'`.

The classic failure — *send succeeds, process dies before "sent" is persisted* —
is handled because step 1 already persisted the key. On replay the ledger is
found in `intended`, the **same** `retry_key` is reused, and LINE suppresses the
duplicate. Without step 1 there would be nothing to replay with, and this is
precisely where a naive "mark after send" ledger fails.

A unique constraint on `(logical_date, briefing_identity, destination,
delivery_type)` makes two concurrent deliveries collide in the database before
either reaches LINE.

**Manual resend stays possible and auditable**: an explicit resend writes a new
ledger row with a new `retry_key` and a recorded reason, so it is a first-class
event rather than a bypass.

### The honest guarantee

> **Effectively-once within LINE's retry-key window; at-least-once outside it.**

I will not claim exactly-once. Three limits, stated plainly:

- LINE's retry-key suppression is bounded by their retention window. A
  redelivery arriving after it expires **will** send again.
- If the ledger insert succeeds and the process dies before the HTTP call, no
  message is sent — the ledger says `intended` and a human or a sweeper must
  decide. That is under-delivery, not over-delivery, and it is the safer error.
- Any push site not routed through the ledger is unprotected. All four must be,
  or the guarantee is only as good as the least careful call site.

**The existing global mute is a separate matter and is not touched here.**

## 8. Lock and stall settings — proposal only

### Measurements

Stage runtimes (`pipeline_runs`, completed rows):

| stage | avg | max |
|---|---|---|
| `world-intel-pipeline` | 24 m | **745 m** |
| `capital-ingestion` | 12 m | 96 m |
| `scenario-refresh` | 2 m | 32 m |
| `scenario-simulate` | 2 m | 22 m |
| everything else | <5 m | 6 m |

Machine suspension since 2026-08-24 — **two distinct populations**:

| | |
|---|---|
| short Sleep→Wake cycles | 317 samples; median **2 s**, p90 **4 s**, p99 **28 s**, max **29 s** |
| cycles exceeding the 15 s renewal interval | **7 (2%)**, of which **6 land in 20–29 s** |
| periods with no power events at all | **7**, including **13.8 h** and **11.8 h** overnight |

### Why the current defaults fail

`lockDuration = 30 s` with renewal at `lockDuration / 2 = 15 s` leaves only 15
seconds of margin. A 20–29 second suspension consumes all of it: the renewal
scheduled for T+15 does not run until T+29, and the lock minted at T has already
expired. Six such cycles occurred in three days, and a 40-minute stage spans
roughly ten sleep cycles — so the collision is likely, not exotic.

### Proposal

| setting | now | proposed | rationale |
|---|---|---|---|
| `lockDuration` | 30 s (default) | **600 000 ms (10 min)** | 20× the worst observed short suspension (29 s), so the entire short-cycle population becomes harmless. Renewal margin rises from 15 s to 5 min. |
| `stalledInterval` | 30 s (default) | **300 000 ms (5 min)** | No point scanning 20× per lock lifetime. |
| `maxStalledCount` | 1 (default) | **2** | Today one stall ends a job even with retries left — `world-intel-pipeline` died at `atm=1, ats=3, stc=2`, killed by the stall limit rather than by failing three times. |

**Cost of delayed detection:** a genuinely dead worker's job is noticed in ~15
minutes instead of ~1. Against a daily pipeline whose average stage is 24
minutes, that is immaterial — and terminal-event reconciliation now catches the
dead-flow case regardless.

### What this does NOT do

It does not survive the 13.8-hour and 11.8-hour suspensions, and no finite
`lockDuration` does. Redelivery after an overnight sleep remains possible.

> **BullMQ provides at-least-once execution. Locks reduce duplicate delivery;
> they do not make business effects exactly-once.**

That is why this item is last: the durable protection is the idempotency work in
items 4 and 5, and tuning is only noise reduction on top of it.
