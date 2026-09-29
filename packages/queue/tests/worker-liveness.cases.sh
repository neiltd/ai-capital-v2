#!/bin/bash
# BEHAVIOURAL CASES FOR scripts/lib/worker-liveness.sh.
#
# Every case runs against STUBBED primitives. Nothing here registers, starts,
# stops, kickstarts, signals or inspects a real launchd job or a real process.
# The four functions the library uses to touch the operating system are redefined
# below AFTER sourcing it, so the decision logic is the only thing under test.
#
# THE COMMAND LINES BELOW ARE THE REAL SHAPES, not conveniences. Four earlier
# versions of this file were green against helpers that were wrong:
#
#   * one put the ABSOLUTE target into launchd fixtures that in reality carry a
#     RELATIVE one, so the helper refused the actually-installed worker;
#   * the next accepted any command mentioning the target ANYWHERE, so
#     `npx vitest run <target>` — a test runner READING the file — counted as a
#     running worker;
#   * the next skipped flags without knowing which ones CONSUME a value, so
#     `node --eval <target>` and `npx --package tsx <target>` placed an option
#     VALUE in the entrypoint position and were accepted;
#   * the next inspected ONLY the PID launchd reports, and every fixture here was
#     a single process. In reality `npx` EXECS into `npm exec`, replacing that
#     process's argv, and the runtime that executes the entry point is a
#     DESCENDANT. So the whole suite was green while the real worker — loaded,
#     healthy and consuming the queue — was refused and `daily` exited 3.
#
# THE FIXTURES ARE THEREFORE PROCESS FAMILIES, with the PID/PPID relationships
# the real chain has, taken from the measured production tree:
#
#   89651   1      npm exec tsx <TARGET>                        <- launchd's PID
#   89653   89651  /usr/bin/caffeinate -i .../npx tsx <TARGET>  <- wrapper child
#   89674   89651  node .../tsx/dist/cli.mjs <TARGET>           <- tsx's own CLI
#   89680   89674  node --require ... --import ... <TARGET>      <- the RUNTIME
#
# Prints one `PASS <name>` or `FAIL <name>` line per case and exits non-zero if
# any case failed, so a caller can assert on both the count and the outcome.

set -u

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
. "$ROOT/scripts/lib/worker-liveness.sh"

TARGET="$ROOT/packages/queue/bin/worker.ts"
LABEL="com.thanapol.ai-capital.worker"

# The reviewed WRAPPER chain, spelled out. Recognised, never accepted.
EXACT='/usr/bin/caffeinate -i /opt/homebrew/bin/npx tsx'

# The reviewed RUNTIME prefix, spelled out with the real pnpm/tsx paths. This is
# the only shape that authorizes a submission.
RT_NODE='/opt/homebrew/Cellar/node/26.7.0/bin/node'
RT_PREFLIGHT="$ROOT/node_modules/.pnpm/tsx@4.22.4/node_modules/tsx/dist/preflight.cjs"
RT_LOADER="file://$ROOT/node_modules/.pnpm/tsx@4.22.4/node_modules/tsx/dist/loader.mjs"
RUNTIME="$RT_NODE --require $RT_PREFLIGHT --import $RT_LOADER"

# The family's PIDs, as measured.
P_ROOT=89651; P_WRAP=89653; P_TSXCLI=89674; P_LEAF=89680

FAILURES=0
RAN=0
check() { # name expected actual
  RAN=$((RAN + 1))
  if [ "$2" = "$3" ]; then
    echo "PASS $1"
  else
    echo "FAIL $1 — expected '$2', got '$3'"
    FAILURES=$((FAILURES + 1))
  fi
}

# ── stub state ───────────────────────────────────────────────────────────────
# NOTE ON STUB VARIABLE NAMES. The library declares locals called `line`, `pid`
# and `snap`, so a stub reading a variable of the same name would read that empty
# local instead of the fixture — dynamic scoping, which silently turned every
# case into a refusal while an earlier version of this harness was written. The
# fixtures therefore use STUB_-prefixed names throughout.
STUB_LAUNCHCTL_OUT=''   # what `launchctl list` prints; '' = the command fails
STUB_SNAPSHOT=''        # the whole `ps` snapshot; '' = the command fails
STUB_LIVE_PIDS=''       # PIDs that answer a direct per-PID query
STUB_CWD=''             # working directory reported for a live PID
STUB_RECHECK=''         # when set, what the POST-SELECTION recheck sees instead

