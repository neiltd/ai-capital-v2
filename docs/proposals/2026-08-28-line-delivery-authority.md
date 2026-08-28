# LINE delivery authority — architecture for review

> **FROZEN 2026-08-28 — REVISION 4 REJECTED FOR IMPLEMENTATION.**
>
> The LINE delivery workstream is closed. Warden's architecture attack showed
> that making LINE delivery trustworthy needs a stateful delivery subsystem
> whose complexity is not justified by the channel's production value.
>
> **LINE is not part of the production correctness boundary.** The system must
> be fully correct with LINE unavailable, credentials absent, LINE code removed,
> and no outbound channel configured.
>
> This document is kept as **design evidence, not a plan**. Findings F1–F5 and
> U1–U6 are **NOT REMEDIATED — channel retired before implementation**; see
> `2026-08-28-line-retirement-audit.md`. Do not implement from this file. The
> DDL in L6 is superseded by L6c and neither is to be built.

**Status: PROPOSAL. No implementation.** Nothing here has been built. The alerts
agent stays unloaded and LINE stays muted throughout.

**Revision 2.** Revision 1's inventory was incomplete and wrong in three
specifics. Warden's completeness attack found three missed triggers, refuted the
central premise of the retry section, and corrected two of my four
implementation descriptions. Every correction below was independently verified
against the source before being accepted. What that cost is recorded in
"Inventory failures" at the end, because the pattern matters more than the map.

---

## The defect this exists to eliminate

From `apps/scenario-simulator/src/cli/cli-alerts.ts:185-187`:

```
notification selected → sendLine() → muted: return void
  → caller assumes success → saveState() → dedupe advances
```

The alert is not deferred. It is **consumed**.

**The generalization matters more than the instance.** `sendLine` returns
`Promise<void>` from **four** outcomes the caller cannot tell apart:

| # | Outcome | Line |
|---|---|---|
| 1 | muted | `line.ts:18-21` |
| 2 | token or userId missing | `line.ts:25-28` |
| 3 | HTTP non-OK (4xx/5xx) — warned, swallowed | `line.ts:42-45` |
| 4 | network throw / timeout — warned, swallowed | `line.ts:46-48` |

Muting is only the outcome we have log evidence for. A 500 from LINE or a DNS
timeout consumes the alert identically — as does running `npm run alerts` from
the app dir without credentials, which CLAUDE.md documents as normal for ad-hoc
CLI runs. Repairing only the mute path leaves three live variants.

---

## L0 — Inventory at current HEAD

### L0.a — Four implementations

**Implementation 1 — `apps/scenario-simulator/src/notify/line.ts`.**
`sendLine(text): Promise<void>`. POSTs `api.line.me/v2/bot/message/push`. Mute
test `existsSync(join(process.cwd(),'..','..','data','line-notifications-muted'))`
— **cwd-dependent**. No result, no status, no message-level retry.

| Caller | Trigger | Success interpretation | State mutation |
|---|---|---|---|
| `cli-alerts.ts:185` | price threshold | logs `"LINE message sent"` unconditionally | **`saveState()` advances dedupe unconditionally** |
| `cli-discover.ts:542` | paper position opened | none | position already written before the send |
| `cli-run.ts:87` | actionable trade signals | none | none — fire-and-forget |

**Implementation 2 — `apps/world-intelligence-data-hub-/run.ts:24-67`.** Own
`fetch`, own hand-rolled `.env` regex parser reading
`apps/scenario-simulator/.env`, and a second independent copy of the
cwd-dependent mute expression.

- Muted → returns at `:30`, **before** the marker write at `:33`. **This is the
  one implementation that orders mute and dedupe correctly.**
- Non-OK and throw → both fall through to `writeFileSync(marker, {…, alertedAt})`
  at `:66`. Its daily marker advances **on failure**.

**Implementation 3 — `scripts/pipeline-watchdog.sh:94-138`.** `curl -s`, no
`-f`, no status capture.

- `:96` `touch "$MARKER"` runs **before** the isolation gate at `:105` and
  **before** the mute check at `:112`. **A muted watchdog burns its
  logical-date/state marker permanently** — the same shape as the alerts
  incident.
- Mute test `[ -f "$REPO/data/… ]` is cwd-independent and correct.

**Implementation 4 — `scripts/daily-catchup.sh:55-73`.**

- `:57` `touch "$ALERT_MARKER"` runs **before** the mute check at `:58`. Same
  marker-before-mute defect.
