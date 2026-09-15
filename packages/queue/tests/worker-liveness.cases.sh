#!/bin/bash
# BEHAVIOURAL CASES FOR scripts/lib/worker-liveness.sh.
#
# Every case runs against STUBBED primitives. Nothing here registers, starts,
# stops, kickstarts, signals or inspects a real launchd job or a real process.
# The three functions the library uses to touch the operating system are
# redefined below AFTER sourcing it, so the decision logic is the only thing
# under test.
#
# THE COMMAND LINES BELOW ARE THE REAL SHAPES, not conveniences. Three earlier
# versions of this file were green against helpers that were wrong:
#
#   * one put the ABSOLUTE target into launchd fixtures that in reality carry a
#     RELATIVE one, so the helper refused the actually-installed worker;
#   * the next accepted any command mentioning the target ANYWHERE, so
#     `npx vitest run <target>` — a test runner READING the file — counted as a
#     running worker;
#   * the next skipped flags without knowing which ones CONSUME a value, so
#     `node --eval <target>` and `npx --package tsx <target>` placed an option
#     VALUE in the entrypoint position and were accepted.
#
# There is now exactly ONE supported chain and the fixtures spell it out
# literally rather than composing it from parts, so changing what the scheduler
# trusts requires editing this file too — deliberately, and in a file whose
# whole subject is that question.
#
# NOTE ON STUB VARIABLE NAMES. The library declares `local cmd` inside
# _pid_is_expected_worker, so a stub reading a variable called `cmd` would read
# that empty local instead of the fixture — dynamic scoping, and it silently
# turned every case into a refusal while this harness was being written. The
# fixtures therefore use STUB_-prefixed names.
#
# Prints one `PASS <name>` or `FAIL <name>` line per case and exits non-zero if
# any case failed, so a caller can assert on both the count and the outcome.

set -u

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
. "$ROOT/scripts/lib/worker-liveness.sh"

TARGET="$ROOT/packages/queue/bin/worker.ts"
LABEL="com.thanapol.ai-capital.worker"

# The ONE supported chain, spelled out. Anything else is configuration drift.
EXACT='/usr/bin/caffeinate -i /opt/homebrew/bin/npx tsx'

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
STUB_LAUNCHCTL_OUT=''   # what `launchctl list` prints; '' = the command fails
STUB_LIVE_PIDS=''       # space-separated PIDs that exist
STUB_CMDLINE=''         # command line reported for a live PID
STUB_CWD=''             # working directory reported for a live PID

_launchctl_list() { [ -n "$STUB_LAUNCHCTL_OUT" ] || return 1; printf '%s\n' "$STUB_LAUNCHCTL_OUT"; }
_pid_command() {
  local p
  for p in $STUB_LIVE_PIDS; do
    if [ "$p" = "$1" ]; then printf '%s\n' "$STUB_CMDLINE"; return 0; fi
  done
  return 1
}
_pid_cwd() {
  local p
  for p in $STUB_LIVE_PIDS; do
    if [ "$p" = "$1" ]; then printf '%s\n' "$STUB_CWD"; return 0; fi
  done
  return 1
}

RUNNING_DICT='{
	"LimitLoadToSessionType" = "Aqua";
	"Label" = "com.thanapol.ai-capital.worker";
	"OnDemand" = false;
	"LastExitStatus" = 0;
	"PID" = 4242;
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

# A registered, live label is the shared precondition for every command-shape
# case; only the command line (and cwd) vary.
#   $1 = command line, $2 = cwd (default: the repository root)
arrange_launchd() {
  STUB_LAUNCHCTL_OUT="$RUNNING_DICT"
  STUB_LIVE_PIDS='4242'
  STUB_CMDLINE="$1"
  STUB_CWD="${2-$ROOT}"     # NOT ${2:-…}: an empty cwd is a distinct case
}

ACCEPT='launchd:4242'
REFUSE='1:'

