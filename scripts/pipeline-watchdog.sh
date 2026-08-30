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
# ── PATHS AND LOGGING FIRST ──────────────────────────────────────────────────
# Same ordering defect the scheduler had: the isolation diagnostic was written
# to "$LOG" before $LOG existed, so the one failure that must never be silent
# produced an ambiguous redirect and disappeared.
# MODE FIRST, for the same reason as the scheduler: --dry-run must not create
# directories, the log, or the heartbeat. The status call's stderr redirection
# alone used to create logs/pipeline-watchdog.log on every dry run.
DRY_RUN=0
[ "$1" = "--dry-run" ] && DRY_RUN=1

# TEST CLOCK: REJECTED BEFORE ANY RUNTIME EVIDENCE EXISTS.
#
# This runs before `mkdir -p`, before the log file can be created or appended
# to, before any heartbeat, state marker or lock, and before submission — so a
# real invocation carrying a test clock leaves no trace suggesting it ran. The
# later `clockOverride` check on the status output stays as a second line of
# defence for an override that reaches the status CLI by another route.
#
# `echo`, not `log()`: log() would create the very file this guard exists to
# keep untouched.
if [ -n "${SCHEDULER_TEST_NOW:-}" ] && [ "$DRY_RUN" -eq 0 ]; then
  echo "[pipeline-watchdog] FATAL: SCHEDULER_TEST_NOW is set — refusing to run for real on an overridden clock" >&2
  echo "[pipeline-watchdog] Unset it, or pass --dry-run to preview against the test clock." >&2
  exit 2
fi

LOG="$ROOT/logs/pipeline-watchdog.log"
export SCHEDULER_HEARTBEAT_FILE="${SCHEDULER_HEARTBEAT_FILE:-$ROOT/data/scheduler-heartbeat.log}"

[ "$DRY_RUN" -eq 0 ] && mkdir -p "$ROOT/logs" "$ROOT/data"
LOG_PREFIX=""
log() {
  if [ "$DRY_RUN" -eq 1 ]; then
    echo "${LOG_PREFIX}[dry-run] $*" >&2
  else
    echo "${LOG_PREFIX}[$(date '+%Y-%m-%d %H:%M:%S %z')] $*" >> "$LOG"
  fi
}

ISOLATION_MODE="$(cd "$REPO" && npx tsx packages/queue/bin/check-isolation.ts 2>&1)"
if [ $? -ne 0 ]; then
  echo "$ISOLATION_MODE" >&2
  log "ISOLATION CHECK FAILED — refusing to read credentials: $ISOLATION_MODE"
  exit 2
fi
if [ "$ISOLATION_MODE" = "isolated" ]; then
  LOG_PREFIX="[TEST] "
fi

# ── INDEPENDENT LIVENESS EVIDENCE, BEFORE ASSESSING ──────────────────────────
# The watchdog is a second, independent observer of MACHINE OPPORTUNITY, and it
# writes the same canonical heartbeat file the scheduler writes. The question
# that file answers is "was this machine awake and running our jobs at this
# instant" — not "is the scheduler healthy". Conflating those is what made a
# dead scheduler indistinguishable from a sleeping laptop: with only the
# scheduler writing, a scheduler that never runs leaves no heartbeat, and that
# absence reads exactly like a machine that was switched off.
#
# Because the watchdog fires on its own interval, "machine awake, scheduler
# absent" now leaves heartbeats after the due time with no run row, which
# becomes `missing` once the grace period passes instead of `no_opportunity`
# forever.
#
# Written BEFORE assessment, so a crash during assessment still records that the
# opportunity existed. Never written under --dry-run or isolation, so tests
# cannot touch production evidence. Retention is bounded to the same 400 lines
# the scheduler keeps.
if [ "$DRY_RUN" -eq 0 ] && [ "$ISOLATION_MODE" != "isolated" ]; then
  echo "$(date -u '+%Y-%m-%dT%H:%M:%S.000Z')" >> "$SCHEDULER_HEARTBEAT_FILE"
  tail -n 400 "$SCHEDULER_HEARTBEAT_FILE" > "$SCHEDULER_HEARTBEAT_FILE.tmp" \
    && mv "$SCHEDULER_HEARTBEAT_FILE.tmp" "$SCHEDULER_HEARTBEAT_FILE"
fi

if [ "$DRY_RUN" -eq 1 ]; then
  STATUS_JSON=$(cd "$REPO" && npx tsx packages/pipeline-runs/bin/daily-run-status.ts --json 2>/dev/null)
else
  STATUS_JSON=$(cd "$REPO" && npx tsx packages/pipeline-runs/bin/daily-run-status.ts --json 2>>"$LOG")
fi
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

# Derived interpretation of the state, kept because it is useful on its own.
case "$STATE" in
  missing) HEAD="daily pipeline did not run";;
  stale)   HEAD="daily pipeline is stuck";;
  failed)  HEAD="daily pipeline failed";;
  *)       HEAD="daily pipeline needs attention";;
esac

# NO NOTIFICATION CHANNEL. LINE was retired 2026-08-28; it is not part of the
# production correctness boundary. What used to live here — a marker touched
# BEFORE the mute check (so a muted watchdog burned it permanently), an
# isolation gate, a credential load and a raw curl that never inspected its own
# HTTP result — is gone. Detection is unchanged and reads pipeline_runs.
#
# ACCEPTED LIMITATION: a pipeline failure is visible in authoritative status
# surfaces (the /admin/pipeline and /system/pipeline dashboards, and this log)
# but does NOT page the operator. Awareness is pull-based for now.
log "ALERT state=$STATE logical=$LOGICAL — $HEAD. $FULL_REASON"
