// SLICE 10 — the one process that owns the copy from fence to producers.
//
// WHY A LIFECYCLE OWNER EXISTS AT ALL. Stage 2 ends at COMMIT and the verifier
// runs after it, and BOTH of those facts only mean something while one process
// still holds the supervisor's fence. A fence released between COMMIT and
// verification is a window in which the source can move; a fence released
// between verification and authorization is a window in which it can move after
// everything has been proved and before anyone has said the copy may stand. So
// the fence is taken once, by Stage 2, and released exactly once, here, after
// an authorization that has already been written to disk and read back.
//
// THE ORDER IS THE WHOLE DESIGN:
//
//   L1  the published Stage-1 bundle, the confirmation and the reviewed target
//   L2  every reviewed producer is stopped
//   L3  Stage 2 - which TAKES the fence and re-derives the source under it
//   L4  the Stage-2 source snapshot ends; THE FENCE DOES NOT
//   L5  the independent verifier, on fresh sessions, fence still held
//   L6  the final release gate, on the SAME supervisor transaction
//   L7  the release AUTHORIZATION is published and read back, fence still held
//   L8  the fence is released: the supervisor's ROLLBACK, and nothing else
//   L9  the release is PROVED - that backend now holds none of the locks
//   L10 producers are restored, in the reviewed reverse order, each confirmed
//   L11 what actually happened is published, separately
//
// THE TWO BUNDLES ARE NOT ONE BUNDLE. `release-gate-*` says the copy was
// authorized to stand; `copy-lifecycle-*` says what was then done about it.
// Writing one record for both would mean an authorization that failed to
// release, or released and failed to restore, would be indistinguishable from a
// clean run - and the authorization has to be durable BEFORE the release, so it
// cannot be the record that describes it.
//
// EVERY OPERATIONAL EFFECT IS AN INJECTED ADAPTER. Nothing in this module
// knows about launchd, Redis or a shell. That is not only for testing: it is
// what makes the reviewed ORDER the thing under review, separately from the
// mechanism, and it is why the disposable suites can drive the whole lifecycle
// without a single production side effect.

import { join } from 'node:path'

import {
  DIGEST_FILE, EvidencePublicationUnknown, EvidencePublishedButUnverified, EvidenceRefused,
  REAL_EVIDENCE_OPS, evidenceNames, evidenceStamp, newRunId, publishEvidence,
  verifyPublishedEvidence,
  type EvidenceOps, type EvidencePhase, type EvidenceReason, type PublishedEvidence,
  type PublishedPhase,
} from './evidence.js'
import {
  COPY_TABLES, REVIEWED_CONTRACT_DIGEST, canonicalJson,
  type Canonical, type ContractArtifact,
} from './schema-contract.js'
import {
  FENCE_SEQUENCES, SEQUENCE_STATE_SQL, effectiveNext, fenceRelationArray, parseSequenceState,
  type FenceExecutor,
} from './source-fence.js'
import {
  VERIFICATION_FILE, attemptFenceProof, observePath, runVerification,
  type FenceDisposition, type FenceProofResult, type PathState, type VerifyCloseable,
  type VerificationResult, type VerifierHandoff,
} from './verify.js'
import {
  CommitOutcomeUnknown, runApply,
  type ApplyResult, type PublishedManifest,
} from './stage2.js'
import type { DriverSession } from './driver-session.js'
import type { OperatorInput } from './source-manifest.js'
import type { TargetExpectation } from './target-authority.js'

/** Bumped when either published document changes shape. */
export const LIFECYCLE_DOCUMENT_VERSION = 1

export const RELEASE_GATE_PREFIX = 'release-gate'
export const LIFECYCLE_PREFIX = 'copy-lifecycle'
export const RELEASE_GATE_FILE = 'release-gate.json'
export const LIFECYCLE_FILE = 'lifecycle.json'
export const GATE_DETAIL_FILE = 'gate-detail.json'
export const LIFECYCLE_DETAIL_FILE = 'actions.json'

/**
 * THE RELEASE. One statement, and it is the supervisor's own ROLLBACK.
 *
 * NOT a COMMIT: the supervisor transaction took the fence and read sequence
 * state, and committing it would be a write path nobody reviewed. NOT
 * `pg_advisory_unlock`: that drops the advisory lock and leaves all 24 relation
 * locks exactly where they are, which looks like a release and is not one.
 * NOT closing the connection or signalling the backend: both do end the
 * transaction, and both also destroy the session this module then has to PROVE
 * the release on. The fence is a transaction; ending it is how it goes.
 */
export const RELEASE_SQL = 'ROLLBACK'

/** The supervisor's own backend, asked of itself. */
export const SUPERVISOR_ALIVE_SQL = 'SELECT pg_catalog.pg_backend_pid()'

/**
 * Every lock the reviewed fence covers, as held by ONE pid, counted.
 *
 * Used AFTER the release, where the question is the opposite of the one the
 * fence proof asks: not "does this backend hold everything" but "does it hold
 * anything at all". A separate statement rather than a reinterpretation of the
 * proof, because the two have different fail-closed directions and sharing one
 * would make a mistake in either invisible in the other.
 */
export const RELEASED_LOCK_CENSUS_SQL = `
SELECT pg_catalog.count(*)::pg_catalog.text
  FROM pg_catalog.pg_locks l
  LEFT JOIN pg_catalog.pg_class c ON c.oid = l.relation
  LEFT JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
 WHERE l.pid = pg_catalog.pg_backend_pid()
   AND ((l.locktype = 'relation' AND n.nspname || '.' || c.relname = ANY ($1))
     OR (l.locktype = 'advisory'))`

/**
 * WHO IS CONNECTED TO THE SOURCE. Reviewed columns only, and never a query text.
 *
 * `query` is deliberately absent from the SELECT list: it is the one column of
 * `pg_stat_activity` that carries arbitrary SQL, which carries row values, which
 * is exactly what must never reach an error or an evidence bundle.
 */
export const ACTIVITY_CENSUS_SQL = `
SELECT pid::pg_catalog.text,
       COALESCE(usename::pg_catalog.text, ''),
       COALESCE(backend_type, '')
  FROM pg_catalog.pg_stat_activity
 WHERE datname = pg_catalog.current_database()
 ORDER BY 1`

/**
 * The reviewed producers, in the order they are STOPPED.
 *
 * Restoration is this list reversed, and the reason is not symmetry. The worker
 * is what drains the queue; the daily and alert triggers are what fill it.
 * Stopping the fillers first leaves the worker to finish what it already has;
 * restoring the worker first means there is something to consume the first job
 * a trigger submits. Restoring in stop order would put work into a queue with
 * nothing behind it.
 */
export const REVIEWED_PRODUCERS: readonly string[] = Object.freeze([
  'com.thanapol.ai-capital.daily',
  'com.thanapol.ai-capital.alerts',
  'com.thanapol.ai-capital.worker',
])

export const RESTORE_ORDER: readonly string[] = Object.freeze([...REVIEWED_PRODUCERS].reverse())