# `rc:out` for a refusal case, so a wrong acceptance is visible in the report.
outcome() {
  local out rc
  out="$(find_live_worker "$TARGET" "$LABEL")"; rc=$?
  printf '%s:%s' "$rc" "$out"
}

# ═══ POSITIVE: the two real transition forms ════════════════════════════════

# A. The command line the CURRENTLY INSTALLED plist produces: WorkingDirectory
#    is the repo and the entry point is a relative argument.
arrange_launchd "$EXACT packages/queue/bin/worker.ts"
check 'A-installed-relative-form-correct-cwd' "$ACCEPT" "$(find_live_worker "$TARGET" "$LABEL")"

# B. The command line the S4D TEMPLATE produces: same chain, absolute entry.
arrange_launchd "$EXACT $TARGET"
check 'B-template-absolute-form' "$ACCEPT" "$(find_live_worker "$TARGET" "$LABEL")"

# A cwd reaching the same directory by another spelling still matches: both
# sides are canonicalized.
arrange_launchd "$EXACT packages/queue/bin/worker.ts" "$ROOT/packages/.."
check 'C-relative-equivalent-cwd-accepted' "$ACCEPT" "$(find_live_worker "$TARGET" "$LABEL")"

# The ABSOLUTE form needs no cwd at all: it names the checkout itself.
arrange_launchd "$EXACT $TARGET" '/Users/someone/other-checkout'
check 'C-absolute-ignores-cwd' "$ACCEPT" "$(find_live_worker "$TARGET" "$LABEL")"

# ═══ NEGATIVE: an OPTION VALUE in the entrypoint position ══════════════════
# The generic parser skipped anything starting with `-` without knowing which
# options consume the next token. `--eval` and `--require` mean the target is
# being READ rather than run; `--title` merely renames the process.

arrange_launchd "node --title $TARGET"
check 'N-node-title-option-value' "$REFUSE" "$(outcome)"

arrange_launchd "node --eval $TARGET"
check 'N-node-eval-option-value' "$REFUSE" "$(outcome)"

arrange_launchd "node --require $TARGET"
check 'N-node-require-option-value' "$REFUSE" "$(outcome)"

arrange_launchd "tsx --eval $TARGET"
check 'N-tsx-eval-option-value' "$REFUSE" "$(outcome)"

arrange_launchd "/opt/homebrew/bin/npx --package tsx $TARGET"
check 'N-npx-package-option-value' "$REFUSE" "$(outcome)"

arrange_launchd "/usr/bin/caffeinate -i /opt/homebrew/bin/npx --package tsx $TARGET"
check 'N-caffeinate-npx-package-option-value' "$REFUSE" "$(outcome)"

# ═══ NEGATIVE: alternate launchers, deliberately unsupported ═══════════════
# These would in fact run the worker, but no production contract produces them,
# and admitting "plausible" chains is what let the previous two defects through.

arrange_launchd "/opt/homebrew/bin/tsx $TARGET"
check 'N-direct-tsx-unsupported' "$REFUSE" "$(outcome)"

arrange_launchd "/opt/homebrew/bin/node --import tsx $TARGET"
check 'N-node-import-tsx-unsupported' "$REFUSE" "$(outcome)"

# ═══ NEGATIVE: same shape, WRONG ENTRY POINT ══════════════════════════════

arrange_launchd "/opt/homebrew/bin/npx vitest $TARGET"
check 'N-npx-other-tool-on-target' "$REFUSE" "$(outcome)"

arrange_launchd "/opt/homebrew/bin/npx tsx /private/tmp/not-a-worker.ts $TARGET"
check 'N-npx-tsx-other-entry-target-as-arg' "$REFUSE" "$(outcome)"

arrange_launchd "node /private/tmp/not-a-worker.js $TARGET"
check 'N-node-other-entry-target-as-arg' "$REFUSE" "$(outcome)"

arrange_launchd "$EXACT $TARGET --flag"
check 'N-target-followed-by-extra-args' "$REFUSE" "$(outcome)"

