// A SCHEDULED SUBMISSION THAT CANNOT FINISH MUST NOT START.
//
// WHAT THIS IS ABOUT, MEASURED. On 2026-09-28 a scheduled run submitted a 23-job
// flow, ran 100 jobs, and failed terminally because `ANTHROPIC_API_KEY` was not in
// the approved environment. The cost was not the failure — it was everything the
// submission created on its way to discovering it: a `pipeline_runs` row recorded
// as failed, two terminally failed jobs, and eleven parents parked behind them for
// ever, which then had to be retired by a purpose-built tool.
//
// The key was absent BEFORE the first job existed. So the check belongs before the
// first row and the first job, and these cases pin both halves: that it refuses,
// and that it refuses without ever putting the value it is checking into an error.
//
// AND THE ROOT .env IS READ AS A SECRET CONTAINER. It holds that key. The reader
// used to be `readFileSync(path)` — a read of a NAME, with no check on what the
// name pointed at. Every refusal below is asserted on the OPEN DESCRIPTOR.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  chmodSync, linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  REQUIRED_SUBMISSION_KEYS, SubmissionPreflightRefused, loadApprovedRootEnv,
  requireSubmissionKeys,
} from '../src/env.js'
import {
  RootEnvRefused, defaultRootEnvSeam, readRootEnvContainer, type RootEnvSeam,
} from '../src/root-env-container.js'

/** A key-shaped value that must never appear in any message. */
const FAKE_KEY = 'sk-ant-api03-THIS-IS-A-FAKE-TEST-KEY-do-not-report-me'

let root: string
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'queue-preflight-')) })
afterEach(() => { rmSync(root, { recursive: true, force: true }) })

function container(body: string, mode = 0o600): string {
  const p = join(root, '.env')
  writeFileSync(p, body, { encoding: 'utf-8', mode })
  chmodSync(p, mode)
  return p
}

describe('the submission preflight', () => {
  it('requires ANTHROPIC_API_KEY, and says so by name', () => {
    expect(REQUIRED_SUBMISSION_KEYS).toContain('ANTHROPIC_API_KEY')
  })

  for (const [what, env] of [
    ['missing', {}],
    ['empty', { ANTHROPIC_API_KEY: '' }],
  ] as const) {
    it(`refuses when the key is ${what}`, () => {
      expect(() => requireSubmissionKeys(env)).toThrow(SubmissionPreflightRefused)
      expect(() => requireSubmissionKeys(env)).toThrow(/ANTHROPIC_API_KEY/)
    })
  }

  it('accepts a non-empty key', () => {
    expect(() => requireSubmissionKeys({ ANTHROPIC_API_KEY: FAKE_KEY })).not.toThrow()
  })

  /**
   * THE MESSAGE NAMES THE KEY AND NOTHING ELSE.
   *
   * Not the value, not its length, not a prefix, not a digest. An error string
   * reaches logs, launchd, evidence and crash dumps, and a length alone narrows a
   * secret. The supplied value here is deliberately key-shaped so a leak would be
   * unmistakable.
   */
  it('never reports the value, its length or any digest of it', () => {
    let message = ''
    try {
      // A second required key is injected so the refusal happens WHILE a real
      // value is present in the same environment.
      requireSubmissionKeys(
        { ANTHROPIC_API_KEY: FAKE_KEY, OTHER_REQUIRED: '' },
        ['ANTHROPIC_API_KEY', 'OTHER_REQUIRED'])
    } catch (e) { message = (e as Error).message }
    expect(message).toContain('OTHER_REQUIRED')
    expect(message).not.toContain(FAKE_KEY)
    expect(message).not.toContain(String(FAKE_KEY.length))
    expect(message).not.toContain(FAKE_KEY.slice(0, 8))
  })

  /**
   * IT RUNS BEFORE ANYTHING IS RECORDED OR ENQUEUED.
   *
   * Asserted structurally against run-daily's own source, because the ordering is
   * the property: a preflight that ran after `submitDailyPipeline` would refuse
   * just as loudly and have prevented nothing.
   */
  it('is called in run-daily before the row and the submission', () => {
    const src = readFileSync(
      fileURLToPath(new URL('../bin/run-daily.ts', import.meta.url)), 'utf-8')
    const preflight = src.indexOf('requireSubmissionKeys(process.env)')
    const submit = src.indexOf('submitDailyPipeline(')
    expect(preflight, 'run-daily calls the preflight').toBeGreaterThan(-1)
    expect(submit, 'run-daily submits').toBeGreaterThan(-1)
    expect(preflight, 'the preflight precedes the submission').toBeLessThan(submit)
    // …and nothing records a row before it either.
    const record = src.indexOf('recordStart')
    if (record > -1) expect(preflight).toBeLessThan(record)
  })
})

