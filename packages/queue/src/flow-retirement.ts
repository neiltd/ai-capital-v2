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
// ancestors-first ordering exists for exactly that reason, and adds the things a
// one-off production mutation needs and a library does not: a measurement of the
// whole world it is about to change, a confirmation token bound to that
// measurement, and a refusal on any drift between deciding and acting.
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
import { statSync } from 'node:fs'

import { canonicalJson } from '@common/db/pg-copy'

import { planFlowRemoval, type FlowRemovalPlan, type JobRef } from './flow-cleanup.js'

/** Moves when anything about the bound shape changes. */
export const RETIREMENT_BINDING_VERSION = 1

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

/** `device:inode` for the evidence root, so a relocated root invalidates. */
export function deviceInode(path: string): string {
  const st = statSync(path, { bigint: true }) as unknown as { dev: bigint; ino: bigint }
  return `${String(st.dev)}:${String(st.ino)}`
}

/** The commit the removal logic comes from. Measured, never supplied. */
export function measureImplementationHead(checkout: string): string {
  const head = execFileSync('/usr/bin/git', ['-C', checkout, 'rev-parse', 'HEAD'],
    { encoding: 'utf-8' }).trim()
  if (!/^[0-9a-f]{40}$/.test(head)) {
    throw new RetirementRefused('the checkout did not yield a commit identifier', checkout)
  }
  return head
}

/** A stable digest of the ordered removal plan. A reordering moves it. */
export function planDigest(plan: FlowRemovalPlan): string {
  return createHash('sha256').update(canonicalJson({
    parent_run_id: plan.parentRunId,
    ancestors_first: plan.ancestorsFirst,
    order: plan.order.map(s => ({ id: s.id, name: s.name, state: s.state })),
  } as never)).digest('hex')
}

export interface RetirementBinding {
  readonly bindingVersion: number
  readonly implementationHead: string
  readonly parentRunId: string
  readonly queue: string
  readonly row: ScheduledRow
  readonly census: readonly JobRef[]
  readonly planDigest: string
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
    implementation_head: b.implementationHead,
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
      .map(j => ({ id: j.id, name: j.name, state: j.state, has_parent: j.hasParent })),
    removal_plan_digest: b.planDigest,
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
  row: ScheduledRow
  census: readonly JobRef[]
  expectedFailedIds: readonly string[]
}): void {
  const { parentRunId, logicalDate, row, census, expectedFailedIds } = input

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
