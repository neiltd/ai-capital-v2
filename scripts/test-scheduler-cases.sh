#!/bin/bash
# End-to-end scheduler case matrix, exercised through the REAL scripts.
#
# Uses a throwaway pipeline-runs database and a throwaway heartbeat file. It
# never reads or writes data/pipeline-runs.db, and never submits a pipeline —
# every invocation is --dry-run. A test that created a fake 'success' row in the
# real database would corrupt the exact record the watchdog reads.
set -uo pipefail
# ROOT IS DERIVED FROM THIS SCRIPT'S OWN LOCATION.
#
# It used to be the literal /Users/thanapold/Desktop/Projects.nosync. That is a
# COLLISION, not merely a stale path: this harness runs the REAL scheduler and
# watchdog out of "$ROOT/scripts", so a copy of the harness sitting in the new
# runtime checkout would silently exercise the LEGACY Desktop scripts instead of
# the ones beside it — reporting PASS for code that was never run. Measured from
# a checkout outside ~/Desktop, the old line still yielded
# /Users/thanapold/Desktop/Projects.nosync/scripts/daily-scheduler.sh.
#
# BASH_SOURCE[0], not $0 and not cwd: $0 is the interpreter's view and differs
# when the file is sourced, while cwd is whatever the operator happened to leave
# behind. The script's own path is the one thing that always describes the
# checkout it belongs to.
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# THE CLOCK IS FIXED HERE, AND THE HARNESS OWNS IT.
#
# This matrix used to derive every fixture from the HOST CLOCK: `date +%H`,
# `datetime.now()`, and a status CLI invoked with no override at all. That made
# the suite wall-clock dependent in the worst way - it PASSED after the due
# time local and FAILED before it, on byte-identical files. Measured: 3 failures at 01:58
# PDT and 73/73 at 09:13 PDT, same commit.
#
# `SCHEDULER_TEST_NOW` is the EXISTING reviewed dry-run seam - no new production
# clock hook is introduced. It is honoured by `daily-run-status.ts`, and both
# `daily-scheduler.sh` and `pipeline-watchdog.sh` REFUSE to run for real while it
# is set, so a fixed clock can never cause a real submission.
#
# 16:00Z on 2026-08-27 is 09:00 in America/Los_Angeles: after the 04:30
# opportunity and its 30-minute grace, which is what Cases A, E and F need.
#
# THE DATE MUST BE A RUN DAY. This was 2026-08-29 while every calendar date was
# eligible. 2026-08-29 is a SATURDAY, and the rule is now trading days plus
# Sundays, so every case below would have come back `not_trading_day` and the
# matrix would have tested nothing. 2026-08-27 is a Thursday and not an NYSE
# holiday. The two non-run-day cases at the end pin the excluded days
# explicitly, with their own clocks.
readonly FIXED_NOW='2026-08-27T16:00:00.000Z'

# THE BUSINESS ZONE, NOT THE HOST'S. `daily-run-state.ts` defines logical dates
# and the due hour in `BUSINESS_TIMEZONE = America/Los_Angeles` precisely so the
# verdict does not depend on where the machine is. Every fixture below is built
# in that same zone, so this harness gives identical results under TZ=UTC,
# TZ=Pacific/Honolulu or anything else - which is the property the old
# host-clock fixtures did not have.
readonly BUSINESS_TZ='America/Los_Angeles'

# A CALLER-SUPPLIED VALUE IS NOT TRUSTED. The harness exports its own on every
# invocation; anything inherited is discarded here so it cannot leak into a
# child through the environment.
unset SCHEDULER_TEST_NOW

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
DB="$TMP/pipeline-runs.db"
HB="$TMP/heartbeat.log"
PASS=0; FAIL=0

# FULL ISOLATION, OR NONE. decideIsolation() classifies three dimensions —
# database, Redis and filesystem — and refuses to run when only some are
# isolated, because isolating one disarms the safety mechanisms living in the
# others. This harness used to override PIPELINE_RUNS_DB alone, so every real
# scheduler/watchdog invocation was refused with PARTIALLY isolated and the
# cases that expected output failed. Supply all three from here.
ISO_ROOT="$TMP/isolated-root"          # outside BOTH protected production roots
ISO_REDIS="redis://127.0.0.1:6380"     # loopback, non-production port; never connected to
mkdir -p "$ISO_ROOT"