- No "sent" log after the curl; `:62` logs *"sending LINE alert…"* before the
  attempt.

> **Corrected count: three of four implementations consume dedupe state on a
> suppressed send** — `cli-alerts` via `saveState`, and both shell scripts via
> marker-before-mute. Revision 1 claimed one, and attributed marker-consumption
> to the single implementation that actually gets it right.

### L0.b — Triggers (the axis revision 1 missed entirely)

Enumerating call sites is not enumerating what fires them.

| Trigger | Reaches | Cadence | Observability |
|---|---|---|---|
| launchd `…alerts` | `cli-alerts` | 30 min, market hours | **currently unloaded** |
| launchd `…daily` → DAG | `cli-run`, `cli-discover`, `run.ts` | daily | **currently unloaded** |
| launchd `…worker` | any DAG stage | continuous | **RUNNING** |
| `scripts/pipeline-watchdog.sh` | own curl | scheduled | — |
| `scripts/daily-catchup.sh` | own curl | wake/login | — |
| **`apps/scenario-simulator` `npm run schedule`** | **`cli-discover` at 06:45 daily** | **node-cron daemon** | **none** |
| **`world-intelligence-data-hub-` `npm run schedule`** | **`run.ts` → `alertOnStaleSourcesOnce`** | **GDELT every 15 min ≈ 96×/day** | **none** |
| manual CLI | all three sender CLIs | ad hoc | none |

The two `npm run schedule` daemons (`cli-schedule.ts:75-82`,
`ingestion/scheduler.ts:25-42`) are long-lived `node-cron` processes. Neither is
launchd-managed, in `DAILY_PIPELINE`, or recorded in `pipeline_runs`. Neither
passes an isolation gate or takes a lock. `run.ts:124` calls
`alertOnStaleSourcesOnce` unconditionally in `main()`, so a *single-source*
invocation reaches the sender exactly as a full pipeline run does.

**Verified not running at the time of writing** — `pgrep` for both returns
nothing. They are one `npm run schedule` from live, with no gate in between.

### L0.c — Retry already exists, one layer up

Revision 1 stated no retry exists. **That is true inside `sendLine` and false in
production.**

`packages/queue/src/submit.ts:15,37` — `DEFAULT_RETRY = { attempts: 3,
backoffMs: 60_000 }`, applied as `spec.retry ?? DEFAULT_RETRY`. The only DAG
stage declaring its own is `capital-ingestion` (`jobs.ts:106`), which is not a
sender. So `world-intel-pipeline`, `scenario-simulate` and `scenario-discover`
all inherit **3 attempts, exponential 60s backoff**. Confirmed in the stored
per-job opts in Redis: `{"attempts":3,"backoff":{"delay":60000,…}}`.

Stage-level retry re-enters the send, and does so differently per caller:

- **`cli-run.ts:87`** — no dedupe. A crash after the send re-runs the whole
  stage, regenerates actions through the LLM, and pushes again: up to 3
  messages, potentially with *different content*, for one logical day.
- **`cli-discover.ts:542`** — the opposite. `:247` re-reads open tickers and
  `:493` gates on `!openDiscoveryTickers.has(...)`, so on retry the position
  from attempt 1 is skipped and **the notification is never re-attempted**.
  Retry structurally guarantees that lost trade alert can never be recovered.
- **`run.ts:66`** — the marker suppresses a retry that reached `:66`, but a
  crash between the `fetch` at `:55` and the write at `:66` re-sends.

**Design consequence:** message-level idempotency must be idempotent across
**BullMQ re-attempts of the same logical stage**, not merely across retries
inside one process. A retry key held in memory would be worthless here.

### L0.d — Four spellings of mute authority, not three

| Spelling | Location | cwd-independent? |
|---|---|---|
| `process.cwd()/../../data/…` | `line.ts:14`, `run.ts:28` | no |
| `$REPO/data/…` (script-location derived) | `pipeline-watchdog.sh:112` | yes |
| `$ROOT/data/…` | `daily-catchup.sh:58` | yes |
| `canonicalPath(PRODUCTION_REPO/…)` | `isolation.ts:148` | **yes — and called by nothing** |

The cwd-dependent form resolves correctly **only** because every real invocation
`cd`s into an app directory two levels deep first (`run-alerts.sh:16`). From the
repo root it resolves `/Users/thanapold/data/line-notifications-muted`, which
does not exist — **and a missing mute file reads as not muted.** The kill switch
is load-bearing on one `cd`.

