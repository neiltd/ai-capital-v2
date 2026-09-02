import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, symlinkSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

// THE DEFECT THIS PINS.
//
// daily-scheduler.sh ended with:
//
//     "$REPO/daily-queue.sh" --logical-date "$LOGICAL" >> "$LOG" 2>&1
//     log "submission finished, exit=$?"
//
// The log LINE was correct — `$?` is expanded before `log` runs — but `log` was
// then the script's last command, so the script exited with log's status. A
// failed submission was reported to launchd as exit 0.
//
// That is the signal the watchdog and every activation proof read to decide
// whether the scheduler worked. A submitter that dies looks identical to one
// that succeeded.
//
// METHOD. These cases execute the REAL scripts/daily-scheduler.sh — reached via
// a symlink so the script's own `dirname $BASH_SOURCE/..` resolves to a sandbox
// REPO — with every external command stubbed:
//   • the isolation check and daily-run-status, by making the sandbox the REPO
//     the script resolves and placing our own CLI files there (the script
//     hard-resets PATH for launchd, so a PATH stub cannot work); node_modules
//     is symlinked so the real `npx tsx` runs offline
//   • `$REPO/daily-queue.sh` via a sandbox file whose exit code each case sets
// AI_CAPITAL_ROOT points into the sandbox, so the log, heartbeat, state marker
// and lock are all created there.
//
// Nothing reaches production Redis, SQLite, PostgreSQL, launchd, an API or a
// model: no real `npx` runs, and the submitter is a shell stub.

const REAL_REPO = resolve(__dirname, '..', '..', '..')
const REAL_SCHEDULER = join(REAL_REPO, 'scripts', 'daily-scheduler.sh')
const LOGICAL = '2026-09-01'

/** Build a sandbox REPO whose daily-queue.sh exits with `code`. */
function sandbox(code: number, schedulerSrc?: string) {
  const dir = mkdtempSync(join(tmpdir(), 'sched-exit-'))
  const repo = join(dir, 'repo')
  const root = join(dir, 'root')
  mkdirSync(join(repo, 'scripts'), { recursive: true })
  mkdirSync(join(repo, 'packages', 'queue', 'bin'), { recursive: true })
  mkdirSync(join(repo, 'packages', 'pipeline-runs', 'bin'), { recursive: true })

  // The script hard-resets PATH for launchd, so its external commands cannot be
  // stubbed by prepending a directory. Instead the sandbox IS the REPO the
  // script resolves: node_modules is symlinked so the real `npx tsx` runs
  // offline, while the two CLI files it invokes are ours.
  symlinkSync(join(REAL_REPO, 'node_modules'), join(repo, 'node_modules'))
  symlinkSync(join(REAL_REPO, 'package.json'), join(repo, 'package.json'))

  // The real script, reached through the sandbox so REPO resolves here.
  if (schedulerSrc) writeFileSync(join(repo, 'scripts', 'daily-scheduler.sh'), schedulerSrc, { mode: 0o755 })
  else symlinkSync(REAL_SCHEDULER, join(repo, 'scripts', 'daily-scheduler.sh'))

  // Non-isolated, so the script does not take its refuse-to-submit branch.
  writeFileSync(join(repo, 'packages', 'queue', 'bin', 'check-isolation.ts'),
    "console.log('production')\n")
  // The day reports eligible, so the script reaches submission.
  writeFileSync(join(repo, 'packages', 'pipeline-runs', 'bin', 'daily-run-status.ts'),
    `console.log(JSON.stringify({logicalDate:'${LOGICAL}',runId:null,startedAt:null,endedAt:null,` +
    `runningForMin:null,lastHeartbeat:null,state:'no_opportunity',eligibleToRun:true,` +
    `shouldAlert:false,reason:'test fixture',clockOverride:false}))\n`)

  // The submitter under test: records its argv, then exits with `code`.
  const submitter = join(repo, 'daily-queue.sh')
  writeFileSync(submitter,
    `#!/bin/bash\nprintf '%s\\n' "$*" > "${join(dir, 'submitter-argv.txt')}"\nexit ${code}\n`,
    { mode: 0o755 })
  chmodSync(submitter, 0o755)

  return { dir, repo, root, submitter, argvFile: join(dir, 'submitter-argv.txt') }
}

function runScheduler(s: ReturnType<typeof sandbox>) {
  return spawnSync('/bin/bash', [join(s.repo, 'scripts', 'daily-scheduler.sh')], {
    encoding: 'utf-8',
    timeout: 120_000,
    env: {
      ...process.env,
      AI_CAPITAL_ROOT: s.root,
      SCHEDULER_HEARTBEAT_FILE: join(s.root, 'hb.log'),
    },
  })
}

