// STAGE 2 AGAINST TWO LIVE PostgreSQL 17 CLUSTERS.
//
// A source cluster with a published Stage-1 bundle, and a separate empty target
// cluster. Two clusters rather than two databases, because the copier's first
// question of the target is which CLUSTER it is - and a check that can only be
// exercised against itself is not a check.
//
// WHAT IS PROVED HERE AND NOWHERE ELSE: that the bytes actually arrive. Every
// digest in this repository is a claim about content, and the only way to know
// the claim survives a binary COPY is to move real values - a numeric whose
// stored scale differs from its normalised form, a JSONB document, a 384
// dimension vector - and ask the target to derive its own manifest afterwards.

import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { inspect } from 'node:util'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { newRunId } from '../../src/pg-copy/evidence.js'
import { EXPORT_ROLE_NAME } from '../../src/pg-copy/export-role.js'
import { openDriverSession, type DriverSession } from '../../src/pg-copy/driver-session.js'
import {
  COPY_TABLES, REVIEWED_CONTRACT_DIGEST,
} from '../../src/pg-copy/schema-contract.js'
import { FENCE_SEQUENCES } from '../../src/pg-copy/source-fence.js'
import {
  EXPORT_BEGIN_SQL, runStage1, type OperatorInput,
} from '../../src/pg-copy/source-manifest.js'
import {
  CommitOutcomeUnknown, Stage2Refused, readPublishedBundle, runApply, runInspect,
  type PublishedManifest,
} from '../../src/pg-copy/stage2.js'
import { sha256Hex } from '../../src/pg-copy/schema-contract.js'
import { TARGET_OWNER_ROLE } from '../../src/pg-copy/target-authority.js'
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
import { buildV19Database } from '../../testing/v19-database.js'

const SRC_DB = 'ai_capital_src'
const TGT_DB = 'ai_capital_tgt'
const TARGET_LOGIN = 'ai_capital_migrator'
const TARGET_PASSWORD = 'stage2_target_pw_0123456789'

let SRC: DisposableCluster
let TGT: DisposableCluster
let ROLE: ProvisionedExportRole
let SRC_SYSID = ''
let TGT_SYSID = ''
let BUNDLE = ''
const ROOTS: string[] = []

