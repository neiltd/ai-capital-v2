#!/bin/bash
# Shared heartbeat writer for daily-scheduler.sh and pipeline-watchdog.sh.
#
# WHY THIS EXISTS. Both scripts wrote the same heartbeat file with the same
# three inline lines and the same FIXED temporary path:
#
#     echo "$(date …)" >> "$SCHEDULER_HEARTBEAT_FILE"
#     tail -n 400 "$SCHEDULER_HEARTBEAT_FILE" > "$SCHEDULER_HEARTBEAT_FILE.tmp" \
#       && mv "$SCHEDULER_HEARTBEAT_FILE.tmp" "$SCHEDULER_HEARTBEAT_FILE"
#
# launchd fires them on independent intervals, so they overlap. During the
# Round 20 activation one of them printed:
#
#     mv: rename …/scheduler-heartbeat.log.tmp …: No such file or directory
#
# Neither script uses `set -e`, the chain is joined by `&&`, and no caller
# checked the result — so the failure exited 0 and was invisible.
#
# UNIQUE TEMP NAMES ARE NOT THE FIX. They remove the rename collision and leave
# the worse bug in place, because append/read/trim/replace is a read-modify-write
# over the whole file:
#
#     A: append A            file = [A]
#     A: tail  -> tmpA       snapshot = [A]
#     B: append B            file = [A,B]
#     B: tail  -> tmpB ; mv  file = [A,B]
#     A: mv tmpA             file = [A]        <- B's record is gone, mv exits 0
#
# So the whole transaction is serialized instead. The heartbeat is the evidence
# the watchdog reads to tell a dead scheduler from a sleeping laptop; a record
# that silently disappears becomes a wrong verdict later.
#
# THE LOCK is `mkdir`, the same primitive daily-scheduler.sh already uses for its
# run lock: creation is atomic on every filesystem we run on, and it needs no
# flock(1) (absent on macOS). It is SIGNED — a token file naming this caller — so
# a stale-lock reclaim can never make one writer delete a lock another writer
# holds. A lock older than HEARTBEAT_LOCK_STALE_SECONDS cannot belong to a live
# transaction, because the transaction is three filesystem operations.
#
# This file is sourced, not executed, and defines no production path of its own.

HEARTBEAT_RETAIN_LINES="${HEARTBEAT_RETAIN_LINES:-400}"
HEARTBEAT_LOCK_TIMEOUT="${HEARTBEAT_LOCK_TIMEOUT:-10}"
HEARTBEAT_LOCK_STALE_SECONDS="${HEARTBEAT_LOCK_STALE_SECONDS:-60}"
HEARTBEAT_RECOVERY_ABANDONED_SECONDS="${HEARTBEAT_RECOVERY_ABANDONED_SECONDS:-300}"

# Epoch mtime of a path. BSD first (macOS), GNU as the fallback.
_heartbeat_mtime() {
  stat -f %m "$1" 2>/dev/null || stat -c %Y "$1" 2>/dev/null
}

# rc 0 = the path exists and is at least <seconds> old. An unreadable mtime is
# NOT age: it returns 1, so nothing is ever reclaimed on a failed measurement.
_heartbeat_path_age_at_least() {           # <path> <seconds>
  local path="$1" want="$2" mtime now age
  [ -e "$path" ] || return 1
  mtime=$(_heartbeat_mtime "$path")
  case "$mtime" in ''|*[!0-9]*) return 1 ;; esac
  now=$(date +%s)
  case "$now" in ''|*[!0-9]*) return 1 ;; esac
  age=$(( now - mtime ))
  [ "$age" -ge "$want" ]
}

