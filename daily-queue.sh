#!/bin/bash
# Phase 3.4 replacement for daily.sh.
#
# Submits the daily pipeline to BullMQ and blocks until the flow completes.
#
# IT STARTS NO WORKER. Slice S4D removed the inline nohup fallback: that worker
# inherited THIS process's environment, which was the only reason a scheduled
# job needed a PostgreSQL credential at all. This script requires a worker that
# is already running, holds no database credential itself, and refuses to submit
# when none is live.
#
# THE SCHEDULING AUTHORITY IS launchd, AND ONLY launchd. This header used to
# carry a ready-to-paste cron line — pointing at a path the repository has not
# lived at since it moved out of iCloud, and at a stale logs directory. Adding
# it would create a SECOND scheduler alongside com.thanapol.ai-capital.daily:
# two independent triggers submitting the same logical date, neither aware of
# the other. The example is removed rather than corrected; the supported trigger
# is the launchd agent whose template lives in ops/launchd/.

set -o pipefail
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"

ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT" || exit 2

mkdir -p "$ROOT/logs" "$ROOT/data"
LOG="$ROOT/logs/daily-queue-$(date +%F).log"

log() { echo "[$(date '+%H:%M:%S')] $*" | tee -a "$LOG"; }

log "=============================="
log " Daily pipeline (queue) — $(date '+%Y-%m-%d %H:%M')"
log "=============================="

# RECONCILIATION IS NOT DONE HERE.
#
# This script used to close every pipeline_runs row left 'running' for >12h with
# a single stage-unfiltered UPDATE. That was age-only: it consulted no queue
# state, so it could not tell a job still retrying from one that had genuinely
# died, and it closed rows belonging to ANY stage — including the independently
# scheduled structured-ingestion parents, whose lane it knows nothing about.
# It also wrote its own reason string and duration_ms, making a row it closed
# indistinguishable from a genuine reconciliation and silently overwriting the
# lane-aware result.
#
# There is now exactly one reconciliation authority:
#   packages/queue/src/reconcile.ts  (per-lane snapshots, per-lane policy)
#   packages/queue/bin/reconcile.ts  (dry-run by default)
#
# Applying a transition is an explicit operator action and is deliberately NOT
# an automatic scheduler step:
#   npx tsx packages/queue/bin/reconcile.ts            # dry run, read-only
#   npx tsx packages/queue/bin/reconcile.ts --apply    # authorized mutation

# Require a LIVE worker belonging to the ONE declared authority: the
# launchd-managed agent com.thanapol.ai-capital.worker, which auto-restarts on
# crash and survives sleep/wake via caffeinate.
#
# A HAND-STARTED WORKER NO LONGER AUTHORIZES A SCHEDULED SUBMISSION. Discovering
# one meant scanning every process on the machine for this path, which is a
# search for a string rather than for an authority — and packages/queue/src/
# submit.ts already records the same principle from the other direction: a
# manual run must never silently become the scheduled run. An operator who wants
# the scheduled run to proceed restores or kickstarts the agent. Ad-hoc work is
# unaffected: `pnpm --filter @common/queue submit` still runs against whatever
# worker the operator has up.
#
# REGISTRATION IS NOT LIVENESS, AND MENTIONING IS NOT RUNNING. This block used
# to accept a successful `launchctl list <label>` as proof. That command
# succeeds for a job that is merely LOADED — one crashed and waiting out its
# ThrottleInterval, one that exited non-zero, one that has never run — and such
# a job has no "PID" key at all. A later version required only that the target
# appear somewhere in the command line, which accepted `npx vitest run
# <target>`: a test runner READING the worker file counted as a worker running.
# scripts/lib/worker-liveness.sh now parses the command structurally and
# requires the target to be the entry point the runtime actually executes, and
# to be the final argument, since this worker takes no arguments of its own.
#
# THE AUTOMATIC FALLBACK WAS REMOVED IN SLICE S4D, DELIBERATELY.
# This block used to spawn a worker inline with nohup when neither was found.
# That inline worker inherited THIS process's environment, which made the
# scheduler the only reason the daily job would need a PostgreSQL credential at
# all — a scheduled process holding a production write credential purely to hand
# it onward. Removing the fallback lets the scheduler hold none.
#
# The reliability cost is smaller than it looks: the launchd agent has KeepAlive,
# so it restarts itself on crash. The fallback only ever fired when the agent was
# UNLOADED, which is an operator state change, not a failure mode. Failing loudly
# and same-day is better than a worker silently started from whatever environment
# the scheduler happened to have.
#
# Fail closed: do NOT submit the flow after reporting a missing worker. No
# database credential is read, required or inspected anywhere in this script.
WORKER_TARGET="$ROOT/packages/queue/bin/worker.ts"
LAUNCHD_LABEL="com.thanapol.ai-capital.worker"

# shellcheck source=scripts/lib/worker-liveness.sh
. "$ROOT/scripts/lib/worker-liveness.sh"

if WORKER_FOUND="$(find_live_worker "$WORKER_TARGET" "$LAUNCHD_LABEL")"; then
  log "worker live (${WORKER_FOUND%%:*}) — pid=${WORKER_FOUND##*:}"
else
  log "FATAL: no live $LAUNCHD_LABEL worker, and this scheduler starts none."
  log "  A registered launchd job is NOT sufficient: the label must have a live"
  log "  PID whose runtime is actually EXECUTING $WORKER_TARGET"
  log "  (a process that merely names it as an argument does not count)."
  log "  The daily flow was NOT submitted; nothing was enqueued."
  log "  Restore the agent, then re-run:"
  log "    launchctl kickstart -k gui/\$(id -u)/$LAUNCHD_LABEL"
  log "  or load it if it is not installed."
  exit 3
fi

# Submit + wait. Exit code mirrors the pipeline outcome (0 success, 1 failed).
log "submitting daily pipeline…"
# ── Business logical date, supplied by the scheduler ─────────────────────────
# Passed straight through to run-daily.ts and never recomputed. The scheduler
# decides eligibility for a specific business date; recomputing downstream let a
# submission crossing Los Angeles midnight claim the following day.
#
# Absent (direct/manual invocation), run-daily.ts keeps its previous default.
LOGICAL_DATE_ARGS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --logical-date)
      if [ -z "${2:-}" ] || case "${2:-}" in --*) true;; *) false;; esac; then
        log "FATAL: --logical-date requires a YYYY-MM-DD value"
        exit 2
      fi
      case "$2" in
        [0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]) ;;
        *) log "FATAL: --logical-date must be YYYY-MM-DD, got '$2'"; exit 2 ;;
      esac
      LOGICAL_DATE_ARGS=(--logical-date "$2")
      shift 2
      ;;
    *) log "ignoring unrecognised argument: $1"; shift ;;
  esac
done

npx tsx "$ROOT/packages/queue/bin/run-daily.ts" "${LOGICAL_DATE_ARGS[@]}" 2>&1 | tee -a "$LOG"
EXIT=${PIPESTATUS[0]}

# Trim old logs (>30 days).
find "$ROOT/logs" -name "daily-queue-*.log" -mtime +30 -delete 2>/dev/null

log "=============================="
log " done — exit=$EXIT"
log "=============================="

exit "$EXIT"
