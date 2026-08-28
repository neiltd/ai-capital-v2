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