_launchctl_list() { [ -n "$STUB_LAUNCHCTL_OUT" ] || return 1; printf '%s\n' "$STUB_LAUNCHCTL_OUT"; }
_process_snapshot() { [ -n "$STUB_SNAPSHOT" ] || return 1; printf '%s\n' "$STUB_SNAPSHOT"; }
_pid_command() {
  local q="$1" p
  for p in $STUB_LIVE_PIDS; do
    if [ "$p" = "$q" ]; then
      if [ -n "$STUB_RECHECK" ]; then printf '%s\n' "$STUB_RECHECK"; return 0; fi
      printf '%s\n' "$STUB_SNAPSHOT" | awk -v want="$q" '
        $1 == want { sub(/^[ \t]*[0-9]+[ \t]+[0-9]+[ \t]*/, ""); print; exit }'
      return 0
    fi
  done
  return 1
}
_pid_cwd() {
  local q="$1" p
  for p in $STUB_LIVE_PIDS; do
    if [ "$p" = "$q" ]; then printf '%s\n' "$STUB_CWD"; return 0; fi
  done
  return 1
}

RUNNING_DICT='{
	"LimitLoadToSessionType" = "Aqua";
	"Label" = "com.thanapol.ai-capital.worker";
	"OnDemand" = false;
	"LastExitStatus" = 0;
	"PID" = 89651;
	"Program" = "/usr/bin/caffeinate";
};'
# A LOADED-BUT-NOT-RUNNING job. `launchctl list` exits 0 and prints this; there
# is no "PID" key at all. This is the state the very first check accepted.
THROTTLED_DICT='{
	"LimitLoadToSessionType" = "Aqua";
	"Label" = "com.thanapol.ai-capital.worker";
	"OnDemand" = false;
	"LastExitStatus" = 256;
	"Program" = "/usr/bin/caffeinate";
};'

# THE REAL FAMILY, with one chosen LEAF command line.
#   $1 = the leaf's command line, $2 = cwd (default: the repository root)
arrange_family() {
  STUB_LAUNCHCTL_OUT="$RUNNING_DICT"
  STUB_RECHECK=''
  STUB_SNAPSHOT="$P_ROOT 1 npm exec tsx $TARGET
$P_WRAP $P_ROOT $EXACT $TARGET
$P_TSXCLI $P_ROOT $RT_NODE $ROOT/node_modules/.bin/../tsx/dist/cli.mjs $TARGET
$P_LEAF $P_TSXCLI $1
1 0 /sbin/launchd"
  STUB_LIVE_PIDS="$P_ROOT $P_WRAP $P_TSXCLI $P_LEAF"
  STUB_CWD="${2-$ROOT}"     # NOT ${2:-…}: an empty cwd is a distinct case
}

# The same family with NO runtime leaf at all — wrapper and tsx CLI only.
arrange_wrapper_only() {
  STUB_LAUNCHCTL_OUT="$RUNNING_DICT"
  STUB_RECHECK=''
  STUB_SNAPSHOT="$P_ROOT 1 npm exec tsx $TARGET
$P_WRAP $P_ROOT $EXACT $TARGET
$P_TSXCLI $P_ROOT $RT_NODE $ROOT/node_modules/.bin/../tsx/dist/cli.mjs $TARGET
1 0 /sbin/launchd"
  STUB_LIVE_PIDS="$P_ROOT $P_WRAP $P_TSXCLI"
  STUB_CWD="$ROOT"
}

ACCEPT="launchd:$P_LEAF"
REFUSE='1:'

# `rc:out` for a refusal case, so a wrong acceptance is visible in the report.
outcome() {
  local out rc
  out="$(find_live_worker "$TARGET" "$LABEL")"; rc=$?
  printf '%s:%s' "$rc" "$out"
}

# ═══ POSITIVE: the real family, and where the leaf may sit ═════════════════

