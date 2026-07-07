# /system/pipeline — Pipeline observability (spec)

**Data:** `packages/pipeline-runs` (`pipeline_runs` table: recordStart/
recordEnd per stage, error_message/error_stack) + `packages/queue/src/jobs.ts`
(DAILY_PIPELINE DAG: stage names, dependsOn edges, skipIf).

Think CI dashboard: the answer to "can I trust today's briefing?" in one
glance.

## Layout

```
┌ Header: last full run · total duration · ● overall status · [Run now]      ┐
├ DAG view (full width): stages as nodes laid out by dependency depth,        │
│   edges as hairlines; node = name · status dot · duration                   │
├ Stage history table: last 7 runs per stage (columns = dates, cells = ✓/✗/–) ┤
├ Failure drawer: error_message + error_stack + [copy] + [re-run stage]       ┤
└──────────────────────────────────────────────────────────────────────────────┘
```

## Components & behavior

- **DAG nodes**: status via icon+color — ✓ good, ✗ critical, ◔ running
  (animated), ⊘ skipped-per-schedule (`notSunday` stages render muted with
  a "weekly" tag, NOT as failures — a Sunday-only stage on Tuesday is
  healthy). Duration under the name, tabular; duration > 2× its 7-run
  median gets an amber clock icon (the "stuck pipeline" early warning).
- **Layout by depth**: columns = dependency depth (world-intel → ingestion →
  thesis → analysis → … → briefing → morning-status), parallel subtrees
  (macro-asset, gov-flow) share a column. Edges hairline; on node hover,
  its ancestor path highlights — "what fed this stage".
- **History grid**: 7 columns of dots per stage — the at-a-glance flake
  detector (Yahoo rate-limit stages show as intermittent ✗).
- **Failure drawer**: exact `error_message`/`error_stack` (monospace,
  `--surface-2`), stage cmd/cwd, and a `Re-run stage` button that enqueues
  just that JobSpec (+ dependents toggle).
- **Freshness contract**: this screen powers the global status-strip dot;
  each data-consuming card elsewhere links here when its envelope is stale.
- LINE-alert stage and refresh-prices script appear as auxiliary rows
  (launchd-scheduled, outside the DAG) with their own last-run status.

## Backend gaps

- Aggregation API: `GET /api/pipeline/runs?days=7` (grouped by stage) and
  `GET /api/pipeline/dag` (serialize DAILY_PIPELINE with edges + skipIf) —
  today the page would read the DB directly; the DAG shape isn't exported.
- `POST /api/pipeline/run` (full) and `/run/:stage` (single, w/ dependents)
  — submit.ts logic exposed via route handler, guarded to localhost.
- Per-stage median-duration stats for the slow-stage warning.