`notificationPolicy()` (`isolation.ts:147`) already returns the right typed
decision, handles the isolated case, and uses the only construction-anchored
path. Its sole importer is its own test. Zero senders consult it. Sixth instance
this session of a safety mechanism that exists, passes its own tests, and is not
on the execution path.

### L0.e — Resurrection reaches LINE senders (was open; now closed)

`submit.ts:47-71` documents a mechanism, reproduced on isolated Redis on
2026-08-27, by which trimming a failed leaf out of a capped set unpins its parent
and **the live worker executes it**. `removeOnFail: false` is the containment —
but it applies only to *newly submitted* jobs. BullMQ stores opts per job, and a
sampled parked job still carries `{"removeOnFail":{"count":100}}`.

Read-only Redis enumeration of what is parked and failed:

| Set | LINE-capable jobs |
|---|---|
| `waiting-children` | 5 `scenario-simulate`, 1 `scenario-discover` |
| `failed` | 12 `world-intel-pipeline`, 9 `scenario-simulate`, 1 `scenario-discover` |

So resurrection is a live LINE request path with no caller in any inventory.

**It is dormant, not active.** Trimming triggers when the failed set exceeds
100; it currently holds 41, and with the daily scheduler frozen nothing is
generating new failures. The freeze is what is holding this closed. Restoring
the scheduler without addressing it walks toward the trigger.

Queue cleanup and reconciler execution are frozen. **Nothing was done about
this** beyond reading.

---

## L1 — Semantics before schema

A discriminated union. Not `void`. Not `boolean`. HTTP completion is never
equated with delivery.

```ts
export type DeliveryResult =
  | { kind: 'accepted';          retryKey: string; acceptedAt: string; status: number }
  | { kind: 'suppressed';        reason: 'muted' | 'isolated'; retryKey: null }
  | { kind: 'retryable_failure'; retryKey: string; attempt: number; cause: string; status?: number }
  | { kind: 'terminal_failure';  retryKey: string; cause: string; status?: number }
```

**`accepted` means LINE accepted the request for processing** — not that the
user received, saw or read anything. No state may be named as though it did.

**Absent credentials — a deliberate change.** Today indistinguishable from
success. Under this design: `suppressed('isolated')` in an isolated environment,
where delivery is structurally impossible and absent credentials are expected;
**`terminal_failure` in production**, because it is a misconfiguration leaving
the user uninformed, and calling it suppression would reintroduce the exact
conflation being removed.

| Condition | Result |
|---|---|
| 2xx | `accepted` |
| 409 / duplicate accepted retry key | `accepted` — previously accepted, not a new delivery |
| 429 (honor `Retry-After`), 5xx | `retryable_failure` |
| timeout, DNS, reset, abort | `retryable_failure` |
| 400/401/403/404, other 4xx | `terminal_failure` |

The asymmetry is intentional: retrying a rejected request cannot succeed and
costs quota; not retrying an ambiguous one loses a real notification.

---

## L2 — Retry-key lifecycle

`X-Line-Retry-Key`, a UUID, one per **logical delivery**, never per attempt.

**This is new construction.** No retry key, idempotency header, or message-level
retry exists anywhere in the tree — verified across all extensions including
`.next/`, `dist/` and `_archive/`. It must not be described as preserved.

1. **Generate and persist the key before the first attempt.** The row exists in
   `pending` with its key before any packet leaves. This ordering is the whole
   mechanism; reversing it reintroduces the ambiguity it resolves.
2. First request carries the key.
3. Timeout or retryable status → retry **the same key**.
4. Duplicate accepted key (409 with the original result) → **previously
   accepted**. Not an error, not a new delivery.
5. Most 4xx → terminal, no automatic retry.
6. Muted → **no network request at all**, no key issued.
7. Bounded attempts with backoff; exhaustion → `terminal_failure`, not silence.

**Never generate a new key because an attempt timed out.** A timed-out request
may have been accepted; a fresh key converts an unknown into a guaranteed
second user-visible message.

**The key must survive process death** (L0.c). The logical key is derived from
the notification's identity — stage, logical date, content hash — so that a
BullMQ re-attempt of the same stage resolves to the *same* ledger row and the
*same* retry key rather than minting a new one. This is the single most
important consequence of stage-level retry already existing.

---

## L3 — Alert evaluation is not notification delivery

`alert-state.json` holds `{ ticker: { lastAlertedAt, lastAlertPrice } }`, written
after `sendLine` returns whatever happened. It records **"we reached the send
call"** — which is none of the facts anyone wants, and is falsely readable as
all of them.

