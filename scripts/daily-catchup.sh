#!/bin/bash
# Wake/login catch-up guard for the daily pipeline.
#
# Fired by com.thanapol.ai-capital.daily.plist (StartCalendarInterval + RunAtLoad).
# launchd runs missed StartCalendarInterval jobs once on wake, which covers
# "Mac was asleep at 7am" — RunAtLoad additionally covers "Mac was fully
# powered off/logged out at 7am, booted later", which StartCalendarInterval
# alone does not catch up on.
#
# Idempotent: safe to fire multiple times same day (double-fire guard below),
# and safe to fire before 7am (exits without doing anything).

set -o pipefail
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"

ROOT="/Users/thanapold/Desktop/Projects.nosync"
DB="${PIPELINE_RUNS_DB:-$ROOT/data/pipeline-runs.db}"
LOG="$ROOT/logs/daily-catchup.log"
LOCK="$ROOT/data/daily-catchup.lock"

mkdir -p "$ROOT/logs" "$ROOT/data"
log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >> "$LOG"; }

# Before 7am local: not due yet — the calendar trigger will fire at 7:00 and
# this same script runs then too, so nothing to do here.
if [ "$(date +%H)" -lt 7 ]; then
  exit 0
fi

# Already ran (or is currently running) today?
if [ -f "$DB" ] && command -v sqlite3 > /dev/null 2>&1; then
  COUNT=$(sqlite3 "file:$DB?mode=ro" "select count(*) from pipeline_runs
    where stage='daily-pipeline' and status in ('running','success','failed')
    and strftime('%Y-%m-%d', started_at) = strftime('%Y-%m-%d','now','localtime');" 2>/dev/null)
  if [ "${COUNT:-0}" -gt 0 ]; then
    exit 0
  fi
fi

# Concurrency guard: the 7:00 calendar fire and a same-minute wake/RunAtLoad
# fire could race before the first enqueue produces a DB row.
mkdir "$LOCK" 2>/dev/null || exit 0
trap 'rmdir "$LOCK"' EXIT

log "no daily-pipeline row for today — triggering catch-up run"
"$ROOT/daily-queue.sh" >> "$LOG" 2>&1
log "catch-up run finished, exit=$?"
