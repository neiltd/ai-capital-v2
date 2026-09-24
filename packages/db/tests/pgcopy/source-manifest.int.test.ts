// STAGE 1 AGAINST A LIVE PostgreSQL 17 — the properties only a server can show.
//
// WHAT IS PROVED HERE AND NOWHERE ELSE.
//
//   THE DIGEST REACTS TO REAL DRIFT. A one-byte change in a text value, a NULL
//   swapped for an empty string, `1.10` stored where `1.1` was, one row
//   deleted, and the same rows split into different batches all have to change
//   the value. Every one of those is computed by PostgreSQL's own `*_send()`
//   output inside a server-side fold, so only PostgreSQL can answer.
//
//   THE ORDER IS REAL. The fence is taken and independently proved before the
//   export session's BEGIN; one backend and one snapshot carry every read; the
//   fence is still held - observed from a third backend - after publication and
//   after the source rollback.
//
//   THE EXPORT ROLE'S AUTHORITY IS REAL. It reads the 21 tables and the
//   catalogue, and the sequence positions in the manifest came from the
//   SUPERVISOR: the export role is refused when it tries the same read.
//
// THE CLUSTER IS DISPOSABLE AND BUILT BY THIS SUITE. Ports 5432 and 5433 are
// forbidden by the harness; there is no credential this file could be aimed at.

import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, rmSync, lstatSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  DIGEST_FILE, FROZEN_DIR_MODE, FROZEN_FILE_MODE, newRunId, parseDigestFile, pathIsPresent,
  sha256Hex, verifyPublishedEvidence,
} from '../../src/pg-copy/evidence.js'
import { EXPORT_ROLE_NAME } from '../../src/pg-copy/export-role.js'
import {
  COPY_TABLES, extractContractFromSession, type ContractArtifact,
} from '../../src/pg-copy/schema-contract.js'
import {
  FENCE_SEQUENCES, SEQUENCE_STATE_SQL, effectiveNext,
} from '../../src/pg-copy/source-fence.js'
import {
  EXPORT_BEGIN_SQL, MANIFEST_FILE, SOURCE_CONTRACT_FILE, hashTable, runStage1,
  sqlWithoutComments, typeContractFrom, type OperatorInput,
} from '../../src/pg-copy/source-manifest.js'
import {
  cleanSecretRoots, makeSecretRoot, openExportSession,
  provisionExportRole, readPublishedCredential, requireScramForExportRole,
  writePassfileFromCredential, type ProvisionedExportRole,
} from '../../testing/export-role.js'
import {
  startDisposableCluster, stopAllDisposableClusters, unstoppedRoots,
  type DisposableCluster,
} from '../../testing/disposable-cluster.js'
import { closeAllPsqlSessions, openPsqlSession, openPsqlSessionCount,
  type PsqlSession } from '../../testing/psql-session.js'
import { buildV19Database } from '../../testing/v19-database.js'

const DB = 'ai_capital_src'

let C: DisposableCluster
let ROLE: ProvisionedExportRole
let PASSFILE: string
let CONTRACT: ContractArtifact
const EVIDENCE_ROOTS: string[] = []

function evidenceRoot(): string {
  const r = mkdtempSync(join(tmpdir(), 'pgcopy-manifest-ev-'))
  execFileSync('/bin/chmod', ['700', r])
  EVIDENCE_ROOTS.push(r)
  return r
}

/** A fresh superuser session inside the reviewed read-only snapshot. */
async function snapshot(): Promise<PsqlSession> {
  const s = await openPsqlSession(C, DB)
  await s.must(EXPORT_BEGIN_SQL)
  return s
}

/** Run one statement on a throwaway backend, outside any snapshot. */
async function write(sql: string): Promise<void> {
  const s = await openPsqlSession(C, DB)
  try { await s.must(sql) } finally { await s.close() }
}

