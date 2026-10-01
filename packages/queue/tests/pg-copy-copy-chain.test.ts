// K7-B7: the production copy's closure chain.
//
// EVERY CASE HERE TAMPERS AND THEN REPUBLISHES. A bundle edited in place fails
// its own DIGEST, and a refusal caused by that proves nothing about semantic
// cross-checking - it is the evidence layer doing its job, not the chain doing
// its job. So each splice builds a bundle whose recomputed DIGEST is valid and
// then proves the CHAIN refused it.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { basename, join } from 'node:path'
import { tmpdir } from 'node:os'
import { readFileSync } from 'node:fs'
import {
  EXPORT_SCHEMAS, EXPORT_TABLES, LEDGER_COLUMNS,
  QUEUE_SAMPLE_INTERVAL_MS, REVIEWED_QUEUES, publishEvidence, verifyPublishedEvidence,
} from '@common/db/pg-copy'
import { BLOCKING_STATES, PAUSED_IS_BLOCKING } from '../src/pg-copy-ops/bullmq.js'
import {
  OpsRefused, proveQueuesRestored, verifyCopyChain, verifyCopyRestorationLink,
  verifyReferencedBundle,
} from '../bin/pg-copy-ops.js'
import {
  AuthorityRefused, REAL_AUTHORITY_FS, REAL_PROVE_OPS,
  authorizeTeardown, runAuthorityCli, type RoleFacts,
} from '../bin/pg-copy-export-authority.js'
import { stage1Bundle, type World } from './support/ops-world.js'

/** Source text with comments removed, so a guard cannot match its own prose. */
const strip = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n')
    .filter(l => !l.trimStart().startsWith('//')).join('\n')

const STAMP = '20260930T101500Z'
const RUN = 'aabbccdd'
const ROOT_D = 'b'.repeat(64)
const TGT_CONTRACT = 'd'.repeat(64)
const SYS_SRC = '7300000000000000001'
const SYS_TGT = '9300000000000000002'
const EXPORT_ROLE = 'ai_capital_v3_export'

/** The reviewed authority, as the live read-back would report it. */
const ROLE_FACTS: RoleFacts = Object.freeze({
  systemIdentifier: SYS_SRC,
  present: true, canLogin: true, superuser: false, createRole: false,
  createDb: false, replication: false, bypassRls: false,
  memberships: [], schemaUsage: [...EXPORT_SCHEMAS], tableSelect: [...EXPORT_TABLES],
  ledgerColumns: [...LEDGER_COLUMNS],
  writeGrants: [], routineGrants: [], sequenceGrants: [],
})

type Doc = Record<string, unknown>
const deep = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T

/** Replace a dotted path inside a cloned document. */
const withPath = (doc: Doc, path: string, value: unknown): Doc => {
  const out = deep(doc)
  const keys = path.split('.')
  let cur = out as Record<string, unknown>
  for (const k of keys.slice(0, -1)) cur = cur[k] as Record<string, unknown>
  cur[keys[keys.length - 1] as string] = value
  return out
}

/** Drop a dotted path from a cloned document. */
const without = (doc: Doc, path: string): Doc => {
  const out = deep(doc)
  const keys = path.split('.')
  let cur = out as Record<string, unknown>
  for (const k of keys.slice(0, -1)) cur = cur[k] as Record<string, unknown>
  delete cur[keys[keys.length - 1] as string]
  return out
}

interface ChainDocs {
  lifecycle: Doc
  gate: Doc
  verification: Doc
}

/** What the published Stage-1 bundle actually says about itself. */
interface Stage1Facts {
  readonly dir: string
  readonly name: string
  readonly rootDigest: string
  readonly sourceContractDigest: string
  readonly systemIdentifier: string
  readonly database: string
  readonly role: string
}

/**
 * The three downstream documents of a coherent, closable copy, built to AGREE
 * with the Stage-1 bundle the reviewed fixture actually published.
 */
