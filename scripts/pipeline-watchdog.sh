#!/bin/bash
# Daily pipeline watchdog.
#
# LIVES OUTSIDE THE PIPELINE, ON PURPOSE. The previous detector for "today's run
# is missing" was inside daily-catchup.sh — the very job that has to run in order
# to notice. A missing pipeline cannot report its own absence, and on 2026-08-27
# it didn't: no run, no alert, no signal of any kind.
#
# It also alerted only when a FAILED row existed, so a day with zero rows
# produced zero alerts. Absence was strictly quieter than failure, which is
# backwards.
#
# This process starts, evaluates, alerts and exits. It shares no code path with
# the pipeline and does not depend on the pipeline having run.
#
#   --dry-run   evaluate and print; never send

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

# ── ISOLATION MODE, DECIDED BEFORE ANYTHING ELSE ─────────────────────────────
# Partial isolation is forbidden. Running with an isolated filesystem but
# production credentials is how a "[TEST]" watchdog sent a real LINE push: the
# mute file was looked for under the isolated root, was not there, and the real
# token loaded from the real repo. A label is not a safety mechanism.
#
# This exits non-zero BEFORE any credential is read or any submitter invoked.
ISOLATION_MODE="$(cd "$REPO" && npx tsx packages/queue/bin/check-isolation.ts 2>&1)"
if [ $? -ne 0 ]; then
  echo "$ISOLATION_MODE" >&2
  echo "$ISOLATION_MODE" >> "$LOG" 2>/dev/null
  exit 2
fi
if [ "$ISOLATION_MODE" = "isolated" ]; then
  LOG_PREFIX="[TEST] "
else
  LOG_PREFIX=""
fi
LOG="$ROOT/logs/pipeline-watchdog.log"
export SCHEDULER_HEARTBEAT_FILE="${SCHEDULER_HEARTBEAT_FILE:-$ROOT/data/scheduler-heartbeat.log}"

DRY_RUN=0
[ "$1" = "--dry-run" ] && DRY_RUN=1

mkdir -p "$ROOT/logs" "$ROOT/data"
log() { echo "${LOG_PREFIX}[$(date '+%Y-%m-%d %H:%M:%S %z')] $*" >> "$LOG"; }

STATUS_JSON=$(cd "$REPO" && npx tsx packages/pipeline-runs/bin/daily-run-status.ts --json 2>>"$LOG")
if [ -z "$STATUS_JSON" ]; then
  log "ERROR: could not evaluate daily run state"
  exit 1
fi

read -r STATE ALERT LOGICAL REASON <<< "$(echo "$STATUS_JSON" | python3 -c '
import json,sys
a = json.load(sys.stdin)
print(a["state"], a["shouldAlert"], a["logicalDate"], a["reason"].replace("\n"," "))')"
FULL_REASON=$(echo "$STATUS_JSON" | python3 -c 'import json,sys;print(json.load(sys.stdin)["reason"])')

if [ "$DRY_RUN" -eq 1 ]; then
  echo "state=$STATE alert=$ALERT logical=$LOGICAL"
  echo "reason: $FULL_REASON"
  exit 0
fi

if [ "$ALERT" != "True" ] && [ "$ALERT" != "true" ]; then
  LAST="$ROOT/data/.watchdog-last-state"
  if [ "$(cat "$LAST" 2>/dev/null)" != "$LOGICAL:$STATE" ]; then
    log "state=$STATE logical=$LOGICAL — healthy, no alert"
    echo "$LOGICAL:$STATE" > "$LAST"
  fi
  exit 0
fi

# One alert per logical date PER STATE. A state change (missing -> stale, or
# missing -> failed) is new information and should be told; the same state at
# every poll is not.
MARKER="$ROOT/data/.watchdog-alerted-$LOGICAL-$STATE"
if [ -f "$MARKER" ]; then exit 0; fi
touch "$MARKER"

log "ALERT state=$STATE logical=$LOGICAL — $FULL_REASON"

# ── NOTIFICATION POLICY — ONE CANONICAL SOURCE ───────────────────────────────
# Isolated mode can never deliver, regardless of any mute file. This ordering is
# the fix for the defect Warden found: the mute used to be read from $ROOT while
# credentials came from $REPO, so isolating the filesystem DISARMED the kill
# switch and a test run sent a real message.
if [ "$ISOLATION_MODE" = "isolated" ]; then
  log "isolated environment — real LINE delivery is structurally impossible; not loading credentials"
  exit 0
fi

# The mute file is authoritative at the PRODUCTION repo, never at $ROOT. An
# isolated root must not be able to make it disappear.
if [ -f "$REPO/data/line-notifications-muted" ]; then
  log "LINE alert suppressed (line-notifications-muted)"
  exit 0
fi

case "$STATE" in
  missing) ICON="🔴"; HEAD="daily pipeline did not run";;
  stale)   ICON="🟠"; HEAD="daily pipeline is stuck";;
  failed)  ICON="🔴"; HEAD="daily pipeline failed";;
  *)       ICON="⚠️";  HEAD="daily pipeline needs attention";;
esac

LINE_ENV="$REPO/apps/scenario-simulator/.env"
if [ -f "$LINE_ENV" ]; then
  set -a; . "$LINE_ENV"; set +a
  if [ -n "$LINE_CHANNEL_ACCESS_TOKEN" ] && [ -n "$LINE_USER_ID" ]; then
    MSG="$ICON AI Capital: $HEAD ($LOGICAL, state=$STATE). $FULL_REASON"
    curl -s -X POST https://api.line.me/v2/bot/message/push \
      -H "Content-Type: application/json" \
      -H "Authorization: Bearer $LINE_CHANNEL_ACCESS_TOKEN" \
      -d "$(python3 -c "
import json,sys
print(json.dumps({'to': sys.argv[1], 'messages':[{'type':'text','text': sys.argv[2][:900]}]}))
" "$LINE_USER_ID" "$MSG")" >> "$LOG" 2>&1
    log "LINE alert sent"
  else
    log "LINE credentials not set — cannot alert"
  fi
fi