const SEED: readonly string[] = Object.freeze([
  `INSERT INTO capital.watchlist (ticker, company, themes, added_at, news_search_terms, cik)
     VALUES ('AAA', 'Alpha Corp', 'x', TIMESTAMPTZ '2026-01-01 00:00:00+00', 'alpha', NULL),
            ('BBB', 'Beta Corp',  'y', TIMESTAMPTZ '2026-01-02 00:00:00+00', 'beta',  '0001'),
            ('CCC', 'Gamma Corp', 'z', TIMESTAMPTZ '2026-01-03 00:00:00+00', 'gamma', '0002')`,
  `INSERT INTO portfolio.trade_log (trade_date, ticker, action, shares, price)
     VALUES (DATE '2026-01-01', 'AAA', 'buy', 10, 1.1),
            (DATE '2026-01-02', 'BBB', 'buy', 20, 2.5)`,
  `INSERT INTO portfolio.positions (ticker, company, shares, avg_cost, updated_at)
     VALUES ('AAA', 'Alpha Corp', 10, 1.1, TIMESTAMPTZ '2026-01-01 00:00:00+00')`,
])

const OPERATOR = (runId: string): OperatorInput => ({
  runId,
  generatedAtUtc: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
  implementationHead: 'a'.repeat(40),
  provenanceHead: 'b'.repeat(40),
  ingestionGitlink: 'c'.repeat(40),
  expectedTargetSystem: 'ai-capital-v3',
  sourceSystem: 'ai-capital-v2-disposable',
  sourceEndpoint: C.socketDir,
  sourcePort: String(C.port),
  sourceDatabase: DB,
})

beforeAll(async () => {
  C = await startDisposableCluster()
  await buildV19Database(C, DB)
  for (const sql of SEED) await write(sql)
  await requireScramForExportRole(C)
  ROLE = await provisionExportRole(C, DB, makeSecretRoot())
  PASSFILE = writePassfileFromCredential(
    ROLE.secretRoot, readPublishedCredential(ROLE.credentialPath))

  const s = await snapshot()
  try {
    CONTRACT = await extractContractFromSession(s, s.pid)
  } finally {
    await s.must('ROLLBACK')
    await s.close()
  }
}, 600_000)

afterAll(async () => {
  await closeAllPsqlSessions()
  await stopAllDisposableClusters()
  cleanSecretRoots()
  for (const r of EVIDENCE_ROOTS.splice(0)) {
    try { execFileSync('/bin/chmod', ['-R', 'u+rwX', r]) } catch { /* already gone */ }
    rmSync(r, { recursive: true, force: true })
  }
}, 300_000)

/** Hash one table on a fresh snapshot, so each measurement is its own moment. */
async function digestOf(qname: string, batchRows = 10_000): Promise<string> {
  const s = await snapshot()
  try {
    return (await hashTable(s, CONTRACT, qname, typeContractFrom(CONTRACT), batchRows)).digest
  } finally {
    await s.must('ROLLBACK')
    await s.close()
  }
}