| Fact | Knowable? | Where it belongs |
|---|---|---|
| condition already observed | yes | evaluation state |
| notification already attempted | yes | ledger: `attempts > 0` |
| notification accepted by LINE | yes | ledger: `state = accepted` |
| **user already informed** | **no** | nowhere — not observable |

The fourth is what people actually want and LINE cannot tell us. The strongest
honest fact is *accepted*. Nothing may be named `delivered` or `informed`.

**Proposed split.** Evaluation records that a condition was observed, and
advances independent of delivery. Delivery is a ledger row keyed by a logical
key. Dedupe for re-notifying keys off **`accepted`**, never off "attempted".

Consequence, and the point of the design: **an alert observed while muted stays
eligible.** It becomes `suppressed`, not `accepted`, so it is not consumed.

> **Re-offer policy is Neil's decision, not a default I should pick.** A
> threshold crossed six days ago is probably noise now. Options: re-offer only
> if the condition still holds on re-evaluation (**recommended** — self-correcting,
> needs no age constant); re-offer within a fixed window; or never, treating
> suppression as permanent loss. Does not block the design; must be settled
> before restore.

---

## L4 — Canonical mute authority

One configuration, resolved from an absolute canonical root, meaning the same
thing from every cwd and every process.

- **Promote `notificationPolicy()` / `canonicalPath(PRODUCTION_REPO/…)`** rather
  than writing a fifth spelling. It is already correct and merely unused.
- **Delete both cwd-dependent copies** (`line.ts:14`, `run.ts:28`).
- **Shell scripts stop implementing LINE semantics.** `pipeline-watchdog.sh` and
  `daily-catchup.sh` each own a mute test, credential load, curl and marker
  today. They lose all four and call one `bin/notify.ts`. This removes two of
  four implementations and both marker-before-mute defects.
- **The marker/dedupe write moves after the delivery result**, everywhere. That
  single ordering rule is what all three consuming implementations violate.

**Capability injection, not environment inference.** The policy is resolved once
and passed in; nothing downstream re-derives it from `process.env` or `cwd` —
the set of spellings that reach an endpoint is larger than the set anyone
enumerates.

---

## L5 — One delivery choke point

```
caller → NotificationClient → LINE implementation
```

```ts
export interface NotificationClient {
  send(n: Notification): Promise<DeliveryResult>
}
```

| Environment | Implementation |
|---|---|
| production, not muted | `LineNotificationClient` — real HTTP, retry keys, ledger |
| production, muted | `SuppressedNotificationClient` — returns `suppressed`, **makes no request** |
| isolated / test | `FakeNotificationClient` — records calls, programmable results |

Selected once by `resolveNotificationClient(policy)` and injected.

Callers must not know the token, endpoint, retry-key header, mute path, or how
to read an HTTP status. They receive a `DeliveryResult` and must handle every
variant — `noFallthroughCasesInSwitch` is already on repo-wide, so a caller that
ignores a variant fails to compile.

---

## L6 — Persistence

**SUPERSEDED by L6c, and not to be built.** Retained only to show what the
content-hash identity looked like before revision 4 withdrew it.

```sql
-- WITHDRAWN — content-derived logical_key; do not implement
CREATE TABLE notification_deliveries (
  id             BIGSERIAL PRIMARY KEY,
  retry_key      UUID        NOT NULL UNIQUE,
  channel        TEXT        NOT NULL,
  logical_key    TEXT        NOT NULL,   -- stage + logical date + content hash
  origin         TEXT        NOT NULL,
  payload        TEXT        NOT NULL,
  payload_hash   TEXT        NOT NULL,
  state          TEXT        NOT NULL,   -- pending|accepted|retryable_failed|terminal_failed|suppressed
  attempts       INTEGER     NOT NULL DEFAULT 0,
  http_status    INTEGER,
  last_error     TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  first_attempt_at TIMESTAMPTZ,
  last_attempt_at  TIMESTAMPTZ,
  accepted_at    TIMESTAMPTZ,
  CONSTRAINT accepted_has_timestamp
    CHECK (state <> 'accepted' OR accepted_at IS NOT NULL),
  CONSTRAINT suppressed_never_attempted
    CHECK (state <> 'suppressed' OR attempts = 0)
);
CREATE INDEX ON notification_deliveries (state, created_at)
  WHERE state IN ('pending','retryable_failed');
CREATE UNIQUE INDEX ON notification_deliveries (channel, logical_key)
  WHERE state = 'accepted';
```