// ---------------------------------------------------------------------------
// ADAPTERS — every operational effect, behind an interface
// ---------------------------------------------------------------------------

/** One reviewed producer, and whether it is stopped. Reported, never assumed. */
export interface ProducerState {
  readonly name: string
  readonly stopped: boolean
}

/**
 * READ-ONLY. Reports what the producers are doing and changes nothing.
 *
 * Separate from `ProducerAdapter` on purpose: the gate consults quiescence
 * repeatedly and must not be able to alter what it is measuring, and an
 * interface that could start something is an interface a gate could start
 * something with.
 */
export interface QuiescenceAdapter {
  report(): Promise<readonly ProducerState[]>
}

/** One bounded observation of the queues. Depth per reviewed queue name. */
export interface QueueSample {
  readonly depths: Readonly<Record<string, number>>
}

export interface QueueAdapter {
  sample(): Promise<QueueSample>
}

/** The only thing in this module that starts anything. */
export interface ProducerAdapter {
  restore(name: string): Promise<void>
  /** Independently confirm it is running. A `restore` that returned is not proof. */
  confirm(name: string): Promise<boolean>
}

// ---------------------------------------------------------------------------
// PHASES AND REASONS
// ---------------------------------------------------------------------------

export type LifecyclePhase =
  | 'L1-bundle'
  | 'L2-quiescence'
  | 'L3-copy'
  | 'L4-snapshot-end'
  | 'L5-verify'
  | 'L6-release-gate'
  | 'L7-authorization-evidence'
  | 'L8-release'
  | 'L9-release-proof'
  | 'L10-restore'
  | 'L11-outcome-evidence'

/** WHY the lifecycle stopped. A CLOSED union of reviewed sentences. */
export type LifecycleReason =
  | 'the published bundle or reviewed target was not accepted'
  | 'a reviewed producer is not stopped'
  | 'the transactional copy did not complete'
  | 'the Stage-2 source snapshot could not be ended'
  | 'the independent verification did not pass'
  | 'the final release gate refused'
  | 'the release authorization evidence was not published and verified'
  | 'the fence release was not completed'
  | 'the fence release could not be proved'
  | 'a reviewed producer was not restored'
  | 'the lifecycle outcome evidence was not published and verified'

/**
 * WHAT IS KNOWN ABOUT THE FENCE at the moment the lifecycle stopped.
 *
 * The three pre-release states are the verifier's, unchanged. The two
 * post-release states exist because once the ROLLBACK has been issued the
 * question changes completely: `held` is no longer available as an answer, and
 * the honest alternatives are "released, and proved" or "released, and the
 * proof did not come back". Reporting a released fence as held - or as
 * recoverable - would send an operator to look for a lease that is gone.
 */
export type LifecycleFenceState =
  | FenceDisposition
  | 'released'
  | 'released-unproved'

export const LIFECYCLE_FENCE_SENTENCE: Readonly<Record<LifecycleFenceState, string>> =
  Object.freeze({
    held:
      'The COMPLETE source fence was PROVED still held. The source is frozen and this ' +
      'process still owns the lease.',
    'not-held':
      'THE REQUIRED FENCE CONTRACT POSITIVELY FAILED: an independent lock census was taken ' +
      'and read, and it shows a required lock missing or a conflicting request queued. Treat ' +
      'the source as MUTABLE and do not restore producers.',
    unproved:
      'The lifecycle did not release the source fence, but its current state is UNPROVED. ' +
      'Treat the source as MUTABLE and do not restore producers automatically.',
    released:
      'THE FENCE HAS BEEN RELEASED and the release was PROVED: the supervisor backend holds ' +
      'none of the reviewed locks. The lease is gone and cannot be recovered.',
    'released-unproved':
      'THE FENCE HAS BEEN RELEASED and the release was NOT PROVED. The lease is gone and ' +
      'cannot be recovered; producers were NOT restored automatically. A person must ' +
      'establish what the source is doing before anything is started.',
  })

// ---------------------------------------------------------------------------
// INTERVENTION
// ---------------------------------------------------------------------------

/** Registered instances. Membership cannot be read, copied or transferred. */
const LIVE_INTERVENTIONS = new WeakSet<object>()

/** A TYPE-ONLY brand, for compile-time opacity, carrying no runtime authority. */
declare const INTERVENTION: unique symbol

/** The primary failure, preserved verbatim through everything that follows it. */
export interface LifecycleFailure {
  readonly phase: LifecyclePhase
  readonly reason: LifecycleReason
  readonly at: string | null
}

/** What happened to a published bundle, truthfully. */
export interface EvidenceState {
  readonly attempted: boolean
  readonly publishedPath: string | null
  readonly verified: boolean
  readonly note: string | null
}

const NO_EVIDENCE: EvidenceState =
  Object.freeze({ attempted: false, publishedPath: null, verified: false, note: null })

/**
 * SOMETHING FAILED AFTER COMMIT AND BEFORE A PROVED RELEASE. A PERSON MUST LOOK.
 *
 * This is the object the whole slice is arranged around. It retains the live
 * supervisor handle - the fence is still this process's to release, and
 * throwing away the handle would make it unreleasable without killing the
 * backend - and it releases nothing, restores nothing and retries nothing.
 *
 * NON-FORGEABLE BY IDENTITY, not by a property. `isInterventionRequired` asks a
 * module-private WeakSet whether THIS OBJECT is one this module minted. A brand
 * on a field would be readable with `Reflect.ownKeys` and therefore copyable
 * onto an object of somebody's own, and a caller that could fabricate one could
 * fabricate the claim that a fence is safely held.
 */
export class LifecycleInterventionRequired extends Error {
  readonly [Symbol.toStringTag] = 'LifecycleInterventionRequired'
  constructor(
    readonly failure: LifecycleFailure,
    readonly fence: LifecycleFenceState,
    /** The caller's supervisor. RETAINED, never closed, never rolled back here. */
    readonly supervisor: FenceExecutor,
    readonly releaseGateEvidence: EvidenceState = NO_EVIDENCE,
    readonly lifecycleEvidence: EvidenceState = NO_EVIDENCE,
    readonly restored: readonly string[] = [],
    readonly notRestored: readonly string[] = REVIEWED_PRODUCERS,
  ) {
    super(
      'COPY LIFECYCLE STOPPED: INTERVENTION REQUIRED. The target has been committed. ' +
      'Nothing has been cleaned, truncated, migrated, retried or restored. ' +
      `${LIFECYCLE_FENCE_SENTENCE[fence]} ` +
      `${failure.reason} (phase ${failure.phase}` +
      `${failure.at === null ? '' : ` at ${failure.at}`})`)
    this.name = 'LifecycleInterventionRequired'
  }
}

/**
 * Mint an intervention state. THE ONLY PLACE ONE IS REGISTERED.
 *
 * A released fence can never be reported as held or unproved-but-recoverable:
 * that is checked here rather than trusted at every call site, because there
 * are several and only one of them has to be wrong.
 */