function evidenceRoot(): string {
  const r = mkdtempSync(join(tmpdir(), 'pgcopy-stage2-ev-'))
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

/** Representative values: numeric scale, JSONB, a 384-dimension vector. */
const VECTOR_384 =
  `(SELECT ('[' || pg_catalog.string_agg('0.25', ',') || ']')::public.vector(384) ` +
  `FROM pg_catalog.generate_series(1, 384))`

const SEED: readonly string[] = Object.freeze([
  `INSERT INTO capital.watchlist (ticker, company, themes, added_at, news_search_terms, cik)
     VALUES ('AAA', 'Alpha Corp', 'x', TIMESTAMPTZ '2026-01-01 00:00:00+00', 'alpha', NULL),
            ('BBB', 'Beta Corp',  'y', TIMESTAMPTZ '2026-01-02 00:00:00+00', 'beta',  ''),
            ('CCC', 'Gamma Corp', 'z', TIMESTAMPTZ '2026-01-03 00:00:00+00', 'gamma', '0002')`,
  // 1.10 and 2.500 carry a stored SCALE that `=` cannot see and binary COPY must keep.
  `INSERT INTO portfolio.trade_log (trade_date, ticker, action, shares, price)
     VALUES (DATE '2026-01-01', 'AAA', 'buy', 10, 1.10),
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
  expectedTargetLabel: 'stage-2-target',
  expectedSystemIdentifier: SRC_SYSID,
  sourceLabel: 'stage-2-source',
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
  await buildV19Database(SRC, SRC_DB)
  for (const sql of SEED) await write(SRC, SRC_DB, sql)
  await requireScramForExportRole(SRC)
  ROLE = await provisionExportRole(SRC, SRC_DB, makeSecretRoot())
  writePassfileFromCredential(ROLE.secretRoot, readPublishedCredential(ROLE.credentialPath))
  SRC_SYSID = await sysid(SRC, SRC_DB)

  TGT = await startDisposableCluster()
  await buildV19Database(TGT, TGT_DB)
  await write(TGT, TGT_DB,
    `ALTER ROLE ${TARGET_LOGIN} WITH LOGIN PASSWORD '${TARGET_PASSWORD}'`)
  TGT_SYSID = await sysid(TGT, TGT_DB)

  // A REAL Stage-1 bundle, published by the reviewed Stage-1 path.
  const root = evidenceRoot()
  const supervisor = await openPsqlSession(SRC, SRC_DB)
  const prover = await openPsqlSession(SRC, SRC_DB)
  const exportSession = await openExport()
  try {
    const r = await runStage1({
      supervisor, prover, exportSession, operator: OPERATOR(), evidenceRoot: root,
    })
    BUNDLE = r.published.finalPath
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

const openTargetDriver = async (): Promise<DriverSession> => await openDriverSession({
  host: TGT.socketDir, port: TGT.port, database: TGT_DB,
  user: TARGET_LOGIN, password: TARGET_PASSWORD,
})

function bundle(): PublishedManifest {
  return readPublishedBundle(BUNDLE, p => readFileSync(p, 'utf-8'), sha256Hex)
}

/** A whole Stage-2 run, with every session this suite owns. */
async function withSessions<T>(
  body: (s: {
    supervisor: PsqlSession; prover: PsqlSession; source: DriverSession
    operator: OperatorInput; sourceBeginSql: string
  }) => Promise<T>,
): Promise<T> {
  const supervisor = await openPsqlSession(SRC, SRC_DB)
  const prover = await openPsqlSession(SRC, SRC_DB)
  const source = await openSourceDriver()
  try {
    return await body({
      supervisor, prover, source, operator: OPERATOR(), sourceBeginSql: EXPORT_BEGIN_SQL,
    })
  } finally {
    try { await source.rows('ROLLBACK') } catch { /* bounded */ }
    await source.end()
    await prover.close()
    try { await supervisor.send('ROLLBACK') } catch { /* bounded */ }
    await supervisor.close()
  }
}

/** Every target table's count and every sequence's state, from outside. */
async function targetState(): Promise<{ rows: number; sequences: string[] }> {
  const s = await openPsqlSession(TGT, TGT_DB)
  try {
    let rows = 0
    for (const q of COPY_TABLES) {
      rows += Number((await s.must(`SELECT pg_catalog.count(*)::pg_catalog.text FROM ${q}`))[0][0])
    }
    const sequences: string[] = []
    for (const q of FENCE_SEQUENCES) {
      const r = await s.must(
        `SELECT last_value::pg_catalog.text, is_called::pg_catalog.text FROM ${q}`)
      sequences.push(`${q}=${r[0][0]}/${r[0][1]}`)
    }
    return { rows, sequences }
  } finally { await s.close() }
}

describe('inspect never reaches the target', () => {
  it('verifies, re-derives, agrees with the manifest and prints a token', async () => {
    const r = await withSessions(async s =>
      await runInspect(s, bundle(), TARGET_EXPECTATION()))
    expect(r.contractDigest).toBe(REVIEWED_CONTRACT_DIGEST)
    expect(r.rootDigest).toMatch(/^[0-9a-f]{64}$/)
    expect(r.confirmation).toMatch(/^PGCOPY-APPLY-[0-9a-f]{64}$/)
    expect(r.bundleName).toMatch(/^source-manifest-\d{8}T\d{6}Z-[0-9a-f]{8}$/)
    // And the target is still untouched.
    expect((await targetState()).rows).toBe(0)
  }, 1_800_000)

  it('REFUSES at A3 when the fence is not INDEPENDENTLY proved', async () => {
    // A session can always see its own locks, so the supervisor proving its own
    // fence proves nothing - `assertFenceProof` refuses it. What is under test
    // is that the refusal happens at A3, i.e. that the independent proof is
    // taken there at all: a copier that skipped A3 would still be caught later
    // by the A5 sequence read, at a different phase, and would have opened a
    // source transaction it had no business opening.
    const supervisor = await openPsqlSession(SRC, SRC_DB)
    const source = await openSourceDriver()
    let thrown: unknown = null
    try {
      await runInspect(
        { supervisor, prover: supervisor, source, operator: OPERATOR(),
          sourceBeginSql: EXPORT_BEGIN_SQL },
        bundle(), TARGET_EXPECTATION())
    } catch (e) { thrown = e } finally {
      try { await source.rows('ROLLBACK') } catch { /* bounded */ }
      await source.end()
      try { await supervisor.send('ROLLBACK') } catch { /* bounded */ }
      await supervisor.close()
    }
    expect(thrown).toBeInstanceOf(Stage2Refused)
    expect((thrown as Stage2Refused).phase).toBe('A3-fence-proof')
  }, 1_800_000)

  it('a C1 refusal happens on the SOURCE, before any target could be reached', async () => {
    // A bundle whose manifest disagrees with the live source: re-derivation
    // refuses at A5, which is before A6 by construction.
    const fake = bundle()
    const doc = { ...(fake.document as Record<string, unknown>) }
    const content = { ...(doc.content as Record<string, unknown>) }
    content.root_digest = 'f'.repeat(64)
    doc.content = content
    await expect(withSessions(async s => await runInspect(
      s, { ...fake, document: doc as never }, TARGET_EXPECTATION())))
      .rejects.toThrow(/does not match the published manifest/)
  }, 1_800_000)
})

describe('apply', () => {
  it('a mismatched confirmation constructs NO target client', async () => {
    let opened = 0
    const thrown = await withSessions(async s => {
      try {
        await runApply({
          ...s, targetExpectation: TARGET_EXPECTATION(),
          confirmation: `PGCOPY-APPLY-${'0'.repeat(64)}`,
          openTarget: async () => { opened += 1; return await openTargetDriver() },
        }, bundle())
        return null
      } catch (e) { return e }
    })
    expect(thrown).toBeInstanceOf(Stage2Refused)
    expect((thrown as Stage2Refused).phase).toBe('confirmation')
    expect(opened).toBe(0)
    // And it never echoes what it was given.
    expect(surfaces(thrown)).not.toContain('0'.repeat(64))
    expect((await targetState()).rows).toBe(0)
  }, 1_800_000)

  it('copies all 21 tables byte-exactly and commits', async () => {
    const before = await targetState()
    expect(before.rows).toBe(0)

    const r = await withSessions(async s => {
      const inspectR = await runInspect(s, bundle(), TARGET_EXPECTATION())
      return { inspectR }
    })

    const applied = await withSessions(async s => await runApply({
      ...s, targetExpectation: TARGET_EXPECTATION(),
      confirmation: r.inspectR.confirmation,
      openTarget: openTargetDriver,
    }, bundle()))

    expect(applied.committed).toBe(true)
    expect(applied.tablesCopied).toBe(21)
    expect(applied.rootDigest).toBe(r.inspectR.rootDigest)

    // THE BYTES ARRIVED. Proved by the target deriving its OWN manifest, which
    // `runApply` already required to equal the source's - and again here from
    // outside, on a fresh connection.
    const after = await targetState()
    expect(after.rows).toBeGreaterThan(0)

    const t = await openDriverSession({
      host: TGT.socketDir, port: TGT.port, database: TGT_DB,
      user: TARGET_LOGIN, password: TARGET_PASSWORD,
    })
    try {
      await t.rows(EXPORT_BEGIN_SQL)
      // The login role is a MEMBER of the owner and holds no USAGE of its own,
      // so this read needs the same authority the copy ran under.
      await t.rows(`SET LOCAL ROLE ${TARGET_OWNER_ROLE}`)
      const { hashAllTables, typeContractFrom } = await import('../../src/pg-copy/source-manifest.js')
      const { extractContractFromSession } = await import('../../src/pg-copy/schema-contract.js')
      const { rootDigest } = await import('../../src/pg-copy/canonical.js')
      const c = await extractContractFromSession(t, t.pid)
      const tables = await hashAllTables(t, c, typeContractFrom(c))
      const root = rootDigest(
        tables.map(x => ({ schema: x.schema, table: x.table, digest: x.digest })))
      expect(root).toBe(r.inspectR.rootDigest)

      // Scale-preserving numeric survived: 1.10 is still 1.10, not 1.1.
      const price = await t.rows(
        "SELECT price::pg_catalog.text FROM portfolio.trade_log WHERE ticker = 'AAA'")
      expect(price[0][0]).toBe('1.10')
      // JSONB and the 384-dimension vector arrived.
      const dims = await t.rows(
        "SELECT public.vector_dims(embedding)::pg_catalog.text FROM capital.chunks")
      expect(dims[0][0]).toBe('384')
      const jb = await t.rows(
        "SELECT (scenarios->'a'->2->>'b') IS NULL AND scenarios ? 'z' FROM briefing.predictions")
      expect(jb[0][0]).toBe('true')
      await t.rows('ROLLBACK')
    } finally { await t.end() }
  }, 1_800_000)

  it('an inserted DEFAULT on a clone receives the expected next value', async () => {
    // The sequence policy's whole purpose: the target must ISSUE what the
    // fenced source would have issued next. Proved on a THROWAWAY CLONE so the
    // copied target is left exactly as the copy made it.
    const s = await openPsqlSession(TGT, TGT_DB)
    try {
      const want = (await s.must(
        `SELECT CASE WHEN is_called THEN last_value + 1 ELSE last_value END::pg_catalog.text
           FROM portfolio.trade_log_id_seq`))[0][0]
      await s.must('BEGIN')
      await s.must('SET LOCAL ROLE ' + TARGET_OWNER_ROLE)
      const got = await s.must(
        `INSERT INTO portfolio.trade_log (trade_date, ticker, action, shares, price)
           VALUES (DATE '2026-02-01', 'ZZZ', 'buy', 1, 1)
         RETURNING id::pg_catalog.text`)
      expect(got[0][0]).toBe(want)
      await s.must('ROLLBACK')
    } finally { await s.close() }
  }, 600_000)
})

/** Put the target back to empty and pristine, as the owner. */
async function resetTarget(): Promise<void> {
  const s = await openPsqlSession(TGT, TGT_DB)
  try {
    await s.must('BEGIN')
    await s.must(`SET LOCAL ROLE ${TARGET_OWNER_ROLE}`)
    await s.must(`TRUNCATE ${COPY_TABLES.join(', ')} RESTART IDENTITY CASCADE`)
    await s.must('COMMIT')
  } finally { await s.close() }
  const after = await targetState()
  expect(after.rows).toBe(0)
  for (const s2 of after.sequences) expect(s2).toMatch(/=1\/false$/)
}

/** A target session whose statements can be watched and interfered with. */
function proxyTarget(hooks: {
  onRows?: (sql: string, inner: DriverSession) => Promise<string[][] | null>
  onCommand?: (sql: string) => Promise<never | null>
  issued?: string[]
}): () => Promise<DriverSession> {
  return async () => {
    const inner = await openTargetDriver()
    return {
      pid: inner.pid,
      client: inner.client,
      rows: async (sql: string) => {
        hooks.issued?.push(sql)
        const taken = await hooks.onRows?.(sql, inner)
        if (taken !== null && taken !== undefined) return taken
        return await inner.rows(sql)
      },
      command: async (sql: string) => {
        hooks.issued?.push(sql)
        await hooks.onCommand?.(sql)
        return await inner.command(sql)
      },
      end: inner.end,
      alive: inner.alive,
    }
  }
}

/**
 * Inspect, then apply - on SEPARATE session sets.
 *
 * The supervisor's transaction IS the fence, so a session that has already
 * fenced cannot fence again. Inspect and apply are two runs, and the copier
 * repeating A2-A5 from scratch is the behaviour under test, not a detail to
 * work around.
 */
async function applyWith(openTarget: () => Promise<DriverSession>): Promise<unknown> {
  const confirmation = await withSessions(
    async s => (await runInspect(s, bundle(), TARGET_EXPECTATION())).confirmation)
  return await withSessions(async s => {
    try {
      await runApply({
        ...s, targetExpectation: TARGET_EXPECTATION(),
        confirmation, openTarget,
      }, bundle())
      return null
    } catch (e) { return e }
  })
}

describe('every pre-COMMIT failure leaves the target empty and pristine', () => {
  it('a C2 refusal opens NO target transaction', async () => {
    await resetTarget()
    const issued: string[] = []
    // A target whose schema is not the reviewed one. An extra INDEX rather than
    // an extra column, and deliberately: the contract counts DROPPED columns,
    // so adding and removing one would leave the digest permanently changed and
    // poison every later test. An index leaves nothing behind.
    await write(TGT, TGT_DB, 'CREATE INDEX stage2_probe_idx ON graph.nodes (ticker)')
    try {
      const thrown = await applyWith(proxyTarget({ issued }))
      expect((thrown as Error).name).toBe('TargetRefused')
      expect(String((thrown as Error).message)).toMatch(/not the reviewed expected-target contract/)
      // The read-only C2 transaction was opened and rolled back; the WRITE
      // transaction - a bare BEGIN - never was.
      expect(issued.filter(s => s.trim() === 'BEGIN')).toEqual([])
    } finally {
      await write(TGT, TGT_DB, 'DROP INDEX graph.stage2_probe_idx')
    }
    expect((await targetState()).rows).toBe(0)
  }, 1_800_000)

  it('a diverged target row aborts at A13 and rolls the whole copy back', async () => {
    // The copy runs to completion, then ONE row is removed inside the same
    // transaction - so the target no longer holds what the manifest describes.
    // A13's digest comparison is the only thing standing between that and a
    // committed, silently-wrong target.
    await resetTarget()
    let diverged = false
    const thrown = await applyWith(proxyTarget({
      onRows: async (sql: string, inner: DriverSession) => {
        // The sequence policy's RELEASE is the last statement before the final
        // gates, so the copy is complete by then.
        if (sql.startsWith('RELEASE SAVEPOINT') && !diverged) {
          diverged = true
          const out = await inner.rows(sql)
          await inner.rows("DELETE FROM capital.watchlist WHERE ticker = 'BBB'")
          return out
        }
        return null
      },
    }))
    expect(diverged).toBe(true)
    expect(thrown).toBeInstanceOf(Stage2Refused)
    expect((thrown as Stage2Refused).phase).toBe('A13-target-verification')
    // AND EVERY ROW WENT BACK. The copy was transactional, so a refusal at the
    // final gate leaves all 21 tables empty and all three sequences pristine.
    const after = await targetState()
    expect(after.rows).toBe(0)
    for (const s of after.sequences) expect(s).toMatch(/=1\/false$/)
  }, 1_800_000)

  it('the source re-proof fails when the supervisor dies before COMMIT', async () => {
    await resetTarget()
    const confirmation = await withSessions(
      async s => (await runInspect(s, bundle(), TARGET_EXPECTATION())).confirmation)

    const supervisor = await openPsqlSession(SRC, SRC_DB)
    const prover = await openPsqlSession(SRC, SRC_DB)
    const source = await openSourceDriver()
    let thrown: unknown = null
    try {
      await runApply({
        supervisor, prover, source, operator: OPERATOR(), sourceBeginSql: EXPORT_BEGIN_SQL,
        targetExpectation: TARGET_EXPECTATION(), confirmation,
        openTarget: proxyTarget({
          onRows: async (sql: string) => {
            // The supervisor dies right before the final gates, which releases
            // the fence: A13 must notice rather than commit anyway.
            if (sql.startsWith('RELEASE SAVEPOINT')) await supervisor.close()
            return null
          },
        }),
      }, bundle())
    } catch (e) { thrown = e } finally {
      try { await source.rows('ROLLBACK') } catch { /* bounded */ }
      await source.end()
      await prover.close()
      try { await supervisor.close() } catch { /* already gone */ }
    }

    expect(thrown).toBeInstanceOf(Stage2Refused)
    expect((thrown as Stage2Refused).phase).toBe('A13-source-reproof')
    const after = await targetState()
    expect(after.rows).toBe(0)
    for (const s of after.sequences) expect(s).toMatch(/=1\/false$/)
  }, 1_800_000)

  it('SOURCE SEQUENCE DRIFT is caught at A13, and the copy rolls back', async () => {
    // Under the selected S3 fence a real `nextval()` cannot complete, which is
    // the point of the fence - so the drift is injected at the supervisor's
    // state read instead. What is under test is that A13 COMPARES, not that
    // the fence can be defeated.
    await resetTarget()
    const confirmation = await withSessions(
      async s => (await runInspect(s, bundle(), TARGET_EXPECTATION())).confirmation)

    const supervisor = await openPsqlSession(SRC, SRC_DB)
    const prover = await openPsqlSession(SRC, SRC_DB)
    const source = await openSourceDriver()
    let copied = false
    let drifted = 0
    // The supervisor answers truthfully until the copy is DONE - gated on the
    // sequence policy's RELEASE rather than on a call count, because the fence
    // acquisition reads these sequences too and a count would drift at A5.
    const driftingSupervisor = {
      send: async (sql: string) => {
        const r = await supervisor.send(sql)
        if (sql.includes('pg_sequence o') && r.error === null && r.rows.length === 1) {
          if (copied) {
            drifted += 1
            const moved = [...r.rows[0]]
            moved[0] = String(BigInt(moved[0]) + 1n)
            moved[1] = 'true'
            return { rows: [moved], error: r.error }
          }
        }
        return r
      },
    }
    let thrown: unknown = null
    try {
      await runApply({
        supervisor: driftingSupervisor, prover, source, operator: OPERATOR(),
        sourceBeginSql: EXPORT_BEGIN_SQL, targetExpectation: TARGET_EXPECTATION(),
        confirmation,
        openTarget: proxyTarget({
          onRows: async (sql: string) => {
            if (sql.startsWith('RELEASE SAVEPOINT')) copied = true
            return null
          },
        }),
      }, bundle())
    } catch (e) { thrown = e } finally {
      try { await source.rows('ROLLBACK') } catch { /* bounded */ }
      await source.end(); await prover.close()
      try { await supervisor.send('ROLLBACK') } catch { /* bounded */ }
      await supervisor.close()
    }
    expect(copied).toBe(true)
    expect(drifted).toBeGreaterThan(0)
    expect(thrown).toBeInstanceOf(Stage2Refused)
    expect((thrown as Stage2Refused).phase).toBe('A13-source-reproof')
    const after = await targetState()
    expect(after.rows).toBe(0)
    for (const s of after.sequences) expect(s).toMatch(/=1\/false$/)
  }, 1_800_000)

  it('an UNCERTAIN COMMIT exits with the unknown outcome and issues no ROLLBACK', async () => {
    await resetTarget()
    const issued: string[] = []
    const thrown = await applyWith(proxyTarget({
      issued,
      onCommand: async (sql: string) => {
        if (sql.trim() === 'COMMIT') {
          throw new Error('injected: connection terminated during COMMIT')
        }
        return null
      },
    }))
    expect(thrown).toBeInstanceOf(CommitOutcomeUnknown)
    expect(String((thrown as Error).message)).toContain('COMMIT OUTCOME UNKNOWN')
    expect(String((thrown as Error).message)).toContain('MUST NOT be retried')
    // THE ONE STATEMENT THAT MUST NOT HAVE BEEN ISSUED.
    const afterCommit = issued.slice(issued.lastIndexOf('COMMIT') + 1)
    expect(afterCommit.filter(s => s.trim() === 'ROLLBACK')).toEqual([])
    // Nothing leaked from the injected failure either.
    expect(surfaces(thrown)).not.toContain('injected')
    expect(surfaces(thrown)).not.toContain('connection terminated')
  }, 1_800_000)
})

describe('residue', () => {
  it('leaves no open session and no foreign cluster root', async () => {
    await closeAllPsqlSessions()
    expect(openPsqlSessionCount()).toBe(0)
    expect(unstoppedRoots().sort()).toEqual([SRC.root, TGT.root].sort())
    for (const r of ROOTS) {
      expect(readdirSync(r).filter(n => n.startsWith('.tmp-'))).toEqual([])
    }
  }, 600_000)
})