The CHECKs and the partial unique index make the old defect unrepresentable: a
suppressed row cannot claim attempts, an accepted row must carry its acceptance
time, and one logical notification can be accepted at most once — **including
across BullMQ stage re-attempts**, since the logical key is derived, not minted.

### Crash boundaries

| Crash point | Row after crash | Truth at LINE | Recovery |
|---|---|---|---|
| before request | `pending`, attempts 0 | nothing sent | retry same key. Safe. |
| after request, before response | `pending`, attempts 1 | **unknown** | retry **same key** → 409 → `accepted`. No second message. |
| after acceptance, before local persist | `pending`, attempts 1 | accepted | identical row, resolves identically. **This is why the key is persisted first.** |
| restart with pending rows | `pending` | unknown | bounded recovery sweep, same key, then `terminal_failed` |
| **BullMQ re-attempt of the stage** | row found by logical key | whatever it was | resumes that row; does not mint a new key |

Rows two and three are locally indistinguishable — and that is the point.
Because the key was written before the attempt, both resolve correctly without
the system ever learning which happened.

A `terminal_failed` row is a **visible** unresolved delivery, not silence. It is
what the dashboard should surface.

---

## L7 — Behavioral test plan

Tests attack running behavior. Warden does not grep for `sendLine`.

| # | Test | Catches |
|---|---|---|
| 1 | muted → **zero** HTTP requests, intercepted at the socket | a mute that still calls out |
| 2 | muted → no delivered-state advancement | the original defect |
| 3 | accepted → state advances **exactly once** | double-advance |
| 4 | timeout → retry uses the **identical** key | key regeneration |
| 5 | accepted + crash before persist → recovery cannot create a second *logical* request | the crash-boundary claim |
| 6 | duplicate-key / 409 → `accepted` | treating idempotent replay as failure |
| 7 | terminal 4xx → bounded, recorded, no storm | retry storm |
| 8 | caller **cannot** log "sent" for a suppressed result | log/state divergence |
| 9 | changing cwd does not change mute behavior | the `cd`-dependent kill switch |
| 10 | **every production LINE path crosses the boundary** | a later bypass |
| 11 | **BullMQ re-attempt of a sender stage produces at most one accepted delivery** | L0.c — the failure revision 1 could not have caught |
| 12 | **dedupe marker/state is never written when the result is `suppressed`** | the three marker-before-mute implementations |

Tests 11 and 12 exist only because of Warden's attack.

Test 10 must be a reachability walk from real **triggers** — including the two
`npm run schedule` daemons — not from call sites. Revision 1's map would have
produced a test that passed while two cron daemons sent freely. Test 1 must
intercept at the network layer; module mocking would pass against the three
implementations that build their own client.

---

## Migration path

| # | Caller | Change | Risk |
|---|---|---|---|
| 1 | `cli-run.ts:87` | inject client; handle result | low |
| 2 | `cli-discover.ts:542` | inject client; ledger row keyed to the trade | low |
| 3 | `world-intel run.ts` | delete own impl, env parser, mute copy; marker only on `accepted` | medium |
| 4 | `pipeline-watchdog.sh` | delete curl/mute/creds/marker; call `bin/notify.ts`; **move marker after result** | medium — must still work when the pipeline is down |
| 5 | `daily-catchup.sh` | same | medium |
| 6 | `cli-alerts.ts:185` | **last.** Split evaluation from delivery; dedupe on `accepted` | highest — the actual incident |
| 7 | both `npm run schedule` daemons | gate or retire; they bypass every existing control | **open — see below** |

`cli-alerts` goes last deliberately: it is the only caller whose semantics change
rather than its plumbing, and by then the boundary is proven by five migrations.

**Deletions enabled:** two cwd-dependent mute expressions, two shell curl
implementations, one hand-rolled `.env` parser, three marker/state writes that
precede the mute check, and `sendLine`'s `Promise<void>` signature.

---

## Inventory failures in revision 1

Recorded because the pattern is the point.

| Claim | Reality |
|---|---|
| "six callers, complete" | complete as *call sites*; missed the trigger axis entirely — two unmanaged cron daemons, one ≈96×/day |
| "no retry exists" | true inside `sendLine`, false in production: 3 attempts inherited by all three sender stages |
| "three spellings" | four |
| "impl 2 advances marker on failure" (implied: only one consumes) | three of four consume dedupe on a suppressed send; impl 2 is the one that orders it correctly |
| "impl 4 logs 'sent' unconditionally" | it does not; its defect is marker-before-mute, which is worse |

