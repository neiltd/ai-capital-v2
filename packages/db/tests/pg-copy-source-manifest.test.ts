// STAGE 1 — the units, the guards and the document, offline.
//
// The end-to-end ordering properties (fence before BEGIN, one pid, one
// snapshot, fence still held at publication and at rollback) are proved against
// a LIVE PostgreSQL in tests/pgcopy/source-manifest.int.test.ts, because a fake
// session would answer whatever it was told to and the whole subject there is
// what a real backend does. What is proved HERE is everything that does not
// need a server: the statement guards, the operator-input grammar, the
// contract/column binding, the digest folds, the document's shape, and the
// absence of any target connection path in the module at all.
//
// THE COMMITTED CONTRACT IS THE FIXTURE. Rather than hand-building a 21-table
// artifact - which would drift from the real one and would let a wrong
// expectation look right - these tests read the committed expected-target
// artifact and drive the column binding from it.

import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { inspect } from 'node:util'

import { describe, expect, it } from 'vitest'

import {
  BUILTIN_SEND_FUNCTIONS, PGCOPY_PROTOCOL, rootDigest, tableDigest,
} from '../src/pg-copy/canonical.js'
import { EXPORT_ROLE_NAME } from '../src/pg-copy/export-role.js'
import {
  COPY_TABLES, REVIEWED_CONTRACT_DIGEST, canonicalJson, parseArtifact,
  type ContractArtifact,
} from '../src/pg-copy/schema-contract.js'
import { FENCE_SEQUENCES, type FencedSequenceState } from '../src/pg-copy/source-fence.js'
import {
  EXPORT_BEGIN_SQL, EXPORT_IDENTITY_SQL, EXPORT_ROLLBACK_SQL, MANIFEST_ARTIFACT_VERSION,
  MANIFEST_FILE, MANIFEST_PREFIX, ManifestRefused, SOURCE_CONTRACT_FILE, assertOperatorInput,
  buildManifest, guardExportSession, hashAllTables, hashTable, parseColumnSpecs,
  proveExportSession, typeContractFrom, type ExportSession, type OperatorInput,
  type TableContent,
} from '../src/pg-copy/source-manifest.js'

const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const ARTIFACT_PATH = join(PKG_ROOT, 'contracts', 'expected-target-v19.json')
const SRC = readFileSync(join(PKG_ROOT, 'src', 'pg-copy', 'source-manifest.ts'), 'utf-8')

/**
 * The module source with comments removed.
 *
 * Bans below are on EXECUTABLE CODE. This module's own commentary discusses the
 * things it must not do - "no target client", "never `pg_sequences`" - and a
 * raw-text ban would match the explanation rather than an implementation.
 */
const CODE = SRC
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').filter(l => !/^\s*(\/\/|\*)/.test(l)).join('\n')

const ARTIFACT: ContractArtifact = parseArtifact(readFileSync(ARTIFACT_PATH, 'utf-8'))

const surfaces = (e: unknown): string => {
  const err = e as Error & Record<string, unknown>
  let json = ''
  try { json = JSON.stringify(err, Object.getOwnPropertyNames(err)) } catch { json = '' }
  return [String(err.message), String(err.stack ?? ''),
          Object.getOwnPropertyNames(err).join(','), json,
          inspect(err, { depth: 6 })].join('\n')
}

const OPERATOR: OperatorInput = Object.freeze({
  runId: 'a1b2c3d4',
  generatedAtUtc: '2026-09-24T10:15:30Z',
  implementationHead: '9e3bf539586273bc6af649243d48f92369208134',
  provenanceHead: '1dabab358d6543ae44d61532b8a6a163dfb1c5e5',
  ingestionGitlink: '1dabab358d6543ae44d61532b8a6a163dfb1c5e5',
  expectedTargetSystem: 'ai-capital-v3',
  sourceSystem: 'ai-capital-v2',
  sourceEndpoint: '/Users/x/ai-capital-run',
  sourcePort: '5432',
  sourceDatabase: 'ai_capital',
})

// ---------------------------------------------------------------------------
// A fake export session, driven by the COMMITTED contract
// ---------------------------------------------------------------------------

type ColumnRecord = {
  name: string; format_type: string; type_schema: string; type_name: string
  typtype: string; typcategory: string; typmod: number
  type_extension: string | null; type_extension_version: string | null
}

