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

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  DIGEST_FILE, EvidencePublicationUnknown, EvidencePublishedButUnverified, EvidenceRefused,
  REAL_EVIDENCE_OPS, evidenceNames, evidenceStamp, newRunId, publishEvidence,
  verifyPublishedEvidence,
  type EvidenceOps, type EvidencePhase, type EvidenceReason, type PublishedEvidence,
  type PublishedPhase,
} from './evidence.js'
import {
  COPY_TABLES, REVIEWED_CONTRACT_DIGEST, canonicalJson, contractDigest, sha256Hex,
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
  CommitOutcomeUnknown, isVerifiedBundle, readPublishedBundle, runApply,
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
 * THE REVIEWED QUEUES, by name. Exactly these, and all of them.
 *
 * A sample is only evidence if it is evidence ABOUT SOMETHING. An adapter that
 * returned `{}` - because it could not reach Redis, because a queue was renamed,
 * because a bug swallowed the list - satisfied "every depth is zero" the way an
 * empty room satisfies "everyone here is asleep", twice, and the gate read two
 * empty objects as a quiet system. The set is named here, so a missing queue is
 * a refusal rather than a pass.
 */
export const REVIEWED_QUEUES: readonly string[] = Object.freeze([
  'ai-capital-daily',
  'ai-capital-alerts',
])

/**
 * HOW LONG ANY OPERATIONAL ADAPTER MAY TAKE.
 *
 * Every adapter here is somebody else's code reaching somebody else's daemon. A
 * `launchctl` that never returns, a Redis connection that hangs mid-handshake -
 * neither raises, and an `await` on either one stops the lifecycle forever WITH
 * THE FENCE HELD. That is the worst outcome available: the source stays frozen,
 * the producers stay down, and nothing ever reports why. A bounded refusal that
 * names the adapter is strictly better than a process that is still waiting.
 */
export const ADAPTER_DEADLINE_MS = 30_000

/** What every adapter call is given: a way to know it has been abandoned. */
export interface AdapterContext {
  readonly signal: AbortSignal
}

/**
 * READ-ONLY. Reports what the producers are doing and changes nothing.
 *
 * Separate from `ProducerAdapter` on purpose: the gate consults quiescence
 * repeatedly and must not be able to alter what it is measuring.
 */
export interface QuiescenceAdapter {
  report(ctx: AdapterContext): Promise<readonly ProducerState[]>
}

/** One bounded observation of the queues. Depth per REVIEWED queue name. */
export interface QueueSample {
  readonly depths: Readonly<Record<string, number>>
}

export interface QueueAdapter {
  sample(ctx: AdapterContext): Promise<QueueSample>
}

/** The only thing in this module that starts anything. */
export interface ProducerAdapter {
  restore(name: string, ctx: AdapterContext): Promise<void>
  /** Independently confirm it is running. A `restore` that returned is not proof. */
  confirm(name: string, ctx: AdapterContext): Promise<boolean>
}

/** An adapter call that did not finish in time. Never carries what it was doing. */
export class AdapterDeadlineExceeded extends Error {
  constructor(readonly adapter: string) {
    super(`the ${adapter} adapter did not answer within the reviewed deadline`)
    this.name = 'AdapterDeadlineExceeded'
  }
}

/**
 * Run one adapter call under a real deadline, and abandon it if it overruns.
 *
 * THE TIMER IS ALWAYS CLEARED. An un-cleared timer keeps the event loop alive,
 * which turns "the lifecycle refused promptly" into "the process would not
 * exit" - a different way of hanging, reached by the code that exists to stop
 * hanging. The signal is aborted too, so an adapter that is listening can stop
 * whatever it started rather than completing into a lifecycle that has gone.
 */
export async function withDeadline<T>(
  adapter: string, ms: number, run: (ctx: AdapterContext) => Promise<T>,
): Promise<T> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | null = null
  try {
    return await Promise.race([
      run({ signal: controller.signal }),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          controller.abort()
          reject(new AdapterDeadlineExceeded(adapter))
        }, ms)
      }),
    ])
  } finally {
    if (timer !== null) clearTimeout(timer)
  }
}

/**
 * A REVIEWED SESSION: one backend, one role, both named.
 *
 * NOT A ROLE LIST. An allowlist of roles authorises a ROLE, and the copy's
 * export role is exactly the role anything reading the source would be using -
 * so a second connection as that role, opened by anyone for any reason, was
 * indistinguishable from the lifecycle's own. What is actually reviewed is a
 * specific backend, doing a specific job, under a specific role.
 */
export interface ReviewedSession {
  readonly pid: string
  readonly role: string
}

/**
 * The backend types the server owns, accepted because they are not client
 * sessions at all and cannot hold a client's locks or write a client's rows.
 *
 * A CLOSED LIST. "Anything that is not a client backend" would admit a type
 * PostgreSQL adds in a future release, and the point of the census is that
 * nothing unexamined is connected to the source.
 */