The through-line is the same failure this whole effort keeps meeting: I
enumerated the mechanism and not the paths that reach it. A design built on
revision 1 would have produced a centralized boundary, a correct ledger, a
passing test suite — and two cron daemons still sending outside all of it.

---

## Not in this proposal

No implementation, no migration `012`, no code changes. No alerts restore
(sequence remains implement → tests → Warden → Glenn → approval → restore). No
unmuting. No replay. No queue cleanup or reconciler execution — the resurrection
finding in L0.e was **read only**.

Frozen and untouched: daily scheduler, Aug 26/27 reconciliation, queue cleanup,
reconciler execution, thesis reconciliation, creator-studio migration, DB Phase
2, claim governance.

## L6a — Identity, in four layers (REVISION 4, for review)

**Revision 3's `uuidv5(NS, logical_key)` is WITHDRAWN.** It collapsed transport
identity into business identity. Two consequences make that unsafe:

1. **LINE retains retry-key protection for only 24 hours.** A key derived from a
   permanent business fact keeps being *presented* after its protection has
   lapsed, so the system believes it is idempotent when it no longer is. The
   belief is worse than the absence.
2. **A legitimate re-offer becomes unsendable.** If a suppressed event is later
   re-evaluated and still holds, a deterministic key would collide with the
   earlier attempt and LINE would answer "already accepted" — the re-offer would
   be silently swallowed. The design would defeat its own recovery path.

### The four layers

