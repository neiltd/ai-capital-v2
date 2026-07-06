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

# Already ran (or is currently running) today? Only 'running' and 'success'
# count as "done" here — a day with only 'failed' rows still gets handled
# below (previously 'failed' counted as done too, so one failed 7am run
# silently killed the whole day with no retry and no notice).
if [ -f "$DB" ] && command -v sqlite3 > /dev/null 2>&1; then
  SQLITE_ERR=$(mktemp)
  COUNT=$(sqlite3 "file:$DB?mode=ro" "select count(*) from pipeline_runs
    where stage='daily-pipeline' and status in ('running','success')
    and strftime('%Y-%m-%d', started_at) = strftime('%Y-%m-%d','now','localtime');" 2>"$SQLITE_ERR")
  if [ -s "$SQLITE_ERR" ]; then
    log "sqlite3 stderr: $(cat "$SQLITE_ERR")"
  fi
  log "debug: COUNT=[$COUNT] hour=$(date +%H) db=$DB"
  rm -f "$SQLITE_ERR"
  if [ "${COUNT:-0}" -gt 0 ]; then
    exit 0
  fi

  # No running/success row today. If there's at least one 'failed' row, this
  # isn't a fresh day — daily-queue.sh already tried and exhausted retries.
  # Alert instead of silently auto-resubmitting (which risks double API/LINE
  # spend on a day that may keep failing for the same reason). Once per day.
  FAILED_COUNT=$(sqlite3 "file:$DB?mode=ro" "select count(*) from pipeline_runs
    where stage='daily-pipeline' and status='failed'
    and strftime('%Y-%m-%d', started_at) = strftime('%Y-%m-%d','now','localtime');" 2>/dev/null)
  ALERT_MARKER="$ROOT/data/daily-catchup-alerted-$(date +%Y-%m-%d)"
  if [ "${FAILED_COUNT:-0}" -gt 0 ] && [ ! -f "$ALERT_MARKER" ]; then
    touch "$ALERT_MARKER"
    log "today's daily-pipeline already failed ${FAILED_COUNT}x — sending LINE alert instead of auto-retrying"
    LINE_ENV="$ROOT/apps/scenario-simulator/.env"
    if [ -f "$LINE_ENV" ]; then
      set -a; . "$LINE_ENV"; set +a
      if [ -n "$LINE_CHANNEL_ACCESS_TOKEN" ] && [ -n "$LINE_USER_ID" ]; then
        curl -s -X POST https://api.line.me/v2/bot/message/push \
          -H "Content-Type: application/json" \
          -H "Authorization: Bearer $LINE_CHANNEL_ACCESS_TOKEN" \
          -d "$(printf '{"to":"%s","messages":[{"type":"text","text":"⚠️ AI Capital: today'"'"'s pipeline failed %s time(s), no successful run yet. Ask Claude to run it manually (daily-queue.sh) when you'"'"'re back."}]}' "$LINE_USER_ID" "$FAILED_COUNT")" \
          >> "$LOG" 2>&1
      else
        log "LINE_CHANNEL_ACCESS_TOKEN/LINE_USER_ID not set — cannot alert"
      fi
    fi
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