export const REVIEWED_BACKEND_TYPES: readonly string[] = Object.freeze([
  'autovacuum launcher', 'autovacuum worker', 'background writer', 'checkpointer',
  'logical replication launcher', 'walwriter', 'archiver', 'startup', 'walsender',
  'walreceiver', 'slotsync worker', 'io worker', 'parallel worker',
])

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
  | 'release-unknown'

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
      'THE ROLLBACK WAS ACKNOWLEDGED, so the fence has been released - and the release was ' +
      'NOT PROVED. The lease is gone and cannot be recovered; producers were NOT restored ' +
      'automatically. A person must establish what the source is doing before anything is ' +
      'started.',
    'release-unknown':
      'THE ROLLBACK WAS ATTEMPTED AND ITS OUTCOME IS NOT KNOWN. The transport failed before ' +
      'any acknowledgement came back, so PostgreSQL may have applied the statement or may ' +
      'never have received it: the fence may still be held, or may already be gone. It has ' +
      'NOT been retried and producers were NOT restored. A person must establish what that ' +
      'backend is doing before anything is started or run again.',
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

/**
 * WHAT HAPPENED TO A PUBLISHED BUNDLE, in full.
 *
 * A `note` naming the disposition threw away everything a person needs to act:
 * which phase the publisher stopped at, its own reviewed reason, which paths
 * exist and which could not be examined. Reducing "a complete bundle is
 * retained at this path" to one word is how an operator ends up looking for
 * nothing.
 */
export interface EvidenceState {
  readonly attempted: boolean
  readonly publishedPath: string | null
  readonly verified: boolean
  readonly note: string | null
  readonly publication: LifecyclePublication | null
  readonly evidencePhase: EvidencePhase | PublishedPhase | null
  readonly evidenceReason: EvidenceReason | null
  readonly finalPath: string | null
  readonly finalPathState: PathState | null
  readonly temporaryPath: string | null
  readonly temporaryPathState: PathState | null
}

const NO_EVIDENCE: EvidenceState = Object.freeze({
  attempted: false, publishedPath: null, verified: false, note: null,
  publication: null, evidencePhase: null, evidenceReason: null,
  finalPath: null, finalPathState: null, temporaryPath: null, temporaryPathState: null,
})

/** Turn a publication failure into the state that keeps all of its findings. */
function evidenceStateOf(e: unknown, fallback: string): EvidenceState {
  if (!(e instanceof LifecycleEvidenceFailed)) {
    return { ...NO_EVIDENCE, attempted: true, note: fallback }
  }
  return Object.freeze({
    attempted: true,
    // A bundle that IS published, and failed after the rename, has a path worth
    // naming. One that was refused does not, and must not be given one.
    publishedPath: e.publication === 'published-unverified' ? e.finalPath : null,
    verified: false,
    note: e.publication,
    publication: e.publication,
    evidencePhase: e.evidencePhase,
    evidenceReason: e.evidenceReason,
    finalPath: e.finalPath,
    finalPathState: e.finalPathState,
    temporaryPath: e.temporaryPath,
    temporaryPathState: e.temporaryPathState,
  })
}

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

/**
 * WHAT EACH AUTHORIZATION IS BOUND TO. A permission, not a fact.
 *
 * A bare set membership said only "this module minted this object". That is
 * three claims short of what a release needs: minted FOR WHICH SUPERVISOR,
 * against WHICH BACKEND, and NOT ALREADY USED. Without the first, an
 * authorization proved against one supervisor releases a fence held by
 * another; without the second, a supervisor that died and reconnected on the
 * same object releases whatever the new backend happens to hold; without the
 * third, one gate run authorises every release anybody later asks for.
 */
interface AuthorizationRecord {
  /** The exact object the gate proved against. Compared by identity. */
  readonly supervisor: FenceExecutor
  /** The backend that object reported at gate time. */
  readonly supervisorPid: string
  /** Set BEFORE the ROLLBACK is submitted, and never cleared. */
  consumed: boolean
}

const AUTHORIZATIONS = new WeakMap<object, AuthorizationRecord>()

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
  return typeof v === 'object' && v !== null && AUTHORIZATIONS.has(v)
}

/** Has this authorization been spent? An object nobody minted counts as spent. */
export function isAuthorizationConsumed(v: unknown): boolean {
  if (typeof v !== 'object' || v === null) return true
  return AUTHORIZATIONS.get(v)?.consumed !== false
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
  /**
   * The Stage-1 bundle, as `readPublishedBundle` MINTED it.
   *
   * The whole object rather than its document, and checked by identity: a
   * document is a value anyone can write, and every comparison below would then
   * be honest about the wrong thing.
   */
  readonly published: PublishedManifest
  readonly reviewedTarget: ContractArtifact
  /** BORROWED. Read through; never ended, never rolled back by the gate. */
  readonly supervisor: FenceExecutor
  readonly prover: FenceExecutor
  readonly quiescence: QuiescenceAdapter
  readonly queue: QueueAdapter
  /** EXACT pid+role pairs. Every client backend must match one of them. */
  readonly reviewedSessions: readonly ReviewedSession[]
  readonly deadlineMs?: number
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
  const deadlineMs = i.deadlineMs ?? ADAPTER_DEADLINE_MS

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

  // 4. THE VERIFIER'S BUNDLE VERIFIES FROM DISK, AND DESCRIBES THIS RUN.
  //
  // `complete: true` and `outcome: "PASS"` say a verification succeeded. They
  // do not say WHICH ONE. Every earlier run of this copy left a bundle that
  // satisfies both, and an operator pointing the lifecycle at yesterday's
  // evidence - or at a bundle from a different source entirely - would have
  // been authorised by it. So the record is read out and bound, field by field,
  // to the Stage-1 bundle, the Stage-2 result and the in-memory verification
  // this run actually produced.
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
  let recorded: RecordedVerification
  try {
    recorded = JSON.parse(
      ops.readFileSync(join(bundle, VERIFICATION_FILE), 'utf-8') as unknown as string) as never
  } catch {
    throw new ReleaseGateRefused('the verifier evidence bundle does not verify from disk')
  }
  assertRecordedVerificationIsThisRun(recorded, i)

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
  const producers = await reportProducers(i.quiescence, deadlineMs)

  // 8. WHO IS CONNECTED TO THE SOURCE.
  const activity = await censusActivity(i)

  // 9. TWO BOUNDED QUEUE SAMPLES, both empty and equal to each other. One
  //    sample cannot distinguish an empty queue from a queue caught between
  //    two jobs.
  const queueSamples = await sampleQueues(i.queue, deadlineMs)

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
  // final - and registered WITH what it was proved against, so the release can
  // check it is about to end the same transaction the gate examined.
  AUTHORIZATIONS.set(authorization, {
    supervisor: i.supervisor, supervisorPid: h.fence.supervisorPid, consumed: false,
  })
  return authorization as unknown as ReleaseAuthorization
}