# The ONE way a real scheduler/watchdog is invoked: every isolation dimension is
# supplied here, and nothing calls these scripts directly. The command and its
# flags are forwarded verbatim so each call site still reads
# "./scripts/<script>.sh --dry-run" — the portability contract in
# packages/queue/tests/runtime-root-portability.test.ts inspects those lines and
# requires --dry-run on every one of them.
# Usage: run_isolated ./scripts/<script>.sh --dry-run ; sets ISO_OUT and ISO_RC.
run_isolated() {
  ISO_OUT=$(cd "$ROOT" && \
    AI_CAPITAL_ROOT="$ISO_ROOT" \
    REDIS_URL="$ISO_REDIS" \
    PIPELINE_RUNS_DB="$DB" \
    SCHEDULER_HEARTBEAT_FILE="$HB" \
    SCHEDULER_TEST_NOW="$FIXED_NOW" \
    "$@" 2>&1)
  ISO_RC=$?
}

# Same, with an explicit clock. The calendar cases each need their own day, and
# a global FIXED_NOW cannot express "a Saturday" and "a Thursday" at once.
run_isolated_at() {
  local when="$1"; shift
  ISO_OUT=$(cd "$ROOT" && \
    AI_CAPITAL_ROOT="$ISO_ROOT" \
    REDIS_URL="$ISO_REDIS" \
    PIPELINE_RUNS_DB="$DB" \
    SCHEDULER_HEARTBEAT_FILE="$HB" \
    SCHEDULER_TEST_NOW="$when" \
    "$@" 2>&1)
  ISO_RC=$?
}

sqlite3 "$DB" "CREATE TABLE pipeline_runs (
  id TEXT PRIMARY KEY, parent_run_id TEXT, stage TEXT NOT NULL, source TEXT,
  started_at TEXT NOT NULL, ended_at TEXT, duration_ms INTEGER, status TEXT NOT NULL,
  doc_count INTEGER, chunk_count INTEGER, ticker_count INTEGER,
  error_message TEXT, error_stack TEXT, metadata_json TEXT);"