# ─── OWNERSHIP ─────────────────────────────────────────────────────────────
# The lock records TWO fields, on separate lines:
#
#     line 1  the owning process id
#     line 2  a token unique to this call
#
# The pid is what makes liveness knowable; the token is what makes release
# provable. Round 2 stored only the token, so staleness could be judged by AGE
# ALONE — and an independent reproduction showed exactly what that costs:
#
#     reclaim_rc=0 owner=LIVE lock=REMOVED
#
# A live writer suspended past the staleness bound had its lock taken, and on
# resuming could replace the heartbeat with the snapshot it read before the
# suspension. Age is not evidence of death; only `ps` answering that the process
# is gone is evidence of death.

# Write the owner record, then read it back. A partial write is as bad as none:
# an unsigned or half-signed lock is one nobody can prove ownership of, and every
# other caller then classifies it as ownerless and refuses to touch it.
_heartbeat_record_owner() {                # <lockdir> <token>
  local lock="$1" token="$2"
  printf '%s\n%s\n' "$$" "$token" > "$lock/owner" 2>/dev/null || return 1
  [ "$(sed -n '1p' "$lock/owner" 2>/dev/null)" = "$$" ]    || return 1
  [ "$(sed -n '2p' "$lock/owner" 2>/dev/null)" = "$token" ] || return 1
  return 0
}

_heartbeat_owner_pid() {                   # <lockdir>; echoes pid or a marker
  local lock="$1"
  [ -f "$lock/owner" ] || { echo '__missing__'; return 0; }
  sed -n '1p' "$lock/owner" 2>/dev/null
}

# Classify the RECORD, from ONE read of the file.
#
# THE DEFECT THIS CLOSES. Adjudication used to read line 1 and classify from the
# pid alone, so a HALF-SIGNED record — a valid numeric pid with no token, or with
# an empty token — was treated as a complete one. If that pid was dead and the
# lock old, the lock was reclaimed:
#
#     owner file: one line containing a dead numeric pid
#     lock age  : old
#     result    : rc=0, lock=REMOVED
#
# That contradicts the invariant this file documents: a record we cannot fully
# read is a record we cannot reason about, and age is not evidence of death.
# `_heartbeat_record_owner` writes two fields and verifies both; the reader had
# to check both too, or the write-side guarantee bought nothing.
#
# ONE read, so both fields describe the SAME observed record. Two separate `sed`
# passes over the file could see two different states of it.
#
# Echoes exactly one of:
#   ownerless          the owner file is absent
#   malformed <seen>   present but unusable; <seen> is the first line, whitespace
#                      stripped and truncated, FOR DIAGNOSTICS ONLY
#   valid <pid>        line 1 numeric and nonempty, line 2 a nonempty token
#
# `ps` is never consulted here, and must never be consulted for anything but a
# `valid` record — asking about a pid we do not trust would dress a guess up as
# evidence.
_heartbeat_owner_classify() {              # <lockdir>
  local lock="$1" record pid token seen
  [ -f "$lock/owner" ] || { echo ownerless; return 0; }
  record=$(cat "$lock/owner" 2>/dev/null) || { echo 'malformed <unreadable>'; return 0; }
  pid=$(printf '%s\n' "$record" | sed -n '1p')
  token=$(printf '%s\n' "$record" | sed -n '2p')
  seen=$(printf '%s' "$pid" | tr -d '[:space:]' | cut -c1-32)
  [ -n "$record" ] || { echo 'malformed <empty>'; return 0; }
  case "$pid" in ''|*[!0-9]*) printf 'malformed %s\n' "${seen:-<empty>}"; return 0 ;; esac
  # A missing second line and an empty one are the same fault, and a token
  # containing whitespace cannot have come from _heartbeat_record_owner.
  case "$token" in ''|*[[:space:]]*) printf 'malformed %s\n' "$seen"; return 0 ;; esac
  printf 'valid %s\n' "$pid"
  return 0
}

_heartbeat_owner_token() {                 # <lockdir>
  sed -n '2p' "$1/owner" 2>/dev/null
}