| Layer | What it is | Identity | Lifetime |
|---|---|---|---|
| **Business observation** | a raw measurement — this ticker crossed this threshold at this price at this instant | observation row id | forever (history) |
| **Logical notification event** | the thing worth telling the user, once | business key, per class (below) | until accepted, expired, or terminal |
| **Delivery episode** | one attempt-set at delivering that event | **minted UUID = the `X-Line-Retry-Key`** | ≤ 24h (LINE's protection window) |
| **HTTP attempt** | one request | attempt number within the episode | one round trip |

**The retry key belongs to the episode.** That is the only scope over which LINE
guarantees anything, and it is bounded by the same 24 hours. Episode is not a
synonym for event: one event may need a second episode (a new key) if the first
lapses, and that is a feature, not a leak.

### Episode rules

- **Mint** a UUID when the episode is created.
- **Persist durably before the first LINE request** — the key, the exact
  recipient, and the exact payload bytes. The payload is frozen at creation, so
  a BullMQ re-attempt that regenerates content cannot send different words under
  the same key.
- **Every retry** — BullMQ stage re-attempt, process restart, network retry —
  **reloads and reuses that same key, recipient and payload.** A retry never
  re-derives any of the three.
- **Outcomes:**

| Condition | Result |
|---|---|
| 2xx | `accepted` |
| 409 for the same retry key | `accepted` — previously accepted, not a new delivery |
| timeout / connection reset / DNS | `retryable_failure`, same episode and key |
| 5xx | `retryable_failure`, same episode and key |
| **429** | `retryable_failure`, classified explicitly — quota, not fault. Honour `Retry-After`; it must not count toward the failure budget the way a 5xx does |
| other 4xx (400/401/403/404) | `terminal_failure` — no automatic retry |
| `key_expires_at` passed while not accepted | `abandoned` — see below |

- **Suppression performs zero LINE network activity.** No episode is created, so
  no key is minted and nothing is attempted. Suppression is recorded on the
  *event*, and it does **not** advance accepted-delivery dedupe.
- **Re-offer** of a suppressed event is permitted only after the underlying
  business condition is re-evaluated and **still holds**. That creates a **new
  delivery episode** with a **new key**. No replay of a stale crossing.

### The 24-hour rule, stated as a rule

An episode whose `key_expires_at` has passed without acceptance **must not be
retried under that key** — the protection is gone and a retry could duplicate a
message LINE actually accepted. The episode becomes `abandoned`, and the event
returns to eligible *only* if re-evaluation says the condition still holds, which
mints a fresh episode. This is precisely the case the deterministic design could
not represent.

---

## L6b — Per-class identity

For each class: what was observed, what the notification *is*, when an episode
may be opened, what suppression does, and when the event dies.

### 1. `cli-alerts` — threshold alert

| | |
|---|---|
| Observation identity | `(ticker, evaluated_at, price, reasons[])` — one row per evaluation that crossed |
| Logical event identity | `alert:{ticker}:{triggerKind}:{businessDate}` — `triggerKind` separates a price move from a news-velocity trigger. **Price value is evidence, not identity**, so a further move the same day is the same event |
| Freshness / episode boundary | the condition must still hold at episode creation. An episode is one delivery attempt-set; a later cycle may open a new one only on re-observation |
| Suppression | event → `suppressed`; no episode; dedupe not advanced; stays eligible |
| Episode creation | condition observed now **and** no accepted episode for this event **and** no live episode |
| Terminal | accepted · business date rolls over (expired unsent) · terminal_failure |

*This is the incident class. Today `saveState()` advances dedupe whatever
happened, consuming the alert.*

### 2. `cli-discover` — discovered trade

| | |
|---|---|
| Observation identity | the paper position row: `(positionId, ticker, shares, price, opened_at)` |
| Logical event identity | `discovery:{positionId}` — a durable DB key. **No date**: a position opens once |
| Freshness / episode boundary | same business day. A trade alert delivered days late is noise, so the event expires rather than being re-offered indefinitely |
| Suppression | `suppressed`; remains eligible within the window |
| Episode creation | position exists, is unnotified, and the window is open |
| Terminal | accepted · window expiry · terminal_failure |

*Today stage retry **destroys** this notification: the retry re-reads open
tickers, skips the already-open position, and the alert can never be recovered.
An event keyed to `positionId` is re-found on retry instead.*

### 3. `cli-run` — scenario signal

| | |
|---|---|
| Observation identity | the generated action set for a date, plus its content hash **as evidence** |
| Logical event identity | `signals:{businessDate}` — **deliberately excludes content** |
| Freshness / episode boundary | the business date. Payload frozen at episode creation |
| Suppression | `suppressed`; eligible until the date rolls |
| Episode creation | actionable signals exist and no accepted episode for that date |
| Terminal | accepted · date rollover · terminal_failure |

*Today three BullMQ attempts can send three messages with **different**
LLM-generated content for one logical day. Content-independent identity plus a
frozen payload fixes both halves.*

### 4. `world-intel` — stale source

| | |
|---|---|
| Observation identity | `(source, measured_at, last_success_at)` |
| Logical event identity | `stale:{source}:{businessDate}` — **per source**, not per source-set |
| Freshness / episode boundary | the business date; still stale tomorrow is a new event |
| Suppression | `suppressed`; eligible while still stale that day |
| Episode creation | source stale now and no accepted episode today |
| Terminal | accepted · **source recovers → condition moot, event expires** · date rollover |

*Per-source matters: today one marker covers the whole set, so a second source
degrading later the same day is unnotifiable. Note this implementation already
orders mute before its marker correctly — it is the failure paths that advance
it wrongly.*

### 5. `watchdog` — pipeline state

| | |
|---|---|
| Observation identity | `(logicalDate, state, evaluated_at)` |
| Logical event identity | `watchdog:{logicalDate}:{state}` — matches today's `$LOGICAL-$STATE` marker, which is already the right identity |
| Freshness / episode boundary | while that state persists |
| Suppression | `suppressed`; **stays eligible while the state persists** |
| Episode creation | state observed and no accepted episode for `(date, state)` |
| Terminal | accepted · **state changes → alert moot** · terminal_failure |

*Today `touch "$MARKER"` runs before both the isolation gate and the mute check,
so a muted watchdog burns its marker permanently. Also: per the standing
decision this path's ledger write is **best-effort** — losing the database must
not disable the watchdog. That failure mode is specified in L6c.*

### 6. `daily-catchup` — pipeline failure

| | |
|---|---|
| Observation identity | `(businessDate, failure_count, observed_at)` |
| Logical event identity | `catchup:{businessDate}` — one per day; **the count is evidence, not identity** |
| Freshness / episode boundary | the business date |
| Suppression | `suppressed`; eligible while failures persist |
| Episode creation | failures > 0 and no accepted episode today |
| Terminal | accepted · **a successful run occurs → condition moot** · date rollover |

*Same marker-before-mute defect as the watchdog.*

> **`businessDate` is the `America/Los_Angeles` date**, never the machine date —
> two processes in different timezones must agree on the identity.

---

## L6c — Minimum durable ledger

Two tables, because the two lifetimes differ. Fields listed are the minimum that
make the survival cases below representable; this is a model, not a migration.

**`notification_events`** — the logical layer
`id` · `channel` · `class` · `logical_key` (unique per channel) · `business_date`
· `state` (`eligible|suppressed|accepted|expired|terminal_failed`) ·
`first_observed_at` · `last_observed_at` · `condition_snapshot` (evidence) ·
`suppressed_reason` · `suppressed_at`

**`delivery_episodes`** — the transport layer
`id` · `event_id` → event · **`retry_key`** (UUID, unique, minted at creation) ·
**`recipient`** · **`payload`** (exact bytes) · `payload_hash` ·
`state` (`pending|accepted|retryable_failed|terminal_failed|abandoned`) ·
`attempts` · `created_at` · **`key_expires_at`** (= `created_at` + 24h) ·
`first_attempt_at` · `last_attempt_at` · `accepted_at` · `last_status` ·
`last_error` · `retry_after_at` (for 429)

Invariants worth enforcing in the schema rather than in code: at most one
`accepted` episode per event; at most one live (`pending`/`retryable_failed`)
episode per event; an `accepted` episode must carry `accepted_at`; a suppressed
event must have **no** episode at all.

### How each survival case is met

| Case | Durable state at the moment of failure | Recovery |
|---|---|---|
| **crash before HTTP** | episode `pending`, `attempts = 0` | retry same key. Nothing was sent |
| **timeout after LINE accepted** | episode `pending`, `attempts ≥ 1`; local truth unknown | retry **same key** → 409 → `accepted`. Works **only** because the key was persisted before the request |
| **BullMQ stage retry** | event found by `logical_key`; a live episode already exists | reuse its key, recipient and payload — never mint, never regenerate the payload |
| **process restart** | episodes left `pending`/`retryable_failed` | recovery sweep resumes them under the same key, bounded attempts, then `terminal_failed` |
| **mute → unmute** | events `suppressed`, **no episodes exist** | nothing to replay by construction. Re-offer only after re-evaluation says the condition still holds, which mints a new episode |
| **retry past 24h** | episode past `key_expires_at`, not accepted | **do not reuse the key.** Mark `abandoned`; re-offer only on re-evaluation, with a new episode and new key |

The last row is the one the withdrawn design could not express, and the reason
the key belongs to the episode.

---

## Decisions recorded 2026-08-28

Approved by Neil; captured here so the design is not re-litigated.

1. **Suppressed-alert re-offer** — re-offer only if the condition still holds on
   re-evaluation. No replay of stale threshold crossings. Evaluation history is
   historical truth; notification eligibility is recomputed from current
   conditions.
2. **Missing production credentials** — `terminal_failure`, not suppression. But
   **no recursive "LINE is broken, page me via LINE"** mechanism: surface it
   through operational health / dashboard / logging.
3. **Watchdog** — crosses the same notification semantic boundary; **no
   last-resort raw curl bypass**. Its ledger persistence may be best-effort so
   losing the primary database does not disable the watchdog. Same delivery
   semantics, *not* the same persistence dependency — and that failure mode must
   be designed explicitly before implementation.
4. **Unmanaged cron daemons** — treated as **untrusted dormant execution
   surfaces**, not merely "to be gated". Before deciding whether they survive,
   determine whether the DAG already supersedes their schedules. If yes, retire
   them; if they provide genuinely unique behaviour, bring that evidence back
   before integrating. They remain stopped.
5. **Daily scheduler** — stays frozen. The resurrection finding (L0.e) makes
   restoring autonomous submission *less* attractive, not more.

---

## Open decisions for Neil

1. **Re-offer policy for suppressed alerts** (L3) — recommend: only if the
   condition still holds on re-evaluation.
2. **Should missing production credentials page?** It becomes a visible
   `terminal_failure` instead of silence — strictly better, but a new noise
   surface the first time a credential expires.
3. **May the watchdog keep a last-resort direct path?** Routing it through the
   infrastructure it monitors is a shared failure mode. Recommend it crosses the
   boundary but writes the ledger best-effort, so a database failure cannot mute
   the watchdog.
4. **NEW — what happens to the two `npm run schedule` daemons?** They bypass
   launchd, the DAG, `pipeline_runs`, the isolation gate and locking. Gate them
   behind the same boundary, or retire them as superseded by the DAG. I do not
   know whether they are still intended to exist, and that is a question about
   your operating model, not the code.
5. **NEW — does L0.e change the daily-scheduler decision?** It is dormant only
   while the scheduler is frozen and the failed set stays under 100. Currently
   41. Restoring the scheduler without addressing the parked flows walks toward
   the trigger, and 6 parked parents are LINE senders.
