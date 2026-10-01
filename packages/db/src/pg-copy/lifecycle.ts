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
import { basename, join } from 'node:path'

import {
  DIGEST_FILE, EvidencePublicationUnknown, EvidencePublishedButUnverified, EvidenceRefused,
  REAL_EVIDENCE_OPS, evidenceNames, evidenceStamp, newRunId, publishEvidence,
  publishRetainedScratch,
  verifyPublishedEvidence,
  type EvidenceOps, type EvidencePhase, type EvidenceReason, type PublishedEvidence,
  type PublishedPhase,
} from './evidence.js'
import {
  COPY_TABLES, REVIEWED_CONTRACT_DIGEST, canonicalJson, contractDigest, sha256Hex,
  type Canonical, type ContractArtifact,
} from './schema-contract.js'
import {
  FENCE_SEQUENCES, FENCE_TABLES, SEQUENCE_STATE_SQL, effectiveNext, fenceRelationArray, parseSequenceState, type AcquiredFence, type FenceExecutor, type SequenceFenceId,
} from './source-fence.js'
import {
  VERIFICATION_FILE, attemptFenceProof, observePath, runVerification,
  type FenceDisposition, type FenceProofResult, type PathState, type VerifyCloseable,
  type VerificationResult, type VerifierHandoff,
} from './verify.js'
import {
  CommitOutcomeUnknown, isVerifiedBundle, readPublishedBundle, runApply,
  type ApplyInput,
  type ApplyResult, type PublishedManifest,
} from './stage2.js'
import {
  COMMIT_DISPOSITION_PREFIX, classifyTargetDisposition,
  type CommitUnknownHandoff, type DispositionInput, type DispositionResult,
  type TargetDisposition,
} from './commit-disposition.js'
import type { DriverSession } from './driver-session.js'
import type { OperatorInput } from './source-manifest.js'
import type { TargetExpectation } from './target-authority.js'

/** Bumped when either published document changes shape. */
export const LIFECYCLE_DOCUMENT_VERSION = 1

export const RELEASE_GATE_PREFIX = 'release-gate'

/** The post-release record a NOT_COMMITTED_PRISTINE run leaves behind. */
export const PRISTINE_RELEASE_PREFIX = 'pristine-release'
export const LIFECYCLE_PREFIX = 'copy-lifecycle'
export const RELEASE_GATE_FILE = 'release-gate.json'
export const LIFECYCLE_FILE = 'lifecycle.json'
export const GATE_DETAIL_FILE = 'gate-detail.json'
export const LIFECYCLE_DETAIL_FILE = 'actions.json'
/**
 * THE MANIFEST NAMES THE PRODUCERS BELOW ACTUALLY WRITE.
 *
 * K7-B7.2.1: these were string literals at the publication sites, so a
 * consumer had to guess them - and guessed wrong: the export authority asked
 * for `commit-disposition.json` while the lifecycle writes `disposition.json`,
 * which made the legitimate no-target-commit path impossible. Named here, both
 * sides refer to the same constant.
 */
export const COMMIT_DISPOSITION_FILE = 'disposition.json'
export const COMMIT_DISPOSITION_DETAIL_FILE = 'measurements.json'
export const PRISTINE_RELEASE_FILE = 'pristine-release.json'
export const PRISTINE_RELEASE_DETAIL_FILE = 'proof.json'

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
 * WHO A SESSION IS, ASKED OF THAT SESSION.
 *
 * pid, role and backend start, in one statement. This is what replaced the
 * operator-supplied session attestation: an allowlist a person typed is an
 * allowlist a person can extend, and an operator who added one pid to it could
 * license exactly the unreviewed connection the census exists to find. A
 * session's own answer to "who are you" cannot be forged by whoever is holding
 * the terminal.
 */
export const SESSION_IDENTITY_SQL =
  // CURRENT_USER, not \`pg_catalog.current_user\`: it is a reserved special
  // expression rather than a schema-qualified function, and the qualified
  // spelling is a syntax error every real server rejects - which a stub that
  // matched the string by equality could never have told us.
  'SELECT pg_catalog.pg_backend_pid(), CURRENT_USER::pg_catalog.text, ' +
  '(SELECT a.backend_start FROM pg_catalog.pg_stat_activity a ' +
  'WHERE a.pid = pg_catalog.pg_backend_pid())'

/** When a NAMED backend started, asked of an INDEPENDENT session. */
export const BACKEND_START_SQL = (pid: string): string =>
  'SELECT a.backend_start FROM pg_catalog.pg_stat_activity a ' +
  `WHERE a.pid = ${pid}`

/** A timestamp psql rendered. Shape-checked, never parsed into a local clock. */
export const BACKEND_START_SHAPE =
  /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d{1,6})?[+-]\d{2}(:\d{2})?$/

/**
 * HOW LONG BETWEEN THE TWO QUEUE SAMPLES.
 *
 * Two samples taken in the same millisecond are one sample written down twice.
 * What the pair is meant to establish is that the queues are not merely empty
 * but STAYING empty - that no producer nobody stopped is about to enqueue - and
 * that takes elapsed time in which something could have arrived.
 */
export const QUEUE_SAMPLE_INTERVAL_MS = 2_000

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
 * THE SAME CENSUS, ASKED OF A NAMED BACKEND FROM AN INDEPENDENT SESSION.
 *
 * WHY A SECOND FORM EXISTS. The one above counts the locks of the session that
 * runs it, which is right for a supervisor proving its own release and useless
 * for anybody else. An intervention hold has to ask "does THAT backend still
 * hold reviewed locks" from a session that is not it - the supervisor may be
 * unreachable, mid-statement, or gone - so the pid becomes a parameter.
 *
 * COUNTS, NEVER A COMPLETENESS TEST. "Holds the complete fence" and "holds no
 * reviewed lock at all" are different questions and the space between them is
 * a PARTIAL fence, which is the state an earlier revision silently reported as
 * released. This returns a number so the caller can tell the three apart.
 */
export function releasedLockCensusSqlFor(pid: string): string {
  if (!/^\d{1,10}$/.test(pid)) {
    // NOT INTERPOLATED UNCHECKED. The pid reaches this function from a proof,
    // not from a person, but the shape is asserted anyway - a value that could
    // carry anything else has no business being spliced into a statement.
    throw new ReleaseGateRefused('the complete source fence was not proved held',
                                 'the backend pid is not in the reviewed form')
  }
  return `
SELECT pg_catalog.count(*)::pg_catalog.text
  FROM pg_catalog.pg_locks l
  LEFT JOIN pg_catalog.pg_class c ON c.oid = l.relation
  LEFT JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
 WHERE l.pid = ${pid}
   AND ((l.locktype = 'relation' AND n.nspname || '.' || c.relname = ANY ($1))
     OR (l.locktype = 'advisory'))`
}

/**
 * How many reviewed locks a complete fence holds.
 *
 * Derived from the reviewed sets rather than written down: 21 tables, 3
 * sequences and the one advisory lock. A constant typed by hand would be a
 * second place the fence's size is stated, and the two would eventually differ.
 */
export const COMPLETE_FENCE_LOCKS = FENCE_TABLES.length + FENCE_SEQUENCES.length + 1

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
  // ALL FIVE DECLARED AGENTS, not the three an earlier revision listed. Two of
  // the missing ones matter: `structured-worker` CONSUMES a queue whose jobs
  // write PostgreSQL, and `watchdog` can put work into one. A reviewed set that
  // omits a writer is a fence with a door in it.
  //
  // `structured-worker` is currently declared and templated but NOT installed.
  // That is not a reason to drop it: its reviewed disposition is `absent`, and
  // absence is something to be PROVED, not assumed by leaving it off the list.
  'com.thanapol.ai-capital.daily',
  'com.thanapol.ai-capital.watchdog',
  'com.thanapol.ai-capital.alerts',
  'com.thanapol.ai-capital.structured-worker',
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
 * THE WHOLE QUIESCENCE MEASUREMENT FOR ONE PRODUCER, not just its verdict.
 *
 * WHY THE VERDICT ALONE IS NOT ENOUGH IN EVIDENCE. `{name, stopped}` records
 * the conclusion and throws away everything that produced it: whether launchd
 * had the label at all, whether it was disabled, whether a process was found
 * and which pattern found it. An operator reading that bundle a month later
 * cannot tell a producer that was absent from one that was disabled-and-idle
 * from one that was never looked for - and those are three different stories
 * about the same word.
 *
 * THE ADAPTER RETURNS THIS AND THE GATE CARRIES IT. A `ProducerState` is what
 * the gate COMPARES; this is what the evidence RECORDS, and the two cannot
 * drift because the first is derived from the second.
 */