const schedLog = (s: ReturnType<typeof sandbox>) => {
  const p = join(s.root, 'logs', 'daily-scheduler.log')
  return existsSync(p) ? readFileSync(p, 'utf-8') : ''
}

describe('the scheduler exits with the submitter status', () => {
  it('a submitter that succeeds yields exit 0 and logs exit=0', () => {
    const s = sandbox(0)
    try {
      const r = runScheduler(s)
      expect(schedLog(s), 'the script never reached submission').toContain('submitting')
      expect(r.status, `stderr: ${r.stderr?.slice(0, 400)}`).toBe(0)
      expect(schedLog(s)).toContain('submission finished, exit=0')
    } finally { rmSync(s.dir, { recursive: true, force: true }) }
  }, 120_000)

  it('a submitter that fails yields THAT EXACT code, not 0', () => {
    const s = sandbox(42)
    try {
      const r = runScheduler(s)
      expect(schedLog(s), 'the script never reached submission').toContain('submitting')
      // The whole point: launchd must see 42, not the logger's 0.
      expect(r.status, 'the scheduler swallowed the submitter failure').toBe(42)
      expect(schedLog(s)).toContain('submission finished, exit=42')
    } finally { rmSync(s.dir, { recursive: true, force: true }) }
  }, 120_000)

  it('a distinctive second failure code is also propagated exactly', () => {
    const s = sandbox(17)
    try {
      const r = runScheduler(s)
      expect(r.status).toBe(17)
      expect(schedLog(s)).toContain('submission finished, exit=17')
    } finally { rmSync(s.dir, { recursive: true, force: true }) }
  }, 120_000)

  // NON-VACUITY. The pre-fix tail, run through the same harness, must FAIL the
  // assertion above — otherwise these cases prove nothing about the change.
  it('NON-VACUITY: the pre-fix implementation reports 0 for a failed submission', () => {
    const real = readFileSync(REAL_SCHEDULER, 'utf-8')
    const fixed = `SUBMIT_RC=$?\nlog "submission finished, exit=$SUBMIT_RC"`
    expect(real, 'the fixed form is not present').toContain(fixed)
    // Reconstruct exactly what the file said before the change.
    const prefix = real.slice(0, real.indexOf(fixed))
    const prefixSrc = `${prefix}log "submission finished, exit=$?"\n`
    const s = sandbox(42, prefixSrc)
    try {
      const r = runScheduler(s)
      expect(schedLog(s), 'the pre-fix variant never reached submission').toContain('submitting')
      expect(r.status, 'the pre-fix variant unexpectedly propagated the failure').toBe(0)
      expect(schedLog(s), 'the pre-fix log line was already correct').toContain('submission finished, exit=42')
    } finally { rmSync(s.dir, { recursive: true, force: true }) }
  }, 120_000)
})

describe('the change alters nothing else', () => {
  it('the approved logical date is still forwarded to the submitter', () => {
    const s = sandbox(0)
    try {
      runScheduler(s)
      expect(existsSync(s.argvFile), 'the submitter was never invoked').toBe(true)
      expect(readFileSync(s.argvFile, 'utf-8').trim()).toBe(`--logical-date ${LOGICAL}`)
    } finally { rmSync(s.dir, { recursive: true, force: true }) }
  }, 120_000)

  it('the lock is released on the SUCCESS path', () => {
    const s = sandbox(0)
    try {
      const r = runScheduler(s)
      expect(r.status).toBe(0)
      expect(existsSync(join(s.root, 'data', 'daily-scheduler.lock')),
        'the lock survived a successful run').toBe(false)
    } finally { rmSync(s.dir, { recursive: true, force: true }) }
  }, 120_000)

  it('the lock is released on the FAILURE path too — `exit` still fires the EXIT trap', () => {
    const s = sandbox(42)
    try {
      const r = runScheduler(s)
      expect(r.status).toBe(42)
      expect(existsSync(join(s.root, 'data', 'daily-scheduler.lock')),
        'a failed submission wedged the lock').toBe(false)
    } finally { rmSync(s.dir, { recursive: true, force: true }) }
  }, 120_000)

  it('the submitter invocation and the isolation refusal branch are untouched', () => {
    const src = readFileSync(REAL_SCHEDULER, 'utf-8')
    expect(src).toContain('"$REPO/daily-queue.sh" --logical-date "$LOGICAL"')
    expect(src).toContain('isolated environment — refusing to invoke the production submitter')
    expect(src).toContain("trap 'release_lock' EXIT")
  })
})
