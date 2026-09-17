// THE LEGACY-COPY SOURCE CONTRACT, proved without a database.
//
// Nothing here opens a PostgreSQL connection. Where a pool is needed it is the
// REAL `createPool` - which registers the destination the write-intent gate
// reads - with `connect` and `end` replaced, so the gate is exercised for real
// while no socket is opened. The SQLite and JSONL fixtures are fabricated and
// written into a mkdtemp directory that is removed afterwards.

import {
  mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  ADAPTER_ORDER,
  CREDENTIAL_VAR,
  COLD_PRESERVED_TABLES,
  CopyRefused,
  FORBIDDEN_FALLBACK_VARS,
  REQUIRED_CREDENTIAL_ROLE,
  SOURCE_ROOT_VAR,
  TARGET_SEQUENCES,
  TARGET_TABLES,
  assertFreshTargets,
  assertSqliteSchema,
  assertCompleteSnapshot,
  assertTargetIdentity,
  canonicalDigest,
  canonicalCountManifest,
  expectFailure,
  openSourceSqlite,
  readSourceHead,
  requireDatabaseName,
  allSnapshotPaths,
  sourceFingerprints,
  readSequenceStates,
  requireBooleanInt,
  requireNullableBooleanInt,
  resolveCredential,
  resolveSourceRoot,
  runLegacyCopy,
} from '../src/legacy-copy.js'
import { createPool } from '../src/pool.js'
import { CURRENT_V19_MANIFEST } from '../src/inventory-queries.js'
import { copyLance } from '../src/legacy-copy/lance.js'
import {
  CANONICAL_UUID_RE,
  scanLanceChunks,
  uuidPartitions,
  vectorToPg,
  sanitizeText,
  emptyToNull,
} from '../src/legacy-copy/lance.js'
import { copyPortfolio } from '../src/legacy-copy/portfolio.js'
import { copyCapital } from '../src/legacy-copy/capital.js'
import { copyThesis } from '../src/legacy-copy/thesis.js'
import { copyBriefing } from '../src/legacy-copy/briefing.js'
import { copyGraph } from '../src/legacy-copy/graph.js'
import {
  CHUNK_ID_A,
  EXACT_DECIMAL,
  FIXTURE_HEAD,
  QUOTED_REASON,
  UNICODE_COMPANY,
  fakeLanceTable,
  fixtureIdsAreCanonical,
  negativeChunksDuplicateId,
  negativeChunksNoncanonicalId,
  negativeChunksWrongDimension,
  positiveChunks,
  writeNegativeCorruptSqlite,
  writeNegativeInvalidBoolean,
  writeNegativeMalformedJsonl,
  writeNegativeMissingJsonl,
  writeNegativeNullBoolean,
  writeNegativeSchemaDrift,
  writePositiveFixtures,
  writeQaJsonlPopulated,
  NUL_CONTENT,
  NUL_CONTENT_SANITIZED,
  emptyLanceDirectory,
  fifoInsideLance,
  removeSnapshotPath,
  symlinkInsideLance,
  symlinkRequiredFile,
} from '../testing/legacy-copy-fixtures.js'
import type { ConfirmedPlan, TargetIdentity } from '../src/legacy-copy.js'
import { CopyCommitOutcomeUnknown, configuredSocketDirectories } from '../src/legacy-copy.js'
import {
  COMMIT_UNKNOWN_MESSAGE,
  EXIT_COMMIT_UNKNOWN,
  EXIT_FAILED,
  EXIT_OK,
  EXIT_REFUSED,
  expectedConfirmation,
  isDirectEntrypoint,
  parseArgs,
  planCopy,
  runCli,
} from '../bin/legacy-copy.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC = join(HERE, '..', 'src')
const BIN = join(HERE, '..', 'bin')
const ADAPTER_FILES = ADAPTER_ORDER.map(n => join(SRC, 'legacy-copy', `${n}.ts`))

const GOOD_URL =
  `postgresql://${REQUIRED_CREDENTIAL_ROLE}@localhost:5435/ai_capital_copy_rehearsal`

let root = ''
// realpathSync because /var is a symlink to /private/var on macOS, and the
// module deliberately refuses a non-canonical root.
beforeEach(() => { root = realpathSync(mkdtempSync(join(tmpdir(), 'zz-copy-'))) })
afterEach(() => { rmSync(root, { recursive: true, force: true }) })

// ---------------------------------------------------------------------------
// A recording client. Every statement the orchestrator or an adapter sends
// lands here, so "exactly one transaction" and "refused before the first
// destructive statement" are observations, not assertions of intent.
// ---------------------------------------------------------------------------

interface FakeOpts {
  counts?: Record<string, number>
  identity?: Record<string, unknown>
  ledger?: { filename: string; sha256: string; applied_at: string }[]
  /** Per-sequence reply: a row, several rows, or the string 'none' for zero. */
  sequences?: Record<string, { last_value: unknown; is_called: unknown } |
    { last_value: unknown; is_called: unknown }[] | 'none'>
  failOn?: RegExp
  ignoreSetRole?: boolean
}

function fakeClient(opts: FakeOpts = {}) {
  const statements: string[] = []
  const identity = {
    database: 'ai_capital_copy_rehearsal',
    session_user: REQUIRED_CREDENTIAL_ROLE,
    current_user: REQUIRED_CREDENTIAL_ROLE,
    server_version_num: 170010,
    system_identifier: '7000000000000000000',
    configured_port: 5435,
    unix_transport: true,
    socket_directories: '/tmp/zz-sock',
    ...(opts.identity ?? {}),
  }
  let assumedOwner = false
  const client = {
    statements,
    released: 0,
    // `_values` is accepted and deliberately unused: nothing this fake answers is
    // parameterised any more. The sequence read that used to need $1/$2 is now a
    // direct, escaped relation read.
    async query(text: string, _values?: unknown[]) {
      statements.push(text.replace(/\s+/g, ' ').trim())
      if (opts.failOn && opts.failOn.test(text)) {
        const err = new Error(`injected failure: ${text.slice(0, 40)}`) as Error & { code?: string }
        err.code = '42501'
        throw err
      }
      if (/^SET LOCAL ROLE/.test(text)) {
        if (!opts.ignoreSetRole) assumedOwner = true
        return { rows: [], rowCount: 0 }
      }
      if (/current_database\(\)/.test(text)) {
        return {
          rows: [{ ...identity, current_user: assumedOwner ? 'ai_capital_owner' : identity.current_user }],
          rowCount: 1,
        }
      }
      if (/FROM db\.schema_migrations/.test(text)) {
        const rows = opts.ledger ?? CURRENT_V19_MANIFEST.map(m => ({
          filename: m.filename, sha256: m.sha256, applied_at: '2026-01-01T00:00:00Z',
        }))
        return { rows, rowCount: rows.length }
      }
      const count = /SELECT count\(\*\)::int AS n FROM ([a-z_]+\.[a-z_]+)/.exec(text)
      if (count) return { rows: [{ n: opts.counts?.[count[1]] ?? 0 }], rowCount: 1 }
      // The three DIRECT, QUOTED sequence-relation reads. pg_sequences is NOT
      // recognised here: it has no is_called column in PostgreSQL 17, and a fake
      // that answered one is exactly what let impossible SQL pass review.
      const seq = /^SELECT last_value::text AS last_value, is_called FROM "([a-z_]+)"\."([a-z_]+)"$/
        .exec(text)
      if (seq) {
        const name = `${seq[1]}.${seq[2]}`
        const st = opts.sequences?.[name] ?? { last_value: '1', is_called: false }
        return { rows: st === 'none' ? [] : Array.isArray(st) ? st : [st], rowCount: 1 }
      }
      return { rows: [], rowCount: 0 }
    },
    release() { client.released++ },
  }
  return client
}

function poolFactory(client: ReturnType<typeof fakeClient>) {
  return (url: string) => {
    const pool = createPool(url)
    ;(pool as unknown as { connect: () => Promise<unknown> }).connect = async () => client
    ;(pool as unknown as { end: () => Promise<void> }).end = async () => {}
    return pool
  }
}

/** Source with comment-only lines removed: the prose deliberately NAMES the
 *  things the code must not do, so a static scan has to read code, not prose. */
function codeOf(file: string): string {
  return readFileSync(file, 'utf-8')
    .split('\n')
    .filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n')
}

/** codeOf, with single- and double-quoted STRINGS blanked as well. A refusal
 *  message that names `process.cwd()` is the module explaining what it refuses
 *  to do; only an actual call is a violation. Backtick templates are left
 *  intact, because the SQL checks need to read them. */
function executableOf(file: string): string {
  return codeOf(file).replace(/'[^'\n]*'/g, "''").replace(/"[^"\n]*"/g, '""')
}

const SYSTEM_ID = '7000000000000000000'
const PORT = 5435
const SOCKET = '/tmp/zz-sock'

async function positiveEnv(): Promise<NodeJS.ProcessEnv> {
  await writePositiveFixtures(root)
  return { [CREDENTIAL_VAR]: GOOD_URL, [SOURCE_ROOT_VAR]: root }
}

/** The plan an operator would have confirmed for the current snapshot. */
function planFor(env: NodeJS.ProcessEnv): ConfirmedPlan {
  const out = planCopy(env, parseArgs([
    `--expect-system-identifier=${SYSTEM_ID}`, `--expect-port=${PORT}`, `--expect-socket=${SOCKET}`,
  ]))
  if (!out.plan) throw new Error('fixture plan is incomplete')
  return out.plan
}

const noopAdapters = () =>
  Object.fromEntries(ADAPTER_ORDER.map(n => [n, async () => []])) as Record<string, () => Promise<[]>>


// ---------------------------------------------------------------------------

