/**
 * K6-C2.2.1: THE CONTAINER'S OWN REPORTING, PROVED UNDER THE KILL IT IS DESIGNED
 * TO DIE FROM.
 *
 * A contained hold is ended by SIGKILL to its process group - that is the only
 * thing that ends an unbounded `holdForIntervention`, and it is deliberate. Every
 * verdict those cases assert therefore comes from a document written by a process
 * that was killed without warning while writing it. These cases prove the
 * document survives that, and that a parent which cannot read one says so instead
 * of reporting a hold that did nothing.
 */
import { describe, expect, it } from 'vitest'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ROOT_PREFIX_FOR, RUN_NONCE, realTmp } from './support/roots.js'
import { publishAtomically } from './support/publish.js'

const CHILD = fileURLToPath(new URL('./support/publish-child.ts', import.meta.url))
const TSX = fileURLToPath(new URL('../node_modules/.bin/tsx', import.meta.url))

const scratch = (): string => mkdtempSync(join(realTmp(), ROOT_PREFIX_FOR(RUN_NONCE, process.pid)))

/** One publisher, killed by group SIGKILL at an arbitrary moment. */
async function killDuringPublication(file: string, writer: 'atomic' | 'plain'): Promise<void> {
  const child = spawn(TSX, [CHILD, file, writer], { detached: true, stdio: 'ignore' })
  const pid = child.pid as number
  const ended = new Promise<void>(resolve => { child.on('exit', () => resolve()) })
  // Long enough to have published many times, short enough to stay inside the
  // run budget; the kill therefore lands in the middle of the write loop.
  await new Promise(r => setTimeout(r, 120 + Math.floor(Math.random() * 60)))
  try { process.kill(-pid, 'SIGKILL') } catch { /* already gone */ }
  await ended
}

/** What the container does with the file afterwards: read it once, parse it once. */
const readable = (file: string): boolean => {
  if (!existsSync(file)) return false
  try { JSON.parse(readFileSync(file, 'utf-8')); return true } catch { return false }
}

describe('K6-C2.2.1: a killed publisher still leaves a whole document', () => {
  it('never leaves a torn or empty document, across many kills', async () => {
    const dir = scratch()
    try {
      let unreadable = 0
      for (let i = 0; i < 40; i += 1) {
        const file = join(dir, `progress-${String(i)}`)
        await killDuringPublication(file, 'atomic')
        // A kill may land before the first publication - that is an absent file,
        // which is honestly "nothing yet". What must never happen is a file that
        // EXISTS and cannot be read.
        if (existsSync(file) && !readable(file)) unreadable += 1
      }
      expect(unreadable).toBe(0)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  }, 120_000)

  it('KILLS THE CONTROL: the same kills tear a plainly-written document', async () => {
    // Without this, the case above would pass against a publisher that never
    // republished at all. 40 kills at the measured ~37.5% leave the plain writer
    // unreadable with a probability of 1 - 0.625^40.
    const dir = scratch()
    try {
      let unreadable = 0
      for (let i = 0; i < 40; i += 1) {
        const file = join(dir, `plain-${String(i)}`)
        await killDuringPublication(file, 'plain')
        if (existsSync(file) && !readable(file)) unreadable += 1
      }
      expect(unreadable).toBeGreaterThan(0)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  }, 120_000)

  it('publishes through a same-parent temporary file and leaves none behind', () => {
    const dir = scratch()
    try {
      const file = join(dir, 'doc')
      publishAtomically(file, 'one\n')
      publishAtomically(file, 'two\n')
      expect(readFileSync(file, 'utf-8')).toBe('two\n')
      expect(existsSync(`${file}.partial`)).toBe(false)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('a report that exists but cannot be read is refused, not read as nothing', async () => {
    const dir = scratch()
    try {
      const file = join(dir, 'progress')
      writeFileSync(file, '')
      const { readReportForTest } = await import('./support/contained.js')
      expect(() => readReportForTest(file)).toThrow(/could not be read as one/)
      // AND AN ABSENT ONE IS STILL NOTHING OBSERVED, which is a different thing.
      expect(readReportForTest(join(dir, 'never-written')).requests.length).toBe(0)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})