function intervention(
  failure: LifecycleFailure, fence: LifecycleFenceState, supervisor: FenceExecutor,
  gate: EvidenceState = NO_EVIDENCE, outcome: EvidenceState = NO_EVIDENCE,
  restored: readonly string[] = [], notRestored: readonly string[] = REVIEWED_PRODUCERS,
): LifecycleInterventionRequired {
  const e = new LifecycleInterventionRequired(
    failure, fence, supervisor, gate, outcome, restored, notRestored)
  LIVE_INTERVENTIONS.add(e)
  return e
}

export function isInterventionRequired(v: unknown): v is LifecycleInterventionRequired {
  return typeof v === 'object' && v !== null && LIVE_INTERVENTIONS.has(v)
}

// ---------------------------------------------------------------------------
// THE RELEASE GATE
// ---------------------------------------------------------------------------

/** Registered authorizations. See `isReleaseAuthorization`. */
const ISSUED_AUTHORIZATIONS = new WeakSet<object>()

/** A TYPE-ONLY brand, for compile-time opacity, carrying no runtime authority. */
declare const RELEASE_AUTHORIZATION: unique symbol

/**
 * PERMISSION TO RELEASE THE FENCE, and the only thing that grants it.
 *
 * Not a boolean, and not a field anyone can set. The release refuses unless it
 * is handed the exact object the gate minted, so "the gate passed" cannot be
 * asserted by a caller, reconstructed from a record, or carried across a run.
 */
export interface ReleaseAuthorization {
  readonly [RELEASE_AUTHORIZATION]: true
  readonly rootDigest: string
  readonly sourceContractDigest: string
  readonly targetContractDigest: string
  readonly sequences: readonly { qname: string; effectiveNext: string }[]
  readonly fence: FenceFactsLike
  readonly producers: readonly ProducerState[]
  readonly queueSamples: readonly QueueSample[]
  readonly activity: { readonly sessions: number; readonly unreviewed: number }
  readonly verifierBundle: string
}

export interface FenceFactsLike {
  readonly supervisorPid: string
  readonly provingPid: string
  readonly relations: number
  readonly ungranted: number
}

export function isReleaseAuthorization(v: unknown): v is ReleaseAuthorization {
  return typeof v === 'object' && v !== null && ISSUED_AUTHORIZATIONS.has(v)
}

/** WHY the gate refused. A CLOSED union; never a measured value. */
export type GateRefusal =
  | 'the supervisor is not the backend that held the fence'
  | 'the complete source fence was not proved held'
  | 'a source sequence has moved since the copy'
  | 'the independent verification did not pass'
  | 'the verifier evidence bundle does not verify from disk'
  | 'the verified chain does not agree with the Stage-2 result'
  | 'a reviewed producer is not stopped'
  | 'the source carries sessions that are not reviewed'
  | 'the queue samples are not empty and stable'

export class ReleaseGateRefused extends Error {
  constructor(readonly refusal: GateRefusal, readonly at: string | null = null) {
    super(`${refusal}${at === null ? '' : ` (at ${at})`}`)
    this.name = 'ReleaseGateRefused'
  }
}

export interface ReleaseGateInput {
  readonly handoff: VerifierHandoff
  readonly verification: VerificationResult
  /** The Stage-1 manifest document the copy was authorised against. */
  readonly publishedDocument: Record<string, never>
  readonly reviewedTarget: ContractArtifact
  /** BORROWED. Read through; never ended, never rolled back by the gate. */
  readonly supervisor: FenceExecutor
  readonly prover: FenceExecutor
  readonly quiescence: QuiescenceAdapter
  readonly queue: QueueAdapter
  /** Backends that may legitimately be connected to the source right now. */
  readonly allowlistedPids: readonly string[]
  readonly allowlistedRoles: readonly string[]
  readonly ops?: EvidenceOps
}

const IDENT = /^[a-z_][a-z0-9_]*$/

/**
 * THE FINAL RELEASE GATE. Everything, proved again, immediately before release.
 *
 * Nothing here is taken from an argument that could have been asserted: the
 * fence is re-proved from an independent backend, the sequences are re-read
 * from the fenced supervisor, the verifier's bundle is re-read FROM DISK rather
 * than believed on the strength of the result object, and the quiescence and
 * queue adapters are consulted again rather than remembered from L2.
 *
 * WHY THE VERIFIER BUNDLE IS READ BACK. `VerificationResult` is an in-memory
 * object this process produced. If the evidence it claims to have published is
 * not on disk and does not verify, then the copy has no durable record - and an
 * authorization that pointed at a record nobody can read would be an
 * authorization for something unauditable.
 */