describe('the content digest reacts to the drift it exists to catch', () => {
  it('changes for one byte of one text value', async () => {
    const before = await digestOf('capital.watchlist')
    await write("UPDATE capital.watchlist SET company = 'Alpha Corq' WHERE ticker = 'AAA'")
    const after = await digestOf('capital.watchlist')
    expect(after).not.toBe(before)
    await write("UPDATE capital.watchlist SET company = 'Alpha Corp' WHERE ticker = 'AAA'")
    expect(await digestOf('capital.watchlist')).toBe(before)
  }, 300_000)

  it('distinguishes NULL from the empty string', async () => {
    // `concat_ws` cannot tell these apart; the length-prefixed frame can, and
    // this is the case that proves the framing is doing its job.
    const withNull = await digestOf('capital.watchlist')
    await write("UPDATE capital.watchlist SET cik = '' WHERE ticker = 'AAA'")
    const withEmpty = await digestOf('capital.watchlist')
    expect(withEmpty).not.toBe(withNull)
    await write("UPDATE capital.watchlist SET cik = NULL WHERE ticker = 'AAA'")
    expect(await digestOf('capital.watchlist')).toBe(withNull)
  }, 300_000)

  it('changes for a numeric SCALE difference that SQL equality cannot see', async () => {
    const before = await digestOf('portfolio.trade_log')
    // 1.10 = 1.1 under `=`, and `numeric_send` encodes the stored scale.
    await write("UPDATE portfolio.trade_log SET price = 1.10 WHERE ticker = 'AAA'")
    const equalButDifferent = await write(
      "SELECT 1").then(async () => await digestOf('portfolio.trade_log'))
    expect(equalButDifferent).not.toBe(before)
    // And the database itself still calls the two values equal.
    const s = await openPsqlSession(C, DB)
    try {
      const eq = await s.must(
        "SELECT (price = 1.1)::pg_catalog.text FROM portfolio.trade_log WHERE ticker = 'AAA'")
      expect(eq[0][0]).toBe('true')
    } finally { await s.close() }
    await write("UPDATE portfolio.trade_log SET price = 1.1 WHERE ticker = 'AAA'")
    expect(await digestOf('portfolio.trade_log')).toBe(before)
  }, 300_000)

  it('changes when a row is deleted, and comes back when it is restored', async () => {
    const before = await digestOf('capital.watchlist')
    await write("DELETE FROM capital.watchlist WHERE ticker = 'CCC'")
    expect(await digestOf('capital.watchlist')).not.toBe(before)
    await write(
      `INSERT INTO capital.watchlist (ticker, company, themes, added_at, news_search_terms, cik)
         VALUES ('CCC', 'Gamma Corp', 'z', TIMESTAMPTZ '2026-01-03 00:00:00+00', 'gamma', '0002')`)
    expect(await digestOf('capital.watchlist')).toBe(before)
  }, 300_000)

  it('changes when the same rows are cut into different batches', async () => {
    // Identical contents, identical order: only the BATCH FRAMING differs. The
    // fold names each batch's ordinal and counts, so it must not collapse.
    const oneBatch = await digestOf('capital.watchlist', 10_000)
    const perRow = await digestOf('capital.watchlist', 1)
    expect(perRow).not.toBe(oneBatch)
  }, 300_000)

  it('changes when two rows exchange their primary keys - the order is part of it',
    async () => {
    const before = await digestOf('capital.watchlist')
    await write(`UPDATE capital.watchlist SET company =
      CASE ticker WHEN 'AAA' THEN 'Beta Corp' WHEN 'BBB' THEN 'Alpha Corp' ELSE company END
      WHERE ticker IN ('AAA','BBB')`)
    expect(await digestOf('capital.watchlist')).not.toBe(before)
    await write(`UPDATE capital.watchlist SET company =
      CASE ticker WHEN 'AAA' THEN 'Alpha Corp' WHEN 'BBB' THEN 'Beta Corp' ELSE company END
      WHERE ticker IN ('AAA','BBB')`)
    expect(await digestOf('capital.watchlist')).toBe(before)
  }, 300_000)

  it('represents an empty table honestly, and says nothing about how it emptied', async () => {
    const alwaysEmpty = await digestOf('graph.nodes')
    const seeded = 'thesis.theses'
    const before = await digestOf(seeded)
    expect(before).toBeTruthy()
    // An emptied table digests as an empty table of that name: the fold is over
    // CONTENTS, and identical contents are identical.
    await write(`INSERT INTO graph.nodes (ticker, company, themes) VALUES ('ZZZ','Z','z')`)
    expect(await digestOf('graph.nodes')).not.toBe(alwaysEmpty)
    await write("DELETE FROM graph.nodes WHERE ticker = 'ZZZ'")
    expect(await digestOf('graph.nodes')).toBe(alwaysEmpty)
  }, 300_000)
})