function artifactColumns(qname: string): ColumnRecord[] {
  const tables = (ARTIFACT.payload as unknown as { tables: Array<{ qname: string;
    columns: ColumnRecord[] }> }).tables
  const t = tables.find(x => x.qname === qname)
  if (t === undefined) throw new Error(`no such table in the artifact: ${qname}`)
  return t.columns
}

/** The twelve-column live-columns row the catalogue would return. */
function liveRow(c: ColumnRecord): string[] {
  const builtin = c.type_schema === 'pg_catalog'
  const sendName = builtin ? BUILTIN_SEND_FUNCTIONS[c.type_name] : `${c.type_name}_send`
  return [
    c.name, c.format_type, c.type_name, c.type_schema, c.typtype, c.typcategory,
    String(c.typmod), sendName, c.type_schema,
    c.type_extension ?? '', c.type_extension_version ?? '',
    builtin ? '' : (c.type_extension ?? ''),
  ]
}

interface FakeOpts {
  /** Batch summaries per table; absent means "empty table". */
  readonly batches?: Record<string, string[][]>
  readonly pk?: Record<string, string[]>
  readonly dropColumn?: string
  readonly identity?: string[]
}

function fakeExport(opts: FakeOpts = {}): ExportSession & { issued: string[] } {
  const issued: string[] = []
  return {
    pid: '4242',
    issued,
    rows: async (sql: string): Promise<string[][]> => {
      issued.push(sql)
      if (sql === EXPORT_IDENTITY_SQL) {
        return [opts.identity ?? ['4242', 'on', 'repeatable read', 'ai_capital', '5432',
                                  EXPORT_ROLE_NAME]]
      }
      const live = /nspname = '([a-z_]+)' AND c\.relname = '([a-z_]+)'[\s\S]*ORDER BY a\.attnum/
        .exec(sql)
      if (live !== null) {
        const q = `${live[1]}.${live[2]}`
        return artifactColumns(q)
          .filter(c => `${q}.${c.name}` !== opts.dropColumn)
          .map(liveRow)
      }
      const pk = /contype = 'p'[\s\S]*ORDER BY u\.ord/.test(sql)
      if (pk) {
        const m = /nspname = '([a-z_]+)' AND c\.relname = '([a-z_]+)'/.exec(sql)
        const q = `${m?.[1]}.${m?.[2]}`
        return (opts.pk?.[q] ?? ['id']).map(n => [n])
      }
      if (sql.startsWith('WITH numbered AS')) {
        const m = /\|batch\|([a-z_.]+)\|/.exec(sql)
        return opts.batches?.[String(m?.[1])] ?? []
      }
      return []
    },
  }
}

const PK: Record<string, string[]> = Object.freeze({
  'portfolio.positions': ['ticker'],
  'portfolio.trade_log': ['id'],
  'capital.watchlist': ['ticker'],
  'capital.documents': ['doc_id'],
  'capital.fetch_log': ['id'],
  'capital.short_interest': ['ticker', 'settlement_date'],
  'capital.api_budget': ['provider', 'window_start'],
  'capital.pending_manual_input': ['request_id'],
  'capital.chunks': ['chunk_id'],
  'thesis.theses': ['thesis_id'],
  'thesis.assumptions': ['assumption_id'],
  'thesis.narratives': ['narrative_id'],
  'thesis.proposals': ['proposal_id'],
  'thesis.proposal_changes': ['change_id'],
  'thesis.theme_memberships': ['theme_id', 'ticker'],
  'briefing.predictions': ['prediction_id'],
  'briefing.qa': ['id'],
  'graph.nodes': ['node_id'],
  'graph.edges': ['edge_id'],
  'graph.proposals': ['proposal_id'],
  'graph.proposal_edges': ['proposal_edge_id'],
})

const hex = (n: number): string => String(n).padStart(2, '0').repeat(32)

const fenced = (q: string, over: Partial<FencedSequenceState> = {}): FencedSequenceState => ({
  last_value: '1', is_called: false, increment_by: '1', min_value: '1',
  max_value: '9223372036854775807', start_value: '1', cache_size: '1', cycle: false,
  data_type: 'integer', owned_by: `${q.replace(/_id_seq$/, '')}.id`, ...over,
} as FencedSequenceState)

const allFenced = (): Record<string, FencedSequenceState> =>
  Object.fromEntries(FENCE_SEQUENCES.map(q => [q, fenced(q)]))