# F. THE MEASURED PRODUCTION FAMILY. This is the case whose absence let the
#    previous version refuse a healthy worker.
arrange_family "$RUNTIME $TARGET"
check 'F-real-launchd-family-accepted' "$ACCEPT" "$(find_live_worker "$TARGET" "$LABEL")"

# The leaf may be a DIRECT CHILD of the launchd root rather than a grandchild:
# the walk proves ancestry, it does not assume a fixed depth.
STUB_LAUNCHCTL_OUT="$RUNNING_DICT"; STUB_RECHECK=''
STUB_SNAPSHOT="$P_ROOT 1 npm exec tsx $TARGET
$P_LEAF $P_ROOT $RUNTIME $TARGET
1 0 /sbin/launchd"
STUB_LIVE_PIDS="$P_ROOT $P_LEAF"; STUB_CWD="$ROOT"
check 'F-leaf-as-direct-child-accepted' "$ACCEPT" "$(find_live_worker "$TARGET" "$LABEL")"

# …and it may sit deeper than the measured tree.
STUB_LAUNCHCTL_OUT="$RUNNING_DICT"; STUB_RECHECK=''
STUB_SNAPSHOT="$P_ROOT 1 npm exec tsx $TARGET
$P_WRAP $P_ROOT $EXACT $TARGET
$P_TSXCLI $P_WRAP $RT_NODE $ROOT/node_modules/.bin/../tsx/dist/cli.mjs $TARGET
70001 $P_TSXCLI /bin/sh -c something
$P_LEAF 70001 $RUNTIME $TARGET
1 0 /sbin/launchd"
STUB_LIVE_PIDS="$P_ROOT $P_WRAP $P_TSXCLI 70001 $P_LEAF"; STUB_CWD="$ROOT"
check 'F-leaf-as-deeper-descendant-accepted' "$ACCEPT" "$(find_live_worker "$TARGET" "$LABEL")"

# A. The relative entry point with the right cwd — the transitional form.
arrange_family "$RUNTIME packages/queue/bin/worker.ts"
check 'A-installed-relative-form-correct-cwd' "$ACCEPT" "$(find_live_worker "$TARGET" "$LABEL")"

# B. The absolute entry point, which is what the installed plist carries.
arrange_family "$RUNTIME $TARGET"
check 'B-template-absolute-form' "$ACCEPT" "$(find_live_worker "$TARGET" "$LABEL")"

# A cwd reaching the same directory by another spelling still matches: both
# sides are canonicalized.
arrange_family "$RUNTIME packages/queue/bin/worker.ts" "$ROOT/packages/.."
check 'C-relative-equivalent-cwd-accepted' "$ACCEPT" "$(find_live_worker "$TARGET" "$LABEL")"

# The ABSOLUTE form needs no cwd at all: it names the checkout itself.
arrange_family "$RUNTIME $TARGET" '/Users/someone/other-checkout'
check 'C-absolute-ignores-cwd' "$ACCEPT" "$(find_live_worker "$TARGET" "$LABEL")"

# ═══ NEGATIVE: the family boundary ═════════════════════════════════════════

# A process with the EXACT accepted command line, outside the launchd family.
# This is what makes the rule an authority rather than a search.
STUB_LAUNCHCTL_OUT="$RUNNING_DICT"; STUB_RECHECK=''
STUB_SNAPSHOT="$P_ROOT 1 npm exec tsx $TARGET
$P_WRAP $P_ROOT $EXACT $TARGET
55555 1 $RUNTIME $TARGET
1 0 /sbin/launchd"
STUB_LIVE_PIDS="$P_ROOT $P_WRAP 55555"; STUB_CWD="$ROOT"
check 'F-matching-process-outside-family-refused' "$REFUSE" "$(outcome)"

# TWO matching descendants. Nobody reviewed that state, so neither is chosen.
STUB_LAUNCHCTL_OUT="$RUNNING_DICT"; STUB_RECHECK=''
STUB_SNAPSHOT="$P_ROOT 1 npm exec tsx $TARGET
$P_LEAF $P_ROOT $RUNTIME $TARGET
70002 $P_ROOT $RUNTIME $TARGET
1 0 /sbin/launchd"
STUB_LIVE_PIDS="$P_ROOT $P_LEAF 70002"; STUB_CWD="$ROOT"
check 'F-two-matching-descendants-refused' "$REFUSE" "$(outcome)"

