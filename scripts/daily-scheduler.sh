#!/bin/bash
# Daily pipeline scheduler — execution-opportunity model.
#
# REPLACES the 07:00-only trigger in daily-catchup.sh (kept for rollback).
#
# WHY. From 2026-07-06 to 2026-08-22 the 07:00 StartCalendarInterval fired on
# time every day. From 2026-08-23 it fired at ~21:00 on four days and not at all
# on 2026-08-27: launchd defers a missed calendar fire to "the next wake", and
# that deferral is not dependable. Binding the pipeline to ONE calendar instant
# makes it depend on the machine being awake at that instant.
#
# THE CONTRACT NOW:
#   - launchd supplies frequent execution OPPORTUNITIES (StartInterval).
#   - This script decides ELIGIBILITY from recorded state, every time.
#   - Correctness does not depend on launchd catching anything up.
#
# One logical run per logical date. Waking, reloading or firing again cannot
# duplicate a day that already succeeded.
#
#   --dry-run   evaluate and report; never submit

set -o pipefail
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"

# ── FILESYSTEM ISOLATION ─────────────────────────────────────────────────────
# AI_CAPITAL_ROOT is the filesystem destination, and it is a SEPARATE isolation
# dimension from the database and Redis. A test that isolates PIPELINE_RUNS_DB
# but not this writes real-looking output into production log paths — on
# 2026-08-27 the case harness wrote a FAKE "state=success logical=2026-08-27"
# into logs/daily-scheduler.log while its database was correctly isolated, and
# that line then misled an auditor into suspecting a wrong-database production
# run. A harness that isolates two of three dimensions is more dangerous than
# one that isolates none, because its output looks genuine.
# REPO = where the CODE lives, derived from this script's own location so it is
# correct in a clone or a worktree. ROOT = where OUTPUT goes. Conflating them is
# what made filesystem isolation impossible: a test could not redirect logs
# without also breaking module resolution.
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ROOT="${AI_CAPITAL_ROOT:-$REPO}"

# Anything written under a non-default root is test output and says so, so it
# can never be mistaken for production evidence even if isolation is imperfect.
LOG_PREFIX=""
if [ "$ROOT" != "$REPO" ]; then
  LOG_PREFIX="[TEST] "
fi
LOG="$ROOT/logs/daily-scheduler.log"
LOCK="$ROOT/data/daily-scheduler.lock"
export SCHEDULER_HEARTBEAT_FILE="${SCHEDULER_HEARTBEAT_FILE:-$ROOT/data/scheduler-heartbeat.log}"

DRY_RUN=0
[ "$1" = "--dry-run" ] && DRY_RUN=1

mkdir -p "$ROOT/logs" "$ROOT/data"
log() { echo "${LOG_PREFIX}[$(date '+%Y-%m-%d %H:%M:%S %z')] $*" >> "$LOG"; }

# ── Heartbeat FIRST, before any other decision ───────────────────────────────
# This is the record that the machine was awake and the scheduler ran. It must
# be written even when this fire does nothing, because "awake and idle" is
# precisely what distinguishes a dead scheduler from a sleeping laptop. Writing
# it later, or only on the paths that act, would make the watchdog blind in
# exactly the case it exists for.
if [ "$DRY_RUN" -eq 0 ]; then
  echo "$(date -u '+%Y-%m-%dT%H:%M:%S.000Z')" >> "$SCHEDULER_HEARTBEAT_FILE"
  tail -n 400 "$SCHEDULER_HEARTBEAT_FILE" > "$SCHEDULER_HEARTBEAT_FILE.tmp" \
    && mv "$SCHEDULER_HEARTBEAT_FILE.tmp" "$SCHEDULER_HEARTBEAT_FILE"
fi

STATUS_JSON=$(cd "$REPO" && npx tsx packages/pipeline-runs/bin/daily-run-status.ts --json 2>>"$LOG")
if [ -z "$STATUS_JSON" ]; then
  log "ERROR: could not evaluate daily run state — refusing to act blind"
  exit 1
fi

STATE=$(echo "$STATUS_JSON"     | python3 -c 'import json,sys;print(json.load(sys.stdin)["state"])')
ELIGIBLE=$(echo "$STATUS_JSON"  | python3 -c 'import json,sys;print(json.load(sys.stdin)["eligibleToRun"])')
LOGICAL=$(echo "$STATUS_JSON"   | python3 -c 'import json,sys;print(json.load(sys.stdin)["logicalDate"])')
REASON=$(echo "$STATUS_JSON"    | python3 -c 'import json,sys;print(json.load(sys.stdin)["reason"])')

if [ "$ELIGIBLE" != "True" ] && [ "$ELIGIBLE" != "true" ]; then
  # Only log state CHANGES; a 15-minute poll that logs every no-op buries the
  # one line that matters.
  LAST_STATE_FILE="$ROOT/data/.scheduler-last-state"
  if [ "$(cat "$LAST_STATE_FILE" 2>/dev/null)" != "$LOGICAL:$STATE" ]; then
    log "state=$STATE logical=$LOGICAL — not eligible: $REASON"
    echo "$LOGICAL:$STATE" > "$LAST_STATE_FILE"
  fi
  exit 0
fi

if [ "$DRY_RUN" -eq 1 ]; then
  log "DRY RUN: would submit daily pipeline for $LOGICAL (state=$STATE)"
  echo "DRY RUN: would submit daily pipeline for $LOGICAL (state=$STATE)"
  echo "reason: $REASON"
  exit 0
fi

# Concurrency guard: two opportunities could overlap before the first enqueue
# produces a pipeline_runs row.
mkdir "$LOCK" 2>/dev/null || { log "another scheduler fire holds the lock — skipping"; exit 0; }
trap 'rmdir "$LOCK" 2>/dev/null' EXIT

# Re-check under the lock. The window between evaluating and acquiring is small
# but real, and a duplicate daily run costs real API spend.
RECHECK=$(cd "$REPO" && npx tsx packages/pipeline-runs/bin/daily-run-status.ts --json 2>/dev/null \
  | python3 -c 'import json,sys;print(json.load(sys.stdin)["eligibleToRun"])' 2>/dev/null)
if [ "$RECHECK" != "True" ] && [ "$RECHECK" != "true" ]; then
  log "no longer eligible after acquiring lock — another fire started it"
  exit 0
fi

log "state=$STATE logical=$LOGICAL — submitting: $REASON"
"$REPO/daily-queue.sh" >> "$LOG" 2>&1
log "submission finished, exit=$?"