export async function runReleaseGate(i: ReleaseGateInput): Promise<ReleaseAuthorization> {
  const h = i.handoff
  const ops = i.ops ?? REAL_EVIDENCE_OPS

  // 1. THE SAME LIVE BACKEND.
  let alive: { rows: string[][]; error: 'statement-refused' | null }
  try {
    alive = await i.supervisor.send(SUPERVISOR_ALIVE_SQL)
  } catch {
    throw new ReleaseGateRefused('the supervisor is not the backend that held the fence')
  }
  if (alive.error !== null || (alive.rows[0]?.[0] ?? '') !== h.fence.supervisorPid) {
    throw new ReleaseGateRefused('the supervisor is not the backend that held the fence')
  }

  // 2. THE COMPLETE FENCE, from an independent backend, nothing queued.
  const proof: FenceProofResult =
    await attemptFenceProof(i.prover, h.fence.supervisorPid, h.fence.mechanism)
  if (proof.outcome !== 'held' || proof.facts === null) {
    throw new ReleaseGateRefused('the complete source fence was not proved held', proof.cause)
  }

  // 3. THE VERIFIER PASSED, and its own numbers agree with Stage 2's.
  if (i.verification.outcome !== 'PASS') {
    throw new ReleaseGateRefused('the independent verification did not pass')
  }

  // 4. THE VERIFIER'S BUNDLE VERIFIES FROM DISK, and says PASS in its own bytes.
  const bundle = i.verification.evidence.finalPath
  let files: readonly string[]
  try {
    files = verifyPublishedEvidence(bundle, ops)
  } catch {
    throw new ReleaseGateRefused('the verifier evidence bundle does not verify from disk')
  }
  if (!files.includes(VERIFICATION_FILE) || !files.includes(DIGEST_FILE)) {
    throw new ReleaseGateRefused('the verifier evidence bundle does not verify from disk')
  }
  let recorded: { outcome?: unknown; complete?: unknown }
  try {
    recorded = JSON.parse(
      ops.readFileSync(join(bundle, VERIFICATION_FILE), 'utf-8') as unknown as string) as never
  } catch {
    throw new ReleaseGateRefused('the verifier evidence bundle does not verify from disk')
  }
  if (recorded.outcome !== 'PASS' || recorded.complete !== true) {
    throw new ReleaseGateRefused('the verifier evidence bundle does not verify from disk')
  }

  // 5. THE CHAIN AGREES: identities, contracts, root, table set, sequence set.
  assertChainAgrees(i)

  // 6. THE SEQUENCES, RE-READ FROM THE FENCED SUPERVISOR.
  //
  // Read again rather than carried: between verification and this instant the
  // fence has been held continuously, so these MUST be unchanged - and the only
  // way that sentence is worth anything is if somebody checks.
  const sequences = await readSequences(i.supervisor)
  for (let n = 0; n < FENCE_SEQUENCES.length; n += 1) {
    const q = FENCE_SEQUENCES[n]
    if (sequences[n].qname !== q) {
      throw new ReleaseGateRefused('a source sequence has moved since the copy', q)
    }
    if (sequences[n].effectiveNext !== h.sequences[n].effectiveNext) {
      throw new ReleaseGateRefused('a source sequence has moved since the copy', q)
    }
    const verified = i.verification.sequences[n]
    if (verified === undefined || verified.qname !== q ||
        verified.sourceEffectiveNext !== sequences[n].effectiveNext) {
      throw new ReleaseGateRefused('a source sequence has moved since the copy', q)
    }
  }

  // 7. QUIESCENCE, AGAIN. L2 said so before the copy; a producer restarted
  //    during it would have been writing to the source the whole time.
  const producers = await reportProducers(i.quiescence)

  // 8. WHO IS CONNECTED TO THE SOURCE.
  const activity = await censusActivity(i)

  // 9. TWO BOUNDED QUEUE SAMPLES, both empty and equal to each other. One
  //    sample cannot distinguish an empty queue from a queue caught between
  //    two jobs.
  const queueSamples = await sampleQueues(i.queue)

  const authorization = Object.freeze({
    rootDigest: h.rootDigest,
    sourceContractDigest: h.sourceContractDigest,
    targetContractDigest: h.targetContractDigest,
    sequences: Object.freeze(sequences.map(s => Object.freeze({ ...s }))),
    fence: Object.freeze({ ...proof.facts }),
    producers: Object.freeze(producers.map(p => Object.freeze({ ...p }))),
    queueSamples: Object.freeze(queueSamples),
    activity,
    verifierBundle: bundle,
  })
  // REGISTERED LAST, after every proof above has passed and the object is
  // final. Nothing that failed can carry an identity this module minted.
  ISSUED_AUTHORIZATIONS.add(authorization)
  return authorization as unknown as ReleaseAuthorization
}

/** Every claim in the chain, compared where it can be compared. */
function assertChainAgrees(i: ReleaseGateInput): void {
  const h = i.handoff
  const v = i.verification
  const fail = (at: string): never => {
    throw new ReleaseGateRefused('the verified chain does not agree with the Stage-2 result', at)
  }
  if (h.targetContractDigest !== REVIEWED_CONTRACT_DIGEST) fail('the reviewed target digest')
  if (i.reviewedTarget.digest !== REVIEWED_CONTRACT_DIGEST) fail('the reviewed target artifact')
  if (v.sourceRootDigest !== h.rootDigest) fail('the source root')
  if (v.targetRootDigest !== h.rootDigest) fail('the target root')

  const doc = i.publishedDocument as unknown as {
    content?: { root_digest?: unknown; tables?: Array<{ qname?: unknown; digest?: unknown }> }
    source_contract?: { digest?: unknown }
  }
  if (doc.source_contract?.digest !== h.sourceContractDigest) fail('the published contract digest')
  if (doc.content?.root_digest !== h.rootDigest) fail('the published root digest')
  const published = Array.isArray(doc.content?.tables) ? doc.content.tables : []
  if (published.length !== COPY_TABLES.length) fail('the published table set')

  if (v.tables.length !== COPY_TABLES.length) fail('the verified table set')
  if (h.tables.length !== COPY_TABLES.length) fail('the Stage-2 table set')
  for (let n = 0; n < COPY_TABLES.length; n += 1) {
    const q = COPY_TABLES[n]
    if (v.tables[n].qname !== q || h.tables[n].qname !== q || published[n].qname !== q) fail(q)
    if (v.tables[n].sourceDigest !== h.tables[n].digest) fail(`${q} source digest`)
    if (v.tables[n].targetDigest !== h.tables[n].digest) fail(`${q} target digest`)
    if (published[n].digest !== h.tables[n].digest) fail(`${q} published digest`)
  }
  if (h.sequences.length !== FENCE_SEQUENCES.length) fail('the Stage-2 sequence set')
  if (v.sequences.length !== FENCE_SEQUENCES.length) fail('the verified sequence set')
  // IDENTITIES. Names and cluster identifiers only; nothing routable.
  for (const [what, id] of [['source', h.source], ['target', h.target]] as const) {
    if (!IDENT.test(id.database) || !IDENT.test(id.role)) fail(`the ${what} identity`)
    if (!/^[1-9][0-9]{0,19}$/.test(id.systemIdentifier)) fail(`the ${what} cluster`)
  }
  if (h.source.systemIdentifier === h.target.systemIdentifier) {
    // A copy from a cluster to itself would satisfy every digest comparison in
    // this file and would not be a copy.
    fail('the source and target clusters')
  }
}

export interface SequencePosition {
  readonly qname: string
  readonly effectiveNext: string
}

/** The three fenced sequences, as the supervisor reports them right now. */
async function readSequences(supervisor: FenceExecutor): Promise<SequencePosition[]> {
  const out: SequencePosition[] = []
  for (const q of FENCE_SEQUENCES) {
    let res: { rows: string[][]; error: 'statement-refused' | null }
    try {
      res = await supervisor.send(SEQUENCE_STATE_SQL(q))
    } catch {
      throw new ReleaseGateRefused('a source sequence has moved since the copy', q)
    }
    if (res.error !== null) {
      throw new ReleaseGateRefused('a source sequence has moved since the copy', q)
    }
    try {
      out.push({ qname: q, effectiveNext: effectiveNext(parseSequenceState(res.rows, q), q).toString() })
    } catch {
      throw new ReleaseGateRefused('a source sequence has moved since the copy', q)
    }
  }
  return out
}

/** Every reviewed producer, and all of them stopped. */
async function reportProducers(q: QuiescenceAdapter): Promise<readonly ProducerState[]> {
  let report: readonly ProducerState[]
  try {
    report = await q.report()
  } catch {
    throw new ReleaseGateRefused('a reviewed producer is not stopped')
  }
  if (report.length !== REVIEWED_PRODUCERS.length) {
    throw new ReleaseGateRefused('a reviewed producer is not stopped')
  }
  for (let n = 0; n < REVIEWED_PRODUCERS.length; n += 1) {
    if (report[n].name !== REVIEWED_PRODUCERS[n] || report[n].stopped !== true) {
      throw new ReleaseGateRefused('a reviewed producer is not stopped', REVIEWED_PRODUCERS[n])
    }
  }
  return report
}

