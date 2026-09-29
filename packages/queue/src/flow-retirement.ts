// RETIRING A FAILED PRODUCTION FLOW: what is measured, what is bound, what is done.
//
// WHY THIS EXISTS. On 2026-09-28 a scheduled daily run submitted 23 jobs, ran 100
// of them, and failed terminally in two: `scenario-simulate` (a missing analysis
// artefact) and `world-intel-report` (a missing API key). Eleven parent jobs were
// left in `waiting-children` behind those two failures, permanently. Nothing in
// the system can drain them, and nothing should retry them — the run's business
// day is gone. They have to be removed by hand, and removing BullMQ jobs by hand
// is the single most dangerous operation in this repository:
//
//   `removeJob` SREMs the job from its parent's dependency set, and when that set
//   empties the parent moves from `waiting-children` to `wait`, where a live
//   worker EXECUTES it. Reproduced on an isolated Redis on 2026-08-27: a parked
//   parent carrying a two-month-old parentRunId ran because a capped `failed` set
//   trimmed the one leaf pinning it.
//
// So this module does not invent a removal order. It uses `flow-cleanup.ts`, whose
// parent-before-child ordering exists for exactly that reason, and adds the things a
// one-off production mutation needs and a library does not: a measurement of the
// whole world it is about to change, a confirmation token bound to that
// measurement, and a re-measurement compared against it before acting.
//
// THE RESIDUAL BOUNDARY, STATED RATHER THAN CLAIMED AWAY.
//
// This is NOT store-side atomic, and BullMQ offers no primitive that would make it
// so: there is no compare-and-remove over a whole flow, and `Queue.getWorkers()`
// reports what was attached when it was asked, not what is attached now. What is
// actually enforced is:
//
//   * one census is measured AFTER the intent bundle is published;
//   * it is exact-compared with the authorized census, plan digest and token;
//   * it is structurally revalidated — ids, root, parents, connectivity, cycles,
//     states, the failed set, the queue;
//   * the worker count is rechecked on the write handle immediately before the
//     first removal;
//   * that exact plan is what the remover consumes, with no further collection.
//
// What remains possible, and is not claimed otherwise: a worker attaching, or a job
// changing state, in the interval between the final recheck and each individual
// `remove()`. The window is small and the operator is required to have every
// producer stopped, but it is a window. The mitigation that DOES hold across it is
// the ordering itself — parents are removed before their children, so no removal can
// empty a surviving parent's dependency set and release it.
//
// WHAT THE TOKEN BINDS, AND WHY EACH PART. A token that covered less would let
// something change between inspection and apply without being noticed:
//
//   implementation head   the code doing the removal; a different build is a
//                         different set of safety checks
//   parent run id         which flow, exactly
//   scheduled row         the SQLite row's identity AND state, so a row that has
//                         already been superseded, or whose status changed, or
//                         whose children differ, refuses
//   job census            every job in the flow: id, name, state and whether it
//                         has a parent — a changed state is a changed flow
//   removal plan digest   the exact ordered plan, so a reordered plan refuses
//                         even when the job SET is identical
//   expected failed ids    the operator's own statement of what is terminal
//   redis endpoint        which server; the same key names exist on others
//   evidence root         path AND device:inode, so a relocated root refuses
//   intent                that this specific row is to be superseded
//
// THE SQLITE READ IS WAL-AWARE, AND THAT IS NOT A DETAIL. An earlier verification
// of this very row used `immutable=1`, which by design ignores the -wal sidecar:
// it reported 2232 rows with a latest logical_date of 2026-09-06 and declared the
// target row missing, when the database in fact had 2245 rows, a latest date of
// 2026-09-28, and the row present. The reader here opens the ordinary pathname
// read-only so committed WAL frames are visible, and a regression test pins it.

