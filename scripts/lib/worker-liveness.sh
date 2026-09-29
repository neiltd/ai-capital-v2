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
#   5. The launchd PID's OWN command line was assumed to still be the plist's
#      argv. It is not, and this refused the real worker. `npx` EXECS into
#      `npm exec`, replacing the argv of the process launchd is watching, and the
#      runtime that actually executes the entry point is a DESCENDANT. Measured,
#      with the agent loaded and healthy:
#
#        89651  npm exec tsx <TARGET>                        <- launchd's PID
#        89653  /usr/bin/caffeinate -i .../npx tsx <TARGET>   <- child
#        89674  node .../tsx/dist/cli.mjs <TARGET>            <- child
#        89680  node --require .../preflight.cjs \
#                    --import file://.../loader.mjs <TARGET>  <- the RUNTIME
#
#      The five-token test looked only at 89651 and answered "no live worker", so
#      `daily` exited 3 and submitted nothing while a perfectly healthy worker was
#      consuming the queue. The rule was right and the place it looked was wrong.
#
# THE ANSWER IS NOT A BETTER OPTION PARSER, AND NOT A WIDER SEARCH. The scheduled
# admission path is launchd-only. So the authority is unchanged — one numeric PID
# from the exact reviewed label — and what widens is only WHERE inside that
# process family the entry point may be found: the launchd root and its PROVEN
# descendants, established from one process snapshot by walking each candidate's
# ancestry back to the root. A process that is not in that family cannot satisfy
# the predicate however its arguments read, which is why no `pgrep` and no global
# scan returns.
#
# AND THE ACCEPTED SHAPE IS THE RUNTIME, NOT THE WRAPPER. `caffeinate`, `npm exec`
# and `tsx`'s own CLI all MENTION the entry point while executing something else -
# exactly the class of mistake defects 3 and 4 were about. Only the node runtime
# form counts, matched as an exact token structure: six tokens, `--require` and
# `--import` spelled out with their values' reviewed suffixes, and the entry point
# last. Exactly ONE member of the family may match; zero and two are both
# refusals, because two is a state nobody reviewed.
#
# A CHANGED tsx OR node INVOCATION THEREFORE FAILS CLOSED, deliberately. That is
# configuration drift, and `daily` exiting 3 with nothing enqueued is the correct
# response to a worker this rule cannot recognise.
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

# Print one snapshot of every process as `PID PPID COMMAND`, or return non-zero.
#
# ONE SNAPSHOT, TAKEN ONCE. The family is derived from a single consistent view
# rather than from repeated `ps` calls, so a process that exits midway cannot
# make the parent map disagree with the command map.
_process_snapshot() { ps -Ao pid=,ppid=,command= 2>/dev/null; }

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

# THE ONE SUPPORTED WRAPPER CHAIN, token by token.
#
# These are the exact strings the launchd plist produces — not basenames. A
# basename test would accept /tmp/fake/caffeinate and /tmp/fake/npx, which is a
# meaningful difference when the whole point is to identify WHICH program is
# running: anyone who can drop a binary on this machine could otherwise satisfy
# the check.
#
# THE WRAPPER IS RECOGNISED BUT NEVER ACCEPTED. It is kept because it identifies
# the reviewed family from the outside, and because a family that contains no
# recognised wrapper at all is not the chain this rule was written for. What
# authorizes a submission is the RUNTIME below.
WORKER_CMD_CAFFEINATE='/usr/bin/caffeinate'
WORKER_CMD_CAFFEINATE_FLAG='-i'
WORKER_CMD_NPX='/opt/homebrew/bin/npx'
WORKER_CMD_LOADER='tsx'

# THE ONE SUPPORTED RUNTIME FORM, token by token.
#
#   node --require <…/tsx/dist/preflight.cjs> --import file://<…/tsx/dist/loader.mjs> <entry>
#   ^0   ^1        ^2                         ^3       ^4                             ^5
#
# Exactly six tokens. Both options are named literally and both consume the token
# after them, so an option VALUE can never land in the entrypoint position — the
# defect that made `node --require <TARGET>` look like a running worker. A sixth
# token followed by anything else is refused: this worker takes no arguments, so a
# trailing argument means the entry point is being passed TO something.
#
# THE VALUES ARE CHECKED BY REVIEWED SUFFIX, NOT PINNED VERSION. The real paths
# carry a pnpm store hash and a tsx version, and pinning those would make an
# ordinary dependency bump silently refuse every worker. The suffix is what says
# WHICH program is being loaded.
#
# `node` IS MATCHED BY BASENAME, and only here. Elsewhere in this file an exact
# absolute path is required, because an impostor binary would otherwise satisfy
# the test. That argument does not apply to this token: a candidate has already
# been proved to be a descendant of the PID launchd reports for the reviewed
# label, so an unrelated executable cannot reach this comparison at all. The
# node path carries a Homebrew version directory, and pinning it would break on
# every node upgrade.
WORKER_RT_REQUIRE='--require'
WORKER_RT_IMPORT='--import'
WORKER_RT_PREFLIGHT_SUFFIX='/tsx/dist/preflight.cjs'
WORKER_RT_LOADER_SUFFIX='/tsx/dist/loader.mjs'
WORKER_RT_IMPORT_SCHEME='file://'

