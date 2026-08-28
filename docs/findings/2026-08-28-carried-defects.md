# Carried defects — explicitly queued into the next technical phase

**Recorded, NOT fixed.** Both were found during the dashboard GET-side-effect
repair and are deliberately excluded from it. They are written down here so they
survive a context change rather than living only in a conversation.

---

## D1 — `reconcile --apply` writes through a read-only handle

**Status: CONFIRMED by independent execution on a throwaway store.**
Production was never opened.

`packages/queue/bin/reconcile.ts:58` opens the run store with
`openDbReadOnly(resolveDbPath())`, then line ~64 issues:

```sql
UPDATE pipeline_runs SET status = ?, ended_at = ?, error_message = COALESCE(...)
 WHERE id = ? AND status = 'running'
```

Reproduction against a seeded throwaway database:

```
CONFIRMED — attempt to write a readonly database
row after: running
```

So `--apply` prints every proposed transition and then dies on the first write.
The dry-run path is unaffected and correct.

**Consequence for the current phase:** the reconciler cannot be handed ownership
of orphan reaping yet, which is why `/admin/pipeline` now reports staleness
without repairing it. Fixing D1 is a precondition for giving the reconciler that
job.

**Do not test this against production**, including `--apply` and including dry
run: `openDbReadOnly` builds the WAL shared-memory index and cannot remove it,
so any open perturbs `-shm` and breaks the byte-level evidence baseline.

---

## D2 — `/api/trade-graph` sends a `file:` SQLite URL into `getPool()`

**Status: CONFIRMED by source reading. NOT executed** — running it risks an
unintended production connection.

`apps/unified-platform/src/app/api/trade-graph/route.ts:6` imports `getPool`
from `@common/db/pool` and issues `SELECT` against `trade.*`. But this app's own
`DATABASE_URL` is the Prisma SQLite URL (`file:...creator-studio/prisma/dev.db`),
and `usePostgres()` is `!!DATABASE_URL` — so it returns true and `pg` receives a
connection string it cannot parse as Postgres.

`/api/portfolio/refresh` already documents the same trap at route.ts:33-38 and
works around it by overriding `DATABASE_URL` for the child process. That
workaround is local to that one route; `/api/trade-graph` has none.

**Consequence:** the route fails the moment anyone hits it authenticated. Before
the default-deny inversion it was unauthenticated, so it was reachable by
anyone; it is now gated, which narrows the blast radius but does not fix it.

Not security. The kind of thing that surfaces during the next incident.

---

## D3 — `/api/ask` constructs an LLM client with no rate limit

`apps/unified-platform/src/app/api/ask/route.ts:11,99` — `POST` contains **zero**
`checkRateLimit` calls and reaches `new Anthropic({ apiKey: … })` at :99. Every
sibling spending route gates first: `thesis-proposals` at :14, `studio/chat` at
:24.

Found by Warden while attacking the premise that `app/api/**` could be excluded
from the no-spend walk because those routes are "POST-gated and rate-limited".
The exclusion survived on other grounds; the stated justification was simply
false for this route.

**Severity is bounded but real.** It is POST-only, so it is not a render-path
spend, and since 2026-08-28 it sits behind default-deny auth on loopback. An
authenticated caller can still spend without limit, and a UI bug that retries in
a loop would bill unbounded.

**Not fixed** — outside the W4 scope, which was the two defects Warden found in
the W4 implementation.

## D4 — `ChatThread.sendMessage` has the defect that was fixed in `startConversation`

`apps/unified-platform/src/app/(next)/studio/chat/ChatThread.tsx:128-160`.

W4 fixed `startConversation` (missing `res.ok`, missing `try/finally`). I left
`sendMessage` on the argument that it inherited the shape rather than
introducing it. **Warden confirmed the provenance and refuted the conclusion:**
`src/components/studio/chat/ChatInterface.tsx`, the file it was ported from, has
**zero importers**. It is dead code. `ChatThread.sendMessage` is therefore the
only LIVE instance of this defect in the application.

Both symptoms reproduce:

- Error JSON renders as the agent's own words — reachable in six sends (429),
  and on 401 and 502.
- On a mid-stream failure `streaming` stays **true**, which disables the Send
  button (`:267`) *and* the Enter key (`:129`), while `messages.length > 0` has
  removed the start affordance. Page reload only. Plus an unhandled promise
  rejection, since `:257` and `:266` call `sendMessage()` bare.

**A fix needs more than a guard.** The `error` state has no render site once a
conversation exists — `:205-207` is nested inside `{messages.length === 0 && (`
at `:199`. Adding `!res.ok` handling would set `error` into a void. It also needs
a decision on the orphaned optimistic user message pushed at `:132` and never
rolled back.

## D5 — a 200 with an empty body strands the chat page

Same file, in code W4 introduced. `:106` optimistically writes an empty
assistant message before the first `read()`. A zero-chunk 200 — a tool-only or
immediately-closed stream — leaves a blank bubble, no error, and
`messages.length > 0` has permanently removed the start button.

Fix: only `setMessages` on the first chunk actually received, and treat a
zero-byte stream as an error.

## D6 — the chat stream cannot distinguish truncation from completion

Design-level, flagged by Warden. The route's `text/plain` stream carries no
terminator. If the server ends the chunked body cleanly after a partial answer,
`read()` returns `done` and a half-answer renders as finished prose with no
error.

This is the repo's signature failure class — silent truncation presenting as
success — in a new place. It is the same shape as the muted-alert incident and
the watchdog that logged a send while curl returned an empty body. Worth a
sentinel byte or a length/stop-reason trailer.

## D7 — two unmanaged cron daemons can send LINE outside every control

`apps/scenario-simulator/src/cli/cli-schedule.ts:75-82` (`npm run schedule`)
spawns `cli-discover` daily at 06:45.
`apps/world-intelligence-data-hub-/ingestion/scheduler.ts:25-42` (`npm run
schedule`) spawns `run.ts` **every 15 minutes for GDELT ≈ 96×/day**, and
`run.ts:124` calls `alertOnStaleSourcesOnce` unconditionally in `main()`.

Neither is launchd-managed, in `DAILY_PIPELINE`, recorded in `pipeline_runs`,
gated by isolation, or locked. Verified **not running** on 2026-08-28, but one
command from live.

Full analysis in `docs/proposals/2026-08-28-line-delivery-authority.md` (L0.b).
Listed here because the decision — gate them behind the notification boundary or
retire them as superseded by the DAG — is Neil's, not a design detail.

## Ownership note — orphan reconciliation

For the record, since the dashboard repair deliberately leaves a gap:

`/admin/pipeline` no longer reaps. Nothing else does — `reapOrphans` now has
**zero call sites** in application code. That is intentional: no automatic
reaper is better than a hidden one triggered by viewing a page.

The proper owner is the terminal-event reconciler
(`packages/queue/src/reconcile.ts`), which decides from live queue state rather
than inferring death from a clock. An age threshold cannot distinguish "the
worker died" from "this stage legitimately ran long", and on this deployment the
machine suspends, which stretches wall-clock duration without anything being
wrong. That reconciler is frozen and carries D1.
