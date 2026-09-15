#!/bin/bash
# ONE AUTHORITY, ONE LIVE PROCESS, ONE ENTRY POINT.
#
# daily-queue.sh may submit a flow only when the expected worker is genuinely
# executing packages/queue/bin/worker.ts. Three earlier versions of this file
# each accepted something weaker, and each gap was reproduced rather than
# reasoned about:
#
#   1. `launchctl list <label>` exiting 0 was treated as proof. It is not: a job
#      that crashed and is waiting out its ThrottleInterval, one that exited
#      non-zero, and one that has never run all exit 0 and print a dict with no
#      "PID" key at all.
#   2. The absolute target was required to appear in the command line, which
#      refused the ACTUALLY INSTALLED worker — its plist sets WorkingDirectory
#      and passes a relative argument.
#   3. Any command whose first word looked like a runtime and which mentioned
#      the target ANYWHERE was accepted. So these all counted as a live worker:
#
#        npx tsx /private/tmp/not-a-worker.ts  <TARGET>
#        node    /private/tmp/not-a-worker.js  <TARGET>
#        npx vitest run                        <TARGET>
#        caffeinate -i npx tsx /other.ts       <TARGET>
#        caffeinate -i npx tsx <TARGET> --flag
#
#      In every one of those the target is an ARGUMENT, not the program being
#      run. A test runner reading the worker file is not a worker.
#
#   4. The chain was parsed generically — an optional `caffeinate` prefix, a
#      runtime, then "skip anything starting with -". That parser does not know
#      which options CONSUME the next token, so an option VALUE landed in the
#      entrypoint position and every one of these was accepted:
#
#        node --title  <TARGET>      node --eval    <TARGET>
#        node --require <TARGET>     tsx  --eval    <TARGET>
#        npx  --package tsx <TARGET>
#        caffeinate -i npx --package tsx <TARGET>
#
#      `--eval` and `--require` in particular mean the target is being READ, not
#      run, and `--title` merely renames the process.
#
# THE ANSWER IS NOT A BETTER OPTION PARSER. The scheduled admission path is
# launchd-only and has exactly ONE supported command chain — the one the plist
# template produces. So the command line is matched as an EXACT TOKEN STRUCTURE:
# five tokens, three of them exact absolute paths, one exact literal, and the
# entrypoint last. Anything else — a different runtime, an extra flag, an extra
# argument, a `caffeinate` from somewhere other than /usr/bin — is configuration
# drift and fails closed. Supporting hypothetical alternate launchers would
# reintroduce exactly the ambiguity that produced defects 3 and 4, and no
# production contract asks for them.
#
# MANUAL-WORKER DISCOVERY WAS REMOVED, DELIBERATELY.
# The scheduler has exactly one declared authority: the launchd label. A
# hand-started worker does not need to authorize an automatic scheduled
# submission — an operator who wants the scheduled run to proceed can restore or
# kickstart the agent. Repository evidence supports this rather than merely
# permitting it: CLAUDE.md documents the manual worker as
# `pnpm --filter @common/queue worker`, whose command line is `tsx bin/worker.ts`
# from inside the package and so states neither supported form; and
# packages/queue/src/submit.ts records the same principle from the other side —
# "a manual run must never silently become the scheduled run". The pre-S4D
# pgrep branch existed only as scaffolding for the nohup fallback that S4D
# removed. With `pgrep -f` gone, an entire class of false positive — any process
# on the machine whose arguments happen to contain this path — is gone with it.
#
# WHY A SOURCED LIBRARY. The three primitives below are the only points that
# touch the operating system. A test sources this file and redefines them, which
# lets every combination be exercised — registered but dead, stale PID, wrong
# entry point, wrong checkout — without registering, starting, stopping,
# signalling or inspecting any real launchd job or process. The production path
# calls the real commands; nothing is selected by an environment variable, so no
# inherited environment can swap in a different implementation.

# ── OS primitives (the only three; tests redefine exactly these) ─────────────

# Print the `launchctl list` output for a label, or return non-zero.
_launchctl_list() { launchctl list "$1" 2>/dev/null; }

# Print the full command line of a live PID, or return non-zero if it is gone.
_pid_command() { ps -o command= -p "$1" 2>/dev/null; }

# Print the current working directory of a live PID, or nothing.
_pid_cwd() { lsof -a -d cwd -p "$1" -Fn 2>/dev/null | sed -n 's/^n//p' | head -1; }

# ── pure helpers ────────────────────────────────────────────────────────────

# ── pure helpers ────────────────────────────────────────────────────────────

# The repository-relative form of an absolute worker target:
#   /repo/packages/queue/bin/worker.ts -> packages/queue/bin/worker.ts
# Empty when the target does not sit under a `packages/` directory, so a
# malformed target can never widen what is accepted.
_relative_target() {
  case "$1" in
    */packages/*) printf 'packages/%s' "${1##*/packages/}" ;;
    *) printf '' ;;
  esac
}

