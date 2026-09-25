// THE WHOLE LIFECYCLE AGAINST TWO LIVE PostgreSQL 17 CLUSTERS.
//
// A genuine CURRENT_V10 source with a published Stage-1 bundle, a separate
// CURRENT_V19 target, and one process that takes the fence, copies, verifies,
// authorizes, releases, proves the release and restores the producers.
//
// WHAT IS PROVED HERE AND NOWHERE ELSE: the LOCK LIFETIME. Every offline test
// in this repository can assert that a release happens after an authorization;
// none of them can show that a writer is still blocked at the instant the gate
// runs and is free the instant after the ROLLBACK. That is a property of a real
// PostgreSQL transaction, and it is the property the whole milestone rests on.

import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { inspect } from 'node:util'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { REAL_EVIDENCE_OPS, newRunId, type EvidenceOps } from '../../src/pg-copy/evidence.js'
import { EXPORT_ROLE_NAME } from '../../src/pg-copy/export-role.js'
import {
  openDriverSession, openSilentDriverSession,
  type DriverSession, type DriverTarget,
} from '../../src/pg-copy/driver-session.js'
import {
  LIFECYCLE_FILE, LifecycleInterventionRequired, LifecycleRefused, RELEASE_GATE_FILE,
  RESTORE_ORDER,
  REVIEWED_PRODUCERS, REVIEWED_QUEUES, isInterventionRequired, runLifecycle,
  type ProducerAdapter, type QueueAdapter, type QuiescenceAdapter, type ReviewedSession,
} from '../../src/pg-copy/lifecycle.js'
import { COPY_TABLES, sha256Hex } from '../../src/pg-copy/schema-contract.js'
import {
  FENCE_PROOF_SQL, FENCE_SEQUENCES, assertFenceProof, fenceRelationArray, parseLockRows,
} from '../../src/pg-copy/source-fence.js'
import {
  EXPORT_BEGIN_SQL, runStage1, type OperatorInput,
} from '../../src/pg-copy/source-manifest.js'
import { loadReviewedTarget, readPublishedBundle, runInspect }
  from '../../src/pg-copy/stage2.js'
import { TARGET_OWNER_ROLE } from '../../src/pg-copy/target-authority.js'
import { VERIFICATION_FILE } from '../../src/pg-copy/verify.js'
import {
  cleanSecretRoots, makeSecretRoot, provisionExportRole, readPublishedCredential,
  requireScramForExportRole, writePassfileFromCredential, type ProvisionedExportRole,
} from '../../testing/export-role.js'
import {
  startDisposableCluster, stopAllDisposableClusters, unstoppedRoots,
  type DisposableCluster,
} from '../../testing/disposable-cluster.js'
import {
  closeAllPsqlSessions, openPsqlSession, openPsqlSessionCount, type PsqlSession,
} from '../../testing/psql-session.js'
import { buildV10Database, buildV19Database } from '../../testing/v19-database.js'

const SRC_DB = 'ai_capital_src'
const TGT_DB = 'ai_capital_tgt'
/** A V19 database whose one NUMERIC differs, for the verifier-FAIL case. */
const DRIFT_DB = 'ai_capital_drift'
const TARGET_LOGIN = 'ai_capital_migrator'
const TARGET_PASSWORD = 'lifecycle_target_pw_0123456789'

let SRC: DisposableCluster
let TGT: DisposableCluster
let ROLE: ProvisionedExportRole
let SRC_SYSID = ''
let TGT_SYSID = ''
let BUNDLE = ''
const ROOTS: string[] = []

function evidenceRoot(): string {
  const r = mkdtempSync(join(tmpdir(), 'pgcopy-lifecycle-ev-'))
  execFileSync('/bin/chmod', ['700', r])
  ROOTS.push(r)
  return r
}

const surfaces = (e: unknown): string => {
  const err = e as Error & Record<string, unknown>
  let json = ''
  try { json = JSON.stringify(err, Object.getOwnPropertyNames(err)) } catch { json = '' }
  return [String(err.message), String(err.stack ?? ''),
          Object.getOwnPropertyNames(err).join(','), json,
          inspect(err, { depth: 8, showHidden: true })].join('\n')
}

const VECTOR_384 =
  `(SELECT ('[' || pg_catalog.string_agg('0.25', ',') || ']')::public.vector(384) ` +
  `FROM pg_catalog.generate_series(1, 384))`

