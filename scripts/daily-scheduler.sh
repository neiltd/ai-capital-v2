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

# ── ISOLATION MODE, DECIDED BEFORE ANYTHING ELSE ─────────────────────────────
# Partial isolation is forbidden. Running with an isolated filesystem but
# production credentials is how a "[TEST]" watchdog sent a real LINE push: the
# mute file was looked for under the isolated root, was not there, and the real
# token loaded from the real repo. A label is not a safety mechanism.
#
# This exits non-zero BEFORE any credential is read or any submitter invoked.
# ── PATHS AND LOGGING FIRST ──────────────────────────────────────────────────
# These must exist before ANY branch that might report a failure. The isolation
# check below used to run first and write its diagnostic to "$LOG" while $LOG
# was still unset, so an isolation failure — the one failure that must never be
# silent — produced an ambiguous redirect and vanished.
# MODE IS DECIDED BEFORE ANY FILESYSTEM EFFECT.
# --dry-run must leave the filesystem byte-for-byte unchanged: no directories,
# no log, no marker, no heartbeat, no lock. Previously the ineligible branch ran
# before the dry-run branch and wrote both the log and .scheduler-last-state,
# and `mkdir -p` created the output directories on every invocation — so the
# safe-inspection mode mutated the workspace it was meant to observe.
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
  echo "[daily-scheduler] FATAL: SCHEDULER_TEST_NOW is set — refusing to run for real on an overridden clock" >&2
  echo "[daily-scheduler] Unset it, or pass --dry-run to preview against the test clock." >&2
  exit 2
fi

LOG="$ROOT/logs/daily-scheduler.log"
LOCK="$ROOT/data/daily-scheduler.lock"
export SCHEDULER_HEARTBEAT_FILE="${SCHEDULER_HEARTBEAT_FILE:-$ROOT/data/scheduler-heartbeat.log}"

[ "$DRY_RUN" -eq 0 ] && mkdir -p "$ROOT/logs" "$ROOT/data"
LOG_PREFIX=""
# In dry-run the diagnostic goes to stderr instead of the log file, so the
# operator still sees everything and nothing is written.
log() {
  if [ "$DRY_RUN" -eq 1 ]; then
    echo "${LOG_PREFIX}[dry-run] $*" >&2
  else
    echo "${LOG_PREFIX}[$(date '+%Y-%m-%d %H:%M:%S %z')] $*" >> "$LOG"
  fi
}

# ── ISOLATION MODE, BEFORE ANY CREDENTIAL IS READ ────────────────────────────
ISOLATION_MODE="$(cd "$REPO" && npx tsx packages/queue/bin/check-isolation.ts 2>&1)"
if [ $? -ne 0 ]; then
  echo "$ISOLATION_MODE" >&2
  log "ISOLATION CHECK FAILED — refusing to read credentials or submit: $ISOLATION_MODE"
  exit 2
fi
if [ "$ISOLATION_MODE" = "isolated" ]; then
  LOG_PREFIX="[TEST] "
fi

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

if [ "$DRY_RUN" -eq 1 ]; then
  STATUS_JSON=$(cd "$REPO" && npx tsx packages/pipeline-runs/bin/daily-run-status.ts --json 2>/dev/null)
else
  STATUS_JSON=$(cd "$REPO" && npx tsx packages/pipeline-runs/bin/daily-run-status.ts --json 2>>"$LOG")
fi
if [ -z "$STATUS_JSON" ]; then
  log "ERROR: could not evaluate daily run state — refusing to act blind"
  exit 1
fi

STATE=$(echo "$STATUS_JSON"     | python3 -c 'import json,sys;print(json.load(sys.stdin)["state"])')
ELIGIBLE=$(echo "$STATUS_JSON"  | python3 -c 'import json,sys;print(json.load(sys.stdin)["eligibleToRun"])')
LOGICAL=$(echo "$STATUS_JSON"   | python3 -c 'import json,sys;print(json.load(sys.stdin)["logicalDate"])')
REASON=$(echo "$STATUS_JSON"    | python3 -c 'import json,sys;print(json.load(sys.stdin)["reason"])')
CLOCK_OVERRIDE=$(echo "$STATUS_JSON" | python3 -c 'import json,sys;print(json.load(sys.stdin).get("clockOverride", False))')