# Classify the owner. Mirrors owner_state() in daily-scheduler.sh.
#
# `ps`, not `kill -0`: kill -0 conflates "no such process" with "exists but you
# may not signal it", and answers success for a zombie. The five states are kept
# distinct because they call for different actions — only ONE of them may ever be
# recovered automatically.
_heartbeat_owner_state() {                 # <pid-or-marker>
  local pid="$1" out rc
  case "$pid" in
    '__missing__') echo ownerless; return 0 ;;
    '')            echo malformed; return 0 ;;
    *[!0-9]*)      echo malformed; return 0 ;;
  esac
  command -v ps >/dev/null 2>&1 || { echo unknown; return 0; }
  out=$(ps -p "$pid" -o pid= 2>/dev/null); rc=$?
  if   [ "$rc" -eq 0 ] && [ -n "$out" ]; then echo alive
  elif [ "$rc" -eq 1 ] && [ -z "$out" ]; then echo dead
  else echo unknown; fi
  return 0
}

# Reclaim a stale lock WITHOUT the read-then-delete race.
#
# THE DEFECT THIS REPLACES. The first version did:
#
#     if _heartbeat_lock_is_stale "$lock"; then rm -rf "$lock"; continue; fi
#
# Two writers could observe the same stale lock. The first reclaims it and
# acquires a fresh one at the same canonical path; the second, still acting on
# its now-obsolete observation, deletes THAT FRESH LOCK. Both then believe they
# hold it, and the serialization this file exists to provide is gone.
#
# THE DESIGN, equivalent to acquire_lock/claim_stale_lock in daily-scheduler.sh:
#
#   • A `mkdir` recovery guard makes adjudication exclusive: exactly one process
#     may decide anything about a stale lock.
#   • Every fact is RE-READ after the guard is held. Nothing observed before it
#     is used for anything — the pre-guard age check is only a trigger to enter
#     adjudication, never a decision.
#   • The claim is a RENAME to a token-specific path. `mv` of a directory
#     succeeds for exactly one racer; a loser's `mv` fails because the source is
#     gone, so a loser removes nothing.
#   • Only the token-specific claimed path is deleted. The canonical lock path is
#     never deleted by a reclaimer.
#   • After a successful reclaim an ordinary writer may take the lock first. The
#     reclaimer simply fails its own `mkdir` and waits — losing safely.
#
# rc 0 = the canonical path is free to try; 1 = leave it alone and wait;
# 2 = recovery authority is abandoned, already diagnosed, stop trying.
_heartbeat_reclaim_stale() {               # <lockdir> <token>
  local lock="$1" token="$2"
  local recovery="$lock.recovery" claim="$lock.stale.$token" rc=1

  if ! mkdir "$recovery" 2>/dev/null; then
    # An abandoned guard resolves itself never, so it is reported as its own
    # outcome rather than as ordinary contention. Nothing is deleted: a timeout
    # here would be a second auto-recovery mechanism with the same class of race
    # underneath it.
    if _heartbeat_path_age_at_least "$recovery" "$HEARTBEAT_RECOVERY_ABANDONED_SECONDS"; then
      echo "[heartbeat] FATAL: heartbeat recovery guard $recovery has been held for over ${HEARTBEAT_RECOVERY_ABANDONED_SECONDS}s" >&2
      echo "[heartbeat]        A process died between taking recovery authority and releasing it." >&2
      echo "[heartbeat]        No heartbeat can be recorded until an operator removes that directory." >&2
      echo "[heartbeat]        Nothing was deleted, renamed or recovered." >&2
      return 2
    fi
    return 1                               # someone else is adjudicating; wait
  fi

  # ── holding recovery authority: re-read everything ──────────────────────
  local owner state
  if [ ! -d "$lock" ]; then
    rc=0                                   # released while we took the guard
  else
    # The RECORD is validated first, from a single read. Only a complete record
    # reaches `ps`; an incomplete one is classified without asking about a pid we
    # have no reason to trust.
    local classification
    classification=$(_heartbeat_owner_classify "$lock")
    case "$classification" in
      ownerless)  state=ownerless; owner='' ;;
      'malformed'*) state=malformed; owner=${classification#malformed } ;;
      'valid '*)  owner=${classification#valid }
                  state=$(_heartbeat_owner_state "$owner") ;;
      *)          state=malformed; owner='<unclassifiable>' ;;
    esac
    case "$state" in
      alive)
        # NEVER, at any age. A long-suspended writer is still a writer, and its
        # snapshot is still the one it will put back.
        rc=1 ;;
      unknown|malformed|ownerless)
        # FAIL CLOSED. Each of these means we do not know what we would be
        # destroying, and age cannot supply that knowledge. Only reported once
        # the lock is also old, so ordinary contention stays quiet.
        if _heartbeat_path_age_at_least "$lock" "$HEARTBEAT_LOCK_STALE_SECONDS"; then
          echo "[heartbeat] FATAL: $lock is held with a ${state} owner (record=${owner:-none})" >&2
          echo "[heartbeat]        Age is not evidence of death, so this lock is NOT recovered" >&2
          echo "[heartbeat]        automatically. An operator must inspect and remove it: $lock" >&2
          echo "[heartbeat]        Nothing was deleted, renamed or recovered." >&2
          rc=2
        else
          rc=1
        fi ;;
      dead)
        if _heartbeat_path_age_at_least "$lock" "$HEARTBEAT_LOCK_STALE_SECONDS"; then
          if mv "$lock" "$claim" 2>/dev/null; then
            # CHECKED. An unreported failure here leaves a claim directory that
            # nothing will ever collect, while the caller is told recovery
            # succeeded. Recovery is not successful while its residue remains.
            if rm -rf "$claim" 2>/dev/null && [ ! -e "$claim" ]; then
              echo "[heartbeat] WARNING: reclaimed the lock of dead owner ${owner} at $lock (claimed as $claim)" >&2
              rc=0
            else
              echo "[heartbeat] FATAL: claimed the stale lock but could not delete $claim" >&2
              echo "[heartbeat]        The canonical lock is free, but this claim directory remains" >&2
              echo "[heartbeat]        and must be removed by an operator: $claim" >&2
              rc=2
            fi
          else
            rc=1                           # lost the claim; $lock is not ours to touch
          fi
        else
          rc=1                             # dead, but too young — try again later
        fi ;;
    esac
  fi

  # CHECKED. A guard we cannot release blocks every future recovery, so it is
  # never reported as an aside. It also overrides a successful reclaim: the
  # caller must not be told recovery worked while authority is stuck held.
  if ! rmdir "$recovery" 2>/dev/null || [ -e "$recovery" ]; then
    echo "[heartbeat] FATAL: cannot release the recovery guard $recovery" >&2
    echo "[heartbeat]        No further heartbeat recovery can proceed until an" >&2
    echo "[heartbeat]        operator removes that directory." >&2
    rc=2
  fi
  return $rc
}