const SEED = (price: string): readonly string[] => Object.freeze([
  `INSERT INTO capital.watchlist (ticker, company, themes, added_at, news_search_terms, cik)
     VALUES ('AAA', 'Alpha Corp', 'x', TIMESTAMPTZ '2026-01-01 00:00:00+00', 'alpha', NULL)`,
  `INSERT INTO portfolio.trade_log (trade_date, ticker, action, shares, price)
     VALUES (DATE '2026-01-01', 'AAA', 'buy', 10, ${price})`,
  `INSERT INTO portfolio.positions (ticker, company, shares, avg_cost, updated_at)
     VALUES ('AAA', 'Alpha Corp', 10.50, 1.10, TIMESTAMPTZ '2026-01-01 00:00:00+00')`,
  `INSERT INTO briefing.qa (date, asked_at, mode, exchanges)
     VALUES (DATE '2026-01-02', TIMESTAMPTZ '2026-01-02 09:00:00+00', 'probe',
             '{"turns":[]}'::pg_catalog.jsonb)`,
  `INSERT INTO capital.fetch_log (ticker, source, fetched_at, doc_count, chunk_count)
     VALUES ('AAA', 'probe', TIMESTAMPTZ '2026-01-01 10:00:00+00', 1, 1)`,
  `INSERT INTO capital.chunks (id, ticker, company, source, doc_type, chunk_index,
                               parent_doc_id, content_hash, embedding_model, content, embedding)
     VALUES ('chunk-1', 'AAA', 'Alpha Corp', 'probe', 'note', 0,
             'doc-1', 'deadbeef', 'probe-model', 'the chunk text', ${VECTOR_384})`,
  `INSERT INTO graph.nodes (ticker, company, themes) VALUES ('AAA', 'Alpha Corp', 'x')`,
])

async function write(c: DisposableCluster, db: string, sql: string): Promise<void> {
  const s = await openPsqlSession(c, db)
  try { await s.must(sql) } finally { await s.close() }
}

async function seedAsOwner(c: DisposableCluster, db: string, price: string): Promise<void> {
  const s = await openPsqlSession(c, db)
  try {
    for (const sql of SEED(price)) {
      await s.must('BEGIN')
      await s.must(`SET LOCAL ROLE ${TARGET_OWNER_ROLE}`)
      await s.must(sql)
      await s.must('COMMIT')
    }
  } finally { await s.close() }
}

async function sysid(c: DisposableCluster, db: string): Promise<string> {
  const s = await openPsqlSession(c, db)
  try {
    return (await s.must(
      'SELECT (pg_catalog.pg_control_system()).system_identifier::pg_catalog.text'))[0][0]
  } finally { await s.close() }
}

const OPERATOR = (): OperatorInput => ({
  runId: newRunId(),
  generatedAtUtc: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
  implementationHead: 'a'.repeat(40),
  provenanceHead: 'b'.repeat(40),
  ingestionGitlink: 'c'.repeat(40),
  expectedTargetLabel: 'lifecycle-target',
  expectedSystemIdentifier: SRC_SYSID,
  sourceLabel: 'lifecycle-source',
  requestedEndpoint: SRC.socketDir,
  sourcePort: String(SRC.port),
  sourceDatabase: SRC_DB,
})

const TARGET_EXPECTATION = (): {
  systemIdentifier: string; database: string; port: string; role: string; endpoint: string
} => ({
  systemIdentifier: TGT_SYSID, database: TGT_DB, port: String(TGT.port),
  role: TARGET_LOGIN, endpoint: TGT.socketDir,
})

beforeAll(async () => {
  SRC = await startDisposableCluster()
  await buildV10Database(SRC, SRC_DB)
  for (const sql of SEED('1.10')) await write(SRC, SRC_DB, sql)
  await requireScramForExportRole(SRC)
  ROLE = await provisionExportRole(SRC, SRC_DB, makeSecretRoot())
  writePassfileFromCredential(ROLE.secretRoot, readPublishedCredential(ROLE.credentialPath))
  SRC_SYSID = await sysid(SRC, SRC_DB)

  TGT = await startDisposableCluster()
  await buildV19Database(TGT, TGT_DB)
  await buildV19Database(TGT, DRIFT_DB)
  await seedAsOwner(TGT, DRIFT_DB, '1.1')
  for (const db of [TGT_DB, DRIFT_DB]) {
    await write(TGT, db, `ALTER ROLE ${TARGET_LOGIN} WITH LOGIN PASSWORD '${TARGET_PASSWORD}'`)
  }
  TGT_SYSID = await sysid(TGT, TGT_DB)

  const root = evidenceRoot()
  const supervisor = await openPsqlSession(SRC, SRC_DB)
  const prover = await openPsqlSession(SRC, SRC_DB)
  const exportSession = await openExport()
  try {
    BUNDLE = (await runStage1({
      supervisor, prover, exportSession, operator: OPERATOR(), evidenceRoot: root,
    })).published.finalPath
  } finally {
    await supervisor.send('ROLLBACK')
    for (const s of [exportSession, prover, supervisor]) await s.close()
  }
}, 1_800_000)