/** The published verification manifest, as far as this module reads it. */
interface RecordedVerification {
  readonly outcome?: unknown
  readonly complete?: unknown
  readonly bundle?: { readonly name?: unknown }
  readonly source?: {
    readonly system_identifier?: unknown; readonly database?: unknown; readonly role?: unknown
    readonly contract_digest?: unknown; readonly root_digest?: unknown
  }
  readonly target?: {
    readonly system_identifier?: unknown; readonly database?: unknown; readonly role?: unknown
    readonly contract_digest?: unknown; readonly root_digest?: unknown
  }
  readonly stage2?: {
    readonly root_digest?: unknown
    readonly source_contract_digest?: unknown
    readonly target_contract_digest?: unknown
  }
  readonly tables?: ReadonlyArray<{
    readonly qname?: unknown; readonly source_digest?: unknown
    readonly target_digest?: unknown; readonly rows?: unknown
  }>
  readonly sequences?: ReadonlyArray<{
    readonly qname?: unknown
    readonly source_effective_next?: unknown; readonly target_effective_next?: unknown
  }>
}

/**
 * THE DURABLE RECORD MUST BE ABOUT THIS RUN, not merely about a good one.
 *
 * Everything compared here was written by the verifier into bytes its own
 * DIGEST covers, and is compared against values that came from somewhere else
 * entirely: the Stage-1 bundle read off disk, the Stage-2 handoff, and the
 * `VerificationResult` still in memory. A bundle from an earlier run agrees
 * with none of them.
 */
