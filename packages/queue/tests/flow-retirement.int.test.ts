// ANCESTOR-FIRST REMOVAL, AGAINST A REAL REDIS THAT IS NOT PRODUCTION.
//
// WHY THIS CANNOT BE A UNIT TEST. The hazard lives inside BullMQ's Lua: removing a
// job SREMs it from its parent's dependency set, and when that set empties the
// parent is ZREM'd out of `waiting-children` and pushed into `wait`, where a live
// worker executes it. No fixture reproduces that; only Redis does. It was
// reproduced on an isolated Redis on 2026-08-27, when a parked parent carrying a
// two-month-old parentRunId ran because a capped `failed` set trimmed the one leaf
// pinning it.
//
// SO A DISPOSABLE SERVER IS SPAWNED PER RUN: its own port, its own directory, no
// persistence, killed and removed in `finally`. Production Redis on 6379 is never
// contacted — the port is asserted to differ, and the connection is built from the
// spawned instance's own coordinates rather than from any environment variable.

// THE ISOLATION SETUP IS LOADED, NOT SIDESTEPPED.
//
// `isolation-mode.test.ts` enforces that every test constructing a Queue, Worker
// or FlowProducer loads this setup, which proves Redis, the run database and the
// filesystem root are ALL isolated before any client exists — and refuses the run
// otherwise. This file spawns its own Redis, but the guard cannot know that, and
// the rule exists precisely because a test that connects to `daily-pipeline` on
// the default URL reaches the production queue. So the three coordinates are
// pointed at this run's own throwaway locations at module load, before the setup's
// hook reads them.
import '../testing/queue-integration-setup.js'

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FlowProducer, Queue } from 'bullmq'

import { collectFlowJobs, planFlowRemoval, removeFlow } from '../src/flow-cleanup.js'

const REDIS_SERVER = '/opt/homebrew/bin/redis-server'
const QUEUE = 'retirement-int'

// CHOSEN AT MODULE LOAD so the isolation hook — which runs after every module body
// and before the first test — sees an environment that is already isolated on all
// three dimensions. A high random port, never production's 6379.
const dir: string = mkdtempSync(join(tmpdir(), 'retire-int-redis-'))
const port: number = 45000 + Math.floor(Math.random() * 2000)
process.env.REDIS_URL = `redis://127.0.0.1:${String(port)}`
process.env.PIPELINE_RUNS_DB = join(dir, 'pipeline-runs.db')
process.env.AI_CAPITAL_ROOT = dir

let server: ChildProcess | null = null

const sleep = async (ms: number): Promise<void> =>
  await new Promise<void>(r => { setTimeout(r, ms) })

const connection = () => ({ host: '127.0.0.1', port, db: 0 })

beforeAll(async () => {
  expect(existsSync(REDIS_SERVER), 'a disposable redis-server binary is available').toBe(true)
  expect(port, 'never production').not.toBe(6379)
  server = spawn(REDIS_SERVER, [
    '--port', String(port), '--dir', dir,
    '--save', '', '--appendonly', 'no', '--daemonize', 'no',
  ], { stdio: 'ignore' })

  // Bounded readiness wait.
  const until = Date.now() + 20_000
  for (;;) {
    try {
      const probe = new Queue(QUEUE, { connection: connection(), skipMetasUpdate: true })
      await probe.client
      await probe.close()
      break
    } catch {
      if (Date.now() > until) throw new Error('the disposable redis never became ready')
      await sleep(100)
    }
  }
}, 60_000)

afterAll(() => {
  if (server !== null) { try { server.kill('SIGKILL') } catch { /* gone */ } }
  server = null
  rmSync(dir, { recursive: true, force: true })
})

/** One three-deep flow whose jobs all carry `parentRunId`. */
async function makeFlow(flows: FlowProducer, parentRunId: string): Promise<void> {
  await flows.add({
    name: 'root', queueName: QUEUE, data: { parentRunId },
    children: [{
      name: 'mid', queueName: QUEUE, data: { parentRunId },
      children: [{ name: 'leaf', queueName: QUEUE, data: { parentRunId } }],
    }],
  })
}

async function census(parentRunId: string) {
  const q = new Queue(QUEUE, { connection: connection(), skipMetasUpdate: true })
  try { return await collectFlowJobs(q, parentRunId) } finally { await q.close() }
}