afterAll(async () => {
  await closeAllPsqlSessions()
  await stopAllDisposableClusters()
  cleanSecretRoots()
  for (const r of ROOTS.splice(0)) {
    try { execFileSync('/bin/chmod', ['-R', 'u+rwX', r]) } catch { /* gone */ }
    rmSync(r, { recursive: true, force: true })
  }
}, 600_000)

async function openExport(): Promise<PsqlSession> {
  const cred = readPublishedCredential(ROLE.credentialPath)
  return await openPsqlSession(SRC, SRC_DB, {
    user: EXPORT_ROLE_NAME,
    passfile: writePassfileFromCredential(ROLE.secretRoot, cred, `p-${newRunId()}.pgpass`),
  })
}

const sourceTarget = (): DriverTarget => {
  const cred = readPublishedCredential(ROLE.credentialPath)
  return { host: cred.host, port: Number(cred.port), database: cred.database,
           user: cred.user, password: cred.password }
}

const targetTarget = (db: string): DriverTarget => ({
  host: TGT.socketDir, port: TGT.port, database: db,
  user: TARGET_LOGIN, password: TARGET_PASSWORD,
})

const REVIEWED_TARGET = (): ReturnType<typeof loadReviewedTarget> => loadReviewedTarget(
  join(process.cwd(), 'contracts', 'expected-target-v19.json'), p => readFileSync(p, 'utf-8'))

/**
 * EXACT pid+role pairs for every session this suite legitimately has open.
 *
 * The lifecycle's own three - supervisor, prover and the Stage-2 source - plus
 * the verifier's two, which come and go. Sampled live rather than listed,
 * because pids are assigned by the server.
 */
async function reviewedSessions(): Promise<ReviewedSession[]> {
  const s = await openPsqlSession(SRC, SRC_DB)
  try {
    const rows = await s.must(`
      SELECT pid::pg_catalog.text, COALESCE(usename::pg_catalog.text, '')
        FROM pg_catalog.pg_stat_activity
       WHERE datname = pg_catalog.current_database()
         AND backend_type = 'client backend'
       ORDER BY 1`)
    // This probe's own backend is about to close, so it is not reviewed.
    return rows.filter(r => r[0] !== s.pid).map(r => ({ pid: r[0], role: r[1] }))
  } finally { await s.close() }
}

/** In-memory adapters. NOTHING here touches launchd, Redis or a shell. */
const zeroDepths = (): Record<string, number> =>
  Object.fromEntries(REVIEWED_QUEUES.map(q => [q, 0]))

function adapters(over: {
  stopped?: () => boolean
  depths?: () => Record<string, number>
  confirm?: (n: string) => boolean
  /** Runs INSIDE the gate, between verification and authorization. */
  onSample?: () => Promise<void>
} = {}): {
  quiescence: QuiescenceAdapter; queue: QueueAdapter; producers: ProducerAdapter
  actions: string[]
} {
  const actions: string[] = []
  return {
    actions,
    quiescence: {
      report: async () => REVIEWED_PRODUCERS.map(name => ({
        name, stopped: over.stopped === undefined ? true : over.stopped(),
      })),
    },
    queue: {
      sample: async () => {
        // THE ONE PLACE THIS SUITE CAN STAND INSIDE THE GATE. The queue is
        // sampled after verification and before the authorization is minted,
        // which is exactly the window where the fence must still be holding.
        if (over.onSample !== undefined) await over.onSample()
        return { depths: over.depths?.() ?? zeroDepths() }
      },
    },
    producers: {
      restore: async (n: string) => { actions.push(`restore ${n}`) },
      confirm: async (n: string) => {
        actions.push(`confirm ${n}`)
        return over.confirm === undefined ? true : over.confirm(n)
      },
    },
  }
}

/** Is the whole reviewed fence held by this supervisor, right now? */
async function fenceHeld(supervisor: PsqlSession, prover: PsqlSession): Promise<boolean> {
  try {
    const locks = parseLockRows(
      await prover.must(FENCE_PROOF_SQL.replace('$1', fenceRelationArray())))
    assertFenceProof(locks, { supervisorPid: supervisor.pid, provingPid: prover.pid })
    return true
  } catch { return false }
}

/** Put the target back to empty and pristine, as the owner. */
async function resetTarget(): Promise<void> {
  const s = await openPsqlSession(TGT, TGT_DB)
  try {
    await s.must('BEGIN')
    await s.must(`SET LOCAL ROLE ${TARGET_OWNER_ROLE}`)
    await s.must(`TRUNCATE ${COPY_TABLES.join(', ')} RESTART IDENTITY CASCADE`)
    for (const q of FENCE_SEQUENCES) await s.must(`ALTER SEQUENCE ${q} RESTART WITH 1`)
    await s.must('COMMIT')
  } finally { await s.close() }
}

