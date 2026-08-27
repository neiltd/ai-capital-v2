#!/usr/bin/env tsx
/**
 * Reconcile persisted parent runs against authoritative queue state.
 *
 * DEFAULTS TO DRY RUN. `--apply` is required to write, and even then it only
 * transitions rows whose assessment is unambiguous — `unknown` never mutates.
 */
import { ensurePipelineEnv } from '../src/env.js'
import { getQueue, closeAll } from '../src/queue.js'
import { snapshotQueue, assessFlow, openParents } from '../src/reconcile.js'
import { openDbReadOnly, resolveDbPath } from '@common/pipeline-runs'

const APPLY = process.argv.includes('--apply')
const JSON_OUT = process.argv.includes('--json')

ensurePipelineEnv()

async function main() {
  const queue = getQueue()
  const snap = await snapshotQueue(queue)
  // --parent lets a SPECIFIC parentRunId be assessed regardless of its DB
  // status, so an already-closed run still works as an acceptance fixture. The
  // 2026-08-26 parent was closed by daily-queue.sh's >12h zombie sweep during
  // the 08-27 autonomous run, which is precisely the accidental-reconciler
  // behaviour this module replaces.
  const explicit = process.argv.indexOf('--parent')
  let parents = openParents()
  if (explicit !== -1 && process.argv[explicit + 1]) {
    const id = process.argv[explicit + 1]
    const db = openDbReadOnly(resolveDbPath())
    const row = db.prepare('SELECT id, started_at, status FROM pipeline_runs WHERE id = ?').get(id) as
      { id: string; started_at: string; status: string } | undefined
    if (!row) { console.error(`no pipeline_runs row with id ${id}`); process.exit(1) }
    parents = [row]
  }

  const results = parents.map(p => assessFlow(p.id, p.status, p.started_at, snap))

  if (JSON_OUT) {
    console.log(JSON.stringify(results, null, 2))
  } else {
    console.log(`mode: ${APPLY ? 'APPLY' : 'DRY RUN (no writes)'}`)
    console.log(`queue: active=${snap.active.length} wait=${snap.wait.length} delayed=${snap.delayed.length} ` +
                `prioritized=${snap.prioritized.length} waiting-children=${snap.waitingChildren.length} ` +
                `failed=${snap.failed.length} completed=${snap.completed.length}`)
    console.log(`open parent rows: ${parents.length}\n`)
    for (const r of results) {
      console.log(`parentRunId        : ${r.parentRunId}`)
      console.log(`  DB state         : ${r.dbStatus}  (started ${r.dbStartedAt})`)
      console.log(`  BullMQ state     : runnable=${r.runnable} blocked=${r.blocked} failed=${r.failed} completed=${r.completed} rootCompleted=${r.rootCompleted}`)
      console.log(`  assessment       : ${r.assessment.toUpperCase()}`)
      console.log(`  proposed         : ${r.proposedTransition ?? '(none — leave as is)'}`)
      console.log(`  reason           : ${r.reason}\n`)
    }
  }

  if (APPLY) {
    const db = openDbReadOnly(resolveDbPath())
    let changed = 0
    for (const r of results) {
      if (r.assessment === 'terminal_success' || r.assessment === 'terminal_failed' || r.assessment === 'terminal_removed') {
        const status = r.assessment === 'terminal_success' ? 'success' : 'failed'
        db.prepare(
          `UPDATE pipeline_runs
              SET status = ?, ended_at = ?,
                  error_message = COALESCE(error_message, ?)
            WHERE id = ? AND status = 'running'`,
        ).run(status, new Date().toISOString(), `reconciled: ${r.reason}`, r.parentRunId)
        changed++
      }
    }
    console.log(`applied ${changed} transition(s); ${results.length - changed} left untouched`)
  }

  await closeAll()
  process.exit(0)
}
main().catch(e => { console.error('reconcile failed:', e.message); process.exit(1) })
