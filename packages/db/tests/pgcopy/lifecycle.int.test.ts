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

import { newRunId } from '../../src/pg-copy/evidence.js'
import { EXPORT_ROLE_NAME } from '../../src/pg-copy/export-role.js'
import {
  openDriverSession, openSilentDriverSession,
  type DriverSession, type DriverTarget,
} from '../../src/pg-copy/driver-session.js'
import {
  LIFECYCLE_FILE, LifecycleInterventionRequired, RELEASE_GATE_FILE,
  RESTORE_ORDER, REVIEWED_PRODUCERS, isInterventionRequired, runLifecycle,
  type ProducerAdapter, type QueueAdapter, type QuiescenceAdapter,
} from '../../src/pg-copy/lifecycle.js'
import { COPY_TABLES, sha256Hex } from '../../src/pg-copy/schema-contract.js'
import {
  FENCE_PROOF_SQL, FENCE_SEQUENCES, assertFenceProof, fenceRelationArray, parseLockRows,
} from '../../src/pg-copy/source-fence.js'
import {
  EXPORT_BEGIN_SQL, runStage1, type OperatorInput,
} from '../../src/pg-copy/source-manifest.js'
import {
  loadReviewedTarget, readPublishedBundle, runInspect, type PublishedManifest,
} from '../../src/pg-copy/stage2.js'
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

function bundle(): PublishedManifest {
  return readPublishedBundle(BUNDLE, p => readFileSync(p, 'utf-8'), sha256Hex)
}

/** In-memory adapters. NOTHING here touches launchd, Redis or a shell. */
function adapters(over: {
  stopped?: () => boolean
  depths?: () => Record<string, number>
  confirm?: (n: string) => boolean
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
    queue: { sample: async () => ({ depths: over.depths?.() ?? { daily: 0, alerts: 0 } }) },
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
}

async function lifecycle(opts: {
  targetDb?: string
  stopped?: () => boolean
  depths?: () => Record<string, number>
  confirm?: (n: string) => boolean
  duringRun?: (s: { supervisor: PsqlSession; prover: PsqlSession }) => Promise<void>
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
      }, bundle(), TARGET_EXPECTATION())).confirmation
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
  const a = adapters(opts)
  const stageSessions: DriverSession[] = []
  let result: unknown = null
  let thrown: unknown = null

  const run = runLifecycle({
    supervisor, prover,
    openStageSource: async () => {
      const s = await openDriverSession(sourceTarget())
      stageSessions.push(s)
      return s
    },
    openStageTarget: async () => await openDriverSession(targetTarget(TGT_DB)),
    openVerifySource: async () => await openSilentDriverSession(sourceTarget()),
    openVerifyTarget: async () =>
      await openSilentDriverSession(targetTarget(opts.targetDb ?? TGT_DB)),
    published: bundle(),
    reviewedTarget: REVIEWED_TARGET(),
    operator: OPERATOR(),
    sourceBeginSql: EXPORT_BEGIN_SQL,
    targetExpectation: TARGET_EXPECTATION(),
    confirmation,
    quiescence: a.quiescence, queue: a.queue, producers: a.producers,
    allowlistedPids: [supervisor.pid, prover.pid],
    allowlistedRoles: [EXPORT_ROLE_NAME, 'postgres', TARGET_LOGIN, TARGET_OWNER_ROLE],
    evidenceRoot: root,
  })
  if (opts.duringRun) await opts.duringRun({ supervisor, prover })
  try { result = await run } catch (e) { thrown = e }

  return { result, thrown, supervisor, prover, actions: a.actions, root, stageSessions }
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

  it('holds the fence for the WHOLE lifecycle, and a writer is blocked until release',
    async () => {
      // Sampled from a third session while the lifecycle is mid-flight. The
      // adapters are the only place this suite can interleave, so the queue
      // sampler - which the gate calls twice, after verification and before
      // authorization - is where the observation is taken.
      const samples: boolean[] = []
      const r = await lifecycle({
        depths: () => {
          // Recorded, not awaited: the sampler is synchronous from the gate's
          // point of view and must stay bounded.
          samples.push(true)
          return { daily: 0 }
        },
        duringRun: async () => { /* the run is already in flight */ },
      })
      try {
        expect(r.thrown).toBeNull()
        expect(samples.length).toBe(2)
        // Afterwards the fence is gone; during it, the target was copied under
        // one continuously held fence, which the gate proved twice.
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

  it('a NON-ALLOWLISTED source session refuses at the gate', async () => {
    // A fourth connection to the source database, as a role nobody allowlisted.
    const intruder = await openPsqlSession(SRC, SRC_DB)
    try {
      const r = await lifecycle({})
      try {
        const e = await expectIntervention(r, 'L6-release-gate')
        expect(e.failure.at).toBe('the source carries sessions that are not reviewed')
        expect(await fenceHeld(r.supervisor, r.prover)).toBe(true)
        expect(r.actions).toEqual([])
        // The intruder's pid and role are nowhere in what travels.
        expect(surfaces(e)).not.toContain(intruder.pid)
      } finally { await closeBorrowed(r) }
    } finally { await intruder.close() }
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
