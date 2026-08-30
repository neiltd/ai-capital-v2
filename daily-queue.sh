#!/bin/bash
# Phase 3.4 replacement for daily.sh.
#
# Submits the daily pipeline to BullMQ and blocks until the flow completes.
# Spawns the worker if it isn't already running (via pgrep on the script name).
#
# Cron line (replaces the daily.sh entry):
#   0 7 * * 1-5 /Users/thanapold/Desktop/Projects/daily-queue.sh >> /Users/thanapold/Desktop/Projects/logs/cron.log 2>&1

set -o pipefail
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"

ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT" || exit 2

mkdir -p "$ROOT/logs" "$ROOT/data"
LOG="$ROOT/logs/daily-queue-$(date +%F).log"
WORKER_LOG="$ROOT/logs/queue-worker.log"

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

# Ensure a worker is running. Preferred: launchd-managed agent
# (com.thanapol.ai-capital.worker) which auto-restarts on crash and survives
# sleep/wake via caffeinate. Fallback: spawn one inline via nohup.
WORKER_TARGET="$ROOT/packages/queue/bin/worker.ts"
LAUNCHD_LABEL="com.thanapol.ai-capital.worker"
if launchctl list "$LAUNCHD_LABEL" > /dev/null 2>&1; then
  log "worker managed by launchd ($LAUNCHD_LABEL) — pid=$(launchctl list "$LAUNCHD_LABEL" | awk '/"PID"/{gsub(/[",;]/,"",$3); print $3}')"
elif pgrep -f "$WORKER_TARGET" > /dev/null 2>&1; then
  log "worker already running (manual) — pid=$(pgrep -f "$WORKER_TARGET" | tr '\n' ' ')"
else
  log "starting worker → $WORKER_LOG (fallback; consider loading launchd plist)"
  nohup caffeinate -i npx tsx "$WORKER_TARGET" > "$WORKER_LOG" 2>&1 &
  disown
  sleep 3
  if ! pgrep -f "$WORKER_TARGET" > /dev/null 2>&1; then
    log "FATAL: worker failed to start — see $WORKER_LOG"
    exit 2
  fi
  log "worker started — pid=$(pgrep -f "$WORKER_TARGET" | tr '\n' ' ')"
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