import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { realpathSync, statSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { canonicalJson } from '@common/db/pg-copy'

import {
  FlowTopologyRefused, planFlowRemoval, type FlowRemovalPlan, type JobRef,
} from './flow-cleanup.js'

/** Moves when anything about the bound shape changes. */
/**
 * 2 BINDS THE EXECUTING IMPLEMENTATION AND EXACT TOPOLOGY.
 *
 * Version 1 bound a commit identifier read from an operator-supplied directory, and
 * recorded each job's parenthood as a boolean. Neither is the same statement as the
 * one version 2 makes: the repository containing the running code, clean in its
 * reviewed source, and each job's exact parent. A token minted under 1 must not
 * verify under 2, because the shapes mean different things.
 */
export const RETIREMENT_BINDING_VERSION = 2

export const INTENT_PREFIX = 'queue-flow-retirement-intent'
export const OUTCOME_PREFIX = 'queue-flow-retirement-outcome'

/** The four answers a retirement may give. `unknown` is not a failure mode. */
export type RetirementOutcome = 'complete' | 'partial' | 'refused' | 'unknown'

export class RetirementRefused extends Error {
  constructor(readonly reason: string, readonly at: string | null = null) {
    super(`${reason}${at === null ? '' : ` (at ${at})`}`)
    this.name = 'RetirementRefused'
  }
}

/** The scheduled-run row, exactly as measured. */
export interface ScheduledRow {
  readonly id: string
  readonly parentRunId: string | null
  readonly stage: string
  readonly source: string
  readonly status: string
  readonly logicalDate: string | null
  readonly supersededAt: string | null
  readonly failedStage: string | null
  /** Each child's identity and state, so a changed child set moves the token. */
  readonly children: readonly { readonly id: string; readonly stage: string; readonly status: string }[]
}

export interface RedisEndpoint {
  readonly host: string
  readonly port: number
  readonly db: number
}

/** Minimal read interface, so the binding can be built without a live database. */
export interface RowReader {
  readRow: (parentRunId: string) => ScheduledRow | null
}

/**
 * The states a targeted flow may NOT be in.
 *
 * A job that is runnable or running is a job something may still do something
 * with, and removing its ancestors underneath it is the resurrection hazard in
 * reverse. Only terminal and parked states may be retired.
 */
export const FORBIDDEN_STATES: readonly string[] = Object.freeze([
  'active', 'wait', 'delayed', 'prioritized',
])

/** The only states a reviewable flow may be in. Anything else is unknown, not safe. */
export const TERMINAL_OR_PARKED: readonly string[] = Object.freeze([
  'failed', 'completed', 'waiting-children',
])

/** `device:inode` for the evidence root, so a relocated root invalidates. */
export function deviceInode(path: string): string {
  const st = statSync(path, { bigint: true }) as unknown as { dev: bigint; ino: bigint }
  return `${String(st.dev)}:${String(st.ino)}`
}

/**
 * THE DIRECTORIES WHOSE CONTENTS ARE THE IMPLEMENTATION.
 *
 * Cleanliness is required HERE and not repository-wide. A run store, a log, or an
 * approved unrelated data artefact sitting untracked elsewhere says nothing about
 * whether the code performing the removal is the code that was reviewed; refusing
 * on those would make the check about tidiness instead of about authority.
 */
export const REVIEWED_IMPLEMENTATION_PATHS: readonly string[] = Object.freeze([
  'packages/queue/src',
  'packages/queue/bin',
  'packages/db/src/pg-copy',
  'packages/pipeline-runs/src',
])

export interface ImplementationAuthority {
  /** The real path of the repository that contains the RUNNING CLI. */
  readonly root: string
  readonly head: string
  /** The reviewed source paths whose cleanliness was required. */
  readonly reviewedPaths: readonly string[]
}

const git = (root: string, args: readonly string[]): string =>
  execFileSync('/usr/bin/git', ['-C', root, ...args], { encoding: 'utf-8' })

/**
 * MEASURE THE IMPLEMENTATION THAT IS ACTUALLY EXECUTING.
 *
 * WHAT THE PREVIOUS VERSION PROVED, AND WHAT IT DID NOT. It ran
 * `git -C <--checkout> rev-parse HEAD` and bound the answer. That establishes only
 * that SOME repository somewhere reports that commit. It did not establish that the
 * repository was the one containing the running CLI, that the worktree matched the
 * commit, or that the files being executed were the files the commit records. A
 * token could therefore certify a clean reviewed commit while the code performing
 * an irreversible production removal was locally modified, or came from an entirely
 * different checkout.
 *
 * SO THE ROOT IS DERIVED, NOT ACCEPTED. It comes from the executing module's own
 * URL, through git's own `--show-toplevel`, and is realpath-resolved. The supplied
 * `--checkout` is then compared against it and refused if it names anywhere else:
 * the option survives as a statement the operator must get right, not as the source
 * of truth.
 *
 * AND CLEANLINESS IS PART OF IDENTITY. A commit identifier describes a tree; a
 * dirty worktree means the executing files are not that tree. Staged and unstaged
 * tracked changes are refused repository-wide, and untracked files are refused
 * within the reviewed implementation directories — where an untracked module could
 * be imported and executed while the commit knows nothing about it.
 */
export function measureImplementationAuthority(
  suppliedCheckout: string, moduleUrl: string,
): ImplementationAuthority {
  const here = dirname(fileURLToPath(moduleUrl))

  let root: string
  try {
    root = realpathSync(git(here, ['rev-parse', '--show-toplevel']).trim())
  } catch {
    throw new RetirementRefused(
      'the executing implementation is not inside a git repository', here)
  }

  let supplied: string
  try { supplied = realpathSync(suppliedCheckout) } catch {
    throw new RetirementRefused('the supplied checkout cannot be resolved', suppliedCheckout)
  }
  if (supplied !== root) {
    throw new RetirementRefused(
      'the supplied checkout is not the repository containing the running code',
      `${supplied} != ${root}`)
  }

  const head = git(root, ['rev-parse', 'HEAD']).trim()
  if (!/^[0-9a-f]{40}$/.test(head)) {
    throw new RetirementRefused('the checkout did not yield a commit identifier', root)
  }

  // TRACKED CHANGES, ANYWHERE: staged or unstaged, both refused.
  const trackedDirty = git(root, ['status', '--porcelain', '--untracked-files=no'])
    .split('\n').filter(l => l.trim().length > 0)
  if (trackedDirty.length > 0) {
    throw new RetirementRefused(
      'the worktree has tracked modifications, so the executing files are not the recorded commit',
      trackedDirty.slice(0, 5).map(l => l.trim()).join('; '))
  }

  // UNTRACKED FILES, ONLY INSIDE THE REVIEWED IMPLEMENTATION.
  const untracked = git(root, [
    'status', '--porcelain', '--untracked-files=all', '--', ...REVIEWED_IMPLEMENTATION_PATHS,
  ]).split('\n').filter(l => l.startsWith('??')).map(l => l.slice(3).trim())
  if (untracked.length > 0) {
    throw new RetirementRefused(
      'an untracked file sits inside the reviewed implementation source',
      untracked.slice(0, 5).join('; '))
  }

  return Object.freeze({ root, head, reviewedPaths: REVIEWED_IMPLEMENTATION_PATHS })
}

/** A stable digest of the ordered removal plan. A reordering moves it. */
export function planDigest(plan: FlowRemovalPlan): string {
  return createHash('sha256').update(canonicalJson({
    parent_run_id: plan.parentRunId,
    ancestors_first: plan.ancestorsFirst,
    order: plan.order.map(s => ({
      id: s.id, name: s.name, state: s.state, parent_id: s.parentId,
    })),
  } as never)).digest('hex')
}

export interface RetirementBinding {
  readonly bindingVersion: number
  readonly implementation: ImplementationAuthority
  readonly parentRunId: string
  readonly queue: string
  readonly row: ScheduledRow
  readonly census: readonly JobRef[]
  readonly planDigest: string
  /** Workers that could advance this queue while it is being retired. Must be 0. */
  readonly workersPresent: number
  readonly expectedFailedIds: readonly string[]
  readonly redis: RedisEndpoint
  readonly evidenceRoot: string
  readonly evidenceRootDeviceInode: string
  readonly intent: string
}

/**
 * The document the token is computed over.
 *
 * The census is SORTED so that the order Redis happened to answer in cannot move
 * the token; the PLAN's order is bound separately and deliberately, because there
 * the order is the safety property.
 */
export function retirementBindingDocument(b: RetirementBinding): Record<string, unknown> {
  return {
    binding_version: b.bindingVersion,
    implementation: {
      root: b.implementation.root,
      head: b.implementation.head,
      reviewed_paths: [...b.implementation.reviewedPaths],
      tracked_worktree_clean: true,
      reviewed_source_untracked: 0,
    },
    parent_run_id: b.parentRunId,
    queue: b.queue,
    scheduled_row: {
      id: b.row.id,
      parent_run_id: b.row.parentRunId,
      stage: b.row.stage,
      source: b.row.source,
      status: b.row.status,
      logical_date: b.row.logicalDate,
      superseded_at: b.row.supersededAt,
      failed_stage: b.row.failedStage,
      children: [...b.row.children]
        .sort((x, y) => x.id.localeCompare(y.id))
        .map(c => ({ id: c.id, stage: c.stage, status: c.status })),
    },
    census: [...b.census]
      .sort((x, y) => x.id.localeCompare(y.id))
      .map(j => ({
        id: j.id, name: j.name, state: j.state,
        parent_id: j.parentId, parent_queue: j.parentQueue,
      })),
    removal_plan_digest: b.planDigest,
    workers_able_to_advance_the_queue: b.workersPresent,
    expected_failed_ids: [...b.expectedFailedIds].sort(),
    redis: { host: b.redis.host, port: b.redis.port, db: b.redis.db },
    evidence_root: b.evidenceRoot,
    evidence_root_device_inode: b.evidenceRootDeviceInode,
    intent: b.intent,
  }
}

export const RETIREMENT_TOKEN_PREFIX = 'QUEUE-RETIRE-'

export function retirementToken(b: RetirementBinding): string {
  const digest = createHash('sha256')
    .update(canonicalJson(retirementBindingDocument(b) as never)).digest('hex')
  return `${RETIREMENT_TOKEN_PREFIX}${digest}`
}

/**
 * Every safety rule that does not need a live connection, in one place.
 *
 * Called by BOTH modes against freshly measured inputs, so an inspection cannot
 * pass a check that an apply would skip, and an apply cannot rely on a check the
 * inspection performed minutes earlier.
 */
export function assertRetirable(input: {
  parentRunId: string
  logicalDate: string
  queue: string
  row: ScheduledRow
  census: readonly JobRef[]
  expectedFailedIds: readonly string[]
  /** Workers able to advance this queue. Anything but zero is a refusal. */
  workersPresent?: number
}): void {
  const { parentRunId, logicalDate, queue, row, census, expectedFailedIds } = input

  // NO WORKER MAY BE ABLE TO ADVANCE THIS QUEUE.
  //
  // Removing a job can move its parent into `wait`. If a worker is attached, that
  // parent is executed — months late, against a business day that is gone. The
  // count is measured, bound into the confirmation, and rechecked immediately
  // before the first removal.
  if (input.workersPresent !== undefined && input.workersPresent !== 0) {
    throw new RetirementRefused(
      'a worker is able to advance this queue', String(input.workersPresent))
  }

  if (row.id !== parentRunId) {
    throw new RetirementRefused('the scheduled row is not the one named', row.id)
  }
  if (row.logicalDate !== logicalDate) {
    throw new RetirementRefused('the scheduled row is for another logical date',
                                String(row.logicalDate))
  }
  if (row.status !== 'failed') {
    throw new RetirementRefused('only a failed scheduled run may be retired', row.status)
  }
  if (row.supersededAt !== null) {
    throw new RetirementRefused('the scheduled row is already superseded', row.supersededAt)
  }
  if (census.length === 0) {
    throw new RetirementRefused('no job in this queue belongs to that parent run', parentRunId)
  }

  // NOTHING RUNNABLE OR RUNNING.
  for (const j of census) {
    if (FORBIDDEN_STATES.includes(j.state)) {
      throw new RetirementRefused(`a job in the flow is ${j.state}`, j.id)
    }
    if (!TERMINAL_OR_PARKED.includes(j.state)) {
      throw new RetirementRefused('a job is in a state this tool does not review', `${j.id}:${j.state}`)
    }
    // A PARENT ON ANOTHER QUEUE IS NOT THIS FLOW. The removal only reaches one
    // queue, so a cross-queue edge would leave a parent nobody retires.
    if (j.parentQueue !== null && j.parentQueue !== queue) {
      throw new RetirementRefused('a job\'s parent is on another queue',
                                  `${j.id} -> ${j.parentQueue}`)
    }
  }

  // THE TREE ITSELF. Unique ids, one root, every parent present, connected, no
  // cycle, no self-parent — all of it, before a plan is built, because a plan over
  // a malformed graph is not a plan. `planFlowRemoval` raises each of these.
  try {
    planFlowRemoval(parentRunId, [...census])
  } catch (e) {
    if (e instanceof FlowTopologyRefused) {
      throw new RetirementRefused(`the flow topology is not reviewable: ${e.reason}`, e.at)
    }
    throw e
  }

  // THE FAILED SET IS EXACTLY WHAT THE OPERATOR STATED. An unexpected failed leaf
  // means the flow is not the one that was reviewed, and an expected id that is
  // not there means the census is not the one the operator was looking at.
  const failed = census.filter(j => j.state === 'failed').map(j => j.id).sort()
  const expected = [...expectedFailedIds].sort()
  if (failed.length !== expected.length || failed.some((id, i) => id !== expected[i])) {
    throw new RetirementRefused(
      'the failed jobs in the flow are not the ones named',
      `measured ${failed.join(',') || '<none>'}`)
  }
}

/** Build the plan the way `flow-cleanup` builds it. Never a local reordering. */
export function retirementPlan(parentRunId: string, census: readonly JobRef[]): FlowRemovalPlan {
  return planFlowRemoval(parentRunId, [...census])
}
