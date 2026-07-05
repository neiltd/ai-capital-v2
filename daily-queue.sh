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

# Close zombie pipeline_runs rows. Anything still 'running' after 12h is the
# residue of a worker that died (macOS killed it, network outage, sleep, etc.)
# and never got a chance to call recordEnd. Leaving them open means the
# dashboard shows fake-running pipelines indefinitely.
RUNS_DB="${PIPELINE_RUNS_DB:-$ROOT/data/pipeline-runs.db}"
if [ -f "$RUNS_DB" ] && command -v sqlite3 > /dev/null 2>&1; then
  ZOMBIE_COUNT=$(sqlite3 "$RUNS_DB" "select count(*) from pipeline_runs where status='running' and started_at < datetime('now','-12 hours');" 2>/dev/null || echo 0)
  if [ "${ZOMBIE_COUNT:-0}" -gt 0 ]; then
    sqlite3 "$RUNS_DB" "update pipeline_runs
        set status='failed',
            ended_at=datetime('now'),
            error_message=COALESCE(error_message, 'orphaned >12h — worker died without recordEnd'),
            duration_ms=cast((julianday('now')-julianday(started_at))*86400000 as integer)
      where status='running' and started_at < datetime('now','-12 hours');" 2>/dev/null
    log "closed $ZOMBIE_COUNT zombie pipeline_runs row(s) (>12h running)"
  fi
fi

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
npx tsx "$ROOT/packages/queue/bin/run-daily.ts" 2>&1 | tee -a "$LOG"
EXIT=${PIPESTATUS[0]}

# Trim old logs (>30 days).
find "$ROOT/logs" -name "daily-queue-*.log" -mtime +30 -delete 2>/dev/null

log "=============================="
log " done — exit=$EXIT"
log "=============================="

exit "$EXIT"
