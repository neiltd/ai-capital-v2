// K7-B PHASE A: the operator channel is proved BEFORE anything is contacted.
//
// `runOpsCli` measures the source identity for every mode - it opens a
// read-only session and runs `git` - and that happens before the `--apply`
// branch is reached. So a preflight performed inside that branch would run
// AFTER a database session already existed, and a preflight that fails after
// the fence is taken is the one state a production apply must never reach: a
// held source and no channel through which anyone can tell it to let go.
//
// These cases prove the ordering by COUNTING what was opened, not by reading
// the source.
import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { runOpsCli, type OperatorChannel, type OpsDeps } from '../bin/pg-copy-ops.js'

/** Every seam a failing preflight must not reach. */
const countingDeps = (channel: OperatorChannel): OpsDeps & {
  counts: Record<string, number>
} => {
  const counts = {
    openSourceIdentity: 0, openTargetIdentity: 0, openSupervisor: 0,
    openProver: 0, measureRepository: 0, commands: 0, queue: 0,
  }
  return {
    counts,
    newRunId: () => 'aabbccdd',
    stamp: () => '20260930T000000Z',
    operatorChannel: () => channel,
    openSourceIdentity: async () => { counts.openSourceIdentity += 1; throw new Error('unreachable') },
    openTargetIdentity: async () => { counts.openTargetIdentity += 1; throw new Error('unreachable') },
    openSupervisor: async () => { counts.openSupervisor += 1; throw new Error('unreachable') },
    openProver: async () => { counts.openProver += 1; throw new Error('unreachable') },
    measureRepository: async () => { counts.measureRepository += 1; throw new Error('unreachable') },
    commands: () => { counts.commands += 1; throw new Error('unreachable') },
  } as unknown as OpsDeps & { counts: Record<string, number> }
}

const applyArgv = (root: string, extra: readonly string[] = []): string[] => [
  '--apply',
  `--evidence-root=${root}`,
  '--producer-authority=manual-stop',
  ...extra,
]

describe('K7-B Phase A: preflight precedes every apply contact', () => {
  it('a FAILED preflight opens no source, target, supervisor or prover session', async () => {
    const root = mkdtempSync(join(tmpdir(), 'k7b-ord-'))
    try {
      const preflight = vi.fn(() => { throw new Error('no terminal and no resolution file') })
      const channel: OperatorChannel = {
        preflight, arm: () => () => undefined,
        nextLine: async () => '', close: () => undefined,
      }
      const d = countingDeps(channel)
      const r = await runOpsCli(applyArgv(root), d)

      expect(preflight).toHaveBeenCalledTimes(1)
      // NOTHING ELSE HAPPENED. Not a session, not a repository measurement,
      // not a launchctl call.
      expect(d.counts).toEqual({
        openSourceIdentity: 0, openTargetIdentity: 0, openSupervisor: 0,
        openProver: 0, measureRepository: 0, commands: 0, queue: 0,
      })
      expect(r.exitCode).not.toBe(0)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  it('the preflight runs BEFORE the source identity measurement', async () => {
    // Ordering proved by sequence, not by absence: the preflight succeeds, and
    // the very next recorded event is the source measurement it must precede.
    const root = mkdtempSync(join(tmpdir(), 'k7b-ord-'))
    try {
      const order: string[] = []
      const channel: OperatorChannel = {
        preflight: () => { order.push('preflight') },
        arm: () => () => undefined,
        nextLine: async () => '',
        close: () => { order.push('close') },
      }
      const d = {
        newRunId: () => 'aabbccdd',
        stamp: () => '20260930T000000Z',
        operatorChannel: () => channel,
        openSourceIdentity: async () => {
          order.push('openSourceIdentity')
          throw new Error('stop here')
        },
      } as unknown as OpsDeps
      await runOpsCli(applyArgv(root, ['--source-host=127.0.0.1']), d)
      expect(order[0]).toBe('preflight')
      expect(order).toContain('openSourceIdentity')
      expect(order.indexOf('preflight')).toBeLessThan(order.indexOf('openSourceIdentity'))
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  it('the channel used later is the EXACT preflighted object', async () => {
    const root = mkdtempSync(join(tmpdir(), 'k7b-ord-'))
    try {
      let handed: OperatorChannel | null = null
      const channel: OperatorChannel = {
        preflight: () => undefined, arm: () => () => undefined,
        nextLine: async () => '', close: () => undefined,
      }
      const d = {
        newRunId: () => 'aabbccdd',
        stamp: () => '20260930T000000Z',
        operatorChannel: (): OperatorChannel => { handed = channel; return channel },
        openSourceIdentity: async () => { throw new Error('stop here') },
      } as unknown as OpsDeps
      await runOpsCli(applyArgv(root, ['--source-host=127.0.0.1']), d)
      expect(handed).toBe(channel)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  it('NON-apply modes construct no operator channel at all', async () => {
    // They take no fence, so there is nothing to hold and nobody to ask.
    const root = mkdtempSync(join(tmpdir(), 'k7b-ord-'))
    try {
      const factory = vi.fn()
      const d = {
        newRunId: () => 'aabbccdd',
        stamp: () => '20260930T000000Z',
        operatorChannel: factory,
        openSourceIdentity: async () => { throw new Error('stop here') },
      } as unknown as OpsDeps
      await runOpsCli(
        ['--inspect', '--for=rehearse', `--evidence-root=${root}`,
         '--producer-authority=manual-stop', '--source-host=127.0.0.1'], d)
      expect(factory).not.toHaveBeenCalled()
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
})
