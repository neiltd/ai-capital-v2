// Slice 4, proved OFFLINE: the grant surface, the batch shapes, the SCRAM
// derivation, the credential path rules, the census normalization and the
// session-bound extraction guards. What a real server does with any of it is
// tests/pgcopy/export-role.int.test.ts.

import { createHash, createHmac, randomBytes } from 'node:crypto'
import {
  chmodSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync,
  writeFileSync, type Stats,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterAll, describe, it, expect } from 'vitest'

import {
  censusJson, censusDigest, CENSUS_QUERIES, CensusRefused, type RawCensus,
} from '../src/pg-copy/acl-census.js'
import { parseCredentialUrl } from '../testing/export-role.js'
import {
  EXPORT_ROLE_NAME, EXPORT_SCHEMAS, EXPORT_TABLES, ExportRoleRefused,
  FORBIDDEN_PSQL_ARGS, LEDGER_COLUMNS, LEDGER_RELATION, SCRAM_ITERATIONS,
  CredentialPublishedButUnverified, LOG_SUPPRESSION_SQL, REAL_PUBLISH_OPS,
  TRANSACTION_SAMPLING_SUPPRESSION_SQL,
  type PublishOps, type PublishPhase,
  assertBatchArgs, assertCredentialFilename, assertScramVerifier, buildExportCredentialUrl,
  createExportRoleSql, deriveScramSha256Verifier, dropExportRoleSql, generateExportSecret,
  publishExportCredential, removeExportCredential, scramSaltedPassword, sterileBatchEnv,
} from '../src/pg-copy/export-role.js'
import {
  COLUMNS_SQL, COPY_TABLES, CONTRACT_QUERIES, ContractRefused,
  REQUIRED_TRANSACTION_ISOLATION, SEQUENCES_SQL, SESSION_GUARD_SQL, SESSION_PID_SQL,
  extractContractFromSession, type ContractQueryExecutor,
} from '../src/pg-copy/schema-contract.js'

const SRC = readFileSync(
  fileURLToPath(new URL('../src/pg-copy/export-role.ts', import.meta.url)), 'utf-8')
/**
 * SRC with its `//` comments removed.
 *
 * The comments deliberately name the defects they replaced - the six-bit mask,
 * `renameSync` - so a check that could not tell code from commentary would force
 * those explanations out of the file.
 */
const SRC_CODE = SRC
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').map(l => l.replace(/^\s*\/\/.*$/, '')).join('\n')
const CONTRACT_SRC = readFileSync(
  fileURLToPath(new URL('../src/pg-copy/schema-contract.ts', import.meta.url)), 'utf-8')

/** Registered on creation: a credential root left in /tmp is residue holding a URL. */
const SCRATCH: string[] = []
const scratch = (): string => {
  const base = tmpdir().length > 24 ? '/tmp' : tmpdir()
  const d = mkdtempSync(join(base, 'pgcopy-sec-'))
  mkdirSync(d, { recursive: true, mode: 0o700 })
  SCRATCH.push(d)
  return d
}
afterAll(() => {
  for (const d of SCRATCH) rmSync(d, { recursive: true, force: true })
})

/**
 * SQL with its `--` comments removed.
 *
 * The prohibition is on what a query DOES, not on what its comment says: the
 * comments below deliberately name `pg_sequences` to record why it is not used,
 * and a check that could not tell those apart would force the explanation out of
 * the file.
 */
const executable = (sql: string): string =>
  sql.split('\n').map(l => l.replace(/--.*$/, '')).join('\n')

describe('the contract queries observe no mutable sequence state', () => {
  it('names none of the state-bearing sequence surfaces', () => {
    for (const sql of CONTRACT_QUERIES) {
      const code = executable(sql)
      for (const banned of ['pg_sequences', 'pg_sequence_last_value',
                            'nextval', 'currval', 'setval']) {
        expect(code, banned).not.toContain(banned)
      }
    }
    // NON-VACUITY: the stripper must not be removing the SQL itself.
    expect(executable(SEQUENCES_SQL)).toContain('pg_catalog.pg_sequence sq')
  })

  it('reads sequence definition from pg_sequence, and never from a sequence relation', () => {
    expect(SEQUENCES_SQL).toContain('pg_catalog.pg_sequence sq')
    expect(SEQUENCES_SQL).toContain('sq.seqrelid')
    expect(SEQUENCES_SQL).toContain('pg_catalog.format_type(sq.seqtypid, NULL)')
    for (const f of ['start_value', 'increment_by', 'min_value', 'max_value',
                     'cache_size', 'cycle', 'owned_by', 'data_type']) {
      expect(SEQUENCES_SQL, f).toContain(f)
    }
    // The identity-sequence lateral moved to the same static source.
    expect(executable(COLUMNS_SQL)).toContain('pg_catalog.pg_sequence s ')
    expect(executable(COLUMNS_SQL)).toContain('s.seqrelid = sq.oid')
  })
})