# A test clock must never be able to cause a real submission. The status CLI
# reports when its verdict came from SCHEDULER_TEST_NOW; acting on that verdict
# for real would file a live run under a fabricated date.
if [ "$CLOCK_OVERRIDE" = "True" ] || [ "$CLOCK_OVERRIDE" = "true" ]; then
  if [ "$DRY_RUN" -eq 0 ]; then
    log "FATAL: SCHEDULER_TEST_NOW is set — refusing to submit on an overridden clock"
    exit 2
  fi
  log "clock overridden by SCHEDULER_TEST_NOW — dry-run only"
fi

if [ "$ELIGIBLE" != "True" ] && [ "$ELIGIBLE" != "true" ]; then
  # Only log state CHANGES; a 15-minute poll that logs every no-op buries the
  # one line that matters.
  LAST_STATE_FILE="$ROOT/data/.scheduler-last-state"
  if [ "$(cat "$LAST_STATE_FILE" 2>/dev/null)" != "$LOGICAL:$STATE" ]; then
    log "state=$STATE logical=$LOGICAL — not eligible: $REASON"
    # The marker is state; dry-run must not create or advance it.
    [ "$DRY_RUN" -eq 0 ] && echo "$LOGICAL:$STATE" > "$LAST_STATE_FILE"
  fi
  exit 0
fi

if [ "$DRY_RUN" -eq 1 ]; then
  log "DRY RUN: would submit daily pipeline for $LOGICAL (state=$STATE)"
  echo "DRY RUN: would submit daily pipeline for $LOGICAL (state=$STATE)"
  echo "reason: $REASON"
  exit 0
fi

# ── Concurrency guard, recoverable ───────────────────────────────────────────
# Two opportunities could overlap before the first enqueue produces a
# pipeline_runs row, so the lock is still required.
#
# It must also be RECOVERABLE. The previous version was `mkdir` plus a
# `trap rmdir EXIT`: correct while the process exits normally, and permanently
# wedging otherwise. A SIGKILL, a panic, or power loss leaves the directory
# behind, and with a 15-minute StartInterval every later opportunity then skips
# forever — the pipeline silently stops with no failure anywhere.
#
# Recovery is deliberately conservative:
#   - acquisition stays atomic (mkdir succeeds for exactly one caller);
#   - a LIVE owner is never displaced (ps -p; `kill -0` was wrong here — it
#     fails with EPERM for a process owned by another user, so a live owner
#     would have been read as dead and its lock stolen);
#   - a lock is only broken when its owner is gone AND it is older than
#     LOCK_STALE_AFTER_S, so a fire that has created the directory but not yet
#     written its pid cannot be robbed;
#   - every recovery is logged, because a silently broken lock would hide the
#     crash that produced it.
#
# PID reuse is theoretically possible; the age requirement makes it unlikely,
# and the cost is one duplicate opportunity that the under-lock re-check below
# then rejects.
LOCK_STALE_AFTER_S="${LOCK_STALE_AFTER_S:-900}"
# A token unique to THIS process. Cleanup and recovery both key off it, so no
# process can ever delete a lock it does not own.
LOCK_TOKEN="$$-$(date +%s)-$RANDOM"

lock_dir_age_s() {
  local mtime
  mtime=$(stat -f %m "$LOCK" 2>/dev/null || echo 0)
  if [ "$mtime" -eq 0 ]; then echo 0; else echo $(( $(date +%s) - mtime )); fi
}

