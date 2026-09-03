import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

// THE DEFECT THIS PINS.
//
// daily-scheduler.sh and pipeline-watchdog.sh both wrote the SAME heartbeat file
// with the SAME three lines and the SAME fixed temporary path:
//
//     echo "$(date …)" >> "$SCHEDULER_HEARTBEAT_FILE"
//     tail -n 400 "$SCHEDULER_HEARTBEAT_FILE" > "$SCHEDULER_HEARTBEAT_FILE.tmp" \
//       && mv "$SCHEDULER_HEARTBEAT_FILE.tmp" "$SCHEDULER_HEARTBEAT_FILE"
//
// launchd fires them independently, so they overlap. Two failures follow, and
// during the Round 20 activation the first one was observed in production:
//
//   1. RENAME COLLISION — both processes write one `.tmp` path; the second `mv`
//      finds it already consumed:
//        mv: rename …/scheduler-heartbeat.log.tmp …: No such file or directory
//
//   2. LOST UPDATE — the deeper defect, which unique temp names do NOT fix.
//      `tail` reads a snapshot; if the other writer appends after that read, the
//      `mv` puts back a file with the other writer's line missing. The heartbeat
//      is liveness evidence the watchdog reads to tell a dead scheduler from a
//      sleeping laptop, so a silently dropped record is a wrong verdict later.
//
// Neither script uses `set -e`, the chain is joined by `&&`, and nothing checks
// the result — so both failures exited 0 and were invisible.
//
// METHOD. The control is not a paraphrase and not a lookup: LEGACY_FIXTURE below
// is a frozen verbatim copy of the pre-fix body, executed as-is. This suite
// consults no repository history — a committed test that reads history passes
// only until the fix is committed. Everything runs in a temp directory against
// temp heartbeat files. No production path, database, queue, launchd job or
// network is touched.

const REPO = resolve(__dirname, '..', '..', '..')
const HELPER = join(REPO, 'scripts', 'heartbeat.sh')
const SCHEDULER = join(REPO, 'scripts', 'daily-scheduler.sh')
const WATCHDOG = join(REPO, 'scripts', 'pipeline-watchdog.sh')

/**
 * THE LEGACY IMPLEMENTATION, FROZEN.
 *
 * This is a verbatim, immutable copy of the heartbeat body both scripts carried
 * at commit 89560fba3ae113bd1d5144a0905cde3787ecb238, kept here as a fixture.
 *
 * It is NOT read from version control. An earlier version of this file shelled
 * out to read the script as committed, to prove the control matched — which
 * works only while the pre-fix code is still the tip and breaks on the very
 * commit that lands the fix. A committed test may not depend on the tip, its
 * parent, a branch, or any commit remaining adjacent.
 *
 * Its non-vacuity does not need Git either: the cases below DEMONSTRATE that
 * this fixture loses records and collides on rename. A control that misbehaves
 * on demand is self-proving in a way a text comparison never was.
 */
const LEGACY_FIXTURE = [
  'echo "$(date -u \'+%Y-%m-%dT%H:%M:%S.000Z\')" >> "$SCHEDULER_HEARTBEAT_FILE"',
  'tail -n 400 "$SCHEDULER_HEARTBEAT_FILE" > "$SCHEDULER_HEARTBEAT_FILE.tmp" \\',
  '  && mv "$SCHEDULER_HEARTBEAT_FILE.tmp" "$SCHEDULER_HEARTBEAT_FILE"',
].join('\n')

function sandbox(): string {
  return mkdtempSync(join(tmpdir(), 'heartbeat-'))
}

/**
 * Run `writers` shell processes concurrently, each appending `rounds` records
 * through `body`. A shared start file is polled by every writer so they are all
 * inside the critical section at once rather than politely queued.
 */
function race(dir: string, body: string, writers: number, rounds: number) {
  const hb = join(dir, 'heartbeat.log')
  const go = join(dir, 'GO')
  const runner = join(dir, 'writer.sh')
  writeFileSync(runner, [
    '#!/bin/bash',
    'set -o pipefail',
    'SCHEDULER_HEARTBEAT_FILE="$1"; WHO="$2"; ROUNDS="$3"; GO="$4"',
    'while [ ! -f "$GO" ]; do :; done',
    'rc=0',
    'for i in $(seq 1 "$ROUNDS"); do',
    '  STAMP="$WHO-$i"',
    body,
    '  [ $? -eq 0 ] || rc=1',
    'done',
    'exit $rc',
  ].join('\n'), { mode: 0o755 })

  const kids = Array.from({ length: writers }, (_, w) =>
    spawnSync('/bin/bash', ['-c',
      `"${runner}" "${hb}" "w${w}" ${rounds} "${go}" > "${dir}/out.w${w}" 2>&1 & echo $!`],
      { encoding: 'utf-8' }).stdout.trim())

  writeFileSync(go, '')
  // Wait for every writer to exit.
  const deadline = Date.now() + 120_000
  while (Date.now() < deadline) {
    const alive = kids.filter(p => spawnSync('kill', ['-0', p]).status === 0)
    if (alive.length === 0) break
  }

  const text = existsSync(hb) ? readFileSync(hb, 'utf-8') : ''
  const present = new Set(text.split('\n').filter(Boolean))
  const expected: string[] = []
  for (let w = 0; w < writers; w++) for (let i = 1; i <= rounds; i++) expected.push(`w${w}-${i}`)
  const missing = expected.filter(e => !present.has(e))
  const noise = kids.map((_, w) => {
    const f = join(dir, `out.w${w}`)
    return existsSync(f) ? readFileSync(f, 'utf-8') : ''
  }).join('')
  return { hb, lines: text.split('\n').filter(Boolean), missing, noise, expected }
}

const LEGACY_BODY = [
  '  echo "$STAMP" >> "$SCHEDULER_HEARTBEAT_FILE"',
  '  tail -n 400 "$SCHEDULER_HEARTBEAT_FILE" > "$SCHEDULER_HEARTBEAT_FILE.tmp" \\',
  '    && mv "$SCHEDULER_HEARTBEAT_FILE.tmp" "$SCHEDULER_HEARTBEAT_FILE"',
].join('\n')

const FIXED_BODY = [
  `  . "${HELPER}"`,
  '  heartbeat_record "$SCHEDULER_HEARTBEAT_FILE" "$STAMP"',
].join('\n')

// ── The control: the committed pre-fix code really does lose records ────────