function assertRecordedVerificationIsThisRun(
  r: RecordedVerification, i: ReleaseGateInput,
): void {
  const h = i.handoff
  const v = i.verification
  const fail = (at: string): never => {
    throw new ReleaseGateRefused('the verifier evidence bundle does not verify from disk', at)
  }
  if (r.outcome !== 'PASS' || r.complete !== true) fail('the recorded outcome')

  // WHICH STAGE-1 BUNDLE.
  if (r.bundle?.name !== i.published.bundleName) fail('the recorded bundle name')
  if (r.bundle?.name !== h.bundleName) fail('the recorded bundle name')

  // WHICH DATABASES. Identity as the verifier MEASURED it, not as anyone says.
  for (const [what, rec, stated] of [
    ['source', r.source, h.source], ['target', r.target, h.target],
  ] as const) {
    if (rec?.system_identifier !== stated.systemIdentifier) fail(`the recorded ${what} cluster`)
    if (rec?.database !== stated.database) fail(`the recorded ${what} database`)
    if (rec?.role !== stated.role) fail(`the recorded ${what} role`)
  }
  if (r.source?.contract_digest !== h.sourceContractDigest) fail('the recorded source contract')
  if (r.target?.contract_digest !== h.targetContractDigest) fail('the recorded target contract')
  if (r.source?.root_digest !== v.sourceRootDigest) fail('the recorded source root')
  if (r.target?.root_digest !== v.targetRootDigest) fail('the recorded target root')
  if (r.stage2?.root_digest !== h.rootDigest) fail('the recorded Stage-2 root')
  if (r.stage2?.source_contract_digest !== h.sourceContractDigest) {
    fail('the recorded Stage-2 source contract')
  }
  if (r.stage2?.target_contract_digest !== h.targetContractDigest) {
    fail('the recorded Stage-2 target contract')
  }

  // EVERY TABLE, in the reviewed order, by both digests and its row count.
  const tables = Array.isArray(r.tables) ? r.tables : []
  if (tables.length !== COPY_TABLES.length) fail('the recorded table set')
  for (let n = 0; n < COPY_TABLES.length; n += 1) {
    const q = COPY_TABLES[n]
    if (tables[n].qname !== q) fail(`the recorded table set at ${q}`)
    if (tables[n].source_digest !== h.tables[n].digest) fail(`${q} recorded source digest`)
    if (tables[n].target_digest !== h.tables[n].digest) fail(`${q} recorded target digest`)
    if (tables[n].rows !== h.tables[n].rows) fail(`${q} recorded row count`)
  }

  // EVERY SEQUENCE, by what each side would issue next.
  const sequences = Array.isArray(r.sequences) ? r.sequences : []
  if (sequences.length !== FENCE_SEQUENCES.length) fail('the recorded sequence set')
  for (let n = 0; n < FENCE_SEQUENCES.length; n += 1) {
    const q = FENCE_SEQUENCES[n]
    if (sequences[n].qname !== q) fail(`the recorded sequence set at ${q}`)
    if (sequences[n].source_effective_next !== h.sequences[n].effectiveNext) {
      fail(`${q} recorded source position`)
    }
    if (sequences[n].target_effective_next !== h.sequences[n].effectiveNext) {
      fail(`${q} recorded target position`)
    }
  }
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

  // THE STAGE-1 BUNDLE CAME THROUGH THE DISK VERIFIER. Checked by identity,
  // because everything below is a comparison against what it says.
  if (!isVerifiedBundle(i.published)) fail('the Stage-1 bundle provenance')
  const doc = i.published.document as unknown as {
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
async function reportProducers(
  q: QuiescenceAdapter, deadlineMs: number = ADAPTER_DEADLINE_MS,
): Promise<readonly ProducerState[]> {
  let report: readonly ProducerState[]
  try {
    report = await withDeadline('quiescence', deadlineMs, ctx => q.report(ctx))
  } catch (e) {
    throw new ReleaseGateRefused('a reviewed producer is not stopped',
      e instanceof AdapterDeadlineExceeded ? 'the deadline' : null)
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
  const refuse = (at: string | null = null): never => {
    throw new ReleaseGateRefused('the source carries sessions that are not reviewed', at)
  }
  // THE REVIEWED SET ITSELF MUST BE COHERENT. One pid claimed by two roles, or
  // one pid listed twice, is an allowlist that cannot be checked against.
  const byPid = new Map<string, string>()
  for (const r of i.reviewedSessions) {
    if (typeof r?.pid !== 'string' || !/^\d+$/.test(r.pid)) refuse('a reviewed session pid')
    if (typeof r?.role !== 'string' || !IDENT.test(r.role)) refuse('a reviewed session role')
    const seen = byPid.get(r.pid)
    if (seen !== undefined) {
      refuse(seen === r.role ? 'a duplicate reviewed session' : 'a conflicting reviewed session')
    }
    byPid.set(r.pid, r.role)
  }
  if (byPid.size === 0) refuse('an empty reviewed session set')

  let res: { rows: string[][]; error: 'statement-refused' | null }
  try {
    res = await i.prover.send(ACTIVITY_CENSUS_SQL)
  } catch {
    return refuse('the census could not be taken')
  }
  if (res.error !== null) refuse('the census was refused')

  let unreviewed = 0
  for (const row of res.rows) {
    if (!Array.isArray(row) || row.length !== 3) refuse('a malformed census row')
    const [pid, role, backendType] = row
    if (typeof pid !== 'string' || typeof role !== 'string' ||
        typeof backendType !== 'string') {
      refuse('a malformed census row')
    }
    // SERVER-OWNED BACKENDS, through a closed list and nothing wider.
    if (backendType !== 'client backend') {
      if (!REVIEWED_BACKEND_TYPES.includes(backendType)) refuse('an unreviewed backend type')
      continue
    }
    // A CLIENT BACKEND MATCHES A PAIR, OR IT DOES NOT MATCH. A role on its own
    // authorises nothing: the export role is exactly what a second reader would
    // be using, which is the case this census exists to catch.
    if (!/^\d+$/.test(pid)) refuse('a malformed census row')
    if (byPid.get(pid) !== role) unreviewed += 1
  }
  if (unreviewed > 0) refuse(`${unreviewed} session(s)`)
  return { sessions: res.rows.length, unreviewed }
}

/**
 * Two bounded samples: the REVIEWED queue set, all of it, all empty, and equal.
 *
 * `{}` twice used to pass. The set is named now, so a queue the adapter could
 * not see is a refusal; and each call is deadline-bounded, so an adapter that
 * never answers stops the lifecycle with a reason rather than stopping it
 * forever with the fence held.
 */
async function sampleQueues(
  q: QueueAdapter, deadlineMs: number,
): Promise<readonly QueueSample[]> {
  const refuse = (at: string | null = null): never => {
    throw new ReleaseGateRefused('the queue samples are not empty and stable', at)
  }
  const samples: QueueSample[] = []
  for (let n = 0; n < 2; n += 1) {
    try {
      samples.push(await withDeadline('queue', deadlineMs, ctx => q.sample(ctx)))
    } catch (e) {
      refuse(e instanceof AdapterDeadlineExceeded ? 'the deadline' : null)
    }
  }
  for (const s of samples) {
    const depths = s?.depths
    if (depths === null || typeof depths !== 'object') refuse('a malformed sample')
    // EXACTLY THE REVIEWED SET: nothing missing, nothing extra. Object keys are
    // unique, so counting them and requiring each reviewed name covers both.
    if (Object.keys(depths).length !== REVIEWED_QUEUES.length) refuse('the sampled queue set')
    for (const name of REVIEWED_QUEUES) {
      if (!Object.prototype.hasOwnProperty.call(depths, name)) refuse(name)
      const depth = depths[name]
      if (!Number.isSafeInteger(depth) || depth !== 0) refuse(name)
    }
  }
  if (canonicalJson(samples[0].depths as Canonical) !==
      canonicalJson(samples[1].depths as Canonical)) {
    refuse('the two samples')
  }
  return Object.freeze(samples.map(s => Object.freeze({ depths: Object.freeze({ ...s.depths }) })))
}

// ---------------------------------------------------------------------------
// RELEASE AND RESTORATION
// ---------------------------------------------------------------------------

/** What the release established. Three answers, and only one of them is proof. */
/**
 * WHAT THE RELEASE ESTABLISHED. Three answers, and only one of them is proof.
 *
 *   `released`          the ROLLBACK was ACKNOWLEDGED and a census on that same
 *                       backend showed none of the reviewed locks. Proof.
 *   `released-unproved` the ROLLBACK was ACKNOWLEDGED - so the transaction did
 *                       end and the lease is gone - and the census that should
 *                       have confirmed it did not come back, or did not say zero.
 *   `release-unknown`   the transport failed before any acknowledgement. Nobody
 *                       can say whether PostgreSQL applied the statement.
 *
 * THE THIRD IS NOT A WEAKER SECOND. An acknowledgement is what makes "the
 * transaction ended" true; without one, "released" is a guess, and a guess in
 * this direction reads as a lease that is safely gone.
 */
export interface ReleaseResult {
  readonly state: 'released' | 'released-unproved' | 'release-unknown'
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
  // THE THREE SYNCHRONOUS CHECKS, THEN THE CONSUMPTION, WITH NO `await` BETWEEN
  // THEM. That ordering is the whole concurrency argument: JavaScript will not
  // interleave these statements, so two callers racing on one authorization
  // cannot both get past the `consumed` test - the first marks it and the
  // second finds it marked. A PID query placed before the consumption would put
  // an `await` in that window and hand both of them a release.
  const record = AUTHORIZATIONS.get(authorization)
  if (record === undefined) {
    throw new ReleaseGateRefused('the complete source fence was not proved held',
                                 'the authorization was not issued by this gate')
  }
  // THE SAME SUPERVISOR OBJECT. Not a matching pid, not an equivalent session:
  // the transaction the gate proved against is the transaction being ended.
  // Refused BEFORE consumption, so a misdirected attempt cannot spend the
  // holder's authorization, and refused before a statement is sent anywhere.
  if (record.supervisor !== supervisor) {
    throw new ReleaseGateRefused('the complete source fence was not proved held',
                                 'the authorization belongs to another supervisor')
  }
  if (record.consumed) {
    throw new ReleaseGateRefused('the complete source fence was not proved held',
                                 'the authorization has already been used')
  }
  // SPENT. From here it is spent whatever happens next - refused, timed out, or
  // lost to a transport nobody can ask. A second attempt must run a second
  // gate, because the first one's proofs are about a moment that has passed.
  record.consumed = true

  // AND THE BACKEND IS STILL THE ONE THAT WAS PROVED. A supervisor that died
  // and reconnected on the same object holds none of the fence, and rolling it
  // back would release nothing while reporting a release.
  let alive: { rows: string[][]; error: 'statement-refused' | null }
  try {
    alive = await supervisor.send(SUPERVISOR_ALIVE_SQL)
  } catch {
    throw new ReleaseGateRefused('the complete source fence was not proved held',
                                 'the supervisor could not be reached')
  }
  if (alive.error !== null || (alive.rows[0]?.[0] ?? '') !== record.supervisorPid) {
    throw new ReleaseGateRefused('the complete source fence was not proved held',
                                 'the supervisor is not the backend the gate proved')
  }

  // THE RELEASE. One statement, on the supervisor, and the only place in this
  // module that sends it.
  let released: { rows: string[][]; error: 'statement-refused' | null }
  try {
    released = await supervisor.send(RELEASE_SQL)
  } catch {
    // ATTEMPTED, OUTCOME UNKNOWN - and that is ALL that is known.
    //
    // A transport that raises has told us nothing about the server. The bytes
    // may have arrived and been applied with the reply lost on the way back;
    // they may never have left. So this is not a release, and it is not a
    // release that failed to prove: it is an attempt whose outcome nobody can
    // state. NOT RETRIED - a second ROLLBACK would be meaningless on a
    // transaction that already ended and an unauthorised attempt on one that
    // did not, and either way it cannot turn an unknown into a fact.
    return { state: 'release-unknown', remainingLocks: null }
  }
  if (released.error !== null) {
    // ACKNOWLEDGED, AND REFUSED. The server answered and declined, so the
    // transaction did NOT end and the fence is still held. Raised as a plain
    // refusal so the caller stays on the intervention path with the lease
    // intact.
    throw new ReleaseGateRefused('the complete source fence was not proved held', 'the rollback')
  }

  // ACKNOWLEDGED AND APPLIED. From here the transaction has ended, so every
  // outcome below is a RELEASED one; what is still open is whether it can be
  // proved.

  // THE PROOF, on the supervisor's own backend - the only session that can
  // answer "do I still hold anything" about itself.
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
export async function restoreProducers(
  a: ProducerAdapter, deadlineMs: number = ADAPTER_DEADLINE_MS,
): Promise<RestorationResult> {
  const restored: string[] = []
  for (const name of RESTORE_ORDER) {
    let ok = false
    try {
      // BOUNDED. A `launchctl` that never returns would otherwise leave the
      // lifecycle waiting between two producers, with the fence already gone
      // and nobody able to say which of them is running.
      await withDeadline('producer', deadlineMs, ctx => a.restore(name, ctx))
      ok = await withDeadline('producer', deadlineMs, ctx => a.confirm(name, ctx)) === true
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
 * END THE SUPERVISOR TRANSACTION AND PROVE THE REVIEWED LOCKS ARE GONE.
 *
 * Used on the PRE-COMMIT path only, where the target is untouched and the one
 * thing left to put right is the fence. Exactly one ROLLBACK, and the same
 * four-way reading of what came back as `releaseFence`: a transport that raised
 * establishes nothing and is `release-unknown`; an acknowledged refusal means
 * the transaction did not end; an acknowledgement plus a zero census is proof;
 * an acknowledgement without one is a release nobody could confirm.
 */
export async function rollbackAndProveReleased(
  supervisor: FenceExecutor,
): Promise<ReleaseResult | 'not-released'> {
  let released: { rows: string[][]; error: 'statement-refused' | null }
  try {
    released = await supervisor.send(RELEASE_SQL)
  } catch {
    // ATTEMPTED, OUTCOME UNKNOWN. Not retried, and not describable as released
    // - see `releaseFence`, which makes the same distinction for the same
    // reason.
    return { state: 'release-unknown', remainingLocks: null }
  }
  // ACKNOWLEDGED AND REFUSED: the transaction did not end.
  if (released.error !== null) return 'not-released'
  try {
    const census = await supervisor.send(
      RELEASED_LOCK_CENSUS_SQL.replace('$1', fenceRelationArray()))
    if (census.error !== null) return { state: 'released-unproved', remainingLocks: null }
    const n = Number(census.rows[0]?.[0] ?? NaN)
    if (!Number.isSafeInteger(n) || n < 0) {
      return { state: 'released-unproved', remainingLocks: null }
    }
    return n === 0
      ? { state: 'released', remainingLocks: 0 }
      : { state: 'released-unproved', remainingLocks: n }
  } catch {
    return { state: 'released-unproved', remainingLocks: null }
  }
}

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

  /**
   * The Stage-1 bundle DIRECTORY. Not a manifest object.
   *
   * The lifecycle verifies it here, through the reviewed disk verifier, rather
   * than accepting somebody's word for what it said. A `PublishedManifest` is a
   * claim that a DIGEST covered the bytes the fields came out of, and an
   * ordinary interface is a claim anybody can make by writing an object literal.
   */
  readonly bundleDir: string
  readonly readFile?: (path: string) => string
  readonly reviewedTarget: ContractArtifact
  readonly operator: OperatorInput
  readonly sourceBeginSql: string
  readonly targetExpectation: TargetExpectation
  readonly confirmation: string

  readonly quiescence: QuiescenceAdapter
  readonly queue: QueueAdapter
  readonly producers: ProducerAdapter
  /** EXACT pid+role pairs for every session legitimately on the source. */
  readonly reviewedSessions: readonly ReviewedSession[]
  readonly deadlineMs?: number

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
export async function assertQuiescent(
  q: QuiescenceAdapter, deadlineMs: number = ADAPTER_DEADLINE_MS,
): Promise<readonly ProducerState[]> {
  return await reportProducers(q, deadlineMs)
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
  /** SEPARATE FACTS. The snapshot's ROLLBACK is not the session's close, and a
   *  `finally` that conflated them re-submitted a statement already sent. */
  let snapshotEnded = false
  let gateEvidence: EvidenceState = NO_EVIDENCE
  let outcomeEvidence: EvidenceState = NO_EVIDENCE
  /** Publication is attempted ONCE per run id, and its first result stands. */
  let outcomeAttempted = false
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
    // ONCE PER RUN ID, AND THE FIRST RESULT STANDS.
    //
    // A second attempt under the same name can only collide with the first -
    // and that collision would then be reported INSTEAD of what actually
    // happened. A bundle published but unverified, or a temporary directory
    // retained, is the finding; "a path is already present" is the noise a
    // retry makes on top of it.
    if (outcomeAttempted) return outcomeEvidence
    outcomeAttempted = true
    const h = applied?.verification
    if (h === undefined) {
      outcomeEvidence = { ...NO_EVIDENCE, note: 'no Stage-2 result to describe' }
      return outcomeEvidence
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
      outcomeEvidence = {
        attempted: true, publishedPath: p.finalPath, verified: true, note: null,
        publication: 'published', finalPath: p.finalPath, finalPathState: 'present',
        temporaryPath: null, temporaryPathState: 'absent',
        evidencePhase: null, evidenceReason: null,
      }
      return outcomeEvidence
    } catch (e) {
      outcomeEvidence = evidenceStateOf(e, 'the outcome bundle was not published')
      return outcomeEvidence
    }
  }

  /**
   * Every PRE-COMMIT failure that may have left a fence funnels through here.
   *
   * One ROLLBACK, one proof. A proved release is an ordinary refusal - the
   * caller may fix the problem and run again. Anything else is a state a person
   * has to resolve, because "try again" against a source that may still be
   * fenced is how two runs end up fighting over it.
   */
  const cleanUpPreCommit = async (
    phase: LifecyclePhase, reason: LifecycleReason, at: string | null = null,
  ): Promise<never> => {
    const outcome = await rollbackAndProveReleased(i.supervisor)
    if (outcome !== 'not-released' && outcome.state === 'released') {
      throw new LifecycleRefused(phase, reason, at)
    }
    // EACH OUTCOME KEEPS ITS OWN NAME. Folding an unknown into
    // `released-unproved` would tell an operator the lease is gone when the
    // only thing established is that nobody can say.
    throw new LifecyclePreCommitCleanupRequired(
      { phase, reason, at },
      outcome === 'not-released' ? 'unproved' : outcome.state,
      i.supervisor)
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
    // L1. THE BUNDLE IS VERIFIED HERE, FROM DISK, BY THIS LIFECYCLE.
    //
    // Not accepted as an object. `readPublishedBundle` verifies the DIGEST over
    // the published bytes and reads every field out of what that DIGEST covers;
    // a `PublishedManifest` handed in instead is an object literal with the
    // right field names, and every comparison the copy and the gate later make
    // would be honest about it and worthless.
    let bundleManifest: PublishedManifest
    try {
      bundleManifest = readPublishedBundle(
        i.bundleDir, i.readFile ?? ((path: string) => readFileSync(path, 'utf-8')), sha256Hex,
        ops)
    } catch {
      throw new LifecycleRefused(
        'L1-bundle', 'the published bundle or reviewed target was not accepted',
        'the Stage-1 bundle')
    }
    // AND THE REVIEWED TARGET IS RECOMPUTED, not read. A digest field is a
    // claim by whoever wrote the file; the payload is the thing that was
    // reviewed, and its digest is derivable from it.
    if (contractDigest(i.reviewedTarget.payload) !== i.reviewedTarget.digest ||
        i.reviewedTarget.digest !== REVIEWED_CONTRACT_DIGEST) {
      throw new LifecycleRefused(
        'L1-bundle', 'the published bundle or reviewed target was not accepted',
        'the reviewed target artifact')
    }

    // L2. QUIESCENCE, before the fence is even taken. A producer still running
    // here would be writing to the source that Stage 2 is about to freeze.
    try {
      await assertQuiescent(i.quiescence, i.deadlineMs ?? ADAPTER_DEADLINE_MS)
    } catch (e) {
      throw new LifecycleRefused(
        'L2-quiescence', 'a reviewed producer is not stopped',
        e instanceof ReleaseGateRefused ? e.at : null)
    }

    // L3. STAGE 2. Takes the fence on the borrowed supervisor and holds it.
    stageSource = await i.openStageSource()
    let appliedResult: ApplyResult
    try {
      appliedResult = await runApply({
        supervisor: i.supervisor, prover: i.prover, source: stageSource,
        operator: i.operator, sourceBeginSql: i.sourceBeginSql,
        reviewedTarget: i.reviewedTarget,
        targetExpectation: i.targetExpectation, confirmation: i.confirmation,
        openTarget: i.openStageTarget,
      }, bundleManifest)
    } catch (e) {
      if (e instanceof CommitOutcomeUnknown) {
        committed = true
        await stop('L3-copy', 'the transactional copy did not complete', 'the commit outcome')
      }
      // PRE-COMMIT, AND THE FENCE MAY BE HELD. A2 takes the fence, and it takes
      // it as a SEQUENCE of statements, so even a refusal at A2 itself can
      // leave part of it. Everything from there to COMMIT - the confirmation,
      // the target identity, the copy, the sequence policy, the final gates -
      // fails with the supervisor still inside that transaction. The target is
      // untouched, so this is not an intervention about data; it is a fence
      // this lifecycle must end and prove ended before anyone runs again.
      throw await cleanUpPreCommit('L3-copy', 'the transactional copy did not complete')
    }
    applied = appliedResult
    committed = true

    // L4. THE STAGE-2 SNAPSHOT ENDS. THE FENCE DOES NOT. Ending the source
    // transaction frees the snapshot the copy read in; the fence lives in the
    // SUPERVISOR's transaction and is untouched by this.
    try {
      await stageSource.rows(RELEASE_SQL)
      // SUBMITTED. Recorded before the close, so the `finally` below can never
      // send it a second time - a retry of a statement that already ran is a
      // statement nobody decided to send.
      snapshotEnded = true
      await stageSource.end()
      stageSource = null
    } catch {
      snapshotEnded = true
      await stop('L4-snapshot-end', 'the Stage-2 source snapshot could not be ended', null)
    }

    // L5. THE INDEPENDENT VERIFIER, on fresh sessions, fence still held.
    try {
      verification = await runVerification({
        handoff: appliedResult.verification,
        publishedDocument: bundleManifest.document,
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
        handoff: appliedResult.verification,
        verification: verification as VerificationResult,
        published: bundleManifest,
        reviewedTarget: i.reviewedTarget,
        supervisor: i.supervisor, prover: i.prover,
        quiescence: i.quiescence, queue: i.queue,
        reviewedSessions: i.reviewedSessions,
        deadlineMs: i.deadlineMs ?? ADAPTER_DEADLINE_MS,
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
          authorization as ReleaseAuthorization, appliedResult.verification,
          runIds.releaseGate, stamp),
        detail: gateDetailDocument(authorization as ReleaseAuthorization),
        ops,
      })
      gateEvidence = {
        attempted: true, publishedPath: p.finalPath, verified: true, note: null,
        publication: 'published', finalPath: p.finalPath, finalPathState: 'present',
        temporaryPath: null, temporaryPathState: 'absent',
        evidencePhase: null, evidenceReason: null,
      }
    } catch (e) {
      gateEvidence = evidenceStateOf(e, 'the authorization bundle was not published')
      await stop('L7-authorization-evidence',
                 'the release authorization evidence was not published and verified',
                 gateEvidence.publication)
    }

    // L8/L9. THE RELEASE, AND ITS PROOF. One ROLLBACK, then a census on that
    // same backend. Nothing between them.
    try {
      release = await releaseFence(i.supervisor, authorization as ReleaseAuthorization)
    } catch (e) {
      await stop('L8-release', 'the fence release was not completed',
                 e instanceof ReleaseGateRefused ? e.refusal : null)
    }
    // TWO DIFFERENT FAILURES, AND THEY ARE NOT INTERCHANGEABLE.
    //
    // An unknown outcome is a failure of the RELEASE - nobody knows whether the
    // statement was applied - and belongs at L8. An acknowledged release whose
    // census did not confirm it is a failure of the PROOF, at L9: there the
    // transaction provably ended. Routing the first through the second would
    // record "released" about a run where that was never established.
    if ((release as ReleaseResult).state === 'release-unknown') {
      await stop('L8-release', 'the fence release was not completed',
                 'the rollback outcome is unknown')
    }
    if ((release as ReleaseResult).state !== 'released') {
      // ACKNOWLEDGED AND NOT PROVED. The lease is gone; producers stay down.
      await stop('L9-release-proof', 'the fence release could not be proved', null)
    }

    // L10. RESTORATION, and only now. Reviewed reverse order, each confirmed.
    restoration = await restoreProducers(i.producers, i.deadlineMs ?? ADAPTER_DEADLINE_MS)
    if (restoration.failedAt !== null) {
      await stop('L10-restore', 'a reviewed producer was not restored', restoration.failedAt)
    }

    // L11. WHAT ACTUALLY HAPPENED, published separately from the authorization.
    //
    // If this fails, `stop` must NOT publish again: the first attempt's outcome
    // is the finding, and a second one under the same name could only collide
    // with it and report the collision instead.
    outcomeEvidence = recordOutcome('released', null, gateEvidence.publishedPath)
    if (!outcomeEvidence.verified) {
      await stop('L11-outcome-evidence',
                 'the lifecycle outcome evidence was not published and verified',
                 outcomeEvidence.publication)
    }

    return Object.freeze({
      outcome: 'COMPLETE',
      rootDigest: appliedResult.rootDigest,
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
      // ONLY IF IT WAS NEVER SUBMITTED. `snapshotEnded` is the record of that,
      // and closing is a separate act from ending the transaction.
      if (!snapshotEnded) {
        try { await stageSource.rows(RELEASE_SQL) } catch { /* bounded */ }
      }
      try { await stageSource.end() } catch { /* bounded */ }
    }
    // The supervisor and the prover are the CALLER'S. Not closed, not rolled
    // back - the release above is the one statement this module ever sends to
    // end that transaction, and it happens only with an authorization in hand.
    void committed
  }
}

/**
 * THE COPY DID NOT COMMIT, AND THE FENCE COULD NOT BE PROVED GONE.
 *
 * WHY THIS IS NOT A REFUSAL. A refusal means a caller may fix the problem and
 * run again, and that is only true if the source is as it was. Stage 2 takes
 * the fence at A2 - and a refusal at A2 itself may have taken PART of it, since
 * acquisition is a sequence of statements - so every failure from that point on
 * leaves a transaction holding locks that this lifecycle must end. It ends it
 * with one ROLLBACK and proves the locks are gone. When that proof does not
 * come back, telling the caller "try again" would invite a second run into a
 * source the first one may still be holding.
 *
 * NOTHING IS RESTORED. This lifecycle did not stop the producers - they were
 * required to be stopped before it began - so starting them is not its
 * business, and doing it here would be starting writers against a source whose
 * state nobody can state.
 */
export class LifecyclePreCommitCleanupRequired extends Error {
  /** Stated, and stated as false. The target is not part of this problem. */
  readonly committed = false
  constructor(
    readonly failure: LifecycleFailure,
    readonly fence: LifecycleFenceState,
    /** The caller's supervisor. RETAINED, never closed. */
    readonly supervisor: FenceExecutor,
  ) {
    super(
      'COPY LIFECYCLE STOPPED BEFORE COMMIT: INTERVENTION REQUIRED. The target was NOT ' +
      'committed and holds nothing from this run. No producer was restored - this lifecycle ' +
      'did not stop them. ' +
      `${LIFECYCLE_FENCE_SENTENCE[fence]} ` +
      'DO NOT simply retry: a second run would take a fence this one may still be holding. ' +
      `${failure.reason} (phase ${failure.phase}` +
      `${failure.at === null ? '' : ` at ${failure.at}`})`)
    this.name = 'LifecyclePreCommitCleanupRequired'
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
