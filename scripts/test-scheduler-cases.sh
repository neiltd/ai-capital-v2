#!/bin/bash
# End-to-end scheduler case matrix, exercised through the REAL scripts.
#
# Uses a throwaway pipeline-runs database and a throwaway heartbeat file. It
# never reads or writes data/pipeline-runs.db, and never submits a pipeline —
# every invocation is --dry-run. A test that created a fake 'success' row in the
# real database would corrupt the exact record the watchdog reads.
set -uo pipefail
ROOT="/Users/thanapold/Desktop/Projects.nosync"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
DB="$TMP/pipeline-runs.db"
HB="$TMP/heartbeat.log"
PASS=0; FAIL=0

sqlite3 "$DB" "CREATE TABLE pipeline_runs (
  id TEXT PRIMARY KEY, parent_run_id TEXT, stage TEXT NOT NULL, source TEXT,
  started_at TEXT NOT NULL, ended_at TEXT, duration_ms INTEGER, status TEXT NOT NULL,
  doc_count INTEGER, chunk_count INTEGER, ticker_count INTEGER,
  error_message TEXT, error_stack TEXT, metadata_json TEXT);"

TODAY=$(date '+%Y-%m-%d')
reset() { sqlite3 "$DB" "DELETE FROM pipeline_runs;"; : > "$HB"; }
# local time -> stored UTC ISO, the way the pipeline records it
utc()  { python3 -c "
import datetime,sys
h,m = sys.argv[1].split(':')
d = datetime.datetime.now().replace(hour=int(h),minute=int(m),second=0,microsecond=0)
print(d.astimezone(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%S.000Z'))" "$1"; }
add_run()  { sqlite3 "$DB" "INSERT INTO pipeline_runs (id,stage,started_at,ended_at,status)
             VALUES ('t-$2-$1','daily-pipeline','$(utc "$1")',$( [ -n "${3:-}" ] && echo "'$(utc "$3")'" || echo NULL ),'$2');"; }
beat() { utc "$1" >> "$HB"; }
# "the machine woke N minutes ago" — the Case B shape. Anchored to NOW, not to a
# wall-clock hour, so the test means the same thing whatever time it runs.
beat_ago() { python3 -c "
import datetime,sys
d = datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(minutes=int(sys.argv[1]))
print(d.strftime('%Y-%m-%dT%H:%M:%S.000Z'))" "$1" >> "$HB"; }

check() { # name expected_state expected_eligible expected_alert
  local out state elig alert
  out=$(cd "$ROOT" && PIPELINE_RUNS_DB="$DB" SCHEDULER_HEARTBEAT_FILE="$HB" \
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

NOW_H=$(date '+%H')
echo "Scheduler case matrix (throwaway DB, dry-run only) — local hour now: $NOW_H"
echo

reset; beat "07:05"
check "Case A  awake since 07:05, run missing"            missing        true  true

reset; beat_ago 3
check "Case B  asleep through 07:00, woke 3min ago"       no_opportunity true  false

reset; add_run "07:00" success "07:33"; beat "07:05"
check "Case C  already succeeded -> no duplicate"         success        false false

reset; add_run "07:00" failed "07:05"; beat "07:05"
check "Case D  failed != never ran"                       failed         false true

reset; add_run "07:00" running; beat "07:05"
check "Case E  running >90min -> stale/orphaned"          stale          false true

reset; beat "07:05"; beat "08:00"
check "Case F  opportunity elapsed, still nothing"        missing        true  true

reset
check "Edge    scheduler never ran -> no false alarm"     no_opportunity true  false

reset; add_run "$NOW_H:00" running; beat "07:05"
check "Edge    just-started run is healthy, not stale"    running        false false

echo
echo "── the scheduler script itself, on the Case C database (must NOT submit) ──"
reset; add_run "07:00" success "07:33"; beat "07:05"
OUT=$(cd "$ROOT" && PIPELINE_RUNS_DB="$DB" SCHEDULER_HEARTBEAT_FILE="$HB" ./scripts/daily-scheduler.sh --dry-run 2>&1)
if echo "$OUT" | grep -q "would submit"; then
  echo "  FAIL  scheduler would DUPLICATE a successful day"; FAIL=$((FAIL+1))
else
  echo "  PASS  scheduler does not submit when the day already succeeded"; PASS=$((PASS+1))
fi

echo "── the scheduler script on the Case A database (must submit) ──"
reset; beat "07:05"
OUT=$(cd "$ROOT" && PIPELINE_RUNS_DB="$DB" SCHEDULER_HEARTBEAT_FILE="$HB" ./scripts/daily-scheduler.sh --dry-run 2>&1)
if echo "$OUT" | grep -q "would submit"; then
  echo "  PASS  scheduler submits when the run is genuinely missing"; PASS=$((PASS+1))
else
  echo "  FAIL  scheduler did NOT submit a missing run: $OUT"; FAIL=$((FAIL+1))
fi

echo "── the watchdog on the Case F database (must alert) ──"
reset; beat "07:05"; beat "08:00"
OUT=$(cd "$ROOT" && PIPELINE_RUNS_DB="$DB" SCHEDULER_HEARTBEAT_FILE="$HB" ./scripts/pipeline-watchdog.sh --dry-run 2>&1)
echo "$OUT" | grep -q "alert=True" && { echo "  PASS  watchdog alerts on a missing run"; PASS=$((PASS+1)); } \
                                   || { echo "  FAIL  watchdog silent on a missing run: $OUT"; FAIL=$((FAIL+1)); }

echo "── the watchdog on the Case B database (must NOT alert) ──"
reset; beat_ago 3
OUT=$(cd "$ROOT" && PIPELINE_RUNS_DB="$DB" SCHEDULER_HEARTBEAT_FILE="$HB" ./scripts/pipeline-watchdog.sh --dry-run 2>&1)
echo "$OUT" | grep -q "alert=False" && { echo "  PASS  watchdog silent when the machine merely slept"; PASS=$((PASS+1)); } \
                                    || { echo "  FAIL  watchdog false-alarmed on a sleeping laptop: $OUT"; FAIL=$((FAIL+1)); }

echo
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
