// THE SCHEDULER'S ADMISSION RULE: one authority, one live process, one entry point.
//
// daily-queue.sh may submit a flow only when the expected worker is genuinely
// EXECUTING packages/queue/bin/worker.ts. Three successive versions of that rule
// were each too weak, and each gap was reproduced against the real helper rather
// than argued about:
//
//   1. `launchctl list <label>` exiting 0 was treated as proof of a running
//      worker. It exits 0 for a job that is merely loaded and has no PID key.
//   2. The absolute target was required in the command line, which refused the
//      ACTUALLY INSTALLED worker — its plist passes a relative argument under
//      WorkingDirectory.
//   3. Any command whose first word looked like a runtime and which mentioned
//      the target anywhere was accepted, so `npx vitest run <target>` and
//      `npx tsx /other.ts <target>` both counted as a live worker.
//   4. The chain was parsed generically, skipping anything starting with `-`
//      without knowing which options CONSUME the next token — so `node --eval
//      <target>`, `node --require <target>` and `npx --package tsx <target>`
//      put an option VALUE in the entrypoint position and were accepted.
//   5. Only the PID launchd reports was inspected, and every fixture was ONE
//      process. `npx` execs into `npm exec`, replacing that process's argv, and
//      the runtime that executes the entry point is a DESCENDANT — so the suite
//      was green while the real, healthy worker was refused and `daily` exited 3
//      with nothing enqueued. Measured against the loaded agent.
//
// The authority is unchanged — one numeric PID from the exact reviewed label —
// and the search is now the launchd root plus its PROVEN descendants, with the
// node RUNTIME form as the only accepted shape and exactly one match required.
//
// The decision now lives in scripts/lib/worker-liveness.sh and is exercised by
// tests/worker-liveness.cases.sh, which sources that library and REDEFINES the
// three functions that touch the operating system. No launchd job is registered,
// started, stopped, kickstarted or inspected; no real process is signalled or
// read; no database or queue is contacted.
import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const CASES = fileURLToPath(new URL('./worker-liveness.cases.sh', import.meta.url))
const SCHEDULER = fileURLToPath(new URL('../../../daily-queue.sh', import.meta.url))
const LIBRARY = fileURLToPath(new URL('../../../scripts/lib/worker-liveness.sh', import.meta.url))

const out = execFileSync('bash', [CASES], { encoding: 'utf-8', timeout: 30_000 })
const lines = out.trim().split('\n')
const named = (name: string) => lines.find(l => l === `PASS ${name}` || l.startsWith(`FAIL ${name} `))

/** Every case the harness must contain, by name. */
const POSITIVE = [
  ['F-real-launchd-family-accepted', 'the MEASURED production family'],
  ['F-leaf-as-direct-child-accepted', 'the runtime as a direct child of the root'],
  ['F-leaf-as-deeper-descendant-accepted', 'the runtime deeper than the measured tree'],
  ['A-installed-relative-form-correct-cwd', 'the relative form, with the right cwd'],
  ['B-template-absolute-form', 'the absolute form the installed plist carries'],
  ['C-relative-equivalent-cwd-accepted', 'a differently-spelled but equivalent cwd'],
  ['C-absolute-ignores-cwd', 'the absolute form, which needs no cwd proof'],
] as const

