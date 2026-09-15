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
//
// There is now ONE supported chain, matched as an exact five-token structure.
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
  ['A-installed-relative-form-correct-cwd', 'the CURRENTLY INSTALLED relative form, with the right cwd'],
  ['B-template-absolute-form', 'the S4D template absolute form'],
  ['C-relative-equivalent-cwd-accepted', 'a differently-spelled but equivalent cwd'],
  ['C-absolute-ignores-cwd', 'the absolute form, which needs no cwd proof'],
] as const

const NEGATIVE = [
  // An option VALUE landing in the entrypoint position — the Round-4 defect.
  ['N-node-title-option-value', 'node --title <target>'],
  ['N-node-eval-option-value', 'node --eval <target>'],
  ['N-node-require-option-value', 'node --require <target>'],
  ['N-tsx-eval-option-value', 'tsx --eval <target>'],
  ['N-npx-package-option-value', 'npx --package tsx <target>'],
  ['N-caffeinate-npx-package-option-value', 'caffeinate -i npx --package tsx <target>'],
  // Alternate launchers that would work but that no plist produces.
  ['N-direct-tsx-unsupported', 'a direct tsx invocation'],
  ['N-node-import-tsx-unsupported', 'node --import tsx <target>'],
  // Right shape, wrong entry point.
  ['N-npx-other-tool-on-target', 'npx running another tool on the target'],
  ['N-npx-tsx-other-entry-target-as-arg', 'npx tsx <other entry> <target>'],
  ['N-node-other-entry-target-as-arg', 'node <other entry> <target>'],
  ['N-target-followed-by-extra-args', 'the exact chain followed by an extra argument'],
  ['N-typechecker-reading-the-file', 'a typechecker reading the file'],
  ['N-grep-wrong-runtime', 'grep'],
  ['N-tail-wrong-runtime', 'tail'],
  // Impostor executables at the right positions.
  ['N-impostor-caffeinate-path', '/tmp/fake/caffeinate instead of /usr/bin/caffeinate'],
  ['N-impostor-npx-path', '/tmp/fake/npx instead of /opt/homebrew/bin/npx'],
  // Wrong checkout / lookalike / wrong script.
  ['N-another-checkout-absolute', "another checkout's absolute worker path"],
  ['N-suffix-lookalike', 'a path that merely ends in the same suffix'],
  ['N-other-relative-script', 'a different relative script under the same label'],
  // The cwd proof for the transitional relative form.
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

  it('exposes exactly three OS primitives', () => {
    const defs = [...src.matchAll(/^_(\w+)\(\) \{ [a-z]/gm)].map(m => m[1])
    expect(defs.sort()).toEqual(['launchctl_list', 'pid_command', 'pid_cwd'])
  })

  it('requires a numeric PID', () => {
    expect(src).toMatch(/\*\[!0-9\]\*/)
  })

  it('matches ONE exact command chain, token by token', () => {
    expect(src).toContain('_worker_entrypoint')
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

  it('compares EXACT paths, never executable basenames', () => {
    // A basename test would accept /tmp/fake/caffeinate and /tmp/fake/npx.
    const code = src.split('\n').filter(l => !/^\s*#/.test(l)).join('\n')
    expect(code).not.toMatch(/\$\{t\[[^\]]*\]##\*\//)
    expect(code).toMatch(/\[ "\$\{t\[0\]\}" = "\$WORKER_CMD_CAFFEINATE" \]/)
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
    expect(src).toMatch(/pid="\$\(_launchd_pid "\$label"\)" \|\| return 1/)
  })
})