# The wrapper chain alone, with no runtime leaf: caffeinate, npm and tsx's CLI
# all MENTION the entry point while executing something else.
arrange_wrapper_only
check 'F-wrapper-without-runtime-refused' "$REFUSE" "$(outcome)"

# tsx's own CLI is not the runtime either, even under the right node.
STUB_LAUNCHCTL_OUT="$RUNNING_DICT"; STUB_RECHECK=''
STUB_SNAPSHOT="$P_ROOT 1 npm exec tsx $TARGET
$P_TSXCLI $P_ROOT $RT_NODE $ROOT/node_modules/.bin/../tsx/dist/cli.mjs $TARGET
1 0 /sbin/launchd"
STUB_LIVE_PIDS="$P_ROOT $P_TSXCLI"; STUB_CWD="$ROOT"
check 'F-tsx-cli-is-not-the-runtime-refused' "$REFUSE" "$(outcome)"

# ═══ NEGATIVE: malformed, cyclic and incomplete snapshots ══════════════════

# The snapshot cannot be read at all.
STUB_LAUNCHCTL_OUT="$RUNNING_DICT"; STUB_SNAPSHOT=''; STUB_LIVE_PIDS="$P_ROOT"; STUB_CWD="$ROOT"
check 'S-no-snapshot-refused' "$REFUSE" "$(outcome)"

# The root launchd reports is not in the snapshot: a stale or recycled PID.
STUB_LAUNCHCTL_OUT="$RUNNING_DICT"; STUB_RECHECK=''
STUB_SNAPSHOT="70003 1 $RUNTIME $TARGET
1 0 /sbin/launchd"
STUB_LIVE_PIDS='70003'; STUB_CWD="$ROOT"
check 'S-root-absent-from-snapshot-refused' "$REFUSE" "$(outcome)"

# Non-numeric and truncated rows must not become family members.
STUB_LAUNCHCTL_OUT="$RUNNING_DICT"; STUB_RECHECK=''
STUB_SNAPSHOT="not-a-pid also-not $RUNTIME $TARGET
$P_LEAF
$P_ROOT 1 npm exec tsx $TARGET
1 0 /sbin/launchd"
STUB_LIVE_PIDS="$P_ROOT $P_LEAF"; STUB_CWD="$ROOT"
check 'S-malformed-rows-refused' "$REFUSE" "$(outcome)"

# A PARENT CYCLE must end the walk rather than spin, and must not admit anyone.
STUB_LAUNCHCTL_OUT="$RUNNING_DICT"; STUB_RECHECK=''
STUB_SNAPSHOT="$P_ROOT 1 npm exec tsx $TARGET
70004 70005 $RUNTIME $TARGET
70005 70004 /bin/sh -c loop
1 0 /sbin/launchd"
STUB_LIVE_PIDS="$P_ROOT 70004 70005"; STUB_CWD="$ROOT"
check 'S-cyclic-ancestry-refused' "$REFUSE" "$(outcome)"

# ═══ NEGATIVE: the POST-SELECTION recheck ══════════════════════════════════
# Everything before it came from one snapshot. A PID reissued between the
# snapshot and the decision answers with a different command line.
arrange_family "$RUNTIME $TARGET"
STUB_RECHECK='/usr/sbin/some-unrelated-daemon --serve'
check 'R-recheck-command-changed-refused' "$REFUSE" "$(outcome)"

arrange_family "$RUNTIME $TARGET"
STUB_LIVE_PIDS="$P_ROOT $P_WRAP $P_TSXCLI"   # the leaf is gone by recheck time
check 'R-recheck-pid-gone-refused' "$REFUSE" "$(outcome)"

# ═══ NEGATIVE: an OPTION VALUE in the entrypoint position ══════════════════
# The generic parser skipped anything starting with `-` without knowing which
# options consume the next token. `--eval` and `--require` mean the target is
# being READ rather than run; `--title` merely renames the process.