# alive | dead | unknown | malformed | ownerless
#
# `kill -0` is NOT used: it returns EPERM for another user's process, which
# reads as "dead" and would steal a live lock. `ps` distinguishes the cases, and
# anything it cannot answer is UNKNOWN — never dead.
owner_state() {
  local pid="$1" out rc
  # No owner file at all is a different fault from an owner file full of
  # garbage: the first means a lock was created by something that never
  # recorded itself, the second means the record was corrupted. Neither is
  # evidence that anything died, and they are reported separately so an
  # operator knows which they are looking at.
  case "$pid" in
    '__missing__' ) echo ownerless; return ;;
    '' ) echo malformed; return ;;
    *[!0-9]* ) echo malformed; return ;;
  esac
  command -v ps > /dev/null 2>&1 || { echo unknown; return; }
  out=$(ps -p "$pid" -o pid= 2>/dev/null); rc=$?
  if [ "$rc" -eq 0 ] && [ -n "$out" ]; then echo alive
  elif [ "$rc" -eq 1 ] && [ -z "$out" ]; then echo dead
  else echo unknown; fi
}

# Claim a stale lock ATOMICALLY.
#
# The previous version inspected, `rm -rf`ed, then `mkdir`ed. Two recoverers
# could both inspect the same stale lock, and the second could delete the
# first's freshly acquired lock — leaving two schedulers believing they held it.
#
# Now the stale directory is RENAMED to a token-suffixed path. `mv` of a
# directory succeeds for exactly one racer; every loser's `mv` fails because the
# source no longer exists, so a loser never removes anything. Only the winner
# deletes the claimed path, and it deletes a path bearing its OWN token.
claim_stale_lock() {
  local claim="${LOCK}.stale.${LOCK_TOKEN}"
  mv "$LOCK" "$claim" 2>/dev/null || return 1
  rm -rf "$claim" 2>/dev/null
  return 0
}

# Record ourselves as the owner, and FAIL if we cannot.
#
# This used to be `printf ... > "$LOCK/owner" 2>/dev/null` with the result
# discarded, so a failed write returned successful acquisition and left an
# anonymously held lock — which every other caller then classifies as
# `ownerless` and refuses to touch, wedging the scheduler with no owner to
# blame. Read it back, because a partial write is as bad as no write.
record_owner() {
  printf '%s\n%s\n' "$$" "$LOCK_TOKEN" > "$LOCK/owner" 2>/dev/null || return 1
  [ "$(sed -n '1p' "$LOCK/owner" 2>/dev/null)" = "$$" ] || return 1
  [ "$(sed -n '2p' "$LOCK/owner" 2>/dev/null)" = "$LOCK_TOKEN" ] || return 1
  return 0
}

# Take the lock we have just created, or give it up entirely.
take_fresh_lock() {
  if record_owner; then
    return 0
  fi
  # Never hold a lock we could not sign. Removing it is safe: `mkdir` gave us
  # exclusive creation, so this directory is ours and nobody else can be using
  # it yet.
  log "ERROR: acquired the scheduler lock but could not record ownership — releasing it"
  rm -rf "$LOCK" 2>/dev/null
  return 1
}

acquire_lock() {
  if mkdir "$LOCK" 2>/dev/null; then
    take_fresh_lock
    return $?
  fi

  # SOMEONE HOLDS IT. Any recovery decision from here must be SERIALIZED.
  #
  # The previous version read owner, liveness and age, and only then renamed
  # $LOCK. Two recoverers could both read the same stale lock; the first would
  # rename it, delete it and create a fresh one — and the second, still acting
  # on its now-obsolete observation, would rename THAT FRESH LIVE LOCK away and
  # take the lock for itself. Two schedulers then believed they held it, which
  # is precisely the duplicate daily run the lock exists to prevent.
  #
  # The guard below is a second, ordinary mkdir mutex. Whoever creates it holds
  # exclusive recovery authority, and everything that follows — re-reading the
  # owner, classifying liveness, measuring age, claiming, and creating the
  # replacement — happens inside it. Nothing observed before the guard was held
  # is used for anything.
  local recovery="${LOCK}.recovery"
  if ! mkdir "$recovery" 2>/dev/null; then
    # DISTINCT OUTCOME, NOT A GENERIC FAILURE.
    #
    # Two very different conditions used to arrive at the caller as the same
    # silent `return 1`, and the caller then logged "another scheduler fire
    # holds the lock" for both. That sentence is actively misleading here: it
    # describes healthy contention that resolves itself on the next fire,
    # whereas a guard left behind by a process that died mid-recovery resolves
    # itself never. The operator reading the log would see a routine skip and
    # wait for a recovery that cannot happen.
    #
    # ACQUIRE_GUARD_BLOCKED (3) says which condition this is; the caller says
    # what to do about it. Still fails closed: nothing is recovered, nothing is
    # removed, and no timeout is introduced.
    return 3
  fi

  recovery_decision
  local rc=$?
  rmdir "$recovery" 2>/dev/null
  return $rc
}

