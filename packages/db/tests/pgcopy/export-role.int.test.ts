// Slice 4 against LIVE PostgreSQL 17 on a disposable cluster: the export role's
// exact authority, the fence-first contract extraction, the transactional
// lifecycle, the credential, and the census that proves the cluster came back to
// where it started.

import { execFileSync } from 'node:child_process'
import { readFileSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { censusDigest } from '../../src/pg-copy/acl-census.js'
import {
  EXPORT_ROLE_NAME, EXPORT_TABLES, LEDGER_RELATION, LOG_SUPPRESSION_SQL,
  createExportRoleSql, deriveScramSha256Verifier, dropExportRoleSql, generateExportSecret,
} from '../../src/pg-copy/export-role.js'
import {
  COPY_SEQUENCES, MIGRATIONS_SQL, extractContractFromSession, pgTextArray,
} from '../../src/pg-copy/schema-contract.js'
import {
  LIVE_COLUMNS_SQL, PK_COLUMNS_SQL, assertSupportedColumns, batchDigestSql,
  type ColumnSpec, type TypeContract,
} from '../../src/pg-copy/canonical.js'
import {
  FENCE_ADVISORY_SQL, FENCE_BEGIN_SQL, FENCE_LOCK_TIMEOUT_SQL, FENCE_PROOF_SQL,
  FENCE_SEQUENCES, FENCE_TABLES, SELECTED_SEQUENCE_FENCE, SEQUENCE_STATE_SQL,
  acquireSourceFence, assertFenceProof, fenceRelationArray, parseLockRows,
  parseSequenceState, readFencedSequenceState, sequenceFenceSql, tableFenceSql,
} from '../../src/pg-copy/source-fence.js'
import {
  startDisposableCluster, stopAllDisposableClusters, type DisposableCluster,
} from '../../testing/disposable-cluster.js'
import {
  CREDENTIAL_FILENAME, cleanSecretRoots, makeSecretRoot, openExportSession, provisionExportRole,
  readPublishedCredential, requireScramForExportRole, runBatch, takeCensus, teardownExportRole,
  writePassfileFromCredential, type ParsedCredential, type ProvisionedExportRole,
} from '../../testing/export-role.js'
import { closeAllPsqlSessions, openPsqlSession, type PsqlSession } from '../../testing/psql-session.js'
import { buildV19Database } from '../../testing/v19-database.js'
import { EXTRACTION_BEGIN_SQL, extractContract } from '../../bin/pg-copy-contract.js'

const DB = 'source_v19'
const SHORT = `SET statement_timeout = '5s'`
const SHORT_LOCK = `SET lock_timeout = '5s'`

let C: DisposableCluster
let secretRoot: string
let ownerDigest: string
let censusBefore: string
/** The reviewed vector contract, with the version read from this cluster. */
let CONTRACT: TypeContract = { vector: null }

beforeAll(async () => {
  C = await startDisposableCluster()
  await buildV19Database(C, DB)
  await requireScramForExportRole(C)
  // Relations OUTSIDE the reviewed surface, so the denial matrix is not vacuous.
  await C.sql('CREATE SCHEMA IF NOT EXISTS desk', DB)
  await C.sql('CREATE SCHEMA IF NOT EXISTS trade', DB)
  await C.sql('CREATE TABLE IF NOT EXISTS desk.probe (id integer)', DB)
  await C.sql('CREATE TABLE IF NOT EXISTS trade.probe (id integer)', DB)
  // At least one copied table must hold a row, or every digest would be empty
  // and "the digest query runs" would be a claim about zero bytes.
  await C.sql(
    `INSERT INTO graph.nodes (ticker, company, themes) VALUES
       ('AAPL', 'Apple', '{}'), ('MSFT', 'Microsoft', '{}'), ('NVDA', 'NVIDIA', '{}'),
       ('AMD', 'AMD', '{}'), ('INTC', 'Intel', '{}')
     ON CONFLICT DO NOTHING`, DB)
  CONTRACT = {
    vector: {
      extension: 'vector',
      version: (await C.rows(
        `SELECT extversion FROM pg_catalog.pg_extension WHERE extname = 'vector'`, DB))[0][0],
      dimension: 384,
      sendName: 'vector_send',
    },
  }
  secretRoot = makeSecretRoot()
  ownerDigest = (await extractContract(C, DB)).digest
  const admin = await openPsqlSession(C, DB)
  try { censusBefore = await takeCensus(admin) } finally { await admin.close() }
}, 900_000)

afterAll(async () => {
  await closeAllPsqlSessions()
  await stopAllDisposableClusters()
  cleanSecretRoots()
})

describe('the transactional lifecycle is all-or-nothing', () => {
  const roleExists = async (): Promise<boolean> =>
    (await C.rows(
      `SELECT pg_catalog.count(*)::pg_catalog.text FROM pg_catalog.pg_roles
        WHERE rolname = '${EXPORT_ROLE_NAME}'`, DB))[0][0] !== '0'

  const grantCount = async (): Promise<number> => Number((await C.rows(
    `SELECT pg_catalog.count(*)::pg_catalog.text FROM pg_catalog.pg_class c
       JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
       CROSS JOIN LATERAL pg_catalog.aclexplode(c.relacl) a
      WHERE a.grantee = (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = '${EXPORT_ROLE_NAME}')`,
    DB))[0][0])

  it('leaves nothing behind when the batch fails after CREATE ROLE', async () => {
    const v = deriveScramSha256Verifier(generateExportSecret())
    const batch = createExportRoleSql(DB, v)
      .replace('GRANT CONNECT', 'SELECT 1/0;\nGRANT CONNECT')
    const out = await runBatch(C, DB, batch)
    expect(out.ok).toBe(false)
    expect(await roleExists()).toBe(false)
  }, 300_000)

  it('leaves nothing behind when the batch fails after several grants', async () => {
    const v = deriveScramSha256Verifier(generateExportSecret())
    const lines = createExportRoleSql(DB, v).split('\n')
    const at = lines.findIndex(l => l.startsWith('GRANT SELECT ON')) + 5
    lines.splice(at, 0, 'SELECT 1/0;')
    const out = await runBatch(C, DB, lines.join('\n'))
    expect(out.ok).toBe(false)
    expect(await roleExists()).toBe(false)
    expect(await grantCount()).toBe(0)
  }, 300_000)

  it('rolls back a failed teardown to the COMPLETE original grant set', async () => {
    const p = await provisionExportRole(C, DB, secretRoot)
    try {
      const before = await grantCount()
      expect(before).toBe(EXPORT_TABLES.length)
      const broken = dropExportRoleSql(DB).replace('DROP ROLE', 'SELECT 1/0;\nDROP ROLE')
      const out = await runBatch(C, DB, broken)
      expect(out.ok).toBe(false)
      expect(await roleExists()).toBe(true)
      expect(await grantCount()).toBe(before)
    } finally {
      await teardownExportRole(C, DB, p)
    }
  }, 300_000)
})

describe('the export role, its authority and the fenced extraction', () => {
  let p: ProvisionedExportRole
  let cred: ParsedCredential
  let session: PsqlSession

  beforeAll(async () => {
    p = await provisionExportRole(C, DB, secretRoot)
    // EVERYTHING comes from the published file. Using the secret the provisioner
    // still holds would prove the secret works, not that the file does.
    cred = readPublishedCredential(p.credentialPath)
    const passfile = writePassfileFromCredential(secretRoot, cred)
    session = await openExportSession(C, DB, passfile)
    await session.must(SHORT)
    await session.must(SHORT_LOCK)
    // The passfile exists only long enough to connect.
    rmSync(passfile, { force: true })
  }, 600_000)

  afterAll(async () => {
    await session.close()
    await teardownExportRole(C, DB, p)
  })

  it('authenticates through the PUBLISHED credential url', async () => {
    // CURRENT_USER is a reserved special form, not a pg_catalog function: it
    // cannot be schema-qualified, exactly like COALESCE.
    expect((await session.must('SELECT CURRENT_USER'))[0][0]).toBe(EXPORT_ROLE_NAME)
    expect(cred.user).toBe(EXPORT_ROLE_NAME)
    expect(cred.database).toBe(DB)
    expect(cred.host).toBe(C.socketDir)
    expect(cred.port).toBe(String(C.port))
  }, 300_000)

  it('fails when ANY single component of that url is mutated', async () => {
    const mutations: Array<[string, ParsedCredential]> = [
      ['password', { ...cred, password: `${cred.password}x` }],
      ['username', { ...cred, user: 'ai_capital_owner' }],
      ['database', { ...cred, database: 'postgres' }],
      ['host', { ...cred, host: '/tmp' }],
      ['port', { ...cred, port: String(C.port + 1) }],
    ]
    let proved = 0
    for (const [label, m] of mutations) {
      const pf = writePassfileFromCredential(secretRoot, m, `bad-${label}.pgpass`)
      try {
        const s = await openExportSession(C, DB, pf, m.user).catch(() => null)
        if (s === null) { proved += 1; continue }
        try {
          const r = await s.send('SELECT CURRENT_USER')
          // Either authentication failed, or we are not who the credential says.
          const failed = r.error !== null
          const wrongIdentity = !failed && r.rows[0]?.[0] !== EXPORT_ROLE_NAME
          expect(failed || wrongIdentity, `${label} was accepted as ${EXPORT_ROLE_NAME}`).toBe(true)
          proved += 1
        } finally { await s.close() }
      } finally { rmSync(pf, { force: true }) }
    }
    // NON-VACUITY: every mutation was actually exercised.
    expect(proved).toBe(mutations.length)
  }, 600_000)

  it('published the credential at 0600 with link count 1', () => {
    const st = statSync(p.credentialPath)
    expect(st.mode & 0o777).toBe(0o600)
    expect(st.nlink).toBe(1)
    expect(p.credentialPath).toBe(join(secretRoot, CREDENTIAL_FILENAME))
  })

  it('reads all 21 copied tables', async () => {
    let ok = 0
    for (const t of EXPORT_TABLES) {
      const r = await session.send(`SELECT pg_catalog.count(*)::pg_catalog.text FROM ${t}`)
      expect(r.error, t).toBeNull()
      ok += 1
    }
    expect(ok).toBe(21)
  }, 300_000)

  it('runs the exact MIGRATIONS_SQL through the two-column grant', async () => {
    const r = await session.send(MIGRATIONS_SQL)
    expect(r.error).toBeNull()
    expect(r.rows.length).toBe(19)
  }, 300_000)

  it('is denied every other column and every write on the ledger', async () => {
    for (const sql of [
      `SELECT * FROM ${LEDGER_RELATION}`,
      `SELECT applied_at FROM ${LEDGER_RELATION}`,
      `INSERT INTO ${LEDGER_RELATION} (filename, sha256) VALUES ('x', 'y')`,
      `UPDATE ${LEDGER_RELATION} SET filename = filename`,
      `DELETE FROM ${LEDGER_RELATION}`,
      `TRUNCATE ${LEDGER_RELATION}`,
    ]) {
      const r = await session.send(sql)
      expect(r.error, sql).toMatch(/permission denied/i)
    }
  }, 300_000)

  it('is denied every application relation outside the reviewed surface', async () => {
    const outside = (await C.rows(
      `SELECT n.nspname || '.' || c.relname
         FROM pg_catalog.pg_class c
         JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname NOT LIKE 'pg\\_%' AND n.nspname <> 'information_schema'
          AND c.relkind IN ('r','p','v','m','f')
          AND n.nspname || '.' || c.relname <> ALL (${pgTextArray([...EXPORT_TABLES, LEDGER_RELATION])})
        ORDER BY 1`, DB)).map(r => r[0])
    // NON-VACUITY: desk.probe and trade.probe were created for exactly this.
    expect(outside).toContain('desk.probe')
    expect(outside).toContain('trade.probe')
    for (const q of outside) {
      const r = await session.send(`SELECT * FROM ${q}`)
      expect(r.error, q).toMatch(/permission denied/i)
    }
  }, 300_000)

  it('holds no sequence privilege of any kind', async () => {
    for (const q of COPY_SEQUENCES) {
      for (const sql of [
        `SELECT last_value, is_called FROM ${q}`,
        `SELECT pg_catalog.nextval('${q}')`,
        `SELECT pg_catalog.setval('${q}', 1)`,
        `ALTER SEQUENCE ${q} INCREMENT BY 1`,
      ]) {
        const r = await session.send(sql)
        expect(r.error, sql).not.toBeNull()
      }
      expect((await session.send(`SELECT pg_catalog.currval('${q}')`)).error).not.toBeNull()
      for (const priv of ['SELECT', 'USAGE', 'UPDATE']) {
        const r = await session.must(
          `SELECT pg_catalog.has_sequence_privilege('${EXPORT_ROLE_NAME}', '${q}', '${priv}')::pg_catalog.text`)
        expect(r[0][0], `${q} ${priv}`).toBe('false')
      }
    }
  }, 300_000)

  it('has no broad, default, PUBLIC or predefined-role authority', async () => {
    expect((await C.rows(
      `SELECT pg_catalog.count(*)::pg_catalog.text FROM pg_catalog.pg_auth_members m
         JOIN pg_catalog.pg_roles r ON r.oid = m.member
        WHERE r.rolname = '${EXPORT_ROLE_NAME}'`, DB))[0][0]).toBe('0')
    expect((await C.rows(
      `SELECT pg_catalog.count(*)::pg_catalog.text FROM pg_catalog.pg_default_acl d
         CROSS JOIN LATERAL pg_catalog.aclexplode(d.defaclacl) a
        WHERE a.grantee = (SELECT oid FROM pg_catalog.pg_roles WHERE rolname='${EXPORT_ROLE_NAME}')`,
      DB))[0][0]).toBe('0')
    for (const attr of ['rolsuper', 'rolcreatedb', 'rolcreaterole',
                        'rolbypassrls', 'rolreplication', 'rolinherit']) {
      expect((await C.rows(
        `SELECT ${attr}::pg_catalog.text FROM pg_catalog.pg_roles
          WHERE rolname = '${EXPORT_ROLE_NAME}'`, DB))[0][0], attr).toBe('false')
    }
  }, 300_000)

  it('builds and EXECUTES the real batched digest on every copied table', async () => {
    const orNull = (v: string): string | null => (v === '' ? null : v)
    let tablesExercised = 0
    let columnRows = 0
    let totalBatchRows = 0
    let tablesWithRows = 0
    let tablesWithoutRows = 0

    for (const q of EXPORT_TABLES) {
      const [schema, table] = q.split('.')
      const bind = (sql: string): string =>
        sql.replace('$1', `'${schema}'`).replace('$2', `'${table}'`)

      const colRes = await session.send(bind(LIVE_COLUMNS_SQL))
      expect(colRes.error, `${q} columns`).toBeNull()
      const columns: ColumnSpec[] = colRes.rows.map(r => ({
        name: r[0], formatType: r[1], typname: r[2], typnamespace: r[3],
        typtype: r[4], typcategory: r[5], typmod: Number(r[6]),
        sendName: r[7], sendNamespace: r[8],
        typeExtension: orNull(r[9]), typeExtensionVersion: orNull(r[10]),
        sendExtension: orNull(r[11]),
      }))
      columnRows += columns.length

      const pkRes = await session.send(bind(PK_COLUMNS_SQL))
      expect(pkRes.error, `${q} pk`).toBeNull()
      const pkColumns = pkRes.rows.map(r => r[0])
      expect(pkColumns.length, `${q} has no primary key`).toBeGreaterThan(0)

      assertSupportedColumns(columns, CONTRACT)
      const sql = batchDigestSql({
        schema, table, pkColumns, columns,
        schemaDigest: ownerDigest, contract: CONTRACT, batchRows: 4,
      })
      const digestRes = await session.send(sql)
      expect(digestRes.error, `${q} digest`).toBeNull()
      for (const row of digestRes.rows) {
        expect(row.length).toBe(4)
        expect(Number.isSafeInteger(Number(row[0]))).toBe(true)
        expect(Number(row[1])).toBeGreaterThan(0)
        expect(Number(row[2])).toBeGreaterThan(0)
        expect(row[3]).toMatch(/^[0-9a-f]{64}$/)
        totalBatchRows += Number(row[1])
      }
      if (digestRes.rows.length > 0) tablesWithRows += 1
      else tablesWithoutRows += 1
      tablesExercised += 1
    }

    // NON-VACUITY, in every direction.
    expect(tablesExercised).toBe(21)
    expect(columnRows).toBe(152)
    expect(totalBatchRows).toBeGreaterThan(0)
    expect(tablesWithRows).toBeGreaterThan(0)
    expect(tablesWithoutRows).toBeGreaterThan(0)
  }, 900_000)

  it('extracts the COMPLETE contract under the held fence, on one backend', async () => {
    const sup = await openPsqlSession(C, DB)
    const prover = await openPsqlSession(C, DB)
    try {
      // 1-2. fence, then an INDEPENDENT proof, before Stage 1 begins.
      const fence = await acquireSourceFence(sup)
      const rows = parseLockRows(
        await prover.must(FENCE_PROOF_SQL.replace('$1', fenceRelationArray())))
      assertFenceProof(rows, { supervisorPid: fence.supervisorPid, provingPid: prover.pid })

      // 3-4. only now does the export-role transaction open.
      await session.must(EXTRACTION_BEGIN_SQL)
      const artifact = await extractContractFromSession(session, session.pid)
      await session.must('ROLLBACK')

      // 5. the same schema the owner sees.
      expect(artifact.digest).toBe(ownerDigest)

      // 6. and the fence is still whole, same supervisor, nothing queued.
      const after = parseLockRows(
        await prover.must(FENCE_PROOF_SQL.replace('$1', fenceRelationArray())))
      assertFenceProof(after, { supervisorPid: fence.supervisorPid, provingPid: prover.pid })

      // Mutable state comes ONLY from the supervisor, bound to its live pid.
      const live = (await sup.must('SELECT pg_catalog.pg_backend_pid()::pg_catalog.text'))[0][0]
      expect(live).toBe(fence.supervisorPid)
      const fenced = await readFencedSequenceState(sup, prover, fence)
      expect(Object.keys(fenced).sort()).toEqual([...FENCE_SEQUENCES])
      await sup.send('ROLLBACK')
    } finally {
      await prover.close()
      await sup.close()
    }
  }, 600_000)

  it('leaks nothing into a LIVE child process argv or environment', async () => {
    // A canary secret and its real verifier, run through the real lifecycle path
    // against a role name that does not exist - so the batch blocks on a
    // deliberately slow statement while we photograph the running child.
    const canarySecret = generateExportSecret()
    const canaryVerifier = deriveScramSha256Verifier(canarySecret)
    const canaryUrl = `postgresql://${EXPORT_ROLE_NAME}:${canarySecret}@/x`
    const slow = `\\set ON_ERROR_STOP on\nBEGIN;\nSELECT pg_catalog.pg_sleep(3);\n` +
                 `SELECT '${canaryVerifier}'::pg_catalog.text IS NOT NULL;\nROLLBACK;\n`
    const running = runBatch(C, DB, slow)
    await new Promise(r => setTimeout(r, 900))

    // The child is ALIVE right now: photograph argv and environment.
    const argvAndEnv = execFileSync('/bin/ps', ['-Ewwwax'],
      { encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 })
    const psqlLines = argvAndEnv.split('\n').filter(l => l.includes('psql'))
    expect(psqlLines.length, 'no live psql child was photographed').toBeGreaterThan(0)
    const photo = psqlLines.join('\n')
    for (const canary of [canarySecret, canaryVerifier, canaryUrl]) {
      expect(photo.includes(canary), 'live child argv/env').toBe(false)
    }
    for (const forbidden of ['PGPASSWORD=', 'DATABASE_URL=', 'PGHOST=', 'PGPORT=',
                             'PGUSER=', 'PGDATABASE=', 'SECRET=', 'CREDENTIAL=']) {
      expect(photo.includes(forbidden), `forbidden env family ${forbidden}`).toBe(false)
    }
    const outcome = await running
    // Only how it ended: no captured output is returned at all.
    expect(Object.keys(outcome).sort()).toEqual(['code', 'ok'])
    expect(JSON.stringify(outcome).includes(canarySecret)).toBe(false)

    // The real published URL lives in exactly one place.
    expect(readFileSync(p.credentialPath, 'utf-8')).toBe(p.url)
    const src = readFileSync(
      new URL('../../src/pg-copy/export-role.ts', import.meta.url), 'utf-8')
    expect(src.includes(canarySecret)).toBe(false)
  }, 300_000)

})

describe('the cluster comes back to exactly where it started', () => {
  /**
   * Every channel PostgreSQL can print a statement through, one at a time.
   *
   * Each case turns ON exactly the channel it names, proves with a unique probe
   * that the channel really is writing to the log, then runs a successful and a
   * deliberately failing verifier-bearing batch and proves nothing leaked.
   * Enabling all of them at once would let one working suppression hide a
   * broken one.
   */
  const LOG_CASES: Array<{
    name: string
    settings: Array<[string, string]>
    /** Transaction sampling only fires for statements inside a transaction. */
    probeInTransaction?: boolean
  }> = [
    { name: 'log_statement=all', settings: [['log_statement', "'all'"]] },
    {
      name: 'log_min_duration_statement=0',
      settings: [['log_statement', "'none'"], ['log_min_duration_statement', '0']],
    },
    {
      name: 'log_min_duration_sample=0',
      settings: [
        ['log_statement', "'none'"], ['log_min_duration_statement', '-1'],
        ['log_min_duration_sample', '0'], ['log_statement_sample_rate', '1'],
      ],
    },
    {
      // The fifth channel. Sampling is decided when a transaction STARTS, so a
      // SET LOCAL inside the lifecycle transaction arrives too late; only the
      // pre-BEGIN session setting closes it.
      name: 'log_transaction_sample_rate=1',
      settings: [
        ['log_statement', "'none'"], ['log_min_duration_statement', '-1'],
        ['log_min_duration_sample', '-1'], ['log_transaction_sample_rate', '1'],
      ],
      probeInTransaction: true,
    },
  ]

  for (const c of LOG_CASES) {
    it(`keeps the verifier out of the server log under ${c.name}`, async () => {
      for (const [k, v] of c.settings) await C.sql(`ALTER SYSTEM SET ${k} = ${v}`)
      await C.sql('SELECT pg_catalog.pg_reload_conf()')
      const probe = `log_probe_${c.name.replace(/[^a-z0-9]/gi, '_')}`
      try {
        // NON-VACUITY: this channel must actually be writing to the log. Without
        // it, "the log contains no verifier" could be true of an empty file.
        await C.sql(
          c.probeInTransaction === true
            ? `BEGIN; SELECT '${probe}'::pg_catalog.text; COMMIT;`
            : `SELECT '${probe}'::pg_catalog.text`, DB)
        const before = readFileSync(join(C.root, 'pg.log'), 'utf-8')
        expect(before, `${c.name} never logged its probe`).toContain(probe)

        const secret = generateExportSecret()
        const verifier = deriveScramSha256Verifier(secret)
        const url = `postgresql://${EXPORT_ROLE_NAME}:${secret}@/x`
        const batch = createExportRoleSql(DB, verifier)
        expect(batch.indexOf(LOG_SUPPRESSION_SQL)).toBeGreaterThan(batch.indexOf('BEGIN;'))
        expect(batch.indexOf(LOG_SUPPRESSION_SQL)).toBeLessThan(batch.indexOf('CREATE ROLE'))

        const ok = await runBatch(C, DB, batch)
        expect(ok.ok, `${c.name}: creation failed`).toBe(true)
        await runBatch(C, DB, dropExportRoleSql(DB))
        const bad = await runBatch(C, DB,
          batch.replace('GRANT CONNECT', 'SELECT 1/0;\nGRANT CONNECT'))
        expect(bad.ok).toBe(false)

        const log = readFileSync(join(C.root, 'pg.log'), 'utf-8')
        for (const canary of [secret, verifier, url]) {
          expect(log.includes(canary), `${c.name}: leaked a canary`).toBe(false)
        }
        expect(log.includes('SCRAM-SHA-256$'), `${c.name}: leaked a verifier`).toBe(false)
      } finally {
        for (const [k] of c.settings) await C.sql(`ALTER SYSTEM RESET ${k}`)
        await C.sql('SELECT pg_catalog.pg_reload_conf()')
      }
    }, 600_000)
  }

  it('is byte-identical after revoke, drop and credential removal', async () => {
    const p = await provisionExportRole(C, DB, secretRoot)
    const admin = await openPsqlSession(C, DB)
    try {
      // While it exists, only its own records are excluded - by exact name.
      const during = await takeCensus(admin, EXPORT_ROLE_NAME)
      expect(censusDigest(during)).toBe(censusDigest(censusBefore))
      const out = await teardownExportRole(C, DB, p)
      expect(out.ok).toBe(true)
      // Afterwards, with NO exclusions at all.
      const after = await takeCensus(admin)
      expect(after).toBe(censusBefore)
      expect(censusDigest(after)).toBe(censusDigest(censusBefore))
    } finally {
      await admin.close()
    }
  }, 600_000)

  it('the fence mechanism and sequence policy are unchanged by Slice 4', async () => {
    expect(SELECTED_SEQUENCE_FENCE).toBe('S3')
    const sup = await openPsqlSession(C, DB)
    try {
      await sup.must(FENCE_BEGIN_SQL)
      await sup.must(FENCE_LOCK_TIMEOUT_SQL)
      await sup.must(FENCE_ADVISORY_SQL)
      for (const t of FENCE_TABLES) await sup.must(tableFenceSql(t))
      for (const q of FENCE_SEQUENCES) {
        const st = parseSequenceState(await sup.must(SEQUENCE_STATE_SQL(q)), q)
        await sup.must(sequenceFenceSql(SELECTED_SEQUENCE_FENCE, q, st))
      }
      await sup.send('ROLLBACK')
    } finally { await sup.close() }
  }, 300_000)
})
