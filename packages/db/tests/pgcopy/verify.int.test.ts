// THE INDEPENDENT VERIFIER AGAINST TWO LIVE PostgreSQL 17 CLUSTERS.
//
// A genuine CURRENT_V10 source and a separate CURRENT_V19 target, copied by the
// reviewed Stage 2, and then measured again by an implementation that shares no
// content code with it. What is proved here and nowhere else:
//
//   THAT THE TWO IMPLEMENTATIONS AGREE ON REAL BYTES. A digest algorithm that
//   only ever compares itself with itself proves nothing; the cross-check below
//   runs the copier's derivation and the verifier's over the SAME database and
//   requires the same value.
//
//   THAT THEY BOTH REFUSE TO NORMALISE. 1.10 and 1.1 are equal under `=` and are
//   different values. Two databases identical except for that one numeric must
//   produce different frames, different batch digests, different table digests
//   and different roots - in BOTH implementations - and the verifier must say so.
//
//   THAT THE FENCE OUTLIVES THE VERIFICATION. The supervisor is never closed,
//   the locks are never released, and a writer that arrives during verification
//   is still blocked when it ends.

import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { inspect } from 'node:util'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { DIGEST_FILE, newRunId } from '../../src/pg-copy/evidence.js'
import { EXPORT_ROLE_NAME } from '../../src/pg-copy/export-role.js'
import {
  openDriverSession, openSilentDriverSession, reviewedClientFactory,
  type DriverSession, type DriverTarget,
} from '../../src/pg-copy/driver-session.js'
import type { Client } from 'pg'
import { COPY_TABLES, SOURCE_V10_PROFILE, extractContractFromSession, sha256Hex }
  from '../../src/pg-copy/schema-contract.js'
import {
  FENCE_PROOF_SQL, FENCE_SEQUENCES, assertFenceProof, fenceRelationArray, parseLockRows,
} from '../../src/pg-copy/source-fence.js'
import {
  EXPORT_BEGIN_SQL, hashAllTables, runStage1, typeContractFrom, type OperatorInput,
} from '../../src/pg-copy/source-manifest.js'
import { rootDigest } from '../../src/pg-copy/canonical.js'
import {
  loadReviewedTarget, readPublishedBundle, runApply, runInspect, type PublishedManifest,
} from '../../src/pg-copy/stage2.js'
import { TARGET_OWNER_ROLE } from '../../src/pg-copy/target-authority.js'
import {
  PostCommitVerificationFailed, VERIFICATION_CONTENT_FILE, VERIFICATION_FILE,
  runVerification, type VerifierHandoff,
} from '../../src/pg-copy/verify.js'
import { verifyAllTables, verifyTable, verifyVectorFrom }
  from '../../src/pg-copy/verify-content.js'
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
/** Two V19 databases, identical but for ONE numeric's stored scale. */
const SCALE_A_DB = 'ai_capital_scale_a'
const SCALE_B_DB = 'ai_capital_scale_b'
const TARGET_LOGIN = 'ai_capital_migrator'
const TARGET_PASSWORD = 'verify_target_pw_0123456789'

let SRC: DisposableCluster
let TGT: DisposableCluster
let ROLE: ProvisionedExportRole
let SRC_SYSID = ''
let TGT_SYSID = ''
let BUNDLE = ''
const ROOTS: string[] = []