/**
 * Who is connected to the source, and is every one of them reviewed.
 *
 * Counted, never listed. A pid and a role name are the only things compared,
 * and the refusal carries a COUNT: a session nobody expected is a fact worth
 * refusing on, and its application name is arbitrary operator-supplied text.
 */
async function censusActivity(
  i: ReleaseGateInput,
): Promise<{ sessions: number; unreviewed: number }> {
  let res: { rows: string[][]; error: 'statement-refused' | null }
  try {
    res = await i.prover.send(ACTIVITY_CENSUS_SQL)
  } catch {
    throw new ReleaseGateRefused('the source carries sessions that are not reviewed')
  }
  if (res.error !== null) {
    throw new ReleaseGateRefused('the source carries sessions that are not reviewed')
  }
  let unreviewed = 0
  for (const row of res.rows) {
    if (row.length !== 3) {
      throw new ReleaseGateRefused('the source carries sessions that are not reviewed')
    }
    const [pid, role, backendType] = row
    // Background workers are the server's own and have no role.
    if (backendType !== '' && backendType !== 'client backend') continue
    if (i.allowlistedPids.includes(pid)) continue
    if (i.allowlistedRoles.includes(role)) continue
    unreviewed += 1
  }
  if (unreviewed > 0) {
    throw new ReleaseGateRefused(
      'the source carries sessions that are not reviewed', `${unreviewed} session(s)`)
  }
  return { sessions: res.rows.length, unreviewed }
}

/** Two bounded samples. Both empty, and equal to each other. */
async function sampleQueues(q: QueueAdapter): Promise<readonly QueueSample[]> {
  const samples: QueueSample[] = []
  for (let n = 0; n < 2; n += 1) {
    try {
      samples.push(await q.sample())
    } catch {
      throw new ReleaseGateRefused('the queue samples are not empty and stable')
    }
  }
  for (const s of samples) {
    for (const [name, depth] of Object.entries(s.depths)) {
      if (!Number.isSafeInteger(depth) || depth !== 0) {
        throw new ReleaseGateRefused('the queue samples are not empty and stable', name)
      }
    }
  }
  if (canonicalJson(samples[0].depths as Canonical) !==
      canonicalJson(samples[1].depths as Canonical)) {
    throw new ReleaseGateRefused('the queue samples are not empty and stable')
  }
  return Object.freeze(samples.map(s => Object.freeze({ depths: Object.freeze({ ...s.depths }) })))
}


// ---------------------------------------------------------------------------
// RELEASE AND RESTORATION
// ---------------------------------------------------------------------------

/** What the release established. Three answers, and only one of them is proof. */
export interface ReleaseResult {
  readonly state: 'released' | 'released-unproved'
  /** Reviewed locks still held by the supervisor backend. 0 when proved. */
  readonly remainingLocks: number | null
}

/**
 * RELEASE THE FENCE, and then PROVE it, in that order and no other.
 *
 * REFUSES WITHOUT THE AUTHORIZATION OBJECT ITSELF. Not a flag, not a field, not
 * a record read back from the bundle - the exact object `runReleaseGate`
 * minted, checked by identity against a module-private registry. A caller that
 * could assert its way past this could release a fence that nothing had
 * authorized.
 *
 * AFTER THE ROLLBACK THERE IS NO GOING BACK, and that shapes what may be said.
 * The lease is gone whether or not the proof comes back, so a failed proof is
 * `released-unproved` - never `unproved`, which would imply the fence might
 * still be this process's to hold, and never `held`, which would be false.
 */
export async function releaseFence(
  supervisor: FenceExecutor, authorization: ReleaseAuthorization,
): Promise<ReleaseResult> {
  if (!isReleaseAuthorization(authorization)) {
    throw new ReleaseGateRefused('the complete source fence was not proved held')
  }

  // THE RELEASE. One statement, on the supervisor, and this is the only place
  // in this module that sends it.
  const released = await supervisor.send(RELEASE_SQL)
  if (released.error !== null) {
    // The transaction did not end, so the fence is still held - and this is
    // NOT a release that failed to prove. Reported as a plain refusal so the
    // caller stays on the intervention path with the lease intact.
    throw new ReleaseGateRefused('the complete source fence was not proved held', 'the rollback')
  }

  // THE PROOF, on the supervisor's own backend, which is the only session that
  // can answer "do I still hold anything" about itself.
  try {
    const census = await supervisor.send(
      RELEASED_LOCK_CENSUS_SQL.replace('$1', fenceRelationArray()))
    if (census.error !== null) return { state: 'released-unproved', remainingLocks: null }
    const n = Number(census.rows[0]?.[0] ?? NaN)
    if (!Number.isSafeInteger(n) || n < 0) {
      return { state: 'released-unproved', remainingLocks: null }
    }
    if (n !== 0) return { state: 'released-unproved', remainingLocks: n }
    return { state: 'released', remainingLocks: 0 }
  } catch {
    return { state: 'released-unproved', remainingLocks: null }
  }
}

export interface RestorationResult {
  readonly restored: readonly string[]
  readonly notRestored: readonly string[]
  readonly failedAt: string | null
}

/**
 * Restore the producers, in the reviewed REVERSE order, each one confirmed.
 *
 * STOPS AT THE FIRST FAILURE and says exactly where. It does not skip ahead,
 * retry, or start the rest anyway: a producer that would not come back is a
 * reason for a person to look, and starting the others on top of it turns one
 * known problem into an unknown number of them.
 *
 * `restore` returning is not evidence. `confirm` is asked separately, because
 * a launch command that exits zero and a job that is running are different
 * facts and the reviewed order depends on the second one.
 */
export async function restoreProducers(a: ProducerAdapter): Promise<RestorationResult> {
  const restored: string[] = []
  for (const name of RESTORE_ORDER) {
    let ok = false
    try {
      await a.restore(name)
      ok = await a.confirm(name) === true
    } catch {
      ok = false
    }
    if (!ok) {
      return Object.freeze({
        restored: Object.freeze([...restored]),
        notRestored: Object.freeze(RESTORE_ORDER.filter(n => !restored.includes(n))),
        failedAt: name,
      })
    }
    restored.push(name)
  }
  return Object.freeze({
    restored: Object.freeze([...restored]), notRestored: Object.freeze([]), failedAt: null,
  })
}

// ---------------------------------------------------------------------------
// EVIDENCE
// ---------------------------------------------------------------------------

/** Where a lifecycle publication stopped, and therefore what is on disk. */
export type LifecyclePublication =
  | 'published'
  | 'refused-nothing-created'
  | 'retained-temporary'
  | 'destination-occupied'
  | 'state-unproved'
  | 'published-unverified'
  | 'unknown'

export class LifecycleEvidenceFailed extends Error {
  constructor(
    readonly prefix: string,
    readonly publication: LifecyclePublication,
    readonly evidencePhase: EvidencePhase | PublishedPhase,
    readonly evidenceReason: EvidenceReason | null,
    readonly finalPath: string,
    readonly finalPathState: PathState,
    readonly temporaryPath: string | null,
    readonly temporaryPathState: PathState,
  ) {
    super(
      `${prefix} evidence: ${publication} (${evidenceReason ?? 'no reviewed reason'}) ` +
      `at ${evidencePhase}`)
    this.name = 'LifecycleEvidenceFailed'
  }
}

