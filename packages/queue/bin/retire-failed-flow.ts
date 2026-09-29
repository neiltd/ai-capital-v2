#!/usr/bin/env node
// RETIRE ONE FAILED DAILY FLOW. TWO MODES, ONE TOKEN, TWO BUNDLES.
//
// See src/flow-retirement.ts for what is measured and why. This file is the
// operator surface: it parses reviewed arguments, measures the world, and either
// reports (`--inspect`) or acts (`--apply`) — never both, and never acts without
// the exact token the inspection printed.
//
//   --inspect  strictly read-only. Opens a `skipMetasUpdate` queue handle (a plain
//              BullMQ Queue constructor WRITES `<queue>:meta`), a read-only
//              WAL-aware SQLite handle, and publishes nothing.
//
//   --apply    remeasures everything from scratch, recomputes the token, refuses
//              on any difference, publishes a frozen INTENT bundle, removes the
//              flow ancestors-first, verifies the flow is gone, supersedes exactly
//              one row, verifies that, and publishes a frozen OUTCOME bundle.
//
// THE INTENT BUNDLE IS PUBLISHED BEFORE THE FIRST MUTATION, deliberately. A single
// bundle written at the end cannot distinguish "nothing happened" from "something
// happened and was never recorded". If this process dies between the two bundles,
// what remains on disk is an intent with no outcome — which is exactly the
// statement "a mutation was authorized and its result is unknown", and is what a
// later run reads before deciding anything.
//
// NO PAYLOAD, NO ENVIRONMENT, NO CREDENTIAL IS EVER PUBLISHED. The evidence
// records job ids, names and states; the scheduled row's identity and status; and
// the sanitized Redis endpoint. Job `data` is never read into a bundle.

import { Queue } from 'bullmq'
import { createHash } from 'node:crypto'
import { basename } from 'node:path'

import { publishEvidence, verifyPublishedEvidence } from '@common/db/pg-copy'
import { closeDb, openDb, openDbReadOnly } from '@common/pipeline-runs'

import {
  collectFlowJobs, removePlannedFlow, type FlowRemovalPlan, type JobRef,
} from '../src/flow-cleanup.js'
import {
  FORBIDDEN_STATES, INTENT_PREFIX, OUTCOME_PREFIX, RETIREMENT_BINDING_VERSION,
  RetirementRefused, assertRetirable, deviceInode, measureImplementationAuthority,
  planDigest, retirementBindingDocument, retirementPlan, retirementToken,
  type RedisEndpoint, type RetirementOutcome, type ScheduledRow,
} from '../src/flow-retirement.js'

const MODES = ['--inspect', '--apply'] as const
const OPTIONS = [
  '--parent-run-id', '--logical-date', '--expect-failed', '--queue',
  '--checkout', '--pipeline-runs-db', '--evidence-root',
  '--redis-host', '--redis-port', '--redis-db',
  '--confirm', '--run-id', '--stamp',
] as const

function parseArgs(argv: readonly string[]): {
  mode: string; values: Readonly<Record<string, string>>
} {
  let mode: string | null = null
  const values: Record<string, string> = {}
  for (const arg of argv) {
    if ((MODES as readonly string[]).includes(arg)) {
      if (mode !== null) throw new RetirementRefused('exactly one mode is required')
      mode = arg
      continue
    }
    const eq = arg.indexOf('=')
    if (!arg.startsWith('--') || eq < 0) {
      throw new RetirementRefused('an argument is not a reviewed --option=value', arg)
    }
    const name = arg.slice(0, eq)
    if (!(OPTIONS as readonly string[]).includes(name)) {
      throw new RetirementRefused('an option is not reviewed', name)
    }
    values[name] = arg.slice(eq + 1)
  }
  if (mode === null) throw new RetirementRefused('exactly one mode is required')
  return { mode, values: Object.freeze(values) }
}

const required = (v: Readonly<Record<string, string>>, name: string): string => {
  const got = v[name]
  if (got === undefined || got === '') throw new RetirementRefused('a required option is missing', name)
  return got
}

/** No URL, no userinfo, no password — three plain coordinates. */
function reviewedRedis(v: Readonly<Record<string, string>>): RedisEndpoint {
  const host = required(v, '--redis-host')
  const port = required(v, '--redis-port')
  const db = required(v, '--redis-db')
  if (!/^[A-Za-z0-9._-]{1,120}$/.test(host) || host.includes('@') || host.includes('://')) {
    throw new RetirementRefused('the redis host is not in the reviewed form')
  }
  if (!/^[1-9][0-9]{0,4}$/.test(port)) throw new RetirementRefused('the redis port is not in the reviewed form')
  if (!/^\d{1,5}$/.test(db)) throw new RetirementRefused('the redis database is not in the reviewed form')
  return { host, port: Number(port), db: Number(db) }
}