arrange_launchd "/opt/homebrew/bin/npx tsc --noEmit $TARGET"
check 'N-typechecker-reading-the-file' "$REFUSE" "$(outcome)"

arrange_launchd "grep -f $TARGET"
check 'N-grep-wrong-runtime' "$REFUSE" "$(outcome)"

arrange_launchd "tail -f $TARGET"
check 'N-tail-wrong-runtime' "$REFUSE" "$(outcome)"

# ═══ NEGATIVE: impostor executables at the right positions ════════════════
# Basename matching would accept both. Anyone able to drop a binary on this
# machine could otherwise satisfy the check.

arrange_launchd "/tmp/fake/caffeinate -i /opt/homebrew/bin/npx tsx $TARGET"
check 'N-impostor-caffeinate-path' "$REFUSE" "$(outcome)"

arrange_launchd "/usr/bin/caffeinate -i /tmp/fake/npx tsx $TARGET"
check 'N-impostor-npx-path' "$REFUSE" "$(outcome)"

# ═══ NEGATIVE: wrong checkout and lookalike paths ══════════════════════════

arrange_launchd "$EXACT /Users/someone/other/packages/queue/bin/worker.ts"
check 'N-another-checkout-absolute' "$REFUSE" "$(outcome)"

arrange_launchd "$EXACT /Users/someone/my-packages/queue/bin/worker.ts"
check 'N-suffix-lookalike' "$REFUSE" "$(outcome)"

arrange_launchd "$EXACT packages/queue/bin/structured-worker.ts"
check 'N-other-relative-script' "$REFUSE" "$(outcome)"

# ═══ RELATIVE FORM: the cwd proof ═══════════════════════════════════════════
# The LABEL does not prove which WorkingDirectory the loaded plist uses; a stale
# or hand-edited plist can carry the same label and point at another checkout.

arrange_launchd "$EXACT packages/queue/bin/worker.ts" '/Users/someone/other-checkout'
check 'C-relative-wrong-cwd-refused' "$REFUSE" "$(outcome)"

arrange_launchd "$EXACT packages/queue/bin/worker.ts" ''
check 'C-relative-missing-cwd-refused' "$REFUSE" "$(outcome)"

# ═══ LIVENESS: PID states ═══════════════════════════════════════════════════

STUB_LAUNCHCTL_OUT="$THROTTLED_DICT"; STUB_LIVE_PIDS=''; STUB_CMDLINE=''; STUB_CWD="$ROOT"
check 'L-registered-no-pid-refused' "$REFUSE" "$(outcome)"

# launchd reports a PID, but the process is gone.
arrange_launchd "$EXACT $TARGET"
STUB_LIVE_PIDS=''
check 'L-stale-pid-refused' "$REFUSE" "$(outcome)"

# The PID is alive but belongs to something else entirely (recycled PID).
arrange_launchd '/usr/sbin/some-unrelated-daemon --serve'
check 'L-recycled-pid-refused' "$REFUSE" "$(outcome)"

# The label is not registered at all.
STUB_LAUNCHCTL_OUT=''; STUB_LIVE_PIDS='4242'; STUB_CMDLINE="$EXACT $TARGET"; STUB_CWD="$ROOT"
check 'L-label-not-registered-refused' "$REFUSE" "$(outcome)"

# ═══ MANUAL DISCOVERY IS GONE ══════════════════════════════════════════════
# A perfectly good hand-started worker is NOT admitted for a scheduled
# submission: the scheduler has one declared authority, the launchd label. An
# operator restores or kickstarts the agent instead.
STUB_LAUNCHCTL_OUT=''; STUB_LIVE_PIDS='5150'; STUB_CMDLINE="$EXACT $TARGET"; STUB_CWD="$ROOT"
check 'M-manual-worker-not-admitted' "$REFUSE" "$(outcome)"

echo "RAN=$RAN"
echo "FAILURES=$FAILURES"
exit $((FAILURES > 0))