arrange_family "$RT_NODE --title $TARGET"
check 'N-node-title-option-value' "$REFUSE" "$(outcome)"

arrange_family "$RT_NODE --eval $TARGET"
check 'N-node-eval-option-value' "$REFUSE" "$(outcome)"

arrange_family "$RT_NODE --require $TARGET"
check 'N-node-require-option-value' "$REFUSE" "$(outcome)"

arrange_family "tsx --eval $TARGET"
check 'N-tsx-eval-option-value' "$REFUSE" "$(outcome)"

arrange_family "/opt/homebrew/bin/npx --package tsx $TARGET"
check 'N-npx-package-option-value' "$REFUSE" "$(outcome)"

arrange_family "/usr/bin/caffeinate -i /opt/homebrew/bin/npx --package tsx $TARGET"
check 'N-caffeinate-npx-package-option-value' "$REFUSE" "$(outcome)"

# The reviewed options with the target as one of their VALUES rather than last.
arrange_family "$RT_NODE --require $TARGET --import $RT_LOADER $TARGET"
check 'N-require-value-is-the-target' "$REFUSE" "$(outcome)"

arrange_family "$RT_NODE --require $RT_PREFLIGHT --import $TARGET $TARGET"
check 'N-import-value-is-the-target' "$REFUSE" "$(outcome)"

# ═══ NEGATIVE: alternate launchers, deliberately unsupported ═══════════════
# These would in fact run the worker, but no production contract produces them,
# and admitting "plausible" chains is what let earlier defects through.

arrange_family "/opt/homebrew/bin/tsx $TARGET"
check 'N-direct-tsx-unsupported' "$REFUSE" "$(outcome)"

arrange_family "/opt/homebrew/bin/node --import tsx $TARGET"
check 'N-node-import-tsx-unsupported' "$REFUSE" "$(outcome)"

# ═══ NEGATIVE: same shape, WRONG ENTRY POINT ══════════════════════════════

arrange_family "/opt/homebrew/bin/npx vitest $TARGET"
check 'N-npx-other-tool-on-target' "$REFUSE" "$(outcome)"

arrange_family "/opt/homebrew/bin/npx tsx /private/tmp/not-a-worker.ts $TARGET"
check 'N-npx-tsx-other-entry-target-as-arg' "$REFUSE" "$(outcome)"

arrange_family "$RT_NODE /private/tmp/not-a-worker.js $TARGET"
check 'N-node-other-entry-target-as-arg' "$REFUSE" "$(outcome)"

arrange_family "$RUNTIME $TARGET --flag"
check 'N-target-followed-by-extra-args' "$REFUSE" "$(outcome)"

arrange_family "/opt/homebrew/bin/npx tsc --noEmit $TARGET"
check 'N-typechecker-reading-the-file' "$REFUSE" "$(outcome)"

arrange_family "grep -f $TARGET"
check 'N-grep-wrong-runtime' "$REFUSE" "$(outcome)"

arrange_family "tail -f $TARGET"
check 'N-tail-wrong-runtime' "$REFUSE" "$(outcome)"

# ═══ NEGATIVE: impostor executables and drifted reviewed values ════════════

arrange_family "/tmp/fake/caffeinate -i /opt/homebrew/bin/npx tsx $TARGET"
check 'N-impostor-caffeinate-path' "$REFUSE" "$(outcome)"

arrange_family "/usr/bin/caffeinate -i /tmp/fake/npx tsx $TARGET"
check 'N-impostor-npx-path' "$REFUSE" "$(outcome)"

# A relative `node`, which names no program on this machine in particular.
arrange_family "node --require $RT_PREFLIGHT --import $RT_LOADER $TARGET"
check 'N-relative-node-refused' "$REFUSE" "$(outcome)"

# The preflight and loader values must be the reviewed programs.
arrange_family "$RT_NODE --require /tmp/fake/preflight.cjs --import $RT_LOADER $TARGET"
check 'N-impostor-preflight-refused' "$REFUSE" "$(outcome)"