/**
 * Read the scheduled row and its children, WAL-AWARE.
 *
 * `openDbReadOnly` opens the ordinary pathname with better-sqlite3's `readonly`,
 * which reads committed WAL frames. It deliberately does NOT use SQLite's
 * `immutable=1`: that flag tells SQLite the file cannot change and to ignore the
 * -wal sidecar entirely, and using it against this database reported a stale
 * census that was 13 rows and three weeks behind and declared the target row
 * absent. A regression test pins this.
 */
function readScheduledRow(dbPath: string, parentRunId: string): ScheduledRow | null {
  const db = openDbReadOnly(dbPath)
  try {
    const row = db.prepare(
      `SELECT id, parent_run_id, stage, source, status, logical_date, superseded_at, metadata_json
         FROM pipeline_runs WHERE id = ?`).get(parentRunId) as {
      id: string; parent_run_id: string | null; stage: string; source: string
      status: string; logical_date: string | null; superseded_at: string | null
      metadata_json: string | null
    } | undefined
    if (row === undefined) return null
    let failedStage: string | null = null
    if (row.metadata_json !== null) {
      try {
        failedStage = (JSON.parse(row.metadata_json) as { failedStage?: string }).failedStage ?? null
      } catch { failedStage = null }
    }
    const kids = db.prepare(
      `SELECT id, stage, status FROM pipeline_runs WHERE parent_run_id = ?`).all(parentRunId) as
      { id: string; stage: string; status: string }[]
    return {
      id: row.id, parentRunId: row.parent_run_id, stage: row.stage, source: row.source,
      status: row.status, logicalDate: row.logical_date, supersededAt: row.superseded_at,
      failedStage,
      children: kids.map(k => ({ id: k.id, stage: k.stage, status: k.status })),
    }
  } finally {
    db.close()
  }
}

/** A read-only queue handle. A plain `new Queue` writes `<queue>:meta`. */
function inspectionQueue(name: string, redis: RedisEndpoint): Queue {
  return new Queue(name, {
    connection: { host: redis.host, port: redis.port, db: redis.db },
    skipMetasUpdate: true,
  })
}

/**
 * One read-only measurement of the queue: the flow's census AND the workers that
 * could advance it.
 *
 * Both come from the same handle in the same pass, so a census cannot be paired
 * with a worker count taken at another moment.
 */
async function measureQueue(
  name: string, redis: RedisEndpoint, parentRunId: string,
): Promise<{ census: readonly JobRef[]; workers: number }> {
  const q = inspectionQueue(name, redis)
  try {
    const census = await collectFlowJobs(q, parentRunId)
    const workers = (await q.getWorkers()).length
    return { census, workers }
  } finally {
    await q.close()
  }
}