const FENCE = Object.freeze({
  supervisorPid: '111', mechanism: 'S3' as const,
  tables: COPY_TABLES, sequences: FENCE_SEQUENCES,
  candidateInputs: {}, statements: [],
})
const PROOF = Object.freeze({
  provingPid: '222', supervisorPid: '111', relations: 24, ungranted: 0,
})

// ---------------------------------------------------------------------------

describe('the export session is guarded, not trusted', () => {
  it('refuses any statement before the reviewed BEGIN', async () => {
    const g = guardExportSession(fakeExport())
    await expect(g.rows('SELECT 1')).rejects.toThrow(/before its transaction began/)
    expect(g.begun).toBe(false)
    expect(g.issued).toEqual([])
  })

  it('accepts the reviewed BEGIN first, and only then anything else', async () => {
    const inner = fakeExport()
    const g = guardExportSession(inner)
    await g.rows(EXPORT_BEGIN_SQL)
    expect(g.begun).toBe(true)
    await g.rows(EXPORT_IDENTITY_SQL)
    expect([...g.issued]).toEqual([EXPORT_BEGIN_SQL, EXPORT_IDENTITY_SQL])
    expect(inner.issued[0]).toBe(EXPORT_BEGIN_SQL)
  })

  it('refuses a BEGIN that is not exactly the reviewed one', async () => {
    for (const bad of ['BEGIN', 'BEGIN READ ONLY', 'BEGIN TRANSACTION READ ONLY',
                       'BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ',
                       'BEGIN TRANSACTION READ WRITE ISOLATION LEVEL REPEATABLE READ',
                       'BEGIN TRANSACTION READ ONLY ISOLATION LEVEL SERIALIZABLE']) {
      const g = guardExportSession(fakeExport())
      await expect(g.rows(bad), bad).rejects.toThrow(/before its transaction began/)
    }
  })

  it('NEVER lets the export role read mutable sequence state', async () => {
    const g = guardExportSession(fakeExport())
    await g.rows(EXPORT_BEGIN_SQL)
    for (const bad of [
      "SELECT last_value FROM portfolio.trade_log_id_seq",
      "SELECT s.is_called FROM capital.fetch_log_id_seq s",
      "SELECT * FROM pg_catalog.pg_sequences",
      "SELECT pg_catalog.pg_sequence_last_value('briefing.qa_id_seq'::regclass)",
      "SELECT pg_catalog.nextval('briefing.qa_id_seq')",
      "SELECT pg_catalog.setval('briefing.qa_id_seq', 1)",
    ]) {
      await expect(g.rows(bad), bad).rejects.toThrow(/may not read mutable sequence state/)
    }
    expect(g.issued.some(s => /last_value|is_called|pg_sequences/.test(s))).toBe(false)
  })

  it('still permits the contract extractor STATIC sequence definition query', async () => {
    // The distinction this guard exists to draw: pg_catalog.pg_sequence carries
    // every OPTION and no position, and takes no lock. It must stay reachable.
    const g = guardExportSession(fakeExport())
    await g.rows(EXPORT_BEGIN_SQL)
    await expect(g.rows(
      'SELECT sq.seqstart FROM pg_catalog.pg_sequence sq JOIN pg_catalog.pg_class c ' +
      "ON c.oid = sq.seqrelid WHERE n.nspname = ANY ('{portfolio.trade_log_id_seq}')"))
      .resolves.toBeTruthy()
  })
})

