import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs'
import { execFileSync, spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

// Shell-level behaviour, exercised against a TEMPORARY filesystem only.
//
// The scheduler script itself is never executed: running it would invoke the
// isolation check, the status bin and possibly the submitter. Instead the lock
// functions are extracted from the real file and sourced, so the code under
// test is the shipped code, not a copy.

const REPO = resolve(__dirname, '..', '..', '..')
const SCHEDULER = join(REPO, 'scripts', 'daily-scheduler.sh')

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'sched-')) })
afterEach(() => rmSync(dir, { recursive: true, force: true }))

/** Extract the lock helpers from the real script and run one command against them. */
function withLock(script: string, opts: { stale?: number; psStub?: string } = {}): string {
  const src = readFileSync(SCHEDULER, 'utf-8')
  const start = src.indexOf('lock_dir_age_s()')
  const end = src.indexOf('\nacquire_lock\nACQUIRE_RC=$?')
  expect(start, 'lock helpers not found in the scheduler').toBeGreaterThan(-1)
  expect(end).toBeGreaterThan(start)
  const helpers = src.slice(start, end)

  // Optional `ps` stub, to simulate an environment where owner liveness cannot
  // be established (a sandbox that denies process inspection).
  let pathLine = ''
  if (opts.psStub) {
    const binDir = join(dir, 'stubbin')
    mkdirSync(binDir, { recursive: true })
    writeFileSync(join(binDir, 'ps'), `#!/bin/bash
${opts.psStub}
`, { mode: 0o755 })
    pathLine = `export PATH="${binDir}:$PATH"`
  }

  const harness = join(dir, `harness-${Math.random().toString(36).slice(2)}.sh`)
  writeFileSync(harness, [
    'set -o pipefail',
    pathLine,
    `LOCK="${join(dir, 'sched.lock')}"`,
    `LOG="${join(dir, 'harness.log')}"`,
    `LOCK_STALE_AFTER_S=${opts.stale ?? 900}`,
    'LOCK_TOKEN="$$-test-$RANDOM"',
    'log() { echo "$*" >> "$LOG"; }',
    helpers,
    script,
  ].join('\n'), 'utf-8')
  return execFileSync('/bin/bash', [harness], { encoding: 'utf-8' }).trim()
}
const logText = () => (existsSync(join(dir, 'harness.log')) ? readFileSync(join(dir, 'harness.log'), 'utf-8') : '')

/**
 * Run the helpers PLUS the scheduler's own acquisition-outcome block — the code
 * that decides which condition to report. Extracted from the real script so the
 * message asserted here cannot drift from the message shipped.
 */
function withLockCaller(setup: string, opts: { stale?: number } = {}): { code: number; out: string } {
  const src = readFileSync(SCHEDULER, 'utf-8')
  const hStart = src.indexOf('lock_dir_age_s()')
  const cStart = src.indexOf('\nacquire_lock\nACQUIRE_RC=$?')
  const cEnd = src.indexOf("trap 'release_lock' EXIT")
  expect(cStart, 'acquisition-outcome block not found').toBeGreaterThan(-1)
  expect(cEnd).toBeGreaterThan(cStart)

  const harness = join(dir, `caller-${Math.random().toString(36).slice(2)}.sh`)
  writeFileSync(harness, [
    `LOCK="${join(dir, 'sched.lock')}"`,
    `LOG="${join(dir, 'harness.log')}"`,
    `LOCK_STALE_AFTER_S=${opts.stale ?? 0}`,
    'LOCK_TOKEN="$$-test-$RANDOM"',
    'log() { echo "$*" >> "$LOG"; }',
    src.slice(hStart, cStart),
    setup,
    src.slice(cStart, cEnd),
    'echo PROCEEDED_TO_SUBMIT',
  ].join('\n'), 'utf-8')
  const r = spawnSync('/bin/bash', [harness], { encoding: 'utf-8' })
  return { code: r.status as number, out: `${r.stdout}${r.stderr}`.trim() }
}
const lockPath = () => join(dir, 'sched.lock')