interface Run {
  result: unknown
  thrown: unknown
  supervisor: PsqlSession
  prover: PsqlSession
  actions: string[]
  root: string
  stageSessions: DriverSession[]
  /** Every statement the OWNED Stage-2 source session was asked for. */
  stageStatements: string[]
}

async function lifecycle(opts: {
  targetDb?: string
  stopped?: () => boolean
  depths?: () => Record<string, number>
  confirm?: (n: string) => boolean
  duringRun?: (s: { supervisor: PsqlSession; prover: PsqlSession }) => Promise<void>
  onSample?: () => Promise<void>
  /** Runs AFTER the reviewed-session snapshot, so what it opens is unreviewed. */
  afterSnapshot?: () => Promise<void>
  badConfirmation?: boolean
  /** Make the OWNED Stage-2 source refuse to close, after its snapshot ended. */
  stageEndThrows?: boolean
  ops?: EvidenceOps
} = {}): Promise<Run> {
  await resetTarget()
  const root = evidenceRoot()

  const confirmation = await (async () => {
    const sup = await openPsqlSession(SRC, SRC_DB)
    const prv = await openPsqlSession(SRC, SRC_DB)
    const src = await openDriverSession(sourceTarget())
    try {
      return (await runInspect({
        supervisor: sup, prover: prv, source: src, operator: OPERATOR(),
        sourceBeginSql: EXPORT_BEGIN_SQL, reviewedTarget: REVIEWED_TARGET(),
      }, readPublishedBundle(BUNDLE, f => readFileSync(f, 'utf-8'), sha256Hex),
         TARGET_EXPECTATION())).confirmation
    } finally {
      try { await src.rows('ROLLBACK') } catch { /* bounded */ }
      await src.end()
      await prv.close()
      try { await sup.send('ROLLBACK') } catch { /* bounded */ }
      await sup.close()
    }
  })()

  const supervisor = await openPsqlSession(SRC, SRC_DB)
  const prover = await openPsqlSession(SRC, SRC_DB)
  // THE REVIEWED SET, snapshot from the live server. Whatever is connected at
  // this instant is what this suite has open and is prepared to declare;
  // anything that arrives afterwards is, by construction, unreviewed.
  const snapshot = await reviewedSessions()
  if (opts.afterSnapshot !== undefined) await opts.afterSnapshot()
  const a = adapters(opts)
  const stageSessions: DriverSession[] = []
  const stageStatements: string[] = []
  let result: unknown = null
  let thrown: unknown = null

  const run = runLifecycle({
    supervisor, prover,
    openStageSource: async () => {
      const s = await openDriverSession(sourceTarget())
      stageSessions.push(s)
      let refusedOnce = false
      return Object.freeze({
        pid: s.pid, client: s.client,
        rows: async (sql: string) => { stageStatements.push(sql); return await s.rows(sql) },
        command: s.command,
        end: async () => {
          if (opts.stageEndThrows === true && !refusedOnce) {
            refusedOnce = true
            throw new Error('injected: the session would not close')
          }
          return await s.end()
        },
        alive: s.alive,
      }) as DriverSession
    },
    openStageTarget: async () => await openDriverSession(targetTarget(TGT_DB)),
    openVerifySource: async () => await openSilentDriverSession(sourceTarget()),
    openVerifyTarget: async () =>
      await openSilentDriverSession(targetTarget(opts.targetDb ?? TGT_DB)),
    bundleDir: BUNDLE,
    reviewedTarget: REVIEWED_TARGET(),
    operator: OPERATOR(),
    sourceBeginSql: EXPORT_BEGIN_SQL,
    targetExpectation: TARGET_EXPECTATION(),
    confirmation: opts.badConfirmation === true
      ? `PGCOPY-APPLY-${'0'.repeat(64)}` : confirmation,
    quiescence: a.quiescence, queue: a.queue, producers: a.producers,
    reviewedSessions: snapshot,
    evidenceRoot: root,
    ...(opts.ops === undefined ? {} : { ops: opts.ops }),
  })
  if (opts.duringRun) await opts.duringRun({ supervisor, prover })
  try { result = await run } catch (e) { thrown = e }

  return { result, thrown, supervisor, prover, actions: a.actions, root, stageSessions,
           stageStatements }
}

async function closeBorrowed(r: Run): Promise<void> {
  await r.prover.close()
  try { await r.supervisor.send('ROLLBACK') } catch { /* bounded */ }
  await r.supervisor.close()
}

