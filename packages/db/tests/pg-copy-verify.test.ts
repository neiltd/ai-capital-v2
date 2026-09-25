// THE INDEPENDENT VERIFIER — the parts that need no server.
//
// What is proved here is everything that is a property of the CODE: that the
// content algorithm is written independently of the copier's, that its framing
// and folds are deterministic and self-describing, that every comparison the
// verifier makes refuses rather than tolerates, that nothing it can say carries
// a row value or a credential, and that its evidence is published exactly once,
// frozen, digested, and never overwritten.
//
// The one thing that CANNOT be proved here is that the two implementations
// agree about real bytes. That needs two live databases and is proved in
// `tests/pgcopy/verify.int.test.ts`.

import { execFileSync } from 'node:child_process'
import {
  mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { inspect } from 'node:util'

import { afterEach, describe, expect, it } from 'vitest'

import {
  DIGEST_FILE, REAL_EVIDENCE_OPS, TEMPORARY_NAME_PREFIX, evidenceNames, parseDigestFile,
  publishEvidence, sha256Hex, verifyPublishedEvidence, type EvidenceOps,
} from '../src/pg-copy/evidence.js'
import {
  COPY_TABLES, REVIEWED_CONTRACT_DIGEST, canonicalJson, contractDigest,
  type Canonical, type ContractArtifact,
} from '../src/pg-copy/schema-contract.js'
import {
  FENCE_SEQUENCES, FENCE_SEQUENCE_LOCK_MODE, FENCE_TABLES,
  FENCE_TABLE_LOCK_MODE,
} from '../src/pg-copy/source-fence.js'
import {
  BORROWED_STATEMENTS, FENCE_DISPOSITION_SENTENCE, PHASE_REASON, PostCommitVerificationFailed,
  SUPERVISOR_PID_SQL,
  VERIFICATION_CONTENT_FILE, VERIFICATION_FILE, VERIFICATION_PREFIX, VERIFY_BEGIN_SQL,
  VERIFY_IDENTITY_SQL, VerificationEvidenceOutcomeUnknown,
  VerificationEvidencePublishedButUnverified, VerificationEvidenceRefused,
  assertCompatibilityMatches, assertContentMatches, assertHandoff, assertSequencesMatch,
  assertSourceArtifact, assertTargetArtifact, borrowReadOnly, proveCompleteFence,
  recognitionOf, runVerification, settleFenceDisposition, verificationContentDocument,
  verificationDocument,
  type FenceDisposition, type SequencePair, type VerificationState, type VerifierHandoff,
  type VerifyPhase,
} from '../src/pg-copy/verify.js'
import {
  VERIFY_BATCH_ROWS, VERIFY_SEND, VerifyContentRefused, assertVerifiableColumns,
  parseVerifyColumns, verifyBatchSql, verifyRootDigest, verifyRowFrameSql, verifyTableDigest,
  verifyVectorFrom, type VerifyBatch, type VerifyColumn, type VerifyVector,
} from '../src/pg-copy/verify-content.js'

const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const strip = (text: string): string => text
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').filter(l => !/^\s*(\/\/|\*)/.test(l)).join('\n')

const read = (rel: string): string => readFileSync(join(PKG_ROOT, rel), 'utf-8')
const CONTENT = strip(read('src/pg-copy/verify-content.ts'))
const VERIFY = strip(read('src/pg-copy/verify.ts'))
const STAGE2 = strip(read('src/pg-copy/stage2.ts'))

const surfaces = (e: unknown): string => {
  const err = e as Error & Record<string, unknown>
  let json = ''
  try { json = JSON.stringify(err, Object.getOwnPropertyNames(err)) } catch { json = '' }
  return [String(err.message), String(err.stack ?? ''),
          Object.getOwnPropertyNames(err).join(','), json,
          inspect(err, { depth: 8, showHidden: true })].join('\n')
}

// ---------------------------------------------------------------------------
// FIXTURES
// ---------------------------------------------------------------------------

const VECTOR: VerifyVector = Object.freeze({
  extension: 'vector', version: '0.8.0', dimension: 384, sendName: 'vector_send',
})

const column = (over: Partial<VerifyColumn> = {}): VerifyColumn => ({
  name: 'value',
  typname: 'text',
  typNamespace: 'pg_catalog',
  typtype: 'b',
  typcategory: 'S',
  typmod: -1,
  sendName: 'textsend',
  sendNamespace: 'pg_catalog',
  typeExtension: null,
  typeExtensionVersion: null,
  sendExtension: null,
  ...over,
})

const vectorColumn = (): VerifyColumn => column({
  name: 'embedding', typname: 'vector', typNamespace: 'public', typcategory: 'U',
  typmod: 384, sendName: 'vector_send', sendNamespace: 'public',
  typeExtension: 'vector', typeExtensionVersion: '0.8.0', sendExtension: 'vector',
})

const hex = (seed: string): string =>
  sha256Hex(Buffer.from(`verify-fixture|${seed}`, 'utf-8'))

const batch = (n: number, over: Partial<VerifyBatch> = {}): VerifyBatch =>
  ({ batch: n, rows: 3, bytes: 90, digest: hex(`batch-${n}`), ...over })

interface FakeTable {
  qname: string; schema: string; table: string
  columns: readonly string[]; pkColumns: readonly string[]
  rows: number; bytes: number; batches: readonly VerifyBatch[]; digest: string
}

const fakeTable = (qname: string): FakeTable => {
  const [schema, table] = qname.split('.')
  const batches = [batch(0, { digest: hex(`${qname}-b0`) })]
  return {
    qname, schema, table,
    columns: ['id'], pkColumns: ['id'],
    rows: 3, bytes: 90, batches, digest: hex(qname),
  }
}

const fakeContent = (): { tables: FakeTable[]; rootDigest: string } => {
  const tables = COPY_TABLES.map(fakeTable)
  return { tables, rootDigest: verifyRootDigest(tables) }
}

const COMPAT_DOC: Canonical = Object.freeze({
  source_recognition: 'CURRENT_V10',
  target_recognition: 'CURRENT_V19',
  target_only_indexes: [],
  target_only_foreign_keys: [],
})

const HANDOFF = (over: Partial<VerifierHandoff> = {}): VerifierHandoff => {
  const c = fakeContent()
  return {
    bundleName: 'source-manifest-20260924T101530Z-a1b2c3d4',
    rootDigest: c.rootDigest,
    sourceContractDigest: hex('source-contract'),
    targetContractDigest: REVIEWED_CONTRACT_DIGEST,
    sourceRecognition: 'CURRENT_V10',
    targetRecognition: 'CURRENT_V19',
    tables: c.tables.map(t => ({ qname: t.qname, digest: t.digest, rows: t.rows })),
    sequences: FENCE_SEQUENCES.map((q, n) => ({ qname: q, effectiveNext: String(n + 7) })),
    compatibility: COMPAT_DOC,
    source: { systemIdentifier: '7689229024919775042', database: 'ai_capital', role: 'ai_capital_v3_export' },
    target: { systemIdentifier: '7689229024919775999', database: 'ai_capital_v3', role: 'ai_capital_migrator' },
    fence: { supervisorPid: '4242', mechanism: 'S3' },
    ...over,
  }
}

const PUBLISHED = (over: Record<string, unknown> = {}): Record<string, never> => {
  const c = fakeContent()
  return {
    source_contract: { digest: HANDOFF().sourceContractDigest },
    content: {
      root_digest: c.rootDigest,
      tables: c.tables.map(t => ({ qname: t.qname, digest: t.digest })),
    },
    ...over,
  } as unknown as Record<string, never>
}

const SEQ_PAIRS = (): SequencePair[] => FENCE_SEQUENCES.map((q, n) => ({
  qname: q, sourceEffectiveNext: String(n + 7), targetEffectiveNext: String(n + 7),
}))

const artifact = (digest: string, recognition: string): ContractArtifact =>
  ({ pgcopy_schema_contract_version: 2, digest,
     payload: { migrations: { recognition } } as Canonical })

const thrownBy = (fn: () => void): PostCommitVerificationFailed => {
  try { fn() } catch (e) {
    expect(e).toBeInstanceOf(PostCommitVerificationFailed)
    return e as PostCommitVerificationFailed
  }
  throw new Error('expected a refusal, and none was raised')
}

// ---------------------------------------------------------------------------

describe('the verifier is an INDEPENDENT implementation', () => {
  it('imports nothing from the copier content path', () => {
    for (const [name, src] of [['verify-content', CONTENT], ['verify', VERIFY]] as const) {
      expect(src, name).not.toMatch(/from\s+'\.\/canonical\.js'/)
      expect(src, name).not.toMatch(/from\s+'\.\/source-manifest\.js'/)
      expect(src, name).not.toMatch(/from\s+'\.\/stage2\.js'/)
      expect(src, name).not.toMatch(/from\s+'\.\/binary-copy\.js'/)
      // And not by NAME either, however it were reached.
      expect(src, name).not.toContain('hashAllTables')
      expect(src, name).not.toContain('hashTable(')
      expect(src, name).not.toContain('tableDigest(')
      expect(src, name).not.toContain('rootDigest(')
      expect(src, name).not.toContain('assertTargetHoldsSource')
      expect(src, name).not.toContain('copyTableBinary')
      expect(src, name).not.toContain('batchDigestSql')
      expect(src, name).not.toContain('rowFrameSql')
    }
  })

  it('Stage 2 depends on the verifier only for a TYPE', () => {
    // One direction only. A runtime import from the copier into the verifier -
    // or the reverse - is how "two implementations" quietly becomes one.
    // The specifier is ASSEMBLED, not written out: a literal relative import
    // inside a test file reads to `findDeadTestFiles` as a real import of
    // something that does not exist beside tests/, and it would report this
    // whole suite as unloadable - the check doing its job on a string that
    // only looked like an import.
    const spec = ['.', '/verify.js'].join('')
    expect(STAGE2).toContain(`import type { VerifierHandoff } from '${spec}'`)
    expect(STAGE2).not.toMatch(/^import \{[^}]*\} from '\.\/verify(-content)?\.js'/m)
    expect(STAGE2).not.toContain('verifyAllTables')
  })

  it('measures the two databases through two SEPARATE sessions', () => {
    // A verifier that measured one session twice would compare a database with
    // itself and agree every time.
    expect(VERIFY).toContain('verifyAllTables(sourceSession, sourceContract, vector)')
    expect(VERIFY).toContain('verifyAllTables(targetSession, sourceContract, vector)')
  })

  it('runs EVERY reviewed check, in the reviewed order', () => {
    // Each comparison is a separate exported assertion so it can be tested on
    // its own terms; that only proves anything if the lifecycle actually calls
    // it. A mutant that deletes a call would otherwise leave 56 green tests
    // for checks nothing runs.
    const calls = [
      'assertHandoff(i.handoff)',
      "proveCompleteFence(\n      prover, 'V3-fence-before'",
      'assertSourceArtifact(sourceContract, h, i.publishedDocument)',
      'assertTargetArtifact(targetContract, h)',
      'assertContentMatches(measuredSource, measuredTarget, h, i.publishedDocument)',
      'assertSequencesMatch(state.sequences, h)',
      'assertCompatibilityMatches(rebuilt, h.compatibility)',
      "proveCompleteFence(\n      prover, 'V11-fence-after'",
      'publishOutcome(i, h, state)',
    ]
    let at = -1
    for (const c of calls) {
      const n = VERIFY.indexOf(c)
      expect(n, c).toBeGreaterThan(at)
      at = n
    }
  })

  it('never trims a scale, never renders a value as text, never SELECTs *', () => {
    for (const [name, src] of [['verify-content', CONTENT], ['verify', VERIFY]] as const) {
      expect(src, name).not.toContain('trim_scale')
      expect(src, name).not.toMatch(/SELECT\s+\*/)
      // No value is cast to text anywhere. The only `::pg_catalog.text` casts
      // in the content SQL are over catalogue metadata and the header's own
      // counts, never over a column being hashed.
      expect(src, name).not.toMatch(/\bto_char\(/)
      expect(src, name).not.toMatch(/\bsum\(\s*[a-z_]*sha/i)
    }
    expect(VERIFY_SEND.numeric).toBe('numeric_send')
  })

  it('aggregates in an ORDERED way and never by sum', () => {
    const sql = verifyBatchSql({
      schema: 'portfolio', table: 'trade_log', pkColumns: ['id'],
      columns: [column({ name: 'id', typname: 'int4', sendName: 'int4send' })],
      schemaDigest: hex('schema'), vector: VECTOR,
    })
    expect(sql).toContain("string_agg(rh, '' ORDER BY rn)")
    expect(sql).toContain('ORDER BY "id"')
    expect(sql).toContain('GROUP BY b')
    expect(sql).toContain(' ORDER BY b')
    // `sum` appears once, over BYTE LENGTHS, and never over a row hash.
    expect(sql.match(/sum\(/g)?.length).toBe(2)
    expect(sql).toContain('sum(len)')
  })
})

describe('the row frame', () => {
  it('is length-framed, tagged and 1-based, and distinguishes NULL from empty', () => {
    const sql = verifyRowFrameSql(
      [column({ name: 'a' }), column({ name: 'b', typname: 'int4', sendName: 'int4send' })],
      VECTOR)
    // The live column COUNT leads the frame.
    expect(sql.startsWith('pg_catalog.int4send(2)')).toBe(true)
    expect(sql).toContain('pg_catalog.int4send(1)')
    expect(sql).toContain('pg_catalog.int4send(2)')
    // NULL is one byte and carries NO length; a non-NULL - INCLUDING an empty
    // string - is a different tag followed by its own length, so `''` frames as
    // 0x01,0,0,0,0 and can never collide with NULL's 0x00.
    expect(sql).toContain("'\\x00'::pg_catalog.bytea")
    expect(sql).toContain("'\\x01'::pg_catalog.bytea")
    expect(sql).toContain(
      'pg_catalog.int4send(pg_catalog.octet_length("pg_catalog"."textsend"("a")))')
    expect(sql).not.toContain("concat_ws")
  })

  it('names EVERY send function schema-qualified, for every supported type', () => {
    for (const [typname, send] of Object.entries(VERIFY_SEND)) {
      const sql = verifyRowFrameSql([column({ name: 'v', typname, sendName: send })], VECTOR)
      expect(sql, typname).toContain(`"pg_catalog"."${send}"("v")`)
    }
    // The one reviewed extension type resolves into its own namespace.
    expect(verifyRowFrameSql([vectorColumn()], VECTOR))
      .toContain('"public"."vector_send"("embedding")')
  })

  it('jsonb and vector go through their own binary send functions', () => {
    const sql = verifyRowFrameSql(
      [column({ name: 'doc', typname: 'jsonb', sendName: 'jsonb_send' }), vectorColumn()],
      VECTOR)
    expect(sql).toContain('"pg_catalog"."jsonb_send"("doc")')
    expect(sql).toContain('"public"."vector_send"("embedding")')
    expect(sql).not.toContain('jsonb_pretty')
    expect(sql).not.toContain('::pg_catalog.text')
  })

  it('REFUSES every type outside the reviewed set, and says which kind it was', () => {
    const cases: Array<[string, Partial<VerifyColumn>]> = [
      ['array types', { typcategory: 'A' }],
      ['composite types', { typtype: 'c' }],
      ['domain types', { typtype: 'd' }],
      ['enum types', { typtype: 'e' }],
      ['range types', { typtype: 'r' }],
      ['range types', { typtype: 'm' }],
      ['float4 and float8', { typname: 'float8', sendName: 'float8send' }],
      ['float4 and float8', { typname: 'float4', sendName: 'float4send' }],
      ['reviewed built-in set', { typname: 'bytea', sendName: 'byteasend' }],
      ['reviewed built-in set', { typname: 'money', sendName: 'cash_send' }],
    ]
    for (const [says, over] of cases) {
      expect(() => assertVerifiableColumns([column(over)], VECTOR), JSON.stringify(over))
        .toThrow(new RegExp(says.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    }
    // A SHADOWED send function is refused even though the type name is right.
    expect(() => assertVerifiableColumns([column({ sendNamespace: 'public' })], VECTOR))
      .toThrow(/shadowed send function/)
    // A `public.text` cannot pass on the strength of the word "text".
    expect(() => assertVerifiableColumns([column({ typNamespace: 'public' })], VECTOR))
      .toThrow(/not the reviewed extension type/)
    // A built-in owned by an extension is not a built-in.
    expect(() => assertVerifiableColumns([column({ typeExtension: 'vector' })], VECTOR))
      .toThrow(/not owned by an extension/)
    // The vector contract is checked in full.
    expect(() => assertVerifiableColumns([{ ...vectorColumn(), typmod: 380 }], VECTOR))
      .toThrow(/dimension 380/)
    expect(() => assertVerifiableColumns(
      [{ ...vectorColumn(), typeExtensionVersion: '0.7.0' }], VECTOR))
      .toThrow(/reviewed installed version/)
    expect(() => assertVerifiableColumns([], VECTOR)).toThrow(/no live columns/)
  })

  it('refuses a table with no primary key to order by', () => {
    expect(() => verifyBatchSql({
      schema: 'graph', table: 'nodes', pkColumns: [], columns: [column()],
      schemaDigest: hex('s'), vector: VECTOR,
    })).toThrow(/primary key to order by/)
  })

  it('refuses an identifier outside the reviewed grammar rather than escaping it', () => {
    expect(() => verifyRowFrameSql([column({ name: 'a"b' })], VECTOR)).toThrow(VerifyContentRefused)
    expect(() => verifyRowFrameSql([column({ name: 'A' })], VECTOR)).toThrow(/grammar/)
  })

  it('requires an installed vector version, and never assumes one', () => {
    expect(() => verifyVectorFrom(
      { pgcopy_schema_contract_version: 2, digest: hex('x'),
        payload: { platform: { extensions: [] } } as Canonical }))
      .toThrow(/no installed vector extension version/)
    expect(verifyVectorFrom(
      { pgcopy_schema_contract_version: 2, digest: hex('x'),
        payload: { platform: { extensions: [{ name: 'vector', version: '0.8.0' }] } } as Canonical })
      .version).toBe('0.8.0')
  })

  it('parses a column description, or refuses its shape', () => {
    const c = parseVerifyColumns([[
      'v', 'text', 'pg_catalog', 'b', 'S', '-1', 'textsend', 'pg_catalog', '', '', '']])
    expect(c[0].typeExtension).toBeNull()
    expect(c[0].typmod).toBe(-1)
    expect(() => parseVerifyColumns([['too', 'few']])).toThrow(/expected shape/)
  })
})

describe('the folds are deterministic and self-describing', () => {
  const base = { schema: 'graph', table: 'nodes', schemaDigest: hex('schema') }

  it('the table digest changes with EVERY component', () => {
    const d = verifyTableDigest({ ...base, batches: [batch(0), batch(1)] })
    expect(d).toBe(verifyTableDigest({ ...base, batches: [batch(0), batch(1)] }))
    const variants = [
      { ...base, table: 'edges', batches: [batch(0), batch(1)] },
      { ...base, schema: 'thesis', batches: [batch(0), batch(1)] },
      { ...base, schemaDigest: hex('other'), batches: [batch(0), batch(1)] },
      { ...base, batches: [batch(0)] },
      { ...base, batches: [batch(0), batch(1, { rows: 4 })] },
      { ...base, batches: [batch(0), batch(1, { bytes: 91 })] },
      { ...base, batches: [batch(0), batch(1, { digest: hex('moved') })] },
    ]
    const seen = new Set([d])
    for (const v of variants) seen.add(verifyTableDigest(v))
    expect(seen.size).toBe(variants.length + 1)
  })

  it('a zero-row table is a DEFINED value and says nothing about how it emptied', () => {
    expect(verifyTableDigest({ ...base, batches: [] }))
      .toBe(verifyTableDigest({ ...base, batches: [] }))
    expect(verifyTableDigest({ ...base, batches: [] }))
      .not.toBe(verifyTableDigest({ ...base, batches: [batch(0, { rows: 0, bytes: 0 })] }))
  })

  it('REFUSES a discontinuous, repeated or reordered batch sequence', () => {
    expect(() => verifyTableDigest({ ...base, batches: [batch(0), batch(2)] }))
      .toThrow(/contiguous 0-based sequence/)
    expect(() => verifyTableDigest({ ...base, batches: [batch(0), batch(0)] }))
      .toThrow(/contiguous 0-based sequence/)
    expect(() => verifyTableDigest({ ...base, batches: [batch(1), batch(0)] }))
      .toThrow(/contiguous 0-based sequence/)
    expect(() => verifyTableDigest({ ...base, batches: [batch(0, { digest: 'nope' })] }))
      .toThrow(/64 lowercase hexadecimal/)
  })

  it('the root digest is ORDERED, counted, and refuses a repeat', () => {
    const t = (q: string): { schema: string; table: string; digest: string } => {
      const [schema, table] = q.split('.')
      return { schema, table, digest: hex(q) }
    }
    const a = verifyRootDigest(COPY_TABLES.map(t))
    expect(a).toBe(verifyRootDigest(COPY_TABLES.map(t)))
    const swapped = [...COPY_TABLES]
    ;[swapped[0], swapped[1]] = [swapped[1], swapped[0]]
    expect(verifyRootDigest(swapped.map(t))).not.toBe(a)
    expect(verifyRootDigest(COPY_TABLES.slice(0, 20).map(t))).not.toBe(a)
    expect(() => verifyRootDigest([t('graph.nodes'), t('graph.nodes')]))
      .toThrow(/more than once/)
  })

  it('the reviewed batch size is stated, not inferred', () => {
    expect(VERIFY_BATCH_ROWS).toBe(10_000)
    expect(() => verifyBatchSql({
      schema: 'graph', table: 'nodes', pkColumns: ['id'], columns: [column()],
      schemaDigest: hex('s'), vector: VECTOR, batchRows: 0,
    })).toThrow(/positive safe integer/)
  })
})

describe('the handoff is checked, not trusted', () => {
  it('accepts the reviewed form', () => {
    expect(assertHandoff(HANDOFF())).toBeDefined()
  })

  it('REFUSES every malformation, and never before it has looked', () => {
    const variants: Array<Partial<VerifierHandoff>> = [
      { rootDigest: 'nope' },
      { sourceContractDigest: '' },
      // The target anchor is the COMMITTED digest, not whatever was handed in.
      { targetContractDigest: hex('substitute') },
      { bundleName: 'not-a-bundle' },
      { source: { systemIdentifier: '0', database: 'ai_capital', role: 'r' } },
      { source: { systemIdentifier: '1', database: 'Bad Name', role: 'r' } },
      { fence: { supervisorPid: 'x', mechanism: 'S3' } },
      { tables: [] },
      { tables: HANDOFF().tables.slice(0, 20) },
      { tables: [...HANDOFF().tables].reverse() },
      { tables: HANDOFF().tables.map(t => ({ ...t, rows: -1 })) },
      { sequences: [] },
      { sequences: HANDOFF().sequences.map(s => ({ ...s, effectiveNext: 'x' })) },
    ]
    for (const v of variants) {
      const e = thrownBy(() => assertHandoff(HANDOFF(v)))
      expect(e.phase, JSON.stringify(v)).toBe('V1-handoff')
    }
  })
})

describe('the comparisons refuse, and name only reviewed things', () => {
  it('SOURCE DRIFT after Stage 2 is refused, three ways', () => {
    const h = HANDOFF()
    const good = artifact(h.sourceContractDigest, 'CURRENT_V10')
    expect(() => assertSourceArtifact(good, h, PUBLISHED())).not.toThrow()

    // The source changed since Stage 2 measured it.
    expect(thrownBy(() => assertSourceArtifact(
      artifact(hex('drifted'), 'CURRENT_V10'), h, PUBLISHED())).at)
      .toBe('the Stage-2 source contract digest')
    // Stage 2 agreed with a source the PUBLISHED BUNDLE never described.
    expect(thrownBy(() => assertSourceArtifact(
      good, h, PUBLISHED({ source_contract: { digest: hex('elsewhere') } }))).at)
      .toBe('the published manifest contract digest')
    // The ledger is no longer the one the copy was authorised for.
    expect(thrownBy(() => assertSourceArtifact(
      artifact(h.sourceContractDigest, 'CURRENT_V11'),
      { ...h, sourceRecognition: 'CURRENT_V11' }, PUBLISHED())).at)
      .toBe('the source recognition')
  })

  it('TARGET DRIFT after Stage 2 is refused, and anchored to the COMMITTED digest', () => {
    const h = HANDOFF()
    expect(() => assertTargetArtifact(
      artifact(REVIEWED_CONTRACT_DIGEST, 'CURRENT_V19'), h)).not.toThrow()
    expect(thrownBy(() => assertTargetArtifact(
      artifact(hex('migrated-under-us'), 'CURRENT_V19'), h)).at)
      .toBe('the reviewed target digest')
    expect(thrownBy(() => assertTargetArtifact(
      artifact(REVIEWED_CONTRACT_DIGEST, 'CURRENT_V21'),
      { ...h, targetRecognition: 'CURRENT_V21' })).at)
      .toBe('the target recognition')
  })

  it('CONTENT mismatch names the table, the batch and WHICH claim it broke', () => {
    const h = HANDOFF()
    const s = fakeContent()
    const t = fakeContent()
    expect(() => assertContentMatches(s as never, t as never, h, PUBLISHED())).not.toThrow()

    const mutate = (
      side: 'source' | 'target', f: (c: ReturnType<typeof fakeContent>) => void,
    ): PostCommitVerificationFailed => {
      const a = fakeContent()
      const b = fakeContent()
      f(side === 'source' ? a : b)
      return thrownBy(() => assertContentMatches(a as never, b as never, h, PUBLISHED()))
    }

    // ROW COUNT, BATCH SEQUENCE AND DIGEST are three separate answers.
    expect(mutate('target', c => { c.tables[3].rows = 2 }).at)
      .toBe(`${COPY_TABLES[3]} row count`)
    expect(mutate('target', c => { c.tables[3].batches = [] as never }).at)
      .toBe(`${COPY_TABLES[3]} batch count`)
    expect(mutate('target', c => {
      c.tables[3].batches = [{ ...c.tables[3].batches[0], rows: 2 }]
    }).at).toBe(`${COPY_TABLES[3]} batch 0 row count`)
    expect(mutate('target', c => {
      c.tables[3].batches = [{ ...c.tables[3].batches[0], bytes: 2 }]
    }).at).toBe(`${COPY_TABLES[3]} batch 0 byte count`)
    expect(mutate('target', c => {
      c.tables[3].batches = [{ ...c.tables[3].batches[0], digest: hex('moved') }]
    }).at).toBe(`${COPY_TABLES[3]} batch 0 digest`)
    expect(mutate('target', c => { c.tables[3].digest = hex('moved') }).at)
      .toBe(`${COPY_TABLES[3]} digest`)

    // AND EACH SIDE AGAINST THE TWO EXTERNAL CLAIMS.
    const bothMoved = (): PostCommitVerificationFailed => {
      const a = fakeContent()
      const b = fakeContent()
      a.tables[5].digest = hex('moved')
      b.tables[5].digest = hex('moved')
      return thrownBy(() => assertContentMatches(a as never, b as never, h, PUBLISHED()))
    }
    // The two sides AGREE and are both wrong - which is exactly the failure a
    // single implementation could never see.
    expect(bothMoved().at).toBe(`${COPY_TABLES[5]} against the Stage-2 result`)

    // ROOTS, each side named separately. Three values and three pairwise
    // equalities: only the check that runs FIRST for a given case can catch
    // it, so each case is constructed to leave exactly one candidate.
    //
    // THE SOURCE MOVED, and the target moved with it - both agree, both are
    // wrong. Only the source-against-Stage-2 check can see this.
    expect(mutate('source', c => { c.rootDigest = hex('r') }).at)
      .toBe('the source root against the Stage-2 result')
    // THE TARGET MOVED, alone. Only the target-against-Stage-2 check sees it
    // before the source-to-target comparison would.
    expect(mutate('target', c => { c.rootDigest = hex('r') }).at)
      .toBe('the target root against the Stage-2 result')
    const rootsAgreeAndDiffer = (): PostCommitVerificationFailed => {
      const a = fakeContent()
      const b = fakeContent()
      a.rootDigest = hex('r')
      b.rootDigest = hex('r')
      return thrownBy(() => assertContentMatches(a as never, b as never, h, PUBLISHED()))
    }
    expect(rootsAgreeAndDiffer().at).toBe('the source root against the Stage-2 result')

    // AND AGAINST THE PUBLISHED MANIFEST.
    expect(thrownBy(() => assertContentMatches(
      s as never, t as never, h,
      PUBLISHED({ content: { root_digest: hex('other'),
                             tables: fakeContent().tables.map(
                               x => ({ qname: x.qname, digest: x.digest })) } }))).at)
      .toBe('the root against the published manifest')

    // A TRUNCATED published table set is refused before anything is compared.
    expect(thrownBy(() => assertContentMatches(
      s as never, t as never, h,
      PUBLISHED({ content: { root_digest: s.rootDigest, tables: [] } }))).at)
      .toBe('the published table set')
  })

  it('SEQUENCE mismatch names the sequence', () => {
    const h = HANDOFF()
    expect(() => assertSequencesMatch(SEQ_PAIRS(), h)).not.toThrow()

    const drift = SEQ_PAIRS()
    drift[1] = { ...drift[1], targetEffectiveNext: '999' }
    expect(thrownBy(() => assertSequencesMatch(drift, h)).at).toBe(FENCE_SEQUENCES[1])

    // The two sides AGREE with each other and disagree with what Stage 2 left.
    const both = SEQ_PAIRS().map(p => ({ ...p, sourceEffectiveNext: '999', targetEffectiveNext: '999' }))
    expect(thrownBy(() => assertSequencesMatch(both, h)).at)
      .toBe(`${FENCE_SEQUENCES[0]} against the Stage-2 result`)

    expect(thrownBy(() => assertSequencesMatch(SEQ_PAIRS().slice(0, 2), h)).at)
      .toBe('the sequence set')
    expect(thrownBy(() => assertSequencesMatch(
      [...SEQ_PAIRS()].reverse(), h)).at).toBe(FENCE_SEQUENCES[0])
  })

  it('COMPATIBILITY mismatch is canonical, so an ADDED field is compared too', () => {
    expect(() => assertCompatibilityMatches(COMPAT_DOC, COMPAT_DOC)).not.toThrow()
    // Key ORDER is not a difference.
    expect(() => assertCompatibilityMatches(
      { target_only_foreign_keys: [], target_only_indexes: [],
        target_recognition: 'CURRENT_V19', source_recognition: 'CURRENT_V10' },
      COMPAT_DOC)).not.toThrow()
    // A TOLERATED target-only index that Stage 2 never recorded is a difference.
    expect(thrownBy(() => assertCompatibilityMatches(
      { ...(COMPAT_DOC as Record<string, Canonical>),
        target_only_indexes: [{ qname: 'graph.nodes', name: 'ix', definition: 'd',
                                is_valid: true, is_ready: true, predicate: '', expressions: '' }] },
      COMPAT_DOC)).phase).toBe('V10-compatibility')
    // And a field ADDED to one side is caught without this test naming it.
    expect(thrownBy(() => assertCompatibilityMatches(
      { ...(COMPAT_DOC as Record<string, Canonical>), something_new: true },
      COMPAT_DOC)).phase).toBe('V10-compatibility')
  })

  it('carries a reviewed NAME and never a measured value', () => {
    const secret = 'pw_LEAKCANARY_987654321'
    const s = fakeContent()
    const t = fakeContent()
    t.tables[0].digest = sha256Hex(Buffer.from(secret, 'utf-8'))
    const e = thrownBy(() => assertContentMatches(
      s as never, t as never, HANDOFF(), PUBLISHED()))
    const text = surfaces(e)
    expect(text).not.toContain(secret)
    expect(text).not.toContain(t.tables[0].digest)
    expect(text).not.toContain(s.tables[0].digest)
    expect(text).toContain(COPY_TABLES[0])
    // The sentence itself is one of the reviewed ones.
    expect(Object.values(PHASE_REASON)).toContain(e.reason)
    // And it says plainly what state the target is in.
    expect(e.message).toContain('NOT verified')
    expect(e.message).toContain('nothing may be retried')
    // AND IT DOES NOT CLAIM THE FENCE IS HELD. This constructor was not told
    // anything about the fence, so it says the only safe thing there is.
    expect(e.fence).toBe('unproved')
    expect(e.message).toContain('UNPROVED')
    expect(e.message).toContain('do not restore producers automatically')
    expect(e.message).not.toContain('still held')
  })
})

describe('the fence, before and after', () => {
  const lock = (qname: string, mode: string, pid = '4242', granted = true): string[] =>
    [qname === 'advisory' ? 'advisory' : 'relation', qname, mode, String(granted), pid]

  const completeFence = (over: string[][] = []): string[][] => [
    lock('advisory', 'ExclusiveLock'),
    ...FENCE_TABLES.map(q => lock(q, FENCE_TABLE_LOCK_MODE)),
    ...FENCE_SEQUENCES.map(q => lock(q, FENCE_SEQUENCE_LOCK_MODE)),
    ...over,
  ]

  const prover = (rows: string[][], pid = '99'): { send: (sql: string) => Promise<{ rows: string[][]; error: null }> } => ({
    send: async (sql: string) => ({
      rows: sql === SUPERVISOR_PID_SQL ? [[pid]] : rows, error: null,
    }),
  })

  it('accepts a COMPLETE fence proved from a different backend', async () => {
    const f = await proveCompleteFence(prover(completeFence()), 'V3-fence-before', '4242', 'S3')
    expect(f.ungranted).toBe(0)
    expect(f.provingPid).toBe('99')
    expect(f.relations).toBe(FENCE_TABLES.length + FENCE_SEQUENCES.length)
  })

  it('refuses PRE-verification fence loss, and says so', async () => {
    const missing = completeFence().filter(r => r[1] !== FENCE_TABLES[7])
    await expect(proveCompleteFence(prover(missing), 'V3-fence-before', '4242', 'S3'))
      .rejects.toThrow(/fence was not held before verification/)
    // The advisory lock alone is not the fence either.
    await expect(proveCompleteFence(
      prover([lock('advisory', 'ExclusiveLock')]), 'V3-fence-before', '4242', 'S3'))
      .rejects.toThrow(/before verification/)
  })

  it('refuses POST-verification fence loss, and says THAT instead', async () => {
    const missing = completeFence().filter(r => r[1] !== FENCE_SEQUENCES[0])
    const e = await proveCompleteFence(prover(missing), 'V11-fence-after', '4242', 'S3')
      .then(() => null, (x: unknown) => x as PostCommitVerificationFailed)
    expect(e?.phase).toBe('V11-fence-after')
    expect(e?.reason).toBe('the complete source fence was not held after verification')
  })

  it('refuses a QUEUED WRITER even when every lock is held', async () => {
    // The whole fence is granted AND somebody is waiting behind it. A verifier
    // that ignored this would measure a source that is about to change and
    // report it as still.
    const queued = completeFence([lock(FENCE_TABLES[0], 'RowExclusiveLock', '777', false)])
    const e = await proveCompleteFence(prover(queued), 'V3-fence-before', '4242', 'S3')
      .then(() => null, (x: unknown) => x as PostCommitVerificationFailed)
    expect(e).toBeInstanceOf(PostCommitVerificationFailed)
    // And the refusal does not reproduce the lock listing.
    expect(surfaces(e)).not.toContain('777')
    expect(surfaces(e)).not.toContain('RowExclusiveLock')
  })

  it('refuses a SELF-proof: a session can always see its own locks', async () => {
    await expect(proveCompleteFence(
      prover(completeFence(), '4242'), 'V3-fence-before', '4242', 'S3'))
      .rejects.toThrow(PostCommitVerificationFailed)
  })

  it('refuses when the proving statement itself is refused', async () => {
    await expect(proveCompleteFence(
      { send: async () => ({ rows: [], error: 'statement-refused' as const }) },
      'V3-fence-before', '4242', 'S3')).rejects.toThrow(PostCommitVerificationFailed)
  })
})

describe('the borrowed supervisor is never written through', () => {
  it('permits ONLY the reviewed reads', async () => {
    const seen: string[] = []
    const inner = { send: async (sql: string) => { seen.push(sql); return { rows: [['4242']], error: null } } }
    const borrowed = borrowReadOnly(inner)
    for (const sql of BORROWED_STATEMENTS) await borrowed.send(sql)
    expect(seen.length).toBe(BORROWED_STATEMENTS.length)
  })

  it('REFUSES every statement that would end the transaction or drop the fence', async () => {
    const seen: string[] = []
    const borrowed = borrowReadOnly(
      { send: async (sql: string) => { seen.push(sql); return { rows: [], error: null } } })
    for (const sql of ['ROLLBACK', 'COMMIT', 'END', 'ABORT', 'BEGIN',
                       'SELECT pg_catalog.pg_advisory_unlock_all()',
                       `${SUPERVISOR_PID_SQL} ; ROLLBACK`]) {
      await expect(borrowed.send(sql), sql).rejects.toThrow(PostCommitVerificationFailed)
    }
    // NOT ONE of them reached the real session.
    expect(seen).toEqual([])
  })

  it('the reviewed list contains no transaction control and no unlock', () => {
    for (const sql of BORROWED_STATEMENTS) {
      expect(sql).not.toMatch(/\b(COMMIT|ROLLBACK|ABORT|END|BEGIN|UNLOCK|advisory_unlock)\b/i)
      expect(sql.trim().toUpperCase().startsWith('SELECT')).toBe(true)
    }
    // And the module never names one anywhere else either.
    expect(VERIFY).not.toMatch(/supervisor\.send\('(ROLLBACK|COMMIT)'\)/)
    expect(VERIFY).not.toContain('advisory_unlock')
    expect(VERIFY).not.toContain('supervisor.end')
    expect(VERIFY).not.toContain('prover.end')
    // It rolls back and ends ONLY sessions it opened.
    expect(VERIFY).toContain('for (const s of [targetSession, sourceSession])')
  })

  it('attempts NO repair of any kind after a failed verification', () => {
    // After COMMIT the target holds unverified data, and every "helpful"
    // response to that makes it worse: a truncate destroys the evidence, a
    // migration changes the thing under examination, a producer restart puts
    // writers back on a source that is still fenced for a reason.
    for (const forbidden of ['TRUNCATE', 'DELETE FROM', 'DROP ', 'ALTER TABLE',
                             'runMigration', 'migrate(', '090_', 'restoreProducers',
                             'cleanup', 'unlock']) {
      expect(VERIFY, forbidden).not.toContain(forbidden)
    }
    // `migrations` appears only where a contract's own recognition is READ.
    expect(VERIFY.match(/migrations/g)?.length).toBe(2)
    // No COMMIT anywhere - the word survives only inside the phrase
    // "POST-COMMIT", which names when this runs rather than something it does.
    expect(VERIFY.replace(/POST-COMMIT/g, '')).not.toMatch(/\bCOMMIT\b/)
    // The only statement it ever ends a transaction with is its OWN rollback.
    expect(VERIFY).toContain("export const VERIFY_ROLLBACK_SQL = 'ROLLBACK'")
    expect(VERIFY.match(/VERIFY_ROLLBACK_SQL/g)?.length).toBe(2)
  })

  it('never retries: no loop resumes after a failure', () => {
    expect(VERIFY).not.toMatch(/for\s*\([^)]*attempt/i)
    expect(VERIFY).not.toMatch(/\bretry\b\s*[=(]/)
    expect(VERIFY).not.toMatch(/while\s*\(/)
    // The one catch that exists RECORDS the failure and re-raises it; it does
    // not resume.
    expect(VERIFY).toContain("state.outcome = 'FAIL'")
  })

  it('the verifier session opener issues NO SQL, and takes its pid from the protocol', () => {
    const DRIVER = strip(read('src/pg-copy/driver-session.ts'))
    const opener = DRIVER.slice(
      DRIVER.indexOf('export async function openSilentDriverSession'),
      DRIVER.indexOf('export async function openDriverSession'))
    expect(opener.length).toBeGreaterThan(200)
    // NOT ONE STATEMENT before the caller's first. A pid SELECT here runs in
    // its own implicit transaction, in a snapshot nothing afterwards can
    // account for - and a recorder attached around the returned session cannot
    // see it, which is exactly how it survived the first time.
    expect(opener).not.toContain('pg_backend_pid')
    expect(opener).not.toContain('SELECT')
    expect(opener).not.toMatch(/\braw\(|\brun\(['"`]/)
    // The pid comes from BackendKeyData, is validated, and refuses when absent.
    expect(opener).toContain('processID')
    expect(opener).toContain("!/^\\d+$/.test(pid)")
    expect(opener).toContain("throw new DriverSessionRefused('the session did not report a backend pid')")
    // Stage 2's opener is UNCHANGED and still asks; the two are separate.
    expect(DRIVER.slice(DRIVER.indexOf('export async function openDriverSession')))
      .toContain('pg_backend_pid')
  })

  it('the session transaction is READ ONLY REPEATABLE READ, as its first statement', () => {
    expect(VERIFY_BEGIN_SQL)
      .toBe('BEGIN TRANSACTION READ ONLY ISOLATION LEVEL REPEATABLE READ')
    expect(VERIFY).toContain('await sourceSession.rows(VERIFY_BEGIN_SQL)')
    expect(VERIFY).toContain('await targetSession.rows(VERIFY_BEGIN_SQL)')
    // Identity is one observation, and includes the transaction state.
    expect(VERIFY_IDENTITY_SQL).toContain("current_setting('transaction_read_only')")
    expect(VERIFY_IDENTITY_SQL).toContain("current_setting('transaction_isolation')")
    expect(VERIFY_IDENTITY_SQL).toContain('pg_control_system()')
  })
})

// ---------------------------------------------------------------------------
// EVIDENCE
// ---------------------------------------------------------------------------

const ROOTS: string[] = []

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'pgcopy-verify-'))
  execFileSync('/bin/chmod', ['700', root])
  ROOTS.push(root)
  return root
}

afterEach(() => {
  for (const r of ROOTS.splice(0)) {
    try { execFileSync('/bin/chmod', ['-R', 'u+rwX', r]) } catch { /* gone */ }
    rmSync(r, { recursive: true, force: true })
  }
})

const STAMP = '20260924T101530Z'
const RUN = 'a1b2c3d4'

const state = (over: Partial<VerificationState> = {}): VerificationState => ({
  outcome: 'PASS',
  failure: null,
  handoffAccepted: true,
  fenceDisposition: 'held',
  fenceAfterProvedBy: 'verification',
  sourceContract: artifact(HANDOFF().sourceContractDigest, 'CURRENT_V10'),
  targetContract: artifact(REVIEWED_CONTRACT_DIGEST, 'CURRENT_V19'),
  source: { pid: '11', systemIdentifier: '7689229024919775042', database: 'ai_capital',
            currentUser: 'ai_capital_v3_export', sessionUser: 'ai_capital_v3_export' },
  target: { pid: '22', systemIdentifier: '7689229024919775999', database: 'ai_capital_v3',
            currentUser: 'ai_capital_migrator', sessionUser: 'ai_capital_migrator' },
  content: { source: fakeContent() as never, target: fakeContent() as never },
  sequences: SEQ_PAIRS().map(p => ({ ...p })),
  fenceBefore: { provingPid: '99', supervisorPid: '4242', relations: 24, ungranted: 0 },
  fenceAfter: { provingPid: '99', supervisorPid: '4242', relations: 24, ungranted: 0 },
  compatibility: COMPAT_DOC,
  ...over,
})

const publishVerification = (
  root: string, st: VerificationState = state(), ops?: EvidenceOps, runId = RUN,
): ReturnType<typeof publishEvidence> => publishEvidence({
  root, prefix: VERIFICATION_PREFIX, stamp: STAMP, runId,
  artifacts: [{
    path: VERIFICATION_CONTENT_FILE,
    bytes: Buffer.from(`${canonicalJson(verificationContentDocument(st))}\n`, 'utf-8'),
  }],
  manifest: {
    path: VERIFICATION_FILE,
    bytes: Buffer.from(`${canonicalJson(verificationDocument(HANDOFF(), st, runId, STAMP))}\n`, 'utf-8'),
  },
}, ops)

describe('the verification document', () => {
  it('records every reviewed fact, and carries the completion marker', () => {
    const doc = JSON.parse(canonicalJson(
      verificationDocument(HANDOFF(), state(), RUN, STAMP))) as Record<string, never>
    expect(doc.complete).toBe(true)
    expect(doc.outcome).toBe('PASS')
    expect(doc.failure).toBeNull()
    expect((doc.source as Record<string, unknown>).recognition).toBe('CURRENT_V10')
    expect((doc.target as Record<string, unknown>).recognition).toBe('CURRENT_V19')
    expect((doc.source as Record<string, unknown>).contract_digest)
      .toBe(HANDOFF().sourceContractDigest)
    expect((doc.target as Record<string, unknown>).contract_digest).toBe(REVIEWED_CONTRACT_DIGEST)
    expect((doc.tables as unknown[]).length).toBe(21)
    expect((doc.sequences as unknown[]).length).toBe(3)
    expect(doc.compatibility).toEqual(COMPAT_DOC)
    expect(((doc.fence as Record<string, never>).before as Record<string, unknown>).ungranted).toBe(0)
    expect(((doc.fence as Record<string, never>).after as Record<string, unknown>).ungranted).toBe(0)
    expect((doc.stage2 as Record<string, unknown>).root_digest).toBe(HANDOFF().rootDigest)
  })

  it('a FAILED verification records a COMPLETE record and NEVER says PASS', () => {
    const failed = state({
      outcome: 'FAIL',
      failure: { phase: 'V8-content', reason: PHASE_REASON['V8-content'], at: COPY_TABLES[3] },
      fenceAfter: null,
    })
    const doc = JSON.parse(canonicalJson(
      verificationDocument(HANDOFF(), failed, RUN, STAMP))) as Record<string, never>
    expect(doc.outcome).toBe('FAIL')
    expect(doc.complete).toBe(true)
    expect((doc.failure as Record<string, unknown>).phase).toBe('V8-content')
    expect((doc.failure as Record<string, unknown>).at).toBe(COPY_TABLES[3])
    expect((doc.fence as Record<string, never>).after).toBeNull()
    expect(canonicalJson(verificationDocument(HANDOFF(), failed, RUN, STAMP)))
      .not.toContain('"PASS"')
  })

  it('an EARLY failure still produces a document, with nulls where nothing was measured', () => {
    const early = state({
      outcome: 'FAIL',
      failure: { phase: 'V3-fence-before', reason: PHASE_REASON['V3-fence-before'], at: null },
      sourceContract: null, targetContract: null, source: null, target: null,
      content: null, sequences: [], fenceBefore: null, fenceAfter: null, compatibility: null,
    })
    const doc = JSON.parse(canonicalJson(
      verificationDocument(HANDOFF(), early, RUN, STAMP))) as Record<string, never>
    expect(doc.outcome).toBe('FAIL')
    expect(doc.complete).toBe(true)
    expect((doc.tables as unknown[]).length).toBe(0)
    expect((doc.source as Record<string, unknown>).measured).toBe(false)
    // The identity STATED by the handoff is still recorded, and labelled as
    // unmeasured rather than presented as a measurement.
    expect((doc.source as Record<string, unknown>).database).toBe('ai_capital')
    expect((doc.source as Record<string, unknown>).root_digest).toBeNull()
  })

  it('carries NO credential component of any kind', () => {
    const text = [canonicalJson(verificationDocument(HANDOFF(), state(), RUN, STAMP)),
                  canonicalJson(verificationContentDocument(state()))].join('\n')
    for (const marker of ['password', 'passfile', 'pgpass', 'postgres://', 'host=',
                          'sslmode', '/tmp/', 'secret', '@']) {
      expect(text.toLowerCase(), marker).not.toContain(marker)
    }
    // And no raw row value: the content artifact carries digests and counts.
    expect(canonicalJson(verificationContentDocument(state()))).not.toContain('Alpha Corp')
  })

  it('the content artifact carries every batch, and no row', () => {
    const doc = JSON.parse(canonicalJson(verificationContentDocument(state()))) as
      { tables: Array<Record<string, never>> }
    expect(doc.tables.length).toBe(21)
    expect(doc.tables[0].qname).toBe(COPY_TABLES[0])
    expect(((doc.tables[0].source as Record<string, never>).batches as unknown[]).length).toBe(1)
    expect(((doc.tables[0].target as Record<string, never>).batches as unknown[]).length).toBe(1)
  })

  it('reads a recognition out of an artifact, or nothing at all', () => {
    expect(recognitionOf(artifact(hex('a'), 'CURRENT_V10'))).toBe('CURRENT_V10')
    expect(recognitionOf(
      { pgcopy_schema_contract_version: 2, digest: hex('a'), payload: {} })).toBe('')
  })
})

describe('the published verification evidence', () => {
  it('uses the reviewed names, in the SAME parent', () => {
    const n = evidenceNames(VERIFICATION_PREFIX, STAMP, RUN)
    expect(n.finalName).toBe(`verification-${STAMP}-${RUN}`)
    expect(n.temporaryName).toBe(`.tmp-verification-${RUN}`)
    expect(n.finalName).toMatch(/^verification-\d{8}T\d{6}Z-[0-9a-f]{8}$/)
    // Stage 1's name is UNCHANGED by the addition.
    expect(evidenceNames('source-manifest', STAMP, RUN).temporaryName).toBe(`.tmp-${RUN}`)
    expect(Object.keys(TEMPORARY_NAME_PREFIX).sort()).toEqual(['source-manifest', 'verification'])
  })

  it('publishes ONE frozen, digested, fsynced bundle', () => {
    const root = makeRoot()
    const p = publishVerification(root)
    expect(readdirSync(root)).toEqual([`verification-${STAMP}-${RUN}`])
    expect([...p.files].sort())
      .toEqual([DIGEST_FILE, VERIFICATION_CONTENT_FILE, VERIFICATION_FILE].sort())
    expect(statSync(p.finalPath).mode & 0o777).toBe(0o500)
    for (const f of p.files) {
      expect(statSync(join(p.finalPath, f)).mode & 0o777).toBe(0o400)
    }
    // THE DIGEST DESCRIBES THE BYTES, and verifies from outside.
    const digest = parseDigestFile(readFileSync(join(p.finalPath, DIGEST_FILE), 'utf-8'))
    expect([...digest.keys()].sort())
      .toEqual([VERIFICATION_CONTENT_FILE, VERIFICATION_FILE].sort())
    for (const [rel, d] of digest) {
      expect(sha256Hex(readFileSync(join(p.finalPath, rel)))).toBe(d)
    }
    expect([...verifyPublishedEvidence(p.finalPath)].sort()).toEqual([...p.files].sort())
  })

  it('DIGEST is written LAST, and the freeze happens AFTER it', () => {
    const root = makeRoot()
    const log: string[] = []
    const rel = (p: unknown): string => String(p).split('/').slice(-2).join('/')
    const ops: EvidenceOps = {
      ...REAL_EVIDENCE_OPS,
      openSync: ((p: string, f: string, m?: number) => {
        log.push(`open ${f} ${rel(p)}`)
        return REAL_EVIDENCE_OPS.openSync(p, f as never, m)
      }) as typeof REAL_EVIDENCE_OPS.openSync,
      fsyncSync: (fd: number) => { log.push('fsync'); return REAL_EVIDENCE_OPS.fsyncSync(fd) },
      chmodSync: ((p: string, m: number) => {
        log.push(`chmod ${m.toString(8)} ${rel(p)}`)
        return REAL_EVIDENCE_OPS.chmodSync(p, m)
      }) as typeof REAL_EVIDENCE_OPS.chmodSync,
      renameNoReplace: (a: string, b: string) => {
        log.push(`rename ${rel(a)} -> ${rel(b)}`)
        return REAL_EVIDENCE_OPS.renameNoReplace(a, b)
      },
    }
    publishVerification(root, state(), ops)

    const at = (p: (l: string) => boolean): number => log.findIndex(p)
    const digestWritten = at(l => l === `open wx .tmp-verification-${RUN}/${DIGEST_FILE}`)
    const manifestWritten = at(l => l.endsWith(`/${VERIFICATION_FILE}`) && l.startsWith('open wx'))
    const contentWritten = at(l => l.endsWith(`/${VERIFICATION_CONTENT_FILE}`) && l.startsWith('open wx'))
    const firstFreeze = at(l => l.startsWith('chmod 400'))
    const firstFsync = log.indexOf('fsync', firstFreeze)
    const renamed = at(l => l.startsWith('rename'))

    // ARTIFACTS, then the MANIFEST, then DIGEST, then freeze, then fsync, then
    // exactly one rename.
    expect(contentWritten).toBeLessThan(manifestWritten)
    expect(manifestWritten).toBeLessThan(digestWritten)
    expect(digestWritten).toBeLessThan(firstFreeze)
    expect(firstFreeze).toBeLessThan(firstFsync)
    expect(firstFsync).toBeLessThan(renamed)
    expect(log.filter(l => l.startsWith('rename')).length).toBe(1)
    // The bundle ROOT is frozen only AFTER the rename - a 0500 directory cannot
    // be renamed on APFS.
    expect(at(l => l === `chmod 500 ${rel(p0(root))}`)).toBeGreaterThan(renamed)
  })

  it('REFUSES a final path that already exists, including a DANGLING SYMLINK', () => {
    const root = makeRoot()
    writeFileSync(join(root, `verification-${STAMP}-${RUN}`), 'squatter')
    expect(() => publishVerification(root)).toThrow(/already present at the publication destination/)

    const root2 = makeRoot()
    symlinkSync(join(root2, 'nowhere-at-all'), join(root2, `verification-${STAMP}-${RUN}`))
    expect(() => publishVerification(root2))
      .toThrow(/already present at the publication destination/)
  })

  it('REFUSES a temporary path that already exists, including a DANGLING SYMLINK', () => {
    const root = makeRoot()
    writeFileSync(join(root, `.tmp-verification-${RUN}`), 'squatter')
    expect(() => publishVerification(root)).toThrow(/already present at the temporary directory/)

    const root2 = makeRoot()
    symlinkSync(join(root2, 'nowhere-at-all'), join(root2, `.tmp-verification-${RUN}`))
    expect(() => publishVerification(root2)).toThrow(/already present at the temporary directory/)
  })

  it('NEVER overwrites, merges with, or mutates a published bundle', () => {
    const root = makeRoot()
    const first = publishVerification(root)
    const before = readFileSync(join(first.finalPath, VERIFICATION_FILE), 'utf-8')

    // The same run identifier twice. The second is refused outright.
    expect(() => publishVerification(root, state({ outcome: 'FAIL' })))
      .toThrow(/already present at the publication destination/)
    expect(readFileSync(join(first.finalPath, VERIFICATION_FILE), 'utf-8')).toBe(before)

    // AND THE NORMAL WRITER CANNOT TOUCH IT. Frozen files are 0400 and the
    // frozen directory is 0500, so create, truncate, append and replace all
    // fail without any privilege being dropped.
    const target = join(first.finalPath, VERIFICATION_FILE)
    expect(() => writeFileSync(target, 'x')).toThrow()
    expect(() => writeFileSync(target, 'x', { flag: 'a' })).toThrow()
    expect(() => writeFileSync(join(first.finalPath, 'new-file'), 'x')).toThrow()
    expect(() => rmSync(target)).toThrow()
    expect(readFileSync(target, 'utf-8')).toBe(before)
    expect(readdirSync(first.finalPath).sort())
      .toEqual([DIGEST_FILE, VERIFICATION_CONTENT_FILE, VERIFICATION_FILE].sort())
  })

  it('a second run publishes BESIDE the first, never into it', () => {
    const root = makeRoot()
    const a = publishVerification(root, state(), undefined, RUN)
    const b = publishVerification(root, state({ outcome: 'FAIL' }), undefined, 'b2c3d4e5')
    expect(a.finalPath).not.toBe(b.finalPath)
    expect(readdirSync(root).sort())
      .toEqual([`verification-${STAMP}-${RUN}`, `verification-${STAMP}-b2c3d4e5`].sort())
    expect(JSON.parse(readFileSync(join(a.finalPath, VERIFICATION_FILE), 'utf-8')).outcome)
      .toBe('PASS')
    expect(JSON.parse(readFileSync(join(b.finalPath, VERIFICATION_FILE), 'utf-8')).outcome)
      .toBe('FAIL')
  })

  it('a FAILED publication RETAINS the temporary directory for diagnosis', () => {
    const root = makeRoot()
    const ops: EvidenceOps = {
      ...REAL_EVIDENCE_OPS,
      renameNoReplace: () => 'failed',
    }
    expect(() => publishVerification(root, state(), ops)).toThrow()
    // Still there, complete, and readable enough to say what happened.
    const tmp = join(root, `.tmp-verification-${RUN}`)
    expect(readdirSync(tmp).sort())
      .toEqual([DIGEST_FILE, VERIFICATION_CONTENT_FILE, VERIFICATION_FILE].sort())
    expect(JSON.parse(readFileSync(join(tmp, VERIFICATION_FILE), 'utf-8')).outcome).toBe('PASS')
    // And NOTHING was published under the final name.
    expect(readdirSync(root).filter(n => n.startsWith('verification-'))).toEqual([])
  })

  it('a publication refusal that created NOTHING says so, and names no phantom path', () => {
    const e = new VerificationEvidenceRefused(
      'FAIL', 'collision', null, '/evidence/verification-20260924T101530Z-a1b2c3d4',
      null, 'held')
    expect(e).toBeInstanceOf(PostCommitVerificationFailed)
    expect(e.phase).toBe('V12-evidence')
    expect(e.disposition).toBe('refused')
    expect(e.temporaryPath).toBeNull()
    expect(e.reason).toBe('the verification evidence was not published')
    expect(e.message).toContain('no bundle was created')
    expect(e.message).toContain('NOT verified')
    // A DIFFERENT outcome when something WAS built and retained.
    const r = new VerificationEvidenceRefused(
      'FAIL', 'digest', '/evidence/.tmp-verification-a1b2c3d4',
      '/evidence/verification-20260924T101530Z-a1b2c3d4', null, 'held')
    expect(r.disposition).toBe('retained-temporary')
    expect(r.reason).toBe('the verification evidence was built but not published')
    expect(r.temporaryPath).toBe('/evidence/.tmp-verification-a1b2c3d4')
  })

  it('a POST-RENAME failure says the bundle EXISTS, and names which step failed', () => {
    for (const phase of ['freeze-final', 'fsync-final', 'fsync-parent', 'verify'] as const) {
      const e = new VerificationEvidencePublishedButUnverified(
        'PASS', phase, '/evidence/verification-20260924T101530Z-a1b2c3d4', null, 'held')
      expect(e.disposition, phase).toBe('published-unverified')
      expect(e.publishedPhase, phase).toBe(phase)
      expect(e.reason).toBe('the verification evidence was published but not verified')
      expect(e.message).toContain(phase)
      // It never suggests nothing was published, and never names a temporary.
      expect(e.message).not.toContain('.tmp-')
      expect((e as unknown as { temporaryPath?: unknown }).temporaryPath).toBeUndefined()
    }
  })

  it('an INDETERMINATE rename preserves both names and forbids reuse', () => {
    const e = new VerificationEvidenceOutcomeUnknown(
      'PASS', '/evidence/verification-20260924T101530Z-a1b2c3d4',
      '/evidence/.tmp-verification-a1b2c3d4', null, 'unproved')
    expect(e.disposition).toBe('unknown')
    expect(e.reason).toBe('the verification evidence publication outcome is unknown')
    expect(e.finalPath).toContain('verification-20260924T101530Z-a1b2c3d4')
    expect(e.temporaryPath).toContain('.tmp-verification-a1b2c3d4')
    expect(e.message).toContain('neither name may be reused')
  })

  it('a publication failure NEVER loses the primary verification failure', () => {
    const primary = { phase: 'V8-content' as const, reason: PHASE_REASON['V8-content'],
                      at: COPY_TABLES[3] }
    for (const e of [
      new VerificationEvidenceRefused('FAIL', 'digest', '/t', '/f', primary, 'held'),
      new VerificationEvidencePublishedButUnverified('FAIL', 'verify', '/f', primary, 'held'),
      new VerificationEvidenceOutcomeUnknown('FAIL', '/f', '/t', primary, 'unproved'),
    ]) {
      expect(e.verification).toEqual(primary)
      expect(e.outcome).toBe('FAIL')
    }
  })

  it('DIGEST verification refuses a bundle whose bytes were changed', () => {
    const root = makeRoot()
    const p = publishVerification(root)
    execFileSync('/bin/chmod', ['-R', 'u+rwX', p.finalPath])
    writeFileSync(join(p.finalPath, VERIFICATION_FILE),
                  readFileSync(join(p.finalPath, VERIFICATION_FILE), 'utf-8')
                    .replace('"PASS"', '"FAIL"'))
    expect(() => verifyPublishedEvidence(p.finalPath))
      .toThrow(/digest does not describe the published bytes|type, mode or link count/)
  })
})

/** The published bundle's own path, for the ordering assertion above. */
function p0(root: string): string {
  return join(root, `verification-${STAMP}-${RUN}`)
}

// ---------------------------------------------------------------------------
// THE POST-COMMIT FAILURE STATE
// ---------------------------------------------------------------------------

/** A borrowed session that records what it was asked, and can be made dead. */
function borrowedStub(
  pid: string | null, lockRows: string[][] = [],
): { send: (sql: string) => Promise<{ rows: string[][]; error: null }>; seen: string[] } {
  const seen: string[] = []
  return {
    seen,
    send: async (sql: string) => {
      seen.push(sql)
      if (pid === null) throw new Error('connection terminated unexpectedly')
      return { rows: sql === SUPERVISOR_PID_SQL ? [[pid]] : lockRows, error: null }
    },
  }
}

const lockRow = (qname: string, mode: string, pid = '4242', granted = true): string[] =>
  [qname === 'advisory' ? 'advisory' : 'relation', qname, mode, String(granted), pid]

const wholeFence = (extra: string[][] = []): string[][] => [
  lockRow('advisory', 'ExclusiveLock'),
  ...FENCE_TABLES.map(q => lockRow(q, FENCE_TABLE_LOCK_MODE)),
  ...FENCE_SEQUENCES.map(q => lockRow(q, FENCE_SEQUENCE_LOCK_MODE)),
  ...extra,
]

describe('the fence disposition is proved, never asserted', () => {
  const failed = (phase: VerifyPhase, over: Partial<VerificationState> = {}): VerificationState =>
    state({ outcome: 'FAIL', fenceDisposition: 'unproved', fenceAfterProvedBy: null,
            fenceAfter: null,
            failure: { phase, reason: PHASE_REASON[phase], at: null }, ...over })

  it('a clean run is HELD, on the strength of its own final proof', async () => {
    const st = state()
    const prover = borrowedStub('99', wholeFence())
    expect(await settleFenceDisposition(prover, HANDOFF(), st)).toBe('held')
    expect(st.fenceAfterProvedBy).toBe('verification')
    // The clean path asks nothing extra: V11 already proved it.
    expect(prover.seen).toEqual([])
  })

  it('a DEAD SUPERVISOR is UNPROVED, and nothing is sent to find out', async () => {
    const prover = borrowedStub('99', wholeFence())
    expect(await settleFenceDisposition(prover, HANDOFF(), failed('V2-supervisor')))
      .toBe('unproved')
    // A fence whose holder is unaccounted for cannot be proved by asking about
    // locks, so nothing is asked.
    expect(prover.seen).toEqual([])
  })

  it('a MISSING INITIAL LOCK is NOT-HELD: a proof ran and refused', async () => {
    const prover = borrowedStub('99', wholeFence())
    expect(await settleFenceDisposition(prover, HANDOFF(), failed('V3-fence-before')))
      .toBe('not-held')
    expect(prover.seen).toEqual([])
  })

  it('a LOST FINAL FENCE is NOT-HELD', async () => {
    const prover = borrowedStub('99', wholeFence())
    expect(await settleFenceDisposition(prover, HANDOFF(), failed('V11-fence-after')))
      .toBe('not-held')
  })

  it('a CONTENT MISMATCH with the fence still there is HELD, and proves it', async () => {
    const st = failed('V8-content')
    const prover = borrowedStub('99', wholeFence())
    expect(await settleFenceDisposition(prover, HANDOFF(), st)).toBe('held')
    expect(st.fenceAfterProvedBy).toBe('failure-path')
    expect(st.fenceAfter?.ungranted).toBe(0)
    // It really did take a proof, on the prover, and asked for nothing else.
    expect(prover.seen.length).toBe(2)
    for (const sql of prover.seen) expect(BORROWED_STATEMENTS).toContain(sql)
  })

  it('a CONTENT MISMATCH whose failure-path reproof FAILS is UNPROVED', async () => {
    for (const prover of [
      borrowedStub('99', wholeFence().filter(r => r[1] !== FENCE_TABLES[3])),
      borrowedStub('99', wholeFence([lockRow(FENCE_TABLES[0], 'RowExclusiveLock', '777', false)])),
      borrowedStub(null),
    ]) {
      const st = failed('V8-content')
      expect(await settleFenceDisposition(prover, HANDOFF(), st)).toBe('unproved')
      expect(st.fenceAfterProvedBy).toBeNull()
      expect(st.fenceAfter).toBeNull()
    }
  })

  it('a QUEUED WRITER on the failure path is UNPROVED, never held', async () => {
    const st = failed('V9-sequences')
    const queued = borrowedStub(
      '99', wholeFence([lockRow(FENCE_SEQUENCES[0], 'ShareLock', '777', false)]))
    expect(await settleFenceDisposition(queued, HANDOFF(), st)).toBe('unproved')
  })

  it('NEVER masks the primary failure - whether the reproof succeeds or fails', async () => {
    const primary = {
      phase: 'V8-content' as const, reason: PHASE_REASON['V8-content'], at: COPY_TABLES[5] }
    // BOTH BRANCHES. A reproof that SUCCEEDS is the dangerous one: it has a
    // verdict of its own, and writing that verdict down would replace "the
    // content did not match" with "the fence moved" - the wrong problem, and
    // one that reads as if the copy were fine.
    for (const prover of [borrowedStub('99', wholeFence()), borrowedStub(null)]) {
      const st = failed('V8-content', { failure: { ...primary } })
      const d = await settleFenceDisposition(prover, HANDOFF(), st)
      expect(st.failure).toEqual(primary)
      expect(['held', 'unproved']).toContain(d)
    }
  })

  it('every disposition has its own sentence, and only one claims the fence is held', () => {
    const all: FenceDisposition[] = ['held', 'not-held', 'unproved']
    expect(Object.keys(FENCE_DISPOSITION_SENTENCE).sort()).toEqual([...all].sort())
    expect(new Set(Object.values(FENCE_DISPOSITION_SENTENCE)).size).toBe(3)
    for (const d of all) {
      const m = new PostCommitVerificationFailed('V8-content', PHASE_REASON['V8-content'], null, d)
        .message
      expect(m.includes('PROVED still held'), d).toBe(d === 'held')
      if (d !== 'held') {
        expect(m, d).toContain('MUTABLE')
        expect(m, d).toContain('restore producers')
      }
    }
    // The document carries the disposition AND the sentence, so the record and
    // the error cannot drift apart.
    const doc = JSON.parse(canonicalJson(verificationDocument(
      HANDOFF(), state({ fenceDisposition: 'unproved' }), RUN, STAMP))) as Record<string, never>
    expect((doc.fence as Record<string, unknown>).disposition).toBe('unproved')
    expect((doc.fence as Record<string, unknown>).sentence)
      .toBe(FENCE_DISPOSITION_SENTENCE.unproved)
    expect((doc.fence as Record<string, unknown>).after_proved_by).toBe('verification')
  })
})

describe('runVerification, end to end, without a database', () => {
  const reviewedTarget = JSON.parse(read('contracts/expected-target-v19.json')) as ContractArtifact

  interface Run {
    thrown: unknown
    opened: number
    supervisor: ReturnType<typeof borrowedStub>
    prover: ReturnType<typeof borrowedStub>
    root: string
    published: string[]
  }

  async function run(over: {
    handoff?: VerifierHandoff
    supervisorPid?: string | null
    lockRows?: string[][]
    ops?: EvidenceOps
    root?: string
  } = {}): Promise<Run> {
    const root = over.root ?? makeRoot()
    const supervisor = borrowedStub(
      over.supervisorPid === undefined ? '4242' : over.supervisorPid)
    const prover = borrowedStub('99', over.lockRows ?? wholeFence())
    let opened = 0
    let thrown: unknown = null
    try {
      await runVerification({
        handoff: over.handoff ?? HANDOFF(),
        publishedDocument: PUBLISHED(),
        supervisor,
        prover,
        openSource: async () => { opened += 1; throw new Error('must not be reached') },
        openTarget: async () => { opened += 1; throw new Error('must not be reached') },
        reviewedTarget,
        evidenceRoot: root,
        runId: RUN,
        stamp: STAMP,
        ...(over.ops === undefined ? {} : { ops: over.ops }),
      })
    } catch (e) { thrown = e }
    return { thrown, opened, supervisor, prover, root,
             published: readdirSync(root).filter(n => n.startsWith('verification-')) }
  }

  const record = (r: Run): Record<string, never> => JSON.parse(
    readFileSync(join(r.root, r.published[0], VERIFICATION_FILE), 'utf-8'))

  it('a MALFORMED HANDOFF publishes a complete V1 FAIL record and opens nothing', async () => {
    const r = await run({ handoff: HANDOFF({ rootDigest: 'not-a-digest' }) })
    expect(r.thrown).toBeInstanceOf(PostCommitVerificationFailed)
    const e = r.thrown as PostCommitVerificationFailed
    expect(e.phase).toBe('V1-handoff')
    expect(e.fence).toBe('unproved')
    // NOTHING was opened and NOTHING was sent to either borrowed session.
    expect(r.opened).toBe(0)
    expect(r.supervisor.seen).toEqual([])
    expect(r.prover.seen).toEqual([])
    // AND THE RECORD EXISTS.
    expect(r.published.length).toBe(1)
    const doc = record(r)
    expect(doc.outcome).toBe('FAIL')
    expect(doc.complete).toBe(true)
    expect((doc.failure as Record<string, unknown>).phase).toBe('V1-handoff')
    expect((doc.fence as Record<string, unknown>).disposition).toBe('unproved')
  })

  it('a refused handoff reproduces NONE of its fields', async () => {
    const poison = 'ZZ_POISON_987654321'
    const variants: Array<Partial<VerifierHandoff>> = [
      { rootDigest: poison },
      { sourceContractDigest: poison },
      { targetContractDigest: poison },
      { bundleName: poison },
      { tables: [...HANDOFF().tables].reverse() },
      { sequences: HANDOFF().sequences.map(s => ({ ...s, effectiveNext: poison })) },
      { source: { systemIdentifier: poison, database: poison, role: poison } },
      { fence: { supervisorPid: poison, mechanism: 'S3' } },
    ]
    for (const v of variants) {
      const r = await run({ handoff: HANDOFF(v) })
      expect((r.thrown as PostCommitVerificationFailed).phase, JSON.stringify(v))
        .toBe('V1-handoff')
      expect(r.opened, JSON.stringify(v)).toBe(0)
      const bytes = readdirSync(join(r.root, r.published[0]))
        .map(f => readFileSync(join(r.root, r.published[0], f), 'utf-8')).join('\n')
      expect(bytes, JSON.stringify(v)).not.toContain(poison)
      expect(surfaces(r.thrown), JSON.stringify(v)).not.toContain(poison)
      // Every handoff-derived fact is null, not "what it claimed".
      const doc = record(r)
      expect((doc.bundle as Record<string, unknown>).name).toBeNull()
      expect((doc.stage2 as Record<string, unknown>).root_digest).toBeNull()
      expect((doc.source as Record<string, unknown>).database).toBeNull()
      expect((doc.source as Record<string, unknown>).measured).toBe(false)
      expect(doc.compatibility).toBeNull()
      expect((doc.tables as unknown[]).length).toBe(0)
    }
  })

  it('a DEAD SUPERVISOR is UNPROVED, opens nothing, and is still recorded', async () => {
    const r = await run({ supervisorPid: null })
    const e = r.thrown as PostCommitVerificationFailed
    expect(e.phase).toBe('V2-supervisor')
    expect(e.fence).toBe('unproved')
    expect(e.message).toContain('UNPROVED')
    expect(e.message).not.toContain('still held')
    expect(r.opened).toBe(0)
    expect(r.prover.seen).toEqual([])
    expect(record(r).outcome).toBe('FAIL')
    expect((record(r).fence as Record<string, unknown>).disposition).toBe('unproved')
  })

  it('a MISSING INITIAL LOCK is NOT-HELD and says the source is mutable', async () => {
    const r = await run({ lockRows: wholeFence().filter(row => row[1] !== FENCE_TABLES[9]) })
    const e = r.thrown as PostCommitVerificationFailed
    expect(e.phase).toBe('V3-fence-before')
    expect(e.fence).toBe('not-held')
    expect(e.message).toContain('IS NOT HELD')
    expect(e.message).toContain('MUTABLE')
    expect(r.opened).toBe(0)
    expect((record(r).fence as Record<string, unknown>).disposition).toBe('not-held')
  })

  it('a QUEUED WRITER at the initial proof is NOT-HELD', async () => {
    const r = await run({ lockRows: wholeFence(
      [lockRow(FENCE_TABLES[0], 'RowExclusiveLock', '777', false)]) })
    const e = r.thrown as PostCommitVerificationFailed
    expect(e.phase).toBe('V3-fence-before')
    expect(e.fence).toBe('not-held')
    expect(surfaces(e)).not.toContain('777')
  })
})

describe('the publication outcome is preserved exactly', () => {
  const reviewedTarget = JSON.parse(read('contracts/expected-target-v19.json')) as ContractArtifact

  /** Always fails at V2, so publication is the only thing under test. */
  async function publishFailing(root: string, ops: EvidenceOps): Promise<unknown> {
    try {
      await runVerification({
        handoff: HANDOFF(), publishedDocument: PUBLISHED(),
        supervisor: borrowedStub(null), prover: borrowedStub('99', wholeFence()),
        openSource: async () => { throw new Error('unreached') },
        openTarget: async () => { throw new Error('unreached') },
        reviewedTarget, evidenceRoot: root, runId: RUN, stamp: STAMP, ops,
      })
      return null
    } catch (e) { return e }
  }

  const FINAL = `verification-${STAMP}-${RUN}`
  const TMP = `.tmp-verification-${RUN}`
  /** The root the currently-running case is publishing into. */
  let ROOT_UNDER_TEST = ''

  const failingOn = (
    when: (op: string, path: string) => boolean, over: Partial<EvidenceOps> = {},
  ): EvidenceOps => ({
    ...REAL_EVIDENCE_OPS,
    chmodSync: ((p: string, m: number) => {
      if (when('chmod', String(p))) throw new Error('injected')
      return REAL_EVIDENCE_OPS.chmodSync(p, m)
    }) as typeof REAL_EVIDENCE_OPS.chmodSync,
    openSync: ((p: string, f: string, m?: number) => {
      if (when('open', String(p))) throw new Error('injected')
      return REAL_EVIDENCE_OPS.openSync(p, f as never, m)
    }) as typeof REAL_EVIDENCE_OPS.openSync,
    writeSync: ((fd: number, b: Buffer) => {
      if (when('write', '')) throw new Error('injected')
      return REAL_EVIDENCE_OPS.writeSync(fd, b as never)
    }) as typeof REAL_EVIDENCE_OPS.writeSync,
    readdirSync: ((p: string, o?: unknown) => {
      if (when('readdir', String(p))) throw new Error('injected')
      return REAL_EVIDENCE_OPS.readdirSync(p, o as never)
    }) as typeof REAL_EVIDENCE_OPS.readdirSync,
    ...over,
  })

  it('a COLLISION refused before construction names NO temporary directory', async () => {
    const root = makeRoot()
    writeFileSync(join(root, FINAL), 'squatter')
    const e = await publishFailing(root, REAL_EVIDENCE_OPS)
    expect(e).toBeInstanceOf(VerificationEvidenceRefused)
    const r = e as VerificationEvidenceRefused
    expect(r.disposition).toBe('refused')
    expect(r.temporaryPath).toBeNull()
    expect(r.evidencePhase).toBe('collision')
    // AND THE FILESYSTEM AGREES: no temporary directory was ever created.
    expect(readdirSync(root).sort()).toEqual([FINAL])
  })

  it('a PRE-RENAME failure retains the temporary directory and names it', async () => {
    const root = makeRoot()
    let written = 0
    const e = await publishFailing(root, failingOn(op => op === 'write' && ++written === 2))
    expect(e).toBeInstanceOf(VerificationEvidenceRefused)
    const r = e as VerificationEvidenceRefused
    expect(r.disposition).toBe('retained-temporary')
    expect(r.temporaryPath).toBe(join(root, TMP))
    // AND THE FILESYSTEM AGREES.
    expect(readdirSync(root).sort()).toEqual([TMP])
    expect(statSync(join(root, TMP)).isDirectory()).toBe(true)
  })

  it('an UNAVAILABLE atomic rename retains the temporary directory', async () => {
    const root = makeRoot()
    const e = await publishFailing(root, { ...REAL_EVIDENCE_OPS,
      renameNoReplace: () => 'unavailable' })
    expect(e).toBeInstanceOf(VerificationEvidenceRefused)
    expect((e as VerificationEvidenceRefused).disposition).toBe('retained-temporary')
    expect(readdirSync(root).sort()).toEqual([TMP])
  })

  it('EVERY POST-RENAME failure point says the bundle EXISTS, and which step failed',
    async () => {
      const cases: Array<[string, () => EvidenceOps]> = [
        ['freeze-final', () => failingOn((op, p) => op === 'chmod' && p.endsWith(FINAL))],
        ['fsync-final', () => failingOn((op, p) => op === 'open' && p.endsWith(FINAL))],
        // The ROOT is opened exactly once, by the final parent fsync - every
        // earlier open is inside the temporary directory - so this predicate
        // can only fire there.
        ['fsync-parent', () => failingOn((op, p) => op === 'open' && p === ROOT_UNDER_TEST)],
        ['verify', () => failingOn((op, p) => op === 'readdir' && p.endsWith(FINAL))],
      ]
      for (const [phase, make] of cases) {
        const root = makeRoot()
        ROOT_UNDER_TEST = root
        const e = await publishFailing(root, make())
        expect(e, phase).toBeInstanceOf(VerificationEvidencePublishedButUnverified)
        const p = e as VerificationEvidencePublishedButUnverified
        expect(p.disposition, phase).toBe('published-unverified')
        expect(p.finalPath, phase).toBe(join(root, FINAL))
        // AND THE FILESYSTEM AGREES: the final bundle exists, the temporary
        // name does not, and nothing removed either of them.
        expect(readdirSync(root).sort(), phase).toEqual([FINAL])
        expect(readdirSync(join(root, FINAL)).sort(), phase)
          .toEqual([DIGEST_FILE, VERIFICATION_CONTENT_FILE, VERIFICATION_FILE].sort())
      }
    })

  it('the four post-rename phases are distinguished, not collapsed', async () => {
    // Guarded separately, because three of them are injected on the same
    // operation and a classifier that reported one label for all of them would
    // pass every individual case above.
    const seen = new Set<string>()
    for (const make of [
      (): EvidenceOps => failingOn((op, p) => op === 'chmod' && p.endsWith(FINAL)),
      (): EvidenceOps => failingOn((op, p) => op === 'open' && p.endsWith(FINAL)),
      (): EvidenceOps => failingOn((op, p) => op === 'open' && p === ROOT_UNDER_TEST),
      (): EvidenceOps => failingOn((op, p) => op === 'readdir' && p.endsWith(FINAL)),
    ]) {
      const root = makeRoot()
      ROOT_UNDER_TEST = root
      const e = await publishFailing(root, make())
      seen.add((e as VerificationEvidencePublishedButUnverified).publishedPhase)
    }
    expect([...seen].sort())
      .toEqual(['freeze-final', 'fsync-final', 'fsync-parent', 'verify'])
  })

  it('an INDETERMINATE rename that cannot be resolved is UNKNOWN, and touches nothing',
    async () => {
      const root = makeRoot()
      const e = await publishFailing(root, { ...REAL_EVIDENCE_OPS,
        // The helper moved the directory somewhere neither name points at and
        // then failed to report - so looking settles nothing.
        renameNoReplace: (from: string) => {
          renameSync(from, `${from}-elsewhere`)
          return 'indeterminate'
        } })
      expect(e).toBeInstanceOf(VerificationEvidenceOutcomeUnknown)
      const u = e as VerificationEvidenceOutcomeUnknown
      expect(u.disposition).toBe('unknown')
      expect(u.finalPath).toBe(join(root, FINAL))
      expect(u.temporaryPath).toBe(join(root, TMP))
      expect(u.message).toContain('unknown')
      // NOTHING was cleaned up, retried or reused.
      expect(readdirSync(root).sort()).toEqual([`${TMP}-elsewhere`])
    })

  it('no publication failure leaks an errno, a path outside the root, or a row', async () => {
    const root = makeRoot()
    for (const ops of [
      failingOn(op => op === 'write'),
      { ...REAL_EVIDENCE_OPS, renameNoReplace: () => 'unavailable' as const },
    ]) {
      const e = await publishFailing(makeRoot(), ops)
      const text = surfaces(e)
      expect(text).not.toContain('injected')
      expect(text).not.toContain('ENOENT')
      expect(text).not.toContain('EACCES')
      expect(text).not.toContain('Alpha Corp')
    }
    expect(readdirSync(root)).toEqual([])
  })
})

describe('the phase vocabulary is closed', () => {
  it('every phase has exactly one reviewed reason', () => {
    const phases: VerifyPhase[] = [
      'V1-handoff', 'V2-supervisor', 'V3-fence-before', 'V4-source-session',
      'V5-target-session', 'V6-source-contract', 'V7-target-contract', 'V8-content',
      'V9-sequences', 'V10-compatibility', 'V11-fence-after', 'V12-evidence',
    ]
    expect(Object.keys(PHASE_REASON).sort()).toEqual([...phases].sort())
    expect(new Set(Object.values(PHASE_REASON)).size).toBe(phases.length)
    for (const p of phases) {
      expect(new PostCommitVerificationFailed(p, PHASE_REASON[p]).phase).toBe(p)
    }
  })

  it('the standalone --apply path is STILL refused', () => {
    // This slice adds the verifier; it does not open the copier. Apply stays
    // unavailable until a lifecycle owner exists that runs BOTH, which is a
    // later slice than this one.
    const cli = strip(read('bin/pg-copy.ts'))
    expect(cli).toContain('if (parsed.apply) {')
    expect(cli).toContain("say('REFUSED: the standalone --apply path is not available.')")
    expect(cli).not.toContain('runApply(')
    expect(cli).not.toContain('runVerification(')
    // And no standalone verifier entrypoint was added beside it: the verifier
    // is reachable only with a live supervisor fence the caller already holds.
    expect(cli).not.toContain('--verify')
    for (const rel of ['bin/pg-copy.ts', 'bin/pg-copy-manifest.ts', 'bin/pg-copy-contract.ts']) {
      expect(read(rel), rel).not.toContain("from '../src/pg-copy/verify.js'")
    }
  })

  it('the reviewed target artifact on disk is still the committed one', () => {
    const a = JSON.parse(read('contracts/expected-target-v19.json')) as ContractArtifact
    expect(a.digest).toBe(REVIEWED_CONTRACT_DIGEST)
    expect(contractDigest(a.payload)).toBe(REVIEWED_CONTRACT_DIGEST)
  })
})