async function stateOf(parentRunId: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  for (const j of await census(parentRunId)) out[j.name] = j.state
  return out
}

describe('retiring one flow leaves every other flow untouched', () => {
  it('removes the target ancestors-first and preserves the unrelated flow exactly', async () => {
    const flows = new FlowProducer({ connection: connection() })
    const TARGET = 'aaaaaaaa-0000-0000-0000-000000000001'
    const OTHER = 'bbbbbbbb-0000-0000-0000-000000000002'
    try {
      await makeFlow(flows, TARGET)
      await makeFlow(flows, OTHER)

      const before = await stateOf(TARGET)
      const otherBefore = await stateOf(OTHER)
      expect(Object.keys(before).sort(), 'the target flow is present')
        .toEqual(['leaf', 'mid', 'root'])
      expect(before.root, 'the root is parked on its child').toBe('waiting-children')
      expect(otherBefore, 'the unrelated flow is present').toEqual(before)

      // THE PLAN PUTS ANCESTORS FIRST, on a real census.
      const plan = planFlowRemoval(TARGET, await census(TARGET))
      const order = plan.order.map(s => s.name)
      expect(order.indexOf('root')).toBeLessThan(order.indexOf('leaf'))
      expect(order.indexOf('mid')).toBeLessThan(order.indexOf('leaf'))

      const q = new Queue(QUEUE, { connection: connection() })
      let removed = 0
      try {
        removed = (await removeFlow(q, TARGET, { dryRun: false })).removed
      } finally {
        await q.close()
      }

      // THE COUNT IS NOT THE JOB COUNT, AND THAT IS THE POINT.
      //
      // Measured: three jobs, one `remove()` call. BullMQ removes a parent's
      // dependent children with it, so taking the ancestor first takes the whole
      // subtree — and the later steps find nothing left to remove. That is exactly
      // the property the ordering exists for: after the first removal there is no
      // parent remaining whose dependency set could empty and release anything.
      // A leaf-first cleanup would instead have made three separate removals, each
      // one a chance to release the parent above it.
      // EXACTLY ONE CALL, and that number is the signature of the ordering.
      //
      // A leaf-first pass would make three: leaf, then mid, then root — and each of
      // those is a moment at which the parent above could be released into `wait`.
      // Accepting "between one and three" let a reversed removal order pass this
      // case entirely. Measured: the mutant survived until this was pinned.
      expect(removed, 'the ancestor took the whole subtree in one removal').toBe(1)
      expect(await census(TARGET), 'no job of the target flow remains').toEqual([])

      // AND THE UNRELATED FLOW IS UNCHANGED — same jobs, same states.
      expect(await stateOf(OTHER)).toEqual(otherBefore)
    } finally {
      await flows.close()
    }
  }, 60_000)

  /**
   * THE HAZARD, DEMONSTRATED — so the ordering above is not merely a preference.
   *
   * Removing the LEAF first empties its parent's dependency set, and BullMQ moves
   * that parent out of `waiting-children` into `wait`: runnable. This is the
   * resurrection the ancestor-first order exists to prevent, and asserting it here
   * is what makes the previous case's ordering load-bearing rather than decorative.
   */
  it('leaf-first removal RELEASES a parked parent into wait', async () => {
    const flows = new FlowProducer({ connection: connection() })
    const HAZARD = 'cccccccc-0000-0000-0000-000000000003'
    try {
      await makeFlow(flows, HAZARD)
      const before = await stateOf(HAZARD)
      expect(before.mid, 'the middle job starts parked').toBe('waiting-children')

      const q = new Queue(QUEUE, { connection: connection() })
      try {
        const leaf = (await census(HAZARD)).find(j => j.name === 'leaf')
        expect(leaf, 'the leaf is there').toBeDefined()
        const job = await q.getJob((leaf as { id: string }).id)
        await job?.remove()
      } finally {
        await q.close()
      }

      const after = await stateOf(HAZARD)
      expect(after.mid, 'the parent became runnable — the defect').toBe('wait')
      expect(after.leaf, 'and the leaf is gone').toBeUndefined()

      // Clean up what is left of the hazard flow.
      const q2 = new Queue(QUEUE, { connection: connection() })
      try { await removeFlow(q2, HAZARD, { dryRun: false }) } finally { await q2.close() }
    } finally {
      await flows.close()
    }
  }, 60_000)
})