/** Can an ordinary writer change the source right now? */
async function writerBlocked(): Promise<boolean> {
  const w = await openPsqlSession(SRC, SRC_DB)
  try {
    await w.send("SET lock_timeout = '750ms'")
    const r = await w.send(
      `INSERT INTO graph.nodes (ticker, company, themes) VALUES ('ZZZ', 'Z', 'z')`)
    if (r.error === null) await w.send('DELETE FROM graph.nodes WHERE ticker = \'ZZZ\'')
    return r.error !== null
  } finally { await w.close() }
}

describe('the whole lifecycle, end to end', () => {
  it('copies, verifies, authorizes, releases, proves and restores - in that order', async () => {
    const r = await lifecycle({})
    try {
      expect(r.thrown).toBeNull()
      const v = r.result as Awaited<ReturnType<typeof runLifecycle>>
      expect(v.outcome).toBe('COMPLETE')
      expect(v.fence).toBe('released')
      expect([...v.restored]).toEqual([...RESTORE_ORDER])

      // THREE BUNDLES, all published, all distinct, all frozen.
      const published = readdirSync(r.root).sort()
      expect(published.filter(n => n.startsWith('verification-')).length).toBe(1)
      expect(published.filter(n => n.startsWith('release-gate-')).length).toBe(1)
      expect(published.filter(n => n.startsWith('copy-lifecycle-')).length).toBe(1)
      expect(readdirSync(r.root).filter(n => n.startsWith('.tmp'))).toEqual([])
      for (const p of [v.verifierBundle, v.releaseGateBundle, v.lifecycleBundle]) {
        expect(statSync(p).mode & 0o777).toBe(0o500)
        for (const f of readdirSync(p)) {
          expect(statSync(join(p, f)).mode & 0o777).toBe(0o400)
        }
      }
      expect(new Set([v.verifierBundle, v.releaseGateBundle, v.lifecycleBundle]).size).toBe(3)

      // WHAT EACH ONE SAYS.
      const verification = JSON.parse(
        readFileSync(join(v.verifierBundle, VERIFICATION_FILE), 'utf-8'))
      expect(verification.outcome).toBe('PASS')
      const gate = JSON.parse(readFileSync(join(v.releaseGateBundle, RELEASE_GATE_FILE), 'utf-8'))
      expect(gate.record).toBe('authorization-to-release')
      expect(gate.released).toBeNull()
      expect(gate.producers_restored).toBeNull()
      expect(gate.fence.ungranted).toBe(0)
      const outcome = JSON.parse(readFileSync(join(v.lifecycleBundle, LIFECYCLE_FILE), 'utf-8'))
      expect(outcome.record).toBe('lifecycle-outcome')
      expect(outcome.outcome).toBe('COMPLETE')
      expect(outcome.fence.state).toBe('released')
      expect(outcome.restoration.restored).toEqual([...RESTORE_ORDER])
      expect(outcome.bundle.release_gate).toBe(v.releaseGateBundle)

      // THE PRODUCERS CAME BACK IN THE REVIEWED REVERSE ORDER, each confirmed.
      expect(r.actions).toEqual(RESTORE_ORDER.flatMap(n => [`restore ${n}`, `confirm ${n}`]))

      // THE FENCE IS GONE, and an ordinary writer can work again.
      expect(await fenceHeld(r.supervisor, r.prover)).toBe(false)
      expect(await writerBlocked()).toBe(false)

      // THE BYTES ARRIVED.
      const t = await openPsqlSession(TGT, TGT_DB)
      try {
        const price = await t.must(
          "SELECT price::pg_catalog.text FROM portfolio.trade_log WHERE ticker = 'AAA'")
        expect(price[0][0]).toBe('1.10')
      } finally { await t.close() }
    } finally { await closeBorrowed(r) }
  }, 1_800_000)

  it('a REAL writer is BLOCKED between verification and authorization, and free after release',
    async () => {
      // NOT A MARKER. A third backend issues genuine INSERT, UPDATE, DELETE and
      // TRUNCATE statements against fenced tables, from inside the gate - after
      // verification and before the authorization is minted - and every one of
      // them must hit `lock_timeout` rather than succeed. That is the property
      // the entire milestone rests on, and nothing short of a real statement
      // against a real lock can establish it.
      const attempts: Array<{ sql: string; blocked: boolean }> = []
      let samples = 0
      const r = await lifecycle({
        onSample: async () => {
          samples += 1
          if (samples !== 1) return
          const w = await openPsqlSession(SRC, SRC_DB)
          try {
            await w.send("SET lock_timeout = '750ms'")
            for (const sql of [
              `INSERT INTO graph.nodes (ticker, company, themes) VALUES ('ZZZ', 'Z', 'z')`,
              `UPDATE graph.nodes SET company = 'changed' WHERE ticker = 'AAA'`,
              `DELETE FROM graph.nodes WHERE ticker = 'AAA'`,
              `TRUNCATE portfolio.positions`,
              `SELECT pg_catalog.nextval('portfolio.trade_log_id_seq')`,
            ]) {
              const res = await w.send(sql)
              attempts.push({ sql: sql.split(' ')[0], blocked: res.error !== null })
              if (res.error === null) await w.send('ROLLBACK')
            }
          } finally { await w.close() }
        },
      })
      try {
        // The writer above is gone by the time the census runs, so the run
        // completes - and every statement it made was refused.
        expect(r.thrown).toBeNull()
        expect(samples).toBe(2)
        expect(attempts.length).toBe(5)
        for (const a of attempts) expect(a.blocked, a.sql).toBe(true)

        // AND AFTER THE PROVED RELEASE, a writer succeeds.
        expect(await writerBlocked()).toBe(false)

        const gate = JSON.parse(readFileSync(
          join((r.result as { releaseGateBundle: string }).releaseGateBundle,
               RELEASE_GATE_FILE), 'utf-8'))
        expect(gate.fence.relations).toBeGreaterThanOrEqual(
          COPY_TABLES.length + FENCE_SEQUENCES.length)
        expect(gate.fence.ungranted).toBe(0)
        expect(gate.quiescence.every((p: { stopped: boolean }) => p.stopped)).toBe(true)
      } finally { await closeBorrowed(r) }
    }, 1_800_000)

  it('closes the sessions it OWNS and never the caller sessions', async () => {
    const r = await lifecycle({})
    try {
      expect(r.thrown).toBeNull()
      // The Stage-2 source session was opened by the lifecycle and is closed.
      expect(r.stageSessions.length).toBe(1)
      expect(r.stageSessions[0].alive()).toBe(false)
      // The supervisor and the prover are the CALLER'S and are still usable.
      expect(r.supervisor.alive()).toBe(true)
      expect((await r.prover.must('SELECT 1'))[0][0]).toBe('1')
      expect((await r.supervisor.must('SELECT 1'))[0][0]).toBe('1')
    } finally { await closeBorrowed(r) }
  }, 1_800_000)
})

