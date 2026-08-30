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
import { ensurePipelineEnv } from '../src/env.js'
import { getQueue, getStructuredQueue, closeAll } from '../src/queue.js'
import { snapshotQueue, openParents, classifyQueueHealth } from '../src/reconcile.js'
import { STRUCTURED_PARENT_STAGE } from '../src/structured-scheduling.js'

ensurePipelineEnv()

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
  // Structured parents are surfaced too, so an orphaned structured run is
  // visible rather than silently `running` forever. Counted separately — it is
  // not part of daily-flow health.
  const structuredParents = openParents(undefined, STRUCTURED_PARENT_STAGE)
  // Each lane assessed against its OWN snapshot. Counting structured parents
  // without assessing them let a terminally stuck structured run sit behind a
  // HEALTHY verdict.
  const structuredSnap = await snapshotQueue(getStructuredQueue())
  const health = classifyQueueHealth({
    main:       { snap, parents },
    structured: { snap: structuredSnap, parents: structuredParents },
  })
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
  console.log(`  parents 'running' with no progress  ${health.dailyStuck.length}`)
  console.log(`  oldest unresolved parent           ${oldestUnresolved ?? '(none)'}${oldestUnresolved ? `  (${ageHours}h)` : ''}`)
  // Separate lane, separate line: structured runs are not daily-flow health, but
  // an orphaned one must not be invisible either.
  console.log(`  structured parents still 'running'  ${structuredParents.length}`)
  console.log(`  structured runs terminally stuck    ${health.structuredStuck.length}`)

  // Queue-depth observations stay here; per-lane parent assessment comes from
  // classifyQueueHealth so structured state cannot contaminate daily health.
  const problems: string[] = [...health.problems]
  if (deadFlows.length > 0) problems.push(`${deadFlows.length} dead flow(s) holding ${deadFlows.reduce((n, [, c]) => n + c, 0)} parked jobs`)
  if (ageHours > 24)        problems.push(`oldest unresolved parent is ${ageHours}h old`)

  console.log(problems.length ? `\nUNHEALTHY: ${problems.join('; ')}` : '\nHEALTHY')
  await closeAll()
  process.exit(problems.length ? 1 : 0)
}
main().catch(e => { console.error('queue-health failed:', e.message); process.exit(2) })
