#!/usr/bin/env tsx
/**
 * Reconcile persisted parent runs against authoritative queue state.
 *
 * DEFAULTS TO DRY RUN. `--apply` is required to write, and even then it only
 * transitions rows whose assessment is unambiguous — `unknown` never mutates.
 */
import { ensurePipelineEnv } from '../src/env.js'
import { getInspectionQueue, getStructuredInspectionQueue, closeAll } from '../src/queue.js'
import { snapshotQueue, assessFlow, openParents, applyTransitions, routeParentAssessment,
  DAILY_PARENT_STAGE, STRUCTURED_PARENT_STAGE, DAILY_FLOW_POLICY, STRUCTURED_FLOW_POLICY,
  type FlowAssessment, type ParentRow, type ParentRowWithStage } from '../src/reconcile.js'
import { openDb, openDbReadOnly, resolveDbPath } from '@common/pipeline-runs'

const APPLY = process.argv.includes('--apply')
const JSON_OUT = process.argv.includes('--json')

ensurePipelineEnv()

/**
 * --lane restricts which queues are CONSTRUCTED.
 *
 * WHY IT EXISTS. BullMQ 5.78.0's `Queue` constructor issues
 * `client.hset(<queue>:meta, …)` unless `skipMetasUpdate` is passed, and
 * `getQueue()` / `getStructuredQueue()` pass no such option. Constructing a lane
 * is therefore a Redis WRITE, and constructing the dormant structured lane
 * CREATES `bull:structured-ingestion:meta` where no key exists at all. An
 * inspection that claims to mutate nothing must be able to avoid that.
 *
 * Default is `both`, so existing callers are unchanged. A lane that was not
 * constructed is never guessed at: an explicit parent routed to an unbuilt lane
 * fails closed.
 */
type Lane = 'daily' | 'structured' | 'both'

function parseLane(argv: string[]): Lane {
  const i = argv.indexOf('--lane')
  if (i === -1) return 'both'
  const v = argv[i + 1]
  if (v === 'daily' || v === 'structured' || v === 'both') return v
  console.error(`--lane must be daily|structured|both, got '${v ?? ''}'`)
  process.exit(2)
}