describe('the pre-fix heartbeat write is unsafe under concurrency', () => {
  it('the frozen legacy fixture has the shape of the defect, and needs no Git to say so', () => {
    // Shape, asserted on the fixture itself — no repository history is consulted.
    expect(LEGACY_FIXTURE).toContain('>> "$SCHEDULER_HEARTBEAT_FILE"')
    expect(LEGACY_FIXTURE).toContain('tail -n 400 "$SCHEDULER_HEARTBEAT_FILE"')
    expect(LEGACY_FIXTURE, 'the fixture must use the FIXED temp path that collided')
      .toContain('"$SCHEDULER_HEARTBEAT_FILE.tmp"')
    expect(LEGACY_FIXTURE, 'the fixture must be the unchecked && chain').toContain('&& mv')
    expect(LEGACY_FIXTURE, 'the fixture must have no lock').not.toMatch(/mkdir|flock|lock/)
    // The executed control is that fixture with only the timestamp swapped for a
    // marker, so a lost record can be named.
    expect(LEGACY_BODY).toContain('"$SCHEDULER_HEARTBEAT_FILE.tmp"')
    expect(LEGACY_BODY).toContain('tail -n 400')
  })

  it('no test in this file reads repository history', () => {
    const self = readFileSync(__filename, 'utf-8')
    const code = self.split('\n').filter(l => !l.trim().startsWith('*') && !l.trim().startsWith('//')).join('\n')
    // Assembled from fragments so this assertion cannot match its own source.
    const forbidden = ['g' + 'it show', 'rev-' + 'parse', 'HEAD' + '~', 'HEAD' + ':scripts']
    for (const f of forbidden) {
      expect(code, `this suite still depends on repository history via ${f}`).not.toContain(f)
    }
  })

  it('loses records or fails the rename when two writers overlap', () => {
    const dir = sandbox()
    try {
      const r = race(dir, LEGACY_BODY, 4, 30)
      const collided = /No such file or directory/.test(r.noise)
      expect(r.missing.length > 0 || collided,
        `legacy run kept all ${r.expected.length} records and reported no rename error — ` +
        `the control did not reproduce the defect (lines=${r.lines.length})`).toBe(true)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  }, 180_000)
})

// ── The fix ────────────────────────────────────────────────────────────────

describe('heartbeat_record serializes the whole transaction', () => {
  it('the shared helper exists and is sourceable', () => {
    expect(existsSync(HELPER), `${HELPER} does not exist`).toBe(true)
    const r = spawnSync('/bin/bash', ['-n', HELPER], { encoding: 'utf-8' })
    expect(r.status, `helper does not parse: ${r.stderr}`).toBe(0)
  })

  it('preserves EVERY record from four concurrent writers', () => {
    const dir = sandbox()
    try {
      const r = race(dir, FIXED_BODY, 4, 30)
      expect(r.missing, `these records were lost: ${r.missing.slice(0, 10).join(', ')}`).toEqual([])
      expect(r.lines.length).toBe(r.expected.length)
      expect(r.noise, `writers reported errors: ${r.noise.slice(0, 300)}`).not.toMatch(/No such file or directory/)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  }, 180_000)

  it('leaves no lock or temporary file behind', () => {
    const dir = sandbox()
    try {
      race(dir, FIXED_BODY, 3, 10)
      const left = spawnSync('/bin/bash', ['-c', `ls -A "${dir}" | grep -E 'heartbeat.log.(tmp|lock)' || true`],
        { encoding: 'utf-8' }).stdout.trim()
      expect(left, `residue left behind: ${left}`).toBe('')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  }, 120_000)

  it('two writers interleaving 200 records each still keep all 400', () => {
    const dir = sandbox()
    try {
      const r = race(dir, FIXED_BODY, 2, 200)
      expect(r.missing).toEqual([])
      expect(r.lines.length).toBe(400)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  }, 180_000)
})

// ── Mutation: the lock is what fixes this, not the temp filename ───────────
// The tempting minimal fix is a unique temporary path. It removes the rename
// collision — and makes the real defect SILENT, because the lost update never
// produced an error in the first place. This mutant is that fix, so a later
// simplification of the helper cannot pass by removing the lock.

describe('unique temporary names alone are not the fix', () => {
  it('a lock-free writer with unique temp names still loses records', () => {
    const dir = sandbox()
    try {
      const mutant = join(dir, 'mutant.sh')
      writeFileSync(mutant, [
        'heartbeat_record() {',
        '  local file="$1" stamp="${2:-x}" tmp="$1.tmp.$$.$RANDOM"',
        '  printf "%s\\n" "$stamp" >> "$file" || return 1',
        '  tail -n 400 "$file" > "$tmp" || return 1',
        '  mv "$tmp" "$file" || return 1',
        '  return 0',
        '}',
      ].join('\n'))
      const r = race(dir, [`  . "${mutant}"`, '  heartbeat_record "$SCHEDULER_HEARTBEAT_FILE" "$STAMP"'].join('\n'), 4, 30)
      expect(r.missing.length,
        'the lock-free mutant kept every record — this guard has stopped discriminating').toBeGreaterThan(0)
      // …and it did so without a single error: nothing downstream could notice.
      expect(r.noise).not.toMatch(/No such file or directory/)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  }, 180_000)
})

// ── Stale-lock recovery: the read-then-delete race ─────────────────────────
//
// The first fix reclaimed with `if stale; then rm -rf "$lock"; fi`. Two writers
// can observe the SAME stale lock; the first reclaims it and acquires a fresh
// one at the same canonical path, and the second — still holding its obsolete
// observation — deletes that fresh, live lock. Both then believe they hold it.
//
// These cases drive the interleaving EXPLICITLY rather than hoping a race shows
// up, so they are deterministic: reclaimer B is made to act after writer W has
// taken a replacement, which is exactly the moment the old code got wrong.

describe('stale-lock recovery cannot displace a live lock', () => {
  const sh = (script: string) =>
    spawnSync('/bin/bash', ['-c', `. "${HELPER}"\n${script}`], { encoding: 'utf-8' })

  /**
   * A pid that is certainly gone: started, waited for, and confirmed absent.
   * PID reuse is theoretically possible and is checked for, so a reused pid
   * fails the fixture loudly instead of silently weakening the case.
   */
  function deadPid(): string {
    const r = spawnSync('/bin/bash', ['-c', 'sleep 0.01 & p=$!; wait $p; echo $p'], { encoding: 'utf-8' })
    const pid = r.stdout.trim()
    expect(pid, 'could not obtain a reaped pid').toMatch(/^\d+$/)
    expect(spawnSync('ps', ['-p', pid, '-o', 'pid=']).status,
      `pid ${pid} is still alive — it was reused; rerun`).toBe(1)
    return pid
  }

  /** A live, TEST-OWNED process. The caller must kill it. */
  function livePid(): { pid: string; kill: () => void } {
    const r = spawnSync('/bin/bash', ['-c', 'sleep 300 >/dev/null 2>&1 & echo $!'], { encoding: 'utf-8' })
    const pid = r.stdout.trim()
    expect(pid).toMatch(/^\d+$/)
    expect(spawnSync('ps', ['-p', pid, '-o', 'pid=']).status, 'the live fixture never started').toBe(0)
    return { pid, kill: () => { spawnSync('kill', ['-9', pid]) } }
  }

  /**
   * A lock directory in the two-field format the implementation now writes:
   *   line 1 owning pid, line 2 token.
   * Backdated so age is satisfied — age alone must no longer be enough.
   */
  function ownedLock(dir: string, pid: string, opts: { old?: boolean; owner?: string } = {}) {
    const hb = join(dir, 'heartbeat.log')
    const lock = `${hb}.lock`
    mkdirSync(lock)
    writeFileSync(join(lock, 'owner'), opts.owner ?? `${pid}\ntok-${pid}\n`)
    if (opts.old !== false) spawnSync('touch', ['-t', '202001010000', lock])
    return { hb, lock }
  }

  /** The default fixture: dead owner, old lock — the only recoverable case. */
  function staleLock(dir: string) {
    return ownedLock(dir, deadPid())
  }

  it('a lone reclaimer frees a genuinely stale lock, and says so', () => {
    const dir = sandbox()
    try {
      const { hb, lock } = staleLock(dir)
      const r = sh(`_heartbeat_reclaim_stale "${lock}" tokenA; echo "RC=$?"`)
      expect(r.stdout).toContain('RC=0')
      expect(existsSync(lock), 'the stale lock survived reclamation').toBe(false)
      expect(r.stderr).toMatch(/reclaimed the lock of dead owner/)
      expect(existsSync(`${lock}.recovery`), 'the recovery guard was left behind').toBe(false)
      expect(hb).toBeTruthy()
    } finally { rmSync(dir, { recursive: true, force: true }) }
  }, 60_000)

  it('the SECOND reclaimer, acting on an obsolete observation, leaves the winner alone', () => {
    const dir = sandbox()
    try {
      const { lock } = staleLock(dir)
      // Both reclaimers observe the same stale lock. A acts first.
      const a = sh(`_heartbeat_reclaim_stale "${lock}" tokenA; echo "RC=$?"`)
      expect(a.stdout, 'reclaimer A should have won').toContain('RC=0')

      // A writer now takes a REPLACEMENT lock at the same canonical path, and
      // that writer is ALIVE — which is what B must respect.
      const w = livePid()
      try {
        mkdirSync(lock)
        writeFileSync(join(lock, 'owner'), `${w.pid}\ntok-winner\n`)

        // B still holds its pre-A observation. This is the exact moment the old
        // code deleted the winner's lock.
        const b = sh(`_heartbeat_reclaim_stale "${lock}" tokenB; echo "RC=$?"`)
        expect(b.stdout, 'B must decline: the owner it re-reads is alive').toContain('RC=1')
        expect(existsSync(lock), "B deleted the winner's fresh lock").toBe(true)
        expect(readFileSync(join(lock, 'owner'), 'utf-8').split('\n')[1],
          'the surviving owner is not the writer that legitimately acquired it').toBe('tok-winner')
      } finally { w.kill() }
    } finally { rmSync(dir, { recursive: true, force: true }) }
  }, 60_000)

  it('the loser neither deletes nor renames the winner\'s lock', () => {
    const dir = sandbox()
    try {
      const { lock } = staleLock(dir)
      sh(`_heartbeat_reclaim_stale "${lock}" tokenA`)
      const w = livePid()
      try {
        mkdirSync(lock); writeFileSync(join(lock, 'owner'), `${w.pid}\ntok-winner\n`)
        sh(`_heartbeat_reclaim_stale "${lock}" tokenB`)
        const strays = spawnSync('/bin/bash', ['-c', `ls -A "${dir}" | grep -E 'stale|recovery' || true`],
          { encoding: 'utf-8' }).stdout.trim()
        expect(strays, `a claim or guard path was left behind: ${strays}`).toBe('')
        expect(readFileSync(join(lock, 'owner'), 'utf-8').split('\n')[1]).toBe('tok-winner')
      } finally { w.kill() }
    } finally { rmSync(dir, { recursive: true, force: true }) }
  }, 60_000)

  it('exactly one owner survives when many reclaimers hit one stale lock at once', () => {
    const dir = sandbox()
    try {
      const { hb, lock } = staleLock(dir)
      const go = join(dir, 'GO')
      const runner = join(dir, 'r.sh')
      writeFileSync(runner, [
        '#!/bin/bash',
        `. "${HELPER}"`,
        'while [ ! -f "$3" ]; do :; done',
        'heartbeat_record "$1" "$2"',
      ].join('\n'), { mode: 0o755 })
      const pids = Array.from({ length: 6 }, (_, i) =>
        spawnSync('/bin/bash', ['-c',
          `"${runner}" "${hb}" "w${i}" "${go}" > "${dir}/o${i}" 2>&1 & echo $!`],
          { encoding: 'utf-8' }).stdout.trim())
      writeFileSync(go, '')
      const deadline = Date.now() + 90_000
      while (Date.now() < deadline &&
             pids.some(pd => spawnSync('kill', ['-0', pd]).status === 0)) { /* wait */ }

      // Every writer's record survives, and no lock or claim is left over.
      const lines = existsSync(hb) ? readFileSync(hb, 'utf-8').split('\n').filter(Boolean) : []
      expect(new Set(lines).size, `records: ${lines.join(',')}`).toBe(6)
      expect(existsSync(lock), 'a lock outlived every writer').toBe(false)
      const strays = spawnSync('/bin/bash', ['-c', `ls -A "${dir}" | grep -E 'stale|recovery|\\.tmp' || true`],
        { encoding: 'utf-8' }).stdout.trim()
      expect(strays, `residue: ${strays}`).toBe('')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  }, 180_000)

  it('an abandoned recovery guard fails closed with an actionable diagnostic', () => {
    const dir = sandbox()
    try {
      const { hb, lock } = staleLock(dir)
      const guard = `${lock}.recovery`
      mkdirSync(guard)
      spawnSync('touch', ['-t', '202001010000', guard])   // held since forever
      const r = spawnSync('/bin/bash', ['-c',
        `. "${HELPER}"; HEARTBEAT_LOCK_TIMEOUT=1 heartbeat_record "${hb}" STAMP`],
        { encoding: 'utf-8' })
      expect(r.status, 'an abandoned recovery guard was reported as success').not.toBe(0)
      expect(r.stderr).toMatch(/recovery guard/)
      expect(r.stderr, 'the diagnostic must tell an operator what to do').toMatch(/operator removes/)
      expect(r.stderr).toMatch(/Nothing was deleted, renamed or recovered/)
      // Fails closed: it destroys nothing on its way out.
      expect(existsSync(guard), 'the abandoned guard was deleted').toBe(true)
      expect(existsSync(lock), 'the stale lock was deleted despite failing closed').toBe(true)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  }, 60_000)

  it('a FRESH recovery guard is waited on, not reclaimed', () => {
    const dir = sandbox()
    try {
      const { hb, lock } = staleLock(dir)
      const guard = `${lock}.recovery`
      mkdirSync(guard)                                    // just taken, by someone
      const r = spawnSync('/bin/bash', ['-c',
        `. "${HELPER}"; HEARTBEAT_LOCK_TIMEOUT=1 heartbeat_record "${hb}" STAMP`],
        { encoding: 'utf-8' })
      expect(r.status).not.toBe(0)
      expect(r.stderr, 'a fresh guard must not be reported as abandoned').not.toMatch(/recovery guard .* held for over/)
      expect(existsSync(guard)).toBe(true)
      expect(existsSync(lock)).toBe(true)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  }, 60_000)

  // NON-VACUITY. The pre-fix reclamation, run through the very same interleave,
  // really does destroy the winner's fresh lock. Without this, every assertion
  // above could be passing for reasons unrelated to the fix.
  it('CONTROL: the read-then-delete sequence displaces the winner\'s fresh lock', () => {
    const dir = sandbox()
    try {
      const { lock } = staleLock(dir)
      const mutant = join(dir, 'mutant.sh')
      writeFileSync(mutant, [
        '# MUTATION: the pre-fix reclamation — observe, then delete the canonical path.',
        '_heartbeat_reclaim_stale_legacy() {',
        '  local lock="$1"',
        '  if [ -d "$lock" ]; then rm -rf "$lock"; return 0; fi',
        '  return 1',
        '}',
      ].join('\n'))
      // A observes staleness and reclaims.
      spawnSync('/bin/bash', ['-c', `. "${mutant}"; _heartbeat_reclaim_stale_legacy "${lock}"`])
      // A writer takes the replacement.
      mkdirSync(lock); writeFileSync(join(lock, 'owner'), 'FRESH\n')
      // B acts on its obsolete observation.
      spawnSync('/bin/bash', ['-c', `. "${mutant}"; _heartbeat_reclaim_stale_legacy "${lock}"`])
      expect(existsSync(lock),
        'the legacy sequence left the fresh lock intact — this control no longer discriminates').toBe(false)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  }, 60_000)

  it('the helper never deletes the canonical lock path during recovery', () => {
    const code = readFileSync(HELPER, 'utf-8')
      .split('\n').filter(l => !l.trim().startsWith('#')).join('\n')
    const i = code.indexOf('_heartbeat_reclaim_stale()')
    const body = code.slice(i, code.indexOf('\n}', i))
    expect(body, 'the reclaimer deletes the canonical lock path').not.toMatch(/rm -rf "\$lock"/)
    expect(body, 'the reclaimer must claim by rename to a token-specific path').toMatch(/mv "\$lock" "\$claim"/)
    expect(body, 'only the token-specific claim may be deleted').toMatch(/rm -rf "\$claim"/)
    expect(body, 'recovery must be serialized by a guard').toMatch(/mkdir "\$recovery"/)
  })
})

// ── Ownership: only a provably dead owner may be reclaimed ─────────────────
//
// Round 2 judged staleness by AGE ALONE. An independent reproduction showed the
// cost directly:
//
//     reclaim_rc=0 owner=LIVE lock=REMOVED
//
// A live writer suspended past the bound had its lock taken; on resuming it can
// put back the snapshot it read before the suspension, silently undoing every
// record written in between. Age is not evidence of death.
//
// Every case below uses REAL pids: a reaped one for `dead`, and a test-owned
// `sleep` for `alive`, killed in the case's own finally block.

describe('reclamation requires positive evidence of death', () => {
  const sh = (script: string) =>
    spawnSync('/bin/bash', ['-c', `. "${HELPER}"\n${script}`], { encoding: 'utf-8' })

  function deadPid(): string {
    const pid = spawnSync('/bin/bash', ['-c', 'sleep 0.01 & p=$!; wait $p; echo $p'],
      { encoding: 'utf-8' }).stdout.trim()
    expect(pid).toMatch(/^\d+$/)
    expect(spawnSync('ps', ['-p', pid, '-o', 'pid=']).status, `pid ${pid} was reused; rerun`).toBe(1)
    return pid
  }
  function livePid() {
    const pid = spawnSync('/bin/bash', ['-c', 'sleep 300 >/dev/null 2>&1 & echo $!'],
      { encoding: 'utf-8' }).stdout.trim()
    expect(pid).toMatch(/^\d+$/)
    expect(spawnSync('ps', ['-p', pid, '-o', 'pid=']).status).toBe(0)
    return { pid, kill: () => spawnSync('kill', ['-9', pid]) }
  }
  function lockWith(dir: string, ownerFile: string, old = true) {
    const hb = join(dir, 'heartbeat.log')
    const lock = `${hb}.lock`
    mkdirSync(lock)
    writeFileSync(join(lock, 'owner'), ownerFile)
    if (old) spawnSync('touch', ['-t', '202001010000', lock])
    return { hb, lock }
  }

  // 1. THE DEFECT. An old lock whose owner is alive must survive.
  it('an OLD lock owned by a LIVE process is never reclaimed', () => {
    const dir = sandbox(); const w = livePid()
    try {
      const { lock } = lockWith(dir, `${w.pid}\ntok-live\n`)
      const r = sh(`_heartbeat_reclaim_stale "${lock}" tokX; echo "RC=$?"`)
      expect(r.stdout, 'a live owner was reclaimed on age alone').toContain('RC=1')
      expect(existsSync(lock), "the live writer's lock was removed").toBe(true)
      expect(readFileSync(join(lock, 'owner'), 'utf-8').split('\n')[1]).toBe('tok-live')
      expect(r.stderr).not.toMatch(/reclaimed/)
    } finally { w.kill(); rmSync(dir, { recursive: true, force: true }) }
  }, 60_000)

  // 2. Dead AND old: the one recoverable case.
  it('a DEAD-and-OLD owner is reclaimed, and the reason is named', () => {
    const dir = sandbox()
    try {
      const pid = deadPid()
      const { lock } = lockWith(dir, `${pid}\ntok-dead\n`)
      const r = sh(`_heartbeat_reclaim_stale "${lock}" tokX; echo "RC=$?"`)
      expect(r.stdout).toContain('RC=0')
      expect(existsSync(lock)).toBe(false)
      expect(r.stderr).toMatch(new RegExp(`reclaimed the lock of dead owner ${pid}`))
    } finally { rmSync(dir, { recursive: true, force: true }) }
  }, 60_000)

  // 3. Dead but young: still not ours to take.
  it('a DEAD but YOUNG owner is not reclaimed', () => {
    const dir = sandbox()
    try {
      const { lock } = lockWith(dir, `${deadPid()}\ntok-dead\n`, false)   // fresh mtime
      const r = sh(`_heartbeat_reclaim_stale "${lock}" tokX; echo "RC=$?"`)
      expect(r.stdout, 'a young lock was reclaimed').toContain('RC=1')
      expect(existsSync(lock)).toBe(true)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  }, 60_000)

  // 4. `ps` unavailable is UNKNOWN, and unknown is not death.
  it('UNKNOWN liveness is not treated as death', () => {
    const dir = sandbox()
    try {
      const { lock } = lockWith(dir, `${deadPid()}\ntok-x\n`)
      // A `ps` that answers neither "here it is" (rc 0 with output) nor "gone"
      // (rc 1 with none) — the shape of a refused or unavailable process table.
      // Only `ps` is stubbed: emptying PATH entirely would also remove `mkdir`,
      // so the guard would never be taken and the classifier never reached —
      // the case would pass for the wrong reason.
      const bin = join(dir, 'psbin'); mkdirSync(bin)
      writeFileSync(join(bin, 'ps'), '#!/bin/bash\nexit 2\n', { mode: 0o755 })
      const r = spawnSync('/bin/bash', ['-c',
        `. "${HELPER}"; PATH="${bin}:$PATH"; _heartbeat_reclaim_stale "${lock}" tokX; echo "RC=$?"`],
        { encoding: 'utf-8' })
      expect(r.stdout, 'unreadable liveness was treated as death').toContain('RC=2')
      expect(existsSync(lock), 'a lock of unknown liveness was destroyed').toBe(true)
      expect(r.stderr).toMatch(/unknown owner/)
      expect(r.stderr).toMatch(/Age is not evidence of death/)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  }, 60_000)

  // 5. Malformed and ownerless fail closed, distinctly.
  for (const [label, ownerFile, word] of [
    ['a non-numeric pid', 'OLD\ntok\n', 'malformed'],
    ['an empty record', '\n\n', 'malformed'],
  ] as const) {
    it(`${label} fails closed as ${word}`, () => {
      const dir = sandbox()
      try {
        const { lock } = lockWith(dir, ownerFile)
        const r = sh(`_heartbeat_reclaim_stale "${lock}" tokX; echo "RC=$?"`)
        expect(r.stdout).toContain('RC=2')
        expect(existsSync(lock), 'a lock we could not classify was destroyed').toBe(true)
        expect(r.stderr).toMatch(new RegExp(`${word} owner`))
        expect(r.stderr).toMatch(/operator must inspect/)
      } finally { rmSync(dir, { recursive: true, force: true }) }
    }, 60_000)
  }

  it('a lock with NO owner file fails closed as ownerless', () => {
    const dir = sandbox()
    try {
      const hb = join(dir, 'heartbeat.log')
      const lock = `${hb}.lock`
      mkdirSync(lock)                                  // never signed
      spawnSync('touch', ['-t', '202001010000', lock])
      const r = sh(`_heartbeat_reclaim_stale "${lock}" tokX; echo "RC=$?"`)
      expect(r.stdout).toContain('RC=2')
      expect(existsSync(lock)).toBe(true)
      expect(r.stderr).toMatch(/ownerless owner/)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  }, 60_000)

  it('the classifier reports all five states', () => {
    const w = livePid()
    try {
      const states = (arg: string) =>
        sh(`_heartbeat_owner_state ${arg}`).stdout.trim()
      expect(states(w.pid)).toBe('alive')
      expect(states(deadPid())).toBe('dead')
      expect(states('__missing__')).toBe('ownerless')
      expect(states('"not-a-pid"')).toBe('malformed')
      expect(states('""')).toBe('malformed')
      expect(spawnSync('/bin/bash', ['-c',
        `. "${HELPER}"; PATH=/nonexistent; _heartbeat_owner_state 1`], { encoding: 'utf-8' })
        .stdout.trim()).toBe('unknown')
    } finally { w.kill() }
  }, 60_000)

  // THE ROUND 4 DEFECT. A record with a valid numeric pid but no token was
  // classified from the pid ALONE, so a half-signed lock left by a dead process
  // was reclaimed:
  //
  //     owner file: one line containing a dead numeric pid
  //     lock age  : old
  //     result    : rc=0, lock=REMOVED
  //
  // `_heartbeat_record_owner` writes two fields and verifies both; the reader
  // had to check both too, or the write-side guarantee bought nothing.
  for (const [label, ownerOf] of [
    ['a dead pid with NO token line', (pid: string) => `${pid}\n`],
    ['a dead pid with an EMPTY token line', (pid: string) => `${pid}\n\n`],
    ['a dead pid with a whitespace-only token', (pid: string) => `${pid}\n   \n`],
  ] as const) {
    it(`${label} is MALFORMED and fails closed`, () => {
      const dir = sandbox()
      try {
        const pid = deadPid()
        const { lock } = lockWith(dir, ownerOf(pid))
        const r = sh(`_heartbeat_reclaim_stale "${lock}" tok4; echo "RC=$?"`)
        expect(r.stdout, 'a half-signed record was reclaimed on its pid alone').toContain('RC=2')
        expect(existsSync(lock), 'the half-signed lock was removed').toBe(true)
        expect(r.stderr, 'the diagnostic must say malformed').toMatch(/malformed owner/)
        expect(r.stderr).toMatch(/Age is not evidence of death/)
        expect(r.stderr).toMatch(/operator must inspect/)
        expect(r.stderr, 'a half-signed record must never read as a reclaim').not.toMatch(/reclaimed/)
        // No claim or guard residue is left behind by a refusal.
        const strays = spawnSync('/bin/bash', ['-c',
          `ls -A "${dir}" | grep -E 'stale|recovery' || true`], { encoding: 'utf-8' }).stdout.trim()
        expect(strays, `residue: ${strays}`).toBe('')
      } finally { rmSync(dir, { recursive: true, force: true }) }
    }, 60_000)
  }

  it('an invalid record is classified WITHOUT consulting ps', () => {
    const dir = sandbox()
    try {
      const pid = deadPid()
      const { lock } = lockWith(dir, `${pid}\n`)            // half-signed
      const bin = join(dir, 'psbin'); mkdirSync(bin)
      const calls = join(dir, 'ps-calls.txt')
      // A `ps` that records every invocation, then behaves normally.
      writeFileSync(join(bin, 'ps'), `#!/bin/bash\necho "$@" >> "${calls}"\nexec /bin/ps "$@"\n`,
        { mode: 0o755 })
      const r = spawnSync('/bin/bash', ['-c',
        `. "${HELPER}"; PATH="${bin}:$PATH"; _heartbeat_reclaim_stale "${lock}" tok4; echo "RC=$?"`],
        { encoding: 'utf-8' })
      expect(r.stdout).toContain('RC=2')
      const seen = existsSync(calls) ? readFileSync(calls, 'utf-8').trim() : ''
      expect(seen, `ps was asked about an untrusted record: ${seen}`).toBe('')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  }, 60_000)

  it('the record classifier answers ownerless / malformed / valid from one read', () => {
    const dir = sandbox()
    try {
      const hb = join(dir, 'heartbeat.log')
      const lock = `${hb}.lock`
      const classify = () => sh(`_heartbeat_owner_classify "${lock}"`).stdout.trim()
      mkdirSync(lock)
      expect(classify(), 'no owner file').toBe('ownerless')
      const cases: Array<[string, string]> = [
        ['', 'malformed <empty>'],
        ['\n', 'malformed <empty>'],
        ['OLD\ntok\n', 'malformed OLD'],
        ['123\n', 'malformed 123'],
        ['123\n\n', 'malformed 123'],
        ['123\n  \n', 'malformed 123'],
        ['123\ntok-ok\n', 'valid 123'],
      ]
      for (const [content, want] of cases) {
        writeFileSync(join(lock, 'owner'), content)
        expect(classify(), `owner=${JSON.stringify(content)}`).toBe(want)
      }
    } finally { rmSync(dir, { recursive: true, force: true }) }
  }, 60_000)

  // NON-VACUITY. Pid-only validation — exactly what Round 3 did — reclaims the
  // half-signed fixture. Without this, the cases above could pass for reasons
  // unrelated to record validation.
  it('CONTROL: pid-only validation reclaims the half-signed dead-owner lock', () => {
    const dir = sandbox()
    try {
      const pid = deadPid()
      const { lock } = lockWith(dir, `${pid}\n`)            // half-signed, old
      const mutant = join(dir, 'pidonly.sh')
      writeFileSync(mutant, [
        `. "${HELPER}"`,
        '# MUTATION: the Round 3 reader — line 1 only, token never validated.',
        '_heartbeat_reclaim_pidonly() {',
        '  local lock="$1" token="$2" claim="$1.stale.$2" pid state',
        '  pid=$(_heartbeat_owner_pid "$lock")',
        '  state=$(_heartbeat_owner_state "$pid")',
        '  [ "$state" = dead ] || return 1',
        '  _heartbeat_path_age_at_least "$lock" "$HEARTBEAT_LOCK_STALE_SECONDS" || return 1',
        '  mv "$lock" "$claim" 2>/dev/null && rm -rf "$claim" && return 0',
        '  return 1',
        '}',
      ].join('\n'))
      const r = spawnSync('/bin/bash', ['-c',
        `. "${mutant}"; _heartbeat_reclaim_pidonly "${lock}" tokM; echo "RC=$?"`],
        { encoding: 'utf-8' })
      expect(r.stdout, 'the pid-only mutant declined — this control no longer discriminates')
        .toContain('RC=0')
      expect(existsSync(lock),
        'the pid-only mutant left the half-signed lock alone; the fix would then be untested')
        .toBe(false)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  }, 60_000)

  it('a COMPLETE dead-and-old record is still reclaimable', () => {
    const dir = sandbox()
    try {
      const pid = deadPid()
      const { lock } = lockWith(dir, `${pid}\ntok-complete\n`)
      const r = sh(`_heartbeat_reclaim_stale "${lock}" tok4; echo "RC=$?"`)
      expect(r.stdout, 'record validation must not block a complete record').toContain('RC=0')
      expect(existsSync(lock)).toBe(false)
      expect(r.stderr).toMatch(new RegExp(`reclaimed the lock of dead owner ${pid}`))
    } finally { rmSync(dir, { recursive: true, force: true }) }
  }, 60_000)

  it('a COMPLETE live-and-old record is still protected', () => {
    const dir = sandbox(); const w = livePid()
    try {
      const { lock } = lockWith(dir, `${w.pid}\ntok-complete-live\n`)
      const r = sh(`_heartbeat_reclaim_stale "${lock}" tok4; echo "RC=$?"`)
      expect(r.stdout).toContain('RC=1')
      expect(existsSync(lock)).toBe(true)
      expect(readFileSync(join(lock, 'owner'), 'utf-8').split('\n')[1]).toBe('tok-complete-live')
    } finally { w.kill(); rmSync(dir, { recursive: true, force: true }) }
  }, 60_000)

  // 6. Both fields written and read back.
  it('the owner record carries pid AND token, and both are read back', () => {
    const dir = sandbox()
    try {
      const hb = join(dir, 'heartbeat.log')
      const lock = `${hb}.lock`
      const r = sh(`mkdir "${lock}"; _heartbeat_record_owner "${lock}" tok-abc; echo "RC=$?"`)
      expect(r.stdout).toContain('RC=0')
      const [pid, token] = readFileSync(join(lock, 'owner'), 'utf-8').split('\n')
      expect(pid, 'line 1 must be the owning pid').toMatch(/^\d+$/)
      expect(token, 'line 2 must be the token').toBe('tok-abc')
      // A record that cannot be read back is refused, not accepted silently.
      const bad = sh(`mkdir -p "${dir}/b.lock"; chmod 500 "${dir}/b.lock"; ` +
        `_heartbeat_record_owner "${dir}/b.lock" tok; echo "RC=$?"; chmod 700 "${dir}/b.lock"`)
      expect(bad.stdout, 'an unwritable owner record was accepted').toContain('RC=1')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  }, 60_000)

  it('release requires the stored TOKEN to still match the caller', () => {
    const dir = sandbox()
    try {
      const hb = join(dir, 'heartbeat.log')
      const lock = `${hb}.lock`
      mkdirSync(lock); writeFileSync(join(lock, 'owner'), `${process.pid}\ntok-theirs\n`)
      const r = sh(`_heartbeat_release "${lock}" tok-ours; echo "RC=$?"`)
      expect(r.stdout, "a writer released a lock it does not own").toContain('RC=1')
      expect(existsSync(lock), "someone else's lock was removed").toBe(true)
      expect(r.stderr).toMatch(/no longer signed by this writer/)
      const ok = sh(`_heartbeat_release "${lock}" tok-theirs; echo "RC=$?"`)
      expect(ok.stdout).toContain('RC=0')
      expect(existsSync(lock)).toBe(false)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  }, 60_000)

  // 7. The losing reclaimer cannot remove a LIVE replacement owner.
  it('a losing reclaimer cannot remove a live replacement owner', () => {
    const dir = sandbox()
    try {
      const { lock } = lockWith(dir, `${deadPid()}\ntok-dead\n`)
      expect(sh(`_heartbeat_reclaim_stale "${lock}" tokenA; echo "RC=$?"`).stdout).toContain('RC=0')
      const w = livePid()
      try {
        mkdirSync(lock); writeFileSync(join(lock, 'owner'), `${w.pid}\ntok-live-winner\n`)
        spawnSync('touch', ['-t', '202001010000', lock])   // even backdated, it is ALIVE
        const b = sh(`_heartbeat_reclaim_stale "${lock}" tokenB; echo "RC=$?"`)
        expect(b.stdout).toContain('RC=1')
        expect(existsSync(lock)).toBe(true)
        expect(readFileSync(join(lock, 'owner'), 'utf-8').split('\n')[1]).toBe('tok-live-winner')
      } finally { w.kill() }
    } finally { rmSync(dir, { recursive: true, force: true }) }
  }, 60_000)

  // 8/9. Cleanup failures are reported, not swallowed.
  it('a claim that cannot be deleted propagates nonzero and stays visible', () => {
    const dir = sandbox()
    try {
      const { lock } = lockWith(dir, `${deadPid()}\ntok-dead\n`)
      // `rm -rf` of a directory needs write permission on its PARENT. Making the
      // sandbox read-only after the lock exists blocks the claim's deletion —
      // and the rename too, so the claim is staged in a writable subdirectory
      // instead: the lock lives one level down, and its parent is frozen.
      const inner = join(dir, 'inner')
      mkdirSync(inner)
      const hb2 = join(inner, 'heartbeat.log')
      const lock2 = `${hb2}.lock`
      mkdirSync(lock2)
      writeFileSync(join(lock2, 'owner'), `${deadPid()}\ntok-dead\n`)
      spawnSync('touch', ['-t', '202001010000', lock2])
      // A stub `rm` that always fails, ahead of the real one on PATH.
      const bin = join(dir, 'bin'); mkdirSync(bin)
      writeFileSync(join(bin, 'rm'), '#!/bin/bash\nexit 1\n', { mode: 0o755 })
      const r = spawnSync('/bin/bash', ['-c',
        `. "${HELPER}"; PATH="${bin}:$PATH"; _heartbeat_reclaim_stale "${lock2}" tokC; echo "RC=$?"`],
        { encoding: 'utf-8' })
      expect(r.stdout, 'a failed claim deletion was reported as success').toContain('RC=2')
      expect(r.stderr).toMatch(/could not delete/)
      expect(r.stderr, 'the residue must be named so an operator can find it').toMatch(/\.stale\.tokC/)
      expect(existsSync(`${lock2}.stale.tokC`), 'the claim residue should still be there').toBe(true)
      expect(lock).toBeTruthy()
    } finally { rmSync(dir, { recursive: true, force: true }) }
  }, 60_000)

  it('a recovery guard that cannot be released propagates nonzero and stays visible', () => {
    const dir = sandbox()
    try {
      const { lock } = lockWith(dir, `${deadPid()}\ntok-dead\n`)
      const bin = join(dir, 'bin'); mkdirSync(bin)
      writeFileSync(join(bin, 'rmdir'), '#!/bin/bash\nexit 1\n', { mode: 0o755 })
      const r = spawnSync('/bin/bash', ['-c',
        `. "${HELPER}"; PATH="${bin}:$PATH"; _heartbeat_reclaim_stale "${lock}" tokD; echo "RC=$?"`],
        { encoding: 'utf-8' })
      expect(r.stdout, 'a stuck recovery guard was reported as success').toContain('RC=2')
      expect(r.stderr).toMatch(/cannot release the recovery guard/)
      expect(r.stderr).toMatch(/operator removes that directory/)
      expect(existsSync(`${lock}.recovery`), 'the guard should still be there').toBe(true)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  }, 60_000)

  // 11. MUTATION. Age-only recovery must make the live-owner case fail.
  it('CONTROL: age-only recovery reclaims a LIVE owner', () => {
    const dir = sandbox(); const w = livePid()
    try {
      const { lock } = lockWith(dir, `${w.pid}\ntok-live\n`)
      const mutant = join(dir, 'ageonly.sh')
      // The Round 2 rule verbatim: old enough is reason enough.
      writeFileSync(mutant, [
        `. "${HELPER}"`,
        '_heartbeat_reclaim_stale_ageonly() {',
        '  local lock="$1" token="$2" claim="$1.stale.$2"',
        '  if _heartbeat_path_age_at_least "$lock" "$HEARTBEAT_LOCK_STALE_SECONDS"; then',
        '    mv "$lock" "$claim" 2>/dev/null && rm -rf "$claim" && return 0',
        '  fi',
        '  return 1',
        '}',
      ].join('\n'))
      const r = spawnSync('/bin/bash', ['-c',
        `. "${mutant}"; _heartbeat_reclaim_stale_ageonly "${lock}" tokM; echo "RC=$?"`],
        { encoding: 'utf-8' })
      expect(r.stdout, 'the age-only mutant declined — this control no longer discriminates')
        .toContain('RC=0')
      expect(existsSync(lock),
        'the age-only mutant left the live lock alone; the fix would then be untested').toBe(false)
      expect(spawnSync('ps', ['-p', w.pid, '-o', 'pid=']).status,
        'the owner must still be alive for this control to mean anything').toBe(0)
    } finally { w.kill(); rmSync(dir, { recursive: true, force: true }) }
  }, 60_000)

  it('the implementation requires a dead owner, structurally', () => {
    const code = readFileSync(HELPER, 'utf-8')
      .split('\n').filter(l => !l.trim().startsWith('#')).join('\n')
    expect(code, 'liveness must be classified with ps, not kill -0').toMatch(/ps -p "\$pid" -o pid=/)
    expect(code, 'kill -0 conflates permission and existence').not.toMatch(/kill -0/)
    const i = code.indexOf('_heartbeat_reclaim_stale()')
    const body = code.slice(i, code.indexOf('\n}', i))
    expect(body, 'the reclaimer must branch on owner state').toMatch(/alive\)/)
    expect(body, 'blocked states must be handled together').toMatch(/unknown\|malformed\|ownerless\)/)
    expect(body, 'only a dead owner may be claimed').toMatch(/dead\)/)
  })
})

// ── Retention ──────────────────────────────────────────────────────────────

describe('retention stays bounded at the newest 400 lines', () => {
  const run = (dir: string, hb: string, stamp: string) =>
    spawnSync('/bin/bash', ['-c', `. "${HELPER}"; heartbeat_record "${hb}" "${stamp}"`],
      { encoding: 'utf-8', cwd: dir })

  it('keeps 400 and drops the oldest when the file is over the bound', () => {
    const dir = sandbox()
    try {
      const hb = join(dir, 'heartbeat.log')
      // 500 pre-existing records, oldest first.
      writeFileSync(hb, Array.from({ length: 500 }, (_, i) => `old-${i}`).join('\n') + '\n')
      const r = run(dir, hb, 'NEWEST')
      expect(r.status, r.stderr).toBe(0)
      const lines = readFileSync(hb, 'utf-8').split('\n').filter(Boolean)
      expect(lines.length).toBe(400)
      expect(lines[lines.length - 1]).toBe('NEWEST')      // the new record survives
      expect(lines).not.toContain('old-0')                 // the oldest is dropped
      expect(lines).toContain('old-499')                   // the newest old record is kept
      expect(lines[0]).toBe('old-101')                     // exactly the newest 400
    } finally { rmSync(dir, { recursive: true, force: true }) }
  }, 60_000)

  it('does not pad a short file', () => {
    const dir = sandbox()
    try {
      const hb = join(dir, 'heartbeat.log')
      expect(run(dir, hb, 'first').status).toBe(0)
      expect(run(dir, hb, 'second').status).toBe(0)
      expect(readFileSync(hb, 'utf-8').split('\n').filter(Boolean)).toEqual(['first', 'second'])
    } finally { rmSync(dir, { recursive: true, force: true }) }
  }, 60_000)

  it('holds the bound exactly at 400 under concurrency', () => {
    const dir = sandbox()
    try {
      const hb = join(dir, 'heartbeat.log')
      writeFileSync(hb, Array.from({ length: 390 }, (_, i) => `old-${i}`).join('\n') + '\n')
      const r = race(dir, FIXED_BODY, 2, 25)          // 390 + 50 = 440 written
      expect(readFileSync(r.hb, 'utf-8').split('\n').filter(Boolean).length).toBe(400)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  }, 120_000)
})

// ── Failure propagation ────────────────────────────────────────────────────

describe('every failure mode propagates a nonzero status with a diagnostic', () => {
  const attempt = (script: string) =>
    spawnSync('/bin/bash', ['-c', `. "${HELPER}"; ${script}`], { encoding: 'utf-8' })

  it('an append that cannot happen fails, and says so', () => {
    const dir = sandbox()
    try {
      const ro = join(dir, 'ro'); mkdirSync(ro); chmodSync(ro, 0o500)
      const r = spawnSync('/bin/bash', ['-c',
        `. "${HELPER}"; HEARTBEAT_LOCK_TIMEOUT=1 heartbeat_record "${join(ro, 'heartbeat.log')}" STAMP`],
        { encoding: 'utf-8' })
      expect(r.status, 'an unwritable heartbeat directory was reported as success').not.toBe(0)
      expect(r.stderr).toMatch(/heartbeat/i)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  }, 60_000)

  it('a lock that cannot be acquired fails within the timeout, and says so', () => {
    const dir = sandbox()
    try {
      const hb = join(dir, 'heartbeat.log')
      writeFileSync(hb, 'existing\n')
      mkdirSync(`${hb}.lock`)                    // held by another writer, and fresh
      writeFileSync(join(`${hb}.lock`, 'owner'), `${process.pid}\ntok-someone-else\n`)
      const started = Date.now()
      const r = spawnSync('/bin/bash', ['-c',
        `. "${HELPER}"; HEARTBEAT_LOCK_TIMEOUT=2 HEARTBEAT_LOCK_STALE_SECONDS=3600 heartbeat_record "${hb}" STAMP`],
        { encoding: 'utf-8' })
      expect(r.status, 'a contended lock was reported as success').not.toBe(0)
      expect(r.stderr).toMatch(/lock/i)
      expect(Date.now() - started, 'the wait was unbounded').toBeLessThan(30_000)
      // and it did not write behind the lock
      expect(readFileSync(hb, 'utf-8')).toBe('existing\n')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  }, 60_000)

  it('a lock left by a DEAD owner is reclaimed rather than blocking forever', () => {
    const dir = sandbox()
    try {
      const hb = join(dir, 'heartbeat.log')
      const lock = `${hb}.lock`
      // A reaped pid, in the two-field format, on a backdated directory.
      const pid = spawnSync('/bin/bash', ['-c', 'sleep 0.01 & p=$!; wait $p; echo $p'],
        { encoding: 'utf-8' }).stdout.trim()
      mkdirSync(lock)
      writeFileSync(join(lock, 'owner'), `${pid}\ntok-dead\n`)
      spawnSync('touch', ['-t', '202001010000', lock])
      const r = spawnSync('/bin/bash', ['-c',
        `. "${HELPER}"; HEARTBEAT_LOCK_TIMEOUT=3 heartbeat_record "${hb}" AFTER-STALE`],
        { encoding: 'utf-8' })
      expect(r.status, r.stderr).toBe(0)
      expect(readFileSync(hb, 'utf-8')).toContain('AFTER-STALE')
      expect(r.stderr, 'reclaiming must be visible and must name the reason').toMatch(/dead owner/)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  }, 60_000)

  it('an unwritable heartbeat FILE fails even when the lock is obtainable', () => {
    const dir = sandbox()
    try {
      const hb = join(dir, 'heartbeat.log')
      writeFileSync(hb, 'existing\n')
      chmodSync(hb, 0o400)                       // directory writable, file not
      const r = attempt(`heartbeat_record "${hb}" STAMP`)
      expect(r.status, 'an unwritable heartbeat file was reported as success').not.toBe(0)
      expect(r.stderr).toMatch(/cannot append/i)
      expect(existsSync(`${hb}.lock`), 'the lock was left behind after the failure').toBe(false)
      expect(readFileSync(hb, 'utf-8')).toBe('existing\n')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  }, 60_000)

  it('a missing file argument fails closed', () => {
    const r = attempt('heartbeat_record ""')
    expect(r.status).not.toBe(0)
    expect(r.stderr).toMatch(/heartbeat/i)
  })

  it('a replace that cannot happen fails, and says so', () => {
    const dir = sandbox()
    try {
      const hb = join(dir, 'heartbeat.log')
      writeFileSync(hb, 'existing\n')
      // `tail` writes its output to a path we make impossible to create.
      const r = spawnSync('/bin/bash', ['-c',
        `. "${HELPER}"; HEARTBEAT_TMP_OVERRIDE="${join(dir, 'no', 'such', 'dir', 'x')}" heartbeat_record "${hb}" STAMP`],
        { encoding: 'utf-8' })
      expect(r.status, 'an impossible temporary path was reported as success').not.toBe(0)
      expect(r.stderr).toMatch(/heartbeat/i)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  }, 60_000)
})

// ── The callers ────────────────────────────────────────────────────────────

/**
 * Executable text only. These scripts document the defect they fix, so the word
 * `heartbeat_record` appears in prose long before the call site — searching the
 * raw source finds the comment and concludes the call is unchecked. That is the
 * same first-match trap that let three shadowed handlers through an earlier
 * review, so the assertions below read stripped code.
 */
function code(path: string): string {
  return readFileSync(path, 'utf-8')
    .split('\n')
    .filter(l => !l.trim().startsWith('#'))
    .join('\n')
}

describe('both scripts use the shared helper and check its result', () => {
  for (const [name, path] of [['daily-scheduler.sh', SCHEDULER], ['pipeline-watchdog.sh', WATCHDOG]] as const) {
    it(`${name} sources the helper and no longer inlines the racy idiom`, () => {
      const c = code(path)
      expect(c, `${name} does not source the helper`).toMatch(/\.\s+"\$REPO\/scripts\/heartbeat\.sh"/)
      expect(c, `${name} still writes the fixed .tmp path inline`)
        .not.toMatch(/tail -n 400 "\$SCHEDULER_HEARTBEAT_FILE" > "\$SCHEDULER_HEARTBEAT_FILE\.tmp"/)
      expect(c, `${name} still appends to the heartbeat inline`)
        .not.toMatch(/>> "\$SCHEDULER_HEARTBEAT_FILE"/)
      expect(c, `${name} does not call heartbeat_record`).toMatch(/heartbeat_record/)
    })

    it(`${name} exits nonzero when the heartbeat cannot be recorded`, () => {
      const c = code(path)
      const i = c.indexOf('heartbeat_record "$SCHEDULER_HEARTBEAT_FILE"')
      expect(i, `${name} has no heartbeat_record call site`).toBeGreaterThan(-1)
      const window = c.slice(i, i + 300)
      expect(window, `${name} calls heartbeat_record without acting on its status`).toMatch(/exit 1/)
      expect(c.slice(Math.max(0, i - 80), i), `${name} ignores the return status`).toMatch(/if ! /)
    })

    it(`${name} still guards the write behind --dry-run`, () => {
      const c = code(path)
      const i = c.indexOf('heartbeat_record "$SCHEDULER_HEARTBEAT_FILE"')
      expect(c.slice(Math.max(0, i - 300), i), `${name} lost its dry-run guard`).toMatch(/DRY_RUN"? -eq 0/)
    })
  }

  it('the watchdog additionally refuses to write in isolated mode', () => {
    const c = code(WATCHDOG)
    const i = c.indexOf('heartbeat_record "$SCHEDULER_HEARTBEAT_FILE"')
    expect(c.slice(Math.max(0, i - 300), i)).toMatch(/ISOLATION_MODE" != "isolated"/)
  })

  it('the helper names no production path in executable text', () => {
    // Its comments quote the observed production error, which is evidence, not
    // a hardcoded path. Only the code is asserted on.
    expect(code(HELPER)).not.toMatch(/Projects\.nosync|scheduler-heartbeat\.log/)
  })
})