describe('nothing is released when something is wrong', () => {
  async function expectIntervention(r: Run, phase: string): Promise<LifecycleInterventionRequired> {
    expect(r.thrown).toBeInstanceOf(LifecycleInterventionRequired)
    expect(isInterventionRequired(r.thrown)).toBe(true)
    const e = r.thrown as LifecycleInterventionRequired
    expect(e.failure.phase).toBe(phase)
    return e
  }

  it('a verifier FAIL keeps the fence, restores nobody and authorizes nothing', async () => {
    const r = await lifecycle({ targetDb: DRIFT_DB })
    try {
      const e = await expectIntervention(r, 'L5-verify')
      // THE FENCE IS STILL HELD - proved, not asserted - and a writer is still
      // blocked by it.
      expect(e.fence).toBe('held')
      expect(await fenceHeld(r.supervisor, r.prover)).toBe(true)
      expect(await writerBlocked()).toBe(true)
      // NOTHING WAS RESTORED and no authorization was published.
      expect(r.actions).toEqual([])
      expect([...e.notRestored]).toEqual([...REVIEWED_PRODUCERS])
      expect(readdirSync(r.root).filter(n => n.startsWith('release-gate-'))).toEqual([])
      // The verifier's own FAIL bundle IS there, and the outcome bundle says
      // the lifecycle stopped.
      expect(readdirSync(r.root).filter(n => n.startsWith('verification-')).length).toBe(1)
      expect(e.lifecycleEvidence.verified).toBe(true)
      const doc = JSON.parse(
        readFileSync(join(e.lifecycleEvidence.publishedPath as string, LIFECYCLE_FILE), 'utf-8'))
      expect(doc.outcome).toBe('STOPPED')
      expect(doc.fence.state).toBe('held')
      expect(doc.release).toBeNull()
      expect(doc.restoration).toBeNull()
      // Nothing measured, and no credential, travels.
      const text = surfaces(e)
      expect(text).not.toContain(TARGET_PASSWORD)
      expect(text).not.toContain('Alpha Corp')
      expect(text).not.toContain('1.10')
    } finally { await closeBorrowed(r) }
  }, 1_800_000)

  it('QUIESCENCE DRIFT at the gate keeps the fence and releases nothing', async () => {
    // Stopped for L2 and for the copy; running by the time the gate asks.
    let calls = 0
    const r = await lifecycle({ stopped: () => ++calls <= REVIEWED_PRODUCERS.length })
    try {
      const e = await expectIntervention(r, 'L6-release-gate')
      expect(e.failure.at).toBe('a reviewed producer is not stopped')
      expect(e.fence).toBe('held')
      expect(await fenceHeld(r.supervisor, r.prover)).toBe(true)
      expect(r.actions).toEqual([])
      expect(readdirSync(r.root).filter(n => n.startsWith('release-gate-'))).toEqual([])
    } finally { await closeBorrowed(r) }
  }, 1_800_000)

  it('a NON-EMPTY queue keeps the fence and releases nothing', async () => {
    const r = await lifecycle({ depths: () => ({ daily: 1 }) })
    try {
      const e = await expectIntervention(r, 'L6-release-gate')
      expect(e.failure.at).toBe('the queue samples are not empty and stable')
      expect(await fenceHeld(r.supervisor, r.prover)).toBe(true)
      expect(await writerBlocked()).toBe(true)
      expect(r.actions).toEqual([])
    } finally { await closeBorrowed(r) }
  }, 1_800_000)

  it('an UNSTABLE queue between the two samples refuses', async () => {
    let n = 0
    const r = await lifecycle({
      depths: (): Record<string, number> => (n++ === 0 ? { daily: 0 } : { daily: 0, x: 0 }),
    })
    try {
      const e = await expectIntervention(r, 'L6-release-gate')
      expect(e.failure.at).toBe('the queue samples are not empty and stable')
      expect(await fenceHeld(r.supervisor, r.prover)).toBe(true)
    } finally { await closeBorrowed(r) }
  }, 1_800_000)

  it('a session nobody reviewed refuses at the gate', async () => {
    // A fourth connection to the source database, as a role nobody allowlisted.
    let intruder: PsqlSession | null = null
    try {
      const r = await lifecycle({
        afterSnapshot: async () => { intruder = await openPsqlSession(SRC, SRC_DB) },
      })
      try {
        const e = await expectIntervention(r, 'L6-release-gate')
        expect(e.failure.at).toBe('the source carries sessions that are not reviewed')
        expect(await fenceHeld(r.supervisor, r.prover)).toBe(true)
        expect(r.actions).toEqual([])
        // The intruder's pid is nowhere in what travels.
        expect(surfaces(e)).not.toContain((intruder as unknown as PsqlSession).pid)
      } finally { await closeBorrowed(r) }
    } finally { if (intruder !== null) await (intruder as PsqlSession).close() }
  }, 1_800_000)

  it('a RESTORATION failure reports its exact boundary, after a proved release', async () => {
    const r = await lifecycle({ confirm: (n: string) => n !== RESTORE_ORDER[1] })
    try {
      const e = await expectIntervention(r, 'L10-restore')
      expect(e.failure.at).toBe(RESTORE_ORDER[1])
      // THE FENCE IS GONE, and is described as gone - never as held.
      expect(e.fence).toBe('released')
      expect(e.message).toContain('HAS BEEN RELEASED')
      expect(e.message).not.toContain('still held')
      expect(await fenceHeld(r.supervisor, r.prover)).toBe(false)
      // EXACTLY ONE producer came back, and the third was never touched.
      expect([...e.restored]).toEqual([RESTORE_ORDER[0]])
      expect([...e.notRestored]).toEqual([RESTORE_ORDER[1], RESTORE_ORDER[2]])
      expect(r.actions).not.toContain(`restore ${RESTORE_ORDER[2]}`)
      // The authorization was published BEFORE the release and is still there.
      expect(e.releaseGateEvidence.verified).toBe(true)
      const doc = JSON.parse(
        readFileSync(join(e.lifecycleEvidence.publishedPath as string, LIFECYCLE_FILE), 'utf-8'))
      expect(doc.outcome).toBe('STOPPED')
      expect(doc.fence.state).toBe('released')
      expect(doc.restoration.restored).toEqual([RESTORE_ORDER[0]])
      expect(doc.restoration.failed_at).toBe(RESTORE_ORDER[1])
    } finally { await closeBorrowed(r) }
  }, 1_800_000)

})

