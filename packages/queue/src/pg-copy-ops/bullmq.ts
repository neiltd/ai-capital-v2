// READ-ONLY QUEUE INSPECTION THAT OWNS EVERY HANDLE IT USES.
//
// TWO THINGS THIS MODULE MUST NOT DO, and both are about handles it did not
// create.
//
//   IT NEVER USES THE META-WRITING CONSTRUCTORS. BullMQ 5's `Queue` issues
//   `hset(<queue>:meta, …)` from `waitUntilReady()` unless `skipMetasUpdate` is
//   set, so plain construction is a Redis WRITE - and for the dormant
//   structured lane it CREATES a key that did not exist. A pre-activation
//   inspection that changed Redis would be exactly the thing it promises not to
//   be. `getQueue`/`getStructuredQueue` are therefore never imported here.
//
//   IT NEVER USES THE CACHED INSPECTION HANDLES EITHER. `getInspectionQueue`
//   and `getStructuredInspectionQueue` are module-global singletons shared with
//   other callers; closing one would close a handle this module does not own,
//   and reusing one would inherit somebody else's lifetime. So this creates its
//   own, uses them, and closes them on every path including every refusal.
//
// WHAT COUNTS AS BLOCKING. `active`, `wait`, `delayed`, `prioritized` AND
// `waiting-children`. The last one is stricter than the repository's health
// check, deliberately: health asks "is this normal", and a parked parent is
// normal. The fence asks "can anything run in the next few minutes", and a
// parked parent becomes runnable the instant a child completes - which is
// precisely the window the fence exists to cover. A paused queue is a refusal
// rather than a zero, because pause is resumable by anything and is not
// quiescence.

import { Queue, type JobType } from 'bullmq'

import type { AdapterContext, QueueSample } from '@common/db/pg-copy'

import type { RedisConnection } from './redis-config.js'

/** Every state that contributes to blocking depth, in the reviewed order. */
export const BLOCKING_STATES: readonly JobType[] = Object.freeze([
  'active', 'wait', 'delayed', 'prioritized', 'waiting-children',
])

/** A paused queue is refused outright; it is not a depth of zero. */
export const PAUSED_IS_BLOCKING = true

export class QueueInspectionRefused extends Error {
  constructor(readonly reason: string, readonly at: string | null = null) {
    super(`${reason}${at === null ? '' : ` (at ${at})`}`)
    this.name = 'QueueInspectionRefused'
  }
}

/** The ONE place this module constructs a queue handle. */
export function createInspectionQueue(name: string, connection: RedisConnection): Queue {
  return new Queue(name, {
    connection: { ...connection, maxRetriesPerRequest: null },
    // THE FLAG THAT MAKES THIS A READ. Without it, constructing the handle
    // writes the queue's meta key.
    skipMetasUpdate: true,
  })
}

export interface QueueDepth {
  readonly name: string
  readonly depth: number
  readonly paused: boolean
  /** History, reported and never summed into depth. */
  readonly completed: number
  readonly failed: number
}

/**
 * One bounded observation of every reviewed queue.
 *
 * Handles are created here and closed in the `finally`, so an abort, a refusal
 * or a thrown error all leave the same number of Redis connections behind:
 * none.
 */
export type InspectionQueueFactory = (name: string, connection: RedisConnection) => Queue

export async function sampleReviewedQueues(
  names: readonly string[], connection: RedisConnection, ctx: AdapterContext,
  // A SEAM, and the only one. Production always uses the reviewed factory; a
  // test cannot otherwise observe that every handle is closed without standing
  // up a Redis, which is the one thing this module must never require.
  make: InspectionQueueFactory = createInspectionQueue,
): Promise<readonly QueueDepth[]> {
  const handles: Queue[] = []
  try {
    const out: QueueDepth[] = []
    for (const name of names) {
      if (ctx.signal.aborted) throw new QueueInspectionRefused('the inspection was abandoned')
      const q = make(name, connection)
      handles.push(q)
      let counts: Record<string, number>
      let paused: boolean
      try {
        counts = await q.getJobCounts(...BLOCKING_STATES, 'completed', 'failed')
        paused = await q.isPaused()
      } catch {
        throw new QueueInspectionRefused('a reviewed queue could not be inspected', name)
      }
      const depth = BLOCKING_STATES.reduce((n, s) => n + (counts[s] ?? 0), 0)
      out.push({
        name, depth, paused,
        completed: counts.completed ?? 0,
        failed: counts.failed ?? 0,
      })
    }
    return Object.freeze(out)
  } finally {
    // EVERY handle this call created, on every path.
    for (const q of handles) {
      try { await q.close() } catch { /* bounded */ }
    }
  }
}

/**
 * The reviewed queue adapter.
 *
 * Returns the depth map the gate compares against the reviewed set, and refuses
 * a paused queue rather than reporting it as empty - the gate's own sampling
 * then requires two such observations to agree.
 */
export function bullmqQueueAdapter(
  names: readonly string[], connection: RedisConnection,
  make: InspectionQueueFactory = createInspectionQueue,
): { sample(ctx: AdapterContext): Promise<QueueSample> } {
  return {
    sample: async (ctx: AdapterContext) => {
      const depths: Record<string, number> = {}
      for (const d of await sampleReviewedQueues(names, connection, ctx, make)) {
        if (d.paused) {
          throw new QueueInspectionRefused('a reviewed queue is paused', d.name)
        }
        depths[d.name] = d.depth
      }
      return { depths }
    },
  }
}
