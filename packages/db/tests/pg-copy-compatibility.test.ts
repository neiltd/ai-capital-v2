// C1 — the comparator, exercised on every branch it has.
//
// The live suite proves a genuine V10 copies into a genuine V19. That proves
// the ACCEPT path and nothing else: this repository's V19 happens to carry no
// extra index and no extra foreign key over its V10, so the allowed-superset
// branches never fire there. They are exercised here instead, on controlled
// fixtures derived from the committed artifact - which is the only honest way
// to test a policy whose whole point is to hold for schemas that do not exist
// yet.
//
// EVERY FIXTURE IS A MUTATION OF THE REAL ARTIFACT, not a hand-written shape.
// A comparator tested against a toy contract passes for reasons that have
// nothing to do with the contract it will actually be given.

import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { inspect } from 'node:util'

import { describe, expect, it } from 'vitest'

import {
  CopyIncompatible, assertCopyCompatible, assertCopyDomainSafe, compatibilityDocument,
  sourceTableCopySpec, type CompatibilityCategory, type CompatibilityProof,
} from '../src/pg-copy/copy-compatibility.js'
import {
  CURRENT_V10_MANIFEST, ContractRefused, REVIEWED_CONTRACT_DIGEST, SOURCE_V10_PROFILE,
  TARGET_V19_PROFILE, buildContract, contractDigest, parseArtifact, tableCopySpec,
  type ContractArtifact,
} from '../src/pg-copy/schema-contract.js'

const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const ARTIFACT: ContractArtifact =
  parseArtifact(readFileSync(join(PKG_ROOT, 'contracts', 'expected-target-v19.json'), 'utf-8'))

const surfaces = (e: unknown): string => {
  const err = e as Error & Record<string, unknown>
  let json = ''
  try { json = JSON.stringify(err, Object.getOwnPropertyNames(err)) } catch { json = '' }
  return [String(err.message), String(err.stack ?? ''), json,
          inspect(err, { depth: 8, showHidden: true })].join('\n')
}

/** A deep clone, so a fixture edit cannot leak into the next test. */
const clone = (a: ContractArtifact): ContractArtifact =>
  JSON.parse(JSON.stringify(a)) as ContractArtifact

type AnyRec = Record<string, unknown>
const payload = (a: ContractArtifact): AnyRec => a.payload as unknown as AnyRec
const tables = (a: ContractArtifact): AnyRec[] => payload(a).tables as AnyRec[]
const table = (a: ContractArtifact, q: string): AnyRec =>
  tables(a).find(t => t.qname === q) as AnyRec
const columns = (a: ContractArtifact, q: string): AnyRec[] => table(a, q).columns as AnyRec[]

/** Source and target that are, to begin with, the same schema. */
const pair = (): { s: ContractArtifact; t: ContractArtifact } =>
  ({ s: clone(ARTIFACT), t: clone(ARTIFACT) })

/**
 * Re-digest a deliberately mutated fixture.
 *
 * The proof-minting path refuses an artifact whose digest does not match its
 * payload, which is exactly right for production and useless for a POLICY
 * test: mutating a column to reach the `column-type` branch necessarily
 * invalidates the digest, and without resealing every one of these would
 * refuse for the wrong reason and prove nothing about the policy.
 *
 * The proof-integrity tests below deliberately do NOT use this.
 */
const reseal = (a: ContractArtifact): ContractArtifact =>
  ({ ...a, digest: contractDigest(a.payload) })

/** Compare two POLICY fixtures, each resealed so the mint check is satisfied. */
const compat = (s: ContractArtifact, t2: ContractArtifact): ReturnType<typeof assertCopyCompatible> =>
  assertCopyCompatible(reseal(s), reseal(t2))

const refusal = (fn: () => unknown): CopyIncompatible => {
  let thrown: unknown = null
  try { fn() } catch (e) { thrown = e }
  expect(thrown).toBeInstanceOf(CopyIncompatible)
  return thrown as CopyIncompatible
}