# Runs ONLY while this process holds "${LOCK}.recovery".
#
# OPERATOR NOTE: if a process dies between creating that guard and removing it,
# the guard directory is left behind and automatic recovery stops until someone
# removes it by hand. That is deliberate. A timeout on the recovery guard would
# be a second auto-recovery mechanism with the same class of race underneath it,
# and the failure it would introduce — two processes recovering at once — is
# worse than the one it would fix. The blocked path is reported on every fire.
recovery_decision() {
  local owner state age

  # The lock may have been released while we were taking the guard; in that
  # case this is an ordinary acquisition, not a recovery.
  if [ ! -d "$LOCK" ]; then
    if mkdir "$LOCK" 2>/dev/null; then
      take_fresh_lock
      return $?
    fi
    return 1
  fi

  # RE-READ EVERYTHING. Nothing from before the guard is trusted.
  if [ -f "$LOCK/owner" ]; then
    owner=$(head -n 1 "$LOCK/owner" 2>/dev/null || echo "")
  else
    owner='__missing__'
  fi
  state=$(owner_state "$owner")
  age=$(lock_dir_age_s)

  # FAIL CLOSED: automatic recovery requires POSITIVE evidence of death.
  #
  # Only `dead` — `ps` answered, and answered that the process is gone — may be
  # recovered, and only once the age backstop is also satisfied. Age alone is
  # not evidence: a long pipeline legitimately holds the lock for hours.
  #
  # `unknown` (ps unavailable or refused), `malformed` and `ownerless` are all
  # blocked REGARDLESS of age. Each means we do not know what we would be
  # destroying, and destroying a live scheduler's lock puts two submitters on
  # the same day. Such a lock needs an operator to clear it; that is the correct
  # direction to fail, and the message says so.
  case "$state" in
    alive)
      return 1
      ;;
    unknown|malformed|ownerless)
      log "scheduler lock held with ${state} owner (owner=${owner#__missing__}, age=${age}s) — NOT recovering automatically; operator inspection required: $LOCK"
      return 1
      ;;
  esac

  if [ "$age" -lt "$LOCK_STALE_AFTER_S" ]; then
    return 1                       # dead, but too young — retry next opportunity
  fi

  claim_stale_lock || return 1
  log "recovered stale scheduler lock (owner=${owner}, liveness=${state}, age=${age}s, threshold=${LOCK_STALE_AFTER_S}s)"

  # A normal caller may have won the fresh mkdir in the instant after we moved
  # the stale directory aside. That is a legitimate outcome and we lose safely:
  # we never remove or rename a lock we did not create.
  if mkdir "$LOCK" 2>/dev/null; then
    take_fresh_lock
    return $?
  fi
  return 1
}

# Release ONLY our own lock. Without the token check, a process whose lock had
# already been recovered by someone else would delete the replacement owner's
# lock on the way out.
release_lock() {
  local held
  held=$(sed -n '2p' "$LOCK/owner" 2>/dev/null || echo "")
  [ "$held" = "$LOCK_TOKEN" ] && rm -rf "$LOCK" 2>/dev/null
  return 0
}