export interface ProducerQuiescenceMeasurement {
  readonly name: string
  readonly stopped: boolean
  /** `absent` or `loaded`, as launchd answered. */
  readonly presence: string
  readonly disabled: boolean
  readonly running: boolean
  readonly launchdPid: string | null
  /** The reviewed command pattern the process census matched on. */
  readonly processPattern: string
  /** Every process matching it, whoever started them. */
  readonly processPids: readonly string[]
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
  // THE AUTHORITATIVE NAMES, from `@common/queue`'s own constants. An earlier
  // revision invented `ai-capital-daily`/`ai-capital-alerts`, which exist
  // nowhere: every sample would have refused, which fails safe and for entirely
  // the wrong reason.
  'daily-pipeline',
  'structured-ingestion',
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
  /**
   * The FULL measurement, for the evidence.
   *
   * Optional only so a test double that cares about nothing but the verdict
   * stays short; the reviewed adapter supplies it, and the gate records
   * whatever it gets rather than reducing it.
   */
  measure?(ctx: AdapterContext): Promise<readonly ProducerQuiescenceMeasurement[]>
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

/**
 * WHO - IF ANYONE - PUTS THE PRODUCERS BACK.
 *
 * A DISCRIMINATED UNION RATHER THAN A NO-OP ADAPTER. The production path has no
 * reviewed mutating launchd adapter, and inventing one that returns without
 * acting would be worse than having none: `restoreProducers` would report every
 * producer restored, `confirm` would be the only thing that could contradict it,
 * and the lifecycle bundle would record a restoration that never happened. The
 * authority is therefore part of the INPUT, and "nobody, by authorization" is a
 * value it can take.
 *
 * `adapter` keeps the disposable and integration coverage exactly as it was.
 * `manual-stop` is production: the operator stopped the producers before the
 * copy and puts them back afterwards, under a separate reviewed mode, and the
 * lifecycle says so instead of guessing.
 */
/**
 * THE TERMINAL OUTCOME, named once so the record and the return cannot disagree.
 *
 * WHAT WAS WRONG. The outcome document computed its own verdict as
 * `failure === null ? 'COMPLETE' : 'STOPPED'`, while the function's return value
 * had learned to distinguish a manual-stop success. So a production run copied,
 * verified, released and then FROZE A BUNDLE SAYING `COMPLETE` - the immutable
 * evidence contradicting the result, and claiming a completion whose producers
 * were still down. A caller trusting the bundle would have read the copy as
 * closed.
 *
 * The value is computed once, returned, and written. There is no second opinion.
 */
/**
 * AND NO LIFECYCLE OUTCOME IS `COMPLETE`.
 *
 * K7-B7: a copy is COMPLETE only when its closure says so. The lifecycle runs
 * long before that - the restoration has not been proved, the chain has not
 * been re-walked, and no closure record exists - so a lifecycle bundle saying
 * COMPLETE claimed a completion that nothing had established. The adapter path
 * now returns the truthful nonterminal value instead: the producers really were
 * restored and confirmed, and the copy is still open.
 */
export type LifecycleOutcome =
  | 'COPY_VERIFIED_RESTORED_AWAITING_CLOSURE'
  | 'COPY_VERIFIED_AWAITING_MANUAL_RESTORATION'
  | 'STOPPED'

export type RestorationAuthority =
  | { readonly kind: 'adapter'; readonly producers: ProducerAdapter }
  | { readonly kind: 'manual-stop' }

/**
 * THE EXACT INPUT STAGE 2 IS GIVEN - built where it can be proved.
 *
 * WHY THIS IS A FUNCTION. Inline, the `preAcquiredFence` forwarding lived in an
 * object literal inside `runLifecycle`, which cannot be reached without two
 * live clusters. A mutant that simply DELETED the forwarding therefore survived
 * every runnable test: the field stayed on the input type, the production path
 * silently took a second fence, and nothing said so. The continuous-fence
 * contract is the whole point of this milestone, so the one line that carries
 * it is extracted here and checked directly.
 *
 * OMITTED RATHER THAN UNDEFINED when there is no fence, so the disposable path
 * reaches `acquireSourceFence` exactly as it did before.
 */
export function applyInputFor(
  i: LifecycleInput, source: DriverSession,
): ApplyInput {
  return {
    supervisor: i.supervisor, prover: i.prover, source,
    operator: i.operator, sourceBeginSql: i.sourceBeginSql,
    reviewedTarget: i.reviewedTarget,
    targetExpectation: i.targetExpectation, confirmation: i.confirmation,
    openTarget: i.openStageTarget,
    ...(i.preAcquiredFence === undefined
      ? {}
      : { preAcquiredFence: i.preAcquiredFence }),
  }
}

/**
 * WHICH TERMINAL SUCCESS THIS AUTHORITY MAKES TRUE.
 *
 * EXTRACTED SO IT CAN BE PROVED. Inline, this decision lived inside
 * `runLifecycle`, which needs two live clusters to reach - so a mutant that
 * swapped the two branches survived every test that could be run without one.
 * A total function over the authority is three lines and is checkable directly.
 *
 * TWO NONTERMINAL SUCCESSES, AND NEITHER IS COMPLETE. An adapter that restored
 * and confirmed every producer leaves a copy that is verified, released and
 * running - but NOT closed, because closure re-walks the chain and publishes
 * the only record permitted to say the word. Manual-stop leaves the producers
 * down by authorization. The two are different facts and are named differently;
 * reporting the adapter's success as "awaiting manual restoration" would be as
 * untruthful as calling it COMPLETE.
 */
export function terminalOutcomeFor(
  a: RestorationAuthority,
): Exclude<LifecycleOutcome, 'STOPPED'> {
  return a.kind === 'adapter'
    ? 'COPY_VERIFIED_RESTORED_AWAITING_CLOSURE'
    : 'COPY_VERIFIED_AWAITING_MANUAL_RESTORATION'
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
  | 'the fenced producer census does not agree with the pre-fence one'
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
 * The three pre-release states are the verifier's, unchanged.
 *
 * `released` and `released-unproved` are the two POST-RELEASE states, and both
 * of them require an ACKNOWLEDGED ROLLBACK: the server answered, so the
 * transaction has ended and the lease is gone. They differ only in whether the
 * census that should have confirmed it came back. Reporting either as held - or
 * as recoverable - would send an operator to look for a lease that is not there.
 *
 * `release-unknown` is NOT a post-release state. It is what is left when the
 * transport failed before any acknowledgement, so EXECUTION WAS NEVER
 * ESTABLISHED: PostgreSQL may have applied the statement or may never have
 * received it. The fence may still be held or may already be gone, and the one
 * thing that must not happen is picking a side.
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
interface EvidenceFindings {
  readonly attempted: boolean
  readonly note: string | null
  readonly publication: LifecyclePublication | null
  readonly evidencePhase: EvidencePhase | PublishedPhase | null
  readonly evidenceReason: EvidenceReason | null
  readonly finalPath: string | null
  readonly finalPathState: PathState | null
  readonly temporaryPath: string | null
  readonly temporaryPathState: PathState | null
}

/**
 * A PUBLICATION THAT VERIFIED, and therefore CAN be identified.
 *
 * `digestFileDigest` is the digest of this bundle's `DIGEST` file as the
 * publisher returned it, carried so a caller that must cross-link this
 * publication later - during a post-COMMIT intervention, when reopening a path
 * proves nothing and the transaction may already be unusable - can produce a
 * COMPLETE link without guessing.
 */
export interface VerifiedEvidenceState extends EvidenceFindings {
  readonly verified: true
  readonly publishedPath: string
  readonly digestFileDigest: string
}

/**
 * A PUBLICATION THAT DID NOT VERIFY, or was never attempted.
 *
 * `digestFileDigest` is `null` BY TYPE. The first version of this carried one
 * nullable field beside a boolean and a prose "iff": that admitted
 * `verified: true` with `digestFileDigest: null`, and the cross-link that
 * consumed it wrote `''` into an intervention record - a reference that looks
 * verified and identifies nothing.
 */
export interface UnverifiedEvidenceState extends EvidenceFindings {
  readonly verified: false
  readonly publishedPath: string | null
  readonly digestFileDigest: null
}

/**
 * WHAT HAPPENED TO A PUBLISHED BUNDLE, in full.
 *
 * A DISCRIMINATED UNION, so the impossible state is not merely discouraged.
 * Narrowing on `verified` gives a `string` digest or a `null` one; there is no
 * third shape to remember to validate.
 */
export type EvidenceState = VerifiedEvidenceState | UnverifiedEvidenceState

const NO_EVIDENCE: UnverifiedEvidenceState = Object.freeze({
  attempted: false, publishedPath: null, verified: false,
  digestFileDigest: null, note: null,
  publication: null, evidencePhase: null, evidenceReason: null,
  finalPath: null, finalPathState: null, temporaryPath: null, temporaryPathState: null,
})

/**
 * THE ONE CONSTRUCTOR FOR "THIS PUBLICATION VERIFIED".
 *
 * Every verified `EvidenceState` in this module is built here, so the digest a
 * later cross-link depends on cannot be omitted at one site and present at
 * another. It is taken from the publisher's own result and REFUSED unless it
 * is 64 lowercase hex: a verified publication that cannot be identified is a
 * contradiction, and blanking it produced an intervention record that named a
 * bundle beside an empty digest - which reads as a verified reference and is
 * not one.
 */
export function verifiedEvidence(published: PublishedEvidence): VerifiedEvidenceState {
  if (!/^[0-9a-f]{64}$/.test(published.digestFileDigest)) {
    // THE BUNDLE IS ON DISK. Atomic publication already completed, so this is
    // a POST-publication identity failure and must be classified as one:
    //
    //   - `published-unverified`, which is the only disposition
    //     `evidenceStateOf` retains a path for. Saying `published` lost the
    //     path entirely and left a record claiming nothing was published,
    //     while a complete directory sat there unreferenced.
    //   - `verify`, a PublishedPhase - the failure is in identifying what was
    //     published, not in writing it.
    //   - the exact final path, PRESENT.
    //
    // AND NOTHING IS TOUCHED. No unlink, rename, chmod or retry: this process
    // could not identify the bundle, which is not a licence to alter it.
    throw new LifecycleEvidenceFailed(
      'a verified publication carries no reviewed DIGEST digest',
      'published-unverified', 'verify', null,
      published.finalPath, 'present', null, 'absent')
  }
  return Object.freeze({
    attempted: true,
    publishedPath: published.finalPath,
    verified: true as const,
    digestFileDigest: published.digestFileDigest,
    note: null,
    publication: 'published' as const,
    finalPath: published.finalPath,
    finalPathState: 'present' as const,
    temporaryPath: null,
    temporaryPathState: 'absent' as const,
    evidencePhase: null,
    evidenceReason: null,
  })
}

/**
 * Turn a publication failure into the state that keeps all of its findings.
 *
 * EXPORTED so the pair that every publication catch is built from -
 * `verifiedEvidence` throwing, this function classifying - can be driven
 * directly. Asserting only that `verifiedEvidence` throws says nothing about
 * whether the already-published path survives, which is the whole property.
 */
export function evidenceStateOf(e: unknown, fallback: string): UnverifiedEvidenceState {
  if (!(e instanceof LifecycleEvidenceFailed)) {
    return { ...NO_EVIDENCE, attempted: true, note: fallback }
  }
  return Object.freeze({
    attempted: true,
    // A bundle that IS published, and failed after the rename, has a path worth
    // naming. One that was refused does not, and must not be given one.
    publishedPath: e.publication === 'published-unverified' ? e.finalPath : null,
    verified: false as const,
    // NOT VERIFIED, SO NOT IDENTIFIABLE. A published-unverified bundle has a
    // path worth naming and no digest anybody proved.
    digestFileDigest: null,
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
  /**
   * AND WHEN THAT BACKEND STARTED. The pid alone was one recycled number away
   * from authorising a release against somebody else's session: a supervisor
   * that died and reconnected can report the same pid, and the release would
   * then roll back a transaction that holds none of the fence while reporting
   * that the fence was released.
   */
  readonly supervisorBackendStart: string
  /** Set BEFORE the ROLLBACK attempt, and never cleared. */
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
  /**
   * WHEN THE SUPERVISOR BACKEND STARTED, read by the INDEPENDENT prover.
   *
   * A pid identifies a backend only for as long as that backend lives, and an
   * intervention hold can outlast it. The pair is unique for the cluster's
   * lifetime, so the pair is what the proof carries, what the authorization is
   * registered against, what the release re-checks and what the evidence
   * records. Read by the prover rather than by the supervisor, because a
   * supervisor that died and reconnected would cheerfully report the NEW
   * backend's start as though it were the one that took the fence.
   */
  readonly supervisorBackendStart: string
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
  | 'the fenced producer census does not agree with the pre-fence one'
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
  /** Re-measured WHILE FENCED and compared with `expectedProducers`. */
  readonly destinations: DestinationCensusAdapter
  readonly expectedProducers: readonly ProducerCensusRow[]
  /** Other live sessions this process owns. Each is asked who it is. */
  readonly ownedSessions?: readonly IdentifiableSession[]
  /** Recorded into the evidence. Never a source of census values. */
  readonly attestation?: QuiescenceAttestation
  /** TEST-ONLY seam for the reviewed inter-sample interval. */
  readonly __sleep?: (ms: number) => Promise<void>
  readonly verification: VerificationResult
  /** Additional caller-owned sessions, merged with the lifecycle's own. */
  readonly callerSessions?: readonly IdentifiableSession[]
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
  readonly deadlineMs?: number
  readonly ops?: EvidenceOps
}

const IDENT = /^[a-z_][a-z0-9_]*$/

/**
 * WHAT THE OPERATIONAL HALF OF THE GATE NEEDS, and nothing about a copy.
 *
 * The prerequisite rehearsal proves the production adapters against a live
 * source and never touches a target, so it has no verifier result, no Stage-2
 * handoff and no published bundle to offer. Requiring those would have made the
 * rehearsal impossible to write - which is how the first design ended up
 * proposing a rehearsal that ran the whole copy, and could then never be
 * followed by an apply, because Stage 2 requires an EMPTY target.
 */
/**
 * A FENCED RE-MEASUREMENT OF WHERE THE PRODUCERS WRITE.
 *
 * The pre-fence census answers "where do these agents write" at a moment when
 * they could still be running. The fenced one answers it again with the source
 * frozen, and the two are compared: a plist swapped, a credential repointed or
 * an agent reinstalled in between is a producer whose stopping the operator
 * justified against a world that no longer exists.
 */
export interface DestinationCensusAdapter {
  measure(ctx: AdapterContext): Promise<readonly ProducerCensusRow[]>
}

/**
 * One producer as the census sees it. Structurally the binding's own record,
 * declared here so `@common/db` does not depend on the queue package.
 */
export interface ProducerCensusRow {
  readonly label: string
  readonly plistPath: string | null
  readonly plistSha256: string | null
  readonly plistDeviceInode: string | null
  readonly servedCheckout: string | null
  readonly installation: string
  readonly credentialPath: string | null
  readonly credentialDeviceInode: string | null
  readonly databaseHost: string | null
  readonly databasePort: string | null
  readonly databaseName: string | null
  readonly disposition: string
}

/**
 * The manual procedure an operator carried out, RECORDED and not trusted.
 *
 * This is what remains of the quiescence attestation. It authorizes the A-G
 * stop procedure and stamps when a person did it, which belongs in the
 * evidence; it supplies no pid, no role and no census value, because a number
 * an operator typed is a number an operator can choose.
 */
export interface QuiescenceAttestation {
  readonly authorizedBy: string
  readonly authorizedAt: string
  readonly procedure: string
}

export interface OperationalGateInput {
  /** The fence this gate is about: which backend, under which mechanism. */
  readonly fence: {
    readonly supervisorPid: string
    readonly backendStart: string
    readonly mechanism: SequenceFenceId
  }
  /** BORROWED. Read through; never ended, never rolled back by the gate. */
  readonly supervisor: FenceExecutor
  readonly prover: FenceExecutor
  readonly quiescence: QuiescenceAdapter
  readonly queue: QueueAdapter
  /** Re-measured WHILE FENCED and compared with `expectedProducers`. */
  readonly destinations: DestinationCensusAdapter
  readonly expectedProducers: readonly ProducerCensusRow[]
  /**
   * OTHER SESSIONS THIS PROCESS OWNS AND IS STILL HOLDING.
   *
   * The supervisor and the prover are not always the whole story: during a real
   * copy the lifecycle also holds Stage 2's source snapshot and, while a
   * verification is running, the verifier's own sessions. Those are legitimate
   * and they are on the source, so the census has to know about them - but it
   * learns about them by ASKING EACH ONE WHO IT IS, not by being handed a list.
   * A caller can only put a session in here that it actually has open, and the
   * session's own answer to `SESSION_IDENTITY_SQL` is what gets recorded.
   */
  readonly ownedSessions?: readonly IdentifiableSession[]
  /** Recorded into the evidence. Never a source of census values. */
  readonly attestation?: QuiescenceAttestation
  readonly deadlineMs?: number
  /** TEST-ONLY seam for the reviewed inter-sample interval. */
  readonly __sleep?: (ms: number) => Promise<void>
}

/**
 * Anything that can be asked who it is. A live session, never a record.
 *
 * Either shape answers: `send` is what a `FenceExecutor` offers and `rows` is
 * what a `DriverSession` offers. The census needs one statement's worth of
 * answer, not a particular interface.
 */
export interface IdentifiableSession {
  send?(sql: string): Promise<{ rows: string[][]; error: 'statement-refused' | null }>
  rows?(sql: string): Promise<string[][]>
}

/** What the operational half established. Shared by both gates. */
export interface OperationalFindings {
  readonly fence: FenceFactsLike
  readonly producers: readonly ProducerState[]
  /** The full per-producer measurement, when the adapter supplied one. */
  readonly producerMeasurements: readonly ProducerQuiescenceMeasurement[]
  readonly queueSamples: readonly QueueSample[]
  readonly activity: { readonly sessions: number; readonly unreviewed: number }
  /** The pid+role pairs the gate DERIVED, not any it was handed. */
  readonly derivedSessions: readonly ReviewedSession[]
  /** The fenced producer census, which agreed with the pre-fence one. */
  readonly fencedProducers: readonly ProducerCensusRow[]
}

/**
 * THE OPERATIONAL PROOFS, run identically by both gates.
 *
 * Supervisor identity, the complete fence from an independent backend with
 * nothing queued, quiescence measured again rather than remembered, the source
 * activity census, and two bounded queue samples. Nothing here knows what a
 * copy is, which is precisely why a rehearsal can run it.
 */
export async function proveOperationalState(
  i: OperationalGateInput,
): Promise<OperationalFindings> {
  const deadlineMs = i.deadlineMs ?? ADAPTER_DEADLINE_MS

  // 1. WHO EACH SESSION IS, ASKED OF EACH SESSION. The supervisor must still
  //    be the backend that took the fence - the same pid AND the same start -
  //    and the prover must be somebody else.
  const supervisor = await sessionIdentity(i.supervisor, 'supervisor')
  if (supervisor.pid !== i.fence.supervisorPid ||
      supervisor.backendStart !== i.fence.backendStart) {
    throw new ReleaseGateRefused('the supervisor is not the backend that held the fence')
  }
  const prover = await sessionIdentity(i.prover, 'prover')
  if (prover.pid === supervisor.pid) {
    throw new ReleaseGateRefused('the complete source fence was not proved held',
                                 'the prover is the supervisor')
  }

  // 2. THE COMPLETE FENCE, from that independent backend.
  const proof: FenceProofResult =
    await attemptFenceProof(i.prover, i.fence.supervisorPid, i.fence.mechanism)
  if (proof.outcome !== 'held' || proof.facts === null) {
    throw new ReleaseGateRefused('the complete source fence was not proved held', proof.cause)
  }

  // 3. AND THE PROVER AGREES ABOUT WHEN THE SUPERVISOR STARTED. Read from the
  //    independent side, so a supervisor that died and reconnected cannot
  //    report its NEW backend's start as though it were the one that fenced.
  const observed = await observedBackendStart(i.prover, i.fence.supervisorPid)
  if (observed === null || observed !== i.fence.backendStart) {
    throw new ReleaseGateRefused('the supervisor is not the backend that held the fence',
                                 'the backend start does not match')
  }

  const producers = await reportProducers(i.quiescence, deadlineMs)
  // THE FULL MEASUREMENT TOO, when the adapter has one. The verdicts above are
  // what the gate compares; these are what the evidence records.
  const producerMeasurements = await measureProducers(i.quiescence, deadlineMs)
  const owned: ReviewedSession[] = [
    Object.freeze({ pid: supervisor.pid, role: supervisor.role }),
    Object.freeze({ pid: prover.pid, role: prover.role }),
  ]
  for (const extra of i.ownedSessions ?? []) {
    // ASKED, NOT DECLARED. A caller can only list a session it is holding, and
    // what goes in the census is that session's own answer.
    const who = await sessionIdentity(extra, 'owned')
    owned.push(Object.freeze({ pid: who.pid, role: who.role }))
  }
  const derivedSessions: readonly ReviewedSession[] = Object.freeze(owned)
  const activity = await censusActivity(i, derivedSessions)

  // 4. THE FENCED PRODUCER CENSUS, compared with the pre-fence one.
  const fencedProducers = await remeasureDestinations(i, deadlineMs)

  const queueSamples = await sampleQueues(i.queue, deadlineMs, i.__sleep)

  return Object.freeze({
    fence: Object.freeze({ ...proof.facts, supervisorBackendStart: observed }),
    producers: Object.freeze(producers.map(p => Object.freeze({ ...p }))),
    producerMeasurements,
    queueSamples,
    activity,
    derivedSessions,
    fencedProducers,
  })
}

/**
 * Ask one session who it is. Every field is that session's own answer.
 *
 * THE REFUSAL NAMES WHAT IS ACTUALLY WRONG. A supervisor that will not answer
 * is a supervisor nobody can show still holds the fence; a prover that will not
 * answer leaves the fence unproved; an owned session that will not answer is a
 * connection on the source nobody accounted for. Three different problems, and
 * an operator reading one refusal for all three would look in the wrong place.
 */
async function sessionIdentity(
  x: IdentifiableSession, which: 'supervisor' | 'prover' | 'owned',
): Promise<{ pid: string; role: string; backendStart: string }> {
  const refusal: GateRefusal = which === 'supervisor'
    ? 'the supervisor is not the backend that held the fence'
    : which === 'prover'
      ? 'the complete source fence was not proved held'
      : 'the source carries sessions that are not reviewed'
  let r: { rows: string[][]; error: 'statement-refused' | null }
  try {
    r = typeof x.send === 'function'
      ? await x.send(SESSION_IDENTITY_SQL)
      : { rows: await (x.rows as (sql: string) => Promise<string[][]>)(SESSION_IDENTITY_SQL),
          error: null }
  } catch {
    throw new ReleaseGateRefused(refusal, `the ${which} did not answer`)
  }
  if (r.error !== null) {
    throw new ReleaseGateRefused(refusal, `the ${which} refused to identify itself`)
  }
  const [pid, role, start] = r.rows[0] ?? []
  if (typeof pid !== 'string' || !/^\d+$/.test(pid) ||
      typeof role !== 'string' || !IDENT.test(role) ||
      typeof start !== 'string' || !BACKEND_START_SHAPE.test(start)) {
    throw new ReleaseGateRefused(refusal, `the ${which} identity is not in the reviewed form`)
  }
  return { pid, role, backendStart: start }
}

/**
 * THE SAME BACKEND STILL HOLDS THE SAME FENCE - asserted at a STAGE SEAM.
 *
 * WHY A SEAM NEEDS ITS OWN PROOF. `proveOperationalState` already makes this
 * check, but it needs quiescence and queue adapters because it is a GATE: it
 * answers "is the whole operational world still as reviewed". Between Stage 1
 * and Stage 2 there is no producer question to ask - the producers were stopped
 * before any of this began - and only one thing can have changed: the
 * supervisor. Reusing the gate here would mean re-measuring launchd and Redis
 * to learn something about a database session.
 *
 * TWO SIDES, BECAUSE ONE CANNOT DETECT ITS OWN REPLACEMENT. The supervisor is
 * asked who it is, and an INDEPENDENT backend is asked when that pid started.
 * A supervisor that died and reconnected would answer the first question with
 * its new backend's start and be believed; the prover's answer is what catches
 * it. Pid alone is not identity - `backend_start` is in the fence for exactly
 * this reason.
 */
export async function assertFencedSupervisorUnchanged(
  supervisor: IdentifiableSession, prover: FenceExecutor,
  // THE MINIMAL SHAPE, stated rather than borrowed. `FenceFactsLike` calls this
  // field `supervisorBackendStart` and the gate's own input calls it
  // `backendStart`; naming the two fields this proof actually needs keeps it
  // structurally satisfiable by `AcquiredFence` without importing either.
  fence: { readonly supervisorPid: string; readonly backendStart: string },
): Promise<void> {
  const observedSupervisor = await sessionIdentity(supervisor, 'supervisor')
  if (observedSupervisor.pid !== fence.supervisorPid ||
      observedSupervisor.backendStart !== fence.backendStart) {
    throw new ReleaseGateRefused('the supervisor is not the backend that held the fence',
                                 'the supervisor changed between stages')
  }
  const observedProver = await sessionIdentity(prover, 'prover')
  if (observedProver.pid === observedSupervisor.pid) {
    throw new ReleaseGateRefused('the complete source fence was not proved held',
                                 'the prover is the supervisor')
  }
  const independent = await observedBackendStart(prover, fence.supervisorPid)
  if (independent === null || independent !== fence.backendStart) {
    throw new ReleaseGateRefused('the supervisor is not the backend that held the fence',
                                 'the backend start does not match')
  }
}

/** When a named backend started, as an INDEPENDENT session sees it. */
async function observedBackendStart(
  prover: FenceExecutor, pid: string,
): Promise<string | null> {
  let r: { rows: string[][]; error: 'statement-refused' | null }
  try {
    r = await prover.send(BACKEND_START_SQL(pid))
  } catch {
    return null
  }
  if (r.error !== null) return null
  const v = r.rows[0]?.[0] ?? ''
  return BACKEND_START_SHAPE.test(v) ? v : null
}

/**
 * Re-measure the producers WHILE FENCED and refuse any drift.
 *
 * Compared field by field through the canonical serializer rather than by
 * eyeballing a digest, so the refusal can say which label moved.
 */
async function remeasureDestinations(
  i: OperationalGateInput, deadlineMs: number,
): Promise<readonly ProducerCensusRow[]> {
  let fenced: readonly ProducerCensusRow[]
  try {
    fenced = await withDeadline('quiescence', deadlineMs, ctx => i.destinations.measure(ctx))
  } catch (e) {
    throw new ReleaseGateRefused(
      'the fenced producer census does not agree with the pre-fence one',
      e instanceof AdapterDeadlineExceeded ? 'the fenced census deadline' : 'the fenced census')
  }
  if (fenced.length !== i.expectedProducers.length) {
    throw new ReleaseGateRefused(
      'the fenced producer census does not agree with the pre-fence one',
      'the fenced census covers a different set')
  }
  for (let n = 0; n < fenced.length; n += 1) {
    const before = i.expectedProducers[n] as ProducerCensusRow
    const after = fenced[n] as ProducerCensusRow
    if (canonicalJson({ ...before } as unknown as Canonical) !==
        canonicalJson({ ...after } as unknown as Canonical)) {
      throw new ReleaseGateRefused(
        'the fenced producer census does not agree with the pre-fence one',
        `${before.label} changed under the fence`)
    }
  }
  return Object.freeze(fenced.map(p => Object.freeze({ ...p })))
}

/** The rehearsal's authorization. Same registry, same single-use semantics. */
export interface OperationalReleaseAuthorization {
  readonly [RELEASE_AUTHORIZATION]: true
  readonly kind: 'operational'
  readonly fence: FenceFactsLike
  readonly producers: readonly ProducerState[]
  /** The full per-producer measurement, carried into the evidence. */
  readonly producerMeasurements: readonly ProducerQuiescenceMeasurement[]
  readonly queueSamples: readonly QueueSample[]
  readonly activity: { readonly sessions: number; readonly unreviewed: number }
  /** The pid+role pairs the gate DERIVED. Carried into the evidence. */
  readonly derivedSessions: readonly ReviewedSession[]
  /** The fenced producer census that agreed with the pre-fence one. */
  readonly fencedProducers: readonly ProducerCensusRow[]
}

/**
 * THE OPERATIONAL RELEASE GATE - everything the copy gate proves about the
 * WORLD, and nothing it proves about a copy.
 *
 * Used by the non-mutating operational rehearsal, and by the pre-COMMIT and
 * NOT_COMMITTED_PRISTINE paths, where there is no successful verifier to point
 * at and requiring one would leave the fence unreleasable.
 */
export async function runOperationalGate(
  i: OperationalGateInput,
): Promise<OperationalReleaseAuthorization> {
  const found = await proveOperationalState(i)
  const authorization = Object.freeze({
    kind: 'operational' as const,
    fence: found.fence,
    producers: found.producers,
    producerMeasurements: found.producerMeasurements,
    queueSamples: found.queueSamples,
    activity: found.activity,
    derivedSessions: found.derivedSessions,
    fencedProducers: found.fencedProducers,
  })
  // ONE REGISTRY for both gates, so consume-before-await and non-replay are the
  // same property here as they are for a copy release.
  AUTHORIZATIONS.set(authorization, {
    supervisor: i.supervisor,
    supervisorPid: found.fence.supervisorPid,
    supervisorBackendStart: found.fence.supervisorBackendStart,
    consumed: false,
  })
  return authorization as unknown as OperationalReleaseAuthorization
}

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

  // 1-2 AND 7-9. THE OPERATIONAL HALF, identical to the rehearsal's.
  const found = await proveOperationalState({
    fence: h.fence, supervisor: i.supervisor, prover: i.prover,
    quiescence: i.quiescence, queue: i.queue,
    destinations: i.destinations, expectedProducers: i.expectedProducers,
    ...(i.ownedSessions === undefined ? {} : { ownedSessions: i.ownedSessions }),
    ...(i.attestation === undefined ? {} : { attestation: i.attestation }),
    ...(i.deadlineMs === undefined ? {} : { deadlineMs: i.deadlineMs }),
    ...(i.__sleep === undefined ? {} : { __sleep: i.__sleep }),
  })

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

  const authorization = Object.freeze({
    rootDigest: h.rootDigest,
    sourceContractDigest: h.sourceContractDigest,
    targetContractDigest: h.targetContractDigest,
    sequences: Object.freeze(sequences.map(s => Object.freeze({ ...s }))),
    fence: found.fence,
    producers: found.producers,
    queueSamples: found.queueSamples,
    activity: found.activity,
    verifierBundle: bundle,
  })
  // REGISTERED LAST, after every proof above has passed and the object is
  // final - and registered WITH what it was proved against, so the release can
  // check it is about to end the same transaction the gate examined.
  AUTHORIZATIONS.set(authorization, {
    supervisor: i.supervisor,
    supervisorPid: found.fence.supervisorPid,
    supervisorBackendStart: found.fence.supervisorBackendStart,
    consumed: false,
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
  i: OperationalGateInput, reviewedSessions: readonly ReviewedSession[],
): Promise<{ sessions: number; unreviewed: number }> {
  const refuse = (at: string | null = null): never => {
    throw new ReleaseGateRefused('the source carries sessions that are not reviewed', at)
  }
  // THE REVIEWED SET ITSELF MUST BE COHERENT. One pid claimed by two roles, or
  // one pid listed twice, is an allowlist that cannot be checked against.
  const byPid = new Map<string, string>()
  for (const r of reviewedSessions) {
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
/** The full per-producer measurement, when the adapter offers one. */
async function measureProducers(
  q: QuiescenceAdapter, deadlineMs: number,
): Promise<readonly ProducerQuiescenceMeasurement[]> {
  if (typeof q.measure !== 'function') return Object.freeze([])
  try {
    const rows = await withDeadline('quiescence', deadlineMs,
                                    ctx => (q.measure as NonNullable<typeof q.measure>)(ctx))
    return Object.freeze(rows.map(r => Object.freeze({
      ...r, processPids: Object.freeze([...r.processPids]),
    })))
  } catch (e) {
    throw new ReleaseGateRefused('a reviewed producer is not stopped',
                                 e instanceof AdapterDeadlineExceeded
                                   ? 'the measurement deadline' : 'the measurement')
  }
}

async function sampleQueues(
  q: QueueAdapter, deadlineMs: number,
  sleep: ((ms: number) => Promise<void>) | undefined,
): Promise<readonly QueueSample[]> {
  const refuse = (at: string | null = null): never => {
    throw new ReleaseGateRefused('the queue samples are not empty and stable', at)
  }
  const wait = sleep ?? ((ms: number) => new Promise<void>(r => { setTimeout(r, ms) }))
  const samples: QueueSample[] = []
  for (let n = 0; n < 2; n += 1) {
    // THE REVIEWED INTERVAL BETWEEN THEM. Two samples taken in the same
    // millisecond are one sample written down twice, and the pair exists to
    // establish that the queues are STAYING empty rather than merely being
    // empty at an instant nobody chose.
    if (n > 0) await wait(QUEUE_SAMPLE_INTERVAL_MS)
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
 * WHAT MAY BE SAID DEPENDS ON WHAT CAME BACK, and on nothing else.
 *
 * THE LEASE IS KNOWN GONE ONLY ONCE THE ROLLBACK IS ACKNOWLEDGED. With an
 * acknowledgement the transaction has ended, and the only question left is
 * whether the census confirmed it: `released` when it did, `released-unproved`
 * when it did not - never `unproved`, which would imply the fence might still
 * be this process's to hold, and never `held`, which would then be false.
 *
 * WITHOUT AN ACKNOWLEDGEMENT NOTHING IS ESTABLISHED. A missing acknowledgement
 * and a missing census proof are not degrees of the same thing: the second
 * means the transaction provably ended and the confirmation is absent, while
 * the first means nobody can say whether the statement ran at all. That is
 * `release-unknown`, and it is not a weaker `released-unproved`.
 */
export async function releaseFence(
  supervisor: FenceExecutor,
  authorization: ReleaseAuthorization | OperationalReleaseAuthorization,
): Promise<ReleaseResult> {
  // THE THREE SYNCHRONOUS CHECKS, THEN THE CONSUMPTION, WITH NO `await` BETWEEN
  // THEM. That ordering is the whole concurrency argument: JavaScript will not
  // interleave these statements, so two callers racing on one authorization
  // cannot both get past the `consumed` test - the first marks it and the
  // second finds it marked. A PID query placed before the consumption would put
  // an `await` in that window and hand both of them a release.
  const record = AUTHORIZATIONS.get(authorization as object)
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
    alive = await supervisor.send(SESSION_IDENTITY_SQL)
  } catch {
    throw new ReleaseGateRefused('the complete source fence was not proved held',
                                 'the supervisor could not be reached')
  }
  // PID AND BACKEND START. A supervisor that died and reconnected can come
  // back on the same pid holding none of the fence, and rolling THAT back
  // would release nothing while reporting a release.
  if (alive.error !== null ||
      (alive.rows[0]?.[0] ?? '') !== record.supervisorPid ||
      (alive.rows[0]?.[2] ?? '') !== record.supervisorBackendStart) {
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
    /**
     * THE `device:inode` OF A TEMPORARY DIRECTORY THIS PUBLICATION CREATED.
     *
     * Carried through from `EvidenceRefused.createdIdentity` unchanged - null when
     * the failure happened before the publisher's own `mkdir`, EEXIST included. A
     * caller may treat a non-null value as permission to clear that exact object,
     * and nothing else as permission at all.
     */
    readonly creationReceipt: string | null = null,
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
  /**
   * THE ALREADY-SERIALIZED BYTES, when the caller has to know them.
   *
   * WHY THIS EXISTS. A caller that republishes one record after a transient
   * failure has to be able to say that the second attempt wrote the same bytes
   * as the first, and comparing two documents it serialized separately proves
   * nothing about what this function serialized. So a caller that must make
   * that claim serializes ONCE, keeps the bytes, and hands them here; the
   * bytes it retries with and the bytes it compares an occupied destination
   * against are then the same object, not two hopefully-equal derivations.
   *
   * WHEN OMITTED the document is serialized here, exactly as before. Supplying
   * bytes that do not correspond to `manifest`/`detail` is not detectable and
   * is not meant to be: these are two spellings of one value, and the caller
   * that chooses to supply the bytes owns that correspondence.
   */
  readonly manifestBytes?: Buffer
  readonly detailBytes?: Buffer
  /** Names the retry scratch directory. See `evidenceNames`. */
  readonly temporaryTag?: string
  /**
   * BUILD THE BUNDLE, OR PUBLISH ONE THAT IS ALREADY BUILT.
   *
   * `retained` skips straight to the rename, for a scratch directory the caller
   * has already proved holds exactly the frozen record - see `inspectScratch`.
   * Rebuilding one of those would mean unfreezing files that are already 0400
   * and one syscall away from being evidence, for no gain: the bytes on disk are
   * the bytes we would write.
   *
   * The outcome classification is identical either way, which is why this is a
   * field here rather than a second function with its own error handling.
   */
  readonly reuse?: 'build' | 'retained'
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
  const input = {
    root: i.root, prefix: i.prefix, stamp: i.stamp, runId: i.runId,
    artifacts: [{ path: i.detailFile, bytes: i.detailBytes ?? bytes(i.detail) }],
    manifest: { path: i.manifestFile, bytes: i.manifestBytes ?? bytes(i.manifest) },
    ...(i.temporaryTag === undefined ? {} : { temporaryTag: i.temporaryTag }),
  }
  try {
    return i.reuse === 'retained'
      ? publishRetainedScratch(input, ops)
      : publishEvidence(input, ops)
  } catch (e) {
    let finalPath = i.root
    let temporaryPath: string | null = null
    try {
      const names = evidenceNames(i.prefix, i.stamp, i.runId, i.temporaryTag)
      finalPath = join(i.root, names.finalName)
      temporaryPath = join(i.root, names.temporaryName)
    } catch { /* the names themselves were refused; the root is all there is */ }

    // THE RECEIPT, READ FROM THE ERROR AND NEVER RE-DERIVED. Only the publisher
    // knows whether its own `mkdir` ran.
    const receipt = (e instanceof EvidenceRefused ||
                     e instanceof EvidencePublishedButUnverified ||
                     e instanceof EvidencePublicationUnknown)
      ? e.createdIdentity : null
    if (e instanceof EvidencePublishedButUnverified) {
      throw new LifecycleEvidenceFailed(
        i.prefix, 'published-unverified', e.phase, null, finalPath, 'present', null, 'absent',
        receipt)
    }
    if (e instanceof EvidencePublicationUnknown) {
      throw new LifecycleEvidenceFailed(
        i.prefix, 'unknown', 'publish', null,
        finalPath, 'unproved', temporaryPath, 'unproved', receipt)
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
      finalPath, finalState, created ? temporaryPath : null, tempState, receipt)
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
  outcome: LifecycleOutcome,
): Canonical => ({
  lifecycle_version: LIFECYCLE_DOCUMENT_VERSION,
  complete: true,
  record: 'lifecycle-outcome',
  run: { id: runId, stamp },
  bundle: { name: h.bundleName, release_gate: gateBundle },
  // SUPPLIED, NOT DERIVED. A failure is always STOPPED; a success is whichever
  // terminal state the restoration authority makes true, decided by the caller
  // that also returns it.
  outcome: failure === null ? outcome : 'STOPPED',
  failure: failure === null
    ? null
    : { phase: failure.phase, reason: failure.reason, at: failure.at },
  fence: {
    state: fence,
    sentence: LIFECYCLE_FENCE_SENTENCE[fence],
    remaining_locks: release?.remainingLocks ?? null,
  },
  release: release === null ? null : { state: release.state },
  /**
   * SAID OUTRIGHT, not left to be inferred from `restoration: null`.
   *
   * A manual-stop run ends with the copy verified, the fence proved released
   * and the producers still down by authorization. `restoration: null` alone
   * reads as "no restoration record", which a reader could take either way;
   * `false` is the fact. COMPLETE is unreachable while this is false.
   */
  producers_restored: restoration !== null && restoration.failedAt === null,
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
  /** Who restores the producers, or that nobody will. See RestorationAuthority. */
  readonly restorationAuthority: RestorationAuthority
  /**
   * THE FENCE THIS RUN INHERITED, on the production path.
   *
   * The continuous-fence contract is that ONE supervisor transaction covers
   * Stage 1, Stage 2, verification and the release. When the caller took the
   * fence before Stage 1 it passes it here, and Stage 2 PROVES it rather than
   * taking a second one. Undefined on the disposable path, which owns its own.
   */
  readonly preAcquiredFence?: AcquiredFence
  /**
   * Re-measured WHILE FENCED and compared with `expectedProducers`.
   *
   * THE SESSION ALLOWLIST IS GONE FROM HERE. It used to be
   * `reviewedSessions` - exact pid+role pairs an operator supplied - and an
   * allowlist a person types is an allowlist a person can extend by one line
   * to license exactly the connection the census exists to find. The gate now
   * asks the supervisor and the prover who they are and accepts nobody else.
   */
  readonly destinations: DestinationCensusAdapter
  readonly expectedProducers: readonly ProducerCensusRow[]
  /**
   * OTHER LIVE SOURCE SESSIONS THE CALLER OWNS.
   *
   * Merged with the lifecycle's own stage-source session at gate time, and
   * each one is ASKED who it is. A caller can only list a session it actually
   * holds; nothing here is a pid somebody typed.
   */
  readonly ownedSessions?: readonly IdentifiableSession[]
  /** Recorded into the evidence. Never a source of census values. */
  readonly attestation?: QuiescenceAttestation
  readonly deadlineMs?: number
  /** TEST-ONLY seam for the reviewed inter-sample interval. */
  readonly __sleep?: (ms: number) => Promise<void>
  /**
   * How an unanswered COMMIT is classified. Injected so a suite can exercise
   * all three continuations without two live clusters; production gets the
   * reviewed `classifyTargetDisposition`.
   */
  readonly classifyDisposition?: (i: DispositionInput) => Promise<DispositionResult>

  readonly evidenceRoot: string
  readonly runIds?: { verification?: string; releaseGate?: string; lifecycle?: string }
  readonly stamp?: string
  readonly ops?: EvidenceOps
}

export interface LifecycleResult {
  /**
   * NO LIFECYCLE OUTCOME IS COMPLETE, on either authority.
   *
   * K7-B7.1: this comment used to say COMPLETE was reachable when an adapter
   * restored the producers, and that is no longer true of the type or the
   * behaviour. An adapter that restored and confirmed every producer returns
   * `COPY_VERIFIED_RESTORED_AWAITING_CLOSURE`; manual-stop returns
   * `COPY_VERIFIED_AWAITING_MANUAL_RESTORATION` with the producers still down
   * by authorization. Either way the copy is verified, the fence is proved
   * released, and the copy is NOT closed: closure happens later, in a separate
   * reviewed mode, against a copy-restoration record - and that closure is the
   * only document permitted to say the word.
   */
  readonly outcome: Exclude<LifecycleOutcome, 'STOPPED'>
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
 * is PROVED, every failure raises `LifecycleInterventionRequired` - no producer
 * is restored, nothing is retried, and the primary failure is preserved
 * whatever else happens on the way out.
 *
 * WHAT THAT INTERVAL DOES NOT PROMISE IS THAT THE FENCE IS STILL HELD. Up to
 * the release attempt it is, and the state says which of `held`, `not-held` or
 * `unproved` was established; from the attempt onwards it may also be
 * `release-unknown` - attempted, execution never established - or
 * `released-unproved` - acknowledged, and the confirming census absent. Every
 * failure in this interval records exactly one of those five, and every one of
 * them needs a person.
 *
 * RESTORATION HAPPENS ONLY AFTER `released` IS PROVED. Past that point the
 * lease is gone and cannot be described as anything else, so a restoration
 * failure reports `released` with an exact boundary rather than pretending it
 * is still available.
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
  /** Set only when a MEASUREMENT settled an unanswered COMMIT. */
  let commitUnknownResolved: TargetDisposition | null = null
  let dispositionEvidence: EvidenceState = NO_EVIDENCE
  let pristineEvidence: EvidenceState = NO_EVIDENCE
  let commitUnknownPath: {
    continue: 'verify' | 'release-operational'
    handoff: CommitUnknownHandoff
  } | null = null
  let applied: ApplyResult | null = null
  let verification: VerificationResult | null = null
  let authorization: ReleaseAuthorization | null = null
  let release: ReleaseResult | null = null
  let restoration: RestorationResult | null = null

  /** Publish the outcome record, best effort, and say truthfully what happened. */
  const recordOutcome = (
    fence: LifecycleFenceState, failure: LifecycleFailure | null, gateBundle: string | null,
    outcome: LifecycleOutcome = 'STOPPED',
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
          h, fence, release, restoration, gateBundle, failure, runIds.lifecycle, stamp,
          outcome),
        detail: actionsDocument(release, restoration),
        ops,
      })
      outcomeEvidence = verifiedEvidence(p)
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

  /**
   * L3b. THE COMMIT WENT UNANSWERED. CLASSIFY THE TARGET, THEN DECIDE.
   *
   * THREE CONTINUATIONS, AND ONLY ONE OF THEM IS "CARRY ON".
   *
   *   COMMITTED_EXACT         the target measurably holds the copy. The run
   *                           continues into independent verification and the
   *                           normal release, which is what it would have done
   *                           had the acknowledgement arrived.
   *   NOT_COMMITTED_PRISTINE  the target is measurably untouched. Nothing was
   *                           written, so there is nothing to clean up; the
   *                           fence is released through a FRESH operational
   *                           gate - not the copy gate, which would demand a
   *                           verifier PASS that cannot exist - and a retry
   *                           becomes permissible only once that outcome is
   *                           durable on disk.
   *   INDETERMINATE           nobody can say. Intervention. No retry, no
   *                           cleanup, no migration, no truncation.
   *
   * AND EVERY UNAVAILABLE PROOF IS INDETERMINATE. A target that could not be
   * opened, a contract that would not re-derive, an identity that did not
   * match - each of those is "could not establish", and `classifyTargetDisposition`
   * returns INDETERMINATE for all of them rather than guessing.
   */
  const onCommitUnknown = async (e: CommitOutcomeUnknown): Promise<{
    continue: 'verify' | 'release-operational'
    handoff: CommitUnknownHandoff
  }> => {
    // THE HANDOFF MUST HAVE BEEN MINTED BEFORE THE COMMIT WAS SUBMITTED.
    // Without it there is nothing to compare the target against, and building
    // one now would be a second chance to describe the hoped-for answer.
    if (e.commitHandoff === null) {
      await stop('L3-copy', 'the transactional copy did not complete', 'the commit outcome')
    }
    const handoff = e.commitHandoff as CommitUnknownHandoff
    const classify = i.classifyDisposition ?? classifyTargetDisposition

    let disposition: DispositionResult
    try {
      disposition = await classify({
        handoff,
        openSource: i.openVerifySource,
        openTarget: i.openVerifyTarget,
      })
    } catch {
      // A CLASSIFIER THAT THREW ESTABLISHED NOTHING.
      disposition = Object.freeze({
        disposition: 'INDETERMINATE' as const,
        cause: 'the target could not be classified',
        tables: [], sequences: [], rootDigest: null,
      })
    }

    // PUBLISHED AND VERIFIED BEFORE ANYTHING ACTS ON IT. If this process dies
    // next, what is on disk is the classification somebody would otherwise
    // have to take on trust from a terminal that is no longer there.
    dispositionEvidence = publishDisposition(disposition, handoff)
    commitUnknownResolved = disposition.disposition

    // THE EVIDENCE MUST BE DURABLE BEFORE ANY CONTINUATION IS TAKEN. A
    // classification nobody can read afterwards is a decision taken in a
    // terminal that is no longer there - and NOT_COMMITTED_PRISTINE in
    // particular is what later licenses a retry.
    if (!dispositionEvidence.verified) {
      await stop('L3-copy', 'the transactional copy did not complete', 'the commit outcome')
    }

    if (disposition.disposition === 'COMMITTED_EXACT') {
      // MEASURABLY COMMITTED. The run continues exactly as it would have.
      committed = true
      return { continue: 'verify' as const, handoff }
    }
    if (disposition.disposition === 'NOT_COMMITTED_PRISTINE') {
      // MEASURABLY UNTOUCHED. Nothing was written, so there is nothing to
      // clean up, and the fence is released through a FRESH operational gate -
      // never the copy gate, which would demand a verifier PASS that cannot
      // exist for a copy that did not land.
      return { continue: 'release-operational' as const, handoff }
    }
    // INDETERMINATE. Intervention: no retry, no cleanup, no migration, no
    // truncation, and the fence state is whatever `stop` can actually prove.
    await stop('L3-copy', 'the transactional copy did not complete', 'the commit outcome')
    throw new Error('unreachable')
  }

  /**
   * NOT_COMMITTED_PRISTINE: take the fence off through a FRESH operational gate.
   *
   * NOT THE COPY GATE. That one requires a verifier PASS bound to a published
   * verification bundle, and a copy that measurably did not land has neither -
   * so requiring it would leave the fence unreleasable and turn "nothing
   * happened" into an intervention. The operational gate proves everything
   * about the WORLD that the copy gate proves, and nothing about a copy.
   *
   * AND A RETRY IS PERMISSIBLE ONLY AFTER THIS IS DURABLE. The refusal thrown
   * at the end names the disposition bundle, so whoever runs again is running
   * against a record on disk rather than against a memory of what a terminal
   * said an hour ago.
   */
  const releaseAfterPristine = async (): Promise<never> => {
    const handoff = (commitUnknownPath as { handoff: CommitUnknownHandoff }).handoff
    let operational: OperationalReleaseAuthorization
    try {
      operational = await runOperationalGate({
        fence: {
          supervisorPid: handoff.verifierHandoff.fence.supervisorPid,
          backendStart: handoff.verifierHandoff.fence.backendStart,
          mechanism: handoff.verifierHandoff.fence.mechanism,
        },
        supervisor: i.supervisor, prover: i.prover,
        quiescence: i.quiescence, queue: i.queue,
        destinations: i.destinations, expectedProducers: i.expectedProducers,
        ownedSessions: [...(stageSource === null ? [] : [stageSource]),
                        ...(i.ownedSessions ?? [])],
        ...(i.attestation === undefined ? {} : { attestation: i.attestation }),
        ...(i.__sleep === undefined ? {} : { __sleep: i.__sleep }),
        deadlineMs: i.deadlineMs ?? ADAPTER_DEADLINE_MS,
      })
    } catch (e) {
      // THE GATE REFUSED, SO THE FENCE STAYS. Not released on a hope.
      await stop('L6-release-gate', 'the final release gate refused',
                 e instanceof ReleaseGateRefused ? e.refusal : null)
      throw new Error('unreachable')
    }
    release = await releaseFence(i.supervisor, operational)
    if (release.state !== 'released') {
      await stop('L9-release-proof', 'the fence release could not be proved', release.state)
    }
    // THE DURABLE POST-RELEASE RECORD FOR THIS PATH, AND ITS OWN BUNDLE.
    //
    // `recordOutcome` cannot describe this run: it reads `applied`, which is
    // null here because `runApply` threw before it returned anything, and it
    // therefore publishes "no Stage-2 result to describe". The consequence was
    // that a NOT_COMMITTED_PRISTINE run - a fence taken, a copy that
    // measurably did not land, a release proved with a zero-lock census -
    // left NOTHING on disk saying the fence came off. The refusal message said
    // so, and a message is not evidence.
    pristineEvidence = publishPristineRelease(release)
    if (!pristineEvidence.verified) {
      // NOT PUBLISHED MEANS NOT PERMITTED. A retry is licensed by this record;
      // without it on disk there is nothing for a later run to have read.
      await stop('L11-outcome-evidence',
                 'the lifecycle outcome evidence was not published and verified', null)
    }
    throw new LifecycleRefused(
      'L3-copy', 'the transactional copy did not complete',
      `NOT_COMMITTED_PRISTINE; the target is measurably untouched and the fence is ` +
      `released and proved. The classification is at ` +
      `${dispositionEvidence.publishedPath ?? 'no path'} and the post-release record ` +
      `at ${pristineEvidence.publishedPath ?? 'no path'}.`)
  }

  /**
   * The `pristine-release-*` record. Everything a later run needs, on disk.
   *
   * RETRY PERMISSION AND ITS BASIS, TOGETHER. "A retry is allowed" on its own
   * is an instruction; what makes it checkable is the measurement it rests on -
   * the disposition bundle that proved the target untouched, and the zero-lock
   * census that proved the fence gone. Both are named here, by basename and by
   * the digest of their DIGEST file.
   */
  const publishPristineRelease = (released: ReleaseResult): EvidenceState => {
    const handoff = (commitUnknownPath as { handoff: CommitUnknownHandoff }).handoff
    const dispositionPath = dispositionEvidence.publishedPath
    const retryAllowed = released.state === 'released' && dispositionPath !== null
    try {
      const published = publishLifecycleBundle({
        root: i.evidenceRoot, prefix: PRISTINE_RELEASE_PREFIX, stamp,
        runId: i.runIds?.lifecycle ?? newRunId(),
        manifestFile: PRISTINE_RELEASE_FILE, detailFile: PRISTINE_RELEASE_DETAIL_FILE,
        manifest: {
          record: PRISTINE_RELEASE_PREFIX,
          complete: true,
          disposition: commitUnknownResolved,
          commit_disposition: dispositionPath === null ? null : {
            name: basename(dispositionPath),
            digest_file_digest: digestOfDigestFile(dispositionPath, ops),
          },
          fence: {
            supervisor_pid: handoff.verifierHandoff.fence.supervisorPid,
            backend_start: handoff.verifierHandoff.fence.backendStart,
            mechanism: handoff.verifierHandoff.fence.mechanism,
          },
          // THE ACKNOWLEDGEMENT AND THE PROOF ARE TWO FACTS, not one.
          release_acknowledged: released.state !== 'release-unknown',
          release_state: released.state,
          remaining_reviewed_locks: released.remainingLocks,
          zero_lock_release_proved: released.state === 'released' &&
            released.remainingLocks === 0,
          retry_permitted: retryAllowed,
          retry_basis: retryAllowed
            ? 'the target is measurably untouched and the fence is proved released'
            : 'no retry is permitted; the basis for one was not established',
          bundle_name: handoff.bundleName,
        },
        detail: {
          target: {
            system_identifier: handoff.target.systemIdentifier,
            database: handoff.target.database,
            role: handoff.target.role,
          },
        },
        ops,
      })
      return verifiedEvidence(published)
    } catch (e) {
      return evidenceStateOf(e, 'the pristine-release record was not published')
    }
  }

  /**
 * The SHA-256 of a published bundle's DIGEST file.
 *
 * What makes a cross-bundle reference checkable: the basename says WHICH
 * directory and this says which CONTENTS, so a bundle replaced under the same
 * name no longer satisfies the record that pointed at it.
 */
const digestOfDigestFile = (dir: string, ops: EvidenceOps): string =>
  sha256Hex(ops.readFileSync(join(dir, DIGEST_FILE), 'utf-8'))

/** Publish the `commit-disposition-*` record. Best effort, never silent. */
  const publishDisposition = (
    d: DispositionResult, handoff: CommitUnknownHandoff,
  ): EvidenceState => {
    try {
      const published = publishLifecycleBundle({
        root: i.evidenceRoot, prefix: COMMIT_DISPOSITION_PREFIX, stamp,
        runId: i.runIds?.lifecycle ?? newRunId(),
        manifestFile: COMMIT_DISPOSITION_FILE, detailFile: COMMIT_DISPOSITION_DETAIL_FILE,
        manifest: {
          record: COMMIT_DISPOSITION_PREFIX,
          complete: true,
          disposition: d.disposition,
          cause: d.cause,
          bundle_name: handoff.bundleName,
          target: {
            system_identifier: handoff.target.systemIdentifier,
            database: handoff.target.database,
            role: handoff.target.role,
          },
          root_digest: d.rootDigest,
        },
        detail: {
          tables: d.tables.map(t => ({ ...t })),
          sequences: d.sequences.map(x => ({ ...x })),
        },
        ops,
      })
      return verifiedEvidence(published)
    } catch (e) {
      // THE FAILURE IS THE FINDING, and it is carried in the same three-state
      // shape every other bundle's failure uses: "could not examine" never
      // becomes "absent".
      return evidenceStateOf(e, 'the commit disposition record was not published')
    }
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

    // L2. QUIESCENCE, before this function takes or adopts any fence.
    //
    // A producer still running here would be writing to the source Stage 2 is
    // about to freeze. ON THE PRODUCTION PATH THE FENCE IS ALREADY HELD - the
    // caller took it before Stage 1 derived the manifest - so "before the fence
    // is even taken" was true only of the disposable path, and the operator
    // stopped the producers before any of it began. Either way this check runs
    // against a measured world rather than a remembered one.
    try {
      await assertQuiescent(i.quiescence, i.deadlineMs ?? ADAPTER_DEADLINE_MS)
    } catch (e) {
      throw new LifecycleRefused(
        'L2-quiescence', 'a reviewed producer is not stopped',
        e instanceof ReleaseGateRefused ? e.at : null)
    }

    // L3. STAGE 2, on the fence this run is COMMITTED to - not a new one.
    //
    // ADOPTED WHEN SUPPLIED, TAKEN OTHERWISE. A production apply hands in the
    // `AcquiredFence` Stage 1 returned, and Stage 2 proves that exact object
    // from an independent backend instead of calling `acquireSourceFence`
    // again. That matters more than it looks: locks are per transaction, so a
    // second acquisition on a supervisor that already holds them SUCCEEDS
    // silently, and the fence facts carried forward would then describe
    // whichever read answered last. The Stage-1-through-release chain would
    // stop being evidence that one unbroken fence covered the copy.
    //
    // The disposable path supplies nothing and keeps its own acquisition.
    stageSource = await i.openStageSource()
    let appliedResult: ApplyResult | null = null
    try {
      appliedResult = await runApply(
        applyInputFor(i, stageSource), bundleManifest)
    } catch (e) {
      if (e instanceof CommitOutcomeUnknown) {
        // NOT `committed = true`.
        //
        // That single line was the defect. "The COMMIT was submitted and no
        // acknowledgement came back" is the one state in this whole lifecycle
        // where nobody knows whether the target holds the copy - and recording
        // it as committed answered that question in the direction that happens
        // to be convenient, with no measurement behind it. The rest of the
        // lifecycle then reasoned about a committed target: the release-gate
        // path, the restoration, the outcome sentence in the evidence.
        //
        // What replaces it is a read-only classification of the actual target,
        // published as its own bundle, and three different continuations.
        commitUnknownPath = await onCommitUnknown(e)
      } else {
      // PRE-COMMIT, AND THE FENCE MAY BE HELD. A2 takes the fence, and it takes
      // it as a SEQUENCE of statements, so even a refusal at A2 itself can
      // leave part of it. Everything from there to COMMIT - the confirmation,
      // the target identity, the copy, the sequence policy, the final gates -
      // fails with the supervisor still inside that transaction. The target is
      // untouched, so this is not an intervention about data; it is a fence
      // this lifecycle must end and prove ended before anyone runs again.
        throw await cleanUpPreCommit('L3-copy', 'the transactional copy did not complete')
      }
    }

    // THE UNANSWERED-COMMIT CONTINUATIONS. `commitUnknownPath` is set only by
    // a MEASUREMENT of the live target, never by the absence of one.
    if (commitUnknownPath !== null) {
      if (commitUnknownPath.continue === 'release-operational') {
        // NOTHING WAS WRITTEN. There is no verifier PASS to point at and
        // requiring one would leave the fence unreleasable, so the fence comes
        // off through the operational gate and the run stops with a durable
        // record rather than pretending a copy happened.
        return await releaseAfterPristine()
      }
      // COMMITTED_EXACT. The handoff the copy fixed before the doubt existed
      // is what verification runs against - not one reassembled afterwards
      // from a target whose contents were in question.
      appliedResult = Object.freeze({
        verification: commitUnknownPath.handoff.verifierHandoff,
      }) as unknown as ApplyResult
    }
    // NON-NULL FROM HERE. Either `runApply` returned, or an unanswered COMMIT
    // was MEASURED as COMMITTED_EXACT and the handoff it fixed beforehand
    // stands in for the result it never got to return.
    const applyResult: ApplyResult = appliedResult as ApplyResult
    applied = applyResult
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
        handoff: applyResult.verification,
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
        handoff: applyResult.verification,
        verification: verification as VerificationResult,
        published: bundleManifest,
        reviewedTarget: i.reviewedTarget,
        supervisor: i.supervisor, prover: i.prover,
        quiescence: i.quiescence, queue: i.queue,
        destinations: i.destinations, expectedProducers: i.expectedProducers,
        // THE SESSIONS THIS LIFECYCLE IS STILL HOLDING, asked rather than
        // declared. Stage 2's source snapshot is alive at L6; the verifier's
        // have been closed by then and are not offered.
        ownedSessions: [
          ...(stageSource === null ? [] : [stageSource]),
          ...(i.ownedSessions ?? []),
        ],
        ...(i.attestation === undefined ? {} : { attestation: i.attestation }),
        ...(i.__sleep === undefined ? {} : { __sleep: i.__sleep }),
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
          authorization as ReleaseAuthorization, applyResult.verification,
          runIds.releaseGate, stamp),
        detail: gateDetailDocument(authorization as ReleaseAuthorization),
        ops,
      })
      gateEvidence = verifiedEvidence(p)
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

    // L10. RESTORATION - or its authorized absence, and only now.
    //
    // MANUAL-STOP DOES NOT CALL `restoreProducers` AT ALL. There is nothing to
    // call it with: no reviewed production ProducerAdapter exists, and the
    // operator who stopped the producers will put them back under a separate
    // mode that proves they came back. `restoration` therefore stays null, and
    // the outcome document below records that truthfully rather than reporting
    // an empty restoration as a successful one.
    if (i.restorationAuthority.kind === 'adapter') {
      restoration = await restoreProducers(
        i.restorationAuthority.producers, i.deadlineMs ?? ADAPTER_DEADLINE_MS)
      if (restoration.failedAt !== null) {
        await stop('L10-restore', 'a reviewed producer was not restored', restoration.failedAt)
      }
    }

    // L11. WHAT ACTUALLY HAPPENED, published separately from the authorization.
    //
    // If this fails, `stop` must NOT publish again: the first attempt's outcome
    // is the finding, and a second one under the same name could only collide
    // with it and report the collision instead.
    // DECIDED ONCE. This exact value is frozen in the bundle below and returned.
    const terminal = terminalOutcomeFor(i.restorationAuthority)
    outcomeEvidence = recordOutcome(
      'released', null, gateEvidence.publishedPath, terminal)
    if (!outcomeEvidence.verified) {
      await stop('L11-outcome-evidence',
                 'the lifecycle outcome evidence was not published and verified',
                 outcomeEvidence.publication)
    }

    return Object.freeze({
      // THE OUTCOME FOLLOWS THE AUTHORITY, not the absence of a failure. A
      // manual-stop run that reached here copied, verified and released
      // correctly - and its producers are still down.
      outcome: terminal,
      rootDigest: applyResult.rootDigest,
      verifierBundle: (verification as VerificationResult).evidence.finalPath,
      releaseGateBundle: gateEvidence.publishedPath as string,
      lifecycleBundle: outcomeEvidence.publishedPath as string,
      restored: restoration === null ? [] : restoration.restored,
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
 * THE COPY DID NOT COMMIT, AND THE RELEASE WAS NOT PROVED.
 *
 * WHY THIS IS NOT A REFUSAL. A refusal means a caller may fix the problem and
 * run again, and that is only true if the source is as it was. Stage 2 takes
 * the fence at A2 - and a refusal at A2 itself may have taken PART of it, since
 * acquisition is a sequence of statements - so every failure from that point on
 * leaves a transaction holding locks that this lifecycle has to deal with.
 *
 * IT ATTEMPTS ROLLBACK EXACTLY ONCE, and what happens next is decided by what
 * came back, not by what was hoped for. Only when the release is PROVED - an
 * acknowledged ROLLBACK and a census showing none of the reviewed locks - does
 * this become an ordinary `LifecycleRefused` that a caller may act on.
 * Otherwise the exact state is preserved for a person: `unproved` when the
 * server answered and REFUSED, so the transaction never ended; `release-unknown`
 * when the transport failed and execution was never established;
 * `released-unproved` when the ROLLBACK was acknowledged and the confirming
 * census was not. Telling the caller "try again" in any of those three would
 * invite a second run into a source the first one may still be holding.
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