// ── F. atomic, fail-closed lock ────────────────────────────────────────────

describe('F. scheduler lock', () => {
  it('acquisition is atomic — a second attempt in the same process is refused', () => {
    expect(withLock('acquire_lock && echo FIRST; acquire_lock && echo SECOND || echo BLOCKED'))
      .toBe('FIRST\nBLOCKED')
  })

  it('records its owner pid and a unique token', () => {
    const out = withLock('acquire_lock && cat "$LOCK/owner"')
    const [pid, token] = out.split('\n')
    expect(Number(pid)).toBeGreaterThan(0)
    expect(token).toMatch(/-test-/)
  })

  it('a LIVE owner — a child process this test owns — is never displaced', () => {
    // Hermetic: our own `sleep`, not pid 1. The old test used pid 1, which is
    // owned by root, so `ps` behaviour depended on the sandbox rather than on
    // the code under test.
    const out = withLock(
      'sleep 30 & CHILD=$!; mkdir "$LOCK"; printf "%s\\nother\\n" "$CHILD" > "$LOCK/owner"; ' +
      'acquire_lock && echo STOLEN || echo RESPECTED; kill "$CHILD" 2>/dev/null',
      { stale: 0 })
    expect(out).toBe('RESPECTED')
  })

  it('a dead owner is recovered once the lock is old enough', () => {
    const out = withLock(
      'sleep 0.1 & CHILD=$!; wait "$CHILD"; mkdir "$LOCK"; printf "%s\\nother\\n" "$CHILD" > "$LOCK/owner"; ' +
      'acquire_lock && echo RECOVERED || echo BLOCKED',
      { stale: 0 })
    expect(out).toBe('RECOVERED')
    expect(logText()).toMatch(/recovered stale scheduler lock/)
    expect(logText()).toMatch(/liveness=dead/)
  })

  it('malformed owner contents block REGARDLESS of age, and ask for an operator', () => {
    // Age is not evidence of death. A corrupted owner record means we cannot
    // know what we would be destroying, so it is never recovered automatically
    // — not at 15 minutes, not at a day.
    expect(withLock('mkdir "$LOCK"; echo "not-a-pid" > "$LOCK/owner"; acquire_lock && echo TOOK || echo BLOCKED',
      { stale: 900 })).toBe('BLOCKED')
    expect(withLock('acquire_lock && echo TOOK || echo BLOCKED', { stale: 0 })).toBe('BLOCKED')
    expect(logText()).toMatch(/malformed owner/)
    expect(logText()).toMatch(/operator inspection required/)
  })

  it('an ownerless lock blocks regardless of age, reported as ownerless', () => {
    expect(withLock('mkdir "$LOCK"; acquire_lock && echo TOOK || echo BLOCKED', { stale: 0 }))
      .toBe('BLOCKED')
    expect(logText()).toMatch(/ownerless owner/)
    expect(logText()).toMatch(/operator inspection required/)
  })

  it('when owner liveness cannot be established it blocks at ANY age', () => {
    // `ps` exits 2 (an error, not "no such process") — inspection denied. An
    // undiagnosable owner may well be alive; recovering it would put two
    // schedulers on the same logical date.
    expect(withLock('mkdir "$LOCK"; printf "4242\\nother\\n" > "$LOCK/owner"; acquire_lock && echo TOOK || echo BLOCKED',
      { stale: 900, psStub: 'exit 2' })).toBe('BLOCKED')
    expect(withLock('acquire_lock && echo TOOK || echo BLOCKED', { stale: 0, psStub: 'exit 2' })).toBe('BLOCKED')
    expect(logText()).toMatch(/unknown owner/)
    expect(logText()).toMatch(/operator inspection required/)
  })

  it('a DEAD owner is still not recovered while the lock is young', () => {
    // Both conditions are required: positively dead AND past the threshold.
    const out = withLock(
      'sleep 0.1 & CHILD=$!; wait "$CHILD"; mkdir "$LOCK"; printf "%s\\nother\\n" "$CHILD" > "$LOCK/owner"; ' +
      'acquire_lock && echo RECOVERED || echo BLOCKED',
      { stale: 900 })
    expect(out).toBe('BLOCKED')
  })

  it('CONCURRENCY: two simultaneous stale recoverers produce exactly one winner', () => {
    const out = withLock(
      'mkdir "$LOCK"; printf "99999\\nstale\\n" > "$LOCK/owner"; ' +
      '( LOCK_TOKEN="A-$RANDOM"; acquire_lock && echo WIN-A || echo LOSE-A ) & ' +
      '( LOCK_TOKEN="B-$RANDOM"; acquire_lock && echo WIN-B || echo LOSE-B ) & ' +
      'wait',
      { stale: 0 })
    const wins = out.split('\n').filter(l => l.startsWith('WIN')).length
    expect(wins, `expected exactly one winner, got: ${out.replace(/\n/g, ' ')}`).toBe(1)
    expect(existsSync(lockPath()), 'the winner must hold a real lock').toBe(true)
  })

  it('a losing recoverer cannot remove the winner\'s lock', () => {
    // The loser only ever deletes a path bearing its OWN token, so after both
    // finish the lock still exists and belongs to someone.
    const out = withLock(
      'mkdir "$LOCK"; printf "99999\\nstale\\n" > "$LOCK/owner"; ' +
      '( LOCK_TOKEN="A"; acquire_lock >/dev/null 2>&1 ) & ( LOCK_TOKEN="B"; acquire_lock >/dev/null 2>&1 ) & wait; ' +
      '[ -d "$LOCK" ] && echo LOCK_HELD || echo LOCK_LOST',
      { stale: 0 })
    expect(out).toBe('LOCK_HELD')
  })

  it('release removes only OUR lock, never a replacement owner\'s', () => {
    const out = withLock(
      'acquire_lock; printf "1\\nsomeone-else\\n" > "$LOCK/owner"; ' +   // lock replaced under us
      'release_lock; [ -d "$LOCK" ] && echo STILL_THERE || echo WRONGLY_REMOVED')
    expect(out).toBe('STILL_THERE')
  })

  it('release does remove a lock we genuinely still hold', () => {
    expect(withLock('acquire_lock; release_lock; [ -d "$LOCK" ] && echo STILL_THERE || echo RELEASED'))
      .toBe('RELEASED')
  })

  it('the shipped script uses ps, a token, and an atomic claim — never kill -0', () => {
    const code = readFileSync(SCHEDULER, 'utf-8').split('\n').filter(l => !/^\s*#/.test(l)).join('\n')
    expect(code).toMatch(/ps -p "\$pid"/)
    expect(code).not.toMatch(/kill -0/)
    expect(code).toMatch(/claim_stale_lock/)
    expect(code).toMatch(/LOCK_TOKEN/)
    expect(code).not.toMatch(/rm -rf "\$LOCK"\s*$/m)      // no unconditional removal
  })
})

// ── E. single reconciliation authority ─────────────────────────────────────

describe('E. reconciliation has exactly one authority', () => {
  const scripts = ['daily-queue.sh', 'scripts/daily-scheduler.sh', 'scripts/daily-catchup.sh', 'scripts/pipeline-watchdog.sh']

  it.each(scripts)('%s contains no generic UPDATE of pipeline_runs', (rel) => {
    const p = join(REPO, rel)
    if (!existsSync(p)) return
    const code = readFileSync(p, 'utf-8')
      .split('\n').filter(l => !/^\s*#/.test(l)).join('\n')
    expect(code).not.toMatch(/update\s+pipeline_runs/i)
  })

  it.each(scripts)('%s does not age-close rows by started_at', (rel) => {
    const p = join(REPO, rel)
    if (!existsSync(p)) return
    const code = readFileSync(p, 'utf-8')
      .split('\n').filter(l => !/^\s*#/.test(l)).join('\n')
    expect(code).not.toMatch(/started_at\s*<\s*datetime/i)
  })

  it('daily-queue.sh documents where reconciliation now lives', () => {
    const src = readFileSync(join(REPO, 'daily-queue.sh'), 'utf-8')
    expect(src).toMatch(/reconcile\.ts/)
    expect(src).toMatch(/--apply/)
  })

  it('applying a transition remains an explicit operator action, never automatic', () => {
    for (const rel of scripts) {
      const p = join(REPO, rel)
      if (!existsSync(p)) continue
      const code = readFileSync(p, 'utf-8').split('\n').filter(l => !/^\s*#/.test(l)).join('\n')
      expect(code, `${rel} invokes reconcile --apply automatically`).not.toMatch(/reconcile\.ts[^\n]*--apply/)
    }
  })
})

// ── G/H. logging order and watchdog liveness, structurally ─────────────────

describe('G/H. log initialisation and heartbeat ownership', () => {
  it.each([
    ['scripts/daily-scheduler.sh'],
    ['scripts/pipeline-watchdog.sh'],
  ])('%s defines LOG before the isolation branch that reports failure', (rel) => {
    const src = readFileSync(join(REPO, rel), 'utf-8')
    const logAt = src.search(/^LOG="/m)
    const isoAt = src.indexOf('ISOLATION_MODE="$(cd')
    expect(logAt).toBeGreaterThan(-1)
    expect(isoAt).toBeGreaterThan(logAt)
    expect(src).not.toMatch(/echo "\$ISOLATION_MODE" >> "\$LOG"/)
  })

  // The property is ownership of ONE canonical file with bounded retention. It
  // used to be asserted by matching the inline append/tail/mv both scripts
  // carried — which pinned the implementation, and specifically pinned the
  // racing one: the two scripts share this file, launchd overlaps them, and that
  // idiom lost records and collided on rename. The write now goes through
  // scripts/heartbeat.sh, so the same property is asserted through the helper.
  it('both the scheduler and the watchdog write the SAME canonical heartbeat file', () => {
    for (const rel of ['scripts/daily-scheduler.sh', 'scripts/pipeline-watchdog.sh']) {
      const code = readFileSync(join(REPO, rel), 'utf-8')
        .split('\n').filter(l => !l.trim().startsWith('#')).join('\n')
      // the same default path
      expect(code, rel).toMatch(
        /SCHEDULER_HEARTBEAT_FILE="\$\{SCHEDULER_HEARTBEAT_FILE:-\$ROOT\/data\/scheduler-heartbeat\.log\}"/)
      // the same helper, loaded from the repository it resolves
      expect(code, rel).toMatch(/\.\s+"\$REPO\/scripts\/heartbeat\.sh"/)
      // …passing that same canonical variable, and checking the result
      expect(code, rel).toMatch(/if ! heartbeat_record "\$SCHEDULER_HEARTBEAT_FILE"/)
      expect(code.slice(code.indexOf('heartbeat_record "$SCHEDULER_HEARTBEAT_FILE"')), rel).toMatch(/exit 1/)
    }
    // bounded retention, now owned by the helper — one definition, not two
    const helper = readFileSync(join(REPO, 'scripts', 'heartbeat.sh'), 'utf-8')
    expect(helper).toMatch(/HEARTBEAT_RETAIN_LINES="\$\{HEARTBEAT_RETAIN_LINES:-400\}"/)
    expect(helper).toMatch(/tail -n "\$HEARTBEAT_RETAIN_LINES"/)
  })

  it('neither writes a heartbeat under --dry-run or isolation', () => {
    const wd = readFileSync(join(REPO, 'scripts', 'pipeline-watchdog.sh'), 'utf-8')
    expect(wd).toMatch(/if \[ "\$DRY_RUN" -eq 0 \] && \[ "\$ISOLATION_MODE" != "isolated" \]; then/)
    const sc = readFileSync(join(REPO, 'scripts', 'daily-scheduler.sh'), 'utf-8')
    expect(sc).toMatch(/if \[ "\$DRY_RUN" -eq 0 \]; then/)
  })

  it('the watchdog sends no external notification', () => {
    // Comments still describe the removed LINE push and its raw curl, and
    // PIPELINE_RUNS_DB contains the substring "LINE_" — so match executable
    // lines only, and on actual invocations rather than words.
    const code = readFileSync(join(REPO, 'scripts', 'pipeline-watchdog.sh'), 'utf-8')
      .split('\n').filter(l => !/^\s*#/.test(l)).join('\n')
    expect(code).not.toMatch(/\bcurl\b/)
    expect(code).not.toMatch(/webhook|notify\.me|api\.line\.me/i)
  })
})

// ── F2. stale recovery is SERIALIZED, proven by forced interleaving ────────
//
// THE RACE. Two recoverers both read the same stale lock. A renames it aside,
// deletes it, and creates a fresh lock it now owns. B — still holding its
// obsolete observation — then renames THAT FRESH LIVE LOCK away and takes the
// lock for itself. Both believe they hold it, and both submit.
//
// These tests do not race two background processes and hope. Each one pins the
// interleaving with a filesystem precondition or a blocking `ps` stub, so the
// dangerous ordering happens every run.

describe('F2. serialized stale recovery', () => {
  const ownerToken = () => readFileSync(join(lockPath(), 'owner'), 'utf-8').split('\n')[1]

  /** A stale lock: dead owner, old enough to recover. */
  const stale = 'mkdir "$LOCK"; printf "99999\\nstale-owner\\n" > "$LOCK/owner"; '

  it('1. two recoverers initially target the SAME stale lock', () => {
    // The precondition the race needs — both classify it identically.
    const out = withLock(
      stale + 'owner=$(head -n 1 "$LOCK/owner"); echo "A:$(owner_state "$owner")"; echo "B:$(owner_state "$owner")"',
      { stale: 0 })
    expect(out).toBe('A:dead\nB:dead')
  })

  it('2. a recoverer cannot proceed while another holds the recovery guard', () => {
    // A is mid-decision: it holds "${LOCK}.recovery". B must not act, and must
    // leave the stale lock exactly as it found it — not even the observation
    // it would have based a claim on.
    const out = withLock(
      stale + 'mkdir "${LOCK}.recovery"; ' +          // A is deciding
      'acquire_lock && echo B_TOOK || echo B_BLOCKED',
      { stale: 0 })
    expect(out).toBe('B_BLOCKED')
    expect(existsSync(lockPath()), 'B destroyed the lock A was adjudicating').toBe(true)
    expect(readFileSync(join(lockPath(), 'owner'), 'utf-8')).toContain('stale-owner')
    expect(existsSync(`${lockPath()}.stale.`.replace(/\.$/, ''))).toBe(false)
  })

  it('3. THE DANGEROUS INTERLEAVING: a stale observation cannot displace the winner', () => {
    // Forced ordering: A recovers completely and its replacement lock is owned
    // by a LIVE process. Only then does B run. Under the old code B still held
    // "dead, old" from before A ran and would rename A's live lock away; under
    // the new code B re-reads under the guard and sees a live owner.
    const out = withLock(
      stale +
      'sleep 30 & LIVE=$!; ' +
      // A recovers, then hands the lock to the live process, exactly as a real
      // winner would look to B a moment later.
      'acquire_lock && echo A_RECOVERED || echo A_FAILED; ' +
      'printf "%s\\nwinner-token\\n" "$LIVE" > "$LOCK/owner"; ' +
      'INO_BEFORE=$(stat -f %i "$LOCK"); ' +
      // B now runs with the world in exactly the post-A state.
      '( LOCK_TOKEN="B-token"; acquire_lock && echo B_TOOK || echo B_BLOCKED ); ' +
      'INO_AFTER=$(stat -f %i "$LOCK"); ' +
      '[ "$INO_BEFORE" = "$INO_AFTER" ] && echo SAME_DIR || echo DIR_REPLACED; ' +
      'kill "$LIVE" 2>/dev/null',
      { stale: 0 })
    expect(out).toBe('A_RECOVERED\nB_BLOCKED\nSAME_DIR')
    expect(ownerToken(), "B overwrote the winner's ownership record").toBe('winner-token')
  })

  it('3b. NON-VACUOUS: the pre-guard sequence really would have displaced it', () => {
    // The old body, executed literally: observe, then claim. With the
    // observation taken before the winner existed, the claim destroys a live
    // lock. If this ever stops displacing, test 3 proves nothing.
    const out = withLock(
      stale +
      'OBS_STATE=$(owner_state "$(head -n 1 "$LOCK/owner")"); OBS_AGE=$(lock_dir_age_s); ' +
      'sleep 30 & LIVE=$!; ' +
      'rm -rf "$LOCK"; mkdir "$LOCK"; printf "%s\\nwinner-token\\n" "$LIVE" > "$LOCK/owner"; ' +
      // Acting on the stale observation, as the old code did:
      'if [ "$OBS_STATE" = "dead" ] && [ "$OBS_AGE" -ge 0 ]; then claim_stale_lock && echo DISPLACED_LIVE_LOCK; fi; ' +
      'kill "$LIVE" 2>/dev/null',
      { stale: 0 })
    expect(out).toBe('DISPLACED_LIVE_LOCK')
    expect(existsSync(lockPath()), 'the stale claim removed the live lock').toBe(false)
  })

  it('4. exactly one owner survives, and the loser removed nothing', () => {
    const out = withLock(
      stale +
      '( LOCK_TOKEN="A-token"; acquire_lock && echo WIN-A || echo LOSE-A ) & ' +
      '( LOCK_TOKEN="B-token"; acquire_lock && echo WIN-B || echo LOSE-B ) & ' +
      'wait',
      { stale: 0 })
    const wins = out.split('\n').filter(l => l.startsWith('WIN'))
    expect(wins.length, `expected one winner, got: ${out.replace(/\n/g, ' ')}`).toBe(1)
    expect(existsSync(lockPath()), 'the lock vanished entirely').toBe(true)
    // The surviving lock belongs to the process that reported winning.
    expect(ownerToken()).toBe(wins[0] === 'WIN-A' ? 'A-token' : 'B-token')
  })

  it('4b. the loser cannot rename or remove the winner\'s lock afterwards', () => {
    const out = withLock(
      stale +
      '( LOCK_TOKEN="A-token"; acquire_lock >/dev/null 2>&1 ) & ' +
      '( LOCK_TOKEN="B-token"; acquire_lock >/dev/null 2>&1 ) & wait; ' +
      'INO=$(stat -f %i "$LOCK"); ' +
      // A loser's cleanup runs with ITS token; token-scoped release must no-op.
      '( LOCK_TOKEN="A-token"; release_lock ); ( LOCK_TOKEN="B-token"; release_lock ); ' +
      '[ -d "$LOCK" ] && echo HELD || echo REMOVED',
      { stale: 0 })
    // Exactly one of those releases matches the real owner, so the lock is
    // released once — by its owner — and never by the loser.
    expect(out).toBe('REMOVED')
  })

  it('5. a lock we cannot sign is released, never held anonymously', () => {
    // `printf` is a shell builtin, so overriding it fails the ownership write
    // deterministically without touching permissions or the filesystem.
    const out = withLock(
      'printf() { return 1; }; acquire_lock && echo TOOK || echo REFUSED; ' +
      '[ -d "$LOCK" ] && echo LOCK_LEFT_BEHIND || echo NO_LOCK')
    expect(out).toContain('REFUSED')
    expect(out).toContain('NO_LOCK')
    expect(out).not.toContain('TOOK')
  })

  it('5b. an unsigned lock is never reported as acquired', () => {
    const out = withLock('printf() { return 1; }; acquire_lock; echo "rc=$?"')
    expect(out).toContain('rc=1')
  })

  it('the recovery guard is documented as operator-recoverable, not auto-recovered', () => {
    const src = readFileSync(SCHEDULER, 'utf-8')
    expect(src).toMatch(/OPERATOR NOTE/)
    expect(src).toMatch(/recovery/)
    // No timeout-based clearing of the guard: that would reintroduce the race.
    const exec = src.split('\n').filter(l => !/^\s*#/.test(l)).join('\n')
    expect(exec).not.toMatch(/recovery.*STALE_AFTER|RECOVERY_STALE/)
  })
})


// ── F3. a stranded recovery guard is reported as itself ───────────────────
//
// When "${LOCK}.recovery" survives a process that died mid-decision, recovery
// is blocked permanently — by design, since a timeout would reintroduce the
// race. The failure mode being fixed here is not the blocking; it is the
// REPORTING. Both conditions returned a silent `1`, so the caller logged
// "another scheduler fire holds the lock" either way: a sentence describing
// healthy contention that clears itself on the next fire, printed for a
// condition that clears itself never. An operator reading that waits forever.

describe('F3. stranded recovery guard diagnostics', () => {
  /** A recoverable stale main lock: positively dead owner, past the threshold. */
  const staleLock = 'mkdir "$LOCK"; printf "99999\nstale-owner\n" > "$LOCK/owner"; '
  const guard = () => `${lockPath()}.recovery`
  const ownerBytes = () => readFileSync(join(lockPath(), 'owner'))

  it('1-5. acquisition fails and the stale lock is left byte-identical', () => {
    const before = withLock(staleLock + 'mkdir "${LOCK}.recovery"; ' +
      'B=$(shasum "$LOCK/owner" | cut -d" " -f1); INO=$(stat -f %i "$LOCK"); ' +
      'acquire_lock; echo "rc=$?"; ' +
      'A=$(shasum "$LOCK/owner" | cut -d" " -f1); INO2=$(stat -f %i "$LOCK"); ' +
      '[ "$B" = "$A" ] && echo OWNER_IDENTICAL || echo OWNER_CHANGED; ' +
      '[ "$INO" = "$INO2" ] && echo SAME_DIR || echo DIR_REPLACED',
      { stale: 0 })
    expect(before).toBe('rc=3\nOWNER_IDENTICAL\nSAME_DIR')
    expect(existsSync(lockPath()), 'the stale lock was removed').toBe(true)
    expect(ownerBytes().toString()).toContain('stale-owner')
    expect(existsSync(guard()), 'the guard was removed automatically').toBe(true)
  })

  it('6. the runtime log names the guard path and demands operator inspection', () => {
    const r = withLockCaller(staleLock + 'mkdir "${LOCK}.recovery"')
    // Exit 3: a persistent fault needing a person, not a successful run. Safe
    // under StartInterval=900 with no KeepAlive — launchd records the status and
    // fires again at the next opportunity rather than restarting in a loop.
    expect(r.code, 'a stranded recovery guard must not report success').toBe(3)
    const log = logText()
    expect(log, 'the guard path is not in the log').toContain(guard())
    expect(log).toMatch(/recovery is BLOCKED/i)
    expect(log).toMatch(/NOT be removed automatically/i)
    expect(log).toMatch(/[Oo]perator inspection is required/)
  })

  it('7. it does NOT claim another scheduler holds the lock', () => {
    withLockCaller(staleLock + 'mkdir "${LOCK}.recovery"')
    const log = logText()
    expect(log, 'reported healthy contention for a stranded guard')
      .not.toMatch(/another scheduler fire holds the lock/)
    expect(log).toMatch(/NOT ordinary contention/)
  })

  it('does not submit, and does not remove the guard it is reporting', () => {
    const r = withLockCaller(staleLock + 'mkdir "${LOCK}.recovery"')
    expect(r.code).toBe(3)
    expect(r.out).not.toContain('PROCEEDED_TO_SUBMIT')
    expect(existsSync(guard())).toBe(true)
    // The main lock and its owner record are untouched by the reporting path.
    expect(existsSync(lockPath())).toBe(true)
    expect(readFileSync(join(lockPath(), 'owner'), 'utf-8')).toContain('stale-owner')
  })

  it('exit 3 is reserved for the guard — ordinary contention and success are not', () => {
    // The three outcomes must be distinguishable by status alone, which is the
    // entire reason for the change.
    expect(withLockCaller(staleLock + 'mkdir "${LOCK}.recovery"').code).toBe(3)
  })

  it('8. CONTROL: without the guard, the same dead-and-old lock IS recovered', () => {
    // Non-vacuity. The fixture is genuinely recoverable, so the refusal above is
    // caused by the guard and by nothing else.
    const out = withLock(staleLock + 'acquire_lock; echo "rc=$?"', { stale: 0 })
    expect(out).toBe('rc=0')
    expect(logText()).toMatch(/recovered stale scheduler lock/)
  })

  it('8b. CONTROL: a genuinely held lock still reports ordinary contention', () => {
    // The message that WAS being misapplied must still appear where it is true.
    //
    // The owner is a REAL live process — that is the whole point of this control
    // and it is not weakened here. Two things keep it from costing 30 seconds:
    // the child's stdout/stderr are redirected away from the harness pipes (an
    // inherited pipe keeps spawnSync reading until the child exits, which is
    // what made this test take exactly `sleep`'s duration), and an EXIT trap
    // reaps it. The trap is required rather than trailing cleanup because the
    // contention branch under test ends in `exit 0`, so nothing appended after
    // the extracted block would ever run.
    const r = withLockCaller(
      'sleep 30 >/dev/null 2>&1 & LIVE=$!; ' +
      'trap \'kill "$LIVE" 2>/dev/null; wait "$LIVE" 2>/dev/null\' EXIT; ' +
      'mkdir "$LOCK"; printf "%s\nlive\n" "$LIVE" > "$LOCK/owner"',
      { stale: 0 })
    // Non-vacuous, and the threshold is what proves it: with LOCK_STALE_AFTER_S
    // at 0 a DEAD owner would be dead-and-old and would therefore be recovered
    // (PROCEEDED_TO_SUBMIT), while unknown/malformed/ownerless would log the
    // operator message. Blocking quietly with neither is only possible for a
    // positively LIVE owner — so this really is the live-owner path.
    expect(logText(), 'the owner was not classified as live').not.toMatch(/liveness=|operator inspection/)
    expect(r.code).toBe(0)
    expect(logText()).toMatch(/another scheduler fire holds the lock/)
    expect(logText()).not.toMatch(/recovery is BLOCKED/)
    expect(r.out).not.toContain('PROCEEDED_TO_SUBMIT')
  })

  it('8c. CONTROL: a free lock is acquired and proceeds', () => {
    const r = withLockCaller('')
    expect(r.out).toContain('PROCEEDED_TO_SUBMIT')
    expect(logText()).not.toMatch(/recovery is BLOCKED|another scheduler fire/)
  })

  it('no timeout or automatic removal was introduced for the guard', () => {
    const exec = readFileSync(SCHEDULER, 'utf-8').split('\n')
      .filter(l => !/^\s*#/.test(l)).join('\n')
    // The guard is removed on exactly one path: the process that created it.
    const removals = exec.split('\n').filter(l => /rmdir "\$recovery"|rm -rf "\$\{?LOCK\}?\.recovery/.test(l))
    expect(removals.length, `guard removal sites: ${removals.join(' | ')}`).toBe(1)
  })
})