async function main() {
  // Lanes are constructed ONLY when requested — construction is a Redis write.
  const lane = parseLane(process.argv)
  // Inspection handles only: reconcile READS both lanes and must not write the
  // meta key of either, including the daily lane it is allowed to touch.
  const snap           = lane === 'structured' ? undefined : await snapshotQueue(getInspectionQueue())
  const structuredSnap = lane === 'daily'      ? undefined : await snapshotQueue(getStructuredInspectionQueue())

  // --parent lets a SPECIFIC parentRunId be assessed regardless of its DB
  // status, so an already-closed run still works as an acceptance fixture. The
  // 2026-08-26 parent was closed by daily-queue.sh's >12h zombie sweep during
  // the 08-27 autonomous run, which is precisely the accidental-reconciler
  // behaviour this module replaces.
  //
  // ROUTING IS BY STAGE. The row is selected WITH its stage and dispatched to
  // the matching queue and policy. Previously the stage was not selected at
  // all: an explicit structured parent landed in the daily collection and was
  // assessed against the MAIN snapshot, where it has no jobs, so a live
  // structured run read as `terminal_removed` — and with --apply the CLI would
  // have closed it as failed.
  const explicitIdx = process.argv.indexOf('--parent')
  const explicitId  = explicitIdx !== -1 ? process.argv[explicitIdx + 1] : undefined

  let parents: ParentRow[] = []
  let structuredParents: ParentRow[] = []
  let results: FlowAssessment[] = []
  let structuredResults: FlowAssessment[] = []

  if (explicitIdx !== -1 && !explicitId) {
    console.error('--parent requires a parentRunId')
    process.exit(1)
  }

  if (explicitId) {
    const db = openDbReadOnly(resolveDbPath())
    const row = db.prepare('SELECT id, stage, started_at, status FROM pipeline_runs WHERE id = ?')
      .get(explicitId) as ParentRowWithStage | undefined
    if (!row) { console.error(`no pipeline_runs row with id ${explicitId}`); process.exit(1) }

    if (row.stage === STRUCTURED_PARENT_STAGE && !structuredSnap) {
      console.error(`reconcile: parent ${explicitId} is a structured run but --lane ${lane} did not construct that queue`)
      process.exit(2)
    }
    if (row.stage !== STRUCTURED_PARENT_STAGE && !snap) {
      console.error(`reconcile: parent ${explicitId} is a daily run but --lane ${lane} did not construct that queue`)
      process.exit(2)
    }
    const routed = routeParentAssessment(row, {
      main:       snap           as NonNullable<typeof snap>,
      structured: structuredSnap as NonNullable<typeof structuredSnap>,
    })
    if (!routed.ok) { console.error(`reconcile: ${routed.error}`); process.exit(2) }

    if (routed.stage === STRUCTURED_PARENT_STAGE) {
      structuredParents = [row]; structuredResults = [routed.assessment]
    } else {
      parents = [row]; results = [routed.assessment]
    }
  } else {
    if (snap) {
      parents = openParents()
      results = parents.map(p => assessFlow(p.id, p.status, p.started_at, snap, DAILY_FLOW_POLICY))
    }

    // Independently scheduled structured runs open their own parent rows on
    // their own queue, and are assessed only against the structured snapshot.
    // STRUCTURED_FLOW_POLICY: a single-root flow submitted with
    // removeOnFail:false, so a retained failed root is terminal rather than an
    // unrecognised shape.
    if (structuredSnap) {
      structuredParents = openParents(undefined, STRUCTURED_PARENT_STAGE)
      structuredResults = structuredParents.map(p =>
        assessFlow(p.id, p.status, p.started_at, structuredSnap, STRUCTURED_FLOW_POLICY))
    }
  }

  if (JSON_OUT) {
    console.log(JSON.stringify({ [DAILY_PARENT_STAGE]: results, [STRUCTURED_PARENT_STAGE]: structuredResults }, null, 2))
  } else {
    console.log(`mode: ${APPLY ? 'APPLY' : 'DRY RUN (no writes)'}`)
    if (snap) {
      console.log(`queue: active=${snap.active.length} wait=${snap.wait.length} delayed=${snap.delayed.length} ` +
                  `prioritized=${snap.prioritized.length} waiting-children=${snap.waitingChildren.length} ` +
                  `failed=${snap.failed.length} completed=${snap.completed.length}`)
    } else {
      console.log(`queue: daily lane not constructed (--lane ${lane})`)
    }
    console.log(`open parent rows: ${parents.length} daily, ${structuredParents.length} structured\n`)
    for (const r of [...results, ...structuredResults]) {
      console.log(`parentRunId        : ${r.parentRunId}`)
      console.log(`  DB state         : ${r.dbStatus}  (started ${r.dbStartedAt})`)
      console.log(`  BullMQ state     : runnable=${r.runnable} blocked=${r.blocked} failed=${r.failed} completed=${r.completed} rootCompleted=${r.rootCompleted}`)
      console.log(`  assessment       : ${r.assessment.toUpperCase()}`)
      console.log(`  proposed         : ${r.proposedTransition ?? '(none — leave as is)'}`)
      console.log(`  reason           : ${r.reason}\n`)
    }
  }

  // A writable handle is obtained ONLY here, under an explicit --apply. Dry-run
  // never opens one. The previous version opened the store with
  // openDbReadOnly() and then issued UPDATEs, so the transition it advertised
  // could not actually be written.
  if (APPLY) {
    const all = [...results, ...structuredResults]
    const db = openDb(resolveDbPath())
    const changed = applyTransitions(all, db)
    console.log(`applied ${changed} transition(s); ${all.length - changed} left untouched`)
  }

  await closeAll()
  process.exit(0)
}
main().catch(e => { console.error('reconcile failed:', e.message); process.exit(1) })