export interface LifecycleBundleInput {
  readonly root: string
  readonly prefix: string
  readonly stamp: string
  readonly runId: string
  readonly manifestFile: string
  readonly detailFile: string
  readonly manifest: Canonical
  readonly detail: Canonical
  readonly ops?: EvidenceOps
}

/**
 * Publish one bundle and read it back, preserving the exact outcome.
 *
 * The same six-way classification the verifier uses, for the same reason: "a
 * temporary directory was retained" names a path a collision never created,
 * and "nothing was published" is false about a bundle sitting under its final
 * name. Each is distinguished by asking the filesystem in three states rather
 * than inferring from the phase.
 */
export function publishLifecycleBundle(i: LifecycleBundleInput): PublishedEvidence {
  const ops = i.ops ?? REAL_EVIDENCE_OPS
  const bytes = (v: Canonical): Buffer => Buffer.from(`${canonicalJson(v)}\n`, 'utf-8')
  try {
    return publishEvidence({
      root: i.root, prefix: i.prefix, stamp: i.stamp, runId: i.runId,
      artifacts: [{ path: i.detailFile, bytes: bytes(i.detail) }],
      manifest: { path: i.manifestFile, bytes: bytes(i.manifest) },
    }, ops)
  } catch (e) {
    let finalPath = i.root
    let temporaryPath: string | null = null
    try {
      const names = evidenceNames(i.prefix, i.stamp, i.runId)
      finalPath = join(i.root, names.finalName)
      temporaryPath = join(i.root, names.temporaryName)
    } catch { /* the names themselves were refused; the root is all there is */ }

    if (e instanceof EvidencePublishedButUnverified) {
      throw new LifecycleEvidenceFailed(
        i.prefix, 'published-unverified', e.phase, null, finalPath, 'present', null, 'absent')
    }
    if (e instanceof EvidencePublicationUnknown) {
      throw new LifecycleEvidenceFailed(
        i.prefix, 'unknown', 'publish', null,
        finalPath, 'unproved', temporaryPath, 'unproved')
    }
    const phase: EvidencePhase = e instanceof EvidenceRefused ? e.phase : 'publish'
    const reason: EvidenceReason | null = e instanceof EvidenceRefused ? e.reason : null
    const finalState = observePath(finalPath, ops)
    const tempState = temporaryPath === null ? 'unproved' : observePath(temporaryPath, ops)
    const createdNothing = ['root', 'name', 'collision'].includes(phase)
    const created = !createdNothing && tempState === 'present'
    const publication: LifecyclePublication =
      finalState === 'unproved' || tempState === 'unproved' ? 'state-unproved'
        : created ? 'retained-temporary'
          : finalState === 'present' || tempState === 'present' ? 'destination-occupied'
            : 'refused-nothing-created'
    throw new LifecycleEvidenceFailed(
      i.prefix, publication, phase, reason,
      finalPath, finalState, created ? temporaryPath : null, tempState)
  }
}

const authorizationDocument = (
  a: ReleaseAuthorization, h: VerifierHandoff, runId: string, stamp: string,
): Canonical => ({
  release_gate_version: LIFECYCLE_DOCUMENT_VERSION,
  complete: true,
  // WHAT THIS RECORD IS, stated in it. An authorization is permission for the
  // fence to be released; it is not a claim that it was, and a reader who found
  // only this bundle must not conclude the lifecycle finished.
  record: 'authorization-to-release',
  authorized: true,
  released: null,
  producers_restored: null,
  run: { id: runId, stamp },
  bundle: { name: h.bundleName, verifier: a.verifierBundle },
  content: {
    root_digest: a.rootDigest,
    source_contract_digest: a.sourceContractDigest,
    target_contract_digest: a.targetContractDigest,
    tables: h.tables.map(t => ({ qname: t.qname, digest: t.digest, rows: t.rows })),
  },
  sequences: a.sequences.map(s => ({ qname: s.qname, effective_next: s.effectiveNext })),
  source: { system_identifier: h.source.systemIdentifier, database: h.source.database,
            role: h.source.role },
  target: { system_identifier: h.target.systemIdentifier, database: h.target.database,
            role: h.target.role },
  fence: { supervisor_pid: a.fence.supervisorPid, proving_pid: a.fence.provingPid,
           relations: a.fence.relations, ungranted: a.fence.ungranted, disposition: 'held' },
  quiescence: a.producers.map(p => ({ name: p.name, stopped: p.stopped })),
  queue_samples: a.queueSamples.map(s => ({ depths: s.depths })),
  activity: { sessions: a.activity.sessions, unreviewed: a.activity.unreviewed },
})

const gateDetailDocument = (a: ReleaseAuthorization): Canonical => ({
  compatibility_root: a.rootDigest,
  sequences: a.sequences.map(s => ({ qname: s.qname, effective_next: s.effectiveNext })),
  producers: a.producers.map(p => ({ name: p.name, stopped: p.stopped })),
  queue_samples: a.queueSamples.map(s => ({ depths: s.depths })),
  restore_order: [...RESTORE_ORDER],
})

const outcomeDocument = (
  h: VerifierHandoff, fence: LifecycleFenceState, release: ReleaseResult | null,
  restoration: RestorationResult | null, gateBundle: string | null,
  failure: LifecycleFailure | null, runId: string, stamp: string,
): Canonical => ({
  lifecycle_version: LIFECYCLE_DOCUMENT_VERSION,
  complete: true,
  record: 'lifecycle-outcome',
  run: { id: runId, stamp },
  bundle: { name: h.bundleName, release_gate: gateBundle },
  outcome: failure === null ? 'COMPLETE' : 'STOPPED',
  failure: failure === null
    ? null
    : { phase: failure.phase, reason: failure.reason, at: failure.at },
  fence: {
    state: fence,
    sentence: LIFECYCLE_FENCE_SENTENCE[fence],
    remaining_locks: release?.remainingLocks ?? null,
  },
  release: release === null ? null : { state: release.state },
  restoration: restoration === null ? null : {
    order: [...RESTORE_ORDER],
    restored: [...restoration.restored],
    not_restored: [...restoration.notRestored],
    failed_at: restoration.failedAt,
  },
  content: { root_digest: h.rootDigest, source_contract_digest: h.sourceContractDigest,
             target_contract_digest: h.targetContractDigest },
})

const actionsDocument = (
  release: ReleaseResult | null, restoration: RestorationResult | null,
): Canonical => ({
  release_statement: release === null ? null : RELEASE_SQL,
  release_state: release === null ? null : release.state,
  remaining_locks: release?.remainingLocks ?? null,
  restore_order: [...RESTORE_ORDER],
  restored: restoration === null ? [] : [...restoration.restored],
  not_restored: restoration === null ? [...RESTORE_ORDER] : [...restoration.notRestored],
})