describe('the export session must be the one backend, in the one state', () => {
  const identity = (over: Partial<Record<number, string>>): string[] => {
    const base = ['4242', 'on', 'repeatable read', 'ai_capital', '5432', EXPORT_ROLE_NAME]
    for (const [k, v] of Object.entries(over)) base[Number(k)] = v as string
    return base
  }

  it('accepts the reviewed identity', async () => {
    const got = await proveExportSession(fakeExport(), OPERATOR)
    expect(got).toEqual({
      pid: '4242', database: 'ai_capital', port: '5432', principal: EXPORT_ROLE_NAME,
    })
  })

  it('refuses a different pid, a writable session, the wrong isolation, database, port or role',
    async () => {
    const cases: Array<[string[], RegExp]> = [
      [identity({ 0: '9999' }), /not the backend it reported/],
      [identity({ 1: 'off' }), /not read only/],
      [identity({ 2: 'read committed' }), /not repeatable read/],
      [identity({ 2: 'serializable' }), /not repeatable read/],
      [identity({ 3: 'ai_capital_v3' }), /reviewed source database/],
      [identity({ 4: '5433' }), /reviewed source endpoint/],
      [identity({ 5: 'ai_capital_migrator' }), /reviewed export role/],
      [identity({ 5: 'postgres' }), /reviewed export role/],
    ]
    for (const [row, re] of cases) {
      await expect(proveExportSession(fakeExport({ identity: row }), OPERATOR), row.join(','))
        .rejects.toThrow(re)
    }
  })

  it('refuses a malformed identity row', async () => {
    for (const row of [['4242'], []]) {
      await expect(proveExportSession(fakeExport({ identity: row }), OPERATOR))
        .rejects.toThrow(/one row of identity facts/)
    }
  })

  it('reads all six facts in ONE statement', () => {
    expect(EXPORT_IDENTITY_SQL.trim().split(/;/).length).toBe(1)
    expect(EXPORT_IDENTITY_SQL).toMatch(/^\s*SELECT/)
    // CURRENT_USER is a special form: qualifying it does not resolve.
    expect(EXPORT_IDENTITY_SQL).toContain('CURRENT_USER::pg_catalog.text')
    expect(EXPORT_IDENTITY_SQL).not.toContain('pg_catalog.CURRENT_USER')
  })
})

describe('operator input', () => {
  it('accepts the reviewed forms', () => {
    expect(assertOperatorInput(OPERATOR)).toBe(OPERATOR)
  })

  it('refuses a malformed identifier, head, label, port or database', () => {
    const cases: Array<Partial<OperatorInput>> = [
      { runId: 'A1B2C3D4' }, { runId: 'a1b2c3d' },
      { generatedAtUtc: '2026-09-24 10:15:30' }, { generatedAtUtc: '2026-09-24T10:15:30+01:00' },
      { implementationHead: 'not-a-sha' }, { implementationHead: '9E3BF539586273BC6AF649243D48F92369208134' },
      { provenanceHead: '' }, { ingestionGitlink: '1dabab35' },
      { expectedTargetSystem: 'x|y' }, { expectedTargetSystem: 'a\nb' },
      // A connection URL fits the label grammar; it is refused anyway, because
      // a label is copied verbatim into immutable evidence.
      { expectedTargetSystem: 'postgresql://u:s@h/db' },
      { sourceEndpoint: 'postgresql://u:s@h/db' },
      { sourceSystem: 'postgres://u:s@h/db' },
      { sourceEndpoint: '' }, { sourcePort: '0' }, { sourcePort: 'abc' },
      { sourceDatabase: 'Ai_Capital' }, { sourceDatabase: 'ai capital' },
    ]
    for (const over of cases) {
      expect(() => assertOperatorInput({ ...OPERATOR, ...over }), JSON.stringify(over))
        .toThrow(/an operator input is not in the reviewed form/)
    }
  })

  it('never echoes the offending value', () => {
    const canary = `postgresql://u:pw_${Math.random().toString(36).slice(2)}@h/db`
    let thrown: unknown = null
    try { assertOperatorInput({ ...OPERATOR, expectedTargetSystem: canary }) } catch (e) {
      thrown = e
    }
    expect(thrown).toBeInstanceOf(ManifestRefused)
    expect(surfaces(thrown)).not.toContain(canary)
    expect(surfaces(thrown)).not.toContain('pw_')
    expect(surfaces(thrown)).not.toContain('postgresql://')
  })
})

describe('the type contract comes from the extracted source contract', () => {
  it('takes the vector version the catalogue reported', () => {
    const tc = typeContractFrom(ARTIFACT)
    expect(tc.vector?.extension).toBe('vector')
    expect(tc.vector?.dimension).toBe(384)
    expect(tc.vector?.version).toMatch(/^\d+\.\d+/)
  })

  it('refuses a contract that states no vector version', () => {
    const stripped = {
      ...ARTIFACT,
      payload: {
        ...(ARTIFACT.payload as Record<string, unknown>),
        platform: { extensions: [{ name: 'plpgsql', version: '1.0' }] },
      },
    } as ContractArtifact
    expect(() => typeContractFrom(stripped)).toThrow(/no reviewed vector extension version/)
  })
})

