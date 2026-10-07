#!/bin/bash
# Wake/login catch-up guard for the daily pipeline.
#
# NOT CURRENTLY WIRED TO A LAUNCHD SOURCE. Its installation source, the tracked
# daily-catchup.plist, was deleted in slice S4D: it declared the label
# com.thanapol.ai-capital.daily — the same label as the supported scheduler
# template — and carried copy-into-LaunchAgents instructions that would have
# overwritten the supported agent. The supported source for that label is now
# ops/launchd/com.thanapol.ai-capital.daily.plist.template, which runs
# scripts/daily-scheduler.sh.
#
# This script is retained because removing it is a separate dead-code decision,
# not part of the credential boundary. It remains safe to run by hand: launchd
# runs missed StartCalendarInterval jobs once on wake, which covers "Mac was
# asleep at the due time", and RunAtLoad covers "Mac was fully powered off at
# the due time, booted later" — the behaviours the scheduler template now
# provides.
#
# NOTHING INSTALLED OR SCHEDULED REACHES THIS FILE (verified 2026-10-07): no
# tracked launchd template targets it (ops/launchd/*.template all name
# run-alerts.sh, daily-scheduler.sh, pipeline-watchdog.sh or a queue bin), and
# neither daily-scheduler.sh nor pipeline-watchdog.sh invokes it — their only
# mentions of it are comments. It is a hand-run tool.
#
# Idempotent: safe to fire multiple times the same day, and safe to fire before
# the due time or on a day the daily run does not happen (exits without doing
# anything). It does not own either rule — see the gate below.

set -o pipefail
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"

# ROOT IS DERIVED FROM THIS SCRIPT'S OWN LOCATION.
#
# It used to be the literal /Users/thanapold/Desktop/Projects.nosync, which
# pinned the runtime to one directory and blocked the relocation out of ~/Desktop
# that macOS TCC forces (launchd cannot execute scripts there: the daily,
# watchdog and alerts agents have been failing with "Operation not permitted").
#
# BASH_SOURCE[0], not $0 and not cwd: $0 is the interpreter's view and differs
# when the file is sourced, while cwd is whatever launchd or an operator happened
# to leave behind. The script's own path is the one thing that always describes
# the checkout it belongs to.
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG="$ROOT/logs/daily-catchup.log"
LOCK="$ROOT/data/daily-catchup.lock"

mkdir -p "$ROOT/logs" "$ROOT/data"
log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >> "$LOG"; }

# ── ELIGIBILITY COMES FROM ONE PLACE ────────────────────────────────────────
#
# This gate used to be `[ "$(date +%H)" -lt 7 ]`, with the double-fire and
# already-failed rules re-implemented below in SQL filtered by
# `strftime('%Y-%m-%d','now','localtime')`. Three defects in that shape:
#
#   1. A SECOND COPY OF THE DUE TIME. The hour 7 was hard-coded here while the
#      real due time lives in DUE_TIME (packages/pipeline-runs/src/
#      daily-run-state.ts). The due time is now 04:30, so the copy was wrong,
#      and any future change would have to be made twice.
#   2. THE HOST'S CLOCK, NOT THE BUSINESS ZONE. `date +%H` and SQLite
#      'localtime' both read wherever the laptop happens to be. The business
#      zone is America/Los_Angeles by definition (BUSINESS_TIMEZONE), so in
#      Asia/Bangkok this gate opened and closed on the wrong day entirely.
#   3. NO RUN-DAY RULE AT ALL. The daily run happens on NYSE trading days and
#      on every Sunday — not on Saturdays, and not on a weekday that is an NYSE
#      full-day holiday. This script had no notion of that and would have
#      submitted a pipeline on Thanksgiving.
#
# The verdict now comes from the SAME read-only evaluator the scheduler and the
# watchdog consult, so the three can never disagree: daily-run-status.ts owns
# DUE_TIME, isDailyRunDay and the run-row states. `eligibleToRun` is false
# before 04:30 business time, on a non-run day, and whenever a run already
# exists for the day — which is also the double-fire guard, from recorded state
# rather than a second query.
#
# FAIL CLOSED. If the state cannot be evaluated this exits WITHOUT submitting.
# A catch-up that cannot tell what day it is must not spend API budget guessing.
STATUS_JSON=$(cd "$ROOT" && npx tsx packages/pipeline-runs/bin/daily-run-status.ts --json 2>>"$LOG")
if [ -z "$STATUS_JSON" ]; then
  log "ERROR: could not evaluate daily run state — refusing to submit blind"
  exit 1
fi
STATE=$(echo "$STATUS_JSON"    | python3 -c 'import json,sys;print(json.load(sys.stdin)["state"])')
ELIGIBLE=$(echo "$STATUS_JSON" | python3 -c 'import json,sys;print(json.load(sys.stdin)["eligibleToRun"])')
LOGICAL=$(echo "$STATUS_JSON"  | python3 -c 'import json,sys;print(json.load(sys.stdin)["logicalDate"])')
REASON=$(echo "$STATUS_JSON"   | python3 -c 'import json,sys;print(json.load(sys.stdin)["reason"])')

# A TEST CLOCK MUST NEVER CAUSE A REAL SUBMISSION, the same refusal the
# scheduler and the watchdog carry. Without it, SCHEDULER_TEST_NOW in the
# environment would file a live run under a fabricated date.
CLOCK_OVERRIDE=$(echo "$STATUS_JSON" | python3 -c 'import json,sys;print(json.load(sys.stdin).get("clockOverride", False))')
if [ "$CLOCK_OVERRIDE" = "True" ] || [ "$CLOCK_OVERRIDE" = "true" ]; then
  log "FATAL: SCHEDULER_TEST_NOW is set — refusing to submit on an overridden clock"
  exit 2
fi

if [ "$ELIGIBLE" != "True" ] && [ "$ELIGIBLE" != "true" ]; then
  # Covers every reason not to act: not_due, not_trading_day, success, running,
  # failed, timeout, killed, unknown. Each carries its own reason text.
  log "state=$STATE logical=$LOGICAL — not eligible: $REASON"
  exit 0
fi

# Concurrency guard: two hand-runs, or a wake and a RunAtLoad fire in the same
# minute, could race before the first enqueue produces a run row for the status
# evaluator above to see.
mkdir "$LOCK" 2>/dev/null || exit 0
trap 'rmdir "$LOCK"' EXIT

log "state=$STATE logical=$LOGICAL — eligible, triggering catch-up run"
"$ROOT/daily-queue.sh" >> "$LOG" 2>&1
log "catch-up run finished, exit=$?"