export {
  authorizationDocument, gateDetailDocument, outcomeDocument, actionsDocument, NO_EVIDENCE,
}

// ---------------------------------------------------------------------------
// THE LIFECYCLE
// ---------------------------------------------------------------------------

/**
 * OWNERSHIP IS RECORDED, NOT REMEMBERED.
 *
 * The supervisor and the prover belong to the caller: the fence lives in the
 * supervisor's transaction, the caller opened both, and this module closes
 * neither. Everything else it opens itself and closes exactly once, in the
 * reviewed order, on every path out.
 */
export interface LifecycleInput {
  /** BORROWED. The fence lives in this transaction; never closed here. */
  readonly supervisor: FenceExecutor
  /** BORROWED. A different backend. Never closed here. */
  readonly prover: FenceExecutor
  /** OWNED. Stage 2's single source snapshot. */
  readonly openStageSource: () => Promise<DriverSession>
  /** OWNED BY `runApply`, which ends it. Constructed only after A5 passes. */
  readonly openStageTarget: () => Promise<DriverSession>
  /** OWNED. The verifier's fresh sessions, opened per verification. */
  readonly openVerifySource: () => Promise<VerifyCloseable>
  readonly openVerifyTarget: () => Promise<VerifyCloseable>

  readonly published: PublishedManifest
  readonly reviewedTarget: ContractArtifact
  readonly operator: OperatorInput
  readonly sourceBeginSql: string
  readonly targetExpectation: TargetExpectation
  readonly confirmation: string

  readonly quiescence: QuiescenceAdapter
  readonly queue: QueueAdapter
  readonly producers: ProducerAdapter
  readonly allowlistedPids: readonly string[]
  readonly allowlistedRoles: readonly string[]

  readonly evidenceRoot: string
  readonly runIds?: { verification?: string; releaseGate?: string; lifecycle?: string }
  readonly stamp?: string
  readonly ops?: EvidenceOps
}

export interface LifecycleResult {
  readonly outcome: 'COMPLETE'
  readonly rootDigest: string
  readonly verifierBundle: string
  readonly releaseGateBundle: string
  readonly lifecycleBundle: string
  readonly restored: readonly string[]
  readonly fence: 'released'
}

/**
 * L2 and the gate share ONE quiescence contract, so the reviewed producer list
 * is compared against what the adapter reports in exactly one place.
 */
export async function assertQuiescent(q: QuiescenceAdapter): Promise<readonly ProducerState[]> {
  return await reportProducers(q)
}

/**
 * THE WHOLE LIFECYCLE, in the reviewed order, owning what it opened.
 *
 * WHERE THE LINE IS. Before Stage 2 commits, a failure is an ordinary refusal:
 * nothing has moved and the caller can try again. From COMMIT until the release
 * is PROVED, every failure raises `LifecycleInterventionRequired` - the fence is
 * not released, no producer is restored, nothing is retried, and the primary
 * failure is preserved whatever else happens on the way out. After a proved
 * release the fence is gone and cannot be described as anything else, so a
 * restoration failure reports `released` with an exact boundary rather than
 * pretending the lease is still available.
 *
 * WHY THE AUTHORIZATION IS PUBLISHED BEFORE THE RELEASE. The record has to be
 * durable while the thing it authorizes is still reversible. Publishing it
 * afterwards would mean a crash between the release and the write left a fence
 * released on the strength of nothing anyone can read.
 */
