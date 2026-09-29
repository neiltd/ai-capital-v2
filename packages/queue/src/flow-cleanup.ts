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
  /** Removal order: every parent strictly before its own children. */
  order: Array<{ id: string; name: string; state: string; parentId: string | null }>
  ancestorsFirst: boolean
}

/**
 * One job's identity, state and EXACT place in the tree.
 *
 * `hasParent: boolean` USED TO STAND HERE, and it was not enough. A boolean says
 * that a job is somebody's child; it does not say WHOSE. Two censuses in which a
 * job has been rewired from one parent to another are indistinguishable under a
 * boolean — the removal order derived from them differs, and a confirmation token
 * computed over them is identical. The parent's id and queue are recorded instead,
 * so a rewiring moves the token and is refused.
 */
export interface JobRef {
  id: string
  name: string
  state: string
  /** The parent's job id, or null for the flow's root. */
  parentId: string | null
  /** The queue the parent lives on, parsed from BullMQ's parent key. */
  parentQueue: string | null
}

export class FlowTopologyRefused extends Error {
  constructor(readonly reason: string, readonly at: string | null = null) {
    super(`${reason}${at === null ? '' : ` (at ${at})`}`)
    this.name = 'FlowTopologyRefused'
  }
}

/**
 * Build a TRUE parent-before-child removal order, or refuse.
 *
 * WHY THE BUCKETS WERE WRONG. The previous version sorted the census into three
 * buckets — parentless `waiting-children`, nested `waiting-children`, then
 * everything else — and concatenated them. Within the nested bucket the order was
 * whatever Redis happened to answer, so a grandchild could precede its own parent
 * while the plan still claimed `ancestorsFirst`. The ordering is the safety
 * property, and a bucket is not an ordering.
 *
 * This walks the tree from its single root, emitting each job only after its
 * parent. Every structural precondition is checked first, because a plan over a
 * malformed graph is not a plan: a missing parent, a cycle, a self-parent, a
 * duplicate id, a second root or a disconnected fragment each refuse here rather
 * than producing an order that happens to look plausible.
 */
export function planFlowRemoval(parentRunId: string, jobs: JobRef[]): FlowRemovalPlan {
  const byId = new Map<string, JobRef>()
  for (const j of jobs) {
    if (byId.has(j.id)) throw new FlowTopologyRefused('a job id appears twice', j.id)
    byId.set(j.id, j)
  }

  const roots = jobs.filter(j => j.parentId === null)
  if (roots.length === 0) throw new FlowTopologyRefused('the flow has no root — a cycle')
  if (roots.length > 1) {
    throw new FlowTopologyRefused('the flow has more than one root',
                                  roots.map(r => r.id).join(','))
  }

  const children = new Map<string, JobRef[]>()
  for (const j of jobs) {
    if (j.parentId === null) continue
    if (j.parentId === j.id) throw new FlowTopologyRefused('a job is its own parent', j.id)
    if (!byId.has(j.parentId)) {
      throw new FlowTopologyRefused('a job\'s parent is outside the measured census', j.id)
    }
    const list = children.get(j.parentId) ?? []
    list.push(j)
    children.set(j.parentId, list)
  }

  // BREADTH-FIRST FROM THE ROOT. A job is emitted only once its parent has been,
  // and the visited set makes a cycle a refusal rather than a loop.
  const order: FlowRemovalPlan['order'] = []
  const seen = new Set<string>()
  const queue: JobRef[] = [roots[0] as JobRef]
  while (queue.length > 0) {
    const j = queue.shift() as JobRef
    if (seen.has(j.id)) throw new FlowTopologyRefused('the flow contains a cycle', j.id)
    seen.add(j.id)
    order.push({ id: j.id, name: j.name, state: j.state, parentId: j.parentId })
    // Children in a stable order, so the plan digest does not move with Redis's
    // answer order.
    for (const c of [...(children.get(j.id) ?? [])].sort((a, b) => a.id.localeCompare(b.id))) {
      queue.push(c)
    }
  }

  // CONNECTED: every measured job was reached from the root.
  if (seen.size !== jobs.length) {
    const orphans = jobs.filter(j => !seen.has(j.id)).map(j => j.id)
    throw new FlowTopologyRefused('the flow is disconnected', orphans.join(','))
  }

  return { parentRunId, order, ancestorsFirst: true }
}

/** Collect every job belonging to one flow, across all states. */
export async function collectFlowJobs(queue: Queue, parentRunId: string): Promise<JobRef[]> {
  const states = ['active', 'wait', 'delayed', 'prioritized', 'waiting-children', 'failed', 'completed']
  const out: JobRef[] = []
  for (const state of states) {
    const jobs = (await queue.getJobs([state as never], 0, 5000, true)) as Job[]
    for (const j of jobs) {
      if (!j || (j.data as { parentRunId?: string })?.parentRunId !== parentRunId) continue
      // BullMQ's parent key is `bull:<queue>:<id>`. Both halves are recorded: the
      // id so the tree can be walked and compared, the queue so a parent on
      // ANOTHER queue is visible rather than silently accepted.
      const parentKey = (j as unknown as { parentKey?: string }).parentKey
      let parentId: string | null = null
      let parentQueue: string | null = null
      if (typeof parentKey === 'string' && parentKey.length > 0) {
        const parts = parentKey.split(':')
        parentId = parts.length > 0 ? (parts[parts.length - 1] as string) : null
        parentQueue = parts.length >= 3 ? parts.slice(1, -1).join(':') : null
      }
      out.push({ id: String(j.id), name: j.name, state, parentId, parentQueue })
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
  return { plan, removed: await removePlannedFlow(queue, plan) }
}

/**
 * Remove EXACTLY the jobs in an already-measured plan, in its order.
 *
 * WHY THIS EXISTS SEPARATELY. `removeFlow` measures its own census and then
 * deletes it. For a reviewed, confirmed, evidence-bearing retirement that is the
 * wrong shape: the census that was validated and bound into the confirmation must
 * be the census that is deleted, or the validation describes one world and the
 * deletion happens in another. This function takes the plan and never looks again.
 *
 * A step whose job is already gone is skipped rather than failed: a retry after a
 * partial removal must be able to finish, and an absent job is the desired state.
 */
export async function removePlannedFlow(
  queue: Queue, plan: FlowRemovalPlan,
): Promise<number> {
  let removed = 0
  for (const step of plan.order) {
    const job = await queue.getJob(step.id)
    if (!job) continue
    await job.remove()
    removed++
  }
  return removed
}
