import { describe, it, expect } from 'vitest'
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { execFileSync, spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { resolveLogicalDateArg, isValidLogicalDate } from '../src/logical-date-arg.js'
import { logicalRunDate, openDb, closeDb } from '@common/pipeline-runs'

// FINDING 2 — the approved logical date must reach the submission.
//
// `daily-scheduler.sh` decided WHICH day it was submitting for, computed
// `$LOGICAL`, logged it, gated eligibility on it — and then invoked
// `daily-queue.sh` without passing it. `run-daily.ts` recomputed
// `logicalRunDate(new Date())` for itself. Those two clock readings are minutes
// apart, and when the gap straddles midnight in the business timezone the run
// is filed under a date nobody approved: the eligibility gate says "2026-08-29
// is due", and the row lands on 2026-08-30 — which then reads as already
// satisfied, so the real 08-30 run is suppressed and 08-29 never happened.
//
// SAFETY: nothing here submits, connects to Redis, or opens the production run
// store. The shell assertions read script text and run extracted argument
// parsing in a temporary directory.

const REPO = resolve(__dirname, '..', '..', '..')
const SCHEDULER = join(REPO, 'scripts', 'daily-scheduler.sh')
const QUEUE_SH = join(REPO, 'daily-queue.sh')

// ── The seam: a supplied date is used verbatim, never recomputed ───────────

describe('resolveLogicalDateArg', () => {
  it('uses the supplied date even when "now" has moved to the next day', () => {
    // THE DEFECT, expressed exactly: the scheduler approved 2026-08-29 at
    // 23:59:50 PDT; by the time the submission runs, the fallback clock says
    // 2026-08-30. The approved date must win.
    const r = resolveLogicalDateArg(['node', 'run-daily.ts', '--logical-date', '2026-08-29'],
      () => '2026-08-30')
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.logicalDate).toBe('2026-08-29')
      expect(r.supplied).toBe(true)
    }
  })

  it('is non-vacuous: the fallback really would have returned the other date', () => {
    // Guards against a test that would pass even if the fix were reverted.
    const justBeforeMidnight = new Date('2026-08-30T06:59:50.000Z')  // 23:59:50 PDT on 08-29
    const justAfter = new Date('2026-08-30T07:00:10.000Z')           // 00:00:10 PDT on 08-30
    expect(logicalRunDate(justBeforeMidnight)).toBe('2026-08-29')
    expect(logicalRunDate(justAfter)).toBe('2026-08-30')
    const r = resolveLogicalDateArg(['node', 'x', '--logical-date', logicalRunDate(justBeforeMidnight)],
      () => logicalRunDate(justAfter))
    expect(r.ok && r.logicalDate).toBe('2026-08-29')
  })

  it('falls back only when no date was supplied, and says so', () => {
    const r = resolveLogicalDateArg(['node', 'run-daily.ts'], () => '2026-08-30')
    expect(r.ok).toBe(true)
    if (r.ok) { expect(r.logicalDate).toBe('2026-08-30'); expect(r.supplied).toBe(false) }
  })

  it('REFUSES a malformed date rather than silently falling back', () => {
    // Falling back here would resurrect the bug under a different name: the
    // caller asked for a specific day and would get a different one.
    for (const bad of ['2026-8-9', '20260829', 'yesterday', '2026-08-29T00:00:00Z', '']) {
      const r = resolveLogicalDateArg(['node', 'x', '--logical-date', bad], () => '2026-08-30')
      expect(r.ok, `accepted "${bad}"`).toBe(false)
    }
  })

  it('REFUSES a flag with no value, and does not swallow the next flag', () => {
    expect(resolveLogicalDateArg(['node', 'x', '--logical-date'], () => '2026-08-30').ok).toBe(false)
    const r = resolveLogicalDateArg(['node', 'x', '--logical-date', '--verbose'], () => '2026-08-30')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/YYYY-MM-DD/)
  })

  it('rejects impossible calendar dates, not just the wrong shape', () => {
    expect(isValidLogicalDate('2026-13-01')).toBe(false)
    expect(isValidLogicalDate('2026-02-30')).toBe(false)
    expect(isValidLogicalDate('2026-08-29')).toBe(true)
  })
})

// ── The chain: scheduler → daily-queue.sh → run-daily.ts ───────────────────