# Append one record and trim to the newest HEARTBEAT_RETAIN_LINES, as ONE
# serialized transaction. Returns 0 only when the record is durably in place;
# every other outcome returns nonzero after writing a diagnostic to stderr.
#
#   heartbeat_record <file> [record]
#
# `record` defaults to the current UTC instant in the format both scripts wrote.
heartbeat_record() {
  local file="$1"
  local stamp="${2:-$(date -u '+%Y-%m-%dT%H:%M:%S.000Z')}"
  local lock tmp token attempts attempt=0 acquired=0

  if [ -z "$file" ]; then
    echo "[heartbeat] FATAL: no heartbeat file given" >&2
    return 1
  fi
  lock="$file.lock"
  # Unique per caller AND per call, so a lock that is somehow bypassed still
  # cannot make two writers share a temporary file. Same directory as the
  # target, so the final rename stays atomic.
  tmp="${HEARTBEAT_TMP_OVERRIDE:-$file.tmp.$$.${RANDOM}}"
  token="$$-$(date +%s)-${RANDOM}"

  # Bounded wait, in 0.05s steps rather than whole seconds: the transaction is
  # sub-millisecond, so a coarse backoff would serialize callers far longer than
  # the work takes.
  attempts=$(( HEARTBEAT_LOCK_TIMEOUT * 20 ))
  [ "$attempts" -gt 0 ] || attempts=1
  while [ "$attempt" -lt "$attempts" ]; do
    if mkdir "$lock" 2>/dev/null; then
      # Sign it with pid AND token, and read both back.
      if _heartbeat_record_owner "$lock" "$token"; then
        acquired=1
        break
      fi
      # Removing it is safe: `mkdir` gave us exclusive creation, so this
      # directory is ours and no other writer can be using it yet.
      rm -rf "$lock" 2>/dev/null
      echo "[heartbeat] FATAL: cannot record pid and token in $lock/owner" >&2
      return 1
    fi
    # Contended. The age test here is only a TRIGGER to enter adjudication; the
    # decision is re-made inside the recovery guard, on facts read there.
    if _heartbeat_path_age_at_least "$lock" "$HEARTBEAT_LOCK_STALE_SECONDS"; then
      _heartbeat_reclaim_stale "$lock" "$token"
      case $? in
        # 2 = a condition no amount of waiting resolves: an abandoned recovery
        # guard, a stale lock whose owner cannot be proved dead, or residue left
        # by a claim or guard we could not clean up. Each is already diagnosed;
        # spinning out the remaining timeout would only delay the same answer.
        2) echo "[heartbeat] FATAL: $file was NOT updated" >&2; return 1 ;;
        0) attempt=$(( attempt + 1 )); continue ;;   # retry at once, still bounded
      esac
    fi
    attempt=$(( attempt + 1 ))
    sleep 0.05
  done

  if [ "$acquired" -ne 1 ]; then
    echo "[heartbeat] FATAL: could not acquire $lock within ${HEARTBEAT_LOCK_TIMEOUT}s; $file was NOT updated" >&2
    return 1
  fi

  # ── inside the lock: append, read, trim and replace are one transaction ──
  if ! printf '%s\n' "$stamp" >> "$file" 2>/dev/null; then
    echo "[heartbeat] FATAL: cannot append to $file" >&2
    _heartbeat_release "$lock" "$token"
    return 1
  fi
  if ! tail -n "$HEARTBEAT_RETAIN_LINES" "$file" > "$tmp" 2>/dev/null; then
    echo "[heartbeat] FATAL: cannot write the trimmed heartbeat to $tmp" >&2
    rm -f "$tmp" 2>/dev/null
    _heartbeat_release "$lock" "$token"
    return 1
  fi
  if ! mv "$tmp" "$file" 2>/dev/null; then
    echo "[heartbeat] FATAL: cannot replace $file with $tmp" >&2
    rm -f "$tmp" 2>/dev/null
    _heartbeat_release "$lock" "$token"
    return 1
  fi

  _heartbeat_release "$lock" "$token" || return 1
  return 0
}

# Release only a lock still signed by us. A reclaimer may have taken it while we
# worked; deleting theirs would hand a third caller a lock two writers believe
# they hold.
_heartbeat_release() {                     # <lockdir> <token>
  local lock="$1" token="$2" owner
  owner=$(_heartbeat_owner_token "$lock")
  if [ "$owner" != "$token" ]; then
    echo "[heartbeat] WARNING: $lock is no longer signed by this writer; leaving it in place" >&2
    return 1
  fi
  if ! rm -rf "$lock" 2>/dev/null; then
    echo "[heartbeat] FATAL: cannot release $lock" >&2
    return 1
  fi
  return 0
}