describe('a PRE-COMMIT failure leaves no fence behind', () => {
  it('rolls back, proves the locks gone, and refuses - the target untouched', async () => {
    // A confirmation that does not match this run. Stage 2 has already taken
    // the fence at A2 and refuses before it opens a target, so the supervisor
    // is sitting inside a transaction holding all 24 reviewed locks.
    const r = await lifecycle({ badConfirmation: true })
    try {
      expect(r.thrown).toBeInstanceOf(LifecycleRefused)
      expect((r.thrown as LifecycleRefused).phase).toBe('L3-copy')
      // THE FENCE IS GONE, proved rather than assumed - and an ordinary writer
      // can work again, which is what "the caller may simply retry" requires.
      expect(await fenceHeld(r.supervisor, r.prover)).toBe(false)
      expect(await writerBlocked()).toBe(false)
      // NOTHING was restored - this lifecycle did not stop the producers - and
      // the target holds nothing.
      expect(r.actions).toEqual([])
      const t = await openPsqlSession(TGT, TGT_DB)
      try {
        const n = await t.must(
          'SELECT pg_catalog.count(*)::pg_catalog.text FROM portfolio.trade_log')
        expect(n[0][0]).toBe('0')
      } finally { await t.close() }
    } finally { await closeBorrowed(r) }
  }, 1_800_000)

  it('submits the Stage-2 snapshot ROLLBACK exactly once', async () => {
    const r = await lifecycle({})
    try {
      expect(r.thrown).toBeNull()
      // The owned source session ends its snapshot ONCE. A `finally` that
      // re-sent it would be repeating a statement already submitted.
      expect(r.stageStatements.filter(q => q === 'ROLLBACK').length).toBe(1)
      expect(r.stageStatements[r.stageStatements.length - 1]).toBe('ROLLBACK')
    } finally { await closeBorrowed(r) }
  }, 1_800_000)

  it('does NOT resend it when the session refuses to CLOSE', async () => {
    // ENDING THE TRANSACTION AND CLOSING THE SESSION ARE TWO FACTS. The
    // snapshot's ROLLBACK is submitted first; if the close then fails, the
    // session is still open and the cleanup path can see it - and a cleanup
    // that treated "still open" as "never rolled back" would send the statement
    // a second time, on a session that just told it something was wrong.
    const r = await lifecycle({ stageEndThrows: true })
    try {
      expect(r.thrown).toBeInstanceOf(LifecycleInterventionRequired)
      expect((r.thrown as LifecycleInterventionRequired).failure.phase).toBe('L4-snapshot-end')
      expect(r.stageStatements.filter(q => q === 'ROLLBACK').length).toBe(1)
      // The copy DID commit, so the fence is still this run's to hold.
      expect((r.thrown as LifecycleInterventionRequired).fence).toBe('held')
      expect(await fenceHeld(r.supervisor, r.prover)).toBe(true)
    } finally { await closeBorrowed(r) }
  }, 1_800_000)
})