describe('the approved date survives every hop', () => {
  const exec = (p: string) => readFileSync(p, 'utf-8').split('\n')
    .filter(l => !/^\s*#/.test(l)).join('\n')

  it('the scheduler PASSES $LOGICAL to daily-queue.sh', () => {
    expect(exec(SCHEDULER)).toMatch(/daily-queue\.sh"?\s+--logical-date\s+"\$LOGICAL"/)
  })

  it('daily-queue.sh forwards it to run-daily.ts', () => {
    const src = exec(QUEUE_SH)
    expect(src).toMatch(/--logical-date\)/)
    expect(src).toMatch(/run-daily\.ts"?\s+"\$\{LOGICAL_DATE_ARGS\[@\]\}"/)
  })

  it('run-daily.ts submits the resolved date instead of recomputing one', () => {
    const src = readFileSync(join(__dirname, '..', 'bin', 'run-daily.ts'), 'utf-8')
    expect(src).toMatch(/resolveLogicalDateArg\(/)
    expect(src).toMatch(/submitDailyPipeline\(\{\s*logicalDate/)
    // The old unconditional recomputation must not survive as the live value.
    const live = src.split('\n').filter(l => !/^\s*(\/\/|\*)/.test(l)).join('\n')
    expect(live).not.toMatch(/logicalDate:\s*logicalRunDate\(new Date\(\)\)/)
  })
})

// ── daily-queue.sh's own validation, run for real in a temp directory ──────

describe('daily-queue.sh argument validation', () => {
  const parseBlock = () => {
    const src = readFileSync(QUEUE_SH, 'utf-8')
    const start = src.indexOf('LOGICAL_DATE_ARGS=()')
    const end = src.indexOf('npx tsx', start)   // AFTER start: the file has an earlier `npx tsx`
    expect(start, 'argument parsing not found').toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    return src.slice(start, end)
  }

  /** Run only the parsing block — never the submission below it. */
  const run = (args: string[]) => {
    const block = parseBlock()          // outside the try: an extraction bug must not
    const dir = mkdtempSync(join(tmpdir(), 'queue-args-'))   // masquerade as a non-zero exit
    try {
      const h = join(dir, 'h.sh')
      writeFileSync(h, ['log() { echo "$*"; }', block,
        'echo "ARGS:${LOGICAL_DATE_ARGS[*]}"'].join('\n'))
      const r = execFileSync('/bin/bash', [h, ...args], { encoding: 'utf-8' })
      return { status: 0, out: r.trim() }
    } catch (e: any) {
      return { status: e.status as number, out: `${e.stdout ?? ''}${e.stderr ?? ''}`.trim() }
    } finally { rmSync(dir, { recursive: true, force: true }) }
  }

  it('accepts and forwards a well-formed date', () => {
    const r = run(['--logical-date', '2026-08-29'])
    expect(r.status).toBe(0)
    expect(r.out).toContain('ARGS:--logical-date 2026-08-29')
  })

  it('passes nothing when given nothing, so ad-hoc runs still work', () => {
    const r = run([])
    expect(r.status).toBe(0)
    expect(r.out).toContain('ARGS:')
    expect(r.out).not.toContain('--logical-date')
  })

  it('exits 2 on a malformed date rather than submitting the wrong day', () => {
    const r = run(['--logical-date', '29-08-2026'])
    expect(r.status).toBe(2)
    expect(r.out).toMatch(/YYYY-MM-DD/)
  })

  it('exits 2 when the flag has no value', () => {
    expect(run(['--logical-date']).status).toBe(2)
  })
})

// ── The under-lock recheck must ask about, and get back, $LOGICAL ─────────

describe('under-lock recheck', () => {
  it('passes the approved date to the status CLI', () => {
    const exec = readFileSync(SCHEDULER, 'utf-8').split('\n')
      .filter(l => !/^\s*#/.test(l)).join('\n')
    expect(exec).toMatch(/daily-run-status\.ts[\s\\]+--json --logical-date "\$LOGICAL"/)
  })

  /**
   * Run the recheck's validation block in isolation, with a preset response.
   * Extracted from the real script so the assertions cannot drift from it.
   */
  const validate = (json: string, logical = '2026-08-29') => {
    const src = readFileSync(SCHEDULER, 'utf-8')
    const start = src.indexOf('if [ -z "$RECHECK_JSON" ]; then')
    const end = src.indexOf('# An isolated run must never reach the production submitter')
    expect(start, 'recheck validation block not found').toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    const block = src.slice(start, end)

    const dir = mkdtempSync(join(tmpdir(), 'recheck-'))
    try {
      const h = join(dir, 'h.sh')
      writeFileSync(h, [
        'log() { echo "$*" >&2; }',
        `LOGICAL='${logical}'`,
        `RECHECK_JSON=$(cat <<'J'
${json}
J
)`,
        block,
        'echo PROCEEDED',
      ].join('\n'))
      // spawnSync, not execFileSync: the "not eligible" path exits 0 and logs to
      // stderr, which execFileSync discards on success.
      const r = spawnSync('/bin/bash', [h], { encoding: 'utf-8' })
      return { code: r.status as number, out: `${r.stdout}${r.stderr}`.trim() }
    } finally { rmSync(dir, { recursive: true, force: true }) }
  }

  it('proceeds when the recheck answers eligible FOR THE APPROVED DATE', () => {
    const r = validate('{"eligibleToRun": true, "logicalDate": "2026-08-29"}')
    expect(r.code).toBe(0)
    expect(r.out).toContain('PROCEEDED')
  })

  it('5. FAILS CLOSED when the recheck answers for a DIFFERENT date', () => {
    // The exact midnight-crossing symptom, seen from the scheduler's side.
    const r = validate('{"eligibleToRun": true, "logicalDate": "2026-08-30"}')
    expect(r.code).toBe(1)
    expect(r.out).toMatch(/recheck answered for 2026-08-30 but 2026-08-29 was approved/)
    expect(r.out).not.toContain('PROCEEDED')
  })

  it('5b. FAILS CLOSED on malformed JSON', () => {
    const r = validate('{not json')
    expect(r.code).toBe(1)
    expect(r.out).toMatch(/unparseable/)
    expect(r.out).not.toContain('PROCEEDED')
  })

  it('5c. FAILS CLOSED when the response is missing a field', () => {
    const r = validate('{"eligibleToRun": true}')
    expect(r.code).toBe(1)
    expect(r.out).not.toContain('PROCEEDED')
  })

  it('5d. FAILS CLOSED on empty output', () => {
    const r = validate('')
    expect(r.code).toBe(1)
    expect(r.out).toMatch(/refusing to submit blind/)
  })

  it('stops WITHOUT failing when the right date is simply no longer eligible', () => {
    // Not an error: another fire started it. Exit 0, no submission.
    const r = validate('{"eligibleToRun": false, "logicalDate": "2026-08-29"}')
    expect(r.code).toBe(0)
    expect(r.out).toMatch(/no longer eligible for 2026-08-29/)
    expect(r.out).not.toContain('PROCEEDED')
  })
})

// ── The status CLI validates the date it is handed ────────────────────────

describe('daily-run-status --logical-date', () => {
  const STATUS = resolve(REPO, 'packages', 'pipeline-runs', 'bin', 'daily-run-status.ts')
  const TSX = resolve(REPO, 'node_modules', '.bin', 'tsx')

  const cli = (args: string[], dbPath: string) => {
    try {
      return { code: 0, out: execFileSync(TSX, [STATUS, ...args],
        { encoding: 'utf-8', timeout: 90_000, env: { ...process.env, PIPELINE_RUNS_DB: dbPath } }) }
    } catch (e: any) {
      return { code: e.status as number, out: `${e.stdout ?? ''}${e.stderr ?? ''}` }
    }
  }

  it('assesses the requested date and echoes it back', () => {
    const dir = mkdtempSync(join(tmpdir(), 'status-date-'))
    try {
      const dbPath = join(dir, 'runs.db')
      openDb(dbPath).close(); closeDb()
      const r = cli(['--json', '--logical-date', '2026-08-29'], dbPath)
      expect(r.code).toBe(0)
      expect(JSON.parse(r.out).logicalDate).toBe('2026-08-29')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('rejects a malformed date instead of assessing some other day', () => {
    const dir = mkdtempSync(join(tmpdir(), 'status-date-bad-'))
    try {
      const dbPath = join(dir, 'runs.db')
      openDb(dbPath).close(); closeDb()
      for (const bad of ['2026-13-40', 'today', '20260829']) {
        expect(cli(['--json', '--logical-date', bad], dbPath).code, `accepted ${bad}`).toBe(2)
      }
      expect(cli(['--json', '--logical-date'], dbPath).code).toBe(2)
      expect(cli(['--json', '--logical-date', '--exit-code'], dbPath).code).toBe(2)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
}, 120_000)