describe('the export role', () => {
  it('can read the 21 reviewed tables but NOT mutable sequence state', async () => {
    const e = await openExportSession(C, DB, PASSFILE)
    try {
      const who = await e.must('SELECT CURRENT_USER::pg_catalog.text')
      expect(who[0][0]).toBe(EXPORT_ROLE_NAME)
      for (const q of COPY_TABLES) {
        const r = await e.send(`SELECT pg_catalog.count(*) FROM ${q}`)
        expect(r.error, q).toBeNull()
      }
      // The sequence relations are NOT readable by it: the authority grants no
      // sequence privilege at all.
      for (const q of FENCE_SEQUENCES) {
        const r = await e.send(SEQUENCE_STATE_SQL(q))
        expect(r.error, q).not.toBeNull()
        expect(r.error, q).toMatch(/permission denied/i)
      }
    } finally { await e.close() }
  }, 300_000)
})

describe('Stage 1, end to end, under a held fence', () => {
  it('publishes a complete manifest and keeps the fence to the very end', async () => {
    const root = evidenceRoot()
    const supervisor = await openPsqlSession(C, DB)
    const prover = await openPsqlSession(C, DB)
    const exportSession = await openExportSession(C, DB, PASSFILE)
    const runId = newRunId()
    try {
      const r = await runStage1({
        supervisor, prover, exportSession, operator: OPERATOR(runId), evidenceRoot: root,
      })

      // THE ORDER. Acquisition and an independent proof precede the BEGIN, and
      // the fence is still held after publication AND after the rollback.
      expect([...r.timeline]).toEqual([
        'fence-acquired', 'fence-proved', 'export-begun', 'export-proved',
        'contract-extracted', 'content-hashed', 'sequences-read', 'fence-reproved',
        'published', 'fence-held-at-publication', 'source-rolled-back',
        'fence-held-at-rollback',
      ])

      // ONE transaction, opened first, on ONE backend, and never committed.
      expect(r.exportStatements[0]).toBe(EXPORT_BEGIN_SQL)
      expect(r.exportStatements.filter(s => s.trim() === EXPORT_BEGIN_SQL).length).toBe(1)
      expect(r.exportStatements.some(s => /^\s*COMMIT/i.test(s))).toBe(false)
      expect(r.exportStatements[r.exportStatements.length - 1]).toBe('ROLLBACK')
      const m = r.manifest as Record<string, never>
      expect((m.source as unknown as { backend_pid: string }).backend_pid)
        .toBe(exportSession.pid)
      expect(r.exportStatements.filter(s => s.startsWith('WITH numbered AS')).length).toBe(21)

      // THE EXPORT ROLE WAS NEVER ASKED FOR A POSITION. Judged on EXECUTABLE
      // SQL: one reviewed contract query carries a `--` comment explaining why
      // it does not join pg_sequences, and matching that would be matching the
      // explanation rather than the statement.
      expect(r.exportStatements.some(
        s => /\blast_value\b|\bis_called\b|\bpg_sequences\b|\bnextval\b/
          .test(sqlWithoutComments(s)))).toBe(false)
      // The commentary really is there, so the distinction is not vacuous.
      expect(r.exportStatements.some(s => /pg_sequences/.test(s))).toBe(true)

      // THE PUBLISHED BUNDLE.
      expect(r.published.finalPath).toMatch(
        new RegExp(`/source-manifest-\\d{8}T\\d{6}Z-${runId}$`))
      expect([...r.published.files])
        .toEqual([MANIFEST_FILE, SOURCE_CONTRACT_FILE, DIGEST_FILE])
      expect(lstatSync(r.published.finalPath).mode & 0o777).toBe(FROZEN_DIR_MODE)
      for (const f of r.published.files) {
        expect(lstatSync(join(r.published.finalPath, f)).mode & 0o777, f).toBe(FROZEN_FILE_MODE)
      }
      expect(verifyPublishedEvidence(r.published.finalPath)).toBeTruthy()
      const recorded = parseDigestFile(
        readFileSync(join(r.published.finalPath, DIGEST_FILE), 'utf-8'))
      for (const [rel, digest] of recorded) {
        expect(sha256Hex(readFileSync(join(r.published.finalPath, rel))), rel).toBe(digest)
      }
      expect(pathIsPresent(join(root, `.tmp-${runId}`))).toBe(false)

      // THE DOCUMENT.
      const doc = JSON.parse(
        readFileSync(join(r.published.finalPath, MANIFEST_FILE), 'utf-8')) as Record<string, never>
      expect(doc.complete).toBe(true)
      expect((doc.content as unknown as { tables: Array<{ qname: string }> }).tables
        .map(t => t.qname)).toEqual([...COPY_TABLES])
      expect((doc.content as unknown as { root_digest: string }).root_digest).toBe(r.rootDigest)
      expect((doc.expected_target as unknown as { contacted: boolean }).contacted).toBe(false)
      expect((doc.source as unknown as { principal: string }).principal).toBe(EXPORT_ROLE_NAME)
      expect((doc.source_contract as unknown as { digest: string }).digest)
        .toBe(r.contractDigest)

      // THE SEQUENCES CAME FROM THE SUPERVISOR, and say what the supervisor says.
      const seqs = doc.sequences as unknown as Array<Record<string, string>>
      expect(seqs.map(s => s.qname)).toEqual([...FENCE_SEQUENCES])
      for (const s of seqs) {
        const live = await supervisor.must(SEQUENCE_STATE_SQL(s.qname))
        expect(live[0][0], s.qname).toBe(s.last_value)
        expect(effectiveNext({
          last_value: s.last_value, is_called: s.is_called as unknown as boolean,
          increment_by: s.increment_by, min_value: s.min_value, max_value: s.max_value,
          start_value: s.start_value, cache_size: s.cache_size,
          cycle: s.cycle as unknown as boolean, data_type: s.data_type, owned_by: s.owned_by,
        }, s.qname).toString(), s.qname).toBe(s.effective_next)
      }

      // The fence is STILL held right now, from a third backend's point of view.
      const held = await prover.must(
        `SELECT pg_catalog.count(*)::pg_catalog.text FROM pg_catalog.pg_locks
          WHERE pid = ${supervisor.pid} AND granted AND locktype = 'relation'`)
      expect(Number(held[0][0])).toBeGreaterThanOrEqual(24)

      // A WRITER IS STILL BLOCKED: the source could not have changed under us.
      const blocked = await openPsqlSession(C, DB)
      try {
        await blocked.must("SET lock_timeout = '750ms'")
        const r2 = await blocked.send(
          "INSERT INTO capital.watchlist (ticker, company, themes, added_at, news_search_terms)" +
          " VALUES ('QQQ','Q','q', now(), 'q')")
        expect(r2.error).toMatch(/lock timeout|canceling statement/i)
      } finally { await blocked.close() }
    } finally {
      await supervisor.send('ROLLBACK')
      for (const s of [exportSession, prover, supervisor]) await s.close()
    }
  }, 900_000)

  it('a second run publishes a DISTINCT bundle and never touches the first', async () => {
    const root = evidenceRoot()
    const paths: string[] = []
    for (let i = 0; i < 2; i += 1) {
      const supervisor = await openPsqlSession(C, DB)
      const prover = await openPsqlSession(C, DB)
      const exportSession = await openExportSession(C, DB, PASSFILE)
      try {
        const r = await runStage1({
          supervisor, prover, exportSession, operator: OPERATOR(newRunId()), evidenceRoot: root,
        })
        paths.push(r.published.finalPath)
      } finally {
        await supervisor.send('ROLLBACK')
        for (const s of [exportSession, prover, supervisor]) await s.close()
      }
    }
    expect(paths[0]).not.toBe(paths[1])
    expect(readdirSync(root).sort()).toEqual([
      paths[0].split('/').pop() as string, paths[1].split('/').pop() as string,
    ].sort())
    for (const p of paths) expect(verifyPublishedEvidence(p)).toBeTruthy()
    // Identical contents under identical fences: the same root digest.
    const doc = (p: string): Record<string, never> =>
      JSON.parse(readFileSync(join(p, MANIFEST_FILE), 'utf-8')) as Record<string, never>
    expect((doc(paths[0]).content as unknown as { root_digest: string }).root_digest)
      .toBe((doc(paths[1]).content as unknown as { root_digest: string }).root_digest)
    expect(doc(paths[0]).run_id).not.toBe(doc(paths[1]).run_id)
  }, 900_000)

  it('publishes NOTHING when derivation cannot complete, and releases nothing early',
    async () => {
    const root = evidenceRoot()
    const supervisor = await openPsqlSession(C, DB)
    const prover = await openPsqlSession(C, DB)
    const exportSession = await openExportSession(C, DB, PASSFILE)
    const runId = newRunId()
    try {
      // The operator names a database the session is not on: the identity proof
      // refuses, after the fence is held and before anything is derived.
      await expect(runStage1({
        supervisor, prover, exportSession, evidenceRoot: root,
        operator: { ...OPERATOR(runId), sourceDatabase: 'ai_capital_other' },
      })).rejects.toThrow(/reviewed source database/)

      expect(readdirSync(root)).toEqual([])
      expect(pathIsPresent(join(root, `.tmp-${runId}`))).toBe(false)

      // The fence is STILL HELD - the failure did not release it behind our back.
      const held = await prover.must(
        `SELECT pg_catalog.count(*)::pg_catalog.text FROM pg_catalog.pg_locks
          WHERE pid = ${supervisor.pid} AND granted AND locktype = 'relation'`)
      expect(Number(held[0][0])).toBeGreaterThanOrEqual(24)
    } finally {
      await supervisor.send('ROLLBACK')
      for (const s of [exportSession, prover, supervisor]) await s.close()
    }
  }, 900_000)

  it('refuses a self-proof: the supervisor may not prove its own fence', async () => {
    const root = evidenceRoot()
    const supervisor = await openPsqlSession(C, DB)
    const exportSession = await openExportSession(C, DB, PASSFILE)
    try {
      await expect(runStage1({
        supervisor, prover: supervisor, exportSession,
        operator: OPERATOR(newRunId()), evidenceRoot: root,
      })).rejects.toThrow(/fence was not still held/)
      expect(readdirSync(root)).toEqual([])
    } finally {
      await supervisor.send('ROLLBACK')
      for (const s of [exportSession, supervisor]) await s.close()
    }
  }, 900_000)

  it('refuses to publish into a root that is missing, loose or a symlink', async () => {
    const root = evidenceRoot()
    const supervisor = await openPsqlSession(C, DB)
    const prover = await openPsqlSession(C, DB)
    const exportSession = await openExportSession(C, DB, PASSFILE)
    try {
      await expect(runStage1({
        supervisor, prover, exportSession, operator: OPERATOR(newRunId()),
        evidenceRoot: join(root, 'absent'),
      })).rejects.toThrow(/evidence root is not an existing directory/)
      expect(readdirSync(root)).toEqual([])
    } finally {
      await supervisor.send('ROLLBACK')
      for (const s of [exportSession, prover, supervisor]) await s.close()
    }
  }, 900_000)
})

describe('residue', () => {
  it('leaves no open session, no foreign cluster root and no temporary bundle', async () => {
    await closeAllPsqlSessions()
    expect(openPsqlSessionCount()).toBe(0)
    // This suite's own cluster is still running by design - `afterAll` stops it.
    // What must not exist is any OTHER disposable root: one left behind by a
    // failed run in this file would be indistinguishable from a leak otherwise.
    expect(unstoppedRoots()).toEqual([C.root])
    for (const r of EVIDENCE_ROOTS) {
      expect(readdirSync(r).filter(n => n.startsWith('.tmp-'))).toEqual([])
    }
  }, 300_000)
})