# THE BUSINESS-ZONE DATE OF THE FIXED INSTANT. Never `date`.
TODAY=$(python3 -c "
import datetime,sys
from zoneinfo import ZoneInfo
now = datetime.datetime.fromisoformat(sys.argv[1].replace('Z','+00:00'))
print(now.astimezone(ZoneInfo(sys.argv[2])).strftime('%Y-%m-%d'))" "$FIXED_NOW" "$BUSINESS_TZ")
reset() { sqlite3 "$DB" "DELETE FROM pipeline_runs;"; : > "$HB"; }
# A business-zone wall-clock time on the fixed instant's day -> stored UTC ISO,
# the way the pipeline records it. Anchored to FIXED_NOW and BUSINESS_TZ, so the
# host's clock and the host's zone change nothing.
utc()  { python3 -c "
import datetime,sys
from zoneinfo import ZoneInfo
h,m = sys.argv[1].split(':')
now = datetime.datetime.fromisoformat(sys.argv[2].replace('Z','+00:00'))
local = now.astimezone(ZoneInfo(sys.argv[3]))
d = local.replace(hour=int(h),minute=int(m),second=0,microsecond=0)
print(d.astimezone(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%S.000Z'))" "$1" "$FIXED_NOW" "$BUSINESS_TZ"; }
add_run()  { sqlite3 "$DB" "INSERT INTO pipeline_runs (id,stage,started_at,ended_at,status)
             VALUES ('t-$2-$1','daily-pipeline','$(utc "$1")',$( [ -n "${3:-}" ] && echo "'$(utc "$3")'" || echo NULL ),'$2');"; }
beat() { utc "$1" >> "$HB"; }
# A heartbeat at a wall-clock time on the business day of an ARBITRARY instant,
# for the calendar cases, which each use their own day. `beat` anchors to
# FIXED_NOW, so on any other day it writes a heartbeat that is not "since due"
# and every such case comes back `no_opportunity` instead of `missing` — which
# is how this helper came to exist.
beat_on() { python3 -c "
import datetime,sys
from zoneinfo import ZoneInfo
h,m = sys.argv[1].split(':')
now = datetime.datetime.fromisoformat(sys.argv[2].replace('Z','+00:00'))
local = now.astimezone(ZoneInfo(sys.argv[3]))
d = local.replace(hour=int(h),minute=int(m),second=0,microsecond=0)
print(d.astimezone(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%S.000Z'))" "$2" "$1" "$BUSINESS_TZ" >> "$HB"; }
# "the machine woke N minutes ago" — the Case B shape. Anchored to the FIXED
# instant, not to the host clock, so the test means the same thing whenever and
# wherever it runs.
beat_ago() { python3 -c "
import datetime,sys
now = datetime.datetime.fromisoformat(sys.argv[2].replace('Z','+00:00'))
d = now - datetime.timedelta(minutes=int(sys.argv[1]))
print(d.astimezone(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%S.000Z'))" "$1" "$FIXED_NOW" >> "$HB"; }

check_at() { # instant name expected_state expected_eligible expected_alert
  local when="$1"; shift
  local out state elig alert
  out=$(cd "$ROOT" && PIPELINE_RUNS_DB="$DB" SCHEDULER_HEARTBEAT_FILE="$HB" \
        SCHEDULER_TEST_NOW="$when" \
        npx tsx packages/pipeline-runs/bin/daily-run-status.ts --json 2>/dev/null)
  state=$(echo "$out" | python3 -c 'import json,sys;print(json.load(sys.stdin)["state"])')
  elig=$(echo  "$out" | python3 -c 'import json,sys;print(str(json.load(sys.stdin)["eligibleToRun"]).lower())')
  alert=$(echo "$out" | python3 -c 'import json,sys;print(str(json.load(sys.stdin)["shouldAlert"]).lower())')
  if [ "$state" = "$2" ] && [ "$elig" = "$3" ] && [ "$alert" = "$4" ]; then
    printf "  PASS  %-52s state=%-16s eligible=%-5s alert=%s\n" "$1" "$state" "$elig" "$alert"; PASS=$((PASS+1))
  else
    printf "  FAIL  %-52s got state=%s eligible=%s alert=%s (wanted %s/%s/%s)\n" \
      "$1" "$state" "$elig" "$alert" "$2" "$3" "$4"; FAIL=$((FAIL+1))
  fi
}

check() { # name expected_state expected_eligible expected_alert
  local out state elig alert
  out=$(cd "$ROOT" && PIPELINE_RUNS_DB="$DB" SCHEDULER_HEARTBEAT_FILE="$HB" \
        SCHEDULER_TEST_NOW="$FIXED_NOW" \
        npx tsx packages/pipeline-runs/bin/daily-run-status.ts --json 2>/dev/null)
  state=$(echo "$out" | python3 -c 'import json,sys;print(json.load(sys.stdin)["state"])')
  elig=$(echo  "$out" | python3 -c 'import json,sys;print(str(json.load(sys.stdin)["eligibleToRun"]).lower())')
  alert=$(echo "$out" | python3 -c 'import json,sys;print(str(json.load(sys.stdin)["shouldAlert"]).lower())')
  if [ "$state" = "$2" ] && [ "$elig" = "$3" ] && [ "$alert" = "$4" ]; then
    printf "  PASS  %-52s state=%-14s eligible=%-5s alert=%s\n" "$1" "$state" "$elig" "$alert"; PASS=$((PASS+1))
  else
    printf "  FAIL  %-52s got state=%s eligible=%s alert=%s ; want %s/%s/%s\n" "$1" "$state" "$elig" "$alert" "$2" "$3" "$4"; FAIL=$((FAIL+1))
  fi
}

NOW_H=$(python3 -c "
import datetime,sys
from zoneinfo import ZoneInfo
now = datetime.datetime.fromisoformat(sys.argv[1].replace('Z','+00:00'))
print(now.astimezone(ZoneInfo(sys.argv[2])).strftime('%H'))" "$FIXED_NOW" "$BUSINESS_TZ")
echo "Scheduler case matrix (throwaway DB, dry-run only)"
echo "fixed clock: $FIXED_NOW  ==  $TODAY $NOW_H:00 $BUSINESS_TZ  (host clock unused)"
echo

reset; beat "04:35"
check "Case A  awake since 04:35, run missing"            missing        true  true

reset; beat_ago 3
check "Case B  asleep through 04:30, woke 3min ago"       no_opportunity true  false

reset; add_run "04:30" success "05:03"; beat "04:35"
check "Case C  already succeeded -> no duplicate"         success        false false

reset; add_run "04:30" failed "04:35"; beat "04:35"
check "Case D  failed != never ran"                       failed         false true

reset; add_run "04:30" running; beat "04:35"
check "Case E  running >90min -> stale/orphaned"          stale          false true

reset; beat "04:35"; beat "05:30"
check "Case F  opportunity elapsed, still nothing"        missing        true  true

reset
check "Edge    scheduler never ran -> no false alarm"     no_opportunity true  false

reset; add_run "$NOW_H:00" running; beat "04:35"
check "Edge    just-started run is healthy, not stale"    running        false false

echo
echo "── the scheduler script itself, on the Case C database (must NOT submit) ──"
reset; add_run "04:30" success "05:03"; beat "04:35"
run_isolated ./scripts/daily-scheduler.sh --dry-run
# EXIT STATUS FIRST. "no 'would submit' in the output" is also true when the
# script never ran — a refusal, a crash, a missing file. Awarding PASS on the
# absence of a string is the vacuous pass this check exists to prevent.
if [ "$ISO_RC" -ne 0 ]; then
  echo "  FAIL  scheduler exited $ISO_RC on an already-successful day: $ISO_OUT"; FAIL=$((FAIL+1))
elif echo "$ISO_OUT" | grep -q "would submit"; then
  echo "  FAIL  scheduler would DUPLICATE a successful day"; FAIL=$((FAIL+1))
else
  echo "  PASS  scheduler does not submit when the day already succeeded"; PASS=$((PASS+1))
fi

echo "── the scheduler script on the Case A database (must submit) ──"
reset; beat "04:35"
run_isolated ./scripts/daily-scheduler.sh --dry-run
if [ "$ISO_RC" -ne 0 ]; then
  echo "  FAIL  scheduler exited $ISO_RC on a missing run: $ISO_OUT"; FAIL=$((FAIL+1))
elif echo "$ISO_OUT" | grep -q "would submit"; then
  echo "  PASS  scheduler submits when the run is genuinely missing"; PASS=$((PASS+1))
else
  echo "  FAIL  scheduler did NOT submit a missing run: $ISO_OUT"; FAIL=$((FAIL+1))
fi

echo "── the watchdog on the Case F database (must alert) ──"
reset; beat "04:35"; beat "05:30"
run_isolated ./scripts/pipeline-watchdog.sh --dry-run
if [ "$ISO_RC" -ne 0 ]; then
  echo "  FAIL  watchdog exited $ISO_RC on a missing run: $ISO_OUT"; FAIL=$((FAIL+1))
elif echo "$ISO_OUT" | grep -q "alert=True"; then
  echo "  PASS  watchdog alerts on a missing run"; PASS=$((PASS+1))
else
  echo "  FAIL  watchdog silent on a missing run: $ISO_OUT"; FAIL=$((FAIL+1))
fi

echo "── the watchdog on the Case B database (must NOT alert) ──"
reset; beat_ago 3
run_isolated ./scripts/pipeline-watchdog.sh --dry-run
if [ "$ISO_RC" -ne 0 ]; then
  echo "  FAIL  watchdog exited $ISO_RC on a sleeping laptop: $ISO_OUT"; FAIL=$((FAIL+1))
elif echo "$ISO_OUT" | grep -q "alert=False"; then
  echo "  PASS  watchdog silent when the machine merely slept"; PASS=$((PASS+1))
else
  echo "  FAIL  watchdog false-alarmed on a sleeping laptop: $ISO_OUT"; FAIL=$((FAIL+1))
fi

echo
echo "── the calendar rule: trading days AND Sundays ──"
# Each of these is 09:00 America/Los_Angeles on its own day (16:00Z in PDT,
# 17:00Z in PST), well past the 04:30 due time and its grace, with a heartbeat
# so the machine counts as having been awake. If the day were eligible the
# verdict would be `missing`; `not_trading_day` is therefore not a vacuous pass.
reset; beat_on '2026-08-29T16:00:00.000Z' "05:00"
check_at '2026-08-29T16:00:00.000Z' "Cal 1   Saturday -> no run expected"        not_trading_day false false
reset; beat_on '2026-08-30T16:00:00.000Z' "05:00"
check_at '2026-08-30T16:00:00.000Z' "Cal 2   Sunday -> DUE (Sunday-only stages)" missing         true  true
reset; beat_on '2026-11-26T17:00:00.000Z' "05:00"
check_at '2026-11-26T17:00:00.000Z' "Cal 3   Thanksgiving (Thu) -> no run"       not_trading_day false false
reset; beat_on '2026-11-27T17:00:00.000Z' "05:00"
check_at '2026-11-27T17:00:00.000Z' "Cal 4   day after Thanksgiving -> DUE"      missing         true  true
reset; beat_on '2026-07-03T16:00:00.000Z' "05:00"
check_at '2026-07-03T16:00:00.000Z' "Cal 5   observed July 4 (Fri) -> no run"    not_trading_day false false
reset; beat_on '2027-07-04T16:00:00.000Z' "05:00"
check_at '2027-07-04T16:00:00.000Z' "Cal 6   holiday on a Sunday -> DUE"         missing         true  true

echo "── the scheduler on a NON-RUN day (must NOT submit) ──"
reset; beat_on '2026-11-26T17:00:00.000Z' "05:00"
run_isolated_at '2026-11-26T17:00:00.000Z' ./scripts/daily-scheduler.sh --dry-run
if [ "$ISO_RC" -ne 0 ]; then
  echo "  FAIL  scheduler exited $ISO_RC on a holiday: $ISO_OUT"; FAIL=$((FAIL+1))
elif echo "$ISO_OUT" | grep -q "would submit"; then
  echo "  FAIL  scheduler would submit on an NYSE holiday"; FAIL=$((FAIL+1))
else
  echo "  PASS  scheduler does not submit on a non-run day"; PASS=$((PASS+1))
fi

echo "── the watchdog on a NON-RUN day (must NOT alert) ──"
reset; beat_on '2026-11-26T17:00:00.000Z' "05:00"
run_isolated_at '2026-11-26T17:00:00.000Z' ./scripts/pipeline-watchdog.sh --dry-run
if [ "$ISO_RC" -ne 0 ]; then
  echo "  FAIL  watchdog exited $ISO_RC on a holiday: $ISO_OUT"; FAIL=$((FAIL+1))
elif echo "$ISO_OUT" | grep -q "alert=False"; then
  echo "  PASS  watchdog silent on a non-run day"; PASS=$((PASS+1))
else
  echo "  FAIL  watchdog alerted on a non-run day: $ISO_OUT"; FAIL=$((FAIL+1))
fi

echo "── the scheduler on a SUNDAY (must submit, so the Sunday-only stages run) ──"
reset; beat_on '2026-08-30T16:00:00.000Z' "05:00"
run_isolated_at '2026-08-30T16:00:00.000Z' ./scripts/daily-scheduler.sh --dry-run
if [ "$ISO_RC" -ne 0 ]; then
  echo "  FAIL  scheduler exited $ISO_RC on a Sunday: $ISO_OUT"; FAIL=$((FAIL+1))
elif echo "$ISO_OUT" | grep -q "would submit"; then
  echo "  PASS  scheduler submits on a Sunday"; PASS=$((PASS+1))
else
  echo "  FAIL  scheduler did NOT submit on a Sunday: $ISO_OUT"; FAIL=$((FAIL+1))
fi

echo
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