describe('content: the columns come from the contract and the catalogue must agree', () => {
  it('parses the twelve-column live-columns shape', () => {
    const [c] = parseColumnSpecs([liveRow(artifactColumns('portfolio.trade_log')[0])])
    expect(c.typnamespace).toBe('pg_catalog')
    expect(c.sendNamespace).toBe('pg_catalog')
    expect(c.typeExtension).toBeNull()
  })

  it('hashes one table from the contract columns, in primary-key order', async () => {
    const t = await hashTable(
      guardedBegun(fakeExport({ pk: PK, batches: { 'portfolio.trade_log': [['0', '3', '90', hex(1)]] } })),
      ARTIFACT, 'portfolio.trade_log', typeContractFrom(ARTIFACT))
    expect(t.columns).toEqual(
      artifactColumns('portfolio.trade_log').map(c => c.name))
    expect(t.pkColumns).toEqual(['id'])
    expect(t.rows).toBe(3)
    expect(t.bytes).toBe(90)
    expect(t.digest).toBe(tableDigest({
      schema: 'portfolio', table: 'trade_log', schemaDigest: ARTIFACT.digest,
      batches: [{ batch: 0, rows: 3, bytes: 90, digest: hex(1) }],
    }))
  })

  it('represents an EMPTY table honestly, and says nothing about how it got that way',
    async () => {
    const empty = await hashTable(
      guardedBegun(fakeExport({ pk: PK })), ARTIFACT, 'briefing.qa', typeContractFrom(ARTIFACT))
    expect(empty.rows).toBe(0)
    expect(empty.bytes).toBe(0)
    expect(empty.batches).toEqual([])
    expect(empty.digest).toBe(tableDigest({
      schema: 'briefing', table: 'qa', schemaDigest: ARTIFACT.digest, batches: [],
    }))
    // An always-empty table and an emptied one are the SAME contents, so they
    // are the same digest. Claiming otherwise would be a lie about the fold.
    const second = await hashTable(
      guardedBegun(fakeExport({ pk: PK })), ARTIFACT, 'briefing.qa', typeContractFrom(ARTIFACT))
    expect(second.digest).toBe(empty.digest)
  })

  it('refuses when the catalogue and the contract disagree about the columns', async () => {
    await expect(hashTable(
      guardedBegun(fakeExport({ pk: PK, dropColumn: 'portfolio.trade_log.id' })),
      ARTIFACT, 'portfolio.trade_log', typeContractFrom(ARTIFACT)))
      .rejects.toThrow(/live columns do not match the contract columns/)
  })

  it('refuses a table with no primary key to order by', async () => {
    await expect(hashTable(
      guardedBegun(fakeExport({ pk: { 'portfolio.trade_log': [] } })),
      ARTIFACT, 'portfolio.trade_log', typeContractFrom(ARTIFACT)))
      .rejects.toThrow(/no primary key to order by/)
  })

  it('refuses a malformed batch summary', async () => {
    await expect(hashTable(
      guardedBegun(fakeExport({ pk: PK, batches: { 'portfolio.trade_log': [['0', 'three', '9', hex(1)]] } })),
      ARTIFACT, 'portfolio.trade_log', typeContractFrom(ARTIFACT)))
      .rejects.toThrow(/expected batch summary shape/)
  })

  it('includes all 21 reviewed tables, ONCE each, in the reviewed order', async () => {
    const s = guardedBegun(fakeExport({ pk: PK }))
    const all = await hashAllTables(s, ARTIFACT, typeContractFrom(ARTIFACT))
    expect(all.length).toBe(21)
    expect(all.map(t => t.qname)).toEqual([...COPY_TABLES])
    expect(new Set(all.map(t => t.qname)).size).toBe(21)

    // Exactly one content query per table, in that order.
    const hashed = s.issued.filter(q => q.startsWith('WITH numbered AS'))
      .map(q => /\|batch\|([a-z_.]+)\|/.exec(q)?.[1])
    expect(hashed).toEqual([...COPY_TABLES])
  })
})

