#!/usr/bin/env tsx
/**
 * Reconcile persisted parent runs against authoritative queue state.
 *
 * DEFAULTS TO DRY RUN. `--apply` is required to write, and even then it only
 * transitions rows whose assessment is unambiguous — `unknown` never mutates.
 */
import { ensurePipelineEnv } from '../src/env.js'
import { getQueue, getStructuredQueue, closeAll } from '../src/queue.js'
import { snapshotQueue, assessFlow, openParents, applyTransitions, routeParentAssessment,
  DAILY_PARENT_STAGE, STRUCTURED_PARENT_STAGE, DAILY_FLOW_POLICY, STRUCTURED_FLOW_POLICY,
  type FlowAssessment, type ParentRow, type ParentRowWithStage } from '../src/reconcile.js'
import { openDb, openDbReadOnly, resolveDbPath } from '@common/pipeline-runs'

const APPLY = process.argv.includes('--apply')
const JSON_OUT = process.argv.includes('--json')

ensurePipelineEnv()

async function main() {
  // Both lanes are snapshotted up front so an explicitly selected parent can be
  // assessed against the queue that actually owns it.
  const snap           = await snapshotQueue(getQueue())
  const structuredSnap = await snapshotQueue(getStructuredQueue())
  const lanes = { main: snap, structured: structuredSnap }

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

    const routed = routeParentAssessment(row, lanes)
    if (!routed.ok) { console.error(`reconcile: ${routed.error}`); process.exit(2) }

    if (routed.stage === STRUCTURED_PARENT_STAGE) {
      structuredParents = [row]; structuredResults = [routed.assessment]
    } else {
      parents = [row]; results = [routed.assessment]
    }
  } else {
    parents = openParents()
    results = parents.map(p => assessFlow(p.id, p.status, p.started_at, snap, DAILY_FLOW_POLICY))

    // Independently scheduled structured runs open their own parent rows on
    // their own queue, and are assessed only against the structured snapshot.
    // STRUCTURED_FLOW_POLICY: a single-root flow submitted with
    // removeOnFail:false, so a retained failed root is terminal rather than an
    // unrecognised shape.
    structuredParents = openParents(undefined, STRUCTURED_PARENT_STAGE)
    structuredResults = structuredParents.map(p =>
      assessFlow(p.id, p.status, p.started_at, structuredSnap, STRUCTURED_FLOW_POLICY))
  }

  if (JSON_OUT) {
    console.log(JSON.stringify({ [DAILY_PARENT_STAGE]: results, [STRUCTURED_PARENT_STAGE]: structuredResults }, null, 2))
  } else {
    console.log(`mode: ${APPLY ? 'APPLY' : 'DRY RUN (no writes)'}`)
    console.log(`queue: active=${snap.active.length} wait=${snap.wait.length} delayed=${snap.delayed.length} ` +
                `prioritized=${snap.prioritized.length} waiting-children=${snap.waitingChildren.length} ` +
                `failed=${snap.failed.length} completed=${snap.completed.length}`)
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
