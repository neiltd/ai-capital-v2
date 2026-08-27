# Executable entry-point and side-effect authority graph

**Status: INVENTORY. No implementation, no production mutation.**

Built because the same failure has now recurred four times: *a safety mechanism
exists, passes its own tests, and the real execution path does not use it.*
Every row below starts from something that can actually execute, not from a
module that looks important.

---

## F1. What macOS actually executes today

### Loaded agents — only two

| Label | Program | Reaches | Frequency |
|---|---|---|---|
| `com.thanapol.ai-capital.alerts` | `/bin/bash scripts/run-alerts.sh` | `cd apps/scenario-simulator` → `npx tsx src/cli/cli-alerts.ts` | every 30 min, market hours |
| `com.thanapol.ai-capital.worker` | `caffeinate -i npx tsx packages/queue/bin/worker.ts` | `createWorker` → `processJob` → `spawn` of any DAG stage | continuous |

### Not loaded

`com.thanapol.ai-capital.daily` — **booted out 2026-08-27**. Its plist targets
`scripts/daily-catchup.sh`.

### Cron — one entry

`0 8 1 * *` → `scripts/dep-graph-scan.sh`. Monthly. No submitter reference.

### THE CENTRAL FINDING

```
plist target ................ scripts/daily-catchup.sh      <- what launchd runs
scripts I hardened .......... scripts/daily-scheduler.sh    <- referenced only by ops/launchd-proposed/
                              scripts/pipeline-watchdog.sh  <- referenced only by ops/launchd-proposed/
```

**The isolation gate is not on the production path.** `daily-catchup.sh` has a
hardcoded `ROOT`, no isolation gate, its own `sqlite3` reads and its own `curl`
to LINE. The two scripts carrying the gate have no installed plist. If the daily
agent were booted back in tomorrow, it would run the unguarded script.

### Dead / unwired safety code

| File | Status |
|---|---|
| `scripts/daily-scheduler.sh` | referenced only by an uninstalled proposal |
| `scripts/pipeline-watchdog.sh` | same |
| `packages/queue/testing/queue-integration-setup.ts` | **not in any `setupFiles`** — imported by nothing but a string literal in its own meta-test |
| `notificationPolicy()` | called by nothing outside its own test |
| `requireIsolation()` | called by `check-isolation.ts` and its own test; no test harness loads it |
| `removeFlow()` | no bin, no script, no schedule |
| `daily.sh` | legacy pre-queue orchestrator, retained for rollback |

---

## F2. Every LINE send path

| # | Caller | Production reachable? | Test reachable? | Credential source | Mute source | Policy used? |
|---|---|---|---|---|---|---|
| 1 | `apps/scenario-simulator/src/notify/line.ts:7` via `cli-alerts.ts:185` | **YES — loaded agent, every 30 min** | yes | `apps/scenario-simulator/.env` | `cwd/../../data/…` | **no** |
| 2 | same, via `cli-run.ts:87` | yes (DAG stage) | yes | same | same | **no** |
| 3 | same, via `cli-discover.ts:542` | yes (Sunday DAG) | yes | same | same | **no** |
| 4 | `apps/world-intelligence-data-hub-/run.ts:55` | yes (DAG stage) | yes | own `.env` read | `cwd/../../data/…` | **no** |
| 5 | `scripts/daily-catchup.sh:67` | **yes — the plist target** | n/a | sources `.env` | `$ROOT/data/…` (hardcoded ROOT) | **no** |
| 6 | `scripts/pipeline-watchdog.sh:129` | no (unwired) | yes | `$REPO/.env` | `$REPO/data/…` | partially — gate is defeatable |

**Five of six senders never consult `notificationPolicy()`.** The one that does
is the one nothing runs.

### The cwd-relative mute, measured

```
cwd=<repo>                       -> /Users/thanapold/data/line-notifications-muted   NOT FOUND -> WOULD SEND
cwd=<repo>/apps/scenario-simulator -> <repo>/data/line-notifications-muted           FOUND
cwd=/tmp                         -> /data/line-notifications-muted                   NOT FOUND -> WOULD SEND
```

The live alerts agent is muted **only because `run-alerts.sh` happens to `cd`
into the app directory first**. That is an accident of one line in one script,
not a property of the mute.

### Proposed choke point (NOT implemented)

One `NotificationBoundary` interface; `sendLine` becomes its only real
implementation and is the only module allowed to name `api.line.me`. Every
caller receives a boundary instance rather than importing a sender. Tests
receive a recording fake. An architecture check fails on any new occurrence of
`api.line.me` outside the boundary module — the same shape as
`verify-architecture.ts` for Postgres constructors, which does work.

> **Target: no code can perform a real LINE push without passing through one
> boundary, and the shell senders must call the same boundary rather than
> reimplementing mute semantics in bash.**

---

## F3. Every Redis constructor

| Site | Via `connectionOptions()`? |
|---|---|
| `packages/queue/src/queue.ts:39` `new Queue` | yes |
| `packages/queue/src/queue.ts:45` `new QueueEvents` | yes |
| `packages/queue/src/queue.ts:56` `new Worker` | yes |
| `packages/queue/src/submit.ts:219` `new FlowProducer` | yes |
| `packages/queue/bin/smoke-flow.ts:37` `new FlowProducer` | yes |

No raw `ioredis` client anywhere. **Every constructor already funnels through
one function** — which is the good news, and it means the problem was never
discovery, it was that `connectionOptions()` reads `process.env.REDIS_URL`
with a production default and asks nobody's permission.

Proposed: `connectionOptions()` stops reading the environment directly and takes
an injected connection. Production wires it once at each bin; tests wire an
isolated one. The regex meta-test is then unnecessary — there is nothing to
recognise, because the capability cannot be obtained without being given.