describe('the outcome publication happens once', () => {
  it('keeps the FIRST publication result when L11 fails', async () => {
    // The outcome bundle is published, and everything after the rename fails.
    // That is the finding. A second attempt under the same run id could only
    // collide with the bundle the first one just created, and reporting the
    // collision instead would send a person looking for the wrong thing.
    const seen: string[] = []
    const ops: EvidenceOps = {
      ...REAL_EVIDENCE_OPS,
      chmodSync: ((path: string, mode: number) => {
        const p = String(path)
        if (/copy-lifecycle-\d{8}T\d{6}Z-[0-9a-f]{8}$/.test(p)) {
          seen.push(p)
          throw new Error('injected')
        }
        return REAL_EVIDENCE_OPS.chmodSync(path, mode)
      }) as typeof REAL_EVIDENCE_OPS.chmodSync,
    }
    const r = await lifecycle({ ops })
    try {
      expect(r.thrown).toBeInstanceOf(LifecycleInterventionRequired)
      const e = r.thrown as LifecycleInterventionRequired
      expect(e.failure.phase).toBe('L11-outcome-evidence')
      // THE FIRST RESULT STANDS, in full.
      expect(e.lifecycleEvidence.publication).toBe('published-unverified')
      expect(e.lifecycleEvidence.evidencePhase).toBe('freeze-final')
      expect(e.lifecycleEvidence.publishedPath).not.toBeNull()
      expect(e.lifecycleEvidence.finalPathState).toBe('present')
      // ONE attempt at that name, not two.
      expect(seen.length).toBe(1)
      expect(readdirSync(r.root).filter(n => n.startsWith('copy-lifecycle-')).length).toBe(1)
      // The release already happened and is described truthfully.
      expect(e.fence).toBe('released')
      expect(await fenceHeld(r.supervisor, r.prover)).toBe(false)
    } finally { await closeBorrowed(r) }
  }, 1_800_000)
})

describe('residue', () => {
  it('leaves no open session and no foreign cluster root', async () => {
    await closeAllPsqlSessions()
    expect(openPsqlSessionCount()).toBe(0)
    expect(unstoppedRoots().sort()).toEqual([SRC.root, TGT.root].sort())
    for (const r of ROOTS) {
      expect(readdirSync(r).filter(n => n.startsWith('.tmp'))).toEqual([])
    }
  }, 600_000)
})