describe('the digest folds react to the drift they are for', () => {
  const base = [{ batch: 0, rows: 2, bytes: 40, digest: hex(1) },
                { batch: 1, rows: 2, bytes: 40, digest: hex(2) }]
  const d = (batches: typeof base): string =>
    tableDigest({ schema: 'portfolio', table: 'trade_log', schemaDigest: ARTIFACT.digest, batches })

  it('a changed batch digest, a lost row and a reordered batch all change the table digest', () => {
    const original = d(base)
    // One byte of one row changed: the server-side batch digest changes.
    expect(d([{ ...base[0], digest: hex(9) }, base[1]])).not.toBe(original)
    // A row deleted: the count and the bytes change too.
    expect(d([{ ...base[0], rows: 1, bytes: 20 }, base[1]])).not.toBe(original)
    // Batches REORDERED: refused outright rather than silently folded, because a
    // discontinuous ordinal sequence means a lost or duplicated batch.
    expect(() => d([base[1], base[0]])).toThrow(/contiguous 0-based sequence/)
  })

  it('a dropped table and a reordered table set both change the root digest', () => {
    const recs = [...COPY_TABLES].map((q, n) => {
      const [schema, table] = q.split('.')
      return { schema, table, digest: hex((n % 90) + 1) }
    })
    const full = rootDigest(recs)
    expect(rootDigest(recs.slice(0, 20))).not.toBe(full)
    expect(rootDigest([recs[1], recs[0], ...recs.slice(2)])).not.toBe(full)
    expect(() => rootDigest([...recs, recs[0]])).toThrow(/more than once/)
  })
})

describe('the manifest document', () => {
  const tables = (): TableContent[] => [...COPY_TABLES].map((q, n) => {
    const [schema, table] = q.split('.')
    return Object.freeze({
      qname: q, schema, table, columns: ['id'], pkColumns: ['id'],
      rows: n, bytes: n * 10, batches: [], digest: hex((n % 90) + 1),
    })
  })

  const build = (over: Partial<Parameters<typeof buildManifest>[0]> = {}): Record<string, unknown> =>
    buildManifest({
      operator: OPERATOR,
      identity: { pid: '4242', database: 'ai_capital', port: '5432', principal: EXPORT_ROLE_NAME },
      contract: ARTIFACT, tables: tables(), sequences: allFenced(),
      fence: FENCE, proof: PROOF, batchRows: 10_000, ...over,
    }) as Record<string, unknown>

  it('carries every required field', () => {
    const m = build()
    expect(m.artifact_version).toBe(MANIFEST_ARTIFACT_VERSION)
    expect(m.run_id).toBe(OPERATOR.runId)
    expect(m.generated_at_utc).toBe(OPERATOR.generatedAtUtc)
    expect(m.implementation_head).toBe(OPERATOR.implementationHead)
    expect(m.provenance_head).toBe(OPERATOR.provenanceHead)
    expect(m.ingestion_gitlink).toBe(OPERATOR.ingestionGitlink)
    expect(m.complete).toBe(true)

    const source = m.source as Record<string, unknown>
    expect(source.system_identifier).toBe('ai-capital-v2')
    expect(source.database).toBe('ai_capital')
    expect(source.port).toBe('5432')
    expect(source.principal).toBe(EXPORT_ROLE_NAME)
    expect(source.transaction).toBe(EXPORT_BEGIN_SQL)

    const target = m.expected_target as Record<string, unknown>
    expect(target.system_identifier).toBe('ai-capital-v3')
    expect(target.contract_digest).toBe(REVIEWED_CONTRACT_DIGEST)
    expect(target.contacted).toBe(false)

    const contract = m.source_contract as Record<string, unknown>
    expect(contract.version).toBe(2)
    expect(contract.digest).toBe(ARTIFACT.digest)
    expect(contract.payload).toEqual(ARTIFACT.payload)

    const content = m.content as Record<string, unknown>
    expect(content.protocol).toBe(PGCOPY_PROTOCOL)
    expect(content.table_count).toBe(21)
    expect((content.tables as unknown[]).length).toBe(21)
    expect((content.tables as Array<{ qname: string }>).map(t => t.qname)).toEqual([...COPY_TABLES])
    expect(content.root_digest).toMatch(/^[0-9a-f]{64}$/)

    const seqs = m.sequences as Array<Record<string, unknown>>
    expect(seqs.length).toBe(3)
    expect(seqs.map(s => s.qname)).toEqual([...FENCE_SEQUENCES])
    for (const s of seqs) {
      expect(typeof s.effective_next).toBe('string')
      expect(s.effective_next).toMatch(/^\d+$/)
      for (const k of ['last_value', 'is_called', 'increment_by', 'min_value', 'max_value',
                       'start_value', 'cache_size', 'cycle', 'data_type', 'owned_by']) {
        expect(s[k], k).toBeDefined()
      }
    }

    const fence = m.fence as Record<string, unknown>
    expect(fence.supervisor_pid).toBe('111')
    expect(fence.proving_pid).toBe('222')
    expect((fence.tables as unknown[]).length).toBe(21)
    expect((fence.sequences as unknown[]).length).toBe(3)
    expect(fence.ungranted_requests).toBe(0)
  })

  it('binds the expected-target digest to the reviewed anchor, not to the source', () => {
    const m = build()
    expect((m.expected_target as { contract_digest: string }).contract_digest)
      .toBe(REVIEWED_CONTRACT_DIGEST)
    expect((m.source_contract as { digest: string }).digest).toBe(ARTIFACT.digest)
  })

  it('keeps sequence positions as decimal STRINGS, past the JSON-number range', () => {
    const big = { ...allFenced() }
    big[FENCE_SEQUENCES[0]] = fenced(FENCE_SEQUENCES[0],
      { last_value: '9007199254740995', is_called: true })
    const m = build({ sequences: big })
    const s = (m.sequences as Array<Record<string, string>>)[0]
    expect(s.last_value).toBe('9007199254740995')
    expect(s.effective_next).toBe('9007199254740996')
    // The round trip a JSON number would have lost.
    expect(JSON.parse(canonicalJson(m as never)).sequences[0].effective_next)
      .toBe('9007199254740996')
  })

  it('refuses a short, reordered or repeated table set', () => {
    expect(() => build({ tables: tables().slice(0, 20) })).toThrow(/reviewed copy set/)
    const swapped = tables()
    ;[swapped[0], swapped[1]] = [swapped[1], swapped[0]]
    expect(() => build({ tables: swapped })).toThrow(/reviewed copy set/)
  })

  it('refuses a short sequence set', () => {
    const two = { ...allFenced() }
    delete two[FENCE_SEQUENCES[2]]
    expect(() => build({ sequences: two })).toThrow(ManifestRefused)
  })

  it('canonicalises deterministically', () => {
    expect(canonicalJson(build() as never)).toBe(canonicalJson(build() as never))
    expect(canonicalJson(build() as never)).toContain('"complete":true')
  })
})