const coherent = (
  s1: Stage1Facts, gateName: string, verifyName: string,
): ChainDocs => ({
  verification: {
    verification_version: 1,
    complete: true,
    outcome: 'PASS',
    failure: null,
    run: { id: RUN, stamp: STAMP },
    bundle: { name: s1.name },
    source: { system_identifier: s1.systemIdentifier, database: s1.database, role: s1.role },
    target: { system_identifier: SYS_TGT, database: 'ai_capital_v3', role: 'ai_capital_owner' },
    stage2: {
      root_digest: s1.rootDigest,
      source_contract_digest: s1.sourceContractDigest,
      target_contract_digest: TGT_CONTRACT,
    },
  },
  gate: {
    release_gate_version: 1,
    complete: true,
    record: 'authorization-to-release',
    authorized: true,
    run: { id: RUN, stamp: STAMP },
    bundle: { name: s1.name, verifier: verifyName },
    content: {
      root_digest: s1.rootDigest,
      source_contract_digest: s1.sourceContractDigest,
      target_contract_digest: TGT_CONTRACT,
    },
    source: { system_identifier: s1.systemIdentifier, database: s1.database, role: s1.role },
    target: { system_identifier: SYS_TGT, database: 'ai_capital_v3', role: 'ai_capital_owner' },
  },
  lifecycle: {
    lifecycle_version: 1,
    complete: true,
    record: 'lifecycle-outcome',
    outcome: 'COPY_VERIFIED_AWAITING_MANUAL_RESTORATION',
    producers_restored: false,
    run: { id: RUN, stamp: STAMP },
    bundle: { name: s1.name, release_gate: gateName },
    fence: { state: 'released', remaining_locks: 0 },
    release: { state: 'released' },
    content: {
      root_digest: s1.rootDigest,
      source_contract_digest: s1.sourceContractDigest,
      target_contract_digest: TGT_CONTRACT,
    },
  },
})

/** Publish one bundle with a VALID recomputed DIGEST over whatever it says. */
const publishIn = (
  root: string, prefix: string, file: string, doc: Doc,
  stamp = STAMP, runId = RUN,
): string =>
  publishEvidence({
    root, prefix, stamp, runId,
    artifacts: [{ path: 'detail.json', bytes: Buffer.from('{}\n', 'utf-8') }],
    manifest: { path: file, bytes: Buffer.from(`${JSON.stringify(doc)}\n`, 'utf-8') },
  }).finalPath

/** The sha256 of a published bundle's DIGEST file - what every link carries. */
const digestOf = (dir: string): string =>
  createHash('sha256').update(readFileSync(join(dir, 'DIGEST'))).digest('hex')

/**
 * Build a whole chain, optionally editing one document first.
 *
 * `stamps` lets a case publish a bundle under a DIFFERENT directory stamp
 * while its document keeps the coherent one, which is the name-vs-document
 * disagreement.
 */
const buildChain = (
  root: string,
  edit: (d: ChainDocs) => ChainDocs = d => d,
  stamps: Partial<Record<'lifecycle' | 'gate' | 'verification' | 'manifest', string>> = {},
  runIds: Partial<Record<'manifest', string>> = {},
  manifestOver: Parameters<typeof stage1Bundle>[1] = {},
): Record<string, string> => {
  // THE STAGE-1 BUNDLE COMES FROM THE REVIEWED FIXTURE, which publishes the
  // real `source-contract.json` the Stage-1 reader requires. Hand-rolling it
  // produced a directory that failed its own reader, so every case refused
  // for that reason instead of the one under test.
  const manifestDir = stage1Bundle({ evidence: root } as World, {
    stamp: stamps.manifest ?? STAMP,
    runId: runIds.manifest ?? RUN,
    ...manifestOver,
  })
  const m = JSON.parse(
    readFileSync(join(manifestDir, 'manifest.json'), 'utf-8')) as {
      source: { system_identifier: string; database: string; role: string }
      source_contract: { digest: string }
      content: { root_digest: string }
    }
  const s1: Stage1Facts = {
    dir: manifestDir,
    name: basename(manifestDir),
    rootDigest: m.content.root_digest,
    sourceContractDigest: m.source_contract.digest,
    systemIdentifier: m.source.system_identifier,
    database: m.source.database,
    role: m.source.role,
  }
  const gateName = `release-gate-${stamps.gate ?? STAMP}-${RUN}`
  const verifyName = `verification-${stamps.verification ?? STAMP}-${RUN}`
  const d = edit(coherent(s1, gateName, verifyName))
  const verifyDir = publishIn(root, 'verification', 'verification.json', d.verification,
                              stamps.verification ?? STAMP)
  const gateDir = publishIn(root, 'release-gate', 'release-gate.json', d.gate,
                            stamps.gate ?? STAMP)
  const lifecycleDir = publishIn(root, 'copy-lifecycle', 'lifecycle.json', d.lifecycle,
                                 stamps.lifecycle ?? STAMP)
  return {
    '--copy-lifecycle-bundle': lifecycleDir,
    '--release-gate-bundle': gateDir,
    '--verification-bundle': verifyDir,
    '--source-manifest-bundle': manifestDir,
  }
}