export async function runLifecycle(i: LifecycleInput): Promise<LifecycleResult> {
  const ops = i.ops ?? REAL_EVIDENCE_OPS
  const stamp = i.stamp ?? evidenceStamp(new Date())
  const runIds = {
    verification: i.runIds?.verification ?? newRunId(),
    releaseGate: i.runIds?.releaseGate ?? newRunId(),
    lifecycle: i.runIds?.lifecycle ?? newRunId(),
  }

  let stageSource: DriverSession | null = null
  let gateEvidence: EvidenceState = NO_EVIDENCE
  let outcomeEvidence: EvidenceState = NO_EVIDENCE
  let committed = false
  let applied: ApplyResult | null = null
  let verification: VerificationResult | null = null
  let authorization: ReleaseAuthorization | null = null
  let release: ReleaseResult | null = null
  let restoration: RestorationResult | null = null

  /** Publish the outcome record, best effort, and say truthfully what happened. */
  const recordOutcome = (
    fence: LifecycleFenceState, failure: LifecycleFailure | null, gateBundle: string | null,
  ): EvidenceState => {
    const h = applied?.verification
    if (h === undefined) {
      return { attempted: false, publishedPath: null, verified: false,
               note: 'no Stage-2 result to describe' }
    }
    try {
      const p = publishLifecycleBundle({
        root: i.evidenceRoot, prefix: LIFECYCLE_PREFIX, stamp, runId: runIds.lifecycle,
        manifestFile: LIFECYCLE_FILE, detailFile: LIFECYCLE_DETAIL_FILE,
        manifest: outcomeDocument(
          h, fence, release, restoration, gateBundle, failure, runIds.lifecycle, stamp),
        detail: actionsDocument(release, restoration),
        ops,
      })
      return { attempted: true, publishedPath: p.finalPath, verified: true, note: null }
    } catch (e) {
      const f = e instanceof LifecycleEvidenceFailed ? e : null
      return {
        attempted: true,
        publishedPath: f?.publication === 'published-unverified' ? f.finalPath : null,
        verified: false,
        note: f === null ? 'the outcome bundle was not published' : f.publication,
      }
    }
  }

  /** Every failure from COMMIT onwards funnels through here. */
  const stop = async (
    phase: LifecyclePhase, reason: LifecycleReason, at: string | null,
  ): Promise<never> => {
    const failure: LifecycleFailure = { phase, reason, at }
    // WHAT IS ACTUALLY KNOWN ABOUT THE FENCE. Never assumed, and never `held`
    // once a release has been issued.
    let fence: LifecycleFenceState
    if (release !== null) {
      fence = release.state
    } else {
      const p = await attemptFenceProof(
        i.prover, applied?.verification.fence.supervisorPid ?? '', 'S3')
      fence = p.outcome === 'held' ? 'held' : p.outcome === 'invalid' ? 'not-held' : 'unproved'
    }
    outcomeEvidence = recordOutcome(fence, failure, gateEvidence.publishedPath)
    throw intervention(
      failure, fence, i.supervisor, gateEvidence, outcomeEvidence,
      restoration?.restored ?? [], restoration?.notRestored ?? REVIEWED_PRODUCERS)
  }

  try {
    // L1. The bundle and the reviewed target, validated before anything opens.
    if (i.published.contract.digest === '' ||
        i.reviewedTarget.digest !== REVIEWED_CONTRACT_DIGEST) {
      throw new LifecycleRefused(
        'L1-bundle', 'the published bundle or reviewed target was not accepted')
    }

    // L2. QUIESCENCE, before the fence is even taken. A producer still running
    // here would be writing to the source that Stage 2 is about to freeze.
    try {
      await assertQuiescent(i.quiescence)
    } catch (e) {
      throw new LifecycleRefused(
        'L2-quiescence', 'a reviewed producer is not stopped',
        e instanceof ReleaseGateRefused ? e.at : null)
    }

    // L3. STAGE 2. Takes the fence on the borrowed supervisor and holds it.
    stageSource = await i.openStageSource()
    try {
      applied = await runApply({
        supervisor: i.supervisor, prover: i.prover, source: stageSource,
        operator: i.operator, sourceBeginSql: i.sourceBeginSql,
        reviewedTarget: i.reviewedTarget,
        targetExpectation: i.targetExpectation, confirmation: i.confirmation,
        openTarget: i.openStageTarget,
      }, i.published)
    } catch (e) {
      if (e instanceof CommitOutcomeUnknown) {
        committed = true
        await stop('L3-copy', 'the transactional copy did not complete', 'the commit outcome')
      }
      throw new LifecycleRefused('L3-copy', 'the transactional copy did not complete')
    }
    committed = true

    // L4. THE STAGE-2 SNAPSHOT ENDS. THE FENCE DOES NOT. Ending the source
    // transaction frees the snapshot the copy read in; the fence lives in the
    // SUPERVISOR's transaction and is untouched by this.
    try {
      await stageSource.rows(RELEASE_SQL)
      await stageSource.end()
      stageSource = null
    } catch {
      await stop('L4-snapshot-end', 'the Stage-2 source snapshot could not be ended', null)
    }

    // L5. THE INDEPENDENT VERIFIER, on fresh sessions, fence still held.
    try {
      verification = await runVerification({
        handoff: applied.verification,
        publishedDocument: i.published.document,
        supervisor: i.supervisor, prover: i.prover,
        openSource: i.openVerifySource, openTarget: i.openVerifyTarget,
        reviewedTarget: i.reviewedTarget,
        evidenceRoot: i.evidenceRoot, runId: runIds.verification, stamp, ops,
      })
    } catch {
      // The verifier's own failure is already durable in its FAIL bundle where
      // it managed to publish one. Nothing here reproduces what it said.
      await stop('L5-verify', 'the independent verification did not pass', null)
    }

    // L6. THE FINAL GATE, on the SAME supervisor transaction.
    try {
      authorization = await runReleaseGate({
        handoff: applied.verification,
        verification: verification as VerificationResult,
        publishedDocument: i.published.document,
        reviewedTarget: i.reviewedTarget,
        supervisor: i.supervisor, prover: i.prover,
        quiescence: i.quiescence, queue: i.queue,
        allowlistedPids: i.allowlistedPids, allowlistedRoles: i.allowlistedRoles,
        ops,
      })
    } catch (e) {
      await stop('L6-release-gate', 'the final release gate refused',
                 e instanceof ReleaseGateRefused ? e.refusal : null)
    }

    // L7. THE AUTHORIZATION, PUBLISHED AND READ BACK, FENCE STILL HELD.
    try {
      const p = publishLifecycleBundle({
        root: i.evidenceRoot, prefix: RELEASE_GATE_PREFIX, stamp, runId: runIds.releaseGate,
        manifestFile: RELEASE_GATE_FILE, detailFile: GATE_DETAIL_FILE,
        manifest: authorizationDocument(
          authorization as ReleaseAuthorization, applied.verification,
          runIds.releaseGate, stamp),
        detail: gateDetailDocument(authorization as ReleaseAuthorization),
        ops,
      })
      gateEvidence = { attempted: true, publishedPath: p.finalPath, verified: true, note: null }
    } catch (e) {
      const f = e instanceof LifecycleEvidenceFailed ? e : null
      gateEvidence = {
        attempted: true,
        publishedPath: f?.publication === 'published-unverified' ? f.finalPath : null,
        verified: false,
        note: f === null ? 'the authorization bundle was not published' : f.publication,
      }
      await stop('L7-authorization-evidence',
                 'the release authorization evidence was not published and verified',
                 f?.publication ?? null)
    }

    // L8/L9. THE RELEASE, AND ITS PROOF. One ROLLBACK, then a census on that
    // same backend. Nothing between them.
    try {
      release = await releaseFence(i.supervisor, authorization as ReleaseAuthorization)
    } catch (e) {
      await stop('L8-release', 'the fence release was not completed',
                 e instanceof ReleaseGateRefused ? e.refusal : null)
    }
    if ((release as ReleaseResult).state !== 'released') {
      // RELEASED, AND NOT PROVED. The lease is gone; producers stay down.
      await stop('L9-release-proof', 'the fence release could not be proved', null)
    }

    // L10. RESTORATION, and only now. Reviewed reverse order, each confirmed.
    restoration = await restoreProducers(i.producers)
    if (restoration.failedAt !== null) {
      await stop('L10-restore', 'a reviewed producer was not restored', restoration.failedAt)
    }

    // L11. WHAT ACTUALLY HAPPENED, published separately from the authorization.
    outcomeEvidence = recordOutcome('released', null, gateEvidence.publishedPath)
    if (!outcomeEvidence.verified) {
      await stop('L11-outcome-evidence',
                 'the lifecycle outcome evidence was not published and verified',
                 outcomeEvidence.note)
    }

    return Object.freeze({
      outcome: 'COMPLETE',
      rootDigest: applied.rootDigest,
      verifierBundle: (verification as VerificationResult).evidence.finalPath,
      releaseGateBundle: gateEvidence.publishedPath as string,
      lifecycleBundle: outcomeEvidence.publishedPath as string,
      restored: restoration.restored,
      fence: 'released',
    })
  } finally {
    // OWNED SESSIONS ONLY, exactly once. The Stage-2 target is `runApply`'s and
    // is already gone; the verifier's sessions are its own and likewise. What
    // is left is the Stage-2 source, and only if it is still open.
    if (stageSource !== null) {
      try { await stageSource.rows(RELEASE_SQL) } catch { /* bounded */ }
      try { await stageSource.end() } catch { /* bounded */ }
    }
    // The supervisor and the prover are the CALLER'S. Not closed, not rolled
    // back - the release above is the one statement this module ever sends to
    // end that transaction, and it happens only with an authorization in hand.
    void committed
  }
}

/**
 * A refusal BEFORE the copy committed. The target is provably untouched.
 *
 * Kept distinct from `LifecycleInterventionRequired` for the reason that
 * distinction exists at all: this one means a caller may fix the problem and
 * run again, and that one means nobody may do anything until a person looks.
 */
export class LifecycleRefused extends Error {
  constructor(
    readonly phase: LifecyclePhase,
    readonly reason: LifecycleReason,
    readonly at: string | null = null,
  ) {
    super(`${reason} (phase ${phase}${at === null ? '' : ` at ${at}`})`)
    this.name = 'LifecycleRefused'
  }
}

export { reportProducers as reportReviewedProducers }
