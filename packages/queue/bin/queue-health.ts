#!/usr/bin/env tsx
/**
 * Queue health invariants.
 *
 * WHY NOT `waiting-children > 0`. A legitimate in-flight DAG has waiting
 * children by design — that is what a dependency graph looks like while it
 * runs. Treating the raw count as failure would alarm on every healthy pipeline
 * and be ignored within a week.
 *
 * The real condition is narrower and is what actually went undetected for two
 * months: waiting children exist AND no runnable dependency can ever release
 * them. That is a dead flow, and it accumulated 228 jobs across 22 days without
 * a single signal.
 */
import { getQueue, closeAll } from '../src/queue.js'
import { snapshotQueue, assessFlow, openParents } from '../src/reconcile.js'

async function main() {
  const queue = getQueue()
  const snap = await snapshotQueue(queue)

  // Group every parked job by the flow it belongs to.
  const byRun = new Map<string, number>()
  for (const j of snap.waitingChildren) {
    const id = j.data?.parentRunId ?? '(no parentRunId)'
    byRun.set(id, (byRun.get(id) ?? 0) + 1)
  }
  const runnableByRun = new Map<string, number>()
  for (const j of [...snap.active, ...snap.wait, ...snap.delayed, ...snap.prioritized]) {
    const id = j.data?.parentRunId ?? '(no parentRunId)'
    runnableByRun.set(id, (runnableByRun.get(id) ?? 0) + 1)
  }

  const deadFlows = [...byRun.entries()].filter(([id]) => (runnableByRun.get(id) ?? 0) === 0)
  const liveFlows = [...byRun.entries()].filter(([id]) => (runnableByRun.get(id) ?? 0) > 0)

  const parents = openParents()
  const stuck = parents
    .map(p => assessFlow(p.id, p.status, p.started_at, snap))
    .filter(a => a.assessment === 'terminal_failed' || a.assessment === 'terminal_removed')

  const oldestUnresolved = parents.length
    ? parents.map(p => p.started_at).sort()[0]
    : null
  const ageHours = oldestUnresolved
    ? Math.floor((Date.now() - new Date(oldestUnresolved).getTime()) / 3_600_000)
    : 0

  console.log('queue depth')
  console.log(`  active            ${snap.active.length}`)
  console.log(`  wait              ${snap.wait.length}`)
  console.log(`  delayed           ${snap.delayed.length}`)
  console.log(`  prioritized       ${snap.prioritized.length}`)
  console.log(`  waiting-children  ${snap.waitingChildren.length}`)
  console.log(`  failed            ${snap.failed.length}`)
  console.log(`  completed         ${snap.completed.length}`)
  console.log('\nflow health')
  console.log(`  live flows with waiting children   ${liveFlows.length}   (healthy — a running DAG has these)`)
  console.log(`  DEAD flows (parked, nothing runnable) ${deadFlows.length}`)
  console.log(`  parked jobs in dead flows          ${deadFlows.reduce((n, [, c]) => n + c, 0)}`)
  console.log(`  parents 'running' with no progress  ${stuck.length}`)
  console.log(`  oldest unresolved parent           ${oldestUnresolved ?? '(none)'}${oldestUnresolved ? `  (${ageHours}h)` : ''}`)

  const problems: string[] = []
  if (deadFlows.length > 0) problems.push(`${deadFlows.length} dead flow(s) holding ${deadFlows.reduce((n, [, c]) => n + c, 0)} parked jobs`)
  if (stuck.length > 0)     problems.push(`${stuck.length} parent row(s) still 'running' with a dead DAG`)
  if (ageHours > 24)        problems.push(`oldest unresolved parent is ${ageHours}h old`)

  console.log(problems.length ? `\nUNHEALTHY: ${problems.join('; ')}` : '\nHEALTHY')
  await closeAll()
  process.exit(problems.length ? 1 : 0)
}
main().catch(e => { console.error('queue-health failed:', e.message); process.exit(2) })