arrange_family "$RT_NODE --require $RT_PREFLIGHT --import file:///tmp/fake/loader.mjs $TARGET"
check 'N-impostor-loader-refused' "$REFUSE" "$(outcome)"

# ═══ NEGATIVE: wrong checkout and lookalike paths ══════════════════════════

arrange_family "$RUNTIME /Users/someone/other/packages/queue/bin/worker.ts"
check 'N-another-checkout-absolute' "$REFUSE" "$(outcome)"

arrange_family "$RUNTIME /Users/someone/my-packages/queue/bin/worker.ts"
check 'N-suffix-lookalike' "$REFUSE" "$(outcome)"

arrange_family "$RUNTIME packages/queue/bin/structured-worker.ts"
check 'N-other-relative-script' "$REFUSE" "$(outcome)"

arrange_family "$RUNTIME $ROOT/packages/queue/bin/structured-worker.ts"
check 'N-structured-worker-absolute-refused' "$REFUSE" "$(outcome)"

# ═══ RELATIVE FORM: the cwd proof ═══════════════════════════════════════════
# The LABEL does not prove which WorkingDirectory the loaded plist uses; a stale
# or hand-edited plist can carry the same label and point at another checkout.

arrange_family "$RUNTIME packages/queue/bin/worker.ts" '/Users/someone/other-checkout'
check 'C-relative-wrong-cwd-refused' "$REFUSE" "$(outcome)"

arrange_family "$RUNTIME packages/queue/bin/worker.ts" ''
check 'C-relative-missing-cwd-refused' "$REFUSE" "$(outcome)"

# ═══ LIVENESS: PID states and authority ════════════════════════════════════

# THE FAMILY IS PRESENT AND HEALTHY; only the PID key is missing. Isolated on
# purpose: with a launchd-only snapshot this case would also be refused for
# having no family, and a mutation that invented a PID would stay invisible.
arrange_family "$RUNTIME $TARGET"
STUB_LAUNCHCTL_OUT="$THROTTLED_DICT"
check 'L-registered-no-pid-refused' "$REFUSE" "$(outcome)"

# launchd reports a PID that is GONE, while a perfectly matching runtime runs
# elsewhere on the machine. Isolated on purpose: a snapshot with nothing in it
# would be refused for being empty, and a mutation that searched all processes
# would stay invisible.
STUB_LAUNCHCTL_OUT="$RUNNING_DICT"; STUB_RECHECK=''
STUB_SNAPSHOT="70006 1 $RUNTIME $TARGET
1 0 /sbin/launchd"
STUB_LIVE_PIDS='70006'; STUB_CWD="$ROOT"
check 'L-stale-pid-refused' "$REFUSE" "$(outcome)"

# The root PID is alive but belongs to something else entirely, with no family.
STUB_LAUNCHCTL_OUT="$RUNNING_DICT"; STUB_RECHECK=''
STUB_SNAPSHOT="$P_ROOT 1 /usr/sbin/some-unrelated-daemon --serve
1 0 /sbin/launchd"
STUB_LIVE_PIDS="$P_ROOT"; STUB_CWD="$ROOT"
check 'L-recycled-pid-refused' "$REFUSE" "$(outcome)"

# The label is not registered at all.
STUB_LAUNCHCTL_OUT=''; arrange_family "$RUNTIME $TARGET"; STUB_LAUNCHCTL_OUT=''
check 'L-label-not-registered-refused' "$REFUSE" "$(outcome)"

# ═══ MANUAL DISCOVERY IS GONE ══════════════════════════════════════════════
# A perfectly good hand-started worker is NOT admitted for a scheduled
# submission: the scheduler has one declared authority, the launchd label. An
# operator restores or kickstarts the agent instead.
STUB_LAUNCHCTL_OUT=''; STUB_RECHECK=''
STUB_SNAPSHOT="5150 1 $RUNTIME $TARGET
1 0 /sbin/launchd"
STUB_LIVE_PIDS='5150'; STUB_CWD="$ROOT"
check 'M-manual-worker-not-admitted' "$REFUSE" "$(outcome)"

echo "RAN=$RAN"
echo "FAILURES=$FAILURES"
exit $((FAILURES > 0))