describe('the root .env is read as a secret container', () => {
  it('accepts a 0600 regular file owned by this user', () => {
    const p = container(`ANTHROPIC_API_KEY=${FAKE_KEY}\n`)
    expect(readRootEnvContainer(p)).toContain('ANTHROPIC_API_KEY')
  })

  it('treats an absent file as a no-op, and only that', () => {
    expect(readRootEnvContainer(join(root, '.env'))).toBeNull()
    const target: NodeJS.ProcessEnv = {}
    expect(() => loadApprovedRootEnv(root, target)).not.toThrow()
    expect(Object.keys(target)).toEqual([])
  })

  it('refuses a relative path', () => {
    expect(() => readRootEnvContainer('.env')).toThrow(/absolute path/)
  })

  it('refuses a symlink at the final component', () => {
    const real = container(`ANTHROPIC_API_KEY=${FAKE_KEY}\n`)
    const link = join(root, 'linked.env')
    symlinkSync(real, link)
    expect(() => readRootEnvContainer(link)).toThrow(/is a symbolic link/)
  })

  it('refuses a directory', () => {
    const d = join(root, 'dir.env')
    mkdirSync(d)
    expect(() => readRootEnvContainer(d)).toThrow(/is not a regular file|could not be opened/)
  })

  for (const mode of [0o644, 0o640, 0o604, 0o400, 0o666] as const) {
    it(`refuses mode ${mode.toString(8)}`, () => {
      const p = container(`ANTHROPIC_API_KEY=${FAKE_KEY}\n`, mode)
      expect(() => readRootEnvContainer(p)).toThrow(/must be mode 0600/)
    })
  }

  it('refuses a second hard link', () => {
    const p = container(`ANTHROPIC_API_KEY=${FAKE_KEY}\n`)
    linkSync(p, join(root, 'second-name.env'))
    expect(() => readRootEnvContainer(p)).toThrow(/more than one hard link/)
  })

  /**
   * THE OWNERSHIP BRANCH, REACHED.
   *
   * A test runner cannot create a file owned by another user, so the seam reports
   * a foreign uid while every other property stays correct. Without this the check
   * would be unreachable and a mutant deleting it would survive.
   */
  it('refuses a file owned by another user', () => {
    const p = container(`ANTHROPIC_API_KEY=${FAKE_KEY}\n`)
    // SPREADING A `Stats` LOSES ITS METHODS. `isFile` lives on the prototype, so
    // `{...st, uid}` produces an object whose `isFile` is undefined and the reader
    // fails for the wrong reason — measured. The stand-in is built explicitly.
    const seam: RootEnvSeam = {
      ...defaultRootEnvSeam,
      fstatSync: (fd) => {
        const st = defaultRootEnvSeam.fstatSync(fd)
        return { isFile: () => st.isFile(), uid: 999999, mode: st.mode, nlink: st.nlink, size: st.size }
      },
    }
    expect(() => readRootEnvContainer(p, seam)).toThrow(/owned by another user/)
  })

  it('refuses when ownership cannot be established on this platform', () => {
    const p = container(`ANTHROPIC_API_KEY=${FAKE_KEY}\n`)
    const seam: RootEnvSeam = { ...defaultRootEnvSeam, currentUid: () => -1 }
    expect(() => readRootEnvContainer(p, seam)).toThrow(/cannot be ownership-checked/)
  })

  it('refuses a dishonest read count from the seam', () => {
    const p = container(`ANTHROPIC_API_KEY=${FAKE_KEY}\n`)
    const seam: RootEnvSeam = {
      ...defaultRootEnvSeam,
      readSync: () => 10_000_000,
    }
    expect(() => readRootEnvContainer(p, seam)).toThrow(/read count/)
  })

  it('reports the path but never the contents, on every refusal', () => {
    const p = container(`ANTHROPIC_API_KEY=${FAKE_KEY}\n`, 0o644)
    let message = ''
    try { readRootEnvContainer(p) } catch (e) {
      expect(e).toBeInstanceOf(RootEnvRefused)
      message = (e as Error).message
    }
    expect(message).toContain(p)
    expect(message).not.toContain(FAKE_KEY)
  })

  it('closes its descriptor on the refusal paths too', () => {
    const p = container(`ANTHROPIC_API_KEY=${FAKE_KEY}\n`, 0o644)
    let closed = 0
    const seam: RootEnvSeam = {
      ...defaultRootEnvSeam,
      closeSync: (fd) => { closed += 1; defaultRootEnvSeam.closeSync(fd) },
    }
    expect(() => readRootEnvContainer(p, seam)).toThrow(/must be mode 0600/)
    expect(closed, 'the descriptor was closed despite the refusal').toBe(1)
  })

  it('uses the real fs by default — the seam is not the mechanism', () => {
    // Non-vacuity for every injected case above.
    const p = container(`ANTHROPIC_API_KEY=${FAKE_KEY}\n`)
    expect(readRootEnvContainer(p)).toBe(readRootEnvContainer(p, defaultRootEnvSeam))
  })
})