describe('session-bound extraction', () => {
  const guardRows = (pid: string, ro = 'on', iso = REQUIRED_TRANSACTION_ISOLATION): string[][] =>
    [[pid, ro, iso]]

  const executor = (over: Partial<{
    pid: string; guard: string[][]; fail: string; pidAfter: string
  }> = {}): { ex: ContractQueryExecutor; sent: string[] } => {
    const sent: string[] = []
    const pid = over.pid ?? '4242'
    const ex: ContractQueryExecutor = {
      pid,
      rows: async (sql: string) => {
        sent.push(sql)
        if (sql === SESSION_GUARD_SQL) return over.guard ?? guardRows(pid)
        if (sql === SESSION_PID_SQL) return [[over.pidAfter ?? pid]]
        if (over.fail !== undefined && sql.includes(over.fail)) throw new Error('boom')
        if (sql.includes('CROSS JOIN pg_catalog.pg_sequence o')) return []
        return []
      },
    }
    return { ex, sent }
  }

  it('reads pid, read-only and isolation in ONE statement', () => {
    expect(SESSION_GUARD_SQL).toContain('pg_backend_pid')
    expect(SESSION_GUARD_SQL).toContain('transaction_read_only')
    expect(SESSION_GUARD_SQL).toContain('transaction_isolation')
    expect(SESSION_GUARD_SQL.split(';').length).toBe(1)
  })

  it('refuses a mismatched expected pid BEFORE any catalogue query', async () => {
    const { ex, sent } = executor({ pid: '1' })
    await expect(extractContractFromSession(ex, '2')).rejects.toThrow(/not the expected 2/)
    expect(sent.length).toBe(0)
  })

  it('refuses a live pid that disagrees with the declared one', async () => {
    const { ex, sent } = executor({ guard: guardRows('9999') })
    await expect(extractContractFromSession(ex, '4242')).rejects.toThrow(/is backend 9999/)
    expect(sent).toEqual([SESSION_GUARD_SQL])
  })

  it('refuses READ WRITE', async () => {
    const { ex } = executor({ guard: guardRows('4242', 'off') })
    await expect(extractContractFromSession(ex, '4242'))
      .rejects.toThrow(/transaction_read_only is "off"/)
  })

  it('refuses READ COMMITTED', async () => {
    const { ex } = executor({ guard: guardRows('4242', 'on', 'read committed') })
    await expect(extractContractFromSession(ex, '4242'))
      .rejects.toThrow(/transaction_isolation is "read committed"/)
  })

  it('refuses a backend that changes during extraction', async () => {
    const { ex } = executor({ pidAfter: '5555' })
    await expect(extractContractFromSession(ex, '4242'))
      .rejects.toThrow(/became backend 5555/)
  })

  it('fails closed, and redaction-safe, when a query throws', async () => {
    const { ex } = executor({ fail: 'pg_catalog.pg_extension' })
    await expect(extractContractFromSession(ex, '4242')).rejects.toThrow(ContractRefused)
    await expect(extractContractFromSession(ex, '4242')).rejects.toThrow(/contract query failed/)
  })

  it('sends the prelude and all ten queries through the ONE captured executor', async () => {
    const { ex, sent } = executor()
    await expect(extractContractFromSession(ex, '4242')).rejects.toThrow()  // empty catalogue
    // guard + prelude + ten queries were all issued on the same executor.
    expect(sent[0]).toBe(SESSION_GUARD_SQL)
    expect(sent.length).toBeGreaterThanOrEqual(12)
  })

  it('never begins or ends a transaction itself', () => {
    const fn = CONTRACT_SRC.slice(CONTRACT_SRC.indexOf('export async function extractContractFromSession'))
    expect(fn).not.toMatch(/'BEGIN/)
    expect(fn).not.toMatch(/'COMMIT/)
    expect(fn).not.toMatch(/'ROLLBACK/)
    // and it cannot open a connection: the interface carries no connection data.
    expect(fn).not.toMatch(/spawn|createConnection|new Pool|new Client/)
  })
})

describe('the export role grant surface', () => {
  const verifier = deriveScramSha256Verifier('a'.repeat(43))
  const create = createExportRoleSql('ai_capital_v3', verifier)
  const drop = dropExportRoleSql('ai_capital_v3')

  it('is exactly the 21 copied tables, ascending, from the copy authority', () => {
    expect([...EXPORT_TABLES]).toEqual([...COPY_TABLES].sort())
    expect(EXPORT_TABLES.length).toBe(21)
    expect((create.match(/^GRANT SELECT ON [a-z_]+\.[a-z_]+ TO /gm) ?? []).length).toBe(21)
  })

  it('grants the ledger by COLUMN and never by table', () => {
    expect(create).toContain(
      `GRANT SELECT (${LEDGER_COLUMNS.join(', ')}) ON ${LEDGER_RELATION} TO ${EXPORT_ROLE_NAME};`)
    expect(create).not.toMatch(new RegExp(`GRANT SELECT ON ${LEDGER_RELATION}\\b`))
  })

  it('grants no sequence, no broad set, no default, no PUBLIC and no membership', () => {
    for (const banned of ['ON SEQUENCE', 'ON ALL TABLES', 'ON ALL SEQUENCES',
                          'ALTER DEFAULT PRIVILEGES', 'TO PUBLIC', 'pg_read_all',
                          'GRANT pg_', 'WITH ADMIN', 'WITH GRANT OPTION']) {
      expect(create, banned).not.toContain(banned)
    }
  })

  it('creates a role with every dangerous attribute negated', () => {
    for (const a of ['LOGIN', 'NOSUPERUSER', 'NOCREATEDB', 'NOCREATEROLE',
                     'NOBYPASSRLS', 'NOINHERIT', 'NOREPLICATION']) {
      expect(create, a).toContain(a)
    }
  })

  it('is one atomic batch, and so is its exact inverse', () => {
    for (const batch of [create, drop]) {
      expect(batch.startsWith('\\set ON_ERROR_STOP on\n')).toBe(true)
      expect(batch).toContain('\nBEGIN;\n')
      expect(batch.trimEnd().endsWith('COMMIT;')).toBe(true)
      expect(batch).not.toMatch(/EXCEPTION|ON_ERROR_STOP off/)
    }
  })

  it('revokes every single thing it granted, and drops the role', () => {
    for (const t of EXPORT_TABLES) {
      expect(drop, t).toContain(`REVOKE SELECT ON ${t} FROM ${EXPORT_ROLE_NAME};`)
    }
    for (const s of EXPORT_SCHEMAS) {
      expect(drop, s).toContain(`REVOKE USAGE ON SCHEMA ${s} FROM ${EXPORT_ROLE_NAME};`)
    }
    expect(drop).toContain(
      `REVOKE SELECT (${LEDGER_COLUMNS.join(', ')}) ON ${LEDGER_RELATION} FROM ${EXPORT_ROLE_NAME};`)
    expect(drop).toContain(`REVOKE CONNECT ON DATABASE ai_capital_v3 FROM ${EXPORT_ROLE_NAME};`)
    expect(drop).toContain(`DROP ROLE ${EXPORT_ROLE_NAME};`)
    // Counted, so a silently dropped revoke cannot hide among the rest.
    expect((drop.match(/^REVOKE /gm) ?? []).length).toBe(EXPORT_TABLES.length + EXPORT_SCHEMAS.length + 2)
  })

  it('refuses a database name that is not a bare identifier', () => {
    expect(() => createExportRoleSql('ai; DROP DATABASE x', verifier)).toThrow(ExportRoleRefused)
  })
})

describe('psql invocation carries no SQL and no secret', () => {
  it('refuses every argument form that would expose them', () => {
    for (const bad of FORBIDDEN_PSQL_ARGS) {
      expect(() => assertBatchArgs(['--no-psqlrc', bad, 'x']), bad).toThrow(ExportRoleRefused)
    }
    expect(() => assertBatchArgs(['--no-psqlrc', '--set=ON_ERROR_STOP=1'])).toThrow(ExportRoleRefused)
  })

  it('requires --no-psqlrc', () => {
    expect(() => assertBatchArgs(['-h', '/tmp'])).toThrow(/--no-psqlrc/)
    expect(() => assertBatchArgs(['--no-psqlrc', '-h', '/tmp'])).not.toThrow()
  })

  it('builds its own sterile environment, and cannot be handed one', () => {
    const env = sterileBatchEnv()
    expect(Object.keys(env).sort()).toEqual(['LANG', 'LC_ALL', 'PATH'])
    const withPass = sterileBatchEnv('/secret/root/admin.pgpass')
    expect(Object.keys(withPass).sort()).toEqual(['LANG', 'LC_ALL', 'PATH', 'PGPASSFILE'])
    expect(withPass.PGPASSFILE).toBe('/secret/root/admin.pgpass')
    expect(() => sterileBatchEnv('relative.pgpass')).toThrow(/absolute/)
    for (const forbidden of ['PGPASSWORD', 'DATABASE_URL', 'PGHOST', 'PGPORT',
                             'PGUSER', 'PGDATABASE']) {
      expect(withPass[forbidden], forbidden).toBeUndefined()
    }
    // An ALLOW-list, built here - not process.env filtered.
    const fn = SRC.slice(SRC.indexOf('export function sterileBatchEnv'))
    expect(fn.slice(0, fn.indexOf('\n}'))).not.toContain('process.env')
  })

  it('suppresses server logging inside the transaction, before CREATE ROLE', () => {
    // EVERY channel that can print a statement, named exactly. The two sampling
    // settings are individually sufficient and therefore mask each other in a
    // live test; listing them here is what makes removing either one visible,
    // and the live suite proves the PAIR is load-bearing by removing both.
    expect(LOG_SUPPRESSION_SQL.split(';').map(x => x.trim()).filter(x => x !== ''))
      .toEqual([
        "SET LOCAL log_statement = 'none'",
        "SET LOCAL log_min_error_statement = 'panic'",
        'SET LOCAL log_min_duration_statement = -1',
        'SET LOCAL log_min_duration_sample = -1',
        'SET LOCAL log_statement_sample_rate = 0',
      ])
    const batch = createExportRoleSql(
      'ai_capital_v3', deriveScramSha256Verifier(generateExportSecret()))
    expect(batch.indexOf(LOG_SUPPRESSION_SQL)).toBeGreaterThan(batch.indexOf('BEGIN;'))
    expect(batch.indexOf(LOG_SUPPRESSION_SQL)).toBeLessThan(batch.indexOf('CREATE ROLE'))
    // SET LOCAL, so it dies with the transaction and changes nothing persistent.
    expect(LOG_SUPPRESSION_SQL).not.toContain('ALTER SYSTEM')
    expect(LOG_SUPPRESSION_SQL.includes('SET LOCAL')).toBe(true)
  })

  it('silences TRANSACTION sampling before BEGIN, where SET LOCAL is too late', () => {
    expect(TRANSACTION_SAMPLING_SUPPRESSION_SQL).toBe('SET log_transaction_sample_rate = 0;')
    // Session scope, not transaction scope: a transaction is chosen for sampling
    // when it starts, so SET LOCAL inside it would arrive after the decision.
    expect(TRANSACTION_SAMPLING_SUPPRESSION_SQL).not.toContain('SET LOCAL')
    expect(TRANSACTION_SAMPLING_SUPPRESSION_SQL).not.toContain('ALTER SYSTEM')

    const batch = createExportRoleSql(
      'ai_capital_v3', deriveScramSha256Verifier(generateExportSecret()))
    const atSampling = batch.indexOf(TRANSACTION_SAMPLING_SUPPRESSION_SQL)
    const atBegin = batch.indexOf('BEGIN;')
    const atLocal = batch.indexOf(LOG_SUPPRESSION_SQL)
    const atCreate = batch.indexOf('CREATE ROLE')
    const atVerifier = batch.indexOf('SCRAM-SHA-256$')
    expect(atSampling).toBeGreaterThan(-1)
    expect(atSampling, 'transaction sampling must be silenced BEFORE BEGIN').toBeLessThan(atBegin)
    // The other five stay inside the transaction, before the verifier.
    expect(atLocal).toBeGreaterThan(atBegin)
    expect(atLocal).toBeLessThan(atCreate)
    // Every verifier-bearing statement comes after all of it.
    expect(atVerifier).toBeGreaterThan(atSampling)
    expect(atVerifier).toBeGreaterThan(atLocal)
    // Nothing persistent anywhere in the batch.
    expect(batch).not.toContain('ALTER SYSTEM')
    expect(batch).not.toContain('ALTER DATABASE')
    expect(batch).not.toContain('ALTER ROLE ai_capital_v3_export SET')
    // Teardown needs no logging suppression of its own: it carries no verifier
    // and no secret-bearing statement. What it must still not do is change
    // persistent configuration.
    expect(dropExportRoleSql('ai_capital_v3')).not.toContain('ALTER SYSTEM')
  })

  it('writes the batch to stdin and returns only how it ended', () => {
    const fn = SRC.slice(SRC.indexOf('export async function runExportRoleBatch'))
    expect(fn).toContain('child.stdin.end(batch)')
    expect(fn).not.toMatch(/stdout.*batch|return.*stdout/)
  })
})

describe('the secret and its SCRAM verifier', () => {
  it('preserves all 256 bits: 43 unpadded base64url characters', () => {
    const s1 = generateExportSecret()
    const s2 = generateExportSecret()
    // 32 bytes encode to 43 characters unpadded. A 32-CHARACTER secret would be
    // the six-bit-masked generator, which throws away a quarter of the entropy.
    expect(s1.length).toBe(43)
    expect(s1).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(s1).not.toContain('=')
    expect(Buffer.from(s1, 'base64url').length).toBe(32)
    expect(s1).not.toBe(s2)
    expect(() => generateExportSecret(16)).toThrow(/below the reviewed 32/)
    // The masking loop must be gone, not merely unused.
    expect(SRC_CODE).toContain("randomBytes(bytes).toString('base64url')")
    expect(SRC_CODE).not.toMatch(/&\s*0x3f/)
  })

  it('matches the RFC 7677 vector, independently of our own formatting', () => {
    // RFC 7677 section 3: password "pencil", i=4096, and the published
    // ClientProof / ServerSignature for that exchange. Deriving those from our
    // SaltedPassword pins PBKDF2-HMAC-SHA256 and both key derivations against
    // the standard rather than against this file.
    const salt = Buffer.from('W22ZaJ0SNY7soEsUEjb6gQ==', 'base64')
    const sp = scramSaltedPassword('pencil', salt, 4096)
    const clientKey = createHmac('sha256', sp).update('Client Key').digest()
    const storedKey = createHash('sha256').update(clientKey).digest()
    const authMessage =
      'n=user,r=rOprNGfwEbeRWgbNEkqO,' +
      'r=rOprNGfwEbeRWgbNEkqO%hvYDpWUa2RaTCAfuxFIlj)hNlF$k0,s=W22ZaJ0SNY7soEsUEjb6gQ==,i=4096,' +
      'c=biws,r=rOprNGfwEbeRWgbNEkqO%hvYDpWUa2RaTCAfuxFIlj)hNlF$k0'
    const clientSig = createHmac('sha256', storedKey).update(authMessage).digest()
    const proof = Buffer.from(clientKey.map((b, i) => b ^ clientSig[i]))
    expect(proof.toString('base64')).toBe('dHzbZapWIk4jUhN+Ute9ytag9zjfMHgsqmmiz7AndVQ=')
    const serverKey = createHmac('sha256', sp).update('Server Key').digest()
    expect(createHmac('sha256', serverKey).update(authMessage).digest().toString('base64'))
      .toBe('6rriTRBi23WpRR/wtup+mMhUZUn/dB5nLTJRsjl95G4=')

    // AND the production derivation must produce exactly those RFC-pinned keys.
    // Checking only the helpers above would leave the shipped function free to
    // use a different iteration count or a mistyped key label and still pass -
    // which is precisely what two surviving mutants demonstrated.
    expect(SCRAM_ITERATIONS).toBe(4096)
    expect(deriveScramSha256Verifier('pencil', salt)).toBe(
      `SCRAM-SHA-256$4096:${salt.toString('base64')}` +
      `$${storedKey.toString('base64')}:${serverKey.toString('base64')}`)
  })

  it('formats the verifier exactly as PostgreSQL stores it', () => {
    const v = deriveScramSha256Verifier('pencil', Buffer.from('W22ZaJ0SNY7soEsUEjb6gQ==', 'base64'))
    expect(v.startsWith(`SCRAM-SHA-256$${SCRAM_ITERATIONS}:W22ZaJ0SNY7soEsUEjb6gQ==$`)).toBe(true)
    expect(v.split('$').length).toBe(3)
  })

  it('uses a fresh salt every time', () => {
    const a = deriveScramSha256Verifier('pencil')
    const b = deriveScramSha256Verifier('pencil')
    expect(a).not.toBe(b)
  })

  it('refuses a malformed verifier before any SQL is built', () => {
    for (const bad of ['', 'SCRAM-SHA-256$4096:', 'md5abc',
                       'SCRAM-SHA-256$1000:AAAAAAAAAAAAAAAAAAAAAA==$AA==:AA==',
                       "SCRAM-SHA-256$4096:AAAAAAAAAAAAAAAAAAAAAA==$x'y:AA=="]) {
      expect(() => assertScramVerifier(bad), bad).toThrow(ExportRoleRefused)
      expect(() => createExportRoleSql('ai_capital_v3', bad), bad).toThrow(ExportRoleRefused)
    }
  })

  it('refuses a salt below the reviewed minimum', () => {
    expect(() => deriveScramSha256Verifier('pencil', randomBytes(8))).toThrow(/below the reviewed/)
  })
})

describe('the credential URL and its publication', () => {
  const target = { socketDir: '/tmp/pgcopy-abc', port: 5433, database: 'ai_capital_v3' }

  it('percent-encodes every component', () => {
    const secret = generateExportSecret()
    expect(secret.length).toBe(43)
    const url = buildExportCredentialUrl(target, 'a-b_c')
    expect(url).toContain(`postgresql://${EXPORT_ROLE_NAME}:a-b_c@/ai_capital_v3`)
    // A real 43-character base64url secret needs no escaping either.
    expect(buildExportCredentialUrl(target, secret)).toContain(`:${secret}@`)
    expect(url).toContain('host=%2Ftmp%2Fpgcopy-abc')
    expect(url).toContain('port=5433')
  })

  it('publishes atomically at 0600 with link count 1', () => {
    const root = scratch()
    const p = publishExportCredential(root, 'export.url', 'postgresql://x')
    expect(readFileSync(p, 'utf-8')).toBe('postgresql://x')
    const s = statSync(p)
    expect(s.mode & 0o777).toBe(0o600)
    expect(s.nlink).toBe(1)
    removeExportCredential(p, root, 'export.url')
  })

  it('never overwrites an existing credential', () => {
    const root = scratch()
    writeFileSync(join(root, 'export.url'), 'OLD', { mode: 0o600 })
    expect(() => publishExportCredential(root, 'export.url', 'NEW')).toThrow(/already exists/)
    expect(readFileSync(join(root, 'export.url'), 'utf-8')).toBe('OLD')
  })

  it('publishes with link(), never with rename()', () => {
    // rename() OVERWRITES its destination, which is the entire defect: an
    // absence check followed by a rename loses every race silently.
    expect(SRC_CODE).toContain('linkSync(tmpPath, finalPath)')
    expect(SRC_CODE).not.toContain('renameSync')
  })

  it('loses the race rather than clobbering a destination created after the check', () => {
    const root = scratch()
    // Simulate the racer by taking the name after the absence check would have
    // passed: the module is called with the name already taken, and link fails.
    const finalPath = join(root, 'export.url')
    writeFileSync(finalPath, 'RACER', { mode: 0o600 })
    expect(() => publishExportCredential(root, 'export.url', 'OURS')).toThrow()
    expect(readFileSync(finalPath, 'utf-8')).toBe('RACER')
    // No temporary file survives the loss.
    const { readdirSync } = require('node:fs') as typeof import('node:fs')
    expect(readdirSync(root).filter(f => f.endsWith('.tmp'))).toEqual([])
  })

  it('survives a directory or a dangling symlink at the final path', () => {
    const rootA = scratch()
    mkdirSync(join(rootA, 'export.url'))
    expect(() => publishExportCredential(rootA, 'export.url', 'NEW')).toThrow()
    expect(lstatSync(join(rootA, 'export.url')).isDirectory()).toBe(true)

    const rootB = scratch()
    symlinkSync(join(rootB, 'gone'), join(rootB, 'export.url'))
    expect(() => publishExportCredential(rootB, 'export.url', 'NEW')).toThrow()
    expect(lstatSync(join(rootB, 'export.url')).isSymbolicLink()).toBe(true)
  })

  it('refuses every filename that is not one plain basename', () => {
    const root = scratch()
    for (const bad of ['../victim', '/etc/passwd', 'a/b', 'a\\b', '.', '..', '',
                       'sub/../export.url']) {
      expect(() => assertCredentialFilename(root, bad), bad).toThrow(ExportRoleRefused)
      expect(() => publishExportCredential(root, bad, 'x'), bad).toThrow(ExportRoleRefused)
    }
    expect(assertCredentialFilename(root, 'export.url')).toBe(join(root, 'export.url'))
  })

  it('leaves a decoy sibling untouched on every failure path', () => {
    const root = scratch()
    const decoy = join(root, 'decoy')
    writeFileSync(decoy, 'keep me', { mode: 0o600 })
    for (const bad of ['../victim', 'a/b', '..']) {
      expect(() => publishExportCredential(root, bad, 'x')).toThrow()
    }
    writeFileSync(join(root, 'export.url'), 'OLD', { mode: 0o600 })
    expect(() => publishExportCredential(root, 'export.url', 'x')).toThrow()
    expect(readFileSync(decoy, 'utf-8')).toBe('keep me')
  })

  it('publishes the very inode it prepared', () => {
    const root = scratch()
    const p = publishExportCredential(root, 'export.url', 'postgresql://x')
    const st = lstatSync(p)
    expect(st.nlink).toBe(1)
    expect(st.isFile()).toBe(true)
    expect(st.isSymbolicLink()).toBe(false)
    // The temporary link was removed, so exactly one name points at the inode.
    const { readdirSync } = require('node:fs') as typeof import('node:fs')
    expect(readdirSync(root)).toEqual(['export.url'])
    removeExportCredential(p, root, 'export.url')
  })

  it('reports every POST-LINK failure as published-but-unverified, by phase', () => {
    // These branches only fire when the filesystem misbehaves, so the operations
    // are injected. The fsync order inside publication is fixed and short: (1)
    // the temporary FILE, (2) the parent after link, (3) the parent after the
    // temporary link is removed - so a call counter picks a phase exactly.
    type Wrap = (o: PublishOps) => PublishOps
    const failNthFsync = (n: number): Wrap => o => {
      let calls = 0
      return { ...o, fsyncSync: (fd: number) => {
        calls += 1
        if (calls === n) throw new Error('injected')
        o.fsyncSync(fd)
      } }
    }
    const afterLink = (
      f: (o: PublishOps, published: () => boolean) => Partial<PublishOps>,
    ): Wrap => o => {
      let done = false
      const base: PublishOps = {
        ...o,
        linkSync: (a, b) => { o.linkSync(a, b); done = true },
      }
      return { ...base, ...f(base, () => done) }
    }

    const cases: Array<[PublishPhase, Wrap]> = [
      ['fsync-parent-1', failNthFsync(2)],
      ['unlink-temp', afterLink(o => ({
        unlinkSync: p => { if (String(p).endsWith('.tmp')) throw new Error('injected'); o.unlinkSync(p) },
      }))],
      ['fsync-parent-2', failNthFsync(3)],
      ['lstat', afterLink((o, published) => ({
        lstatSync: ((path: string) => {
          if (published() && path.endsWith('export.url')) throw new Error('injected')
          return o.lstatSync(path)
        }) as PublishOps['lstatSync'],
      }))],
      ['verify', afterLink((o, published) => ({
        lstatSync: ((path: string) => {
          const st = o.lstatSync(path) as Stats
          if (published() && path.endsWith('export.url')) {
            // Same file, reported with a different inode: verification must fail.
            return Object.assign(Object.create(Object.getPrototypeOf(st) as object),
              st, { ino: st.ino + 1 }) as Stats
          }
          return st
        }) as PublishOps['lstatSync'],
      }))],
    ]

    for (const [phase, wrap] of cases) {
      const root = scratch()
      const decoy = join(root, 'decoy')
      writeFileSync(decoy, 'keep me', { mode: 0o600 })
      let thrown: unknown = null
      try {
        publishExportCredential(root, 'export.url', 'postgresql://x', wrap(REAL_PUBLISH_OPS))
      } catch (e) { thrown = e }

      expect(thrown, `${phase} did not fail`).toBeInstanceOf(CredentialPublishedButUnverified)
      const err = thrown as CredentialPublishedButUnverified
      expect(err.phase, `${phase} reported the wrong phase`).toBe(phase)
      expect(err.finalPath).toBe(join(root, 'export.url'))
      // The credential is STILL THERE - never tidied away.
      expect(lstatSync(err.finalPath).isFile(), `${phase} removed the credential`).toBe(true)
      expect(readFileSync(err.finalPath, 'utf-8')).toBe('postgresql://x')
      // The unrelated sibling is untouched.
      expect(readFileSync(decoy, 'utf-8')).toBe('keep me')
      // Nothing sensitive, and no filesystem error text, in the message.
      expect(err.message).not.toContain('postgresql://')
      expect(err.message).not.toContain('SCRAM-SHA-256$')
      expect(err.message).not.toContain('injected')
      expect(err.message.toLowerCase()).not.toContain('enoent')
      // A failure at or before the temporary unlink preserves BOTH links.
      if (phase === 'fsync-parent-1' || phase === 'unlink-temp') {
        expect(lstatSync(err.temporaryPath).isFile(), `${phase} lost the temporary`).toBe(true)
      }
    }
  })

  it('refuses a secret root that is not a 0700 directory it owns', () => {
    const root = scratch()
    chmodSync(root, 0o755)
    expect(() => publishExportCredential(root, 'export.url', 'NEW')).toThrow(/mode 755/)
    chmodSync(root, 0o700)
    expect(() => publishExportCredential('/tmp/does-not-exist-pgcopy', 'export.url', 'x'))
      .toThrow(/not an existing directory/)
  })

  it('carries only paths and a phase in the structured error', () => {
    const e = new CredentialPublishedButUnverified('/r/f', '/r/.t', 'verify')
    expect(e.finalPath).toBe('/r/f')
    expect(e.temporaryPath).toBe('/r/.t')
    expect(e.phase).toBe('verify')
    expect(e.message).toContain('has NOT been removed')
  })

  it('removes only the exact published path', () => {
    const root = scratch()
    const p = publishExportCredential(root, 'export.url', 'x')
    writeFileSync(join(root, 'decoy'), 'keep me', { mode: 0o600 })
    expect(() => removeExportCredential(join(root, 'decoy'), root, 'export.url'))
      .toThrow(/not the published path/)
    // Removal applies the same confinement rules as publication.
    expect(() => removeExportCredential(join(root, '../victim'), root, '../victim'))
      .toThrow(ExportRoleRefused)
    expect(readFileSync(join(root, 'decoy'), 'utf-8')).toBe('keep me')
    removeExportCredential(p, root, 'export.url')
  })
})

describe('the published credential url is parsed, not assumed', () => {
  const target = { socketDir: '/tmp/pgcopy-abc', port: 5433, database: 'ai_capital_v3' }

  it('round-trips exactly what buildExportCredentialUrl wrote', () => {
    const secret = generateExportSecret()
    const parsed = parseCredentialUrl(buildExportCredentialUrl(target, secret))
    expect(parsed).toEqual({
      user: EXPORT_ROLE_NAME, password: secret,
      database: 'ai_capital_v3', host: '/tmp/pgcopy-abc', port: '5433',
    })
  })

  it('refuses every malformed credential url', () => {
    for (const bad of [
      'postgres://u:p@/db?host=/tmp&port=1',                 // wrong scheme
      'postgresql:///db?host=/tmp&port=1',                   // no credentials
      'postgresql://u@/db?host=/tmp&port=1',                 // no password
      'postgresql://u:p@/db?port=1',                         // no host
      'postgresql://u:p@/db?host=/tmp',                      // no port
      'postgresql://u:p@/?host=/tmp&port=1',                 // no database
      'postgresql://u:p@localhost/db',                       // not the socket form
      'postgresql://:p@/db?host=/tmp&port=1',                // empty user
      'postgresql://u:@/db?host=/tmp&port=1',                // empty password
    ]) {
      expect(() => parseCredentialUrl(bad), bad).toThrow()
    }
  })
})

describe('the canonical semantic census', () => {
  const raw = (over: Partial<RawCensus> = {}): RawCensus => ({
    roles: [['alice', 'false', 'true', 'false', 'false', 'true', 'false', 'false', '-1', '']],
    rolconfig: [], memberships: [],
    database: [['ai_capital_v3', 'owner', '-1', 'true', 'false', 'UTF8', 'en_US.UTF-8',
                'en_US.UTF-8', 'owner', 'PUBLIC', 'CONNECT', 'false']],
    schemas: [['capital', 'owner', 'owner', 'alice', 'USAGE', 'false']],
    relations: [['capital.chunks', 'r', 'owner', 'owner', 'alice', 'SELECT', 'false']],
    columns: [[`${LEDGER_RELATION}.filename`, 'owner', 'owner', 'alice', 'SELECT', 'false']],
    defaultAcls: [], ...over,
  })

  it('renders PUBLIC literally and never emits an acl_is_default marker', () => {
    const doc = censusJson(raw())
    expect(doc).toContain('"PUBLIC"')
    expect(doc).not.toContain('acl_is_default')
    expect(CENSUS_QUERIES.join('\n')).not.toContain('acl_is_default')
  })

  it('normalizes a NULL ACL through acldefault before exploding it', () => {
    for (const sql of CENSUS_QUERIES) {
      if (sql.includes('aclexplode') && !sql.includes('defaclacl')) {
        expect(sql).toContain('pg_catalog.acldefault(')
        expect(sql).toContain('COALESCE(')
      }
    }
  })

  it('resolves every principal to a name, never an OID', () => {
    for (const sql of CENSUS_QUERIES) {
      expect(sql).not.toMatch(/SELECT[^;]*\ba\.grantee\b(?!\s*=\s*0)[^;]*AS\s+\w*oid/i)
      if (sql.includes('grantee')) expect(sql).toContain('pg_get_userbyid(a.grantee)')
    }
  })

  it('is deterministic regardless of row order', () => {
    const r = raw({ roles: [
      ['bob', 'false', 'true', 'false', 'false', 'true', 'false', 'false', '-1', ''],
      ['alice', 'false', 'true', 'false', 'false', 'true', 'false', 'false', '-1', ''],
    ] })
    const reversed = raw({ roles: [...r.roles].reverse() })
    expect(censusDigest(censusJson(r))).toBe(censusDigest(censusJson(reversed)))
  })

  it('excludes ONLY the exact role name, never a prefix', () => {
    const decoy = `${EXPORT_ROLE_NAME}_legacy`
    const r = raw({ roles: [
      [EXPORT_ROLE_NAME, 'false', 'false', 'false', 'false', 'true', 'false', 'false', '-1', ''],
      [decoy, 'false', 'false', 'false', 'false', 'true', 'false', 'false', '-1', ''],
    ] })
    const doc = censusJson(r, { excludeRoleExactly: EXPORT_ROLE_NAME })
    expect(doc).not.toContain(`"${EXPORT_ROLE_NAME}",`)
    expect(doc).toContain(decoy)
  })

  it('keeps a pre-existing GRANTOR even when the excluded role is the grantee', () => {
    const r = raw({ relations: [
      ['capital.chunks', 'r', 'owner', 'owner', EXPORT_ROLE_NAME, 'SELECT', 'false'],
      ['capital.chunks', 'r', 'owner', EXPORT_ROLE_NAME, 'alice', 'SELECT', 'false'],
    ] })
    const doc = censusJson(r, { excludeRoleExactly: EXPORT_ROLE_NAME })
    // the grant TO the role is gone; the grant BY it to a pre-existing role stays
    expect(doc).toContain('"alice"')
    expect((doc.match(new RegExp(EXPORT_ROLE_NAME, 'g')) ?? []).length).toBe(1)
  })

  it('keeps a membership the excluded role merely GRANTED', () => {
    // granted role = pre-existing A, member = pre-existing B, grantor = the
    // temporary role. That grant outlives the temporary role, so dropping it
    // would let the census call a real leftover clean.
    const r = raw({ memberships: [
      ['role_a', 'role_b', EXPORT_ROLE_NAME, 'false', 'true', 'true'],
      [EXPORT_ROLE_NAME, 'role_b', 'owner', 'false', 'true', 'true'],
      ['role_a', EXPORT_ROLE_NAME, 'owner', 'false', 'true', 'true'],
    ] })
    const doc = censusJson(r, { excludeRoleExactly: EXPORT_ROLE_NAME })
    const parsed = JSON.parse(doc) as { memberships: string[][] }
    expect(parsed.memberships.length).toBe(1)
    expect(parsed.memberships[0]).toEqual(
      ['role_a', 'role_b', EXPORT_ROLE_NAME, 'false', 'true', 'true'])
    // ... and it therefore causes drift against a census without it.
    expect(censusDigest(doc)).not.toBe(censusDigest(censusJson(raw())))
  })

  it('refuses an empty exclusion name', () => {
    expect(() => censusJson(raw(), { excludeRoleExactly: '' })).toThrow(CensusRefused)
  })
})