const NEGATIVE = [
  // The family boundary — what makes this an authority rather than a search.
  ['F-matching-process-outside-family-refused', 'an exact match outside the launchd family'],
  ['F-two-matching-descendants-refused', 'two matching descendants'],
  ['F-wrapper-without-runtime-refused', 'the wrapper chain with no runtime leaf'],
  ['F-tsx-cli-is-not-the-runtime-refused', "tsx's own CLI under the right node"],
  // Snapshots that cannot be trusted.
  ['S-no-snapshot-refused', 'no process snapshot at all'],
  ['S-root-absent-from-snapshot-refused', 'a root PID missing from the snapshot'],
  ['S-malformed-rows-refused', 'non-numeric and truncated rows'],
  ['S-cyclic-ancestry-refused', 'a parent cycle'],
  // The post-selection recheck.
  ['R-recheck-command-changed-refused', 'a PID whose command changed after selection'],
  ['R-recheck-pid-gone-refused', 'a PID that vanished after selection'],
  // An option VALUE landing in the entrypoint position — the Round-4 defect.
  ['N-node-title-option-value', 'node --title <target>'],
  ['N-node-eval-option-value', 'node --eval <target>'],
  ['N-node-require-option-value', 'node --require <target>'],
  ['N-tsx-eval-option-value', 'tsx --eval <target>'],
  ['N-npx-package-option-value', 'npx --package tsx <target>'],
  ['N-caffeinate-npx-package-option-value', 'caffeinate -i npx --package tsx <target>'],
  ['N-require-value-is-the-target', 'the reviewed --require with the target as its value'],
  ['N-import-value-is-the-target', 'the reviewed --import with the target as its value'],
  // Alternate launchers that would work but that no plist produces.
  ['N-direct-tsx-unsupported', 'a direct tsx invocation'],
  ['N-node-import-tsx-unsupported', 'node --import tsx <target>'],
  // Right shape, wrong entry point.
  ['N-npx-other-tool-on-target', 'npx running another tool on the target'],
  ['N-npx-tsx-other-entry-target-as-arg', 'npx tsx <other entry> <target>'],
  ['N-node-other-entry-target-as-arg', 'node <other entry> <target>'],
  ['N-target-followed-by-extra-args', 'the exact runtime followed by an extra argument'],
  ['N-typechecker-reading-the-file', 'a typechecker reading the file'],
  ['N-grep-wrong-runtime', 'grep'],
  ['N-tail-wrong-runtime', 'tail'],
  // Impostor executables and drifted reviewed values.
  ['N-impostor-caffeinate-path', '/tmp/fake/caffeinate instead of /usr/bin/caffeinate'],
  ['N-impostor-npx-path', '/tmp/fake/npx instead of /opt/homebrew/bin/npx'],
  ['N-relative-node-refused', 'a relative `node`, which names no program in particular'],
  ['N-impostor-preflight-refused', 'a --require value that is not the reviewed preflight'],
  ['N-impostor-loader-refused', 'an --import value that is not the reviewed loader'],
  // Wrong checkout / lookalike / wrong script.
  ['N-another-checkout-absolute', "another checkout's absolute worker path"],
  ['N-suffix-lookalike', 'a path that merely ends in the same suffix'],
  ['N-other-relative-script', 'a different relative script under the same label'],
  ['N-structured-worker-absolute-refused', 'the structured worker, absolute'],
  // The cwd proof for the relative form.
  ['C-relative-wrong-cwd-refused', 'the relative form with another checkout as cwd'],
  ['C-relative-missing-cwd-refused', 'the relative form with no readable cwd'],
  // PID states and authority.
  ['L-registered-no-pid-refused', 'a registered job with no PID key'],
  ['L-stale-pid-refused', 'a PID launchd reports that no longer exists'],
  ['L-recycled-pid-refused', 'a live PID running something else'],
  ['L-label-not-registered-refused', 'a label that is not registered'],
  ['M-manual-worker-not-admitted', 'a hand-started worker, which no longer authorizes a scheduled run'],
] as const

describe('accepted command shapes', () => {
  it.each(POSITIVE)('%s — %s', (name) => {
    expect(named(name), `case ${name} did not run`).toBeDefined()
    expect(named(name)).toBe(`PASS ${name}`)
  })
})

describe('refused command shapes', () => {
  it.each(NEGATIVE)('%s — %s', (name) => {
    expect(named(name), `case ${name} did not run`).toBeDefined()
    expect(named(name)).toBe(`PASS ${name}`)
  })
})

describe('the harness itself', () => {
  it('ran every case it defines, and all of them passed', () => {
    expect(out).toContain('FAILURES=0')
    const ran = Number(/RAN=(\d+)/.exec(out)?.[1])
    // Non-vacuity: the per-case lookups above would also be satisfied by a
    // harness that printed nothing, so the count is pinned from the harness's
    // own counter AND from the printed lines.
    expect(ran).toBe(POSITIVE.length + NEGATIVE.length)
    expect(lines.filter(l => l.startsWith('PASS ')).length).toBe(ran)
  })
})

