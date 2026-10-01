// THE COPY LIFECYCLE — the parts that need no server.
//
// What is proved here is everything that is a property of the ORDER and of the
// decisions: that the release gate refuses on every reviewed ground, that the
// authorization it issues cannot be fabricated, that the fence is released by
// exactly one statement and only with that authorization in hand, that the
// release is proved before a single producer is restored, that restoration
// stops at its first failure and says where, that a released fence is never
// described as held or recoverable, and that the two evidence bundles are
// separate, immutable and preserve their exact publication outcomes.
//
// What CANNOT be proved here is the lock lifetime itself. That needs two live
// clusters and is proved in `tests/pgcopy/lifecycle.int.test.ts`.

import { execFileSync } from 'node:child_process'
import {
  mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { inspect } from 'node:util'

import { afterEach, describe, expect, it } from 'vitest'

import {
  REAL_EVIDENCE_OPS, REVIEWED_PREFIXES, TEMPORARY_NAME_PREFIX, evidenceNames,
  publishEvidence, verifyPublishedEvidence, type EvidenceOps,
  type PublishedEvidence,
} from '../src/pg-copy/evidence.js'
import {
  ACTIVITY_CENSUS_SQL, ADAPTER_DEADLINE_MS, AdapterDeadlineExceeded, GATE_DETAIL_FILE,
  LIFECYCLE_DETAIL_FILE, LIFECYCLE_FENCE_SENTENCE, LIFECYCLE_FILE, LIFECYCLE_PREFIX,
  LifecycleEvidenceFailed, LifecycleInterventionRequired, LifecyclePreCommitCleanupRequired,
  BACKEND_START_SQL, COMPLETE_FENCE_LOCKS, PRISTINE_RELEASE_PREFIX,
  QUEUE_SAMPLE_INTERVAL_MS, releasedLockCensusSqlFor,
  RELEASED_LOCK_CENSUS_SQL, RELEASE_GATE_FILE, RELEASE_GATE_PREFIX, RELEASE_SQL, RESTORE_ORDER,
  SESSION_IDENTITY_SQL,
  REVIEWED_BACKEND_TYPES, REVIEWED_PRODUCERS, REVIEWED_QUEUES, ReleaseGateRefused,
  SUPERVISOR_ALIVE_SQL, actionsDocument, assertQuiescent, authorizationDocument,
  gateDetailDocument, isAuthorizationConsumed, isInterventionRequired, isReleaseAuthorization,
  evidenceStateOf, verifiedEvidence,
  outcomeDocument, proveOperationalState, publishLifecycleBundle, releaseFence,
  terminalOutcomeFor,
  restoreProducers,
  rollbackAndProveReleased, runReleaseGate, withDeadline,
  type AdapterContext, type LifecycleFenceState, type ProducerAdapter, type ProducerState,
  type DestinationCensusAdapter, type ProducerCensusRow,
  type QueueAdapter, type QueueSample, type QuiescenceAdapter, type ReleaseAuthorization,
  type ReviewedSession,
} from '../src/pg-copy/lifecycle.js'
import {
  COPY_TABLES, REVIEWED_CONTRACT_DIGEST, canonicalJson, contractDigest, serializeArtifact,
  sha256Hex,
  type Canonical, type ContractArtifact,
} from '../src/pg-copy/schema-contract.js'
import {
  isVerifiedBundle, readPublishedBundle, type PublishedManifest,
} from '../src/pg-copy/stage2.js'
import {
  FENCE_SEQUENCES, FENCE_SEQUENCE_LOCK_MODE, FENCE_TABLES, FENCE_TABLE_LOCK_MODE,
  SEQUENCE_STATE_SQL,
} from '../src/pg-copy/source-fence.js'
import {
  VERIFICATION_FILE, attemptFenceProof,
  type VerificationResult, type VerifierHandoff,
} from '../src/pg-copy/verify.js'

/** One reviewed `backend_start` rendering. pid+start identifies a backend. */
const BACKEND_START = '2026-09-25 09:14:00+00'

const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const strip = (text: string): string => text
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').filter(l => !/^\s*(\/\/|\*)/.test(l)).join('\n')
const read = (rel: string): string => readFileSync(join(PKG_ROOT, rel), 'utf-8')
const LIFECYCLE = strip(read('src/pg-copy/lifecycle.ts'))

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

const ROOTS: string[] = []
function makeRoot(): string {
  const r = mkdtempSync(join(tmpdir(), 'pgcopy-lifecycle-'))
  execFileSync('/bin/chmod', ['700', r])
  ROOTS.push(r)
  return r
}
afterEach(() => {
  for (const r of ROOTS.splice(0)) {
    try { execFileSync('/bin/chmod', ['-R', 'u+rwX', r]) } catch { /* gone */ }
    rmSync(r, { recursive: true, force: true })
  }
})

/** The empty evidence state, for fixtures that predate a publication attempt. */
const NO_EVIDENCE_FIXTURE = {
  attempted: false, publishedPath: null, verified: false,
  // K7-B6.3 B: NON-NULL IF AND ONLY IF `verified`. Carried from the publisher
  // so a post-COMMIT cross-link never has to guess or blank it.
  digestFileDigest: null, note: null,
  publication: null, evidencePhase: null, evidenceReason: null,
  finalPath: null, finalPathState: null, temporaryPath: null, temporaryPathState: null,
} as const

const STAMP = '20260925T091500Z'
const RUN = 'a1b2c3d4'
const SUPERVISOR_PID = '4242'
const PROVING_PID = '99'

const hex = (seed: string): string => sha256Hex(`lifecycle-fixture|${seed}`)

/** The Stage-1 source contract, self-consistent by construction. */
const SOURCE_CONTRACT: ContractArtifact = Object.freeze({
  pgcopy_schema_contract_version: 2,
  digest: contractDigest({ migrations: { recognition: 'CURRENT_V10' } } as Canonical),
  payload: { migrations: { recognition: 'CURRENT_V10' } } as Canonical,
})

const HANDOFF = (over: Partial<VerifierHandoff> = {}): VerifierHandoff => ({
  bundleName: 'source-manifest-20260925T091500Z-a1b2c3d4',
  rootDigest: hex('root'),
  sourceContractDigest: SOURCE_CONTRACT.digest,
  targetContractDigest: REVIEWED_CONTRACT_DIGEST,
  sourceRecognition: 'CURRENT_V10',
  targetRecognition: 'CURRENT_V19',
  tables: COPY_TABLES.map(q => ({ qname: q, digest: hex(q), rows: 3 })),
  sequences: FENCE_SEQUENCES.map((q, n) => ({ qname: q, effectiveNext: String(n + 7) })),
  compatibility: { source_recognition: 'CURRENT_V10', target_recognition: 'CURRENT_V19',
                   target_only_indexes: [], target_only_foreign_keys: [] },
  source: { systemIdentifier: '7689229024919775042', database: 'ai_capital',
            role: 'ai_capital_v3_export' },
  target: { systemIdentifier: '7689229024919775999', database: 'ai_capital_v3',
            role: 'ai_capital_migrator' },
  fence: { supervisorPid: SUPERVISOR_PID, backendStart: BACKEND_START, mechanism: 'S3' },
  ...over,
})

const REVIEWED_TARGET: ContractArtifact = {
  pgcopy_schema_contract_version: 2,
  digest: REVIEWED_CONTRACT_DIGEST,
  payload: { migrations: { recognition: 'CURRENT_V19' } } as Canonical,
}

/** A real published verifier bundle, so the gate can read one back from disk. */
let verifierBundleSeq = 0

/** The verification record this run would have written, as the gate re-reads it. */
const verificationRecord = (
  outcome: string, bundleName: string, over: Record<string, unknown> = {},
): Record<string, unknown> => {
  const h = HANDOFF()
  return {
    complete: true,
    outcome,
    bundle: { name: bundleName },
    source: { system_identifier: h.source.systemIdentifier, database: h.source.database,
              role: h.source.role, contract_digest: h.sourceContractDigest,
              root_digest: h.rootDigest },
    target: { system_identifier: h.target.systemIdentifier, database: h.target.database,
              role: h.target.role, contract_digest: h.targetContractDigest,
              root_digest: h.rootDigest },
    stage2: { root_digest: h.rootDigest, source_contract_digest: h.sourceContractDigest,
              target_contract_digest: h.targetContractDigest },
    tables: h.tables.map(t => ({ qname: t.qname, source_digest: t.digest,
                                 target_digest: t.digest, rows: t.rows })),
    sequences: h.sequences.map(x => ({ qname: x.qname, source_effective_next: x.effectiveNext,
                                       target_effective_next: x.effectiveNext })),
    ...over,
  }
}

function publishVerifierBundle(
  root: string, outcome = 'PASS',
  runId = `bb${(verifierBundleSeq++).toString(16).padStart(6, '0')}`,
  bundleName = 'source-manifest-20260925T091500Z-a1b2c3d4',
  over: Record<string, unknown> = {},
): string {
  return publishEvidence({
    root, prefix: 'verification', stamp: STAMP, runId,
    artifacts: [{ path: 'content.json', bytes: Buffer.from('{"tables":[]}\n', 'utf-8') }],
    manifest: {
      path: VERIFICATION_FILE,
      bytes: Buffer.from(
        `${JSON.stringify(verificationRecord(outcome, bundleName, over))}\n`, 'utf-8'),
    },
  }).finalPath
}

const VERIFICATION = (bundlePath: string, over: Partial<VerificationResult> = {}):
VerificationResult => ({
  outcome: 'PASS',
  sourceRootDigest: HANDOFF().rootDigest,
  targetRootDigest: HANDOFF().rootDigest,
  tables: COPY_TABLES.map(q => ({
    qname: q, rows: 3, bytes: 90, sourceDigest: hex(q), targetDigest: hex(q),
  })),
  sequences: FENCE_SEQUENCES.map((q, n) => ({
    qname: q, sourceEffectiveNext: String(n + 7), targetEffectiveNext: String(n + 7),
  })),
  fenceBefore: { provingPid: PROVING_PID, supervisorPid: SUPERVISOR_PID,
                 relations: 24, ungranted: 0 },
  fenceAfter: { provingPid: PROVING_PID, supervisorPid: SUPERVISOR_PID,
                relations: 24, ungranted: 0 },
  evidence: { finalPath: bundlePath, temporaryPath: '', files: [], digestFileDigest: hex('d') },
  ...over,
} as VerificationResult)

const lockRow = (qname: string, mode: string, pid = SUPERVISOR_PID, granted = true): string[] =>
  [qname === 'advisory' ? 'advisory' : 'relation', qname, mode, String(granted), pid]

const wholeFence = (extra: string[][] = []): string[][] => [
  lockRow('advisory', 'ExclusiveLock'),
  ...FENCE_TABLES.map(q => lockRow(q, FENCE_TABLE_LOCK_MODE)),
  ...FENCE_SEQUENCES.map(q => lockRow(q, FENCE_SEQUENCE_LOCK_MODE)),
  ...extra,
]

/** One sequence-state row, in the shape `parseSequenceState` accepts. */
const seqRows = (last: string, called: string): string[][] =>
  [[last, called, '1', '1', '9223372036854775807', '1', '1', 'false', 'int8',
    'portfolio.trade_log.id']]

interface Stub {
  send: (sql: string) => Promise<{ rows: string[][]; error: 'statement-refused' | null }>
  readonly seen: string[]
}

/** The supervisor: alive, fenced sequences, and a release census. */
function supervisorStub(over: {
  pid?: string | null
  role?: string
  backendStart?: string
  sequences?: (q: string, n: number) => string[][]
  releaseError?: boolean
  releaseThrows?: boolean
  censusRows?: string[][] | null
  censusThrows?: boolean
} = {}): Stub {
  const seen: string[] = []
  return {
    seen,
    send: async (sql: string) => {
      seen.push(sql)
      if (sql === SUPERVISOR_ALIVE_SQL) {
        if (over.pid === null) throw new Error('connection terminated unexpectedly')
        return { rows: [[over.pid ?? SUPERVISOR_PID]], error: null }
      }
      if (sql === SESSION_IDENTITY_SQL) {
        if (over.pid === null) throw new Error('connection terminated unexpectedly')
        return {
          rows: [[over.pid ?? SUPERVISOR_PID, over.role ?? 'ai_capital_owner',
                  over.backendStart ?? BACKEND_START]],
          error: null,
        }
      }
      if (sql === RELEASE_SQL) {
        if (over.releaseThrows === true) throw new Error('connection terminated')
        return { rows: [], error: over.releaseError === true ? 'statement-refused' : null }
      }
      if (sql.startsWith('\nSELECT pg_catalog.count(*)')) {
        if (over.censusThrows === true) throw new Error('gone')
        if (over.censusRows === null) return { rows: [], error: 'statement-refused' }
        return { rows: over.censusRows ?? [['0']], error: null }
      }
      for (let n = 0; n < FENCE_SEQUENCES.length; n += 1) {
        if (sql === SEQUENCE_STATE_SQL(FENCE_SEQUENCES[n])) {
          const make = over.sequences ?? ((): string[][] => seqRows(String(n + 6), 't'))
          return { rows: make(FENCE_SEQUENCES[n], n), error: null }
        }
      }
      return { rows: [], error: null }
    },
  }
}

/** The prover: a pid, a lock census, and the activity census. */
function proverStub(over: {
  pid?: string | null
  role?: string
  proverStart?: string
  observedStart?: string | null
  locks?: string[][]
  activity?: string[][]
  activityError?: boolean
} = {}): Stub {
  const seen: string[] = []
  return {
    seen,
    send: async (sql: string) => {
      seen.push(sql)
      if (sql === ACTIVITY_CENSUS_SQL) {
        if (over.activityError === true) return { rows: [], error: 'statement-refused' }
        return {
          rows: over.activity ?? [[SUPERVISOR_PID, 'ai_capital_owner', 'client backend'],
                                  [PROVING_PID, 'ai_capital_owner', 'client backend']],
          error: null,
        }
      }
      if (sql === 'SELECT pg_catalog.pg_backend_pid()') {
        if (over.pid === null) throw new Error('connection terminated unexpectedly')
        return { rows: [[over.pid ?? PROVING_PID]], error: null }
      }
      if (sql === SESSION_IDENTITY_SQL) {
        if (over.pid === null) throw new Error('connection terminated unexpectedly')
        return {
          rows: [[over.pid ?? PROVING_PID, over.role ?? 'ai_capital_owner',
                  over.proverStart ?? BACKEND_START]],
          error: null,
        }
      }
      if (sql === BACKEND_START_SQL(SUPERVISOR_PID) || sql.startsWith('SELECT a.backend_start')) {
        if (over.observedStart === null) return { rows: [], error: null }
        return { rows: [[over.observedStart ?? BACKEND_START]], error: null }
      }
      return { rows: over.locks ?? wholeFence(), error: null }
    },
  }
}

const stoppedProducers = (): QuiescenceAdapter => ({
  report: async () => REVIEWED_PRODUCERS.map(name => ({ name, stopped: true })),
})

const zeroDepths = (): Record<string, number> =>
  Object.fromEntries(REVIEWED_QUEUES.map(q => [q, 0]))

const emptyQueues = (): QueueAdapter => ({ sample: async () => ({ depths: zeroDepths() }) })

/** The pre-fence producer census this suite's gates are run against. */
const CENSUS = (over: Record<string, unknown> = {}): readonly ProducerCensusRow[] =>
  Object.freeze(REVIEWED_PRODUCERS.map(label => Object.freeze({
    label,
    plistPath: `/Users/x/Library/LaunchAgents/${label}.plist`,
    plistSha256: hex(label),
    plistDeviceInode: '16777234:4242',
    servedCheckout: '/Users/x/checkout',
    installation: 'installed-disabled',
    credentialPath: '/Users/x/.secrets/pipeline.url',
    credentialDeviceInode: '16777234:12345',
    databaseHost: '/tmp/socket',
    databasePort: '5432',
    databaseName: 'ai_capital',
    disposition: 'writes-copy-source',
    ...over,
  })))

/** A fenced census that agrees with the pre-fence one. */
const steadyDestinations = (rows: readonly ProducerCensusRow[] = CENSUS()):
  DestinationCensusAdapter => ({ measure: async () => rows })

/**
 * The pid+role pairs the gate is EXPECTED to derive for itself.
 *
 * Asserted against, never supplied: the gate asks the supervisor and the prover
 * who they are, and this is what those two answer.
 */
const EXPECTED_DERIVED: readonly ReviewedSession[] = Object.freeze([
  { pid: SUPERVISOR_PID, role: 'ai_capital_owner' },
  { pid: PROVING_PID, role: 'ai_capital_owner' },
])

/**
 * A REAL Stage-1 bundle on disk, published and then read back through the
 * reviewed disk verifier - which is the only way to obtain a `PublishedManifest`
 * the gate will accept.
 */
let stage1Seq = 0
function stage1Bundle(
  root: string, contentOver: Record<string, unknown> = {},
): PublishedManifest {
  const runId = `aa${(stage1Seq++).toString(16).padStart(6, '0')}`
  const document = {
    complete: true,
    source_contract: { digest: HANDOFF().sourceContractDigest },
    content: {
      root_digest: HANDOFF().rootDigest,
      tables: COPY_TABLES.map(q => ({ qname: q, digest: hex(q) })),
      ...contentOver,
    },
  }
  const dir = publishEvidence({
    root, prefix: 'source-manifest', stamp: STAMP, runId,
    artifacts: [{ path: 'source-contract.json',
                  bytes: Buffer.from(`${serializeArtifact(SOURCE_CONTRACT)}\n`, 'utf-8') }],
    manifest: { path: 'manifest.json',
                bytes: Buffer.from(`${JSON.stringify(document)}\n`, 'utf-8') },
  }).finalPath
  return readPublishedBundle(dir, f => readFileSync(f, 'utf-8'), sha256Hex)
}

function gateInput(
  root: string, over: Record<string, unknown> = {},
): Parameters<typeof runReleaseGate>[0] {
  const published = (over.published as PublishedManifest | undefined) ?? stage1Bundle(root)
  // Each published bundle gets its own name, and the handoff names the bundle
  // the copy was authorised against - so the fixture follows the real one.
  const named = (over.published as PublishedManifest | undefined)?.bundleName ??
    published.bundleName
  const handoff = { ...((over.handoff as VerifierHandoff | undefined) ?? HANDOFF()),
                    bundleName: named }
  const bundle = (over.bundle as string | undefined) ??
    publishVerifierBundle(root, 'PASS', undefined, named)
  return {
    handoff,
    verification: VERIFICATION(bundle),
    published,
    reviewedTarget: REVIEWED_TARGET,
    supervisor: supervisorStub(),
    prover: proverStub(),
    quiescence: stoppedProducers(),
    queue: emptyQueues(),
    destinations: steadyDestinations(),
    expectedProducers: CENSUS(),
    __sleep: async () => undefined,
    ...over,
  } as Parameters<typeof runReleaseGate>[0]
}

const refusedBy = async (fn: () => Promise<unknown>): Promise<ReleaseGateRefused> => {
  try { await fn() } catch (e) {
    expect(e).toBeInstanceOf(ReleaseGateRefused)
    return e as ReleaseGateRefused
  }
  throw new Error('expected a refusal, and none was raised')
}

// ---------------------------------------------------------------------------

describe('the reviewed producer order', () => {
  it('restores in the REVERSE of the stop order, and says why', () => {
    expect([...RESTORE_ORDER]).toEqual([...REVIEWED_PRODUCERS].reverse())
    // The worker drains; the triggers fill. It comes back first.
    expect(RESTORE_ORDER[0]).toBe('com.thanapol.ai-capital.worker')
    expect(REVIEWED_PRODUCERS[0]).toBe('com.thanapol.ai-capital.daily')
    expect(new Set(RESTORE_ORDER).size).toBe(REVIEWED_PRODUCERS.length)
  })

  it('refuses a quiescence report that is not the reviewed set, all stopped', async () => {
    await expect(assertQuiescent(stoppedProducers())).resolves.toBeDefined()
    const cases: Array<readonly ProducerState[]> = [
      [],
      REVIEWED_PRODUCERS.map(name => ({ name, stopped: false })),
      REVIEWED_PRODUCERS.map((name, n) => ({ name, stopped: n !== 1 })),
      [...REVIEWED_PRODUCERS].reverse().map(name => ({ name, stopped: true })),
      REVIEWED_PRODUCERS.slice(0, 2).map(name => ({ name, stopped: true })),
    ]
    for (const report of cases) {
      await expect(assertQuiescent({ report: async () => report })).rejects
        .toThrow(ReleaseGateRefused)
    }
    // An adapter that throws is not a quiescent system either.
    await expect(assertQuiescent({ report: async () => { throw new Error('launchctl') } }))
      .rejects.toThrow(ReleaseGateRefused)
  })
})

describe('the final release gate', () => {
  it('authorizes a complete, proved, quiescent source', async () => {
    const root = makeRoot()
    const a = await runReleaseGate(gateInput(root))
    expect(isReleaseAuthorization(a)).toBe(true)
    expect(a.rootDigest).toBe(HANDOFF().rootDigest)
    expect(a.fence.ungranted).toBe(0)
    expect(a.sequences.map(s => s.effectiveNext)).toEqual(['7', '8', '9'])
    expect(a.producers.every(p => p.stopped)).toBe(true)
    expect(a.queueSamples.length).toBe(2)
    expect(a.activity.unreviewed).toBe(0)
  })

  it('refuses a supervisor that is dead or is a different backend', async () => {
    const root = makeRoot()
    for (const over of [{ supervisor: supervisorStub({ pid: null }) },
                        { supervisor: supervisorStub({ pid: '5555' }) }]) {
      const e = await refusedBy(() => runReleaseGate(gateInput(root, over)))
      expect(e.refusal).toBe('the supervisor is not the backend that held the fence')
    }
  })

  it('refuses a MISSING table lock, a MISSING sequence lock and a QUEUED writer', async () => {
    const root = makeRoot()
    const cases: Array<[string, string[][]]> = [
      ['table', wholeFence().filter(r => r[1] !== FENCE_TABLES[6])],
      ['sequence', wholeFence().filter(r => r[1] !== FENCE_SEQUENCES[2])],
      ['advisory', wholeFence().filter(r => r[0] !== 'advisory')],
      ['queued', wholeFence([lockRow(FENCE_TABLES[0], 'RowExclusiveLock', '777', false)])],
    ]
    for (const [label, locks] of cases) {
      const e = await refusedBy(
        () => runReleaseGate(gateInput(root, { prover: proverStub({ locks }) })))
      expect(e.refusal, label).toBe('the complete source fence was not proved held')
      // A queued writer is CENSUS evidence; it is never reported as a
      // transport problem, and no pid or lock mode is reproduced.
      expect(surfaces(e), label).not.toContain('777')
      expect(surfaces(e), label).not.toContain('RowExclusiveLock')
    }
  })

  it('refuses a DEAD prover and a MALFORMED census as UNPROVED, not as a lost fence',
    async () => {
      const root = makeRoot()
      for (const over of [{ prover: proverStub({ pid: null }) },
                          { prover: proverStub({ locks: [['relation', 'graph.nodes']] }) },
                          { prover: proverStub({ pid: 'not-a-pid' }) }]) {
        const e = await refusedBy(() => runReleaseGate(gateInput(root, over)))
        expect(e.refusal).toBe('the complete source fence was not proved held')
        // The CAUSE distinguishes them, and never claims a census refused.
        expect(e.at).not.toBe(
          'a required fence lock is missing or a conflicting request is queued')
      }
    })

  it('refuses SEQUENCE DRIFT, naming only the sequence', async () => {
    const root = makeRoot()
    const e = await refusedBy(() => runReleaseGate(gateInput(root, {
      supervisor: supervisorStub({ sequences: (_q, n) => seqRows(String(n + 99), 't') }),
    })))
    expect(e.refusal).toBe('a source sequence has moved since the copy')
    expect(FENCE_SEQUENCES).toContain(e.at)
    // A sequence the supervisor will not report is drift too, not a pass.
    const e2 = await refusedBy(() => runReleaseGate(gateInput(root, {
      supervisor: supervisorStub({ sequences: () => [] }),
    })))
    expect(e2.refusal).toBe('a source sequence has moved since the copy')
  })

  it('refuses a verifier that did not PASS, and one whose bundle does not verify', async () => {
    const root = makeRoot()
    const bundle = publishVerifierBundle(root)
    expect((await refusedBy(() => runReleaseGate(gateInput(root, {
      bundle, verification: VERIFICATION(bundle, { outcome: 'FAIL' as never }),
    })))).refusal).toBe('the independent verification did not pass')

    // A bundle that is not there at all.
    expect((await refusedBy(() => runReleaseGate(gateInput(root, {
      bundle: join(root, 'verification-20260925T091500Z-ffffffff'),
      verification: VERIFICATION(join(root, 'verification-20260925T091500Z-ffffffff')),
    })))).refusal).toBe('the verifier evidence bundle does not verify from disk')

    // A bundle whose BYTES were changed after publication.
    const tampered = publishVerifierBundle(makeRoot(), 'PASS', 'c3d4e5f6')
    execFileSync('/bin/chmod', ['-R', 'u+rwX', tampered])
    writeFileSync(join(tampered, VERIFICATION_FILE), '{"complete":true,"outcome":"PASS"} ')
    expect((await refusedBy(() => runReleaseGate(gateInput(root, {
      bundle: tampered, verification: VERIFICATION(tampered),
    })))).refusal).toBe('the verifier evidence bundle does not verify from disk')

    // A bundle that verifies and says FAIL in its own bytes.
    const failing = publishVerifierBundle(makeRoot(), 'FAIL', 'd4e5f6a7')
    expect((await refusedBy(() => runReleaseGate(gateInput(root, {
      bundle: failing, verification: VERIFICATION(failing),
    })))).refusal).toBe('the verifier evidence bundle does not verify from disk')
  })

  it('refuses when the chain disagrees anywhere', async () => {
    const root = makeRoot()
    const published = stage1Bundle(root)
    const bundle = publishVerifierBundle(root, 'PASS', undefined, published.bundleName)
    // A VerificationResult that disagrees with the record on disk is caught by
    // the bundle binding, which runs first and is the stronger check: the
    // durable evidence, not the in-memory object, is what release rests on.
    for (const over of [
      { verification: VERIFICATION(bundle, { sourceRootDigest: hex('other') }) },
      { verification: VERIFICATION(bundle, { targetRootDigest: hex('other') }) },
    ]) {
      const e = await refusedBy(
        () => runReleaseGate(gateInput(root, { published, bundle, ...over })))
      expect(e.refusal).toBe('the verifier evidence bundle does not verify from disk')
    }

    // WHAT THE RECORDED BUNDLE CANNOT SEE. The verification manifest carries
    // nothing about the Stage-1 DOCUMENT or the reviewed target artifact, so
    // these are the disagreements only the chain comparison can catch.
    const variants: Array<[string, Record<string, unknown>]> = [
      ['a substitute reviewed target',
       { published, bundle, reviewedTarget: { ...REVIEWED_TARGET, digest: hex('substitute') } }],
      ['a different published root', (() => {
        const other = stage1Bundle(root, { root_digest: hex('elsewhere') })
        return { published: other,
                 bundle: publishVerifierBundle(root, 'PASS', undefined, other.bundleName) }
      })()],
      ['a different published table digest', (() => {
        const other = stage1Bundle(root, {
          tables: COPY_TABLES.map((q, n) => ({
            qname: q, digest: n === 4 ? hex('moved') : hex(q) })) })
        return { published: other,
                 bundle: publishVerifierBundle(root, 'PASS', undefined, other.bundleName) }
      })()],
    ]
    for (const [label, over] of variants) {
      const e = await refusedBy(() => runReleaseGate(gateInput(root, over)))
      expect(e.refusal, label).toBe('the verified chain does not agree with the Stage-2 result')
    }

    // AND THE TWO THE RECORD DOES SEE, caught earlier and just as hard.
    for (const over of [
      { handoff: HANDOFF({ tables: COPY_TABLES.map((q, n) => ({
          qname: q, digest: n === 4 ? hex('moved') : hex(q), rows: 3 })) }) },
      { handoff: HANDOFF({ target: { ...HANDOFF().target,
          systemIdentifier: HANDOFF().source.systemIdentifier } }) },
    ]) {
      const e = await refusedBy(
        () => runReleaseGate(gateInput(root, { published, bundle, ...over })))
      expect(e.refusal).toBe('the verifier evidence bundle does not verify from disk')
    }
  })

  it('refuses QUIESCENCE DRIFT measured at the gate, not remembered from earlier', async () => {
    const root = makeRoot()
    // Stopped when the lifecycle started; running by the time the gate asks.
    let calls = 0
    const drifting: QuiescenceAdapter = {
      report: async () => REVIEWED_PRODUCERS.map(name => ({
        name, stopped: calls++ < REVIEWED_PRODUCERS.length,
      })),
    }
    await expect(assertQuiescent(drifting)).resolves.toBeDefined()
    const e = await refusedBy(() => runReleaseGate(gateInput(root, { quiescence: drifting })))
    expect(e.refusal).toBe('a reviewed producer is not stopped')
  })

  it('refuses a source carrying sessions nobody reviewed, and counts rather than lists',
    async () => {
      const root = makeRoot()
      const e = await refusedBy(() => runReleaseGate(gateInput(root, {
        prover: proverStub({ activity: [
          [SUPERVISOR_PID, 'ai_capital_owner', 'client backend'],
          ['8888', 'some_other_role', 'client backend'],
        ] }),
      })))
      expect(e.refusal).toBe('the source carries sessions that are not reviewed')
      expect(e.at).toBe('1 session(s)')
      expect(surfaces(e)).not.toContain('some_other_role')
      expect(surfaces(e)).not.toContain('8888')
      // The census asks for no `query` column at all.
      expect(ACTIVITY_CENSUS_SQL).not.toContain('query')
      // Background workers are the server's own and are not counted against it.
      await expect(runReleaseGate(gateInput(root, {
        prover: proverStub({ activity: [
          [SUPERVISOR_PID, 'ai_capital_owner', 'client backend'],
          [PROVING_PID, 'ai_capital_owner', 'client backend'],
          ['12', '', 'autovacuum launcher'],
        ] }),
      }))).resolves.toBeDefined()
    })

  it('a SECOND connection under a REVIEWED ROLE is still refused', async () => {
    // THE CASE A ROLE LIST COULD NOT SEE. `ai_capital_owner` is exactly the role
    // the lifecycle's own sessions use, so a role-only allowlist authorised any
    // number of additional readers under it - which is the one thing the census
    // exists to catch.
    const root = makeRoot()
    const e = await refusedBy(() => runReleaseGate(gateInput(root, {
      prover: proverStub({ activity: [
        [SUPERVISOR_PID, 'ai_capital_owner', 'client backend'],
        [PROVING_PID, 'ai_capital_owner', 'client backend'],
        ['7777', 'ai_capital_owner', 'client backend'],
      ] }),
    })))
    expect(e.refusal).toBe('the source carries sessions that are not reviewed')
    expect(e.at).toBe('1 session(s)')
  })

  it('a reviewed PID under the WRONG ROLE is refused', async () => {
    const root = makeRoot()
    const e = await refusedBy(() => runReleaseGate(gateInput(root, {
      prover: proverStub({ activity: [
        [SUPERVISOR_PID, 'somebody_else', 'client backend'],
        [PROVING_PID, 'ai_capital_owner', 'client backend'],
      ] }),
    })))
    expect(e.refusal).toBe('the source carries sessions that are not reviewed')
  })

  it('refuses an INCOHERENT derived set, and an unreviewed backend type', async () => {
    const root = makeRoot()
    // THE COHERENCE CHECK NOW GUARDS THE DERIVED SET. It can no longer be fed
    // a bad allowlist - there is nowhere to put one - so what can still go
    // wrong is an OWNED session that answers with somebody else's identity, or
    // with an answer that is not an identity at all.
    const says = (rows: string[][]): { rows(sql: string): Promise<string[][]> } =>
      ({ rows: async () => rows })
    const cases: Array<[string, Record<string, unknown>]> = [
      ['duplicate', { ownedSessions: [says([[SUPERVISOR_PID, 'ai_capital_owner', BACKEND_START]])] }],
      ['conflicting', { ownedSessions: [says([[SUPERVISOR_PID, 'another_role', BACKEND_START]])] }],
      ['bad pid', { ownedSessions: [says([['x', 'ai_capital_owner', BACKEND_START]])] }],
      ['bad role', { ownedSessions: [says([['1', 'Not An Ident', BACKEND_START]])] }],
      ['no start', { ownedSessions: [says([['1', 'ai_capital_owner', '']])] }],
    ]
    for (const [label, over] of cases) {
      const e = await refusedBy(() => runReleaseGate(gateInput(root, over)))
      expect(e.refusal, label).toBe('the source carries sessions that are not reviewed')
    }
    // A backend type nobody reviewed is not waved through as "not a client".
    const e = await refusedBy(() => runReleaseGate(gateInput(root, {
      prover: proverStub({ activity: [
        [SUPERVISOR_PID, 'ai_capital_owner', 'client backend'],
        [PROVING_PID, 'ai_capital_owner', 'client backend'],
        ['13', '', 'some future worker'],
      ] }),
    })))
    expect(e.at).toBe('an unreviewed backend type')
    expect(REVIEWED_BACKEND_TYPES).toContain('autovacuum launcher')
    // A malformed row is refused rather than skipped.
    expect((await refusedBy(() => runReleaseGate(gateInput(root, {
      prover: proverStub({ activity: [['only', 'two']] }),
    })))).at).toBe('a malformed census row')
  })

  it('refuses queues that are not empty, and queues that are not STABLE', async () => {
    const root = makeRoot()
    const e = await refusedBy(() => runReleaseGate(gateInput(root, {
      queue: {
        sample: async () => ({ depths: { ...zeroDepths(), [REVIEWED_QUEUES[0]]: 1 } }),
      } as QueueAdapter,
    })))
    expect(e.refusal).toBe('the queue samples are not empty and stable')
    expect(e.at).toBe(REVIEWED_QUEUES[0])

    // TWO samples, because one cannot tell an empty queue from a queue caught
    // between two jobs. Here one sample is short of a reviewed queue.
    let n = 0
    const unstable: QueueAdapter = {
      sample: async (): Promise<QueueSample> =>
        (n++ === 0 ? { depths: zeroDepths() } : { depths: { [REVIEWED_QUEUES[0]]: 0 } }),
    }
    expect((await refusedBy(() => runReleaseGate(gateInput(root, { queue: unstable })))).refusal)
      .toBe('the queue samples are not empty and stable')
    // And an adapter that throws is not an empty queue.
    expect((await refusedBy(() => runReleaseGate(gateInput(root, {
      queue: { sample: async () => { throw new Error('redis') } } as QueueAdapter,
    })))).refusal).toBe('the queue samples are not empty and stable')
  })

  it('takes TWO queue samples, always, over the REVIEWED SET', async () => {
    const root = makeRoot()
    let taken = 0
    await runReleaseGate(gateInput(root, {
      queue: {
        sample: async () => { taken += 1; return { depths: zeroDepths() } },
      } as QueueAdapter,
    }))
    expect(taken).toBe(2)
  })

  it('REFUSES two EMPTY samples: absence of queues is not absence of work', async () => {
    // `{}` twice satisfied "every depth is zero" the way an empty room
    // satisfies "everyone here is asleep". An adapter that lost its connection,
    // or was pointed at a renamed queue, reported exactly that.
    const root = makeRoot()
    const e = await refusedBy(() => runReleaseGate(gateInput(root, {
      queue: { sample: async () => ({ depths: {} }) } as QueueAdapter,
    })))
    expect(e.refusal).toBe('the queue samples are not empty and stable')
    expect(e.at).toBe('the sampled queue set')

    // A queue MISSING from an otherwise correct sample is refused by name.
    const short = { ...zeroDepths() }
    delete short[REVIEWED_QUEUES[1]]
    expect((await refusedBy(() => runReleaseGate(gateInput(root, {
      queue: { sample: async () => ({ depths: short }) } as QueueAdapter,
    })))).at).toBe('the sampled queue set')

    // An EXTRA queue is refused too: the set is exact in both directions.
    expect((await refusedBy(() => runReleaseGate(gateInput(root, {
      queue: {
        sample: async () => ({ depths: { ...zeroDepths(), surprise: 0 } }),
      } as QueueAdapter,
    })))).at).toBe('the sampled queue set')
  })

  it('an adapter that NEVER ANSWERS is bounded, and the gate refuses', async () => {
    // The worst outcome available is a lifecycle that waits forever WITH THE
    // FENCE HELD: the source stays frozen, the producers stay down, and nothing
    // ever says why.
    const root = makeRoot()
    const never = <T>(): Promise<T> => new Promise<T>(() => { /* never settles */ })

    const q = await refusedBy(() => runReleaseGate(gateInput(root, {
      deadlineMs: 25,
      queue: { sample: async () => await never<QueueSample>() } as QueueAdapter,
    })))
    expect(q.refusal).toBe('the queue samples are not empty and stable')
    expect(q.at).toBe('the deadline')

    const p = await refusedBy(() => runReleaseGate(gateInput(root, {
      deadlineMs: 25,
      quiescence: {
        report: async () => await never<readonly ProducerState[]>(),
      } as QuiescenceAdapter,
    })))
    expect(p.refusal).toBe('a reviewed producer is not stopped')
    expect(p.at).toBe('the deadline')
  })

  it('never sends a transaction-control statement to the borrowed sessions', async () => {
    const root = makeRoot()
    const supervisor = supervisorStub()
    const prover = proverStub()
    await runReleaseGate(gateInput(root, { supervisor, prover }))
    for (const sql of [...supervisor.seen, ...prover.seen]) {
      expect(sql).not.toMatch(/^\s*(COMMIT|ROLLBACK|BEGIN|END|ABORT)\b/i)
      expect(sql).not.toContain('advisory_unlock')
    }
  })
})

describe('the verifier bundle must describe THIS run', () => {
  it('refuses a valid PASS bundle from a different run', async () => {
    const root = makeRoot()
    const published = stage1Bundle(root)
    // A bundle that verifies, says PASS, is complete - and is about some other
    // copy. Every field below is one this run can contradict.
    const cases: Array<[string, Record<string, unknown>]> = [
      ['a different Stage-1 bundle',
       { bundle: { name: 'source-manifest-20260101T000000Z-ffffffff' } }],
      ['a different source cluster',
       { source: { system_identifier: '1', database: 'ai_capital',
                   role: 'ai_capital_v3_export',
                   contract_digest: HANDOFF().sourceContractDigest,
                   root_digest: HANDOFF().rootDigest } }],
      ['a different contract digest',
       { stage2: { root_digest: HANDOFF().rootDigest,
                   source_contract_digest: hex('elsewhere'),
                   target_contract_digest: REVIEWED_CONTRACT_DIGEST } }],
      ['a different root', { target: { system_identifier: '7689229024919775999',
                                       database: 'ai_capital_v3', role: 'ai_capital_migrator',
                                       contract_digest: REVIEWED_CONTRACT_DIGEST,
                                       root_digest: hex('other-root') } }],
      ['a short table set', { tables: [] }],
      ['a moved table digest',
       { tables: COPY_TABLES.map((q, n) => ({
           qname: q, source_digest: n === 3 ? hex('moved') : hex(q),
           target_digest: hex(q), rows: 3 })) }],
      ['a moved sequence',
       { sequences: FENCE_SEQUENCES.map(q => ({
           qname: q, source_effective_next: '999', target_effective_next: '999' })) }],
    ]
    for (const [label, over] of cases) {
      const b = publishVerifierBundle(root, 'PASS', undefined, published.bundleName, over)
      const e = await refusedBy(() => runReleaseGate(gateInput(root, {
        published, bundle: b, verification: VERIFICATION(b),
      })))
      expect(e.refusal, label).toBe('the verifier evidence bundle does not verify from disk')
      expect(e.at, label).not.toBeNull()
    }
  })

  it('accepts only a bundle whose every recorded field is this run', async () => {
    const root = makeRoot()
    const published = stage1Bundle(root)
    const b = publishVerifierBundle(root, 'PASS', undefined, published.bundleName)
    await expect(runReleaseGate(gateInput(root, {
      published, bundle: b, verification: VERIFICATION(b),
    }))).resolves.toBeDefined()
  })
})

describe('the Stage-1 bundle must have come through the disk verifier', () => {
  it('refuses every forgery, however it was built', async () => {
    const root = makeRoot()
    const genuine = stage1Bundle(root)
    const forgeries: unknown[] = [
      { ...genuine },
      JSON.parse(JSON.stringify(genuine)),
      structuredClone(genuine),
      { bundleName: genuine.bundleName, digestFileDigest: genuine.digestFileDigest,
        document: genuine.document, contract: genuine.contract },
    ]
    const reflected: Record<string | symbol, unknown> = {}
    for (const k of Reflect.ownKeys(genuine)) {
      const d = Object.getOwnPropertyDescriptor(genuine, k)
      if (d !== undefined) Object.defineProperty(reflected, k, d)
    }
    forgeries.push(reflected)

    for (const f of forgeries) {
      const e = await refusedBy(() => runReleaseGate(gateInput(root, {
        published: f as PublishedManifest,
      })))
      expect(e.refusal).toBe('the verified chain does not agree with the Stage-2 result')
      expect(e.at).toBe('the Stage-1 bundle provenance')
    }
    // And the genuine one is accepted.
    await expect(runReleaseGate(gateInput(root, { published: genuine })))
      .resolves.toBeDefined()
  })
})

describe('the release authority is bound and single-use', () => {
  it('refuses a genuine authorization offered with ANOTHER supervisor, sending nothing',
    async () => {
      const root = makeRoot()
      const mine = supervisorStub()
      const a = await runReleaseGate(gateInput(root, { supervisor: mine }))
      const other = supervisorStub()
      await expect(releaseFence(other, a)).rejects.toThrow(ReleaseGateRefused)
      // NOT ONE STATEMENT reached the wrong supervisor.
      expect(other.seen).toEqual([])
      // AND THE AUTHORIZATION IS NOT SPENT: a misdirected attempt must not cost
      // the holder its permission.
      expect(isAuthorizationConsumed(a)).toBe(false)
      await expect(releaseFence(mine, a)).resolves.toBeDefined()
    })

  it('refuses a SAME-PID lookalike supervisor', async () => {
    const root = makeRoot()
    const mine = supervisorStub()
    const a = await runReleaseGate(gateInput(root, { supervisor: mine }))
    // A different object reporting the same backend pid. Identity, not equality.
    const lookalike = supervisorStub()
    expect((await lookalike.send(SUPERVISOR_ALIVE_SQL)).rows[0][0]).toBe(SUPERVISOR_PID)
    await expect(releaseFence(lookalike, a)).rejects.toThrow(/another supervisor/)
  })

  it('refuses a SECOND use, and a concurrent double use', async () => {
    const root = makeRoot()
    const s1 = supervisorStub()
    const a = await runReleaseGate(gateInput(root, { supervisor: s1 }))
    expect(await releaseFence(s1, a)).toEqual({ state: 'released', remainingLocks: 0 })
    expect(isAuthorizationConsumed(a)).toBe(true)
    await expect(releaseFence(s1, a)).rejects.toThrow(/already been used/)

    // CONCURRENT. Both start before either finishes; exactly one may proceed.
    const s2 = supervisorStub()
    const b = await runReleaseGate(gateInput(root, { supervisor: s2 }))
    const results = await Promise.allSettled([releaseFence(s2, b), releaseFence(s2, b)])
    expect(results.filter(r => r.status === 'fulfilled').length).toBe(1)
    expect(results.filter(r => r.status === 'rejected').length).toBe(1)
    expect(s2.seen.filter(x => x === RELEASE_SQL).length).toBe(1)
  })

  it('stays consumed after a transport failure, and after a refusal', async () => {
    const root = makeRoot()
    // The ROLLBACK is ATTEMPTED and the transport raises. Nothing is known
    // about whether PostgreSQL applied it - and the authorization is spent
    // regardless, because a retry would be a second attempt nobody authorised
    // on a transaction nobody can ask about.
    const dying = supervisorStub({ releaseThrows: true })
    const a = await runReleaseGate(gateInput(root, { supervisor: dying }))
    expect(await releaseFence(dying, a))
      .toEqual({ state: 'release-unknown', remainingLocks: null })
    expect(isAuthorizationConsumed(a)).toBe(true)
    await expect(releaseFence(dying, a)).rejects.toThrow(/already been used/)

    // And a supervisor that moved to a different backend between the gate and
    // the release is refused - after consumption, because the ROLLBACK window
    // has already been entered.
    const moved = supervisorStub()
    const b = await runReleaseGate(gateInput(root, { supervisor: moved }))
    const movedAgain = supervisorStub({ pid: '5555' })
    ;(moved as unknown as { send: typeof movedAgain.send }).send = movedAgain.send
    await expect(releaseFence(moved, b)).rejects.toThrow(/not the backend the gate proved/)
    expect(isAuthorizationConsumed(b)).toBe(true)
  })
})

describe('the authorization cannot be fabricated', () => {
  it('rejects every look-alike, however it was built', async () => {
    const root = makeRoot()
    const genuine = await runReleaseGate(gateInput(root))
    expect(isReleaseAuthorization(genuine)).toBe(true)

    const forgeries: unknown[] = [
      { ...genuine },
      JSON.parse(JSON.stringify(genuine)),
      structuredClone(genuine),
      Object.create(Object.getPrototypeOf(genuine) as object),
      null, undefined, true, 'authorized', 42, {},
    ]
    // Every own key, descriptor for descriptor, onto an object of our own.
    const reflected: Record<string | symbol, unknown> = {}
    for (const k of Reflect.ownKeys(genuine)) {
      const d = Object.getOwnPropertyDescriptor(genuine, k)
      if (d !== undefined) Object.defineProperty(reflected, k, d)
    }
    forgeries.push(reflected)

    for (const f of forgeries) {
      expect(isReleaseAuthorization(f), inspect(f).slice(0, 60)).toBe(false)
      await expect(releaseFence(supervisorStub(), f as ReleaseAuthorization))
        .rejects.toThrow(ReleaseGateRefused)
    }
    // There is no runtime brand to copy in the first place.
    expect(Object.getOwnPropertySymbols(genuine)).toEqual([])
    expect(Object.isFrozen(genuine)).toBe(true)
  })

  it('a REFUSED gate mints nothing', async () => {
    const root = makeRoot()
    await refusedBy(() => runReleaseGate(gateInput(root, {
      prover: proverStub({ locks: wholeFence().filter(r => r[0] !== 'advisory') }),
    })))
    // Nothing was registered, so nothing can release. Proved by the only
    // observable the registry has: a release attempt.
    const fake = { rootDigest: HANDOFF().rootDigest } as unknown as ReleaseAuthorization
    await expect(releaseFence(supervisorStub(), fake))
      .rejects.toThrow(/was not issued by this gate/)
  })
})

describe('the release is one statement, and it is proved', () => {
  it('is exactly the supervisor ROLLBACK, and never a substitute', async () => {
    expect(RELEASE_SQL).toBe('ROLLBACK')
    const root = makeRoot()
    const supervisor = supervisorStub()
    const a = await runReleaseGate(gateInput(root, { supervisor }))
    const r = await releaseFence(supervisor, a)
    expect(r.state).toBe('released')
    expect(r.remainingLocks).toBe(0)
    expect(supervisor.seen.filter(x => x === RELEASE_SQL).length).toBe(1)
    // NO COMMIT, NO UNLOCK, NO TERMINATION.
    for (const sql of supervisor.seen) {
      expect(sql).not.toMatch(/^\s*COMMIT\b/i)
      expect(sql).not.toContain('advisory_unlock')
      expect(sql).not.toContain('pg_terminate_backend')
      expect(sql).not.toContain('pg_cancel_backend')
    }
    // The module contains no substitute anywhere.
    expect(LIFECYCLE).not.toContain('advisory_unlock')
    expect(LIFECYCLE).not.toContain('pg_terminate_backend')
    expect(LIFECYCLE).not.toMatch(/send\('COMMIT'\)/)
    // TWO call sites, and only two: the authorised release, and the pre-commit
    // cleanup that ends a fence no copy ever committed behind.
    expect(LIFECYCLE.match(/send\(RELEASE_SQL\)/g)?.length).toBe(2)
  })

  it('a ROLLBACK that was REFUSED leaves the fence held, and is not a release', async () => {
    const root = makeRoot()
    const supervisor = supervisorStub({ releaseError: true })
    const a = await runReleaseGate(gateInput(root, { supervisor }))
    await expect(releaseFence(supervisor, a)).rejects.toThrow(ReleaseGateRefused)
    // AND NO PROOF WAS ATTEMPTED: there is nothing to prove, and asking would
    // invite a "released-unproved" answer about a fence that is still held.
    expect(supervisor.seen.filter(s => s.includes('count(*)'))).toEqual([])
  })

  it('a release whose PROOF does not come back is RELEASED-UNPROVED, never unproved',
    async () => {
      const root = makeRoot()
      for (const over of [{ censusRows: null }, { censusThrows: true },
                          { censusRows: [['3']] }, { censusRows: [['not a number']] }]) {
        // A FRESH authorization each time: one is single-use, and it is bound
        // to the supervisor the gate proved it against.
        const supervisor = supervisorStub(over)
        const a = await runReleaseGate(gateInput(root, { supervisor }))
        const r = await releaseFence(supervisor, a)
        expect(r.state, JSON.stringify(over)).toBe('released-unproved')
      }
      // Remaining locks are reported when they were actually counted.
      const counted = supervisorStub({ censusRows: [['3']] })
      expect((await releaseFence(counted,
        await runReleaseGate(gateInput(root, { supervisor: counted })))).remainingLocks).toBe(3)
      const silent = supervisorStub({ censusThrows: true })
      expect((await releaseFence(silent,
        await runReleaseGate(gateInput(root, { supervisor: silent })))).remainingLocks).toBeNull()
    })

  it('the census asks only about the reviewed relations and the reviewed advisory key', () => {
    expect(RELEASED_LOCK_CENSUS_SQL).toContain('pg_catalog.pg_backend_pid()')
    expect(RELEASED_LOCK_CENSUS_SQL).toContain("l.locktype = 'relation'")
    expect(RELEASED_LOCK_CENSUS_SQL).toContain("l.locktype = 'advisory'")
    expect(RELEASED_LOCK_CENSUS_SQL).toContain('count(*)')
  })
})

describe('a pre-commit failure never leaves a fence behind', () => {
  it('rolls back ONCE and proves the reviewed locks are gone', async () => {
    const s = supervisorStub()
    const r = await rollbackAndProveReleased(s)
    expect(r).toEqual({ state: 'released', remainingLocks: 0 })
    expect(s.seen.filter(x => x === RELEASE_SQL).length).toBe(1)
  })

  it('reports NOT-RELEASED when the rollback itself is refused', async () => {
    expect(await rollbackAndProveReleased(supervisorStub({ releaseError: true })))
      .toBe('not-released')
  })

  it('never retries an UNKNOWN outcome, and never calls it released', async () => {
    const s = supervisorStub({ releaseThrows: true })
    expect(await rollbackAndProveReleased(s))
      .toEqual({ state: 'release-unknown', remainingLocks: null })
    // ONE attempt. A second ROLLBACK on a transaction that already ended is
    // meaningless, and on one that did not it is an attempt nobody decided on.
    expect(s.seen.filter(x => x === RELEASE_SQL).length).toBe(1)
  })

  it('reports RELEASED-UNPROVED when the census cannot answer or is not zero', async () => {
    for (const over of [{ censusRows: null }, { censusThrows: true },
                        { censusRows: [['7']] }, { censusRows: [['nope']] }]) {
      const r = await rollbackAndProveReleased(supervisorStub(over))
      expect(r, JSON.stringify(over)).toEqual(
        expect.objectContaining({ state: 'released-unproved' }))
    }
    expect(await rollbackAndProveReleased(supervisorStub({ censusRows: [['7']] })))
      .toEqual({ state: 'released-unproved', remainingLocks: 7 })
  })

  it('the cleanup state says the target did NOT commit, and forbids a plain retry', () => {
    const e = new LifecyclePreCommitCleanupRequired(
      { phase: 'L3-copy', reason: 'the transactional copy did not complete', at: null },
      'released-unproved', supervisorStub() as never)
    expect(e.committed).toBe(false)
    expect(e.message).toContain('was NOT committed')
    expect(e.message).toContain('DO NOT simply retry')
    // NOTHING is restored: this lifecycle did not stop the producers.
    expect(e.message).toContain('No producer was restored')
    expect(e.message).not.toContain('has been committed')
    for (const marker of ['password', 'postgres://', 'passfile']) {
      expect(surfaces(e).toLowerCase()).not.toContain(marker)
    }
  })
})

describe('the adapter deadline', () => {
  it('returns the value when the adapter answers in time', async () => {
    expect(await withDeadline('queue', 1_000, async () => 7)).toBe(7)
  })

  it('gives the adapter a signal, and aborts it on overrun', async () => {
    let seen: AdapterContext | null = null
    let aborted = false
    await expect(withDeadline('producer', 25, async (ctx: AdapterContext) => {
      seen = ctx
      ctx.signal.addEventListener('abort', () => { aborted = true })
      return await new Promise<never>(() => { /* never settles */ })
    })).rejects.toThrow(AdapterDeadlineExceeded)
    expect(seen).not.toBeNull()
    expect(aborted).toBe(true)
  })

  it('clears its timer, so a prompt refusal does not become a process that will not exit',
    async () => {
      // An un-cleared timer keeps the event loop alive - a different way of
      // hanging, reached by the code that exists to stop hanging.
      const before = process.getActiveResourcesInfo?.().filter(r => r === 'Timeout').length ?? 0
      for (let n = 0; n < 5; n += 1) await withDeadline('queue', 60_000, async () => n)
      const after = process.getActiveResourcesInfo?.().filter(r => r === 'Timeout').length ?? 0
      expect(after).toBeLessThanOrEqual(before)
    })

  it('states a reviewed default', () => {
    expect(ADAPTER_DEADLINE_MS).toBe(30_000)
  })

  it('bounds restoration too', async () => {
    const stuck: ProducerAdapter = {
      restore: async () => await new Promise<never>(() => { /* never settles */ }),
      confirm: async () => true,
    }
    const r = await restoreProducers(stuck, 25)
    expect(r.failedAt).toBe(RESTORE_ORDER[0])
    expect(r.restored).toEqual([])
  })
})

describe('an unknown rollback outcome is not a release', () => {
  /** A transport that applies the statement and then loses the response. */
  function losesTheResponse(): Stub & { applied: string[] } {
    const inner = supervisorStub()
    const applied: string[] = []
    return {
      seen: inner.seen,
      applied,
      send: async (sql: string) => {
        if (sql === RELEASE_SQL) {
          // The server DID receive and apply it; the reply never came back.
          applied.push(sql)
          inner.seen.push(sql)
          throw new Error('connection reset by peer')
        }
        return await inner.send(sql)
      },
    } as Stub & { applied: string[] }
  }

  it('a transport that throws BEFORE the server sees it is release-unknown', async () => {
    const root = makeRoot()
    const dying = supervisorStub({ releaseThrows: true })
    const a = await runReleaseGate(gateInput(root, { supervisor: dying }))
    expect(await releaseFence(dying, a))
      .toEqual({ state: 'release-unknown', remainingLocks: null })
    // NO CENSUS WAS ATTEMPTED. There is nothing it could settle, and asking
    // would invite an answer about a transaction nobody can place.
    expect(dying.seen.filter(x => x.includes('count(*)'))).toEqual([])
  })

  it('a transport that APPLIES it and loses the response is ALSO release-unknown', async () => {
    // From the caller's side these two are indistinguishable, and that is the
    // point: the same absence of an acknowledgement means the same absence of
    // knowledge, whichever way it actually went on the server.
    const root = makeRoot()
    const lossy = losesTheResponse()
    const a = await runReleaseGate(gateInput(root, { supervisor: lossy }))
    expect(await releaseFence(lossy, a))
      .toEqual({ state: 'release-unknown', remainingLocks: null })
    expect(lossy.applied).toEqual([RELEASE_SQL])
  })

  it('CONSUMES the authorization, and refuses a second attempt', async () => {
    const root = makeRoot()
    for (const supervisor of [supervisorStub({ releaseThrows: true }), losesTheResponse()]) {
      const a = await runReleaseGate(gateInput(root, { supervisor }))
      expect((await releaseFence(supervisor, a)).state).toBe('release-unknown')
      expect(isAuthorizationConsumed(a)).toBe(true)
      await expect(releaseFence(supervisor, a)).rejects.toThrow(/already been used/)
      // AND THE ROLLBACK WAS NOT RETRIED.
      expect(supervisor.seen.filter(x => x === RELEASE_SQL).length).toBe(1)
    }
  })

  it('RELEASED-UNPROVED is reachable ONLY after an acknowledged ROLLBACK', async () => {
    const root = makeRoot()
    // ACKNOWLEDGED, then a census that cannot confirm: the transaction ended,
    // so the lease IS gone and the message may say so.
    for (const over of [{ censusRows: null }, { censusThrows: true },
                        { censusRows: [['3']] }, { censusRows: [['not a number']] }]) {
      const supervisor = supervisorStub(over)
      const a = await runReleaseGate(gateInput(root, { supervisor }))
      expect((await releaseFence(supervisor, a)).state, JSON.stringify(over))
        .toBe('released-unproved')
    }
    // NOT ACKNOWLEDGED: never released-unproved, however the census behaves.
    for (const over of [{ releaseThrows: true, censusRows: null },
                        { releaseThrows: true, censusRows: [['0']] },
                        { releaseThrows: true, censusThrows: true }]) {
      const supervisor = supervisorStub(over)
      const a = await runReleaseGate(gateInput(root, { supervisor }))
      expect((await releaseFence(supervisor, a)).state, JSON.stringify(over))
        .toBe('release-unknown')
    }
    // ACKNOWLEDGED AND REFUSED: the transaction did not end at all.
    const refusing = supervisorStub({ releaseError: true })
    const b = await runReleaseGate(gateInput(root, { supervisor: refusing }))
    await expect(releaseFence(refusing, b)).rejects.toThrow(/the rollback/)
  })

  it('the PRE-COMMIT cleanup makes the same distinction', async () => {
    // A transport that raises, and one that answers and refuses, and one that
    // answers and succeeds - three different things, three different names.
    expect(await rollbackAndProveReleased(supervisorStub({ releaseThrows: true })))
      .toEqual({ state: 'release-unknown', remainingLocks: null })
    expect(await rollbackAndProveReleased(supervisorStub({ releaseError: true })))
      .toBe('not-released')
    expect(await rollbackAndProveReleased(supervisorStub()))
      .toEqual({ state: 'released', remainingLocks: 0 })
    expect(await rollbackAndProveReleased(supervisorStub({ censusRows: [['2']] })))
      .toEqual({ state: 'released-unproved', remainingLocks: 2 })
    // AND NO RETRY, on any of them.
    const dying = supervisorStub({ releaseThrows: true })
    await rollbackAndProveReleased(dying)
    expect(dying.seen.filter(x => x === RELEASE_SQL).length).toBe(1)
  })

  it('the cleanup state PRESERVES an unknown outcome, and never renames it', () => {
    const e = new LifecyclePreCommitCleanupRequired(
      { phase: 'L3-copy', reason: 'the transactional copy did not complete', at: null },
      'release-unknown', supervisorStub() as never)
    expect(e.fence).toBe('release-unknown')
    expect(e.committed).toBe(false)
    expect(e.message).toContain('OUTCOME IS NOT KNOWN')
    expect(e.message).not.toMatch(/has been released/i)
    expect(e.message).toContain('DO NOT simply retry')
  })

  it('the recorded outcome names the exact state, and is not folded', () => {
    for (const state of ['released', 'released-unproved', 'release-unknown'] as const) {
      const doc = JSON.parse(canonicalJson(outcomeDocument(
        HANDOFF(), state, { state, remainingLocks: null }, null, null,
        { phase: state === 'release-unknown' ? 'L8-release' : 'L9-release-proof',
          reason: state === 'release-unknown'
            ? 'the fence release was not completed'
            : 'the fence release could not be proved',
          at: null },
        RUN, STAMP, 'STOPPED'))) as Record<string, never>
      expect((doc.fence as Record<string, unknown>).state).toBe(state)
      expect((doc.release as Record<string, unknown>).state).toBe(state)
      expect((doc.fence as Record<string, unknown>).sentence)
        .toBe(LIFECYCLE_FENCE_SENTENCE[state])
      // L8 for an unknown outcome, L9 for a proof that failed. The record says
      // which, so "release outcome unknown" and "released but unproved" are
      // never the same finding.
      expect((doc.failure as Record<string, unknown>).phase)
        .toBe(state === 'release-unknown' ? 'L8-release' : 'L9-release-proof')
    }
    const actions = JSON.parse(canonicalJson(
      actionsDocument({ state: 'release-unknown', remainingLocks: null }, null)))
    expect(actions.release_state).toBe('release-unknown')
    expect(actions.restored).toEqual([])
    expect(actions.not_restored).toEqual([...RESTORE_ORDER])
  })

  it('no comment or message claims a rejected send proves anything', () => {
    // A `send` that raised establishes nothing about the server, and an earlier
    // version said "SUBMITTED" in exactly the two places it mattered.
    // Read UNSTRIPPED: the claim lived in the commentary, which is exactly
    // where a reader looking for the reason would find it.
    const raw = read('src/pg-copy/lifecycle.ts')
    expect(raw).not.toContain('SUBMITTED, OUTCOME UNKNOWN')
    expect(raw.match(/ATTEMPTED, OUTCOME UNKNOWN/g)?.length).toBe(2)
    expect(raw).not.toMatch(/the lease is gone[^.]*transport/i)
  })
})

describe('restoration', () => {
  const adapter = (over: Partial<ProducerAdapter> = {}): ProducerAdapter & { log: string[] } => {
    const log: string[] = []
    return {
      log,
      restore: async (n: string) => { log.push(`restore ${n}`) },
      confirm: async (n: string) => { log.push(`confirm ${n}`); return true },
      ...over,
    } as ProducerAdapter & { log: string[] }
  }

  it('restores in the reviewed reverse order, confirming each before the next', async () => {
    const a = adapter()
    const r = await restoreProducers(a)
    expect(r.failedAt).toBeNull()
    expect([...r.restored]).toEqual([...RESTORE_ORDER])
    expect(r.notRestored).toEqual([])
    expect(a.log).toEqual(RESTORE_ORDER.flatMap(n => [`restore ${n}`, `confirm ${n}`]))
  })

  it('STOPS at the first failure and reports the exact boundary', async () => {
    for (const failing of RESTORE_ORDER) {
      const a = adapter({ confirm: async (n: string) => n !== failing })
      const r = await restoreProducers(a)
      expect(r.failedAt, failing).toBe(failing)
      const upTo = RESTORE_ORDER.slice(0, RESTORE_ORDER.indexOf(failing))
      expect([...r.restored], failing).toEqual(upTo)
      expect([...r.notRestored], failing)
        .toEqual(RESTORE_ORDER.filter(n => !upTo.includes(n)))
    }
  })

  it('never retries, and never starts the rest anyway', async () => {
    const attempts: string[] = []
    const a = adapter({ restore: async (n: string) => {
      attempts.push(n)
      if (n === RESTORE_ORDER[1]) throw new Error('launchctl bootstrap failed')
    } })
    const r = await restoreProducers(a)
    expect(r.failedAt).toBe(RESTORE_ORDER[1])
    // The failing producer was tried ONCE, and the third was never touched.
    expect(attempts).toEqual([RESTORE_ORDER[0], RESTORE_ORDER[1]])
    expect(attempts.filter(n => n === RESTORE_ORDER[1]).length).toBe(1)
    expect(attempts).not.toContain(RESTORE_ORDER[2])
    // Nothing the adapter said travels.
    expect(surfaces(r)).not.toContain('launchctl')
  })

  it('a restore that returns is not a confirmation', async () => {
    const a = adapter({ confirm: async () => false })
    const r = await restoreProducers(a)
    expect(r.failedAt).toBe(RESTORE_ORDER[0])
    expect(r.restored).toEqual([])
    // It DID call restore; it simply did not believe it.
    expect(a.log).toContain(`restore ${RESTORE_ORDER[0]}`)
  })
})

describe('the intervention state', () => {
  const failure = { phase: 'L6-release-gate' as const,
                    reason: 'the final release gate refused' as const, at: null }

  it('is non-forgeable by identity, not by a property', () => {
    const genuine = new LifecycleInterventionRequired(
      failure, 'held', supervisorStub() as never)
    // A directly constructed one is NOT registered: only the lifecycle mints.
    expect(isInterventionRequired(genuine)).toBe(false)
    expect(isInterventionRequired({ ...genuine })).toBe(false)
    expect(isInterventionRequired(null)).toBe(false)
    expect(LIFECYCLE).toContain('const LIVE_INTERVENTIONS = new WeakSet<object>()')
    expect(LIFECYCLE).toContain('LIVE_INTERVENTIONS.has(v)')
    expect(LIFECYCLE).not.toMatch(/export\s+(const|function|type)\s+LIVE_INTERVENTIONS/)
  })

  it('states the fence truthfully, and never claims a released fence is held', () => {
    const states: LifecycleFenceState[] =
      ['held', 'not-held', 'unproved', 'released', 'released-unproved', 'release-unknown']
    expect(Object.keys(LIFECYCLE_FENCE_SENTENCE).sort()).toEqual([...states].sort())
    expect(new Set(Object.values(LIFECYCLE_FENCE_SENTENCE)).size).toBe(6)
    for (const s of states) {
      const m = new LifecycleInterventionRequired(failure, s, supervisorStub() as never).message
      expect(m.includes('PROVED still held'), s).toBe(s === 'held')
      if (s === 'released' || s === 'released-unproved') {
        expect(m, s).toMatch(/has been released/i)
        expect(m, s).toContain('cannot be recovered')
        expect(m, s).not.toContain('still held')
      }
      if (s === 'released-unproved') {
        expect(m).toContain('NOT restored')
      }
      if (s === 'not-held' || s === 'unproved') {
        expect(m, s).toContain('MUTABLE')
      }
    }

    // THE UNKNOWN OUTCOME SAYS NONE OF THE FOUR THINGS IT CANNOT KNOW.
    const unknown = LIFECYCLE_FENCE_SENTENCE['release-unknown']
    expect(unknown).toContain('OUTCOME IS NOT KNOWN')
    expect(unknown).toContain('may still be held, or may already be gone')
    expect(unknown).toContain('NOT been retried')
    expect(unknown).toContain('producers were NOT restored')
    // It never claims a release, never claims the fence is held, never calls
    // the source safely mutable, and never invites a retry.
    expect(unknown).not.toMatch(/has been released/i)
    expect(unknown).not.toMatch(/is still held/i)
    expect(unknown).not.toMatch(/safely mutable/i)
    expect(unknown).not.toMatch(/\bretry\b/i)
    expect(unknown).not.toMatch(/may be retried/i)
    // And only the two ACKNOWLEDGED states say the lease is gone.
    for (const s of states) {
      const says = /has been released/i.test(LIFECYCLE_FENCE_SENTENCE[s])
      expect(says, s).toBe(s === 'released' || s === 'released-unproved')
    }
  })

  it('retains the supervisor handle, preserves the primary failure, and leaks nothing', () => {
    const supervisor = supervisorStub()
    const e = new LifecycleInterventionRequired(
      { phase: 'L9-release-proof', reason: 'the fence release could not be proved', at: null },
      'released-unproved', supervisor as never,
      { ...NO_EVIDENCE_FIXTURE, attempted: true, publishedPath: '/ev/release-gate-x',
        verified: true, digestFileDigest: 'a'.repeat(64), publication: 'published' },
      { ...NO_EVIDENCE_FIXTURE },
      [], REVIEWED_PRODUCERS)
    expect(e.supervisor).toBe(supervisor)
    expect(e.failure.phase).toBe('L9-release-proof')
    expect(e.releaseGateEvidence.verified).toBe(true)
    expect(e.lifecycleEvidence.attempted).toBe(false)
    expect([...e.notRestored]).toEqual([...REVIEWED_PRODUCERS])
    expect(e.message).toContain('INTERVENTION REQUIRED')
    expect(e.message).toContain('Nothing has been cleaned')
    const text = surfaces(e)
    for (const marker of ['password', 'postgres://', 'PGPASSWORD', 'passfile', 'Alpha Corp']) {
      expect(text.toLowerCase()).not.toContain(marker.toLowerCase())
    }
  })
})

describe('the two bundles are two bundles', () => {
  const AUTH = async (root: string): Promise<ReleaseAuthorization> =>
    await runReleaseGate(gateInput(root))

  const publishGate = (root: string, a: ReleaseAuthorization, runId = RUN,
                       ops?: EvidenceOps): ReturnType<typeof publishLifecycleBundle> =>
    publishLifecycleBundle({
      root, prefix: RELEASE_GATE_PREFIX, stamp: STAMP, runId,
      manifestFile: RELEASE_GATE_FILE, detailFile: GATE_DETAIL_FILE,
      manifest: authorizationDocument(a, HANDOFF(), runId, STAMP),
      detail: gateDetailDocument(a),
      ...(ops === undefined ? {} : { ops }),
    })

  const publishOutcome = (root: string, runId = 'e5f6a7b8',
                          ops?: EvidenceOps): ReturnType<typeof publishLifecycleBundle> =>
    publishLifecycleBundle({
      root, prefix: LIFECYCLE_PREFIX, stamp: STAMP, runId,
      manifestFile: LIFECYCLE_FILE, detailFile: LIFECYCLE_DETAIL_FILE,
      manifest: outcomeDocument(
        HANDOFF(), 'released', { state: 'released', remainingLocks: 0 },
        { restored: RESTORE_ORDER, notRestored: [], failedAt: null },
        `/ev/release-gate-${STAMP}-${RUN}`, null, runId, STAMP, 'COPY_VERIFIED_RESTORED_AWAITING_CLOSURE'),
      detail: actionsDocument({ state: 'released', remainingLocks: 0 },
                              { restored: RESTORE_ORDER, notRestored: [], failedAt: null }),
      ...(ops === undefined ? {} : { ops }),
    })

  it('are separate, differently named, and both immutable', async () => {
    const root = makeRoot()
    const gate = publishGate(root, await AUTH(root))
    const outcome = publishOutcome(root)
    expect(gate.finalPath).not.toBe(outcome.finalPath)
    expect(readdirSync(root).filter(n => n.startsWith('release-gate-')).length).toBe(1)
    expect(readdirSync(root).filter(n => n.startsWith('copy-lifecycle-')).length).toBe(1)
    for (const p of [gate, outcome]) {
      expect(statSync(p.finalPath).mode & 0o777).toBe(0o500)
      for (const f of p.files) expect(statSync(join(p.finalPath, f)).mode & 0o777).toBe(0o400)
      expect([...verifyPublishedEvidence(p.finalPath)].sort()).toEqual([...p.files].sort())
      // Frozen: the normal writer cannot create, truncate, append or replace.
      const target = join(p.finalPath, readdirSync(p.finalPath)[0])
      expect(() => writeFileSync(target, 'x')).toThrow()
      expect(() => writeFileSync(target, 'x', { flag: 'a' })).toThrow()
      expect(() => writeFileSync(join(p.finalPath, 'extra'), 'x')).toThrow()
    }
  })

  it('the AUTHORIZATION never claims the release or the restoration happened', async () => {
    const root = makeRoot()
    const gate = publishGate(root, await AUTH(root))
    const doc = JSON.parse(readFileSync(join(gate.finalPath, RELEASE_GATE_FILE), 'utf-8'))
    expect(doc.record).toBe('authorization-to-release')
    expect(doc.authorized).toBe(true)
    // THE TWO FIELDS THAT MATTER. An authorization is permission, and a reader
    // who found only this bundle must not conclude the lifecycle finished.
    expect(doc.released).toBeNull()
    expect(doc.producers_restored).toBeNull()
    expect(doc.complete).toBe(true)
    expect(doc.fence.disposition).toBe('held')

    const outcome = publishOutcome(root)
    const odoc = JSON.parse(readFileSync(join(outcome.finalPath, LIFECYCLE_FILE), 'utf-8'))
    expect(odoc.record).toBe('lifecycle-outcome')
    expect(odoc.outcome).toBe('COPY_VERIFIED_RESTORED_AWAITING_CLOSURE')
    expect(odoc.release.state).toBe('released')
    expect(odoc.restoration.restored).toEqual([...RESTORE_ORDER])
    expect(odoc.fence.state).toBe('released')
  })

  it('never overwrites a published destination', async () => {
    const root = makeRoot()
    const a = await AUTH(root)
    const first = publishGate(root, a)
    const before = readFileSync(join(first.finalPath, RELEASE_GATE_FILE), 'utf-8')
    let thrown: unknown = null
    try { publishGate(root, a) } catch (e) { thrown = e }
    expect(thrown).toBeInstanceOf(LifecycleEvidenceFailed)
    // Refused at the COLLISION check, before a byte was written: the
    // destination is occupied by something this run did not create.
    const e = thrown as LifecycleEvidenceFailed
    expect(e.publication).toBe('destination-occupied')
    expect(e.evidencePhase).toBe('collision')
    expect(e.temporaryPath).toBeNull()
    expect(readFileSync(join(first.finalPath, RELEASE_GATE_FILE), 'utf-8')).toBe(before)
  })

  it('publishes by NO-REPLACE RENAME, not merely by checking first', async () => {
    // THE COLLISION CHECK IS NOT THE GUARANTEE. `publishEvidence` looks for the
    // destination before it builds, and that check would hide a rename that
    // overwrites: nothing in the ordinary path ever reaches the rename with the
    // destination occupied. So the check is made to LIE - it reports the final
    // name absent while the bundle is really there - and the rename is left as
    // the only thing standing between a second run and the first one's bytes.
    const root = makeRoot()
    const a = await AUTH(root)
    const first = publishGate(root, a)
    const before = readFileSync(join(first.finalPath, RELEASE_GATE_FILE), 'utf-8')

    // The lie is told ONCE, to the collision check, and the truth is told
    // afterwards - so the publication's own outside verification still works
    // and an overwriting rename would report a clean success rather than
    // failing for some unrelated reason.
    let lied = false
    const blindOnce: EvidenceOps = {
      ...REAL_EVIDENCE_OPS,
      lstatSync: ((path: string, opts?: unknown) => {
        if (String(path) === first.finalPath && !lied) {
          lied = true
          const err = new Error('injected') as NodeJS.ErrnoException
          err.code = 'ENOENT'
          throw err
        }
        return REAL_EVIDENCE_OPS.lstatSync(path, opts as never)
      }) as typeof REAL_EVIDENCE_OPS.lstatSync,
    }
    const inodeBefore = statSync(first.finalPath).ino
    let thrown: unknown = null
    try { publishGate(root, a, RUN, blindOnce) } catch (e) { thrown = e }
    expect(lied).toBe(true)
    expect(thrown).toBeInstanceOf(LifecycleEvidenceFailed)
    // THE RENAME REFUSED, with the collision check already fooled. Both facts
    // are true here - a temporary bundle was built AND the destination is
    // occupied - and the classifier names the actionable one, carrying the
    // publisher's own reason beside it so the cause is not lost.
    const e = thrown as LifecycleEvidenceFailed
    expect(e.publication).toBe('retained-temporary')
    expect(e.evidencePhase).toBe('publish')
    expect(e.evidenceReason).toBe('a path is already present at the publication destination')
    // THE FIRST BUNDLE IS THE SAME DIRECTORY OBJECT, with the same bytes.
    expect(statSync(first.finalPath).ino).toBe(inodeBefore)
    expect(readFileSync(join(first.finalPath, RELEASE_GATE_FILE), 'utf-8')).toBe(before)
    expect([...verifyPublishedEvidence(first.finalPath)].sort())
      .toEqual([...first.files].sort())
  })

  it('preserves EVERY publication outcome class, for both prefixes', async () => {
    const root0 = makeRoot()
    const a = await AUTH(root0)
    const failingOn = (when: (op: string, p: string) => boolean): EvidenceOps => ({
      ...REAL_EVIDENCE_OPS,
      writeSync: ((fd: number, b: Buffer) => {
        if (when('write', '')) throw new Error('injected')
        return REAL_EVIDENCE_OPS.writeSync(fd, b as never)
      }) as typeof REAL_EVIDENCE_OPS.writeSync,
      chmodSync: ((p: string, m: number) => {
        if (when('chmod', String(p))) throw new Error('injected')
        return REAL_EVIDENCE_OPS.chmodSync(p, m)
      }) as typeof REAL_EVIDENCE_OPS.chmodSync,
    })

    for (const [prefix, publish, finalName] of [
      [RELEASE_GATE_PREFIX, (r: string, o?: EvidenceOps) => publishGate(r, a, RUN, o),
       `release-gate-${STAMP}-${RUN}`],
      [LIFECYCLE_PREFIX, (r: string, o?: EvidenceOps) => publishOutcome(r, 'e5f6a7b8', o),
       `copy-lifecycle-${STAMP}-e5f6a7b8`],
    ] as const) {
      // 1. REFUSED, nothing created.
      const r1 = makeRoot()
      writeFileSync(join(r1, finalName), 'squatter')
      let e = ((): LifecycleEvidenceFailed => {
        try { publish(r1) } catch (x) { return x as LifecycleEvidenceFailed }
        throw new Error('expected a refusal')
      })()
      expect(e.publication, prefix).toBe('destination-occupied')
      expect(e.temporaryPath, prefix).toBeNull()

      // 2. RETAINED TEMPORARY.
      const r2 = makeRoot()
      let writes = 0
      e = ((): LifecycleEvidenceFailed => {
        try { publish(r2, failingOn(op => op === 'write' && ++writes === 2)) }
        catch (x) { return x as LifecycleEvidenceFailed }
        throw new Error('expected a refusal')
      })()
      expect(e.publication, prefix).toBe('retained-temporary')
      expect(e.temporaryPath, prefix)
        .toBe(join(r2, evidenceNames(prefix, STAMP, e.temporaryPath!.slice(-8)).temporaryName))

      // 3. UNAVAILABLE atomic rename -> still a retained temporary.
      const r3 = makeRoot()
      e = ((): LifecycleEvidenceFailed => {
        try { publish(r3, { ...REAL_EVIDENCE_OPS, renameNoReplace: () => 'unavailable' }) }
        catch (x) { return x as LifecycleEvidenceFailed }
        throw new Error('expected a refusal')
      })()
      expect(e.publication, prefix).toBe('retained-temporary')

      // 4. PUBLISHED BUT UNVERIFIED.
      const r4 = makeRoot()
      e = ((): LifecycleEvidenceFailed => {
        try { publish(r4, failingOn((op, p) => op === 'chmod' && p.endsWith(finalName))) }
        catch (x) { return x as LifecycleEvidenceFailed }
        throw new Error('expected a refusal')
      })()
      expect(e.publication, prefix).toBe('published-unverified')
      expect(e.finalPath, prefix).toBe(join(r4, finalName))
      expect(readdirSync(r4), prefix).toEqual([finalName])

      // 5. UNKNOWN rename outcome.
      const r5 = makeRoot()
      e = ((): LifecycleEvidenceFailed => {
        try {
          publish(r5, { ...REAL_EVIDENCE_OPS, renameNoReplace: (from: string) => {
            rmSync(from, { recursive: true, force: true })
            return 'indeterminate'
          } })
        } catch (x) { return x as LifecycleEvidenceFailed }
        throw new Error('expected a refusal')
      })()
      expect(e.publication, prefix).toBe('unknown')

      // 6. STATE UNPROVED: the recovery probe itself could not answer.
      const r6 = makeRoot()
      let seen = 0
      e = ((): LifecycleEvidenceFailed => {
        try {
          publish(r6, {
            ...failingOn(op => op === 'write'),
            lstatSync: ((p: string, o?: unknown) => {
              if (seen++ >= 1) {
                const err = new Error('injected') as NodeJS.ErrnoException
                err.code = 'EACCES'
                throw err
              }
              return REAL_EVIDENCE_OPS.lstatSync(p, o as never)
            }) as typeof REAL_EVIDENCE_OPS.lstatSync,
          })
        } catch (x) { return x as LifecycleEvidenceFailed }
        throw new Error('expected a refusal')
      })()
      expect(e.publication, prefix).toBe('state-unproved')
      expect(e.temporaryPath, prefix).toBeNull()
    }
  })

  it('registers both prefixes with their own temporary names', () => {
    // Each prefix STATES its own temporary name, so a prefix added later cannot
    // rename an existing one.
    for (const p of ['source-manifest', 'verification', 'release-gate', 'copy-lifecycle',
                     'operational-rehearsal', 'producer-restoration', 'rehearsal-review',
                     'intervention-intent', 'intervention-outcome', 'commit-disposition']) {
      expect(REVIEWED_PREFIXES, p).toContain(p)
      expect(TEMPORARY_NAME_PREFIX[p], p).toMatch(/^\.tmp-/)
    }
    expect(new Set(Object.values(TEMPORARY_NAME_PREFIX)).size)
      .toBe(REVIEWED_PREFIXES.length)
    expect(TEMPORARY_NAME_PREFIX[RELEASE_GATE_PREFIX]).toBe('.tmp-release-gate-')
    expect(TEMPORARY_NAME_PREFIX[LIFECYCLE_PREFIX]).toBe('.tmp-copy-lifecycle-')
    expect(evidenceNames(RELEASE_GATE_PREFIX, STAMP, RUN).finalName)
      .toBe(`release-gate-${STAMP}-${RUN}`)
    expect(evidenceNames(LIFECYCLE_PREFIX, STAMP, RUN).finalName)
      .toBe(`copy-lifecycle-${STAMP}-${RUN}`)
  })

  it('carries no credential component in either document', async () => {
    const root = makeRoot()
    const a = await AUTH(root)
    const text = [
      canonicalJson(authorizationDocument(a, HANDOFF(), RUN, STAMP)),
      canonicalJson(gateDetailDocument(a)),
      canonicalJson(outcomeDocument(HANDOFF(), 'released',
        { state: 'released', remainingLocks: 0 },
        { restored: RESTORE_ORDER, notRestored: [], failedAt: null }, null, null, RUN, STAMP,
        'COPY_VERIFIED_RESTORED_AWAITING_CLOSURE')),
      canonicalJson(actionsDocument({ state: 'released', remainingLocks: 0 }, null)),
    ].join('\n').toLowerCase()
    for (const marker of ['password', 'passfile', 'pgpass', 'postgres://', 'host=',
                          'sslmode', 'secret', '/tmp/']) {
      expect(text, marker).not.toContain(marker)
    }
  })
})

describe('the reviewed order is the code', () => {
  it('releases only AFTER the authorization evidence is published and verified', () => {
    // THE MAIN PATH ONLY. `releaseAfterPristine` is a SECOND release site -
    // the NOT_COMMITTED_PRISTINE continuation - and it is declared above the
    // main flow, so scanning from the top would compare two different
    // sequences. Its own ordering is asserted in the test below.
    const whole = LIFECYCLE.slice(LIFECYCLE.indexOf('export async function runLifecycle'))
    // `LIFECYCLE` is the STRIPPED source, so the anchor has to be code.
    const body = whole.slice(whole.indexOf('bundleManifest = readPublishedBundle('))
    const at = (needle: string): number => {
      const n = body.indexOf(needle)
      expect(n, needle).toBeGreaterThan(-1)
      return n
    }
    const order = [
      'await assertQuiescent(i.quiescence,',
      'appliedResult = await runApply(',
      'await stageSource.rows(RELEASE_SQL)',
      'verification = await runVerification(',
      'authorization = await runReleaseGate(',
      'prefix: RELEASE_GATE_PREFIX',
      'release = await releaseFence(',
      "if (i.restorationAuthority.kind === 'adapter')",
    ]
    let previous = -1
    for (const step of order) {
      const n = at(step)
      expect(n, step).toBeGreaterThan(previous)
      previous = n
    }
  })

  it('restores only after the release is PROVED, never after released-unproved', () => {
    const body = LIFECYCLE.slice(LIFECYCLE.indexOf('export async function runLifecycle'))
    const guard = body.indexOf("if ((release as ReleaseResult).state !== 'released')")
    // K7-B: restoration is now reached only through the authority branch, which
    // is therefore the thing that must sit after the proof.
    const restore = body.indexOf("if (i.restorationAuthority.kind === 'adapter')")
    expect(guard).toBeGreaterThan(-1)
    expect(restore).toBeGreaterThan(-1)
    expect(guard).toBeLessThan(restore)
    // The guard leaves through `stop`, which never returns.
    expect(body.slice(guard, restore)).toContain("'L9-release-proof'")
  })

  it('MANUAL-STOP NEVER RESTORES: restoreProducers is reachable only via the adapter', () => {
    // Behavioural intent stated structurally because `runLifecycle` needs a
    // live cluster: there is exactly ONE call to `restoreProducers` in the
    // lifecycle, and it sits inside the adapter branch. A production run cannot
    // reach it, so it cannot report producers it never touched.
    const body = LIFECYCLE.slice(LIFECYCLE.indexOf('export async function runLifecycle'))
    const calls = body.match(/await restoreProducers\(/g) ?? []
    expect(calls.length).toBe(1)
    const branch = body.indexOf("if (i.restorationAuthority.kind === 'adapter')")
    const call = body.indexOf('await restoreProducers(')
    expect(branch).toBeGreaterThan(-1)
    expect(branch).toBeLessThan(call)
    // And the terminal outcome distinguishes the two authorities, so a
    // manual-stop run cannot be reported COMPLETE.
    expect(body).toContain('const terminal = terminalOutcomeFor(i.restorationAuthority)')
    // ONE value, published and returned - not two computations that could drift.
    expect(body).toContain('outcome: terminal,')
    expect(body).toContain("recordOutcome(\n      'released', null, gateEvidence.publishedPath, terminal)")
  })

  it('closes what it owns and never the caller sessions', () => {
    expect(LIFECYCLE).toContain('await stageSource.end()')
    expect(LIFECYCLE).not.toMatch(/i\.supervisor\.(end|close)\(/)
    expect(LIFECYCLE).not.toMatch(/i\.prover\.(end|close)\(/)
    // The one statement it ever sends to the supervisor to end a transaction.
    expect(LIFECYCLE.match(/i\.supervisor/g)?.length).toBeGreaterThan(0)
    expect(LIFECYCLE).not.toContain('i.supervisor.send(RELEASE_SQL)')
  })

  it('the standalone --apply path is STILL refused, and says why truthfully', () => {
    const cli = strip(read('bin/pg-copy.ts'))
    expect(cli).toContain('if (parsed.apply) {')
    expect(cli).toContain("say('REFUSED: the standalone --apply path is not available.')")
    expect(cli).toContain('The core lifecycle EXISTS')
    expect(cli).toContain('production-adapter rehearsal')
    expect(cli).not.toContain('runApply(')
    expect(cli).not.toContain('runLifecycle(')
    expect(cli).not.toContain('runReleaseGate(')
    expect(cli).not.toContain('releaseFence(')
    // No standalone verifier or release command was added beside it.
    expect(cli).not.toContain('--verify')
    expect(cli).not.toContain('--release')
  })

  it('touches no operational mechanism directly', () => {
    for (const forbidden of ['launchctl', 'redis', 'ioredis', 'child_process', 'execFile',
                             'spawn(', '090', 'bullmq']) {
      expect(LIFECYCLE.toLowerCase(), forbidden).not.toContain(forbidden.toLowerCase())
    }
  })
})

// ---------------------------------------------------------------------------

describe('the reviewed sets are the real ones', () => {
  it('names every launchd agent that can write the source, and no other', () => {
    // M11. A set that quietly lost an agent would let the gate certify a
    // quiescent source while that agent was still writing to it. The names are
    // the LAUNCHD LABELS, which is what the census can actually ask about.
    expect([...REVIEWED_PRODUCERS]).toEqual([
      'com.thanapol.ai-capital.daily',
      'com.thanapol.ai-capital.watchdog',
      'com.thanapol.ai-capital.alerts',
      'com.thanapol.ai-capital.structured-worker',
      'com.thanapol.ai-capital.worker',
    ])
    // THE WORKER IS LAST TO STOP AND FIRST TO COME BACK: it drains what the
    // triggers fill, so stopping it first would strand in-flight work.
    expect(REVIEWED_PRODUCERS[REVIEWED_PRODUCERS.length - 1])
      .toBe('com.thanapol.ai-capital.worker')
    expect(RESTORE_ORDER[0]).toBe('com.thanapol.ai-capital.worker')
  })

  it('names the queues BullMQ actually has', () => {
    // M12. An earlier revision invented `ai-capital-daily`/`ai-capital-alerts`,
    // which exist nowhere: every sample refused, safely and for entirely the
    // wrong reason. These two are the names in `@common/queue`'s own constants.
    expect([...REVIEWED_QUEUES]).toEqual(['daily-pipeline', 'structured-ingestion'])
  })
})

describe('a fence proof carries facts ONLY when it proved the fence held', () => {
  it('is the invariant the gate depends on', async () => {
    // M14. `runReleaseGate` refuses on `outcome !== 'held' || facts === null`.
    // The first disjunct is redundant ONLY because of this invariant, so the
    // invariant is asserted here rather than left implicit in a doc comment.
    for (const locks of [[], [lockRow('advisory', 'ExclusiveLock')],
                         wholeFence([lockRow('advisory', 'ExclusiveLock', PROVING_PID)])]) {
      const proof = await attemptFenceProof(
        proverStub({ locks }) as never, SUPERVISOR_PID, 'S3')
      if (proof.outcome !== 'held') expect(proof.facts, proof.cause ?? '').toBeNull()
      else expect(proof.facts).not.toBeNull()
    }
  })
})

describe('the Stage-1 bundle the gate is handed is the one it read from disk', () => {
  it('refuses a structurally identical copy of a real bundle', async () => {
    // M20. `PublishedManifest` is an ordinary interface, so an object literal
    // with the right fields is indistinguishable from one `readPublishedBundle`
    // returned after verifying every digest on disk. Membership of a
    // module-private WeakSet is what separates them, and it survives none of
    // the ways an object gets duplicated.
    const root = makeRoot()
    const real = stage1Bundle(root)
    expect(isVerifiedBundle(real)).toBe(true)
    for (const fake of [{ ...real }, JSON.parse(JSON.stringify(real)) as object,
                        structuredClone(real) as object,
                        Object.defineProperties({}, Object.getOwnPropertyDescriptors(real))]) {
      expect(isVerifiedBundle(fake)).toBe(false)
      const e = await refusedBy(() => runReleaseGate(gateInput(root, { published: fake })))
      expect(e.message).toContain('Stage-1 bundle provenance')
    }
  })
})

// ---------------------------------------------------------------------------
// K1.1: THE GATE PROVES THE REAL FENCED WORLD
// ---------------------------------------------------------------------------

describe('the reviewed session set is DERIVED, never supplied', () => {
  it('takes no operator allowlist at all', () => {
    // K1.1-M01. An allowlist a person types is an allowlist a person can
    // extend by one line, and that one line would license exactly the
    // unreviewed connection the census exists to find. The input shape is the
    // control: there is nowhere to put one.
    const input = gateInput(makeRoot()) as unknown as Record<string, unknown>
    expect('reviewedSessions' in input).toBe(false)
    expect(strip(read('src/pg-copy/lifecycle.ts'))).not.toContain('readonly reviewedSessions')
  })

  it('asks the supervisor and the prover who they are, and accepts nobody else',
    async () => {
      const root = makeRoot()
      // A third client backend nobody owns. The census sees it and refuses.
      const e = await refusedBy(() => runReleaseGate(gateInput(root, {
        prover: proverStub({
          activity: [[SUPERVISOR_PID, 'ai_capital_owner', 'client backend'],
                     [PROVING_PID, 'ai_capital_owner', 'client backend'],
                     ['99999', 'somebody_else', 'client backend']],
        }),
      })))
      expect(e.refusal).toBe('the source carries sessions that are not reviewed')
    })

  it('refuses a supervisor that will not identify itself, and says so', async () => {
    // THE REFUSAL NAMES THE RIGHT PROBLEM. A supervisor that will not answer is
    // a supervisor nobody can show still holds the fence - not an unreviewed
    // connection somewhere on the source, which is where a single shared
    // refusal would have sent the operator looking.
    const root = makeRoot()
    const e = await refusedBy(() => runReleaseGate(gateInput(root, {
      supervisor: supervisorStub({ role: 'Not An Identifier' }),
    })))
    expect(e.refusal).toBe('the supervisor is not the backend that held the fence')
    expect(e.at).toContain('supervisor')
  })

  it('refuses a prover that is the supervisor', async () => {
    const root = makeRoot()
    const e = await refusedBy(() => runReleaseGate(gateInput(root, {
      prover: proverStub({ pid: SUPERVISOR_PID }),
    })))
    expect(e.refusal).toBe('the complete source fence was not proved held')
  })
})

describe('pid AND backend start, everywhere the fence is identified', () => {
  it('refuses a supervisor whose backend start does not match the fence',
    async () => {
      // K1.1-M02. A supervisor that died and reconnected can come back on the
      // same pid holding none of the fence. Rolling THAT back would release
      // nothing while reporting a release.
      const root = makeRoot()
      const e = await refusedBy(() => runReleaseGate(gateInput(root, {
        supervisor: supervisorStub({ backendStart: '2026-09-25 11:00:00+00' }),
      })))
      expect(e.refusal).toBe('the supervisor is not the backend that held the fence')
    })

  it('refuses when the INDEPENDENT prover cannot confirm the backend start',
    async () => {
      const root = makeRoot()
      for (const observedStart of [null, '2026-09-25 11:00:00+00']) {
        const e = await refusedBy(() => runReleaseGate(gateInput(root, {
          prover: proverStub({ observedStart }),
        })))
        expect(e.refusal, String(observedStart))
          .toBe('the supervisor is not the backend that held the fence')
      }
    })

  it('carries the pair into the authorization, and the release re-checks it',
    async () => {
      const root = makeRoot()
      const supervisor = supervisorStub()
      const a = await runReleaseGate(gateInput(root, { supervisor }))
      expect(a.fence.supervisorBackendStart).toBe(BACKEND_START)
      // The release asks again, and the supervisor's answer must still match.
      expect((await releaseFence(supervisor as never, a)).state).toBe('released')
    })

  it('refuses a release whose supervisor came back on the same pid', async () => {
    // K1.1-K22. THE SAME OBJECT, THE SAME PID, A NEW BACKEND. A supervisor
    // that died and reconnected can come back on the same pid holding none of
    // the fence, and rolling THAT back would release nothing while reporting a
    // release. Only the start separates them, which is why the start is in the
    // authorization record and is re-checked at release time.
    //
    // MUTATED IN PLACE, on purpose. A wrapper object would be refused one step
    // earlier - the authorization is bound to the exact supervisor OBJECT - and
    // the test would then pass without ever reaching the check it is about.
    const root = makeRoot()
    let backendStart = BACKEND_START
    const supervisor = supervisorStub()
    const original = supervisor.send
    supervisor.send = async (sql: string) => {
      if (sql === SESSION_IDENTITY_SQL) {
        return { rows: [[SUPERVISOR_PID, 'ai_capital_owner', backendStart]], error: null }
      }
      return await original(sql)
    }
    const a = await runReleaseGate(gateInput(root, { supervisor }))
    backendStart = '2026-09-25 12:00:00+00'
    const e = await refusedBy(() => releaseFence(supervisor as never, a))
    expect(e.at).toBe('the supervisor is not the backend the gate proved')
    // AND NOTHING WAS SENT TO IT.
    expect(supervisor.seen).not.toContain(RELEASE_SQL)
  })
})

describe('the producers are re-measured WHILE FENCED', () => {
  it('refuses a producer that changed between the two censuses', async () => {
    // K1.1-M03. The pre-fence census answers "where do these agents write" at a
    // moment when they could still be running; the fenced one answers it with
    // the source frozen. A plist swapped in between is a producer whose
    // stopping the operator justified against a world that no longer exists.
    const root = makeRoot()
    const drifted = CENSUS().map((p, n) => n === 2
      ? { ...p, credentialDeviceInode: '16777234:99999' } : p)
    const e = await refusedBy(() => runReleaseGate(gateInput(root, {
      destinations: steadyDestinations(drifted),
    })))
    expect(e.refusal).toBe('the fenced producer census does not agree with the pre-fence one')
    expect(e.at).toContain(REVIEWED_PRODUCERS[2])
  })

  it('refuses a fenced census that covers a different set', async () => {
    const root = makeRoot()
    const e = await refusedBy(() => runReleaseGate(gateInput(root, {
      destinations: steadyDestinations(CENSUS().slice(1)),
    })))
    expect(e.refusal).toBe('the fenced producer census does not agree with the pre-fence one')
  })

  it('records the fenced census it agreed with', async () => {
    const found = await proveOperationalState({
      fence: { supervisorPid: SUPERVISOR_PID, backendStart: BACKEND_START, mechanism: 'S3' },
      supervisor: supervisorStub() as never, prover: proverStub() as never,
      quiescence: stoppedProducers(), queue: emptyQueues(),
      destinations: steadyDestinations(), expectedProducers: CENSUS(),
      __sleep: async () => undefined,
    })
    expect(found.fencedProducers.length).toBe(REVIEWED_PRODUCERS.length)
    expect([...found.derivedSessions]).toEqual([...EXPECTED_DERIVED])
  })
})

describe('the two queue samples are separated in time', () => {
  it('waits the reviewed interval between them', async () => {
    // K1.1-M04. Two samples taken in the same millisecond are one sample
    // written down twice, and the pair exists to establish that the queues are
    // STAYING empty rather than being empty at an instant nobody chose.
    const waited: number[] = []
    let samples = 0
    await proveOperationalState({
      fence: { supervisorPid: SUPERVISOR_PID, backendStart: BACKEND_START, mechanism: 'S3' },
      supervisor: supervisorStub() as never, prover: proverStub() as never,
      quiescence: stoppedProducers(),
      queue: { sample: async () => { samples += 1; return { depths: zeroDepths() } } },
      destinations: steadyDestinations(), expectedProducers: CENSUS(),
      __sleep: async (ms: number) => { waited.push(ms) },
    })
    expect(samples).toBe(2)
    expect(waited).toEqual([QUEUE_SAMPLE_INTERVAL_MS])
    expect(QUEUE_SAMPLE_INTERVAL_MS).toBeGreaterThanOrEqual(1_000)
  })
})

describe('the NOT_COMMITTED_PRISTINE release is gated too', () => {
  it('runs a FRESH operational gate before it releases, and never the copy gate', () => {
    const body = LIFECYCLE.slice(
      LIFECYCLE.indexOf('const releaseAfterPristine'),
      LIFECYCLE.indexOf('const publishDisposition'))
    expect(body.length).toBeGreaterThan(200)
    // THE OPERATIONAL GATE, not the copy gate. A copy that measurably did not
    // land has no verifier PASS to point at, and requiring one would leave the
    // fence unreleasable - which turns "nothing happened" into an intervention.
    expect(body).toContain('await runOperationalGate(')
    expect(body).not.toContain('runReleaseGate(')
    expect(body.indexOf('await runOperationalGate('))
      .toBeLessThan(body.indexOf('await releaseFence('))
    // AND NOTHING IS CLEANED UP. No truncate, no delete, no migration, no retry.
    for (const forbidden of ['TRUNCATE', 'DELETE', 'runApply', 'migrate']) {
      expect(body, forbidden).not.toContain(forbidden)
    }
  })
})

describe('an unanswered COMMIT is never recorded as committed', () => {
  it('sets nothing about the target until a MEASUREMENT settles it', () => {
    // K1.1-M05. The old path was one line: `committed = true` on
    // `CommitOutcomeUnknown`. That answered the one question in this whole
    // lifecycle that nobody knows the answer to - and answered it in the
    // convenient direction, with no measurement behind it. Everything
    // downstream then reasoned about a committed target.
    const body = LIFECYCLE.slice(LIFECYCLE.indexOf('export async function runLifecycle'))
    const handler = body.slice(body.indexOf('if (e instanceof CommitOutcomeUnknown)'))
    const nextBrace = handler.slice(0, handler.indexOf('} else {'))
    expect(nextBrace).not.toContain('committed = true')
    expect(nextBrace).toContain('onCommitUnknown(e)')
  })

  it('requires the handoff minted BEFORE the commit was submitted', () => {
    const body = LIFECYCLE.slice(LIFECYCLE.indexOf('const onCommitUnknown'))
    const fn = body.slice(0, body.indexOf('const releaseAfterPristine'))
    // Without it there is nothing to compare the target against, and building
    // one now would be a second chance to describe the hoped-for answer.
    expect(fn).toContain('e.commitHandoff === null')
    expect(fn.indexOf('e.commitHandoff === null')).toBeLessThan(fn.indexOf('await classify('))
  })

  it('publishes and VERIFIES the disposition before any continuation', () => {
    const body = LIFECYCLE.slice(LIFECYCLE.indexOf('const onCommitUnknown'))
    const fn = body.slice(0, body.indexOf('const releaseAfterPristine'))
    expect(fn.indexOf('publishDisposition(')).toBeLessThan(fn.indexOf("=== 'COMMITTED_EXACT'"))
    expect(fn).toContain('!dispositionEvidence.verified')
    expect(fn.indexOf('!dispositionEvidence.verified'))
      .toBeLessThan(fn.indexOf("=== 'COMMITTED_EXACT'"))
  })

  it('treats a classifier that threw as INDETERMINATE, never as a result', () => {
    const body = LIFECYCLE.slice(LIFECYCLE.indexOf('const onCommitUnknown'))
    const fn = body.slice(0, body.indexOf('const releaseAfterPristine'))
    const caught = fn.slice(fn.indexOf('} catch {'), fn.indexOf('dispositionEvidence ='))
    expect(caught).toContain("'INDETERMINATE'")
    expect(caught).not.toContain("'COMMITTED_EXACT'")
    expect(caught).not.toContain("'NOT_COMMITTED_PRISTINE'")
  })
})

describe('a NOT_COMMITTED_PRISTINE run leaves a durable post-release record', () => {
  it('publishes its own bundle, because recordOutcome cannot describe this run', () => {
    // K1.2-9. `recordOutcome` reads `applied`, which is null on this path -
    // `runApply` threw before it returned anything - so it published "no
    // Stage-2 result to describe". The consequence was that a run which took a
    // fence, measured the target untouched and proved the release left NOTHING
    // on disk saying the fence came off. The refusal message said so, and a
    // message is not evidence.
    const body = LIFECYCLE.slice(LIFECYCLE.indexOf('const releaseAfterPristine'),
                                 LIFECYCLE.indexOf('const publishDisposition'))
    expect(body).toContain('publishPristineRelease(release)')
    // PUBLISHED AND VERIFIED BEFORE THE REFUSAL IS THROWN.
    expect(body.indexOf('publishPristineRelease(release)'))
      .toBeLessThan(body.indexOf('throw new LifecycleRefused'))
    expect(body).toContain('!pristineEvidence.verified')
    expect(body.indexOf('!pristineEvidence.verified'))
      .toBeLessThan(body.indexOf('throw new LifecycleRefused'))
  })

  it('records the disposition bundle, the fence, the proof and the retry basis', () => {
    const body = LIFECYCLE.slice(LIFECYCLE.indexOf('const publishPristineRelease'),
                                 LIFECYCLE.indexOf('const publishDisposition'))
    // THE COMMIT-DISPOSITION BUNDLE, BY BASENAME AND DIGEST.
    expect(body).toContain('basename(dispositionPath)')
    expect(body).toContain('digestOfDigestFile(dispositionPath, ops)')
    // THE FENCE AND BACKEND IDENTITY.
    expect(body).toContain('supervisor_pid')
    expect(body).toContain('backend_start')
    // THE ACKNOWLEDGEMENT AND THE ZERO-LOCK PROOF, as separate facts.
    expect(body).toContain('release_acknowledged')
    expect(body).toContain('zero_lock_release_proved')
    expect(body).toContain('remaining_reviewed_locks')
    // AND THE RETRY PERMISSION WITH ITS BASIS.
    expect(body).toContain('retry_permitted')
    expect(body).toContain('retry_basis')
    // PERMISSION FOLLOWS THE PROOF, never the other way round.
    expect(body).toContain("released.state === 'released' && dispositionPath !== null")
  })

  it('publishes under its own reviewed prefix', () => {
    expect(PRISTINE_RELEASE_PREFIX).toBe('pristine-release')
    expect([...REVIEWED_PREFIXES]).toContain(PRISTINE_RELEASE_PREFIX)
    expect(TEMPORARY_NAME_PREFIX[PRISTINE_RELEASE_PREFIX])
      .toBe(`.tmp-${PRISTINE_RELEASE_PREFIX}-`)
  })
})

describe('the pid-parameterized lock census', () => {
  it('counts a NAMED backend, not the session that runs it', () => {
    // K1.2-F. The self-census counts the locks of whoever runs it, which is
    // right for a supervisor proving its own release and useless for anybody
    // else. A hold has to ask "does THAT backend still hold reviewed locks"
    // from a session that is not it.
    const sql = releasedLockCensusSqlFor('41512')
    expect(sql).toContain('l.pid = 41512')
    expect(sql).not.toContain('pg_backend_pid()')
    expect(sql).toContain('pg_catalog.count(*)')
    // THE SHAPE IS ASSERTED, so nothing else can be spliced into a statement.
    for (const bad of ['', 'x', '1; DROP TABLE t', '-1', '1 OR 1=1', '12345678901']) {
      expect(() => releasedLockCensusSqlFor(bad), JSON.stringify(bad))
        .toThrow(ReleaseGateRefused)
    }
  })

  it('derives the complete-fence count from the reviewed sets', () => {
    // A hand-typed constant would be a second place the fence's size is
    // stated, and the two would eventually differ.
    expect(COMPLETE_FENCE_LOCKS).toBe(FENCE_TABLES.length + FENCE_SEQUENCES.length + 1)
    expect(COMPLETE_FENCE_LOCKS).toBe(25)
  })
})

// ── K7-B: the PUBLISHED outcome must equal the returned one ─────────────────
//
// The document used to compute its own verdict - `failure === null ? COMPLETE :
// STOPPED` - while the returned value had learned to distinguish a manual-stop
// success. A production run therefore froze a bundle saying COMPLETE about a
// copy whose producers were still down. These cases read the PUBLISHED bytes,
// because a source assertion on the return statement could not have caught that.
describe('K7-B: the copy-lifecycle document tells the truth about restoration', () => {
  const publish = (
    outcome: 'COPY_VERIFIED_RESTORED_AWAITING_CLOSURE'
      | 'COPY_VERIFIED_AWAITING_MANUAL_RESTORATION',
    restoration: { restored: readonly string[]; notRestored: readonly string[]
                   failedAt: string | null } | null,
  ): Record<string, never> => {
    const root = makeRoot()
    {
      const runId = 'aabbccdd'
      const p = publishLifecycleBundle({
        root, prefix: LIFECYCLE_PREFIX, stamp: STAMP, runId,
        manifestFile: LIFECYCLE_FILE, detailFile: LIFECYCLE_DETAIL_FILE,
        manifest: outcomeDocument(
          HANDOFF(), 'released', { state: 'released', remainingLocks: 0 },
          restoration, `/ev/release-gate-${STAMP}-${runId}`, null, runId, STAMP, outcome),
        detail: actionsDocument({ state: 'released', remainingLocks: 0 }, restoration),
      })
      // READ THE BYTES THAT WERE WRITTEN, not the object that was passed in.
      return JSON.parse(
        readFileSync(join(p.finalPath as string, LIFECYCLE_FILE), 'utf-8'),
      ) as Record<string, never>
    }
  }

  it('ADAPTER success: restored-awaiting-closure, and NOT complete', () => {
    // K7-B7.1: the adapter really did restore and confirm every producer, and
    // the copy is STILL OPEN - a closure is what completes it. COMPLETE here
    // claimed a completion nothing had established; calling it "awaiting
    // manual restoration" would be just as untrue.
    const doc = publish('COPY_VERIFIED_RESTORED_AWAITING_CLOSURE',
      { restored: RESTORE_ORDER, notRestored: [], failedAt: null })
    expect(doc).toMatchObject({
      outcome: 'COPY_VERIFIED_RESTORED_AWAITING_CLOSURE', producers_restored: true,
    })
    // AND NO LIFECYCLE BUNDLE CLAIMS COMPLETE, on either authority.
    expect(JSON.stringify(doc)).not.toContain('COMPLETE')
    expect(doc.restoration).not.toBeNull()
    expect((doc.restoration as unknown as { restored: string[] }).restored)
      .toEqual([...RESTORE_ORDER])
  })

  it('MANUAL-STOP success: the action-required outcome, restored false, no restoration', () => {
    const doc = publish('COPY_VERIFIED_AWAITING_MANUAL_RESTORATION', null)
    expect(doc).toMatchObject({
      outcome: 'COPY_VERIFIED_AWAITING_MANUAL_RESTORATION',
      producers_restored: false,
      restoration: null,
    })
    // AND NOTHING IN IT IMPLIES COMPLETION.
    expect(JSON.stringify(doc)).not.toContain('"COMPLETE"')
  })

  it('MANUAL-STOP actions show every reviewed producer not restored', () => {
    const root = makeRoot()
    {
      const p = publishLifecycleBundle({
        root, prefix: LIFECYCLE_PREFIX, stamp: STAMP, runId: 'aabbccdd',
        manifestFile: LIFECYCLE_FILE, detailFile: LIFECYCLE_DETAIL_FILE,
        manifest: outcomeDocument(
          HANDOFF(), 'released', { state: 'released', remainingLocks: 0 },
          null, null, null, 'aabbccdd', STAMP,
          'COPY_VERIFIED_AWAITING_MANUAL_RESTORATION'),
        detail: actionsDocument({ state: 'released', remainingLocks: 0 }, null),
      })
      const detail = JSON.parse(
        readFileSync(join(p.finalPath as string, LIFECYCLE_DETAIL_FILE), 'utf-8'),
      ) as { not_restored?: string[] }
      expect(detail.not_restored).toEqual([...RESTORE_ORDER])
    }
  })

  it('A FAILURE is STOPPED whatever outcome it is handed', () => {
    // The document must never dress a stopped run as a terminal success just
    // because the caller passed one in.
    {
      const doc = JSON.parse(canonicalJson(outcomeDocument(
        HANDOFF(), 'released-unproved', { state: 'released-unproved', remainingLocks: null },
        null, null,
        { phase: 'L9-release-proof', reason: 'the fence release could not be proved', at: null },
        'aabbccdd', STAMP, 'COPY_VERIFIED_RESTORED_AWAITING_CLOSURE'))) as Record<string, never>
      expect(doc.outcome).toBe('STOPPED')
      expect(doc.producers_restored).toBe(false)
    }
  })
})

describe('K7-B: which terminal success each authority makes true', () => {
  it('each authority returns its own nonterminal success, and neither is COMPLETE', () => {
    // Proved directly, because the inline version could only be reached with
    // two live clusters - and a mutant that swapped the branches survived.
    expect(terminalOutcomeFor({ kind: 'manual-stop' }))
      .toBe('COPY_VERIFIED_AWAITING_MANUAL_RESTORATION')
    const adapter = {
      restore: async () => undefined,
      confirm: async () => true,
    }
    expect(terminalOutcomeFor({ kind: 'adapter', producers: adapter }))
      .toBe('COPY_VERIFIED_RESTORED_AWAITING_CLOSURE')
  })

  it('is total over the authority and returns nothing else', () => {
    for (const a of [{ kind: 'manual-stop' as const },
                     { kind: 'adapter' as const,
                       producers: { restore: async () => undefined, confirm: async () => true } }]) {
      // K7-B7.1: NEITHER IS COMPLETE. Both are nonterminal successes; the
      // copy is closed by its closure record and by nothing else.
      expect(['COPY_VERIFIED_RESTORED_AWAITING_CLOSURE',
              'COPY_VERIFIED_AWAITING_MANUAL_RESTORATION'])
        .toContain(terminalOutcomeFor(a))
      expect(terminalOutcomeFor(a)).not.toBe('COMPLETE')
    }
  })
})

// ---------------------------------------------------------------------------
// K7-B6.3 B — ONE CONSTRUCTOR FOR "VERIFIED", AND IT CARRIES THE DIGEST
// ---------------------------------------------------------------------------

describe('K7-B6.3: a verified publication carries its publisher digest', () => {
  const published = (digestFileDigest: string): PublishedEvidence => ({
    finalPath: '/ev/copy-release-gate-20260930T000000Z-aabbccdd',
    temporaryPath: '/ev/.tmp-copy-release-gate-20260930T000000Z-aabbccdd',
    files: ['release-gate.json', 'DIGEST'],
    digestFileDigest,
  })

  it('carries the EXACT digest the publisher returned', () => {
    const digest = 'a1b2c3d4'.repeat(8)
    const e = verifiedEvidence(published(digest))
    expect(e.verified).toBe(true)
    // THE WHOLE POINT: a later cross-link can name AND identify this bundle
    // without reopening a path it could not prove anything about.
    expect(e.digestFileDigest).toBe(digest)
    expect(e.publishedPath).toBe('/ev/copy-release-gate-20260930T000000Z-aabbccdd')
  })

  it('REFUSES a blank, short, uppercase or non-hex digest', () => {
    // A verified publication that cannot be identified is a contradiction.
    // Blanking it is what produced an intervention record naming a bundle
    // beside an empty digest.
    for (const bad of ['', 'a'.repeat(63), 'A'.repeat(64), 'z'.repeat(64),
                       `${'a'.repeat(63)} `, 'not-a-digest']) {
      expect(() => verifiedEvidence(published(bad)), JSON.stringify(bad)).toThrow()
    }
  })

  it('an UNVERIFIED state never carries a digest', () => {
    // `NO_EVIDENCE` and every published-unverified state must be unlinkable as
    // verified evidence, and the absent digest is what makes that structural.
    expect(NO_EVIDENCE_FIXTURE.verified).toBe(false)
    expect(NO_EVIDENCE_FIXTURE.digestFileDigest).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// K7-B6.3.1 B — A POST-PUBLICATION DIGEST FAILURE KEEPS ITS PATH
// ---------------------------------------------------------------------------

describe('K7-B6.3.1: a malformed publisher digest is published-unverified', () => {
  const FINAL = '/ev/copy-release-gate-20260930T000000Z-aabbccdd'
  const published = (digestFileDigest: string): PublishedEvidence => ({
    finalPath: FINAL,
    temporaryPath: '/ev/.tmp-copy-release-gate-20260930T000000Z-aabbccdd',
    files: ['release-gate.json', 'DIGEST'],
    digestFileDigest,
  })

  /**
   * THE PAIR EVERY PUBLICATION CATCH IS BUILT FROM.
   *
   * `verifiedEvidence` throws and `evidenceStateOf` classifies - exactly as
   * the four call sites do. Asserting only that the constructor throws says
   * nothing about whether the ALREADY-PUBLISHED directory survives in the
   * record, which is the property that was wrong: the throw said
   * `publication: 'published'`, and `evidenceStateOf` retains a path only for
   * `published-unverified`, so the state claimed nothing had been published
   * while a complete bundle sat there unreferenced.
   */
  const throughTheCatch = (digest: string): ReturnType<typeof evidenceStateOf> => {
    try {
      verifiedEvidence(published(digest))
      throw new Error('the malformed digest was accepted')
    } catch (e) {
      return evidenceStateOf(e, 'the authorization bundle was not published')
    }
  }

  it('retains the EXACT final path, present, as published-unverified', () => {
    const state = throughTheCatch('')
    // THE DIRECTORY EXISTS AND THE RECORD SAYS SO.
    expect(state.publication).toBe('published-unverified')
    expect(state.publishedPath).toBe(FINAL)
    expect(state.finalPath).toBe(FINAL)
    expect(state.finalPathState).toBe('present')
    // AND IS NOT TREATED AS ABSENT OR AS NOTHING-CREATED.
    expect(state.finalPathState).not.toBe('absent')
    expect(state.publication).not.toBe('refused-nothing-created')
    expect(state.publishedPath).not.toBeNull()
  })

  it('carries verified:false and digestFileDigest:null', () => {
    const state = throughTheCatch('not-a-digest')
    expect(state.verified).toBe(false)
    expect(state.digestFileDigest).toBeNull()
  })

  it('classifies the phase as post-publication VERIFY, not a write phase', () => {
    const state = throughTheCatch('a'.repeat(63))
    // The bundle was written; what failed is identifying it.
    expect(state.evidencePhase).toBe('verify')
    // NO FREE-FORM ERRNO OR PATH LEAK in the reviewed reason slot.
    expect(state.evidenceReason).toBeNull()
  })

  it('names no temporary directory to clear, so nothing may be altered', () => {
    const state = throughTheCatch('')
    // A caller may treat a creation receipt as permission to clear an object.
    // There is none here: this process could not identify the bundle, which is
    // not a licence to delete, rename or chmod it.
    expect(state.temporaryPath).toBeNull()
    expect(state.temporaryPathState).toBe('absent')
  })

  it('a WELL-FORMED digest still produces a verified, identified state', () => {
    const digest = 'a1b2c3d4'.repeat(8)
    const ok = verifiedEvidence(published(digest))
    expect(ok.publication).toBe('published')
    expect(ok.verified).toBe(true)
    expect(ok.digestFileDigest).toBe(digest)
    expect(ok.publishedPath).toBe(FINAL)
  })
})