describe('Stage 1 constructs no target connection at all', () => {
  it('imports nothing that can open one', () => {
    expect(CODE).not.toMatch(/from\s+'pg'/)
    expect(CODE).not.toMatch(/from\s+"pg"/)
    expect(CODE).not.toMatch(/\bnew\s+(Pool|Client)\b/)
    expect(CODE).not.toMatch(/\bcreatePool\b|\bgetPool\b/)
    expect(CODE).not.toMatch(/from\s+'\.\.\/pool\.js'/)
    expect(CODE).not.toMatch(/child_process/)
    expect(CODE).not.toMatch(/\bspawn\b|\bexecFile\b/)
  })

  it('names no target session, target url or target credential in its API', () => {
    expect(CODE).not.toMatch(/targetSession|targetUrl|targetClient|targetPool/i)
    expect(CODE).not.toMatch(/process\.env/)
    expect(CODE).not.toMatch(/DATABASE_URL/)
    expect(CODE).not.toMatch(/PGPASSWORD/)
  })

  it('states the expected target as a label and a compile-time digest only', () => {
    expect(CODE).toContain('expectedTargetSystem')
    expect(CODE).toContain('REVIEWED_CONTRACT_DIGEST')
    expect(CODE).toContain('contacted: false')
  })

  it('publishes under the reviewed prefix and file names', () => {
    expect(MANIFEST_PREFIX).toBe('source-manifest')
    expect(MANIFEST_FILE).toBe('manifest.json')
    expect(SOURCE_CONTRACT_FILE).toBe('source-contract.json')
    expect(EXPORT_ROLLBACK_SQL).toBe('ROLLBACK')
  })

  it('never commits the source transaction', () => {
    expect(CODE).not.toMatch(/'COMMIT'/)
    expect(CODE).not.toMatch(/"COMMIT"/)
  })
})

/** A guarded session that has already sent the reviewed BEGIN. */
function guardedBegun(inner: ExportSession & { issued: string[] }): ExportSession & {
  issued: string[]
} {
  const g = guardExportSession(inner)
  void g.rows(EXPORT_BEGIN_SQL)
  return { pid: g.pid, rows: g.rows, issued: inner.issued }
}