describe('an identical pair is compatible', () => {
  it('accepts, and reports both recognitions without comparing them', () => {
    const { s, t } = pair()
    const proof = compat(s, t)
    expect(proof.sourceDigest).toBe(s.digest)
    expect(proof.targetDigest).toBe(t.digest)
    const r = proof.report
    expect(r.sourceRecognition).toBe('CURRENT_V19')
    expect(r.targetRecognition).toBe('CURRENT_V19')
    expect(r.targetOnlyIndexes).toEqual([])
    expect(r.targetOnlyForeignKeys).toEqual([])
  })

  it('does NOT require the ledgers to match each other', () => {
    // The whole point: a V10 source and a V19 target have different ledgers by
    // design, and C1 must not care.
    const { s, t } = pair()
    ;(payload(s).migrations as AnyRec).recognition = 'CURRENT_V10'
    ;(payload(s).migrations as AnyRec).count = 10
    ;(payload(s).migrations as AnyRec).ledger = CURRENT_V10_MANIFEST
    const r = compat(s, t).report
    expect(r.sourceRecognition).toBe('CURRENT_V10')
    expect(r.targetRecognition).toBe('CURRENT_V19')
  })

  it('does NOT compare owners', () => {
    const { s, t } = pair()
    for (const x of tables(s)) x.owner = 'thanapold'
    for (const x of tables(t)) x.owner = 'ai_capital_owner'
    expect(() => compat(s, t)).not.toThrow()
  })

  it('does NOT require the source to carry a target-only extension', () => {
    const { s, t } = pair()
    const ext = (a: ContractArtifact): AnyRec[] =>
      (payload(a).platform as AnyRec).extensions as AnyRec[]
    ;(payload(s).platform as AnyRec).extensions =
      ext(s).filter(e => e.name !== 'btree_gist')
    expect(ext(s).some(e => e.name === 'btree_gist')).toBe(false)
    expect(ext(t).some(e => e.name === 'btree_gist')).toBe(true)
    expect(() => compat(s, t)).not.toThrow()
  })

  it('does NOT compare dropped-column counts', () => {
    const { s, t } = pair()
    table(s, 'graph.edges').dropped_column_count = 3
    expect(() => compat(s, t)).not.toThrow()
  })
})

