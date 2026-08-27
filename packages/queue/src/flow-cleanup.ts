import type { Job, Queue } from 'bullmq'

/**
 * ── Whole-flow cleanup ─────────────────────────────────────────────────────
 *
 * THE INVARIANT:
 *
 *   Removing retention data from a terminal flow must NEVER make one of its
 *   ancestors or descendants executable again.
 *
 * WHY ORDER IS THE WHOLE DESIGN. BullMQ's `removeJob` calls
 * `removeParentDependencyKey`, which SREMs the removed job from its parent's
 * dependency set. When that set empties, the parent is ZREM'd out of
 * `waiting-children` and moved to `wait` — where a live worker executes it.
 *
 * That is not theoretical: it was reproduced on an isolated Redis on
 * 2026-08-27. A parked parent carrying a two-month-old `parentRunId` was
 * executed by the live worker purely because a capped `failed` set trimmed the
 * one leaf pinning it.
 *
 * So cleanup NEVER removes leaves independently. It removes ANCESTORS FIRST:
 * once a parent is gone, removing its children cannot release anything, because
 * there is nothing left to release. Leaf-first cleanup of these 22 parked flows
 * would trigger the exact resurrection the cleanup exists to prevent.
 *
 * INTERRUPTION SAFETY follows from the same ordering. If cleanup dies midway,
 * what remains is a suffix of the removal order — ancestors already gone,
 * some descendants still present. Orphaned descendants are inert: nothing waits
 * on them, so nothing can be released by removing them later. The reverse order
 * has no such property; interrupting it can leave a parent released and
 * runnable.
 */

export interface FlowRemovalPlan {
  parentRunId: string
  /** Removal order: ancestors before descendants. */
  order: Array<{ id: string; name: string; state: string }>
  ancestorsFirst: boolean
}

export interface JobRef { id: string; name: string; state: string; hasParent: boolean }

/**
 * Build the removal order for one flow.
 *
 * `waiting-children` members are, by definition, jobs still waiting on
 * descendants — i.e. ancestors. They go first. Everything else follows.
 */
export function planFlowRemoval(parentRunId: string, jobs: JobRef[]): FlowRemovalPlan {
  const ancestors = jobs.filter(j => j.state === 'waiting-children')
  const rest      = jobs.filter(j => j.state !== 'waiting-children')

  // Among ancestors, those WITHOUT a parent of their own are the roots and must
  // precede the ancestors nested beneath them.
  const roots  = ancestors.filter(j => !j.hasParent)
  const nested = ancestors.filter(j => j.hasParent)

  return {
    parentRunId,
    order: [...roots, ...nested, ...rest].map(({ id, name, state }) => ({ id, name, state })),
    ancestorsFirst: true,
  }
}

/** Collect every job belonging to one flow, across all states. */
export async function collectFlowJobs(queue: Queue, parentRunId: string): Promise<JobRef[]> {
  const states = ['active', 'wait', 'delayed', 'prioritized', 'waiting-children', 'failed', 'completed']
  const out: JobRef[] = []
  for (const state of states) {
    const jobs = (await queue.getJobs([state as never], 0, 5000, true)) as Job[]
    for (const j of jobs) {
      if (!j || (j.data as { parentRunId?: string })?.parentRunId !== parentRunId) continue
      out.push({
        id: String(j.id), name: j.name, state,
        hasParent: Boolean((j as unknown as { parentKey?: string }).parentKey),
      })
    }
  }
  return out
}

/**
 * Remove a whole flow, ancestors first.
 *
 * `dryRun` returns the plan without touching anything — the default, because
 * this operation is irreversible and the flows it targets are incident evidence.
 */
export async function removeFlow(
  queue: Queue,
  parentRunId: string,
  opts: { dryRun?: boolean } = {},
): Promise<{ plan: FlowRemovalPlan; removed: number }> {
  const jobs = await collectFlowJobs(queue, parentRunId)
  const plan = planFlowRemoval(parentRunId, jobs)
  if (opts.dryRun !== false) return { plan, removed: 0 }

  let removed = 0
  for (const step of plan.order) {
    const job = await queue.getJob(step.id)
    if (!job) continue
    await job.remove()
    removed++
  }
  return { plan, removed }
}