# `$?` must be captured from the plain call: inside `if ! acquire_lock`, `$?`
# is the status of the INVERSION (always 0), which would erase the distinction.
acquire_lock
ACQUIRE_RC=$?
if [ "$ACQUIRE_RC" -eq 3 ]; then
  # A recovery guard is present. This does NOT mean another scheduler holds the
  # main lock — it means the process that was adjudicating a stale lock did not
  # finish, and stale-lock recovery is blocked until someone looks.
  log "ATTENTION: stale-lock recovery is BLOCKED — a recovery guard is present at ${LOCK}.recovery"
  log "  This is NOT ordinary contention: no scheduler is known to hold $LOCK."
  log "  It will NOT be removed automatically, and no timeout will clear it."
  log "  Operator inspection is required before removing ${LOCK}.recovery by hand:"
  log "    verify no daily-scheduler process is running, then remove that directory."
  # EXIT 3, NOT 0. An abandoned recovery guard is a persistent fault that needs a
  # person, and reporting it as a successful run hides it from everything that
  # only ever looks at exit status. Ordinary contention below still exits 0,
  # because that genuinely is a healthy no-op.
  #
  # Safe under the proposed job: StartInterval=900 with no KeepAlive, so launchd
  # records the non-zero status and simply fires again at the next 15-minute
  # opportunity. A non-zero exit cannot produce a restart loop here.
  exit 3
elif [ "$ACQUIRE_RC" -ne 0 ]; then
  log "another scheduler fire holds the lock — skipping"
  exit 0
fi
trap 'release_lock' EXIT

# Re-check under the lock. The window between evaluating and acquiring is small
# but real, and a duplicate daily run costs real API spend.
#
# THE RECHECK MUST ASK ABOUT $LOGICAL, NOT ABOUT "TODAY".
#
# It used to call the status CLI with no date, so it re-derived the day from its
# own clock. Acquiring the lock can take a moment, and if that moment crossed
# Los Angeles midnight the recheck evaluated the NEXT date — which of course had
# no run yet and was not due — and the approved run for $LOGICAL was discarded.
# One late fire could then skip a day entirely.
RECHECK_JSON=$(cd "$REPO" && npx tsx packages/pipeline-runs/bin/daily-run-status.ts \
  --json --logical-date "$LOGICAL" 2>/dev/null)
if [ -z "$RECHECK_JSON" ]; then
  log "recheck under lock produced no output — refusing to submit blind"
  exit 1
fi

# FAIL CLOSED on anything unexpected. A recheck we cannot parse, or one that
# answers about a different day than we asked about, is not permission to spend.
RECHECK=$(echo "$RECHECK_JSON" | python3 -c 'import json,sys;print(json.load(sys.stdin)["eligibleToRun"])' 2>/dev/null)
RECHECK_DATE=$(echo "$RECHECK_JSON" | python3 -c 'import json,sys;print(json.load(sys.stdin)["logicalDate"])' 2>/dev/null)
if [ -z "$RECHECK" ] || [ -z "$RECHECK_DATE" ]; then
  log "recheck under lock was unparseable — refusing to submit"
  exit 1
fi
if [ "$RECHECK_DATE" != "$LOGICAL" ]; then
  log "FATAL: recheck answered for $RECHECK_DATE but $LOGICAL was approved — refusing to submit"
  exit 1
fi
if [ "$RECHECK" != "True" ] && [ "$RECHECK" != "true" ]; then
  log "no longer eligible for $LOGICAL after acquiring lock — another fire started it"
  exit 0
fi

# An isolated run must never reach the production submitter. Redirecting only
# logs while still enqueuing into production Redis is precisely the partial
# isolation this phase forbids.
if [ "$ISOLATION_MODE" = "isolated" ]; then
  log "isolated environment — refusing to invoke the production submitter"
  exit 0
fi

log "state=$STATE logical=$LOGICAL — submitting: $REASON"
# The APPROVED logical date travels with the submission. $LOGICAL is what
# eligibility was evaluated against; anything recomputed downstream could differ
# across a Los Angeles midnight boundary.
"$REPO/daily-queue.sh" --logical-date "$LOGICAL" >> "$LOG" 2>&1
# CAPTURE FIRST. `log "... exit=$?"` printed the right number — the argument is
# expanded before log runs — but log then became the script's LAST command, so
# launchd received log's status (0) rather than the submitter's. A failed
# submission was reported as success, which is exactly the signal the watchdog
# and the activation proofs depend on.
SUBMIT_RC=$?
log "submission finished, exit=$SUBMIT_RC"
# Exit with the submitter's status, not the logger's. `exit` still fires the
# EXIT trap, so release_lock runs on both the success and the failure path.
exit "$SUBMIT_RC"