describe('every equality-required category refuses', () => {
  const cases: Array<[CompatibilityCategory, string, (p: { s: ContractArtifact; t: ContractArtifact }) => void]> = [
    ['copy-set', 'a missing table',
      p => { (payload(p.t).table_order as string[]).pop() }],
    ['relation-kind', 'an unlogged table',
      p => { table(p.t, 'graph.edges').relpersistence = 'u' }],
    ['column-sequence', 'a renamed column',
      p => { columns(p.t, 'graph.edges')[1].name = 'renamed' }],
    ['column-sequence', 'a reordered column list',
      p => {
        const c = columns(p.t, 'graph.edges')
        ;[c[0], c[1]] = [c[1], c[0]]
      }],
    ['column-type', 'a changed typmod',
      p => { columns(p.t, 'capital.chunks').find(c => c.name === 'embedding')!
               .format_type = 'public.vector(256)' }],
    ['column-nullability', 'a relaxed NOT NULL',
      p => { columns(p.t, 'graph.edges')[1].not_null = false }],
    ['column-default', 'an added default',
      p => {
        const c = columns(p.t, 'graph.edges')[1]
        c.has_default = true
        c.default_expression = "'x'::text"
      }],
    ['column-default', 'a changed default expression',
      p => {
        // `portfolio.trade_log.id` is a serial, so it genuinely has one.
        const d = columns(p.t, 'portfolio.trade_log').find(x => x.has_default === true)
        expect(d, 'fixture needs a column that really has a default').toBeDefined()
        d!.default_expression = 'now()'
      }],
    ['column-identity', 'an identity policy difference',
      p => { columns(p.t, 'graph.edges')[1].identity = 'd' }],
    ['column-generated', 'a generation policy difference',
      p => { columns(p.t, 'graph.edges')[1].generated = 's' }],
    ['column-collation', 'a different collation',
      p => {
        (columns(p.t, 'graph.edges')[1].collation as AnyRec).name = 'en_US'
      }],
    ['key-constraints', 'a changed primary key',
      p => {
        const cs = table(p.t, 'graph.edges').constraints as AnyRec[]
        cs.find(c => c.type === 'p')!.definition = 'PRIMARY KEY (from_ticker)'
      }],
    ['check-constraints', 'a changed check',
      p => {
        (table(p.t, 'graph.edges').constraints as AnyRec[]).push({
          name: 'extra_chk', type: 'c', definition: 'CHECK ((id IS NOT NULL))',
          columns: 'id', validated: true, deferrable: false, deferred: false,
        })
      }],
    ['foreign-keys', 'a source FK missing from the target',
      p => {
        const cs = table(p.t, 'graph.edges').constraints as AnyRec[]
        const i = cs.findIndex(c => c.type === 'f')
        cs.splice(i, 1)
      }],
    ['sequence-linkage', 'a changed serial linkage',
      p => {
        columns(p.t, 'portfolio.trade_log').find(c => c.name === 'id')!
          .serial_sequence = 'portfolio.other_seq'
      }],
    ['sequence-options', 'a changed increment',
      p => {
        (payload(p.t).sequences as AnyRec[])[0].increment_by = '2'
      }],
    ['platform', 'a different lc_collate',
      p => { (payload(p.t).platform as AnyRec).lc_collate = 'C' }],
    ['platform', 'a different TimeZone',
      p => { (payload(p.t).platform as AnyRec).timezone = 'UTC' }],
    ['vector-extension', 'a different vector version',
      p => {
        ((payload(p.t).platform as AnyRec).extensions as AnyRec[])
          .find(e => e.name === 'vector')!.version = '0.9.0'
      }],
  ]

  for (const [category, label, mutate] of cases) {
    it(`refuses ${label} (${category})`, () => {
      const p = pair()
      mutate(p)
      const e = refusal(() => compat(p.s, p.t))
      expect(e.category, label).toBe(category)
      // A refusal names the property and the relation, and carries no data.
      expect(surfaces(e)).not.toMatch(/password|postgresql:\/\//i)
    })
  }

  it('is NON-VACUOUS: the unmutated pair passes every one of those', () => {
    const p = pair()
    expect(() => compat(p.s, p.t)).not.toThrow()
  })
})

describe('the two allowed target supersets, and their boundaries', () => {
  const extraIndex = (a: ContractArtifact, over: Partial<AnyRec> = {}): void => {
    (table(a, 'graph.edges').indexes as AnyRec[]).push({
      name: 'idx_target_only', is_primary: false, is_unique: false,
      is_valid: true, is_ready: true, predicate: '', expressions: '',
      definition: 'CREATE INDEX idx_target_only ON graph.edges USING btree (status)',
      ...over,
    })
  }
  const extraFk = (a: ContractArtifact, over: Partial<AnyRec> = {}): void => {
    (table(a, 'graph.edges').constraints as AnyRec[]).push({
      name: 'edges_extra_fkey', type: 'f',
      definition: 'FOREIGN KEY (status) REFERENCES graph.nodes(ticker)',
      columns: 'status', validated: true, deferrable: false, deferred: false, ...over,
    })
  }

  it('ALLOWS a target-only non-identity index, and records its full definition', () => {
    const { s, t } = pair()
    extraIndex(t)
    const r = compat(s, t).report
    expect(r.targetOnlyIndexes.length).toBe(1)
    const i = r.targetOnlyIndexes[0]
    expect(i.qname).toBe('graph.edges')
    expect(i.name).toBe('idx_target_only')
    expect(i.definition).toContain('USING btree (status)')
    expect(i.is_valid).toBe(true)
    expect(i.is_ready).toBe(true)
    expect(i.predicate).toBe('')
    expect(i.expressions).toBe('')
    // And it reaches the evidence document.
    const doc = compatibilityDocument(r) as unknown as AnyRec
    expect(JSON.stringify(doc)).toContain('idx_target_only')
  })

  it('REFUSES a target-only index that is unique or primary', () => {
    // Caught by the IDENTITY-SET comparison, which runs first: an extra unique
    // index makes the target's identity set larger than the source's. The
    // later target-only guard is defence in depth behind it, and the category
    // is what matters - a unique index the source does not have can refuse
    // rows the source holds, and neither branch lets that through.
    for (const over of [{ is_unique: true }, { is_primary: true }]) {
      const { s, t } = pair()
      extraIndex(t, over)
      const e = refusal(() => compat(s, t))
      expect(e.category, JSON.stringify(over)).toBe('identity-indexes')
      expect(e.qname).toBe('graph.edges')
    }
  })

  it('REFUSES an identity index that is not valid and ready', () => {
    for (const k of ['is_valid', 'is_ready']) {
      const { s, t } = pair()
      const pk = (table(t, 'graph.edges').indexes as AnyRec[]).find(i => i.is_primary === true)
      pk![k] = false
      const e = refusal(() => compat(s, t))
      expect(e.category, k).toBe('identity-indexes')
    }
  })

  it('ALLOWS a validated, non-deferrable, non-deferred target-only FK', () => {
    const { s, t } = pair()
    extraFk(t)
    const r = compat(s, t).report
    expect(r.targetOnlyForeignKeys.length).toBe(1)
    expect(r.targetOnlyForeignKeys[0].name).toBe('edges_extra_fkey')
    expect(r.targetOnlyForeignKeys[0].definition).toContain('REFERENCES graph.nodes')
  })

  it('REFUSES a target-only FK that is NOT VALID, deferrable or deferred', () => {
    for (const over of [{ validated: false }, { deferrable: true }, { deferred: true }]) {
      const { s, t } = pair()
      extraFk(t, over)
      const e = refusal(() => compat(s, t))
      expect(e.category, JSON.stringify(over)).toBe('foreign-keys')
      expect(e.message).toContain('not validated, non-deferrable and non-deferred')
    }
  })

  it('a SOURCE-only index or FK is not a target superset and still refuses', () => {
    const { s, t } = pair()
    extraFk(s)
    expect(refusal(() => compat(s, t)).category).toBe('foreign-keys')
  })
})

describe('what neither side may carry', () => {
  it('refuses row level security wherever it appears', () => {
    for (const side of ['s', 't'] as const) {
      for (const flag of ['row_security', 'force_row_security']) {
        const p = pair()
        table(p[side], 'graph.edges')[flag] = true
        const e = refusal(() => compat(p.s, p.t))
        expect(e.category, `${side}.${flag}`).toBe('row-security')
      }
    }
  })

  it('refuses a stored generated column and an identity column on either side', () => {
    for (const side of ['s', 't'] as const) {
      const g = pair()
      columns(g[side], 'graph.edges')[1].generated = 's'
      expect(refusal(() => compat(g.s, g.t)).category).toBe('column-generated')

      const i = pair()
      columns(i[side], 'graph.edges')[1].identity = 'a'
      expect(refusal(() => compat(i.s, i.t)).category).toBe('column-identity')
    }
  })

  it('refuses a nondeterministic collation and a drifted one', () => {
    const nd = pair()
    ;(columns(nd.t, 'graph.edges')[1].collation as AnyRec).deterministic = false
    expect(refusal(() => compat(nd.s, nd.t)).message)
      .toContain('nondeterministic')

    const drift = pair()
    const col = columns(drift.s, 'graph.edges')[1].collation as AnyRec
    col.version = '1.0'
    col.actual_version = '2.0'
    expect(refusal(() => compat(drift.s, drift.t)).message)
      .toContain('drifted')
  })

  it('assertCopyDomainSafe accepts the reviewed artifact unchanged', () => {
    expect(() => assertCopyDomainSafe(ARTIFACT)).not.toThrow()
  })
})

describe('the CURRENT_V10 source profile', () => {
  const ledger = (entries: ReadonlyArray<{ filename: string; sha256: string }>):
    string[][] => entries.map(e => [e.filename, e.sha256])

  /** The committed V19 raw shape, with only the ledger swapped. */
  const rawWith = (rows: string[][]): Parameters<typeof buildContract>[0] => ({
    platform: [['170010', 'UTF8', 'en_US.UTF-8', 'en_US.UTF-8',
                'America/Los_Angeles', 'pg_catalog.english']],
    extensions: [['btree_gist', '1.7', 'public'], ['plpgsql', '1.0', 'pg_catalog'],
                 ['vector', '0.8.2', 'public']],
    migrations: rows,
    relations: [], columns: [], droppedColumns: [], constraints: [],
    indexes: [], triggers: [], sequences: [],
  })

  it('names exactly the reviewed ten, in order', () => {
    expect(CURRENT_V10_MANIFEST.length).toBe(10)
    expect(CURRENT_V10_MANIFEST.map(e => e.filename)).toEqual([
      '001_portfolio.sql', '002_capital.sql', '003_thesis.sql', '004_briefing.sql',
      '005_graph.sql', '006_vectors.sql', '007_trade.sql', '008_desk.sql',
      '009_claim_governance.sql', '010_correct_claim_history.sql',
    ])
    for (const e of CURRENT_V10_MANIFEST) expect(e.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(SOURCE_V10_PROFILE.recognition).toBe('CURRENT_V10')
    expect(TARGET_V19_PROFILE.recognition).toBe('CURRENT_V19')
  })

  it('matches the migration files in this repository, byte for byte', async () => {
    const { createHash } = await import('node:crypto')
    for (const e of CURRENT_V10_MANIFEST) {
      const sql = readFileSync(join(PKG_ROOT, 'migrations', e.filename), 'utf-8')
      expect(createHash('sha256').update(sql).digest('hex'), e.filename).toBe(e.sha256)
    }
  })

  it('RECOGNISES the exact ten and refuses a count, a prefix or a wrong hash', () => {
    // The reviewed ten are recognised. (The rest of the contract is empty here,
    // which `buildContract` refuses later - the ledger is what is under test,
    // so the refusal must NOT be the ledger one.)
    let thrown: unknown = null
    try { buildContract(rawWith(ledger(CURRENT_V10_MANIFEST)), SOURCE_V10_PROFILE) }
    catch (e) { thrown = e }
    expect(String((thrown as Error | null)?.message ?? '')).not.toContain('migration ledger')

    // NINE of ten - a prefix is not recognition.
    expect(() => buildContract(
      rawWith(ledger(CURRENT_V10_MANIFEST.slice(0, 9))), SOURCE_V10_PROFILE))
      .toThrow(/the migration ledger is not CURRENT_V10/)

    // TEN rows, one wrong hash - a count is not recognition.
    const wrongHash = ledger(CURRENT_V10_MANIFEST)
    wrongHash[4][1] = 'f'.repeat(64)
    expect(() => buildContract(rawWith(wrongHash), SOURCE_V10_PROFILE))
      .toThrow(/hash-mismatched/)

    // TEN rows, one wrong filename.
    const wrongName = ledger(CURRENT_V10_MANIFEST)
    wrongName[2][0] = '003_thesis_renamed.sql'
    expect(() => buildContract(rawWith(wrongName), SOURCE_V10_PROFILE))
      .toThrow(/the migration ledger is not CURRENT_V10/)

    // And a V19 ledger is NOT a V10 source.
    expect(() => buildContract(rawWith(ledger(CURRENT_V10_MANIFEST)), TARGET_V19_PROFILE))
      .toThrow(/the migration ledger is not CURRENT_V19/)
  })

  it('refuses a duplicated ledger row', () => {
    const dup = ledger(CURRENT_V10_MANIFEST)
    dup.push([...dup[0]])
    expect(() => buildContract(rawWith(dup), SOURCE_V10_PROFILE)).toThrow(ContractRefused)
  })
})

// ---------------------------------------------------------------------------
// B — collation identity is COMPLETE, versions included
// ---------------------------------------------------------------------------

describe('collation identity includes both version fields', () => {
  const coll = (a: ContractArtifact): AnyRec =>
    columns(a, 'graph.edges')[1].collation as AnyRec

  it('REFUSES X/X against Y/Y - both drift-free, and still different', () => {
    // Neither side has drifted from what it was built with, so the per-side
    // drift check is silent; the two databases still sort differently.
    const { s, t } = pair()
    coll(s).version = 'X'
    coll(s).actual_version = 'X'
    coll(t).version = 'Y'
    coll(t).actual_version = 'Y'
    const e = refusal(() => compat(s, t))
    expect(e.category).toBe('column-collation')
    expect(e.message).toContain('a column collation differs')
    expect(e.message).not.toContain('drifted')
  })

  it('REFUSES a difference in either field alone', () => {
    for (const field of ['version', 'actual_version']) {
      const { s, t } = pair()
      // Both sides internally consistent at first...
      coll(s).version = 'X'
      coll(s).actual_version = 'X'
      coll(t).version = 'X'
      coll(t).actual_version = 'X'
      // ...then one field moves on the target, and its own drift check would
      // fire too - so the source is moved to match, isolating the cross-side
      // comparison as the only thing that can refuse.
      coll(t)[field] = 'Y'
      coll(t)[field === 'version' ? 'actual_version' : 'version'] = 'Y'
      coll(s)[field === 'version' ? 'actual_version' : 'version'] = 'X'
      expect(refusal(() => compat(s, t)).category, field)
        .toBe('column-collation')
    }
  })

  it('REFUSES when only `version` differs and the drift check CANNOT fire', () => {
    // `actual_version` null on both sides, so the per-side drift check skips
    // (it needs both fields non-null). The only thing that can refuse this is
    // `version` being part of the cross-side identity.
    const { s, t } = pair()
    coll(s).version = 'X'
    coll(s).actual_version = null
    coll(t).version = 'Y'
    coll(t).actual_version = null
    const e = refusal(() => compat(s, t))
    expect(e.category).toBe('column-collation')
    expect(e.message).toContain('a column collation differs')
    expect(e.message).not.toContain('drifted')
  })

  it('REFUSES when only `actual_version` differs and the drift check CANNOT fire', () => {
    // Mirror image: `version` null on both sides, so drift again cannot fire.
    const { s, t } = pair()
    coll(s).version = null
    coll(s).actual_version = 'X'
    coll(t).version = null
    coll(t).actual_version = 'Y'
    const e = refusal(() => compat(s, t))
    expect(e.category).toBe('column-collation')
    expect(e.message).not.toContain('drifted')
  })

  it('ACCEPTS null/null on both sides when everything else matches', () => {
    const { s, t } = pair()
    for (const a of [s, t]) {
      coll(a).version = null
      coll(a).actual_version = null
    }
    expect(() => compat(s, t)).not.toThrow()
  })

  it('still refuses a side that has drifted from itself', () => {
    const { s, t } = pair()
    coll(s).version = 'X'
    coll(s).actual_version = 'Y'
    coll(t).version = 'X'
    coll(t).actual_version = 'Y'
    // Identical across the sides, so only the per-side check can catch it.
    expect(refusal(() => compat(s, t)).message).toContain('drifted')
  })
})

// ---------------------------------------------------------------------------
// C — the proof, and what it makes impossible
// ---------------------------------------------------------------------------

describe('the compatibility proof cannot be forged, reused or outrun', () => {
  const v10ish = (): ContractArtifact => {
    // A source that is NOT the reviewed target artifact: a different ledger,
    // re-digested so it is perfectly self-consistent. Exactly the artifact the
    // old nullable anchor would have accepted on a caller's say-so.
    const a = clone(ARTIFACT)
    ;(payload(a).migrations as AnyRec).recognition = 'CURRENT_V10'
    ;(payload(a).migrations as AnyRec).count = 10
    ;(payload(a).migrations as AnyRec).ledger = CURRENT_V10_MANIFEST
    return { ...a, digest: contractDigest(a.payload) }
  }

  it('a SELF-CONSISTENT source is still refused by the target-anchored path', () => {
    const a = v10ish()
    expect(contractDigest(a.payload)).toBe(a.digest)
    expect(a.digest).not.toBe(REVIEWED_CONTRACT_DIGEST)
    expect(() => tableCopySpec(a, 'graph.edges'))
      .toThrow(/is not the reviewed expected-target digest/)
  })

  it('a forged proof is rejected at COMPILE time and at RUN time', () => {
    const a = v10ish()
    const shape = {
      sourceDigest: a.digest, targetDigest: ARTIFACT.digest,
      report: {
        sourceRecognition: 'CURRENT_V10', targetRecognition: 'CURRENT_V19',
        targetOnlyIndexes: [], targetOnlyForeignKeys: [],
      },
    }
    // COMPILE TIME: no object literal satisfies the branded type.
    // @ts-expect-error a proof cannot be constructed outside the comparator
    const typed: CompatibilityProof = shape
    void typed

    // RUN TIME: and casting past the type system does not help, because the
    // brand is a real symbol this module owns. Every field is right; the
    // capability is missing, and the capability is the whole point.
    const forged = shape as unknown as CompatibilityProof
    expect(() => sourceTableCopySpec(a, 'graph.edges', forged))
      .toThrow(/not one this module issued/)
  })

  it('a SPREAD or SERIALIZED copy of a genuine proof is rejected', () => {
    const a = v10ish()
    const genuine = assertCopyCompatible(a, ARTIFACT)
    // The genuine article works.
    expect(() => sourceTableCopySpec(a, 'graph.edges', genuine)).not.toThrow()

    // A spread copies own ENUMERABLE properties; the brand is not one, so the
    // copy has every field and none of the authority.
    const spread = { ...genuine } as unknown as CompatibilityProof
    expect(spread.sourceDigest).toBe(genuine.sourceDigest)
    expect(spread.targetDigest).toBe(genuine.targetDigest)
    expect(() => sourceTableCopySpec(a, 'graph.edges', spread))
      .toThrow(/not one this module issued/)

    // A JSON round trip loses it too - and symbols cannot survive one at all.
    const serialized = JSON.parse(JSON.stringify(genuine)) as CompatibilityProof
    expect(() => sourceTableCopySpec(a, 'graph.edges', serialized))
      .toThrow(/not one this module issued/)

    // Nothing about the genuine proof was disturbed by any of that.
    expect(() => sourceTableCopySpec(a, 'graph.edges', genuine)).not.toThrow()
  })

  it('null, undefined and primitives are rejected before any field is read', () => {
    const a = v10ish()
    for (const bad of [null, undefined, 0, 'proof', [], { sourceDigest: a.digest }]) {
      expect(() => sourceTableCopySpec(a, 'graph.edges', bad as unknown as CompatibilityProof),
             String(bad)).toThrow(/not one this module issued/)
    }
  })

  it('MINTING refuses an internally inconsistent SOURCE', () => {
    const a = v10ish()
    const lying = { ...a, digest: 'f'.repeat(64) }
    expect(() => assertCopyCompatible(lying, ARTIFACT))
      .toThrow(/source artifact digest .* does not match its payload/)
    // And an edited payload with an untouched digest.
    const edited = clone(a)
    columns(edited, 'graph.edges')[1].name = 'smuggled'
    expect(() => assertCopyCompatible(edited, ARTIFACT))
      .toThrow(/source artifact digest .* does not match its payload/)
  })

  it('MINTING refuses an internally inconsistent TARGET', () => {
    const a = v10ish()
    const lying = { ...ARTIFACT, digest: 'f'.repeat(64) }
    expect(() => assertCopyCompatible(a, lying))
      .toThrow(/target artifact digest .* does not match its payload/)
    const edited = clone(ARTIFACT)
    columns(edited, 'graph.edges')[1].name = 'smuggled'
    expect(() => assertCopyCompatible(a, edited))
      .toThrow(/target artifact digest .* does not match its payload/)
  })

  it('records the RECOMPUTED digests, not the artifacts own fields', () => {
    const a = v10ish()
    const proof = assertCopyCompatible(a, ARTIFACT)
    expect(proof.sourceDigest).toBe(contractDigest(a.payload))
    expect(proof.targetDigest).toBe(contractDigest(ARTIFACT.payload))
    expect(proof.targetDigest).toBe(REVIEWED_CONTRACT_DIGEST)
  })

  it('a proof issued against a DIFFERENT TARGET never unlocks the source copy', () => {
    // A target that is compatible with the source but is NOT the reviewed
    // artifact: only its ledger differs, and ledgers are deliberately not
    // compared - so C1 passes and the digest is somebody else's.
    const a = v10ish()
    const otherTarget = clone(ARTIFACT)
    ;(payload(otherTarget).migrations as AnyRec).recognition = 'CURRENT_V21'
    ;(payload(otherTarget).migrations as AnyRec).count = 21
    const sealedOther = reseal(otherTarget)
    expect(sealedOther.digest).not.toBe(REVIEWED_CONTRACT_DIGEST)

    const proof = assertCopyCompatible(a, sealedOther)
    expect(proof.sourceDigest).toBe(a.digest)          // the SOURCE matches
    expect(() => sourceTableCopySpec(a, 'graph.edges', proof))
      .toThrow(/not issued against the reviewed expected-target contract/)
  })

  it('a real proof unlocks the source path', () => {
    const a = v10ish()
    const proof = assertCopyCompatible(a, ARTIFACT)
    const spec = sourceTableCopySpec(a, 'graph.edges', proof)
    expect(spec.qname).toBe('graph.edges')
    expect(spec.columns.length).toBeGreaterThan(0)
    expect(spec.columns).toEqual(
      (columns(ARTIFACT, 'graph.edges')).map(c => c.name as string))
  })

  it('a proof issued for ANOTHER artifact is refused', () => {
    const a = v10ish()
    const other = clone(ARTIFACT)
    ;(payload(other).migrations as AnyRec).recognition = 'CURRENT_V10'
    ;(payload(other).migrations as AnyRec).count = 11
    const rebadged = { ...other, digest: contractDigest(other.payload) }
    const proofForOther = assertCopyCompatible(rebadged, ARTIFACT)
    expect(proofForOther.sourceDigest).not.toBe(a.digest)
    expect(() => sourceTableCopySpec(a, 'graph.edges', proofForOther))
      .toThrow(/issued for a different source artifact/)
  })

  it('MUTATING the artifact after the proof was issued is refused', () => {
    const a = v10ish()
    const proof = assertCopyCompatible(a, ARTIFACT)
    // Edit a column name and re-digest, so the artifact is self-consistent
    // again - the proof still records what it actually verified.
    const tampered = clone(a)
    columns(tampered, 'graph.edges')[1].name = 'smuggled'
    const resealed = { ...tampered, digest: contractDigest(tampered.payload) }
    expect(() => sourceTableCopySpec(resealed, 'graph.edges', proof))
      .toThrow(/issued for a different source artifact/)
  })

  it('an artifact whose digest field was edited is refused before any column is read', () => {
    const a = v10ish()
    const proof = assertCopyCompatible(a, ARTIFACT)
    const lying = { ...a, digest: 'f'.repeat(64) }
    expect(() => sourceTableCopySpec(lying, 'graph.edges', proof))
      .toThrow(/does not match its payload/)
  })

  it('refuses a table outside the reviewed copy set even with a valid proof', () => {
    const a = v10ish()
    const proof = assertCopyCompatible(a, ARTIFACT)
    expect(() => sourceTableCopySpec(a, 'desk.probe', proof))
      .toThrow(/not in the reviewed copy set/)
  })
})