# How far an ancestry walk may climb before it gives up. A malformed or cyclic
# snapshot must end the walk rather than spin; the real family is four deep.
WORKER_FAMILY_MAX_DEPTH=64

# Print the ENTRY POINT of the one supported wrapper chain, or return non-zero.
#
#   /usr/bin/caffeinate -i /opt/homebrew/bin/npx tsx <entrypoint>
#   ^token 0            ^1 ^2                     ^3  ^4
_worker_wrapper_entrypoint() {
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

# Print the ENTRY POINT of the one supported RUNTIME form, or return non-zero.
_worker_runtime_entrypoint() {
  local -a t
  read -r -a t <<< "$1"
  [ "${#t[@]}" -eq 6 ] || return 1
  case "${t[0]}" in
    /*/node) : ;;
    *) return 1 ;;
  esac
  [ "${t[1]}" = "$WORKER_RT_REQUIRE" ] || return 1
  case "${t[2]}" in
    /*"$WORKER_RT_PREFLIGHT_SUFFIX") : ;;
    *) return 1 ;;
  esac
  [ "${t[3]}" = "$WORKER_RT_IMPORT" ] || return 1
  case "${t[4]}" in
    "$WORKER_RT_IMPORT_SCHEME"/*"$WORKER_RT_LOADER_SUFFIX") : ;;
    *) return 1 ;;
  esac
  [ -n "${t[5]}" ] || return 1
  printf '%s' "${t[5]}"
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

# True if COMMAND $2 belonging to PID $1 is the reviewed runtime for target $3.
_command_is_expected_runtime() {
  local pid="$1" line="$2" target="$3" entry rel
  [ -n "$line" ] || return 1
  entry="$(_worker_runtime_entrypoint "$line")" || return 1

  # The absolute form needs nothing further: it names the checkout itself.
  [ "$entry" = "$target" ] && return 0

  # The transitional relative form additionally requires the cwd proof.
  rel="$(_relative_target "$target")"
  [ -n "$rel" ] || return 1
  [ "$entry" = "$rel" ] || return 1
  _cwd_matches_repo "$pid" "$target"
}

# Print `PID<TAB>COMMAND` for the launchd root and every PROVEN descendant.
#
# PROVEN MEANS WALKED, NOT ASSUMED. Each process in the snapshot climbs its own
# parent chain; it joins the family only if that chain reaches the root. There is
# no "same user" or "looks related" shortcut, so a process outside the family is
# outside it no matter what its arguments say.
#
# Returns non-zero when the root is not in the snapshot at all — a PID launchd
# reported that no longer exists, which is a refusal rather than an empty family.
# The walk is depth-bounded and marks what it has visited, so a cyclic or
# truncated snapshot ends rather than looping.
_family_rows() {
  printf '%s\n' "$1" | awk -v root="$2" -v maxdepth="$WORKER_FAMILY_MAX_DEPTH" '
    {
      pid = $1; ppid = $2
      if (pid !~ /^[0-9]+$/ || ppid !~ /^[0-9]+$/) next
      sub(/^[ \t]*[0-9]+[ \t]+[0-9]+[ \t]*/, "")
      if (length($0) == 0) next
      parent[pid] = ppid
      command[pid] = $0
      present[pid] = 1
    }
    END {
      if (!(root in present)) exit 1
      for (p in present) {
        cur = p; depth = 0; reached = 0
        delete walked
        while (depth <= maxdepth) {
          if (cur == root) { reached = 1; break }
          if (!(cur in parent)) break
          if (cur in walked) break
          walked[cur] = 1
          cur = parent[cur]
          depth++
        }
        if (reached) printf "%s\t%s\n", p, command[p]
      }
    }'
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
  local target="$1" label="$2" root snap rows row pid line
  local chosen='' chosen_line='' matches=0

  root="$(_launchd_pid "$label")" || return 1
  snap="$(_process_snapshot)" || return 1
  [ -n "$snap" ] || return 1
  rows="$(_family_rows "$snap" "$root")" || return 1
  [ -n "$rows" ] || return 1

  # EXACTLY ONE CANDIDATE. Counting every match rather than stopping at the first
  # is the point: two runtimes executing this entry point under one label is a
  # state nobody reviewed, and picking either one would hide it.
  while IFS= read -r row; do
    [ -n "$row" ] || continue
    pid="${row%%	*}"
    line="${row#*	}"
    if _command_is_expected_runtime "$pid" "$line" "$target"; then
      matches=$((matches + 1))
      chosen="$pid"
      chosen_line="$line"
    fi
  done <<< "$rows"
  [ "$matches" -eq 1 ] || return 1

  # AND RE-ASK THE OPERATING SYSTEM ABOUT IT, AFTER CHOOSING.
  #
  # Everything above came from one snapshot taken before the decision. Between
  # that snapshot and this line the process may have exited and its number been
  # reissued to something else entirely. Re-reading the command and requiring it
  # to be BYTE-IDENTICAL, then revalidating it, closes that window: a reused PID
  # answers with a different command line and fails here.
  line="$(_pid_command "$chosen")" || return 1
  [ "$line" = "$chosen_line" ] || return 1
  _command_is_expected_runtime "$chosen" "$line" "$target" || return 1

  printf 'launchd:%s' "$chosen"
}