function evidenceRoot(): string {
  const r = mkdtempSync(join(tmpdir(), 'pgcopy-verify-ev-'))
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

/** `<price>` is the ONE thing the two scale fixtures disagree about. */
const SEED = (price: string): readonly string[] => Object.freeze([
  `INSERT INTO capital.watchlist (ticker, company, themes, added_at, news_search_terms, cik)
     VALUES ('AAA', 'Alpha Corp', 'x', TIMESTAMPTZ '2026-01-01 00:00:00+00', 'alpha', NULL),
            ('BBB', 'Beta Corp',  'y', TIMESTAMPTZ '2026-01-02 00:00:00+00', 'beta',  ''),
            ('CCC', 'Gamma Corp', 'z', TIMESTAMPTZ '2026-01-03 00:00:00+00', 'gamma', '0002')`,
  `INSERT INTO portfolio.trade_log (trade_date, ticker, action, shares, price)
     VALUES (DATE '2026-01-01', 'AAA', 'buy', 10, ${price}),
            (DATE '2026-01-02', 'BBB', 'buy', 20.000, 2.500)`,
  `INSERT INTO portfolio.positions (ticker, company, shares, avg_cost, updated_at)
     VALUES ('AAA', 'Alpha Corp', 10.50, 1.10, TIMESTAMPTZ '2026-01-01 00:00:00+00')`,
  `INSERT INTO briefing.predictions (date, regime, confidence, scenarios, actions)
     VALUES (DATE '2026-01-01', 'risk-on', 'high',
             '{"a":[1,2,{"b":null}],"z":"\\u00e9"}'::pg_catalog.jsonb,
             '[]'::pg_catalog.jsonb)`,
  `INSERT INTO briefing.qa (date, asked_at, mode, exchanges)
     VALUES (DATE '2026-01-02', TIMESTAMPTZ '2026-01-02 09:00:00+00', 'probe',
             '{"turns":[{"q":"why","a":"because"}]}'::pg_catalog.jsonb)`,
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

/** Seed a V19 database as the OWNER, which is who the tables belong to. */
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

/**
 * Freeze every `DEFAULT now()` timestamp in the copy set to one instant.
 *
 * The two scale fixtures are seeded a few milliseconds apart, so any column
 * that took its value from `now()` differs between them - and a fixture whose
 * tables all differ would prove nothing about the ONE numeric this pair exists
 * to isolate. Discovered from the catalogue rather than listed, so a new
 * defaulted column cannot quietly reintroduce the noise.
 */
async function freezeVolatileDefaults(c: DisposableCluster, db: string): Promise<void> {
  const s = await openPsqlSession(c, db)
  try {
    const set = `'{${COPY_TABLES.map(q => `"${q}"`).join(',')}}'::pg_catalog.text[]`
    const rows = await s.must(`
      SELECT n.nspname || '.' || r.relname, a.attname
        FROM pg_catalog.pg_attrdef d
        JOIN pg_catalog.pg_class     r ON r.oid = d.adrelid
        JOIN pg_catalog.pg_namespace n ON n.oid = r.relnamespace
        JOIN pg_catalog.pg_attribute a ON a.attrelid = r.oid AND a.attnum = d.adnum
        JOIN pg_catalog.pg_type      t ON t.oid = a.atttypid
       WHERE t.typname = 'timestamptz'
         AND pg_catalog.pg_get_expr(d.adbin, d.adrelid) LIKE '%now()%'
         AND n.nspname || '.' || r.relname = ANY (${set})
       ORDER BY 1, 2`)
    expect(rows.length).toBeGreaterThan(0)
    await s.must('BEGIN')
    await s.must(`SET LOCAL ROLE ${TARGET_OWNER_ROLE}`)
    for (const [qname, column] of rows) {
      await s.must(
        `UPDATE ${qname} SET "${column}" = TIMESTAMPTZ '2026-01-01 00:00:00+00'`)
    }
    await s.must('COMMIT')
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
  expectedTargetLabel: 'verify-target',
  expectedSystemIdentifier: SRC_SYSID,
  sourceLabel: 'verify-source',
  requestedEndpoint: SRC.socketDir,
  sourcePort: String(SRC.port),
  sourceDatabase: SRC_DB,
})

const TARGET_EXPECTATION = (): {
  systemIdentifier: string; database: string; port: string; role: string; endpoint: string
} => ({
  systemIdentifier: TGT_SYSID,
  database: TGT_DB,
  port: String(TGT.port),
  role: TARGET_LOGIN,
  endpoint: TGT.socketDir,
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
  // THE TWO SCALE FIXTURES: identical reviewed schemas, identical rows, one
  // NUMERIC stored at a different scale. Built on the target cluster so they
  // share its roles and its `vector` installation.
  await buildV19Database(TGT, SCALE_A_DB)
  await buildV19Database(TGT, SCALE_B_DB)
  await seedAsOwner(TGT, SCALE_A_DB, '1.10')
  await seedAsOwner(TGT, SCALE_B_DB, '1.1')
  for (const db of [SCALE_A_DB, SCALE_B_DB]) await freezeVolatileDefaults(TGT, db)
  for (const db of [TGT_DB, SCALE_A_DB, SCALE_B_DB]) {
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

async function openSourceDriver(): Promise<DriverSession> {
  const cred = readPublishedCredential(ROLE.credentialPath)
  return await openDriverSession({
    host: cred.host, port: Number(cred.port), database: cred.database,
    user: cred.user, password: cred.password,
  })
}

const openTargetDriver = async (db: string = TGT_DB): Promise<DriverSession> =>
  await openDriverSession({
    host: TGT.socketDir, port: TGT.port, database: db,
    user: TARGET_LOGIN, password: TARGET_PASSWORD,
  })

const REVIEWED_TARGET = (): ReturnType<typeof loadReviewedTarget> => loadReviewedTarget(
  join(process.cwd(), 'contracts', 'expected-target-v19.json'), p => readFileSync(p, 'utf-8'))

function bundle(): PublishedManifest {
  return readPublishedBundle(BUNDLE, p => readFileSync(p, 'utf-8'), sha256Hex)
}

/**
 * Every statement a session was asked for, recorded AT THE CLIENT.
 *
 * WHY NOT AROUND THE SESSION. A recorder wrapped around an already-opened
 * `DriverSession` is attached after the opener has finished, and therefore
 * cannot see anything the opener itself issued. That is not hypothetical: the
 * reviewed Stage-2 opener asks the server for its backend pid before returning,
 * and the first version of this suite asserted "BEGIN is the first statement"
 * while a `SELECT pg_backend_pid()` had already run in its own implicit
 * transaction, unseen. The seam is therefore the CLIENT FACTORY, which is the
 * last point before any byte reaches PostgreSQL.
 */
interface Recorded {
  readonly sql: string[]
  /** How many statements had been issued by the time the session was handed back. */
  atOpen: number
  session: DriverSession | null
}

const newRecorded = (): Recorded => ({ sql: [], atOpen: -1, session: null })

function recordingFactory(into: string[]): (t: DriverTarget) => Client {
  return (t: DriverTarget): Client => {
    const client = reviewedClientFactory(t)
    return new Proxy(client, {
      get(target, prop) {
        if (prop === 'query') {
          return (cfg: unknown, ...rest: unknown[]) => {
            into.push(typeof cfg === 'string'
              ? cfg : String((cfg as { text?: unknown }).text))
            return (target.query as (...a: unknown[]) => unknown).call(target, cfg, ...rest)
          }
        }
        const value = Reflect.get(target, prop, target)
        return typeof value === 'function' ? value.bind(target) : value
      },
    }) as Client
  }
}

/** Open a verifier session with the recorder attached BEFORE connect. */
async function openRecorded(
  target: DriverTarget, rec: Recorded,
): Promise<DriverSession> {
  const s = await openSilentDriverSession(target, recordingFactory(rec.sql))
  rec.atOpen = rec.sql.length
  rec.session = s
  return s
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

/**
 * A complete lifecycle: copy, then verify, with the caller holding the fence
 * across both - which is the only arrangement the verifier is allowed to run in.
 */
async function copyThenVerify(opts: {
  targetDb?: string
  evidence?: string
  mutateHandoff?: (h: VerifierHandoff) => VerifierHandoff
  killSupervisorBeforeVerify?: boolean
  duringVerification?: () => Promise<void>
}): Promise<{
  result: unknown
  thrown: unknown
  supervisor: PsqlSession
  prover: PsqlSession
  sourceStatements: Recorded[]
  targetStatements: Recorded[]
  handoff: VerifierHandoff
  evidenceRoot: string
}> {
  await resetTarget()
  const root = opts.evidence ?? evidenceRoot()

  const confirmation = await (async () => {
    const sup = await openPsqlSession(SRC, SRC_DB)
    const prv = await openPsqlSession(SRC, SRC_DB)
    const src = await openSourceDriver()
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
  const source = await openSourceDriver()
  const sourceStatements: Recorded[] = []
  const targetStatements: Recorded[] = []
  let result: unknown = null
  let thrown: unknown = null
  let handoff: VerifierHandoff | null = null
  try {
    const applied = await runApply({
      supervisor, prover, source, operator: OPERATOR(),
      sourceBeginSql: EXPORT_BEGIN_SQL, reviewedTarget: REVIEWED_TARGET(),
      targetExpectation: TARGET_EXPECTATION(), confirmation,
      openTarget: async () => await openTargetDriver(),
    }, bundle())
    handoff = opts.mutateHandoff
      ? opts.mutateHandoff(applied.verification)
      : applied.verification

    if (opts.killSupervisorBeforeVerify) await supervisor.close()
    if (opts.duringVerification) await opts.duringVerification()

    try {
      result = await runVerification({
        handoff,
        publishedDocument: bundle().document,
        supervisor,
        prover,
        openSource: async () => {
          const r = newRecorded()
          sourceStatements.push(r)
          return await openRecorded(sourceTarget(), r)
        },
        openTarget: async () => {
          const r = newRecorded()
          targetStatements.push(r)
          return await openRecorded(targetTarget(opts.targetDb ?? TGT_DB), r)
        },
        reviewedTarget: REVIEWED_TARGET(),
        evidenceRoot: root,
      })
    } catch (e) { thrown = e }
  } finally {
    try { await source.rows('ROLLBACK') } catch { /* bounded */ }
    await source.end()
  }
  return {
    result, thrown, supervisor, prover, sourceStatements, targetStatements,
    handoff: handoff!, evidenceRoot: root,
  }
}

/** The caller's explicit release. Nothing inside the verifier does this. */
async function release(supervisor: PsqlSession, prover: PsqlSession): Promise<void> {
  await prover.close()
  try { await supervisor.send('ROLLBACK') } catch { /* bounded */ }
  await supervisor.close()
}

/** The whole fence, proved from the prover, right now. */
async function fenceStillHeld(supervisor: PsqlSession, prover: PsqlSession): Promise<boolean> {
  try {
    const locks = parseLockRows(
      await prover.must(FENCE_PROOF_SQL.replace('$1', fenceRelationArray())))
    assertFenceProof(locks, { supervisorPid: supervisor.pid, provingPid: prover.pid })
    return true
  } catch { return false }
}

describe('a committed copy, independently verified', () => {
  it('PASSES, matches all 21 tables and 3 sequences, and publishes evidence', async () => {
    const r = await copyThenVerify({})
    try {
      expect(r.thrown).toBeNull()
      const v = r.result as Awaited<ReturnType<typeof runVerification>>
      expect(v.outcome).toBe('PASS')
      expect(v.tables.length).toBe(21)
      expect(v.tables.map(t => t.qname)).toEqual([...COPY_TABLES])
      for (const t of v.tables) expect(t.sourceDigest).toBe(t.targetDigest)
      expect(v.sequences.length).toBe(3)
      for (const s of v.sequences) {
        expect(s.sourceEffectiveNext).toBe(s.targetEffectiveNext)
      }
      expect(v.sourceRootDigest).toBe(v.targetRootDigest)
      expect(v.sourceRootDigest).toBe(r.handoff.rootDigest)
      // Some table actually carried rows; a suite that verified 21 empty
      // tables would pass and prove nothing.
      expect(v.tables.reduce((n, t) => n + t.rows, 0)).toBeGreaterThan(0)

      // THE FENCE OUTLIVED THE VERIFICATION, and the supervisor is alive.
      expect(r.supervisor.alive()).toBe(true)
      expect(await fenceStillHeld(r.supervisor, r.prover)).toBe(true)
      expect(v.fenceBefore.ungranted).toBe(0)
      expect(v.fenceAfter.ungranted).toBe(0)
      expect(v.fenceBefore.provingPid).not.toBe(v.fenceBefore.supervisorPid)

      // THE EVIDENCE: published, frozen, digested, and saying PASS.
      const name = v.evidence.finalPath.split('/').pop() ?? ''
      expect(name).toMatch(/^verification-\d{8}T\d{6}Z-[0-9a-f]{8}$/)
      expect([...v.evidence.files].sort())
        .toEqual([DIGEST_FILE, VERIFICATION_CONTENT_FILE, VERIFICATION_FILE].sort())
      expect(statSync(v.evidence.finalPath).mode & 0o777).toBe(0o500)
      for (const f of v.evidence.files) {
        expect(statSync(join(v.evidence.finalPath, f)).mode & 0o777).toBe(0o400)
      }
      const doc = JSON.parse(readFileSync(join(v.evidence.finalPath, VERIFICATION_FILE), 'utf-8'))
      expect(doc.outcome).toBe('PASS')
      expect(doc.complete).toBe(true)
      expect(doc.failure).toBeNull()
      expect(doc.tables.length).toBe(21)
      expect(doc.sequences.length).toBe(3)
      expect(doc.source.recognition).toBe('CURRENT_V10')
      expect(doc.target.recognition).toBe('CURRENT_V19')
      expect(doc.fence.before.ungranted).toBe(0)
      expect(doc.fence.after.ungranted).toBe(0)
      // NO CREDENTIAL COMPONENT, anywhere in the bundle.
      const allBytes = v.evidence.files
        .map(f => readFileSync(join(v.evidence.finalPath, f), 'utf-8')).join('\n')
      for (const marker of [TARGET_PASSWORD, TGT.socketDir, SRC.socketDir, 'password',
                            'passfile', String(TGT.port), '.pgpass']) {
        expect(allBytes).not.toContain(marker)
      }
      // The temporary directory is gone, exactly once renamed.
      expect(readdirSync(r.evidenceRoot).filter(n => n.startsWith('.tmp-'))).toEqual([])
    } finally { await release(r.supervisor, r.prover) }
  }, 1_800_000)

  it('opens FRESH sessions that issue NO SQL before BEGIN', async () => {
    const r = await copyThenVerify({})
    try {
      expect(r.thrown).toBeNull()
      expect(r.sourceStatements.length).toBe(1)
      expect(r.targetStatements.length).toBe(1)
      for (const [side, rec] of
           [['source', r.sourceStatements[0]], ['target', r.targetStatements[0]]] as const) {
        // CONNECT ISSUED NOTHING. Recorded at the client, so an opener that
        // asked the server anything at all would show up here.
        expect(rec.atOpen, side).toBe(0)
        // BEGIN IS STATEMENT 1, and identity is statement 2.
        expect(rec.sql[0], side)
          .toBe('BEGIN TRANSACTION READ ONLY ISOLATION LEVEL REPEATABLE READ')
        expect(rec.sql[1], side).toContain('CURRENT_USER')
        expect(rec.sql[1], side).toContain("current_setting('transaction_read_only')")
        // ROLLBACK IS THE LAST THING THE VERIFIER OWNS.
        expect(rec.sql[rec.sql.length - 1], side).toBe('ROLLBACK')
        expect(rec.sql.filter(q => q === 'ROLLBACK').length, side).toBe(1)
        // And the session it owned is closed.
        expect(rec.session?.alive(), side).toBe(false)
        // NO SELECT *, and nothing that would write.
        for (const sql of rec.sql) {
          expect(sql, side).not.toMatch(/SELECT\s+\*/i)
          expect(sql, side)
            .not.toMatch(/^\s*(INSERT|UPDATE|DELETE|TRUNCATE|ALTER|DROP|CREATE)\b/i)
        }
      }
      // THE TARGET ASSUMES THE OWNER ROLE ONLY AFTER ITS IDENTITY IS TAKEN.
      const t = r.targetStatements[0].sql
      const role = t.findIndex(q => q.startsWith('SET LOCAL ROLE'))
      expect(role).toBe(2)
      expect(t.findIndex(q => q.includes('CURRENT_USER'))).toBeLessThan(role)
      // The protocol pid the opener used is the one the server confirmed.
      expect(r.targetStatements[0].session?.pid).toMatch(/^\d+$/)
      // THE BORROWED SESSIONS ARE UNTOUCHED.
      expect(r.supervisor.alive()).toBe(true)
    } finally { await release(r.supervisor, r.prover) }
  }, 1_800_000)

  it('a FAILURE closes only the verifier-owned sessions', async () => {
    const r = await copyThenVerify({
      targetDb: SCALE_B_DB,
      mutateHandoff: h => ({ ...h, target: { ...h.target, database: SCALE_B_DB } }),
    })
    try {
      expect(r.thrown).toBeInstanceOf(PostCommitVerificationFailed)
      for (const rec of [...r.sourceStatements, ...r.targetStatements]) {
        expect(rec.session?.alive()).toBe(false)
        expect(rec.sql[rec.sql.length - 1]).toBe('ROLLBACK')
      }
      // The caller's supervisor and prover are still open and still usable.
      expect(r.supervisor.alive()).toBe(true)
      expect((await r.prover.must('SELECT 1'))[0][0]).toBe('1')
    } finally { await release(r.supervisor, r.prover) }
  }, 1_800_000)

  it('a WRITER and a NEXTVAL stay blocked for the whole verification', async () => {
    const r = await copyThenVerify({
      duringVerification: async () => {
        // Arrives BEFORE the verification and is still queued after it. It is
        // never allowed to commit, so the source it measured never changed.
        const w = await openPsqlSession(SRC, SRC_DB)
        await w.send("SET lock_timeout = '750ms'")
        const ins = await w.send(
          `INSERT INTO graph.nodes (ticker, company, themes) VALUES ('ZZZ', 'Z', 'z')`)
        expect(ins.error).not.toBeNull()
        const nx = await w.send(`SELECT pg_catalog.nextval('portfolio.trade_log_id_seq')`)
        expect(nx.error).not.toBeNull()
        await w.close()
      },
    })
    try {
      expect(r.thrown).toBeNull()
      expect((r.result as { outcome: string }).outcome).toBe('PASS')
      // The source still holds exactly what it held: no ZZZ node arrived.
      const s = await openPsqlSession(SRC, SRC_DB)
      try {
        const n = await s.must(
          `SELECT pg_catalog.count(*)::pg_catalog.text FROM graph.nodes WHERE ticker = 'ZZZ'`)
        expect(n[0][0]).toBe('0')
      } finally { await s.close() }
    } finally { await release(r.supervisor, r.prover) }
  }, 1_800_000)

  it('a DEAD SUPERVISOR refuses before anything is read', async () => {
    const r = await copyThenVerify({ killSupervisorBeforeVerify: true })
    try {
      expect(r.thrown).toBeInstanceOf(PostCommitVerificationFailed)
      const e = r.thrown as PostCommitVerificationFailed
      expect(e.phase).toBe('V2-supervisor')
      // NOTHING was opened; the failure costs no session.
      expect(r.sourceStatements.length).toBe(0)
      expect(r.targetStatements.length).toBe(0)
      expect(e.message).toContain('NOT verified')
      // AND IT DOES NOT CLAIM THE FENCE IS HELD. The supervisor is gone; its
      // transaction went with it, and saying otherwise is how producers get
      // restarted against a live source.
      expect(e.fence).toBe('unproved')
      expect(e.message).toContain('UNPROVED')
      expect(e.message).toContain('MUTABLE')
      expect(e.message).not.toContain('still held')
    } finally { await r.prover.close() }
  }, 1_800_000)
})

describe('numeric scale, across two databases', () => {
  /** Measure one database with the INDEPENDENT implementation. */
  async function measureIndependently(db: string): Promise<{
    root: string; digests: Record<string, string>
    batches: Record<string, Array<{ rows: number; bytes: number; digest: string }>>
  }> {
    const t = await openTargetDriver(db)
    try {
      await t.rows(EXPORT_BEGIN_SQL)
      await t.rows(`SET LOCAL ROLE ${TARGET_OWNER_ROLE}`)
      const src = await openSourceDriver()
      let contract
      try {
        await src.rows(EXPORT_BEGIN_SQL)
        contract = await extractContractFromSession(src, src.pid, SOURCE_V10_PROFILE)
        await src.rows('ROLLBACK')
      } finally { await src.end() }
      const measured = await verifyAllTables(t, contract, verifyVectorFrom(contract))
      await t.rows('ROLLBACK')
      const digests: Record<string, string> = {}
      const batches: Record<string, Array<{ rows: number; bytes: number; digest: string }>> = {}
      for (const x of measured.tables) {
        digests[x.qname] = x.digest
        batches[x.qname] = x.batches.map(b => ({ rows: b.rows, bytes: b.bytes, digest: b.digest }))
      }
      return { root: measured.rootDigest, digests, batches }
    } finally { await t.end() }
  }

  it('1.10 and 1.1 produce different FRAMES, batch digests, table digests and roots',
    async () => {
      // 1. THE RAW FRAMES. `numeric_send` encodes the stored display scale in
      //    its header, so the two values produce DIFFERENT BYTES at the SAME
      //    LENGTH: both carry one digit group, and only the dscale field
      //    differs. Nothing here trims it. A comparison that looked at sizes
      //    rather than bytes would see nothing at all.
      const s = await openPsqlSession(TGT, SCALE_A_DB)
      try {
        const frames = await s.must(
          `SELECT pg_catalog.encode(pg_catalog.numeric_send(1.10::pg_catalog.numeric), 'hex'),
                  pg_catalog.encode(pg_catalog.numeric_send(1.1::pg_catalog.numeric), 'hex'),
                  (1.10::pg_catalog.numeric = 1.1::pg_catalog.numeric)::pg_catalog.text`)
        expect(frames[0][0]).not.toBe(frames[0][1])
        // Equal under `=`, different as values. That is the whole point.
        expect(frames[0][2]).toBe('true')
      } finally { await s.close() }

      const a = await measureIndependently(SCALE_A_DB)
      const b = await measureIndependently(SCALE_B_DB)

      // 2. BATCH DIGESTS differ, for the one table that holds the value.
      expect(a.batches['portfolio.trade_log'][0].digest)
        .not.toBe(b.batches['portfolio.trade_log'][0].digest)
      // The BYTE COUNTS are equal, and that is the point: `numeric_send`
      // encodes the same digit groups for both and differs only in the stored
      // display scale, so a length comparison would never have seen this. Only
      // the digest does.
      expect(a.batches['portfolio.trade_log'][0].bytes)
        .toBe(b.batches['portfolio.trade_log'][0].bytes)
      // 3. TABLE DIGESTS differ.
      expect(a.digests['portfolio.trade_log']).not.toBe(b.digests['portfolio.trade_log'])
      // 4. ROOTS differ.
      expect(a.root).not.toBe(b.root)
      // And ONLY that table moved: the fixtures are otherwise identical, so a
      // difference anywhere else would mean this proves something else.
      for (const q of COPY_TABLES) {
        if (q === 'portfolio.trade_log') continue
        expect(a.digests[q], q).toBe(b.digests[q])
      }
    }, 1_800_000)

  it('a NULL and an EMPTY STRING digest differently', async () => {
    // The frame tags NULL as one byte and an empty string as a tag plus a
    // ZERO LENGTH, so the two can never collide. Proved on real rows: the
    // watchlist fixture holds a NULL `cik`, an empty one and a non-empty one.
    const src = await openSourceDriver()
    let contract
    try {
      await src.rows(EXPORT_BEGIN_SQL)
      contract = await extractContractFromSession(src, src.pid, SOURCE_V10_PROFILE)
      await src.rows('ROLLBACK')
    } finally { await src.end() }

    const t = await openTargetDriver(SCALE_A_DB)
    try {
      const measure = async (): Promise<string> =>
        (await verifyTable(t, contract, 'capital.watchlist', verifyVectorFrom(contract))).digest
      await t.rows('BEGIN')
      await t.rows(`SET LOCAL ROLE ${TARGET_OWNER_ROLE}`)
      const withNull = await measure()
      // NULL -> ''. Under `IS NOT DISTINCT FROM` these are different; under a
      // naive delimiter-joined digest they would not be.
      await t.rows(`UPDATE capital.watchlist SET cik = '' WHERE ticker = 'AAA'`)
      const withEmpty = await measure()
      expect(withEmpty).not.toBe(withNull)
      // And back again, exactly.
      await t.rows(`UPDATE capital.watchlist SET cik = NULL WHERE ticker = 'AAA'`)
      expect(await measure()).toBe(withNull)
      await t.rows('ROLLBACK')
    } finally { await t.end() }
  }, 1_800_000)

  it('the COPIER and the VERIFIER agree, byte for byte, on both fixtures', async () => {
    // THE CROSS-CHECK. Two implementations, one database, one value. A
    // normalisation in EITHER of them shows up here as a disagreement - which
    // is the only way a self-consistent mistake can ever be seen.
    for (const db of [SCALE_A_DB, SCALE_B_DB]) {
      const src = await openSourceDriver()
      let contract
      try {
        await src.rows(EXPORT_BEGIN_SQL)
        contract = await extractContractFromSession(src, src.pid, SOURCE_V10_PROFILE)
        await src.rows('ROLLBACK')
      } finally { await src.end() }

      const t = await openTargetDriver(db)
      try {
        await t.rows(EXPORT_BEGIN_SQL)
        await t.rows(`SET LOCAL ROLE ${TARGET_OWNER_ROLE}`)
        const copier = await hashAllTables(t, contract, typeContractFrom(contract))
        const verifier = await verifyAllTables(t, contract, verifyVectorFrom(contract))
        expect(verifier.tables.length).toBe(copier.length)
        for (let n = 0; n < copier.length; n += 1) {
          expect(verifier.tables[n].qname, db).toBe(copier[n].qname)
          expect(verifier.tables[n].rows, `${db} ${copier[n].qname} rows`).toBe(copier[n].rows)
          expect(verifier.tables[n].bytes, `${db} ${copier[n].qname} bytes`).toBe(copier[n].bytes)
          expect(verifier.tables[n].digest, `${db} ${copier[n].qname}`).toBe(copier[n].digest)
        }
        expect(verifier.rootDigest, db).toBe(rootDigest(
          copier.map(x => ({ schema: x.schema, table: x.table, digest: x.digest }))))
        await t.rows('ROLLBACK')
      } finally { await t.end() }
    }
  }, 1_800_000)

  it('the VERIFIER reports the mismatch, names the table, and holds the fence', async () => {
    const r = await copyThenVerify({
      targetDb: SCALE_B_DB,
      mutateHandoff: h => ({ ...h, target: { ...h.target, database: SCALE_B_DB } }),
    })
    try {
      expect(r.thrown).toBeInstanceOf(PostCommitVerificationFailed)
      const f = r.thrown as PostCommitVerificationFailed
      expect(f.phase).toBe('V8-content')
      expect(f.reason).toBe('the independently measured content does not match')
      expect(String(f.at)).toContain('portfolio.trade_log')
      // THE FENCE IS PROVED, NOT ASSUMED. The content did not match and the
      // source is still frozen - which is the one case where saying so is
      // true, and it is said only because a proof was taken on the failure path.
      expect(f.fence).toBe('held')
      expect(f.message).toContain('PROVED still held')
      // NAMES A TABLE, AND NOTHING FROM A ROW.
      const text = surfaces(f)
      expect(text).not.toContain('1.10')
      expect(text).not.toContain('Alpha Corp')
      expect(text).not.toContain(TARGET_PASSWORD)

      // THE REAL TARGET IS UNTOUCHED and the fence is still held.
      expect(await fenceStillHeld(r.supervisor, r.prover)).toBe(true)
      const tgt = await openPsqlSession(TGT, TGT_DB)
      try {
        const n = await tgt.must(
          'SELECT pg_catalog.count(*)::pg_catalog.text FROM portfolio.trade_log')
        expect(n[0][0]).toBe('2')
      } finally { await tgt.close() }

      // AND THE EVIDENCE SAYS FAIL. Complete, published, and never PASS.
      const published = readdirSync(r.evidenceRoot).filter(n => n.startsWith('verification-'))
      expect(published.length).toBe(1)
      const doc = JSON.parse(
        readFileSync(join(r.evidenceRoot, published[0], VERIFICATION_FILE), 'utf-8'))
      expect(doc.outcome).toBe('FAIL')
      expect(doc.complete).toBe(true)
      expect(doc.failure.phase).toBe('V8-content')
      expect(String(doc.failure.at)).toContain('portfolio.trade_log')
      expect(doc.fence.disposition).toBe('held')
      expect(doc.fence.after_proved_by).toBe('failure-path')
      expect(doc.fence.after.ungranted).toBe(0)
    } finally { await release(r.supervisor, r.prover) }
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