describe('K7-B7: the copy chain is verified semantically, not by name', () => {
  let root = ''
  beforeEach(() => { root = realpathSync(mkdtempSync(join(tmpdir(), 'k7b7-chain-'))) })
  afterEach(() => {
    // Published evidence is deliberately read-only.
    execFileSync('/bin/chmod', ['-R', 'u+w', root])
    rmSync(root, { recursive: true, force: true })
    expect(existsSync(root)).toBe(false)
  })

  /**
   * Build a whole chain, optionally editing one document first.
   *
   * `stamps` lets a case publish a bundle under a DIFFERENT directory stamp
   * while its document keeps the coherent one, which is the name-vs-document
   * disagreement.
   */
  const chain = (
    edit: (d: ChainDocs) => ChainDocs = d => d,
    stamps: Partial<Record<'lifecycle' | 'gate' | 'verification' | 'manifest', string>> = {},
    runIds: Partial<Record<'manifest', string>> = {},
    manifestOver: Parameters<typeof stage1Bundle>[1] = {},
  ): Record<string, string> => buildChain(root, edit, stamps, runIds, manifestOver)

  it('accepts a coherent chain and reports one copy identity', () => {
    const v = chain()
    const out = verifyCopyChain(v)
    expect(out.runId).toBe(RUN)
    expect(out.stamp).toBe(STAMP)
    expect(out.rootDigest).toBe(ROOT_D)
    expect(out.sourceManifest.name).toBe(basename(v['--source-manifest-bundle'] as string))
    // EVERY LINK CARRIES A REAL DIGEST, computed here from the directory.
    for (const l of [out.lifecycle, out.releaseGate, out.verification, out.sourceManifest]) {
      expect(l.digestFileDigest).toMatch(/^[0-9a-f]{64}$/)
    }
  })

  /** Each case must refuse for its own stated reason, not an incidental one. */
  const refuses = (v: Record<string, string>, pattern: RegExp): void => {
    let err: unknown = null
    try { verifyCopyChain(v) } catch (e) { err = e }
    expect(err).toBeInstanceOf(OpsRefused)
    expect(String((err as Error).message)).toMatch(pattern)
    // AND NOT BECAUSE A BUNDLE FAILED ITS OWN DIGEST.
    expect(String((err as Error).message)).not.toMatch(/does not verify/)
  }

  it('refuses the same run id under a DIFFERENT stamp', () => {
    refuses(
      chain(d => ({ ...d, gate: withPath(d.gate, 'run.stamp', '20260101T000000Z') })),
      /different run instant/)
  })

  it('refuses a document whose stamp disagrees with its DIRECTORY name', () => {
    // The gate's directory is stamped differently; its document is coherent.
    refuses(chain(d => d, { gate: '20260101T000000Z' }), /does not carry this run instant/)
  })

  it('refuses a Stage-1 manifest whose generated_at_utc is another instant', () => {
    refuses(chain(d => d, {}, {}, { generatedAtUtc: '2026-01-01T00:00:00Z' }),
            /different generation instant/)
  })

  it('refuses a Stage-1 manifest whose own run_id is another run', () => {
    refuses(chain(d => d, {}, {}, { runIdField: '99999999' }),
            /different run identity/)
  })

  it('refuses a release gate naming another STAGE-1 bundle', () => {
    // CORRECTION 1. Every other edge agreed; this one was never compared.
    refuses(
      chain(d => ({ ...d, gate: withPath(d.gate, 'bundle.name',
                                         `source-manifest-${STAMP}-99999999`) })),
      /release gate names a different Stage-1 bundle/)
  })

  it('refuses a release gate naming another VERIFIER', () => {
    refuses(
      chain(d => ({ ...d, gate: withPath(d.gate, 'bundle.verifier',
                                         `verification-${STAMP}-99999999`) })),
      /authorized against a different verification/)
  })

  it('refuses a release gate that records authorized:false', () => {
    refuses(chain(d => ({ ...d, gate: withPath(d.gate, 'authorized', false) })),
            /does not record an authorization/)
  })

  it('refuses a verification whose outcome is not PASS', () => {
    refuses(chain(d => ({ ...d, verification: withPath(d.verification, 'outcome', 'FAIL') })),
            /verification did not pass/)
  })

  it('refuses a verification carrying a non-null failure', () => {
    refuses(
      chain(d => ({ ...d, verification: withPath(d.verification, 'failure',
        { phase: 'L5-verify', reason: 'the independent verification did not pass', at: null }) })),
      /verification records a failure/)
  })

  it('refuses a release gate describing other CONTENT', () => {
    refuses(
      chain(d => ({ ...d, gate: withPath(d.gate, 'content.root_digest', 'e'.repeat(64)) })),
      /release gate does not describe this copy's content/)
  })

  for (const field of ['system_identifier', 'database', 'role'] as const) {
    it(`refuses a SOURCE ${field} the gate and verification disagree about`, () => {
      refuses(
        chain(d => ({ ...d, verification: withPath(d.verification, `source.${field}`, 'other') })),
        new RegExp(`disagree about the source ${field}`))
    })
    it(`refuses a TARGET ${field} the gate and verification disagree about`, () => {
      refuses(
        chain(d => ({ ...d, verification: withPath(d.verification, `target.${field}`, 'other') })),
        new RegExp(`disagree about the target ${field}`))
    })
  }

  it('refuses a Stage-1 bundle whose SOURCE identity is another cluster', () => {
    const canonical = { system_identifier: SYS_SRC, database: 'ai_capital', role: EXPORT_ROLE }
    refuses(chain(
      d => ({
        ...d,
        gate: withPath(d.gate, 'source', canonical),
        verification: withPath(d.verification, 'source', canonical),
      }),
      {}, {},
      {
        source: {
          system_identifier: '7300000000000000009', database: 'ai_capital',
          role: EXPORT_ROLE, session_user: EXPORT_ROLE,
        },
      }), /disagree about the source/)
  })

  it('refuses a Stage-1 bundle whose EXPORT ROLE is another role', () => {
    // CORRECTION 2. The Stage-1 comparison checked only identifier and
    // database, so a manifest whose export ran as somebody else agreed with
    // the chain on everything that was compared.
    const canonical = { system_identifier: SYS_SRC, database: 'ai_capital', role: EXPORT_ROLE }
    refuses(chain(
      d => ({
        ...d,
        gate: withPath(d.gate, 'source', canonical),
        verification: withPath(d.verification, 'source', canonical),
      }),
      {}, {},
      {
        source: {
          system_identifier: SYS_SRC, database: 'ai_capital',
          role: 'ai_capital_pipeline', session_user: 'ai_capital_pipeline',
        },
      }), /disagree about the export role/)
  })

  it('refuses an upstream bundle that claims COMPLETE', () => {
    refuses(chain(d => ({ ...d, lifecycle: withPath(d.lifecycle, 'outcome', 'COMPLETE') })),
            /reviewed manual-stop outcome|claims COMPLETE/)
  })

  it('refuses a lifecycle that does not record a proved release', () => {
    refuses(chain(d => ({ ...d, lifecycle: withPath(d.lifecycle, 'fence.state', 'unproved') })),
            /does not record a proved release/)
  })

  it('refuses a lifecycle with remaining reviewed locks', () => {
    refuses(chain(d => ({ ...d, lifecycle: withPath(d.lifecycle, 'fence.remaining_locks', 3) })),
            /remaining reviewed locks/)
  })

  it('refuses a lifecycle that already claims the producers were restored', () => {
    refuses(chain(d => ({ ...d, lifecycle: withPath(d.lifecycle, 'producers_restored', true) })),
            /already claims the producers were restored/)
  })

  it('refuses a missing link rather than reading past it', () => {
    refuses(chain(d => ({ ...d, gate: without(d.gate, 'bundle.verifier') })),
            /records no verifier bundle name/)
  })

  it('refuses a cross-run splice: a Stage-1 bundle from another run id', () => {
    refuses(chain(d => d, {}, { manifest: '99999999' }),
            /does not carry this run identity|names a different Stage-1 bundle/)
  })
})

// ---------------------------------------------------------------------------
// K7-B7 C — CLOSURE REFUSES WHAT IS NOT A COPY RESTORATION
// ---------------------------------------------------------------------------

describe('K7-B7: closure accepts only a copy restoration', () => {
  let root = ''
  beforeEach(() => { root = realpathSync(mkdtempSync(join(tmpdir(), 'k7b7-close-'))) })
  afterEach(() => {
    execFileSync('/bin/chmod', ['-R', 'u+w', root])
    rmSync(root, { recursive: true, force: true })
    expect(existsSync(root)).toBe(false)
  })

  /**
   * A bundle carrying a chosen `record` tag under a chosen prefix.
   *
   * THE REHEARSAL'S RESTORATION IS A REAL, VALID BUNDLE. It verifies against
   * its own DIGEST and says `complete: true`; what makes it the wrong evidence
   * is its RECORD TAG, because it closes a run that copied nothing.
   */
  const restorationLike = (prefix: string, record: string, file: string): string =>
    publishEvidence({
      root, prefix, stamp: STAMP, runId: RUN,
      artifacts: [{ path: 'producers.json', bytes: Buffer.from('{}\n', 'utf-8') }],
      manifest: {
        path: file,
        bytes: Buffer.from(`${JSON.stringify({
          record, complete: true, outcome: 'RESTORED',
          run: { id: RUN, stamp: STAMP },
        })}\n`, 'utf-8'),
      },
    }).finalPath

  it('REFUSES a rehearsal producer-restoration bundle', () => {
    // The reviewed rehearsal record, offered where a copy restoration belongs.
    const dir = restorationLike('producer-restoration', 'producer-restoration',
                                'restoration.json')
    let err: unknown = null
    try {
      verifyReferencedBundle(dir, 'copy-restoration', 'copy-restoration.json')
    } catch (e) { err = e }
    expect(err).toBeInstanceOf(OpsRefused)
    // REFUSED ON ITS RECORD, not because its bytes failed to verify.
    expect(String((err as Error).message)).toMatch(/has no manifest|not the expected record/)
    expect(String((err as Error).message)).not.toMatch(/does not verify/)
  })

  it('accepts a real copy-restoration record under the same reader', () => {
    const dir = restorationLike('copy-restoration', 'copy-restoration',
                                'copy-restoration.json')
    const doc = verifyReferencedBundle(dir, 'copy-restoration', 'copy-restoration.json')
    expect((doc as { record?: unknown }).record).toBe('copy-restoration')
  })

  it('a bundle whose tag was swapped for the copy tag still fails its own name', () => {
    // The tag alone is not enough: the DIRECTORY must also be a copy
    // restoration, which `linkFor` requires.
    const dir = restorationLike('producer-restoration', 'copy-restoration',
                                'copy-restoration.json')
    expect(() => verifyCopyRestorationLink(dir))
      .toThrow(/not in the reviewed name form/)
  })
})

// ---------------------------------------------------------------------------
// K7-B7 B — TWO QUEUE SAMPLES, AND THE COMPLETE BLOCKING POLICY
// ---------------------------------------------------------------------------

describe('K7-B7: the restoration samples the queues twice', () => {
  it('takes exactly two samples, separated by the reviewed interval', async () => {
    const taken: number[] = []
    const waits: number[] = []
    const proof = await proveQueuesRestored(
      { sample: async () => {
        taken.push(taken.length + 1)
        return { depths: Object.fromEntries(REVIEWED_QUEUES.map(q => [q, 0])) }
      } },
      5_000,
      async (ms: number) => { waits.push(ms) })
    // TWO SAMPLES. One cannot establish that the queues were STILL empty after
    // time passed, which is the only thing the pair is for.
    expect(taken).toEqual([1, 2])
    expect(proof.samples).toHaveLength(2)
    expect(waits).toEqual([QUEUE_SAMPLE_INTERVAL_MS])
    expect(proof.refusal).toBeNull()
  })

  it('refuses when the SECOND sample is no longer empty', async () => {
    let n = 0
    const proof = await proveQueuesRestored(
      { sample: async () => {
        n += 1
        return {
          depths: Object.fromEntries(REVIEWED_QUEUES.map(q => [q, n === 1 ? 0 : 4])),
        }
      } },
      5_000, async () => undefined)
    expect(proof.samples).toHaveLength(2)
    expect(proof.refusal).not.toBeNull()
  })

  it('the blocking policy covers every reviewed state, and paused is blocking', () => {
    // A queue "empty" only across `active`, `wait` and `delayed` would wave
    // through jobs parked in `prioritized` or blocked on children - and a
    // PAUSED queue is not a depth of zero.
    expect([...BLOCKING_STATES])
      .toEqual(['active', 'wait', 'delayed', 'prioritized', 'waiting-children'])
    expect(PAUSED_IS_BLOCKING).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// K7-B7.2.1 B — THE CLOSURE CHAIN UNDER THE *SHARED* SEMANTIC VERIFIER
//
// `--close-copy` compared a restoration against its chain inline, and the
// export authority did not compare at all: it checked that the closure linked
// the restoration and that both verified their own DIGEST. A forged
// restoration and a forged closure can satisfy that - each with a validly
// recomputed internal digest, linked to each other - and authorize a
// destructive teardown beside an entirely unrelated valid upstream chain.
//
// Every case below republishes with a VALID recomputed DIGEST and is driven
// through `authorizeTeardown`, the consumer that had no comparison at all.
// ---------------------------------------------------------------------------

describe('K7-B7.2.1 B: a spliced restoration or closure cannot authorize teardown', () => {
  let root = ''
  beforeEach(() => { root = realpathSync(mkdtempSync(join(tmpdir(), 'k7b721-closed-'))) })
  afterEach(() => {
    execFileSync('/bin/chmod', ['-R', 'u+w', root])
    rmSync(root, { recursive: true, force: true })
    expect(existsSync(root)).toBe(false)
  })

  /** Private secret roots this describe made, cleaned up whatever happens. */
  const secretRoots: string[] = []
  afterEach(() => {
    while (secretRoots.length > 0) {
      rmSync(secretRoots.pop() as string, { recursive: true, force: true })
    }
  })

  const ENDPOINT = {
    host: '127.0.0.1', port: '5432', database: 'ai_capital',
    // THE CREATE RECORD'S PROVED CLUSTER, which the reviewed Stage-1 fixture
    // also names. A teardown may not act on a bundle from another cluster.
    systemIdentifier: '7300000000000000001',
  }
  const BINDING = 'e'.repeat(64)

  /** A coherent, closable copy: the four-bundle chain, a restoration, a closure. */
  const closed = (over: {
    restoration?: (d: Doc) => Doc
    closure?: (d: Doc) => Doc
  } = {}): Record<string, string> => {
    const v = buildChain(root)
    const c = verifyCopyChain(v)
    const link = (l: { name: string; digestFileDigest: string }): Doc =>
      ({ name: l.name, digest_file_digest: l.digestFileDigest })
    const content = {
      root_digest: c.rootDigest,
      source_contract_digest: c.sourceContractDigest,
      target_contract_digest: c.targetContractDigest,
    }
    const restorationDoc = (over.restoration ?? (d => d))({
      record: 'copy-restoration',
      complete: true,
      outcome: 'COPY_RESTORED',
      run: { id: c.runId, stamp: c.stamp },
      copy: { id: c.runId, stamp: c.stamp },
      copy_chain: {
        copy_lifecycle: link(c.lifecycle),
        release_gate: link(c.releaseGate),
        verification: link(c.verification),
        source_manifest: link(c.sourceManifest),
      },
      content,
      operational_adapter_binding_digest: BINDING,
    })
    const restorationDir =
      publishIn(root, 'copy-restoration', 'copy-restoration.json', restorationDoc)
    const closureDoc = (over.closure ?? (d => d))({
      record: 'copy-closure',
      complete: true,
      outcome: 'COMPLETE',
      run: { id: c.runId, stamp: c.stamp },
      copy: { id: c.runId, stamp: c.stamp },
      copy_restoration: {
        name: basename(restorationDir), digest_file_digest: digestOf(restorationDir),
      },
      source_manifest: link(c.sourceManifest),
      content,
      operational_adapter_binding_digest: BINDING,
    })
    const closureDir = publishIn(root, 'copy-closure', 'copy-closure.json', closureDoc)
    return {
      ...v,
      '--copy-restoration-bundle': restorationDir,
      '--copy-closure-bundle': closureDir,
    }
  }

  /** Refused for its OWN stated reason, and never on a bundle's own digest. */
  const refuses = (
    v: Record<string, string>, pattern: RegExp, ep = ENDPOINT,
  ): void => {
    let err: unknown = null
    try { authorizeTeardown('copy-closed', v, ep) } catch (e) { err = e }
    expect(err).toBeInstanceOf(AuthorityRefused)
    expect(String((err as Error).message)).toMatch(pattern)
    expect(String((err as Error).message)).not.toMatch(/does not verify/)
  }

  it('authorizes a COHERENT closed copy, and names all six bundles', () => {
    const a = authorizeTeardown('copy-closed', closed(), ENDPOINT)
    expect(a.disposition).toBe('copy-closed')
    expect(a.links).toHaveLength(6)
    for (const l of a.links) expect(l.digest_file_digest).toMatch(/^[0-9a-f]{64}$/)
    expect(a.closure?.name).toMatch(/^copy-closure-/)
  })

  // --- the restoration against the chain ---

  it('refuses a restoration that records no chain at all', () => {
    refuses(closed({ restoration: d => without(d, 'copy_chain') }),
            /records no copy chain/)
  })

  it('refuses a restoration that OMITS one chain link', () => {
    refuses(closed({ restoration: d => without(d, 'copy_chain.release_gate') }),
            /omits a chain link/)
  })

  it('refuses a restoration naming a DIFFERENT upstream bundle', () => {
    refuses(
      closed({ restoration: d =>
        withPath(d, 'copy_chain.copy_lifecycle.name', 'copy-lifecycle-20260101T000000Z-99999999') }),
      /names a different bundle/)
  })

  it('refuses a restoration carrying a STALE digest for a real link', () => {
    refuses(
      closed({ restoration: d =>
        withPath(d, 'copy_chain.verification.digest_file_digest', 'f'.repeat(64)) }),
      /no longer has the digest it was closed over/)
  })

  it('refuses a restoration belonging to a DIFFERENT copy id', () => {
    refuses(closed({ restoration: d => withPath(d, 'copy.id', 'deadbeef') }),
            /belongs to a different copy$/)
  })

  it('refuses a restoration belonging to a different copy INSTANT', () => {
    refuses(closed({ restoration: d => withPath(d, 'copy.stamp', '20260101T000000Z') }),
            /belongs to a different copy instant/)
  })

  it('refuses a restoration describing different CONTENT', () => {
    refuses(closed({ restoration: d => withPath(d, 'content.root_digest', 'a'.repeat(64)) }),
            /restoration describes different content/)
  })

  // --- the closure against the restoration and the chain ---

  it('refuses a closure naming ANOTHER Stage-1 bundle', () => {
    refuses(
      closed({ closure: d =>
        withPath(d, 'source_manifest.name', 'source-manifest-20260101T000000Z-99999999') }),
      /closure links a different Stage-1 bundle/)
  })

  it('refuses a closure carrying a stale Stage-1 digest', () => {
    refuses(
      closed({ closure: d =>
        withPath(d, 'source_manifest.digest_file_digest', 'f'.repeat(64)) }),
      /closure links a different Stage-1 bundle/)
  })

  it('refuses a closure that links no Stage-1 bundle at all', () => {
    refuses(closed({ closure: d => without(d, 'source_manifest') }),
            /closure links no Stage-1 bundle/)
  })

  it('refuses a closure describing a DIFFERENT copy', () => {
    refuses(closed({ closure: d => withPath(d, 'copy.stamp', '20260101T000000Z') }),
            /closure describes a different copy/)
  })

  it('refuses a closure describing different CONTENT', () => {
    refuses(
      closed({ closure: d => withPath(d, 'content.target_contract_digest', 'a'.repeat(64)) }),
      /closure describes different content/)
  })

  it('refuses a closure and restoration that disagree about the OPERATIONAL BINDING', () => {
    refuses(
      closed({ closure: d =>
        withPath(d, 'operational_adapter_binding_digest', 'a'.repeat(64)) }),
      /disagree about the operational binding/)
  })

  it('refuses a closure whose restoration link points at ANOTHER restoration', () => {
    refuses(
      closed({ closure: d =>
        withPath(d, 'copy_restoration.name', 'copy-restoration-20260101T000000Z-99999999') }),
      /links a different copy restoration/)
  })

  // --- the cluster the chain was taken from ---

  it('refuses a Stage-1 bundle taken from ANOTHER cluster', () => {
    // The database name agrees, which is exactly the trap: a cluster can be
    // dropped and rebuilt behind the same endpoint, and the identically named
    // role on the new one was never granted this authority.
    refuses(closed(), /names a different source cluster/,
            { ...ENDPOINT, systemIdentifier: SYS_TGT })
  })

  // --- and the record of the destruction names every authorizing bundle ---

  it('a copy-closed teardown record retains ALL SIX authorizing links', async () => {
    const options = closed()
    // THE CONTAINER PATH IS UNDER THIS TEST'S OWN PRIVATE ROOT, never the
    // production credential root: this test runs the real `--teardown`.
    const secretRoot = realpathSync(mkdtempSync(join(tmpdir(), 'k7b723-chain-secrets-')))
    // REGISTERED BEFORE IT IS USED, so a failing assertion cannot leak it.
    secretRoots.push(secretRoot)
    execFileSync('/bin/chmod', ['700', secretRoot])
    const createDir = publishIn(root, 'export-authority-create', 'export-authority.json', {
      record: 'export-authority-create', complete: true, outcome: 'CREATED_AND_PROVED',
      run: { id: RUN, stamp: STAMP },
      endpoint: { host: '127.0.0.1', port: '5432', database: 'ai_capital' },
      source: { system_identifier: SYS_SRC },
      container: {
        path: join(secretRoot, `s4f-k7-export-${RUN}`),
        device_inode: '16777220:1234', uid: 501, mode: '700',
      },
      credentials: [
        { name: 'export-driver.url', device_inode: '16777220:1', uid: 501, mode: '600', links: 1 },
        { name: 'export.pgpass', device_inode: '16777220:2', uid: 501, mode: '600', links: 1 },
      ],
    })
    const r = await runAuthorityCli([
      '--teardown', `--create-bundle=${createDir}`,
      '--disposition=copy-closed', `--evidence-root=${root}`,
      '--admin-passfile=/Users/thanapold/.pgpass-admin', '--psql=/usr/bin/psql',
      '--host=127.0.0.1', '--port=5432', '--database=ai_capital', '--admin-user=thanapold',
      '--run-id=ccddeeff', '--stamp=20260930T120000Z',
      ...Object.entries(options).map(([k, v]) => `${k}=${v}`),
    ], {
      policy: { secretRoot, fs: REAL_AUTHORITY_FS, prove: REAL_PROVE_OPS },
      openAdminPassfile: () => ({ fd: 3, identity: {} as never, close: () => undefined }),
      batch: async () => ({ code: 0, ok: true }),
      proveRole: async () => ROLE_FACTS,
      preflight: () => undefined,
    })
    // The container is not real here, so the teardown is incomplete - which is
    // the record that used to name only a closure and nothing else.
    expect(r.exitCode).toBe(3)
    const dir = join(root, 'export-authority-teardown-20260930T120000Z-ccddeeff')
    expect(verifyPublishedEvidence(dir))
      .toContain('export-authority-teardown.json')
    const doc = JSON.parse(readFileSync(
      join(dir, 'export-authority-teardown.json'), 'utf-8')) as {
        authorized_by: {
          disposition: string
          links: { name: string; digest_file_digest: string }[]
          copy_closure: { name: string; digest_file_digest: string } | null
        }
      }
    const expected = authorizeTeardown('copy-closed', options, ENDPOINT)
    expect(doc.authorized_by.disposition).toBe('copy-closed')
    expect(doc.authorized_by.links).toEqual(expected.links.map(l => ({ ...l })))
    // THE CLOSURE, THE RESTORATION AND THE FOUR CHAIN BUNDLES.
    expect(doc.authorized_by.links.map(l => l.name.replace(/-\d{8}T.*$/, ''))).toEqual([
      'copy-closure', 'copy-restoration', 'copy-lifecycle',
      'release-gate', 'verification', 'source-manifest',
    ])
    for (const l of doc.authorized_by.links) {
      expect(l.digest_file_digest).toMatch(/^[0-9a-f]{64}$/)
      expect(l.name).not.toContain('/')
    }
    // AND THE CONVENIENCE FIELD IS ONE OF THEM, NOT A SUBSTITUTE FOR THEM.
    expect(doc.authorized_by.links).toContainEqual(doc.authorized_by.copy_closure)
    expect(JSON.stringify(doc)).not.toContain(root)
  })

  // --- and the two consumers share ONE verifier, not two copies of it ---

  it('both consumers call the SAME two verifiers, and neither re-implements them', () => {
    const ops = strip(readFileSync(
      new URL('../bin/pg-copy-ops.ts', import.meta.url), 'utf-8'))
    const auth = strip(readFileSync(
      new URL('../bin/pg-copy-export-authority.ts', import.meta.url), 'utf-8'))
    for (const fn of ['assertRestorationMatchesChain', 'assertClosureMatchesChain']) {
      // Declared exactly once, in ops, exported, and never re-implemented in
      // the authority - which calls both.
      expect(ops.split(`export function ${fn}`)).toHaveLength(2)
      expect(auth).toContain(`${fn}(`)
      expect(auth).not.toContain(`function ${fn}`)
    }
    // `--close-copy` CONSUMES a restoration, so it calls the restoration
    // verifier too: declaration plus that call site.
    expect(ops.split('assertRestorationMatchesChain(').length).toBeGreaterThanOrEqual(3)
    // It PRODUCES the closure rather than consuming one, so the closure
    // verifier has exactly one consumer - the authority - and that is why the
    // authority is the only place it is called from.
    expect(ops.split('assertClosureMatchesChain(')).toHaveLength(2)
    // AND THE COMPARISON ITSELF LIVES IN ONE PLACE: the authority holds no
    // copy of the reasons those verifiers raise.
    for (const reason of [
      'records no copy chain', 'omits a chain link',
      'belongs to a different copy', 'describes different content',
    ]) {
      expect(auth, reason).not.toContain(reason)
    }
  })
})