# The repository root implied by an absolute worker target.
_repo_root_of() {
  case "$1" in
    */packages/*) printf '%s' "${1%/packages/*}" ;;
    *) printf '' ;;
  esac
}

# Resolve a directory to its physical path; fall back to the literal string so a
# path that does not exist compares unequal rather than disappearing.
_canonical_dir() {
  [ -n "$1" ] || return 1
  (cd "$1" 2>/dev/null && pwd -P) || printf '%s' "$1"
}

# THE ONE SUPPORTED COMMAND CHAIN, token by token.
#
# These are the exact strings the launchd plist produces — not basenames. A
# basename test would accept /tmp/fake/caffeinate and /tmp/fake/npx, which is a
# meaningful difference when the whole point is to identify WHICH program is
# running: anyone who can drop a binary on this machine could otherwise satisfy
# the check.
WORKER_CMD_CAFFEINATE='/usr/bin/caffeinate'
WORKER_CMD_CAFFEINATE_FLAG='-i'
WORKER_CMD_NPX='/opt/homebrew/bin/npx'
WORKER_CMD_LOADER='tsx'

# Print the ENTRY POINT of the one supported chain, or return non-zero.
#
#   /usr/bin/caffeinate -i /opt/homebrew/bin/npx tsx <entrypoint>
#   ^token 0            ^1 ^2                     ^3  ^4
#
# Exactly five tokens. No flags are skipped, because no flags are permitted:
# every option in the real chain is already spelled out above. A fifth token
# followed by anything else is refused — this worker takes no CLI arguments, so
# a trailing argument means the target is being passed TO something rather than
# run BY it.
_worker_entrypoint() {
  local -a t
  read -r -a t <<< "$1"
  [ "${#t[@]}" -eq 5 ] || return 1
  [ "${t[0]}" = "$WORKER_CMD_CAFFEINATE" ] || return 1
  [ "${t[1]}" = "$WORKER_CMD_CAFFEINATE_FLAG" ] || return 1
  [ "${t[2]}" = "$WORKER_CMD_NPX" ] || return 1
  [ "${t[3]}" = "$WORKER_CMD_LOADER" ] || return 1
  [ -n "${t[4]}" ] || return 1
  printf '%s' "${t[4]}"
}

# True if PID $1's working directory is exactly the repository that $2 names.
#
# The launchd LABEL does not prove which WorkingDirectory the loaded plist uses:
# a stale or hand-edited plist can carry the same label and point at another
# checkout. A relative entry point is meaningless without that proof, so the
# transitional relative form is accepted only when the live process's own cwd
# canonicalizes to the repository root derived from the absolute target.
_cwd_matches_repo() {
  local pid="$1" target="$2" want actual
  want="$(_repo_root_of "$target")"
  [ -n "$want" ] || return 1
  want="$(_canonical_dir "$want")" || return 1
  actual="$(_pid_cwd "$pid")" || return 1
  [ -n "$actual" ] || return 1
  actual="$(_canonical_dir "$actual")" || return 1
  [ "$actual" = "$want" ]
}

# True if PID $1 is alive AND is genuinely running the expected target $2.
_pid_is_expected_worker() {
  local pid="$1" target="$2" line entry
  line="$(_pid_command "$pid")" || return 1
  [ -n "$line" ] || return 1
  entry="$(_worker_entrypoint "$line")" || return 1

  # The absolute form needs nothing further: it names the checkout itself.
  [ "$entry" = "$target" ] && return 0

  # The transitional relative form additionally requires the cwd proof.
  local rel
  rel="$(_relative_target "$target")"
  [ -n "$rel" ] || return 1
  [ "$entry" = "$rel" ] || return 1
  _cwd_matches_repo "$pid" "$target"
}

# Extract a numeric PID from a `launchctl list` dict. A loaded-but-not-running
# job prints no "PID" key, and launchd prints "-" for a job that has exited.
_launchd_pid() {
  local label="$1" out pid
  out="$(_launchctl_list "$label")" || return 1
  [ -n "$out" ] || return 1
  pid="$(printf '%s\n' "$out" | awk '/"PID"/{gsub(/[",;]/,"",$3); print $3; exit}')"
  case "$pid" in
    ''|*[!0-9]*) return 1 ;;
  esac
  printf '%s' "$pid"
}

# Print "launchd:<pid>" for the live, correctly-identified worker belonging to
# the expected label; return 1 when there is none.
# $1 = ABSOLUTE worker target, $2 = launchd label.
find_live_worker() {
  local target="$1" label="$2" pid
  pid="$(_launchd_pid "$label")" || return 1
  _pid_is_expected_worker "$pid" "$target" || return 1
  printf 'launchd:%s' "$pid"
}