describe('imports are inert', () => {
  it('no module in the legacy-copy surface executes at import time', () => {
    for (const f of [join(SRC, 'legacy-copy.ts'), ...ADAPTER_FILES, join(BIN, 'legacy-copy.ts')]) {
      const text = readFileSync(f, 'utf-8')
      const bare = text
        .split('\n')
        .filter(l => /^(main|run|runCli|runLegacyCopy)\s*\(/.test(l))
      expect(bare, `${f} calls a runner at module scope`).toEqual([])
    }
  })

  it('the CLI runs only when it is the process entry point', () => {
    const text = readFileSync(join(BIN, 'legacy-copy.ts'), 'utf-8')
    expect(text).toContain('isDirectEntrypoint(process.argv[1], import.meta.url)')
    expect(isDirectEntrypoint(undefined, import.meta.url)).toBe(false)
    expect(isDirectEntrypoint('/definitely/not/this/file.ts', import.meta.url)).toBe(false)
  })

  it('importing the CLI parsed no environment and opened nothing', () => {
    // If it had, importing this test file would already have thrown: no
    // AI_CAPITAL_COPY_* variable is set in this process.
    expect(process.env[CREDENTIAL_VAR]).toBeUndefined()
    expect(parseArgs([]).apply).toBe(false)
  })
})

describe('explicit inputs only', () => {
  it('an unset credential refuses and names the variable', () => {
    expect(() => resolveCredential({})).toThrow(new RegExp(CREDENTIAL_VAR))
  })

  it('a blank or whitespace credential refuses', () => {
    expect(() => resolveCredential({ [CREDENTIAL_VAR]: '' })).toThrow(/empty or whitespace/)
    expect(() => resolveCredential({ [CREDENTIAL_VAR]: '   ' })).toThrow(/empty or whitespace/)
  })

  it('a credential naming another role refuses', () => {
    const url = 'postgresql://ai_capital_owner@localhost:5435/ai_capital_copy_rehearsal'
    expect(() => resolveCredential({ [CREDENTIAL_VAR]: url })).toThrow(/ai_capital_migrator/)
  })

  it('an incomplete credential refuses rather than inheriting components', () => {
    expect(() => resolveCredential({ [CREDENTIAL_VAR]: 'postgresql://localhost' }))
      .toThrow(/must state its/)
  })

  it.each([...FORBIDDEN_FALLBACK_VARS])('%s is never a fallback', varName => {
    const env: NodeJS.ProcessEnv = { [varName]: GOOD_URL }
    expect(() => resolveCredential(env)).toThrow(new RegExp(CREDENTIAL_VAR))
    expect(() => resolveSourceRoot(env)).toThrow(new RegExp(SOURCE_ROOT_VAR))
  })

  it('no legacy-copy source reads a forbidden variable', () => {
    for (const f of [join(SRC, 'legacy-copy.ts'), ...ADAPTER_FILES, join(BIN, 'legacy-copy.ts')]) {
      const text = executableOf(f)
      for (const v of FORBIDDEN_FALLBACK_VARS) {
        const reads = new RegExp(`(process\\\\.)?env(\\\\.|\\\\[['"])${v}`)
        expect(reads.test(text), `${f} reads ${v}`).toBe(false)
      }
      expect(/process\.cwd\(\)/.test(text), `${f} uses process.cwd()`).toBe(false)
    }
  })

  it('the source root must be set, absolute, existing and canonical', () => {
    expect(() => resolveSourceRoot({})).toThrow(/is not set/)
    expect(() => resolveSourceRoot({ [SOURCE_ROOT_VAR]: '' })).toThrow(/empty or whitespace/)
    expect(() => resolveSourceRoot({ [SOURCE_ROOT_VAR]: ' /tmp' })).toThrow(/whitespace/)
    expect(() => resolveSourceRoot({ [SOURCE_ROOT_VAR]: 'relative/path' })).toThrow(/absolute/)
    expect(() => resolveSourceRoot({ [SOURCE_ROOT_VAR]: join(root, 'nope') })).toThrow(/does not exist/)
    expect(resolveSourceRoot({ [SOURCE_ROOT_VAR]: root })).toBe(root)
  })

  it('a symlinked source root is refused rather than resolved', () => {
    const real = join(root, 'real')
    const link = join(root, 'link')
    mkdirSync(real, { recursive: true })
    symlinkSync(real, link)
    expect(() => resolveSourceRoot({ [SOURCE_ROOT_VAR]: link })).toThrow(/is not canonical/)
  })
})

describe('the CLI requires --apply and an exact confirmation', () => {
  it('default mode constructs no pool and sends no SQL', async () => {
    const env = await positiveEnv()
    let poolsMade = 0
    const r = await runCli([], env, {
      copy: (async () => { poolsMade++; throw new Error('must not run') }) as never,
    })
    expect(r.exitCode).toBe(0)
    expect(poolsMade).toBe(0)
    expect(r.lines.join('\n')).toContain('INSPECT ONLY')
  })

  it('--apply without a confirmation refuses', async () => {
    const env = await positiveEnv()
    const flags = [
      `--expect-system-identifier=${SYSTEM_ID}`, `--expect-port=${PORT}`, `--expect-socket=${SOCKET}`,
    ]
    const r = await runCli([...flags, '--apply'], env,
      { copy: (async () => { throw new Error('x') }) as never })
    expect(r.exitCode).toBe(2)
    expect(r.lines.join('\n')).toContain('requires --confirm')
  })

  it('a wrong confirmation refuses and does not echo what was supplied', async () => {
    const env = await positiveEnv()
    const flags = [
      `--expect-system-identifier=${SYSTEM_ID}`, `--expect-port=${PORT}`, `--expect-socket=${SOCKET}`,
    ]
    const r = await runCli([...flags, '--apply', '--confirm=copy something else'], env,
      { copy: (async () => { throw new Error('must not run') }) as never })
    expect(r.exitCode).toBe(2)
    expect(r.lines.join('\n')).toContain('does not match')
    expect(r.lines.join('\n')).not.toContain('copy something else')
  })

  it('the exact confirmation is required and names the whole plan', async () => {
    const env = await positiveEnv()
    const plan = planFor(env)
    const flags = [
      `--expect-system-identifier=${SYSTEM_ID}`, `--expect-port=${PORT}`, `--expect-socket=${SOCKET}`,
    ]
    let ran = 0
    const r = await runCli([...flags, '--apply', `--confirm=${expectedConfirmation(plan)}`], env, {
      copy: (async () => {
        ran++
        return { migrationCount: 19, sequences: [], countManifestDigest: 'zz', results: [] }
      }) as never,
    })
    expect(ran).toBe(1)
    expect(r.exitCode).toBe(0)
    expect(expectedConfirmation(plan)).toContain(FIXTURE_HEAD)
    expect(expectedConfirmation(plan)).toContain(plan.sourceDigest)
  })

  it('an unknown argument refuses', async () => {
    const env = await positiveEnv()
    const r = await runCli(['--force'], env)
    expect(r.exitCode).toBe(2)
  })
})

describe('one transaction owner', () => {
  it('the orchestrator opens exactly one BEGIN and one COMMIT', async () => {
    const env = await positiveEnv()
    const client = fakeClient()
    await runLegacyCopy({
      env,
      plan: planFor(env),
      createPoolFn: poolFactory(client),
      adapters: Object.fromEntries(ADAPTER_ORDER.map(n => [n, async () => []])),
    })
    expect(client.statements.filter(s => s === 'BEGIN')).toHaveLength(1)
    expect(client.statements.filter(s => s === 'COMMIT')).toHaveLength(1)
    expect(client.statements.filter(s => s === 'ROLLBACK')).toHaveLength(0)
    expect(client.released).toBe(1)
  })

  it('the identity, ledger and role statements precede every adapter', async () => {
    const env = await positiveEnv()
    const client = fakeClient()
    let firstAdapterAt = -1
    await runLegacyCopy({
      env,
      plan: planFor(env),
      createPoolFn: poolFactory(client),
      adapters: Object.fromEntries(ADAPTER_ORDER.map(n => [n, async () => {
        if (firstAdapterAt === -1) firstAdapterAt = client.statements.length
        return []
      }])),
    })
    const idx = (re: RegExp) => client.statements.findIndex(s => re.test(s))
    expect(idx(/^BEGIN$/)).toBeLessThan(idx(/current_database/))
    expect(idx(/current_database/)).toBeLessThan(idx(/schema_migrations/))
    expect(idx(/schema_migrations/)).toBeLessThan(idx(/^SET LOCAL ROLE ai_capital_owner$/))
    expect(idx(/^SET LOCAL ROLE ai_capital_owner$/))
      .toBeLessThan(idx(/^SET LOCAL search_path = pg_catalog$/))
    expect(idx(/^SET LOCAL search_path = pg_catalog$/)).toBeLessThan(firstAdapterAt)
  })

  it('a mid-copy failure produces exactly one ROLLBACK and no COMMIT', async () => {
    const env = await positiveEnv()
    const client = fakeClient()
    await expect(runLegacyCopy({
      env,
      plan: planFor(env),
      createPoolFn: poolFactory(client),
      adapters: {
        ...Object.fromEntries(ADAPTER_ORDER.map(n => [n, async () => []])),
        graph: async () => { throw new Error('zz adapter failure') },
      },
    })).rejects.toThrow(/zz adapter failure/)
    expect(client.statements.filter(s => s === 'ROLLBACK')).toHaveLength(1)
    expect(client.statements.filter(s => s === 'COMMIT')).toHaveLength(0)
    expect(client.released).toBe(1)
  })

  it('adapters own no transaction, pool or process lifecycle', () => {
    const forbidden = [
      /\bBEGIN\b/, /\bCOMMIT\b/, /\bROLLBACK\b/, /SET ROLE/, /\bgetPool\b/,
      /\bcreatePool\b/, /\bclosePool\b/, /process\.exit/,
    ]
    for (const f of ADAPTER_FILES) {
      const code = codeOf(f) // strings intact: the SQL keywords live inside them
      for (const re of forbidden) {
        expect(re.test(code), `${f} contains ${re}`).toBe(false)
      }
    }
  })
})

describe('fresh-target semantics', () => {
  it('all 21 declared tables are counted', async () => {
    const client = fakeClient()
    await assertFreshTargets(client)
    const counted = client.statements
      .map(s => /FROM ([a-z_]+\.[a-z_]+)$/.exec(s)?.[1])
      .filter((x): x is string => !!x)
    expect(TARGET_TABLES).toHaveLength(21)
    expect(counted.sort()).toEqual([...TARGET_TABLES].sort())
  })

  it('a populated target refuses, and refuses before any TRUNCATE', async () => {
    const env = await positiveEnv()
    const client = fakeClient({ counts: { 'graph.edges': 1 } })
    await expect(runLegacyCopy({
      env,
      plan: planFor(env),
      createPoolFn: poolFactory(client),
      adapters: Object.fromEntries(ADAPTER_ORDER.map(n => [n, async (c: { query: (t: string) => Promise<unknown> }) => {
        await c.query('TRUNCATE something')
        return []
      }])),
    })).rejects.toThrow(/not fresh: graph\.edges/)
    expect(client.statements.some(s => /TRUNCATE/.test(s))).toBe(false)
    expect(client.statements.filter(s => s === 'ROLLBACK')).toHaveLength(1)
  })

  it('no source claims idempotence by TRUNCATE', () => {
    for (const f of [join(SRC, 'legacy-copy.ts'), ...ADAPTER_FILES, join(BIN, 'legacy-copy.ts')]) {
      const text = readFileSync(f, 'utf-8')
      expect(/Idempotent: TRUNCATE|idempotent because TRUNCATE|Idempotent:/i.test(text), f).toBe(false)
    }
  })

  it('a database the credential did not name refuses', async () => {
    const env = await positiveEnv()
    const client = fakeClient({ identity: { database: 'somebody_elses_db' } })
    await expect(runLegacyCopy({
      env,
      plan: planFor(env), createPoolFn: poolFactory(client),
      adapters: Object.fromEntries(ADAPTER_ORDER.map(n => [n, async () => []])),
    })).rejects.toThrow(/target database is somebody_elses_db/)
  })

  it('a SET LOCAL ROLE that did not take effect refuses', async () => {
    const env = await positiveEnv()
    // This client accepts SET LOCAL ROLE and keeps reporting the migrator, which
    // is what a revoked or misspelled role assumption looks like.
    const client = fakeClient({ ignoreSetRole: true })
    await expect(runLegacyCopy({
      env,
      plan: planFor(env), createPoolFn: poolFactory(client),
      adapters: Object.fromEntries(ADAPTER_ORDER.map(n => [n, async () => []])),
    })).rejects.toThrow(/after SET LOCAL ROLE ai_capital_owner; the owner role was not assumed/)
    expect(client.statements.some(s => /TRUNCATE/.test(s))).toBe(false)
  })

  it('a session that is not the migrator refuses', async () => {
    const env = await positiveEnv()
    const client = fakeClient({ identity: { session_user: 'postgres', current_user: 'postgres' } })
    await expect(runLegacyCopy({
      env,
      plan: planFor(env), createPoolFn: poolFactory(client),
      adapters: Object.fromEntries(ADAPTER_ORDER.map(n => [n, async () => []])),
    })).rejects.toThrow(/session_user is postgres/)
  })
})

describe('source snapshot integrity', () => {
  it('a source changed during the copy rolls back', async () => {
    const env = await positiveEnv()
    const client = fakeClient()
    await expect(runLegacyCopy({
      env,
      plan: planFor(env),
      createPoolFn: poolFactory(client),
      adapters: {
        ...Object.fromEntries(ADAPTER_ORDER.map(n => [n, async () => []])),
        lance: async () => {
          writeQaJsonlPopulated(root) // the snapshot moves under us
          return []
        },
      },
    })).rejects.toThrow(/source snapshot changed during the copy/)
    expect(client.statements.filter(s => s === 'ROLLBACK')).toHaveLength(1)
    expect(client.statements.filter(s => s === 'COMMIT')).toHaveLength(0)
  })

  it('a missing required SQLite source refuses', async () => {
    await expect(openSourceSqlite(join(root, 'absent.db'))).rejects.toThrow(/missing from the snapshot/)
  })

  it('a corrupt SQLite source refuses', async () => {
    await writePositiveFixtures(root)
    await writeNegativeCorruptSqlite(root)
    await expect(copyPortfolio(fakeClient(), { sourceRoot: root }))
      .rejects.toThrow(/could not be opened|not a database|does not exist/i)
  })

  it('an added source column fails closed', async () => {
    await writePositiveFixtures(root)
    await writeNegativeSchemaDrift(root)
    await expect(copyPortfolio(fakeClient(), { sourceRoot: root }))
      .rejects.toThrow(/unexpected: \[zz_unreviewed\]/)
  })

  it('a schema assertion refuses a missing column even when nothing was added', async () => {
    await writePositiveFixtures(root)
    const db = await openSourceSqlite(join(root, 'apps/scenario-simulator/data/portfolio.db'))
    try {
      // Exactly one direction of drift, so a check that only fires when BOTH
      // lists are non-empty would pass here.
      expect(() => assertSqliteSchema(db, 'positions', [
        'ticker', 'company', 'shares', 'avg_cost', 'current_price', 'current_value',
        'unrealized_pnl', 'updated_at', 'asset_class', 'currency', 'price_symbol',
        'strategy', 'zz_never_existed',
      ])).toThrow(/missing: \[zz_never_existed\]; unexpected: \[\]/)
    } finally {
      db.close()
    }
  })

  it('a missing source column fails closed', async () => {
    await writePositiveFixtures(root)
    const db = await openSourceSqlite(join(root, 'apps/scenario-simulator/data/portfolio.db'))
    expect(() => assertSqliteSchema(db, 'positions', ['ticker', 'zz_absent']))
      .toThrow(/missing: \[zz_absent\]/)
    db.close()
  })
})

describe('JSONL is never silently skipped', () => {
  it('a malformed line fails the copy and names the line number', async () => {
    await writePositiveFixtures(root)
    writeNegativeMalformedJsonl(root)
    await expect(copyBriefing(fakeClient(), { sourceRoot: root }))
      .rejects.toThrow(/predictions\.jsonl:2 is not valid JSON/)
  })

  it('an absent required file refuses; an empty present file is zero rows', async () => {
    await writePositiveFixtures(root)
    writeNegativeMissingJsonl(root)
    await expect(copyBriefing(fakeClient(), { sourceRoot: root }))
      .rejects.toThrow(/missing from the snapshot.*An absent file is not zero rows/s)

    const fresh = realpathSync(mkdtempSync(join(tmpdir(), 'zz-copy-empty-')))
    try {
      await writePositiveFixtures(fresh) // qa.jsonl is written empty by the positive set
      const results = await copyBriefing(fakeClient(), { sourceRoot: fresh })
      expect(results.find(r => r.table === 'briefing.qa')?.rows).toBe(0)
    } finally {
      rmSync(fresh, { recursive: true, force: true })
    }
  })

  it('a duplicate prediction date refuses rather than upserting', async () => {
    await writePositiveFixtures(root)
    const p = join(root, 'apps/investment-analyst-agents/archive/predictions.jsonl')
    const line = JSON.stringify({
      date: '2026-01-02', regime: 'r', confidence: 'c', scenarios: [], actions: {},
    })
    writeFileSync(p, `${line}\n${line}\n`, 'utf-8')
    await expect(copyBriefing(fakeClient(), { sourceRoot: root }))
      .rejects.toThrow(/repeats date 2026-01-02/)
  })

  it('a missing required field refuses', async () => {
    await writePositiveFixtures(root)
    const p = join(root, 'apps/investment-analyst-agents/archive/predictions.jsonl')
    writeFileSync(p, JSON.stringify({ date: '2026-01-02', regime: 'r', confidence: 'c', scenarios: [] }) + '\n', 'utf-8')
    await expect(copyBriefing(fakeClient(), { sourceRoot: root }))
      .rejects.toThrow(/field "actions" is missing/)
  })
})

describe('source booleans are validated, not coerced', () => {
  it.each([null, undefined, 2, -1, 'true', ''])('%p is refused for a NOT NULL boolean', v => {
    expect(() => requireBooleanInt('watchlist', 'news_only', 'ZZTEST1', v)).toThrow(/only integer 0 or 1/)
  })

  it('0 and 1 map to false and true', () => {
    expect(requireBooleanInt('t', 'c', 'i', 0)).toBe(false)
    expect(requireBooleanInt('t', 'c', 'i', 1)).toBe(true)
  })

  it('a nullable boolean accepts NULL but not 2', () => {
    expect(requireNullableBooleanInt('t', 'c', 'i', null)).toBeNull()
    expect(() => requireNullableBooleanInt('t', 'c', 'i', 2)).toThrow(/only integer 0, 1/)
  })

  it('an out-of-range source boolean refuses the whole copy', async () => {
    await writePositiveFixtures(root)
    await writeNegativeInvalidBoolean(root)
    await expect(copyCapital(fakeClient(), { sourceRoot: root }))
      .rejects.toThrow(/watchlist\.news_only for row ZZTEST1 is 2/)
  })

  it('a NULL source boolean refuses the whole copy', async () => {
    await writePositiveFixtures(root)
    await writeNegativeNullBoolean(root)
    await expect(copyCapital(fakeClient(), { sourceRoot: root }))
      .rejects.toThrow(/watchlist\.active for row ZZTEST1 is null/)
  })
})

describe('explicit source columns', () => {
  it('no adapter issues SELECT *', () => {
    for (const f of ADAPTER_FILES) {
      expect(/SELECT \*/i.test(codeOf(f)), f).toBe(false)
    }
  })

  it('all 17 SQLite reads name their columns and their order', () => {
    const reads: string[] = []
    for (const f of ADAPTER_FILES) {
      const text = readFileSync(f, 'utf-8')
      for (const m of text.matchAll(/SELECT \$\{([A-Z_]+_COLUMNS)\.join\(', '\)\} FROM (\w+) ORDER BY ([^`]+)`/g)) {
        reads.push(`${m[2]} ${m[1]} ORDER BY ${m[3].trim()}`)
      }
    }
    // The original tool issued 17 `SELECT *` reads plus one already-explicit
    // read of `documents`: 18 SQLite reads in total, all explicit now.
    expect(reads).toHaveLength(18)
    for (const r of reads) expect(r).toContain('ORDER BY')
  })

  it('every SQLite table read is schema-asserted first', () => {
    for (const f of ADAPTER_FILES.filter(f => !/lance|briefing/.test(f))) {
      const text = readFileSync(f, 'utf-8')
      const read = [...text.matchAll(/FROM (\w+) ORDER BY/g)].map(m => m[1]).sort()
      const asserted = [...text.matchAll(/assertSqliteSchema\(sqlite, '(\w+)'/g)].map(m => m[1]).sort()
      expect(read).toEqual(asserted)
    }
  })
})

describe('LanceDB traversal', () => {
  it('the adapter uses no limit/offset pagination', () => {
    const code = readFileSync(join(SRC, 'legacy-copy', 'lance.ts'), 'utf-8')
      .split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')
    expect(/\.offset\(/.test(code)).toBe(false)
    expect(/\.limit\(/.test(code)).toBe(false)
  })

  it('the sixteen partitions are disjoint and cover the UUID domain', () => {
    const parts = uuidPartitions()
    expect(parts).toHaveLength(16)
    for (const id of ['0a111111', 'f0222222', '7c333333']) {
      const hits = parts.filter(p => {
        const m = /^id >= '(.)' AND id < '(.)'$/.exec(p.predicate)!
        return id >= m[1] && id < m[2]
      })
      expect(hits).toHaveLength(1)
    }
  })

  it('the fixture ids are canonical and a valid scan returns them sorted', async () => {
    expect(fixtureIdsAreCanonical()).toBe(true)
    const scan = await scanLanceChunks(fakeLanceTable(positiveChunks()))
    expect(scan.rows.map(r => r.id)).toEqual([...scan.rows.map(r => r.id)].sort())
    expect(scan.totalBefore).toBe(3)
    expect(scan.perPartition.reduce((n, p) => n + p.read, 0)).toBe(3)
  })

  it('a declared/read count mismatch refuses', async () => {
    const rows = positiveChunks()
    const table = fakeLanceTable(rows)
    const original = table.countRows.bind(table)
    table.countRows = async (f?: string) => (f === undefined ? await original() : (await original(f)) + 1)
    await expect(scanLanceChunks(table)).rejects.toThrow(/declared \d+ rows but returned/)
  })

  it('a noncanonical id is a source-identity failure', async () => {
    await expect(scanLanceChunks(fakeLanceTable(negativeChunksNoncanonicalId())))
      .rejects.toThrow(/not a canonical lowercase UUID|account for/)
  })

  it('a duplicate id refuses, naming the duplicate rather than a tally', async () => {
    await expect(scanLanceChunks(fakeLanceTable(negativeChunksDuplicateId())))
      .rejects.toThrow(/appears more than once in the source/)
  })

  it('a partition above the configured maximum refuses', async () => {
    await expect(scanLanceChunks(fakeLanceTable(positiveChunks()), 0))
      .rejects.toThrow(/above the configured maximum/)
  })

  it('a wrong vector dimension refuses before any SQL is built', () => {
    const bad = negativeChunksWrongDimension()[0]
    expect(() => vectorToPg(bad.id, bad.vector)).toThrow(/383-dimension vector/)
    expect(CANONICAL_UUID_RE.test(CHUNK_ID_A)).toBe(true)
  })

  it('a valid vector serialises to the pgvector text form', () => {
    const ok = positiveChunks()[0]
    const text = vectorToPg(ok.id, ok.vector)
    expect(text.startsWith('[')).toBe(true)
    expect(text.split(',')).toHaveLength(384)
  })

  it('NUL is stripped and empty becomes NULL', () => {
    expect(sanitizeText('a\u0000b')).toBe('ab')
    expect(emptyToNull('')).toBeNull()
    expect(emptyToNull('   ')).toBeNull()
    expect(emptyToNull('\u0000')).toBeNull()
    expect(emptyToNull('zz')).toBe('zz')
  })
})

describe('sequence state is read from the sequence relation, not pg_sequences', () => {
  it('all three sequences are declared', () => {
    expect(TARGET_SEQUENCES.map(s => s.sequence)).toEqual([
      'portfolio.trade_log_id_seq',
      'capital.fetch_log_id_seq',
      'briefing.qa_id_seq',
    ])
  })

  it('exactly the three declared sequences are read, each schema-qualified and quoted', async () => {
    const client = fakeClient()
    const states = await readSequenceStates(client)
    expect(states.map(s => s.sequence)).toEqual([
      'portfolio.trade_log_id_seq',
      'capital.fetch_log_id_seq',
      'briefing.qa_id_seq',
    ])
    const reads = client.statements.filter(x => /last_value/.test(x))
    expect(reads).toEqual([
      'SELECT last_value::text AS last_value, is_called FROM "portfolio"."trade_log_id_seq"',
      'SELECT last_value::text AS last_value, is_called FROM "capital"."fetch_log_id_seq"',
      'SELECT last_value::text AS last_value, is_called FROM "briefing"."qa_id_seq"',
    ])
  })

  it('pg_sequences is not consulted', async () => {
    const client = fakeClient()
    await readSequenceStates(client)
    expect(client.statements.join(' ')).not.toContain('pg_sequences')
    // and the shipped source does not mention it outside the comment explaining why
    expect(executableOf(join(SRC, 'legacy-copy.ts'))).not.toContain('pg_sequences')
  })

  it('no advancing statement is issued', async () => {
    const client = fakeClient()
    await readSequenceStates(client)
    const sent = client.statements.join(' ')
    expect(/nextval|setval|currval|INSERT|UPDATE|DELETE/i.test(sent)).toBe(false)
    expect(/nextval|setval|currval/i.test(executableOf(join(SRC, 'legacy-copy.ts')))).toBe(false)
  })

  it('an uncalled sequence preserves last_value 1 and is_called false', async () => {
    const states = await readSequenceStates(fakeClient())
    for (const s of states) {
      expect(s.lastValue).toBe('1')
      expect(s.isCalled).toBe(false)
    }
  })

  it('a called sequence preserves its non-default last value and is_called true', async () => {
    const states = await readSequenceStates(fakeClient({
      sequences: {
        'portfolio.trade_log_id_seq': { last_value: '42', is_called: true },
        'capital.fetch_log_id_seq': { last_value: '9007199254740993', is_called: true },
        'briefing.qa_id_seq': { last_value: null, is_called: false },
      },
    }))
    expect(states[0]).toEqual({
      sequence: 'portfolio.trade_log_id_seq', lastValue: '42', isCalled: true,
    })
    // Beyond 2^53: proof the value stays a string and is not rounded.
    expect(states[1].lastValue).toBe('9007199254740993')
    expect(states[2].lastValue).toBeNull()
  })

  it('zero returned rows fail closed', async () => {
    await expect(readSequenceStates(fakeClient({
      sequences: { 'capital.fetch_log_id_seq': 'none' },
    }))).rejects.toThrow(/returned no row; it does not exist/)
  })

  it('more than one returned row fails closed', async () => {
    await expect(readSequenceStates(fakeClient({
      sequences: {
        'briefing.qa_id_seq': [
          { last_value: '1', is_called: false },
          { last_value: '2', is_called: true },
        ],
      },
    }))).rejects.toThrow(/returned 2 rows.*exactly one row/s)
  })

  it('a last_value beyond 2^53 is preserved byte-for-byte, never converted', async () => {
    const huge = '9007199254740993'
    const states = await readSequenceStates(fakeClient({
      sequences: { 'capital.fetch_log_id_seq': { last_value: huge, is_called: true } },
    }))
    const got = states.find(x => x.sequence === 'capital.fetch_log_id_seq')!
    expect(got.lastValue).toBe(huge)
    // Not merely equal-ish: the same string, and not a number that round-trips.
    expect(typeof got.lastValue).toBe('string')
    expect(Number(got.lastValue).toString()).not.toBe(huge)
  })

  it('a null last_value stays null', async () => {
    const states = await readSequenceStates(fakeClient({
      sequences: { 'briefing.qa_id_seq': { last_value: null, is_called: false } },
    }))
    expect(states.find(x => x.sequence === 'briefing.qa_id_seq')!.lastValue).toBeNull()
  })

  it.each([
    ['a number', 42, 'number'],
    ['a boolean', false, 'boolean'],
    ['an object', { v: 1 }, 'object'],
    ['an array', ['1'], 'object'],
  ])('%s last_value is refused, not converted', async (_label, value, typeName) => {
    await expect(readSequenceStates(fakeClient({
      sequences: { 'portfolio.trade_log_id_seq': { last_value: value, is_called: false } },
    }))).rejects.toThrow(new RegExp(`last_value as .*\\(type ${typeName}\\)`))
  })

  it('an undefined last_value is refused, not treated as null', async () => {
    await expect(readSequenceStates(fakeClient({
      sequences: { 'portfolio.trade_log_id_seq': { last_value: undefined, is_called: false } },
    }))).rejects.toThrow(/type undefined/)
  })

  it('last_value is never passed through String()', () => {
    const code = executableOf(join(SRC, 'legacy-copy.ts'))
    expect(code).not.toContain('String(row.last_value)')
    expect(code).toContain("typeof row.last_value !== ''")
  })

  it('the comment does not claim the read is lock-free', () => {
    const src = readFileSync(join(SRC, 'legacy-copy.ts'), 'utf-8')
    expect(src).not.toContain('neither advances nor locks')
    expect(src).toContain('ACCESS SHARE relation lock')
    expect(src).toContain('NOT lock-free')
  })

  it('a non-boolean is_called fails closed', async () => {
    await expect(readSequenceStates(fakeClient({
      sequences: { 'portfolio.trade_log_id_seq': { last_value: '1', is_called: 'f' } },
    }))).rejects.toThrow(/reported is_called as "f", which is not a boolean/)
  })

  it('a sequence name that is not exactly two components is refused', async () => {
    // The guard that stands between TARGET_SEQUENCES and string interpolation.
    const code = executableOf(join(SRC, 'legacy-copy.ts'))
    expect(code).toContain('escapeIdentifier(parts[0])')
    expect(code).toContain('escapeIdentifier(parts[1])')
    expect(code).toContain("parts.length !== 2")
  })

  it('the identifier is escaped by the driver, never interpolated raw', () => {
    const code = executableOf(join(SRC, 'legacy-copy.ts'))
    expect(code).toContain("import { escapeIdentifier } from ''")
    expect(/FROM \$\{parts\[0\]\}/.test(code)).toBe(false)
    expect(/::regclass/.test(code)).toBe(false)
  })
})

describe('expected-failure probes recover their own transaction', () => {
  it('each probe brackets itself with SAVEPOINT and ROLLBACK TO SAVEPOINT', async () => {
    const client = fakeClient({ failOn: /TRUNCATE/ })
    const r = await expectFailure(client, 'truncate refused', 'TRUNCATE portfolio.positions')
    expect(r.sqlstate).toBe('42501')
    const s = client.statements
    expect(s[0]).toMatch(/^SAVEPOINT probe_/)
    expect(s[s.length - 2]).toMatch(/^ROLLBACK TO SAVEPOINT probe_/)
    expect(s[s.length - 1]).toMatch(/^RELEASE SAVEPOINT probe_/)
  })

  it('a probe that unexpectedly succeeds is itself a failure', async () => {
    const client = fakeClient()
    await expect(expectFailure(client, 'should have failed', 'SELECT 1'))
      .rejects.toThrow(/was expected to fail and did not/)
  })
})

describe('valid mappings preserve the fabricated values', () => {
  it('portfolio carries Unicode, quotes and exact decimals through unchanged', async () => {
    await writePositiveFixtures(root)
    const client = fakeClient()
    const sent: unknown[][] = []
    const recording = {
      async query(text: string, values?: unknown[]) {
        if (/INSERT INTO portfolio/.test(text)) sent.push(values ?? [])
        return client.query(text, values)
      },
    }
    const results = await copyPortfolio(recording, { sourceRoot: root })
    expect(results).toEqual([
      { table: 'portfolio.positions', rows: 3 },
      { table: 'portfolio.trade_log', rows: 2 },
    ])
    expect(sent[0][1]).toBe(UNICODE_COMPANY)
    expect(sent[1][2]).toBe(EXACT_DECIMAL)
    expect(sent[3][5]).toBe(QUOTED_REASON)
  })

  it('every adapter reports only declared target tables', async () => {
    await writePositiveFixtures(root)
    const ctx = { sourceRoot: root }
    const results = [
      ...(await copyPortfolio(fakeClient(), ctx)),
      ...(await copyCapital(fakeClient(), ctx)),
      ...(await copyThesis(fakeClient(), ctx)),
      ...(await copyBriefing(fakeClient(), ctx)),
      ...(await copyGraph(fakeClient(), ctx)),
    ]
    for (const r of results) expect(TARGET_TABLES).toContain(r.table)
    expect(canonicalCountManifest(results)).not.toContain('UNDECLARED')
  })

  it('the canonical manifest is deterministic and order-independent', () => {
    const a = [{ table: 'graph.nodes', rows: 2 }, { table: 'portfolio.positions', rows: 3 }]
    const b = [{ table: 'portfolio.positions', rows: 3 }, { table: 'graph.nodes', rows: 2 }]
    expect(canonicalCountManifest(a)).toBe(canonicalCountManifest(b))
    expect(canonicalDigest(canonicalCountManifest(a)))
      .toBe(canonicalDigest(canonicalCountManifest(b)))
    expect(canonicalCountManifest(a).split('\n').filter(Boolean)).toHaveLength(21)
  })

  it('an undeclared table is reported, not hidden', () => {
    expect(canonicalCountManifest([{ table: 'zz.other', rows: 1 }]))
      .toContain('UNDECLARED zz.other 1')
  })
})

describe('cold-preserved tables are named', () => {
  it('the seven ungranted targets are declared as cold-preserved', () => {
    expect([...COLD_PRESERVED_TABLES].sort()).toEqual([
      'briefing.qa', 'capital.api_budget', 'graph.edges', 'graph.nodes',
      'graph.proposal_edges', 'graph.proposals', 'thesis.theme_memberships',
    ])
    for (const t of COLD_PRESERVED_TABLES) expect(TARGET_TABLES).toContain(t)
  })
})

describe('the database name comes from the credential', () => {
  it.each([
    ['postgresql://u@h:5435/zz_db', 'zz_db'],
    ['postgresql://u@/zz_db?host=%2Ftmp%2Fs', 'zz_db'],
  ])('%s -> %s', (url, name) => {
    expect(requireDatabaseName(url)).toBe(name)
  })
})

describe('the removed CLIs are gone', () => {
  it('neither legacy migration CLI remains', () => {
    for (const f of ['migrate-from-sqlite.ts', 'migrate-from-lance.ts']) {
      let exists = true
      try { readFileSync(join(BIN, f), 'utf-8') } catch { exists = false }
      expect(exists, `${f} still exists`).toBe(false)
    }
  })

  it('package.json exposes legacy-copy and not the old scripts', () => {
    const pkg = JSON.parse(readFileSync(join(HERE, '..', 'package.json'), 'utf-8')) as {
      scripts: Record<string, string>; bin: Record<string, string>
    }
    expect(pkg.scripts['migrate-data']).toBeUndefined()
    expect(pkg.scripts['migrate-vectors']).toBeUndefined()
    expect(pkg.bin['db-migrate-data']).toBeUndefined()
    expect(pkg.scripts['legacy-copy']).toContain('bin/legacy-copy.ts')
  })
})

describe('fixtures are fabricated and reproducible', () => {
  it('two generations of the snapshot agree table for table', async () => {
    const a = await writePositiveFixtures(root)
    const second = mkdtempSync(join(tmpdir(), 'zz-copy-b-'))
    try {
      const b = await writePositiveFixtures(second)
      expect(a.counts).toEqual(b.counts)
    } finally {
      rmSync(second, { recursive: true, force: true })
    }
  })

  it('no fixture ticker escapes the reserved ZZ namespace', () => {
    const text = readFileSync(join(HERE, '..', 'testing', 'legacy-copy-fixtures.ts'), 'utf-8')
    for (const m of text.matchAll(/'([A-Z]{2,6}\d?)'/g)) {
      const candidate = m[1]
      if (/^(TEXT|NUMERIC|INTEGER|NULL|USD|THB|FY)/.test(candidate)) continue
      expect(candidate.startsWith('ZZ'), `${candidate} is not in the ZZ namespace`).toBe(true)
    }
  })

  it('the snapshot carries its own SOURCE_HEAD', async () => {
    const env = await positiveEnv()
    expect(planFor(env).sourceHead).toBe(FIXTURE_HEAD)
    rmSync(join(root, 'SOURCE_HEAD'))
    expect(() => planFor(env)).toThrow(/required snapshot file is missing/)
  })
})

// ---------------------------------------------------------------------------
// ROUND 2 CORRECTIONS
// ---------------------------------------------------------------------------

describe('authorization is bound to the bytes actually copied', () => {
  it('the plan is a required input and names root, head, digest, db and cluster', async () => {
    const env = await positiveEnv()
    const plan = planFor(env)
    expect(Object.keys(plan).sort()).toEqual([
      'database', 'port', 'socketDirectory', 'sourceDigest', 'sourceHead',
      'sourceRoot', 'systemIdentifier',
    ])
    expect(plan.sourceRoot).toBe(root)
    expect(plan.sourceHead).toBe(FIXTURE_HEAD)
    expect(plan.sourceDigest).toMatch(/^[0-9a-f]{64}$/)
  })

  it('a source changed AFTER confirmation refuses before any pool is constructed', async () => {
    const env = await positiveEnv()
    const plan = planFor(env)
    // The operator confirmed; now the snapshot moves.
    writeQaJsonlPopulated(root)
    let poolsMade = 0
    const client = fakeClient()
    await expect(runLegacyCopy({
      env,
      plan,
      createPoolFn: (url: string) => { poolsMade++; return poolFactory(client)(url) },
      adapters: noopAdapters(),
    })).rejects.toThrow(/has changed since it was confirmed.*No connection was opened/s)
    expect(poolsMade).toBe(0)
    expect(client.statements).toEqual([])
  })

  it('a SOURCE_HEAD edited after confirmation refuses before connecting', async () => {
    const env = await positiveEnv()
    const plan = planFor(env)
    writeFileSync(join(root, 'SOURCE_HEAD'), 'f'.repeat(40) + '\n', 'utf-8')
    let poolsMade = 0
    await expect(runLegacyCopy({
      env, plan,
      createPoolFn: (url: string) => { poolsMade++; return poolFactory(fakeClient())(url) },
      adapters: noopAdapters(),
    })).rejects.toThrow(/taken at f{40}, but the confirmed plan names/)
    expect(poolsMade).toBe(0)
  })

  it('SOURCE_HEAD is part of the fingerprinted manifest', async () => {
    const env = await positiveEnv()
    const before = planFor(env).sourceDigest
    writeFileSync(join(root, 'SOURCE_HEAD'), 'a'.repeat(40) + '\n', 'utf-8')
    expect(planFor(env).sourceDigest).not.toBe(before)
  })

  it('a plan naming another snapshot root refuses', async () => {
    const env = await positiveEnv()
    const plan = { ...planFor(env), sourceRoot: '/tmp/somewhere-else' }
    await expect(runLegacyCopy({ env, plan, createPoolFn: poolFactory(fakeClient()), adapters: noopAdapters() }))
      .rejects.toThrow(/confirmed plan names snapshot root/)
  })

  it('a plan naming another database refuses', async () => {
    const env = await positiveEnv()
    const plan = { ...planFor(env), database: 'zz_other_db' }
    await expect(runLegacyCopy({ env, plan, createPoolFn: poolFactory(fakeClient()), adapters: noopAdapters() }))
      .rejects.toThrow(/confirmed plan names database zz_other_db/)
  })

  it('a source changed DURING the copy is caught again before COMMIT', async () => {
    const env = await positiveEnv()
    const client = fakeClient()
    await expect(runLegacyCopy({
      env, plan: planFor(env), createPoolFn: poolFactory(client),
      adapters: { ...noopAdapters(), lance: async () => { writeQaJsonlPopulated(root); return [] } },
    })).rejects.toThrow(/changed during the copy/)
    expect(client.statements.filter(x => x === 'COMMIT')).toHaveLength(0)
    expect(client.statements.filter(x => x === 'ROLLBACK')).toHaveLength(1)
  })

  it('the CLI hands runLegacyCopy exactly the confirmed plan', async () => {
    const env = await positiveEnv()
    const plan = planFor(env)
    let seen: ConfirmedPlan | null = null
    const r = await runCli([
      `--expect-system-identifier=${SYSTEM_ID}`, `--expect-port=${PORT}`, `--expect-socket=${SOCKET}`,
      '--apply', `--confirm=${expectedConfirmation(plan)}`,
    ], env, {
      copy: (async (o: { plan: ConfirmedPlan }) => {
        seen = o.plan
        return { migrationCount: 19, sequences: [], countManifestDigest: 'zz', results: [] }
      }) as never,
    })
    expect(r.exitCode).toBe(0)
    expect(seen).toEqual(plan)
  })

  it('the confirmation names the cluster and carries no credential', async () => {
    const env = await positiveEnv()
    const text = expectedConfirmation(planFor(env))
    expect(text).toContain(SYSTEM_ID)
    expect(text).toContain(`port ${PORT}`)
    expect(text).toContain(`socket ${SOCKET}`)
    expect(text).not.toContain('postgresql://')
    expect(text).not.toContain(REQUIRED_CREDENTIAL_ROLE)
  })

  it('--apply without the cluster expectations refuses', async () => {
    const env = await positiveEnv()
    const r = await runCli(['--apply'], env, { copy: (async () => { throw new Error('x') }) as never })
    expect(r.exitCode).toBe(2)
    expect(r.lines.join('\n')).toContain('--expect-system-identifier')
  })
})

describe('snapshot completeness', () => {
  it('a complete snapshot passes', async () => {
    await writePositiveFixtures(root)
    expect(() => assertCompleteSnapshot(root)).not.toThrow()
  })

  it.each([
    ['apps/scenario-simulator/data/portfolio.db'],
    ['apps/capital-intelligence-ingestion/data/sqlite.db'],
    ['apps/thesis-memory/data/thesis.db'],
    ['apps/dependency-graph-engine/data/graph.db'],
    ['apps/investment-analyst-agents/archive/predictions.jsonl'],
    ['apps/investment-analyst-agents/archive/qa.jsonl'],
    ['SOURCE_HEAD'],
  ])('a missing %s refuses', async rel => {
    await writePositiveFixtures(root)
    removeSnapshotPath(root, rel)
    expect(() => assertCompleteSnapshot(root)).toThrow(/required snapshot file is missing/)
  })

  it('a missing LanceDB directory refuses', async () => {
    await writePositiveFixtures(root)
    removeSnapshotPath(root, 'apps/capital-intelligence-ingestion/data/lancedb')
    expect(() => assertCompleteSnapshot(root)).toThrow(/required snapshot dir is missing/)
  })

  it('an empty LanceDB tree refuses', async () => {
    await writePositiveFixtures(root)
    emptyLanceDirectory(root)
    expect(() => assertCompleteSnapshot(root)).toThrow(/is empty.*not "zero chunks"/s)
  })

  it('a symlinked required file refuses', async () => {
    await writePositiveFixtures(root)
    const outside = realpathSync(mkdtempSync(join(tmpdir(), 'zz-outside-')))
    try {
      symlinkRequiredFile(root, 'apps/thesis-memory/data/thesis.db', join(outside, 'copy.db'))
      expect(() => assertCompleteSnapshot(root)).toThrow(/is a symlink/)
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })

  it('a symlink NESTED below a required directory refuses', async () => {
    await writePositiveFixtures(root)
    const outside = realpathSync(mkdtempSync(join(tmpdir(), 'zz-outside-')))
    try {
      symlinkInsideLance(root, join(outside, 'target'))
      expect(() => assertCompleteSnapshot(root)).toThrow(/is a symlink/)
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })

  it('a special filesystem node refuses', async () => {
    await writePositiveFixtures(root)
    fifoInsideLance(root)
    expect(() => assertCompleteSnapshot(root))
      .toThrow(/neither a regular file nor a directory/)
  })

  it('sourceFingerprints refuses a missing path rather than skipping it', async () => {
    await writePositiveFixtures(root)
    const paths = allSnapshotPaths(root)
    removeSnapshotPath(root, 'apps/thesis-memory/data/thesis.db')
    expect(() => sourceFingerprints(root, paths))
      .toThrow(/missing and cannot be fingerprinted/)
  })

  it('runLegacyCopy itself refuses an incomplete snapshot, before any pool', async () => {
    // Not via the CLI: planCopy checks completeness too, so a CLI-only test
    // would pass with the orchestrator's own check removed.
    const env = await positiveEnv()
    const plan = planFor(env)
    removeSnapshotPath(root, 'apps/capital-intelligence-ingestion/data/sqlite.db')
    let poolsMade = 0
    await expect(runLegacyCopy({
      env, plan,
      createPoolFn: (url: string) => { poolsMade++; return poolFactory(fakeClient())(url) },
      adapters: noopAdapters(),
    })).rejects.toThrow(/required snapshot file is missing/)
    expect(poolsMade).toBe(0)
  })

  it('the CLI refuses an incomplete snapshot before connecting', async () => {
    const env = await positiveEnv()
    removeSnapshotPath(root, 'apps/dependency-graph-engine/data/graph.db')
    const r = await runCli([], env, { copy: (async () => { throw new Error('x') }) as never })
    expect(r.exitCode).toBe(2)
    expect(r.lines.join('\n')).toMatch(/required snapshot file is missing/)
  })
})

describe('the migration ledger is recognised exactly', () => {
  const good = () => CURRENT_V19_MANIFEST.map(m => ({
    filename: m.filename, sha256: m.sha256, applied_at: '2026-01-01T00:00:00Z',
  }))

  async function ledgerRefuses(rows: { filename: string; sha256: string; applied_at: string }[]) {
    const env = await positiveEnv()
    const client = fakeClient({ ledger: rows })
    await expect(runLegacyCopy({
      env, plan: planFor(env), createPoolFn: poolFactory(client), adapters: noopAdapters(),
    })).rejects.toThrow(/UNRECOGNIZED, not CURRENT_V19/)
    // before SET LOCAL ROLE and before any destructive SQL
    expect(client.statements.some(x => /SET LOCAL ROLE/.test(x))).toBe(false)
    expect(client.statements.some(x => /TRUNCATE/.test(x))).toBe(false)
    return client
  }

  it('the exact nineteen are accepted', async () => {
    const env = await positiveEnv()
    const client = fakeClient()
    const outcome = await runLegacyCopy({
      env, plan: planFor(env), createPoolFn: poolFactory(client), adapters: noopAdapters(),
    })
    expect(outcome.migrationCount).toBe(19)
    expect(CURRENT_V19_MANIFEST).toHaveLength(19)
  })

  it('a replaced filename refuses', async () => {
    const rows = good()
    rows[3] = { ...rows[3], filename: '004_zz_fictional.sql' }
    await ledgerRefuses(rows)
  })

  it('a replaced hash refuses', async () => {
    const rows = good()
    rows[7] = { ...rows[7], sha256: '0'.repeat(64) }
    await ledgerRefuses(rows)
  })

  it('nineteen rows with a fictional migration substituted refuses', async () => {
    const rows = good()
    rows[18] = { filename: '019_zz_not_real.sql', sha256: '1'.repeat(64), applied_at: 'x' }
    await ledgerRefuses(rows)
  })

  it('an extra row plus a deleted row refuses', async () => {
    const rows = good()
    rows.splice(2, 1)
    rows.push({ filename: '020_zz_extra.sql', sha256: '2'.repeat(64), applied_at: 'x' })
    expect(rows).toHaveLength(19)
    await ledgerRefuses(rows)
  })

  it('a duplicated filename refuses', async () => {
    const rows = good()
    rows[5] = { ...rows[4] }
    await ledgerRefuses(rows)
  })

  it('the manifest is imported, never restated', () => {
    const code = codeOf(join(SRC, 'legacy-copy.ts'))
    // The specifier is ASSEMBLED, not written out. A literal
    // an import statement naming that module relatively reads to
    // findDeadTestFiles as a real relative import of something that does not
    // exist beside tests/, and it reported this whole suite as unloadable -
    // the check doing its job on a string that only looked like an import.
    // That applies to comments too, which is why this one spells nothing out.
    const specifier = ['.', '/inventory-queries.js'].join('')
    expect(code).toContain('CURRENT_V19_MANIFEST')
    expect(code).toContain(specifier)
    // No second editable list: no .sql filename literal appears in this module.
    expect(/'\d{3}_[a-z_]+\.sql'/.test(code)).toBe(false)
  })
})

describe('target identity is enforced before SET LOCAL ROLE', () => {
  const base: TargetIdentity = {
    database: 'ai_capital_copy_rehearsal',
    sessionUser: REQUIRED_CREDENTIAL_ROLE,
    currentUser: REQUIRED_CREDENTIAL_ROLE,
    serverVersionNum: 170010,
    systemIdentifier: SYSTEM_ID,
    configuredPort: PORT,
    unixTransport: true,
    // EXACTLY ONE configured directory: see configuredSocketDirectories.
    socketDirectories: SOCKET,
  }
  const expected = {
    database: 'ai_capital_copy_rehearsal', systemIdentifier: SYSTEM_ID,
    port: PORT, socketDirectory: SOCKET,
  }

  it('a matching identity passes', () => {
    expect(() => assertTargetIdentity(base, expected)).not.toThrow()
  })

  it.each([
    ['database', { database: 'other_db' }, /target database is other_db/],
    ['session role', { sessionUser: 'postgres' }, /session_user is postgres/],
    ['current role', { currentUser: 'ai_capital_owner' }, /current_user is ai_capital_owner before SET LOCAL ROLE/],
    ['PostgreSQL 18', { serverVersionNum: 180000 }, /PostgreSQL major 17 is required/],
    ['PostgreSQL 16', { serverVersionNum: 160014 }, /PostgreSQL major 17 is required/],
    ['system identifier', { systemIdentifier: '9'.repeat(19) }, /system identifier is 9+, not the confirmed/],
    ['configured port', { configuredPort: 5432 }, /configured on port 5432, not the confirmed/],
    ['TCP transport', { unixTransport: false }, /connected over TCP/],
    ['null port', { configuredPort: null }, /returned no value/],
    ['socket directory', { socketDirectories: '/var/run/postgresql' }, /only socket directory is/],
    ['zero socket directories', { socketDirectories: '' }, /has 0 unix_socket_directories/],
    ['multiple socket directories', { socketDirectories: `/var/run/postgresql, ${SOCKET}` }, /has 2 unix_socket_directories/],
  ])('a mismatched %s refuses', (_name, patch, re) => {
    expect(() => assertTargetIdentity({ ...base, ...patch }, expected)).toThrow(re)
  })

  it('a same-named database on another cluster refuses before SET ROLE or TRUNCATE', async () => {
    const env = await positiveEnv()
    const client = fakeClient({ identity: { system_identifier: '8'.repeat(19) } })
    await expect(runLegacyCopy({
      env, plan: planFor(env), createPoolFn: poolFactory(client), adapters: noopAdapters(),
    })).rejects.toThrow(/system identifier/)
    expect(client.statements.some(x => /SET LOCAL ROLE/.test(x))).toBe(false)
    expect(client.statements.some(x => /TRUNCATE|count\(\*\)/.test(x))).toBe(false)
  })
})

describe('the database name comes from the driver parser', () => {
  it.each([
    ['postgresql://u@h:5435/zz_db', 'zz_db'],
    ['postgresql://u@h:5435/zz%5Fdb', 'zz_db'],
    ['postgresql://u@/zz_db?host=%2Ftmp%2Fs', 'zz_db'],
    ['postgresql://u@h:5435/zz_db?sslmode=disable&application_name=zz', 'zz_db'],
    ['postgresql://u@h:5435/ZZ_MixedCase', 'ZZ_MixedCase'],
  ])('%s -> %s', (url, name) => {
    expect(requireDatabaseName(url)).toBe(name)
  })

  it('an unresolvable destination refuses', () => {
    expect(() => requireDatabaseName('postgresql://u@h:5435/')).toThrow(/does not name a database/)
  })

  it('no hand-written URL splitting remains', () => {
    const code = codeOf(join(SRC, 'legacy-copy.ts'))
    expect(code).toContain('databaseNameOfRaw')
    expect(/indexOf\(':\/\/'\)/.test(code)).toBe(false)
    expect(/decodeURIComponent/.test(code)).toBe(false)
  })
})

describe('cleanup happens on every pool and client boundary', () => {
  function instrumented(over: {
    authFail?: boolean; connectFail?: boolean; beginFail?: boolean
    commitFail?: boolean; releaseFail?: boolean; endFail?: boolean
  }) {
    const calls = { release: 0, end: 0 }
    // ONE delegate: a fresh fakeClient per statement would forget that
    // SET LOCAL ROLE had happened, and every run would fail on the owner proof.
    const delegate = fakeClient()
    const client = {
      statements: [] as string[],
      async query(text: string, values?: unknown[]) {
        client.statements.push(text.replace(/\s+/g, ' ').trim())
        if (over.beginFail && text === 'BEGIN') throw new Error('zz BEGIN failed')
        if (over.commitFail && text === 'COMMIT') throw new Error('zz COMMIT failed')
        return delegate.query(text, values)
      },
      release() { calls.release++; if (over.releaseFail) throw new Error('zz release failed') },
    }
    const factory = (url: string) => {
      const pool = createPool(url)
      ;(pool as unknown as { connect: () => Promise<unknown> }).connect = async () => {
        if (over.connectFail) throw new Error('zz connect failed')
        return client
      }
      ;(pool as unknown as { end: () => Promise<void> }).end = async () => {
        calls.end++
        if (over.endFail) throw new Error('zz end failed')
      }
      if (over.authFail) {
        // A pool the gate cannot place: destinationOf() returns null.
        const orphan = { connect: pool.connect, end: (pool as unknown as { end: () => Promise<void> }).end }
        return orphan as unknown as ReturnType<typeof createPool>
      }
      return pool
    }
    return { calls, client, factory }
  }

  it('authorization failure after pool construction still ends the pool', async () => {
    const env = await positiveEnv()
    const { calls, factory } = instrumented({ authFail: true })
    await expect(runLegacyCopy({ env, plan: planFor(env), createPoolFn: factory, adapters: noopAdapters() }))
      .rejects.toThrow()
    expect(calls.end).toBe(1)
    expect(calls.release).toBe(0)
  })

  it('a connect rejection ends the pool and releases nothing', async () => {
    const env = await positiveEnv()
    const { calls, factory } = instrumented({ connectFail: true })
    await expect(runLegacyCopy({ env, plan: planFor(env), createPoolFn: factory, adapters: noopAdapters() }))
      .rejects.toThrow(/zz connect failed/)
    expect(calls.end).toBe(1)
    expect(calls.release).toBe(0)
  })

  it('a BEGIN rejection releases once and ends once', async () => {
    const env = await positiveEnv()
    const { calls, factory } = instrumented({ beginFail: true })
    await expect(runLegacyCopy({ env, plan: planFor(env), createPoolFn: factory, adapters: noopAdapters() }))
      .rejects.toThrow(/zz BEGIN failed/)
    expect(calls.release).toBe(1)
    expect(calls.end).toBe(1)
  })

  it('an adapter rejection releases once and ends once', async () => {
    const env = await positiveEnv()
    const { calls, factory } = instrumented({})
    await expect(runLegacyCopy({
      env, plan: planFor(env), createPoolFn: factory,
      adapters: { ...noopAdapters(), thesis: async () => { throw new Error('zz adapter') } },
    })).rejects.toThrow(/zz adapter/)
    expect(calls.release).toBe(1)
    expect(calls.end).toBe(1)
  })

  it('a COMMIT rejection releases once and ends once', async () => {
    const env = await positiveEnv()
    const { calls, factory } = instrumented({ commitFail: true })
    await expect(runLegacyCopy({ env, plan: planFor(env), createPoolFn: factory, adapters: noopAdapters() }))
      .rejects.toThrow(/zz COMMIT failed/)
    expect(calls.release).toBe(1)
    expect(calls.end).toBe(1)
  })

  it('a release rejection does not prevent pool.end, and is reported not raised', async () => {
    const env = await positiveEnv()
    const { calls, factory } = instrumented({ releaseFail: true })
    const said: string[] = []
    const outcome = await runLegacyCopy({
      env, plan: planFor(env), createPoolFn: factory, adapters: noopAdapters(),
      log: l => said.push(l),
    })
    expect(outcome.migrationCount).toBe(19)
    expect(calls.release).toBe(1)
    expect(calls.end).toBe(1)
    expect(said.join('\n')).toContain('client.release() failed')
  })

  it('a pool.end rejection is reported, not raised over a successful copy', async () => {
    const env = await positiveEnv()
    const { calls, factory } = instrumented({ endFail: true })
    const said: string[] = []
    const outcome = await runLegacyCopy({
      env, plan: planFor(env), createPoolFn: factory, adapters: noopAdapters(),
      log: l => said.push(l),
    })
    expect(outcome.countManifestDigest).toMatch(/^[0-9a-f]{64}$/)
    expect(calls.end).toBe(1)
    expect(said.join('\n')).toContain('pool.end() failed')
  })
})

describe('the NUL fixture is real', () => {
  it('the positive chunk carries exactly one U+0000', () => {
    const row = positiveChunks().find(r => r.content.includes('\u0000'))
    expect(row, 'no positive chunk carries a NUL').toBeDefined()
    expect(NUL_CONTENT).toContain('\u0000')
    expect([...NUL_CONTENT].filter(c => c === '\u0000')).toHaveLength(1)
    expect(row!.content).toBe(NUL_CONTENT)
  })

  it('the adapter sends the sanitised content for that exact fixture row', async () => {
    await writePositiveFixtures(root)
    const sent: unknown[][] = []
    const recorder = {
      async query(text: string, values?: unknown[]) {
        if (/INSERT INTO capital\.chunks/.test(text)) sent.push(values ?? [])
        return { rows: [], rowCount: 0 }
      },
    }
    const rows = positiveChunks()
    await copyLance(recorder, { sourceRoot: root }, async () => ({
      async tableNames() { return ['chunks'] },
      async openTable() { return fakeLanceTable(rows) },
    }))
    const contents = sent.map(v => v[13])
    expect(contents).toContain(NUL_CONTENT_SANITIZED)
    for (const c of contents) expect(String(c)).not.toContain('\u0000')
  })

  it('the fixture source spells the NUL visibly and holds no literal NUL byte', () => {
    const raw = readFileSync(join(HERE, '..', 'testing', 'legacy-copy-fixtures.ts'))
    expect(raw.includes(0)).toBe(false)
    expect(raw.toString('utf-8')).toContain("'ZZ content\\u0000with a NUL'")
  })
})

describe('the count manifest is counts, and says so', () => {
  it('it cannot distinguish two targets whose values differ', () => {
    const a = [{ table: 'portfolio.positions', rows: 3 }]
    const b = [{ table: 'portfolio.positions', rows: 3 }]
    // Same counts, and nothing here knows the rows held different values.
    expect(canonicalCountManifest(a)).toBe(canonicalCountManifest(b))
    expect(canonicalDigest(canonicalCountManifest(a)))
      .toBe(canonicalDigest(canonicalCountManifest(b)))
  })

  it('a changed count IS detected - it is a tripwire, not a proof', () => {
    expect(canonicalCountManifest([{ table: 'portfolio.positions', rows: 3 }]))
      .not.toBe(canonicalCountManifest([{ table: 'portfolio.positions', rows: 4 }]))
  })

  it('the source and the CLI both say counts only', () => {
    const src = readFileSync(join(SRC, 'legacy-copy.ts'), 'utf-8')
    expect(src).toContain('ROW COUNTS, AND ONLY ROW COUNTS')
    expect(src).toContain('is not the replay proof')
    expect(src).not.toContain('canonicalResultManifest')
    const cli = readFileSync(join(BIN, 'legacy-copy.ts'), 'utf-8')
    expect(cli).toContain('row-count manifest digest (counts only)')
    expect(cli).not.toContain('manifestDigest}')
  })
})

describe('SOURCE_HEAD semantics are documented correctly', () => {
  it('it is described as the parent runtime commit pinning the submodule', () => {
    const src = readFileSync(join(SRC, 'legacy-copy.ts'), 'utf-8')
    expect(src).toContain('PARENT runtime repository whose gitlink pins')
    expect(src).toContain('NOT a version of the data')
  })

  it('a malformed head refuses', async () => {
    await writePositiveFixtures(root)
    writeFileSync(join(root, 'SOURCE_HEAD'), 'not-a-commit\n', 'utf-8')
    expect(() => readSourceHead(root)).toThrow(/40-character commit id/)
  })
})

// ---------------------------------------------------------------------------
// ROUND 3 CORRECTIONS
// ---------------------------------------------------------------------------

describe('the port and transport facts are usable over a Unix socket', () => {
  it('a Unix-socket identity with the configured port and one socket passes', () => {
    expect(() => assertTargetIdentity({
      database: 'ai_capital_copy_rehearsal',
      sessionUser: REQUIRED_CREDENTIAL_ROLE,
      currentUser: REQUIRED_CREDENTIAL_ROLE,
      serverVersionNum: 170010,
      systemIdentifier: SYSTEM_ID,
      configuredPort: PORT,
      unixTransport: true,
      socketDirectories: SOCKET,
    }, {
      database: 'ai_capital_copy_rehearsal', systemIdentifier: SYSTEM_ID,
      port: PORT, socketDirectory: SOCKET,
    })).not.toThrow()
  })

  it('inet_server_port() is absent from executable source', () => {
    // It returns NULL over a Unix socket, which is how this rehearsal connects:
    // every valid target would have been refused.
    for (const f of [join(SRC, 'legacy-copy.ts'), ...ADAPTER_FILES, join(BIN, 'legacy-copy.ts')]) {
      expect(/inet_server_port/.test(executableOf(f)), f).toBe(false)
    }
  })

  it("current_setting('port') is what the identity query asks for", () => {
    // codeOf, not executableOf: the SQL lives inside a template literal and
    // executableOf blanks quoted strings.
    const code = codeOf(join(SRC, 'legacy-copy.ts'))
    expect(code).toContain("current_setting('port')::int")
    expect(code).toContain('inet_server_addr() IS NULL')
  })

  it('a whole copy over TCP is refused before SET LOCAL ROLE', async () => {
    const env = await positiveEnv()
    const client = fakeClient({ identity: { unix_transport: false } })
    await expect(runLegacyCopy({
      env, plan: planFor(env), createPoolFn: poolFactory(client), adapters: noopAdapters(),
    })).rejects.toThrow(/connected over TCP/)
    expect(client.statements.some(x => /SET LOCAL ROLE/.test(x))).toBe(false)
    expect(client.statements.some(x => /TRUNCATE/.test(x))).toBe(false)
  })

  it('configuredSocketDirectories splits, trims and drops empties', () => {
    expect(configuredSocketDirectories('/a')).toEqual(['/a'])
    expect(configuredSocketDirectories(' /a , /b ')).toEqual(['/a', '/b'])
    expect(configuredSocketDirectories('')).toEqual([])
    expect(configuredSocketDirectories('  ,  ')).toEqual([])
  })
})

describe('a COMMIT that does not answer is an unknown outcome', () => {
  function commitRejecting() {
    const calls = { release: 0, end: 0 }
    const delegate = fakeClient()
    const client = {
      statements: [] as string[],
      async query(text: string, values?: unknown[]) {
        client.statements.push(text.replace(/\s+/g, ' ').trim())
        if (text === 'COMMIT') throw new Error('zz connection reset during COMMIT')
        return delegate.query(text, values)
      },
      release() { calls.release++ },
    }
    const factory = (url: string) => {
      const pool = createPool(url)
      ;(pool as unknown as { connect: () => Promise<unknown> }).connect = async () => client
      ;(pool as unknown as { end: () => Promise<void> }).end = async () => { calls.end++ }
      return pool
    }
    return { calls, client, factory }
  }

  it('is classified as CopyCommitOutcomeUnknown, never an ordinary failure', async () => {
    const env = await positiveEnv()
    const { factory } = commitRejecting()
    await expect(runLegacyCopy({
      env, plan: planFor(env), createPoolFn: factory, adapters: noopAdapters(),
    })).rejects.toBeInstanceOf(CopyCommitOutcomeUnknown)
  })

  it('preserves the original COMMIT error as cause and as evidence', async () => {
    const env = await positiveEnv()
    const { factory } = commitRejecting()
    const err = await runLegacyCopy({
      env, plan: planFor(env), createPoolFn: factory, adapters: noopAdapters(),
    }).catch((e: unknown) => e) as CopyCommitOutcomeUnknown
    expect(err.commitError).toBeInstanceOf(Error)
    expect((err.commitError as Error).message).toBe('zz connection reset during COMMIT')
    expect((err as unknown as { cause: unknown }).cause).toBe(err.commitError)
    expect(err.message).toContain('zz connection reset during COMMIT')
  })

  it('issues NO ROLLBACK and never claims nothing was copied', async () => {
    const env = await positiveEnv()
    const { client, factory } = commitRejecting()
    await expect(runLegacyCopy({
      env, plan: planFor(env), createPoolFn: factory, adapters: noopAdapters(),
    })).rejects.toBeInstanceOf(CopyCommitOutcomeUnknown)
    expect(client.statements.filter(x => x === 'ROLLBACK')).toHaveLength(0)
    expect(client.statements.filter(x => x === 'COMMIT')).toHaveLength(1)
  })

  it('still releases once and ends the pool once', async () => {
    const env = await positiveEnv()
    const { calls, factory } = commitRejecting()
    await expect(runLegacyCopy({
      env, plan: planFor(env), createPoolFn: factory, adapters: noopAdapters(),
    })).rejects.toBeInstanceOf(CopyCommitOutcomeUnknown)
    expect(calls.release).toBe(1)
    expect(calls.end).toBe(1)
  })

  it('the CLI exits 3, prints the exact wording, and never prints COPY COMPLETE', async () => {
    const env = await positiveEnv()
    const plan = planFor(env)
    const flags = [
      `--expect-system-identifier=${SYSTEM_ID}`, `--expect-port=${PORT}`, `--expect-socket=${SOCKET}`,
    ]
    const r = await runCli([...flags, '--apply', `--confirm=${expectedConfirmation(plan)}`], env, {
      copy: (async () => {
        throw new CopyCommitOutcomeUnknown(new Error('zz connection reset during COMMIT'))
      }) as never,
    })
    const text = r.lines.join('\n')
    expect(r.exitCode).toBe(EXIT_COMMIT_UNKNOWN)
    expect(EXIT_COMMIT_UNKNOWN).not.toBe(EXIT_OK)
    expect(EXIT_COMMIT_UNKNOWN).not.toBe(EXIT_FAILED)
    expect(EXIT_COMMIT_UNKNOWN).not.toBe(EXIT_REFUSED)
    expect(text).toContain(COMMIT_UNKNOWN_MESSAGE)
    expect(text).toContain('COMMIT OUTCOME UNKNOWN - inspect the target and do not rerun')
    expect(text).toContain('zz connection reset during COMMIT')
    expect(text).not.toContain('COPY COMPLETE')
    expect(text).not.toMatch(/rolled back|rollback/i)
  })
})

describe('the copy is a legacy-copy, not a migration', () => {
  it('the orchestrator opens and asserts the legacy-copy operation', () => {
    // codeOf: the operation names ARE string literals, so they must survive.
    const code = codeOf(join(SRC, 'legacy-copy.ts'))
    expect(code).toContain("operation: 'legacy-copy'")
    expect(code).toContain("context: 'admin'")
    expect(code).toContain("assertPoolWriteAuthorized(pool, 'legacy-copy')")
    expect(code).not.toContain("operation: 'migration'")
    expect(code).not.toContain("assertPoolWriteAuthorized(pool, 'migration')")
  })

  it('legacy-copy is a closed member of WriteOperation', () => {
    const wi = readFileSync(join(SRC, 'write-intent.ts'), 'utf-8')
    expect(wi).toContain("| 'legacy-copy'")
    // The existing operations are untouched.
    for (const op of ['claim-persistence', 'pipeline-write', 'migration', 'admin-repair',
      'investment-ledger-import']) {
      expect(wi).toContain(`'${op}'`)
    }
  })
})

describe('CopyRefused is the refusal type', () => {
  it('refusals are CopyRefused, so the CLI can exit 2 rather than 1', async () => {
    try {
      resolveSourceRoot({})
      throw new Error('unreachable')
    } catch (err) {
      expect(err).toBeInstanceOf(CopyRefused)
    }
    mkdirSync(join(root, 'x'), { recursive: true })
  })
})