describe('daily-queue.sh admits only the launchd worker', () => {
  const src = readFileSync(SCHEDULER, 'utf-8')
  const code = src.split('\n').filter(l => !/^\s*#/.test(l)).join('\n')

  it('delegates the decision to the shared liveness library', () => {
    expect(code).toContain('worker-liveness.sh')
    expect(code).toContain('find_live_worker')
  })

  it('no longer treats a bare `launchctl list` as proof', () => {
    expect(code).not.toMatch(/if\s+launchctl list/)
  })

  it('does not discover a worker with pgrep', () => {
    expect(code).not.toMatch(/\bpgrep\b/)
  })

  it('starts no worker of its own', () => {
    expect(code).not.toMatch(/nohup|disown|caffeinate/)
    expect(code).toContain('LAUNCHD_LABEL=')
  })

  it('exits before the submit step, so nothing is enqueued', () => {
    const exitIndex = code.indexOf('exit 3')
    const submitIndex = code.indexOf('run-daily.ts"')
    expect(exitIndex).toBeGreaterThan(-1)
    expect(submitIndex).toBeGreaterThan(exitIndex)
  })

  it('reads no database credential anywhere', () => {
    expect(src).not.toMatch(/[A-Z_]*DATABASE_URL/)
    expect(src).not.toMatch(new RegExp(['postgres', '(ql)?', ':', '//'].join('')))
  })

  it('claims neither a spawned worker nor an accepted manual one', () => {
    expect(src).not.toMatch(/Spawns the worker/)
    expect(src).toMatch(/starts no worker/i)
    expect(src).not.toMatch(/manually started worker is also accepted/i)
  })

  it('suggests no second scheduler', () => {
    // A ready-to-paste cron line used to live in the header, pointing at a path
    // the repository has not occupied for months.
    expect(src).not.toMatch(/^\s*#\s*\d+\s+\d+\s+\*/m)
  })
})

describe('the liveness library itself', () => {
  const src = readFileSync(LIBRARY, 'utf-8')

  it('selects its primitives by definition, not by an environment variable', () => {
    expect(src).not.toMatch(/\$\{[A-Z_]*(LAUNCHCTL|PGREP|PS|LSOF)[A-Z_]*:-/)
  })

  it('has no pgrep primitive left', () => {
    // The prose explains why process scanning was removed, so only CODE lines
    // are scanned for a call.
    const code = src.split('\n').filter(l => !/^\s*#/.test(l)).join('\n')
    expect(code).not.toMatch(/_pgrep_pids/)
    expect(code).not.toMatch(/\bpgrep\b/)
    // Non-vacuity: the comment-stripped text is still the body of the library.
    expect(code).toContain('find_live_worker()')
  })

  it('exposes exactly four OS primitives', () => {
    const defs = [...src.matchAll(/^_(\w+)\(\) \{ [a-z]/gm)].map(m => m[1])
    expect(defs.sort())
      .toEqual(['launchctl_list', 'pid_command', 'pid_cwd', 'process_snapshot'])
  })

  it('requires a numeric PID', () => {
    expect(src).toMatch(/\*\[!0-9\]\*/)
  })

  it('matches the wrapper chain as an exact five-token structure', () => {
    expect(src).toContain('_worker_wrapper_entrypoint')
    expect(src).toMatch(/\[ "\$\{#t\[@\]\}" -eq 5 \]/)
    for (const token of [
      "WORKER_CMD_CAFFEINATE='/usr/bin/caffeinate'",
      "WORKER_CMD_CAFFEINATE_FLAG='-i'",
      "WORKER_CMD_NPX='/opt/homebrew/bin/npx'",
      "WORKER_CMD_LOADER='tsx'",
    ]) {
      expect(src).toContain(token)
    }
  })

  it('matches the RUNTIME as an exact six-token structure', () => {
    expect(src).toContain('_worker_runtime_entrypoint')
    expect(src).toMatch(/\[ "\$\{#t\[@\]\}" -eq 6 \]/)
    for (const token of [
      "WORKER_RT_REQUIRE='--require'",
      "WORKER_RT_IMPORT='--import'",
      "WORKER_RT_PREFLIGHT_SUFFIX='/tsx/dist/preflight.cjs'",
      "WORKER_RT_LOADER_SUFFIX='/tsx/dist/loader.mjs'",
      "WORKER_RT_IMPORT_SCHEME='file://'",
    ]) {
      expect(src).toContain(token)
    }
  })

  it('searches the launchd root and its PROVEN descendants, never all processes', () => {
    expect(src).toContain('_family_rows')
    // The ancestry walk, bounded and cycle-marked.
    expect(src).toContain('WORKER_FAMILY_MAX_DEPTH')
    expect(src).toMatch(/walked\[cur\] = 1/)
    expect(src).toMatch(/if \(cur == root\)/)
    // …and the root must actually be in the snapshot.
    expect(src).toMatch(/if \(!\(root in present\)\) exit 1/)
    const code = src.split('\n').filter(l => !/^\s*#/.test(l)).join('\n')
    expect(code).not.toMatch(/\bpgrep\b/)
  })

  it('requires EXACTLY ONE candidate in the family', () => {
    expect(src).toMatch(/matches=\$\(\(matches \+ 1\)\)/)
    expect(src).toMatch(/\[ "\$matches" -eq 1 \] \|\| return 1/)
  })

  it('rechecks the chosen PID and command AFTER selecting it', () => {
    expect(src).toMatch(/line="\$\(_pid_command "\$chosen"\)" \|\| return 1/)
    expect(src).toMatch(/\[ "\$line" = "\$chosen_line" \] \|\| return 1/)
    expect(src).toMatch(/_command_is_expected_runtime "\$chosen" "\$line" "\$target" \|\| return 1/)
  })

  it('compares EXACT paths for the wrapper, never executable basenames', () => {
    // A basename test would accept /tmp/fake/caffeinate and /tmp/fake/npx.
    const code = src.split('\n').filter(l => !/^\s*#/.test(l)).join('\n')
    expect(code).not.toMatch(/\$\{t\[[^\]]*\]##\*\//)
    expect(code).toMatch(/\[ "\$\{t\[0\]\}" = "\$WORKER_CMD_CAFFEINATE" \]/)
  })

  it('requires the runtime to be an ABSOLUTE path named node', () => {
    // `node` is the one token matched by name rather than exact path, because a
    // candidate has already been proved to be a launchd descendant and the real
    // path carries a Homebrew version directory. It must still be absolute.
    expect(src).toMatch(/\/\*\/node\)/)
    expect(src).not.toMatch(/=\s*"node"\s*\]/)
  })

  it('carries no generic runtime table or flag-skipping loop', () => {
    const code = src.split('\n').filter(l => !/^\s*#/.test(l)).join('\n')
    expect(code).not.toMatch(/WORKER_RUNTIMES/)
    expect(code).not.toMatch(/case "\$\{t\[\$i\]\}" in -\*/)
    expect(code).not.toMatch(/_has_argv_word|_has_worker_runtime/)
  })

  it('verifies the working directory before trusting a relative entrypoint', () => {
    expect(src).toContain('_cwd_matches_repo')
    expect(src).toContain('_pid_cwd')
    // …and canonicalizes both sides rather than comparing raw strings.
    expect(src).toContain('_canonical_dir')
  })

  it('admits only the launchd label', () => {
    // THE ONE ENTRY POINT INTO THE SEARCH. The family is rooted at the PID this
    // label reports and nowhere else, so there is no path into the predicate that
    // does not begin here.
    expect(src).toMatch(/root="\$\(_launchd_pid "\$label"\)" \|\| return 1/)
    expect(src).toMatch(/rows="\$\(_family_rows "\$snap" "\$root"\)" \|\| return 1/)
  })
})