const artifact = (path: string, value: unknown) =>
  ({ path, bytes: Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf-8') })

function newRunId(): string {
  return createHash('sha256').update(`${String(Date.now())}:${String(process.pid)}`)
    .digest('hex').slice(0, 8)
}

function utcStamp(d: Date): string {
  const p = (n: number, w = 2) => String(n).padStart(w, '0')
  return `${String(d.getUTCFullYear())}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}` +
         `T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`
}

async function main(): Promise<number> {
  const parsed = parseArgs(process.argv.slice(2))
  const v = parsed.values
  const say = (l: string): void => { process.stdout.write(`${l}\n`) }

  const parentRunId = required(v, '--parent-run-id')
  const logicalDate = required(v, '--logical-date')
  const queueName = required(v, '--queue')
  const checkout = required(v, '--checkout')
  const dbPath = required(v, '--pipeline-runs-db')
  const evidenceRoot = required(v, '--evidence-root')
  const redis = reviewedRedis(v)
  const expectedFailedIds = required(v, '--expect-failed').split(',').map(s => s.trim()).filter(s => s.length > 0)

  if (!/^[0-9a-f-]{36}$/.test(parentRunId)) {
    throw new RetirementRefused('the parent run id is not in the reviewed form')
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(logicalDate)) {
    throw new RetirementRefused('the logical date is not in the reviewed form')
  }

  // ── MEASURE ──────────────────────────────────────────────────────────────
  //
  // THE IMPLEMENTATION IS DERIVED FROM THIS FILE, not from `--checkout`. The option
  // is compared against the derived root and refused if it names anywhere else.
  const implementation = measureImplementationAuthority(checkout, import.meta.url)
  const row = readScheduledRow(dbPath, parentRunId)
  if (row === null) {
    throw new RetirementRefused('no scheduled run row has that identifier', parentRunId)
  }

  const measured = await measureQueue(queueName, redis, parentRunId)

  assertRetirable({
    parentRunId, logicalDate, queue: queueName, row,
    census: measured.census, expectedFailedIds, workersPresent: measured.workers,
  })

  const plan = retirementPlan(parentRunId, measured.census)
  const binding = {
    bindingVersion: RETIREMENT_BINDING_VERSION,
    implementation,
    parentRunId,
    queue: queueName,
    row,
    census: measured.census,
    planDigest: planDigest(plan),
    workersPresent: measured.workers,
    expectedFailedIds,
    redis,
    evidenceRoot,
    evidenceRootDeviceInode: deviceInode(evidenceRoot),
    intent: `supersede-scheduled-run:${row.id}`,
  }
  const token = retirementToken(binding)

  // ── INSPECT ──────────────────────────────────────────────────────────────
  if (parsed.mode === '--inspect') {
    const runId = v['--run-id'] ?? newRunId()
    const stamp = v['--stamp'] ?? utcStamp(new Date())
    say(`mode inspect`)
    say(`implementation ${implementation.root} @ ${implementation.head} (tracked worktree clean, reviewed source untracked-free)`)
    say(`workers able to advance this queue ${String(measured.workers)}`)
    say(`scheduled row ${row.id} ${row.stage}/${row.source} ${row.status} ${String(row.logicalDate)} superseded=${String(row.supersededAt)} failedStage=${String(row.failedStage)} children=${row.children.length}`)
    say(`queue ${queueName} on ${redis.host}:${String(redis.port)}/${String(redis.db)}`)
    say(`jobs in flow ${measured.census.length}`)
    for (const s of plan.order) {
      say(`  remove ${s.state.padEnd(17)} ${s.name.padEnd(26)} ${s.id} parent=${s.parentId ?? '<root>'}`)
    }
    say(`removal plan digest ${binding.planDigest}  ancestors-first ${String(plan.ancestorsFirst)}`)
    say(`evidence root ${evidenceRoot} ${binding.evidenceRootDeviceInode}`)
    say(`run ${runId} ${stamp}`)
    say(`confirmation ${token}`)
    say('This inspection changed nothing: no job, no row, no queue metadata and no')
    say('evidence bundle was written.')
    return 0
  }

  // ── APPLY ────────────────────────────────────────────────────────────────
  const confirm = required(v, '--confirm')
  if (confirm !== token) {
    throw new RetirementRefused(
      'the confirmation does not match the remeasured world; re-run --inspect')
  }
  const runId = required(v, '--run-id')
  const stamp = required(v, '--stamp')

  const common = {
    binding_version: RETIREMENT_BINDING_VERSION,
    run: { id: runId, stamp },
    confirmation: token,
    binding: retirementBindingDocument(binding),
    removal_plan: plan.order.map(s => ({ id: s.id, name: s.name, state: s.state })),
  }

  // THE INTENT, BEFORE ANY MUTATION.
  const intent = publishEvidence({
    root: evidenceRoot, prefix: INTENT_PREFIX, stamp, runId,
    artifacts: [artifact('plan.json', common)],
    manifest: artifact('manifest.json', {
      complete: true, record: INTENT_PREFIX, ...common,
      declares: 'the removal below is authorized and has not yet been attempted',
    }),
  })
  say(`published ${basename(intent.finalPath)} digest=${intent.digestFileDigest}`)

  let outcome: RetirementOutcome = 'unknown'
  let removed = 0
  let remaining: readonly JobRef[] = []
  let supersededAt: string | null = null
  let note = ''

  try {
    // THE CENSUS THAT IS DELETED IS THE CENSUS THAT WAS CHECKED.
    //
    // WHAT WAS WRONG BEFORE. A guard measured a fresh census, validated it, compared
    // its token — and then `removeFlow` went and measured a THIRD census of its own
    // and deleted that one, unvalidated and uncompared. So the sequence validated one
    // world and deleted another, while claiming drift was refused. It was not.
    //
    // Now one census is measured after the intent is on disk, exact-compared against
    // the authorized one, structurally revalidated, turned into a plan that is
    // compared against the authorized plan digest, and that exact plan is what the
    // remover consumes. There is no later recollection.
    const fresh = await measureQueue(queueName, redis, parentRunId)
    const freshRow = readScheduledRow(dbPath, parentRunId)
    if (freshRow === null) {
      throw new RetirementRefused('the scheduled row disappeared after the intent was published')
    }
    assertRetirable({
      parentRunId, logicalDate, queue: queueName, row: freshRow,
      census: fresh.census, expectedFailedIds, workersPresent: fresh.workers,
    })
    const freshPlan: FlowRemovalPlan = retirementPlan(parentRunId, fresh.census)
    const freshDigest = planDigest(freshPlan)
    if (freshDigest !== binding.planDigest) {
      throw new RetirementRefused('the removal plan changed after the intent was published',
                                  freshDigest)
    }
    if (retirementToken({ ...binding, row: freshRow, census: fresh.census,
                          planDigest: freshDigest, workersPresent: fresh.workers }) !== token) {
      throw new RetirementRefused('the world changed after the intent was published')
    }

    const writeQueue = new Queue(queueName, {
      connection: { host: redis.host, port: redis.port, db: redis.db },
    })
    try {
      // AND THE WORKER CHECK IS REPEATED IMMEDIATELY BEFORE THE FIRST REMOVAL,
      // against the handle about to do the removing.
      const attached = (await writeQueue.getWorkers()).length
      if (attached !== 0) {
        throw new RetirementRefused('a worker attached to this queue before the removal',
                                    String(attached))
      }
      // THE MEASURED PLAN, CONSUMED. No second collection.
      removed = await removePlannedFlow(writeQueue, freshPlan)
      remaining = await collectFlowJobs(writeQueue, parentRunId)
    } finally {
      await writeQueue.close()
    }

    if (remaining.length > 0) {
      outcome = 'partial'
      note = `${remaining.length} job(s) for this parent run still remain`
    } else {
      // EXACTLY ONE ROW, AND ONLY IF IT IS STILL THE ROW THAT WAS BOUND.
      const db = openDb(dbPath)
      let changes: number
      try {
        const when = new Date().toISOString()
        changes = db.prepare(
          `UPDATE pipeline_runs SET superseded_at = ?
            WHERE id = ? AND status = 'failed' AND logical_date = ? AND superseded_at IS NULL`,
        ).run(when, parentRunId, logicalDate).changes
      } finally {
        // ON EVERY PATH. `openDb` caches its handle, and a CLI that exits without
        // closing leaves a writable connection on the production run store.
        closeDb()
      }
      const info = { changes }
      if (info.changes !== 1) {
        outcome = 'partial'
        note = `the scheduled row was not superseded (${info.changes} row(s) changed)`
      } else {
        const after = readScheduledRow(dbPath, parentRunId)
        supersededAt = after?.supersededAt ?? null
        const intact = after !== null && after.status === 'failed' &&
                       after.logicalDate === logicalDate && supersededAt !== null
        outcome = intact ? 'complete' : 'partial'
        if (!intact) note = 'the superseded row did not verify'
      }
    }
  } catch (e) {
    if (e instanceof RetirementRefused) {
      // NOTHING WAS MUTATED. The intent stands as a record that a removal was
      // authorized and then declined, which is a different fact from a crash.
      outcome = 'refused'
      note = e.message
    } else {
      outcome = 'unknown'
      note = `the retirement did not complete: ${(e as Error).name}`
    }
  }

  const result = {
    complete: true, record: OUTCOME_PREFIX, ...common,
    outcome, removed_count: removed,
    remaining_for_parent_run: remaining.length,
    scheduled_row_superseded_at: supersededAt,
    note,
  }
  const published = publishEvidence({
    root: evidenceRoot, prefix: OUTCOME_PREFIX, stamp, runId,
    artifacts: [artifact('outcome.json', result)],
    manifest: artifact('manifest.json', result),
  })
  say(`published ${basename(published.finalPath)} digest=${published.digestFileDigest}`)
  verifyPublishedEvidence(intent.finalPath)
  verifyPublishedEvidence(published.finalPath)
  say(`outcome ${outcome} removed=${String(removed)} remaining=${String(remaining.length)} superseded_at=${String(supersededAt)}`)
  if (note !== '') say(`note ${note}`)
  return outcome === 'complete' ? 0 : 1
}

void FORBIDDEN_STATES
main().then(code => { process.exit(code) }).catch((err: unknown) => {
  process.stderr.write(`REFUSED: ${(err as Error).message}\n`)
  process.exit(2)
})