---

## F4. Every `pipeline-runs.db` opener

| Path | Class | Correct today? |
|---|---|---|
| `packages/pipeline-runs/src/api.ts` ×6 (`recordStart`/`recordEnd`/…) | production read/write | yes |
| `packages/pipeline-runs/src/store.ts:49` `openDb` | writer primitive | yes |
| `packages/pipeline-runs/src/store.ts:81` `openDbReadOnly` | diagnostic | creates a `-shm` on WAL; comment claims otherwise |
| **`packages/pipeline-runs/bin/daily-run-status.ts:20`** | **documented "READ-ONLY", calls `openDb`** | **NO — creates a decoy DB, no `ensurePipelineEnv`** |
| `packages/queue/bin/reconcile.ts:30` (dry run) | diagnostic | yes |
| `packages/queue/bin/reconcile.ts:58` (`--apply`) | **needs a writer, has read-only** | **NO — `--apply` is broken** |
| `packages/queue/src/reconcile.ts:149` `openParents` | diagnostic | yes |
| `scripts/daily-catchup.sh:36,52` | `file:…?mode=ro` | yes |
| `daily-queue.sh` zombie sweep | **read/write UPDATE** | works, but is an accidental reconciler |
| `scripts/morning-status.ts` | diagnostic | unaudited |
| `apps/unified-platform/src/app/(next)/system/pipeline/data.ts` | dashboard read | unaudited |
| `apps/unified-platform/src/app/api/status/route.ts` | HTTP route | unaudited |

`daily-run-status.ts` is the one that matters most: **both scheduler scripts
derive `state`, `eligibleToRun` and `shouldAlert` from it.** It is the input that
decides whether to submit a pipeline and whether to fire an alert, and it can
answer from a database it just created.

Proposed: two separate APIs — `openRunStore()` (read/write, production) and
`readRunStore()` (read-only, refuses non-existent, used by every diagnostic).
`--apply` takes the writer explicitly. `openDbReadOnly` never serves a mutating
command again.

---

## F5. Test outbound network — a fifth isolation dimension

Nine test files reach `fetch`/`axios`/`https://`, concentrated in
`apps/capital-intelligence-ingestion/tests/clients/*`. Observed live during a
suite run: `Price fetch failed for NVDA: HTTP 429` from `apps/scenario-simulator`.

**No shared setup blocks network.** All 14 `vitest.config.ts` files load the
Postgres isolation setup and nothing else.

So the isolation model becomes:

```
DB + Redis + filesystem + notifications + NETWORK
```

Proposed: default-deny outbound network in the shared test setup (an `undici`
`MockAgent` with no interceptors, so an unmocked request throws a named error),
with an explicit per-suite allowlist for integrations that genuinely need it.
Default-deny matters because nothing structurally prevents an outbound LINE POST
from a test today.

---

## F6. Capability injection over environment inference

The bypass record is the argument. Asking *"does this URL look like production?"*
has now been defeated by percent-encoding, `socket:` URLs, `PGDATABASE`,
discrete config, query strings, empty userinfo, `127.1`, integer-form loopback,
FQDN root dots, hostname aliases, `rediss://`, IPv4-mapped IPv6, and a loopback
port forward. Each fix was correct and the next spelling arrived anyway.

Inference cannot win because the set of spellings that reach an endpoint is
larger than the set anyone enumerates. Capability can: code that is never handed
a client cannot open one.

```
today     module reads process.env -> builds client -> guard tries to prove the destination was safe
proposed  entry point builds the capability -> passes it in -> module cannot obtain another
```

Environment validation stays as defence in depth. It stops being the authority.

---

## F7. Wiring tests, not unit tests

Each begins at a real executable entry point.

| Property | Test that would actually prove it |
|---|---|
| launchd target is safe | execute **the plist's actual Program** under test config; assert no production side effect reachable |
| diagnostics have honest provenance | run the documented `queue-health` from a clean shell; assert printed DB + Redis identity |
| queue tests cannot reach production | run the real vitest workspace; assert every constructed client received an isolated connection |
| LINE cannot escape | exercise **all six** callers; assert each terminates at the fake boundary |
| `--apply` writes the right store | run it against an isolated fixture; assert the isolated DB changed and production did not |

A unit test of a guard proves the guard works. It does not prove anything uses it.

---

## F8. Provenance on every diagnostic

No tool may print `HEALTHY` without saying what it inspected:

```
mode      : production | isolated
DB        : <canonical path>  (rows=N, mtime=…)
Redis     : <resolved addr:port>  (run_id=…)
business  : America/Los_Angeles
```

**Mixed provenance is refused outright** for sensitive commands. This is the
direct fix for a convincing verdict produced from a decoy DB combined with
production Redis — the tool had every fact needed to notice and printed none of
them.

---

## Migration sequence

Ordered so each step is verifiable before the next, and so the highest live risk
goes first.

1. **Put the guard on the real path.** Either wire the hardened scripts into the
   plist, or move the gate into `daily-catchup.sh`. Until then the gate protects
   nothing that runs.
2. **One notification boundary.** Six callers → one. Includes the two shell
   senders. Highest live risk: a loaded agent sends every 30 minutes and is
   muted by accident of a `cd`.
3. **Split the run-store APIs.** Fix `daily-run-status.ts` (decoy DB) and
   `reconcile --apply` (broken writer) together.
4. **Inject the Redis capability.** Delete the regex meta-test as unnecessary.
5. **Default-deny test network.**
6. **Diagnostic provenance + mixed-provenance refusal.**
7. Only then resume the reconciler classification work, which remains frozen.
