// SLICE 9 — the independent post-copy verifier, and its immutable evidence.
//
// WHERE THIS RUNS. Stage 2 has COMMITTED. The supervisor still holds the entire
// source fence, the producers are still stopped, and nothing has been released.
// That window is the only moment at which the source can be re-read and proved
// unchanged, so the verification happens inside it or it does not happen at all.
//
// WHY A SEPARATE VERIFIER. Stage 2 already compares a target manifest with a
// source manifest, and both come out of ONE implementation. A normalisation
// defect in that implementation - a trimmed numeric scale, a text rendering, an
// unordered fold - corrupts both sides identically, they agree, and the copy is
// declared correct. This module measures both databases again through
// `verify-content.ts`, which is written from the contract and imports no part
// of the copier's content path, so the two have to agree for independent
// reasons or not at all.
//
// WHAT FAILURE MEANS HERE, AND WHY IT IS NOT A REFUSAL. Before COMMIT, a
// refusal meant the target was provably untouched and a retry was safe. After
// COMMIT it means the target holds data nobody has verified. There is nothing
// safe to do about that automatically, so this module does none of it: no
// retry, no truncate, no clean-up, no migration, no fence release, no producer
// restoration. It raises `PostCommitVerificationFailed`, publishes evidence
// saying FAIL, and leaves every lock exactly where it found it. A person
// decides what happens next.
//
// WHAT IT OWNS AND WHAT IT BORROWS. The supervisor transaction and the proving
// session belong to the caller; this module reads through them and never sends
// BEGIN, COMMIT, ROLLBACK or an unlock to either - enforced, not documented, by
// the read-only wrapper below. The two verification sessions are its own: it
// opens them, begins one READ ONLY REPEATABLE READ transaction on each as the
// first statement, and rolls back and closes those and only those.

import { join } from 'node:path'

import {
  DIGEST_FILE, EvidencePublicationUnknown, EvidencePublishedButUnverified, EvidenceRefused,
  REAL_EVIDENCE_OPS, evidenceNames, evidenceStamp, newRunId, pathIsPresent, publishEvidence,
  type EvidenceOps, type EvidencePhase, type EvidenceReason, type PublishedEvidence,
  type PublishedPhase,
} from './evidence.js'
import {
  COPY_TABLES, REVIEWED_CONTRACT_DIGEST, SOURCE_V10_PROFILE, TARGET_V19_PROFILE,
  canonicalJson, extractContractFromSession,
  type Canonical, type ContractArtifact,
} from './schema-contract.js'
import {
  assertCopyCompatible, compatibilityDocument,
} from './copy-compatibility.js'
import {
  FENCE_PROOF_SQL, FENCE_SEQUENCES, SELECTED_SEQUENCE_FENCE, SEQUENCE_STATE_SQL,
  assertFenceProof, effectiveNext, fenceRelationArray, parseLockRows, parseSequenceState,
  type FenceExecutor, type SequenceFenceId,
} from './source-fence.js'
import { SET_LOCAL_ROLE_SQL } from './target-authority.js'
import {
  verifyAllTables, verifyVectorFrom,
  type VerifiedContent, type VerifySession, type VerifyVector,
} from './verify-content.js'

/** Bumped when the evidence document changes shape. */
export const VERIFICATION_DOCUMENT_VERSION = 1

/** The evidence prefix this module publishes under. */
export const VERIFICATION_PREFIX = 'verification'

/** The manifest, and the detail artifact beside it. */
export const VERIFICATION_FILE = 'verification.json'
export const VERIFICATION_CONTENT_FILE = 'content.json'

/**
 * The FIRST statement of each verification session, and the only transaction
 * either of them opens.
 *
 * READ ONLY is what makes a verifier that cannot alter what it is measuring a
 * property of the transaction rather than of this code; REPEATABLE READ is what
 * makes the contract extraction, the 21 table digests and the sequence reads one
 * moment instead of twenty-five.
 */
export const VERIFY_BEGIN_SQL = 'BEGIN TRANSACTION READ ONLY ISOLATION LEVEL REPEATABLE READ'
export const VERIFY_ROLLBACK_SQL = 'ROLLBACK'

/** Identity and transaction state, in ONE observation. */
export const VERIFY_IDENTITY_SQL = `
SELECT pg_catalog.pg_backend_pid()::pg_catalog.text,
       (pg_catalog.pg_control_system()).system_identifier::pg_catalog.text,
       pg_catalog.current_database()::pg_catalog.text,
       CURRENT_USER::pg_catalog.text,
       SESSION_USER::pg_catalog.text,
       pg_catalog.current_setting('transaction_read_only'),
       pg_catalog.current_setting('transaction_isolation')`

export const VERIFY_IDENTITY_COLUMNS = 7

/** The supervisor's own backend pid. The only thing asked of it besides reads. */
export const SUPERVISOR_PID_SQL = 'SELECT pg_catalog.pg_backend_pid()'

// ---------------------------------------------------------------------------
// FAILURE
// ---------------------------------------------------------------------------

/** WHERE a post-commit verification stopped. */
export type VerifyPhase =
  | 'V1-handoff'
  | 'V2-supervisor'
  | 'V3-fence-before'
  | 'V4-source-session'
  | 'V5-target-session'
  | 'V6-source-contract'
  | 'V7-target-contract'
  | 'V8-content'
  | 'V9-sequences'
  | 'V10-compatibility'
  | 'V11-fence-after'
  | 'V12-evidence'

/**
 * WHY it stopped. A CLOSED union of reviewed sentences.
 *
 * Every one of these can be read here without running anything, which is the
 * point: a verifier that interpolated what it found would put row values,
 * connection strings and role names into whatever log caught it. The only
 * variable part any failure carries is a reviewed table or property NAME.
 */
export type VerifyReason =
  | 'the Stage-2 handoff is not in the reviewed form'
  | 'the supervisor is not the backend that held the fence'
  | 'the complete source fence was not held before verification'
  | 'the source verification session could not be prepared'
  | 'the target verification session could not be prepared'
  | 'the source is not the confirmed Stage-1 source'
  | 'the live target is not the reviewed target'
  | 'the independently measured content does not match'
  | 'the sequence positions do not match'
  | 'the compatibility document does not match'
  | 'the complete source fence was not held after verification'
  | 'the verification evidence was not published'
  | 'the verification evidence was built but not published'
  | 'the verification evidence was published but not verified'
  | 'the verification evidence publication outcome is unknown'
  | 'the verification evidence was not published and a path is already occupied'
  | 'the verification evidence state on disk could not be examined'

/**
 * POST-COMMIT VERIFICATION FAILED. The target holds UNVERIFIED data.
 *
 * Deliberately not a `Stage2Refused` and deliberately not retryable. A refusal
 * says the target is untouched; this says nobody can vouch for what is in it.
 * The fence is still held, the producers are still stopped, and no clean-up has
 * been attempted or should be.
 */
/**
 * The reviewed reason for each phase.
 *
 * A failure that is not one of this module's own - a driver that died, a
 * session that refused a statement - still happened SOMEWHERE, and reporting it
 * all as a content mismatch would send a person to look at the rows when the
 * problem was the connection. Nothing from the underlying error is used; only
 * the phase the run had reached.
 */
export const PHASE_REASON: Readonly<Record<VerifyPhase, VerifyReason>> = Object.freeze({
  'V1-handoff': 'the Stage-2 handoff is not in the reviewed form',
  'V2-supervisor': 'the supervisor is not the backend that held the fence',
  'V3-fence-before': 'the complete source fence was not held before verification',
  'V4-source-session': 'the source verification session could not be prepared',
  'V5-target-session': 'the target verification session could not be prepared',
  'V6-source-contract': 'the source is not the confirmed Stage-1 source',
  'V7-target-contract': 'the live target is not the reviewed target',
  'V8-content': 'the independently measured content does not match',
  'V9-sequences': 'the sequence positions do not match',
  'V10-compatibility': 'the compatibility document does not match',
  'V11-fence-after': 'the complete source fence was not held after verification',
  'V12-evidence': 'the verification evidence was not published',
})

/**
 * WHAT IS KNOWN ABOUT THE SOURCE FENCE at the moment a failure is raised.
 *
 * A CLOSED SET, AND NOT A GUESS. The first version of this error said "the
 * source fence is still held" in every message it could produce - including
 * the one raised because the supervisor was gone, and the one raised because
 * the fence proof had just refused. An operator reading that would conclude
 * the source was frozen and act accordingly, which is the single most
 * dangerous thing this module could get wrong: producers restarted against a
 * source everyone believes is still.
 *
 *   `held`       a proof SUCCEEDED after the failure. The source is frozen.
 *   `not-held`   a proof RAN and REFUSED. The source is mutable.
 *   `unproved`   nobody knows. The verifier released nothing, but it cannot
 *                say what the fence is doing, so the source must be treated as
 *                mutable and producers must not be restored automatically.
 *
 * `unproved` is the default because it is the only one of the three that is
 * safe to be wrong about.
 */
export type FenceDisposition = 'held' | 'not-held' | 'unproved'

export const FENCE_DISPOSITION_SENTENCE: Readonly<Record<FenceDisposition, string>> =
  Object.freeze({
    held:
      'The verifier released nothing, and the COMPLETE source fence was PROVED still held ' +
      'after this failure.',
    'not-held':
      'THE REQUIRED FENCE CONTRACT POSITIVELY FAILED: an independent lock census was taken and ' +
      'read, and it shows a required lock missing or a conflicting request queued. The verifier ' +
      'released nothing. Treat the source as MUTABLE and do not restore producers.',
    unproved:
      'The verifier did not release the source fence, but its current state is UNPROVED. ' +
      'Treat the source as MUTABLE and do not restore producers automatically.',
  })

export class PostCommitVerificationFailed extends Error {
  constructor(
    readonly phase: VerifyPhase,
    readonly reason: VerifyReason,
    /** A reviewed table or property name, and never anything measured. */
    readonly at: string | null = null,
    /** What is KNOWN about the fence. Never assumed; see `FenceDisposition`. */
    readonly fence: FenceDisposition = 'unproved',
  ) {
    super(
      'POST-COMMIT VERIFICATION FAILED: the target has been committed and NOT verified. ' +
      'It has not been cleaned, truncated, migrated or rolled back, and nothing may be ' +
      `retried. ${FENCE_DISPOSITION_SENTENCE[fence]} ` +
      `${reason} (phase ${phase}${at === null ? '' : ` at ${at}`})`)
    this.name = 'PostCommitVerificationFailed'
  }
}

export type VerificationOutcome = 'PASS' | 'FAIL'

/** The primary verification failure, carried through a publication failure. */
export interface PrimaryFailure {
  readonly phase: VerifyPhase
  readonly reason: VerifyReason
  readonly at: string | null
}

/**
 * WHAT WAS FOUND ON DISK after a pre-rename publication failure.
 *
 * Seven distinguishable situations, and the difference between them is what an
 * operator does next. `evidenceReason` and `evidenceRelativePath` come from the
 * publisher's own closed vocabulary, so an invalid root, a final-destination
 * collision and a temporary-name collision stay distinguishable rather than
 * being flattened into one sentence.
 */
export type EvidenceDisposition =
  /** Refused, and NOTHING was created. Both names looked at; neither is ours. */
  | 'refused-nothing-created'
  /** Built and not published. The temporary directory is there, and IS ours. */
  | 'retained-temporary'
  /** A path is occupied by something THIS RUN DID NOT CREATE. */
  | 'destination-occupied'
  /** At least one name could not be examined. Nothing may be said about it. */
  | 'state-unproved'
  /** Published, then something after the rename failed. The FINAL path is there. */
  | 'published-unverified'
  /** The rename did not report and could not be resolved by looking. */
  | 'unknown'

/**
 * The evidence was refused BEFORE the rename. Nothing was published by this run.
 *
 * EVERY PRESENCE HERE IS OBSERVED, NOT INFERRED, and carries three states. A
 * path nobody could examine is `unproved`, never `absent` - and a path that was
 * already occupied when this run arrived is never described as a bundle this
 * run produced, because `createdByThisRun` is derived from the publisher's own
 * phase and the reviewed order in which it creates things.
 */
export class VerificationEvidenceRefused extends PostCommitVerificationFailed {
  readonly disposition: EvidenceDisposition
  /** The temporary path, and only when it is present AND ours. */
  readonly temporaryPath: string | null
  readonly createdByThisRun: boolean
  constructor(
    readonly outcome: VerificationOutcome,
    readonly evidencePhase: EvidencePhase,
    readonly evidenceReason: EvidenceReason | null,
    readonly evidenceRelativePath: string | null,
    readonly finalPath: string,
    readonly finalPathState: PathState,
    readonly temporaryFullPath: string,
    readonly temporaryPathState: PathState,
    readonly verification: PrimaryFailure | null,
    fence: FenceDisposition,
  ) {
    const created = !PHASES_BEFORE_CREATION.includes(evidencePhase) &&
                    temporaryPathState === 'present'
    const disposition: EvidenceDisposition =
      finalPathState === 'unproved' || temporaryPathState === 'unproved' ? 'state-unproved'
        : created ? 'retained-temporary'
          : finalPathState === 'present' || temporaryPathState === 'present'
            ? 'destination-occupied'
            : 'refused-nothing-created'
    super('V12-evidence',
      disposition === 'retained-temporary'
        ? 'the verification evidence was built but not published'
        : disposition === 'state-unproved'
          ? 'the verification evidence state on disk could not be examined'
          : disposition === 'destination-occupied'
            ? 'the verification evidence was not published and a path is already occupied'
            : 'the verification evidence was not published',
      `${disposition} (${evidenceReason ?? 'no reviewed reason'})`,
      fence)
    this.disposition = disposition
    this.createdByThisRun = created
    this.temporaryPath = created ? temporaryFullPath : null
    this.name = 'VerificationEvidenceRefused'
  }
}

/**
 * The bundle IS published, and something after the rename failed.
 *
 * Saying "nothing was published" here would be false, and deleting it to tidy
 * up would destroy the only durable record of what the verification concluded.
 * The reviewed final name is reported so it can be examined; the phase says
 * which step failed, because freezing, fsyncing and the outside verification
 * are different problems with different answers.
 */
export class VerificationEvidencePublishedButUnverified extends PostCommitVerificationFailed {
  readonly disposition: EvidenceDisposition = 'published-unverified'
  constructor(
    readonly outcome: VerificationOutcome,
    readonly publishedPhase: PublishedPhase,
    readonly finalPath: string,
    readonly verification: PrimaryFailure | null,
    fence: FenceDisposition,
  ) {
    super('V12-evidence', 'the verification evidence was published but not verified',
      `the published bundle at ${publishedPhase}`, fence)
    this.name = 'VerificationEvidencePublishedButUnverified'
  }
}

/**
 * The rename did not report and looking could not settle it.
 *
 * Both reviewed names are preserved exactly as they are. No retry, no cleanup,
 * no overwrite, no repair, and neither name is ever reused.
 */
export class VerificationEvidenceOutcomeUnknown extends PostCommitVerificationFailed {
  readonly disposition: EvidenceDisposition = 'unknown'
  constructor(
    readonly outcome: VerificationOutcome,
    readonly finalPath: string,
    readonly temporaryPath: string,
    readonly verification: PrimaryFailure | null,
    fence: FenceDisposition,
  ) {
    super('V12-evidence', 'the verification evidence publication outcome is unknown',
      'neither name may be reused', fence)
    this.name = 'VerificationEvidenceOutcomeUnknown'
  }
}

// ---------------------------------------------------------------------------
// THE HANDOFF
// ---------------------------------------------------------------------------

/** One table, as Stage 2 committed it. */
export interface HandoffTable {
  readonly qname: string
  readonly digest: string
  readonly rows: number
}

/** One sequence, as Stage 2 left it. */
export interface HandoffSequence {
  readonly qname: string
  readonly effectiveNext: string
}

/** A database, named by facts that are not secrets. */
export interface HandoffIdentity {
  readonly systemIdentifier: string
  readonly database: string
  readonly role: string
}

/**
 * EVERYTHING THE VERIFIER NEEDS FROM STAGE 2, AND NOT ONE CREDENTIAL.
 *
 * A system identifier, a database name, a role name, a digest and a backend pid
 * are all public: they are printed in operator output and pasted into tickets.
 * No host, no port file, no password, no passfile path and no connection string
 * appears here, which is what lets this structure be recorded into evidence
 * whole rather than field by field with a redaction list that rots.
 */
export interface VerifierHandoff {
  readonly bundleName: string
  readonly rootDigest: string
  readonly sourceContractDigest: string
  readonly targetContractDigest: string
  readonly sourceRecognition: string
  readonly targetRecognition: string
  readonly tables: readonly HandoffTable[]
  readonly sequences: readonly HandoffSequence[]
  readonly compatibility: Canonical
  readonly source: HandoffIdentity
  readonly target: HandoffIdentity
  /** Which backend holds the fence, and under which reviewed mechanism. */
  readonly fence: {
    readonly supervisorPid: string
    readonly mechanism: SequenceFenceId
  }
}

const HEX64 = /^[0-9a-f]{64}$/
const PID = /^\d+$/
const SYSID = /^[1-9][0-9]{0,19}$/
const IDENT = /^[a-z_][a-z0-9_]*$/
const DECIMAL = /^-?\d{1,20}$/

/**
 * The handoff is CHECKED, not trusted, and before a single session is opened.
 *
 * It arrives through a public API. A handoff carrying a digest of somebody's
 * choosing would make every comparison below honest and worthless, so its
 * shape is proved first and its values are then the only thing the measured
 * world is compared against.
 */
export function assertHandoff(h: VerifierHandoff): VerifierHandoff {
  const bad = (): never => {
    throw new PostCommitVerificationFailed(
      'V1-handoff', 'the Stage-2 handoff is not in the reviewed form')
  }
  if (h === null || typeof h !== 'object') bad()
  for (const d of [h.rootDigest, h.sourceContractDigest, h.targetContractDigest]) {
    if (typeof d !== 'string' || !HEX64.test(d)) bad()
  }
  if (h.targetContractDigest !== REVIEWED_CONTRACT_DIGEST) bad()
  if (!/^source-manifest-\d{8}T\d{6}Z-[0-9a-f]{8}$/.test(String(h.bundleName))) bad()
  for (const i of [h.source, h.target]) {
    if (i === null || typeof i !== 'object') bad()
    if (!SYSID.test(String(i.systemIdentifier))) bad()
    if (!IDENT.test(String(i.database)) || !IDENT.test(String(i.role))) bad()
  }
  if (!PID.test(String(h.fence?.supervisorPid))) bad()
  if (!Array.isArray(h.tables) || h.tables.length !== COPY_TABLES.length) bad()
  h.tables.forEach((t, n) => {
    if (t.qname !== COPY_TABLES[n] || !HEX64.test(String(t.digest))) bad()
    if (!Number.isSafeInteger(t.rows) || t.rows < 0) bad()
  })
  if (!Array.isArray(h.sequences) || h.sequences.length !== FENCE_SEQUENCES.length) bad()
  h.sequences.forEach((s, n) => {
    if (s.qname !== FENCE_SEQUENCES[n] || !DECIMAL.test(String(s.effectiveNext))) bad()
  })
  return h
}

// ---------------------------------------------------------------------------
// BORROWED SESSIONS
// ---------------------------------------------------------------------------

/**
 * The reviewed statements the verifier may put on a BORROWED session.
 *
 * The supervisor's transaction holds the fence and belongs to the caller.
 * Listing what may be sent - rather than listing what may not - means a
 * statement nobody thought of is refused by default, and `ROLLBACK`, `COMMIT`,
 * `END`, `ABORT` and every unlock are simply not on the list.
 */
export const BORROWED_STATEMENTS: readonly string[] = Object.freeze([
  SUPERVISOR_PID_SQL,
  FENCE_PROOF_SQL.replace('$1', fenceRelationArray()),
  ...FENCE_SEQUENCES.map(q => SEQUENCE_STATE_SQL(q)),
])

/**
 * Wrap a borrowed executor so it can only be read through.
 *
 * Enforced rather than documented: an edit that released the fence "just to
 * tidy up" would have to add its statement to the reviewed list above, in this
 * file, where a reviewer reads it.
 */
export function borrowReadOnly(x: FenceExecutor): FenceExecutor {
  return {
    send: async (sql: string) => {
      if (!BORROWED_STATEMENTS.includes(sql)) {
        throw new PostCommitVerificationFailed(
          'V2-supervisor', 'the supervisor is not the backend that held the fence')
      }
      return await x.send(sql)
    },
  }
}

// ---------------------------------------------------------------------------
// PROOFS
// ---------------------------------------------------------------------------

/** What one complete fence proof established. Counts only; never a lock listing. */
export interface FenceFacts {
  readonly provingPid: string
  readonly supervisorPid: string
  readonly relations: number
  readonly ungranted: number
}

/**
 * WHAT A FENCE PROOF ESTABLISHED. A closed set, and the distinction that
 * matters most in this module.
 *
 *   `held`     an INDEPENDENT backend returned a complete, readable lock
 *              census, every required lock was granted, and nothing was queued.
 *
 *   `invalid`  a census RAN and was READ, and it positively shows a required
 *              lock missing or a conflicting request queued. This is evidence.
 *
 *   `unproved` nothing was established: the prover could not be reached, it
 *              refused the statement, what came back could not be read, or the
 *              proof would not have been independent. This is the ABSENCE of
 *              evidence, and it is not the same thing as evidence of absence.
 *
 * Collapsing the last two is how "the prover's connection dropped" becomes "the
 * fence is gone" - a sentence with an operational consequence, asserted on the
 * strength of nothing at all.
 */
export type ProofOutcome = 'held' | 'invalid' | 'unproved'

/** WHY, from a closed reviewed set. Never the assertion's own lock listing. */
export type ProofCause =
  | 'the complete fence was proved held'
  | 'a required fence lock is missing or a conflicting request is queued'
  | 'the proving backend could not be reached'
  | 'the proving backend refused a statement'
  | 'the proving backend returned a result that could not be read'
  | 'the proof would not have been independent'
  | 'the proof does not name the reviewed sequence mechanism'

export interface FenceProofResult {
  readonly outcome: ProofOutcome
  /** Only ever present when the outcome is `held`. */
  readonly facts: FenceFacts | null
  readonly cause: ProofCause
}

/** The operator-facing state each proof outcome justifies. */
export function dispositionOf(o: ProofOutcome): FenceDisposition {
  return o === 'held' ? 'held' : o === 'invalid' ? 'not-held' : 'unproved'
}

const proofResult = (
  outcome: ProofOutcome, cause: ProofCause, facts: FenceFacts | null = null,
): FenceProofResult => Object.freeze({ outcome, cause, facts })

/**
 * Take a fence proof and REPORT WHAT IT ESTABLISHED, without throwing.
 *
 * THE ORDER IS WHAT MAKES `invalid` MEAN SOMETHING. Everything that could stop
 * a trustworthy census - transport, refusal, unreadable results, a proof taken
 * on the supervisor's own backend, a mechanism that is not the reviewed one -
 * is excluded FIRST and yields `unproved`. Only then is the reviewed
 * `assertFenceProof` run, so a refusal from it at that point can only be about
 * the lock census itself, which is the one thing that earns `invalid`.
 */
export async function attemptFenceProof(
  prover: FenceExecutor, supervisorPid: string, mechanism: SequenceFenceId,
): Promise<FenceProofResult> {
  if (!/^\d+$/.test(supervisorPid)) {
    return proofResult('unproved', 'the proof would not have been independent')
  }
  if (mechanism !== SELECTED_SEQUENCE_FENCE) {
    return proofResult('unproved', 'the proof does not name the reviewed sequence mechanism')
  }

  let pidRes: { rows: string[][]; error: 'statement-refused' | null }
  try {
    pidRes = await prover.send(SUPERVISOR_PID_SQL)
  } catch {
    return proofResult('unproved', 'the proving backend could not be reached')
  }
  if (pidRes.error !== null) {
    return proofResult('unproved', 'the proving backend refused a statement')
  }
  const provingPid = pidRes.rows[0]?.[0] ?? ''
  if (!/^\d+$/.test(provingPid)) {
    return proofResult('unproved', 'the proving backend returned a result that could not be read')
  }
  // A SESSION CAN ALWAYS SEE ITS OWN LOCKS. A self-proof establishes nothing,
  // so it is excluded here rather than left to look like census evidence.
  if (provingPid === supervisorPid) {
    return proofResult('unproved', 'the proof would not have been independent')
  }

  let censusRes: { rows: string[][]; error: 'statement-refused' | null }
  try {
    censusRes = await prover.send(FENCE_PROOF_SQL.replace('$1', fenceRelationArray()))
  } catch {
    return proofResult('unproved', 'the proving backend could not be reached')
  }
  if (censusRes.error !== null) {
    return proofResult('unproved', 'the proving backend refused a statement')
  }

  let rows: ReturnType<typeof parseLockRows>
  try {
    for (const row of censusRes.rows) {
      if (!Array.isArray(row) || row.length !== 5) throw new Error('shape')
    }
    // `parseLockRows` raises on a boolean it cannot read, which is a result
    // this module could not interpret - not a fence it observed to be gone.
    rows = parseLockRows(censusRes.rows)
  } catch {
    return proofResult('unproved', 'the proving backend returned a result that could not be read')
  }

  try {
    assertFenceProof(rows, { supervisorPid, provingPid, mechanism })
  } catch {
    // Reached only after every non-census cause has been excluded above, so
    // this is the lock census itself refusing. The assertion's own message
    // lists locks and pids; it stops here.
    return proofResult(
      'invalid', 'a required fence lock is missing or a conflicting request is queued')
  }

  return proofResult('held', 'the complete fence was proved held', Object.freeze({
    provingPid,
    supervisorPid,
    relations: rows.filter(r => r.kind === 'relation').length,
    ungranted: rows.filter(r => !r.granted).length,
  }))
}

/**
 * The COMPLETE fence, proved from a DIFFERENT backend, or a refusal that says
 * exactly what it established.
 */
export async function proveCompleteFence(
  prover: FenceExecutor, phase: VerifyPhase, supervisorPid: string, mechanism: SequenceFenceId,
): Promise<FenceFacts> {
  const r = await attemptFenceProof(prover, supervisorPid, mechanism)
  if (r.outcome !== 'held') {
    throw new FenceProofFailed(
      phase,
      phase === 'V11-fence-after'
        ? 'the complete source fence was not held after verification'
        : 'the complete source fence was not held before verification',
      r)
  }
  return r.facts as FenceFacts
}

/**
 * A fence-proof failure that CARRIES its own verdict.
 *
 * The phase says where the proof was taken; it says nothing about what the
 * proof found, and the two are not interchangeable. An earlier version derived
 * the fence disposition from the phase alone, so a prover that died at V3 -
 * having established nothing whatsoever - was reported as positive evidence
 * that the fence had been lost.
 */
export class FenceProofFailed extends PostCommitVerificationFailed {
  constructor(
    phase: VerifyPhase,
    reason: VerifyReason,
    readonly proof: FenceProofResult,
  ) {
    super(phase, reason, proof.cause, dispositionOf(proof.outcome))
    this.name = 'FenceProofFailed'
  }
}

/** What a session reported about itself. Nothing here was supplied by a caller. */
export interface VerifiedIdentity {
  readonly pid: string
  readonly systemIdentifier: string
  readonly database: string
  readonly currentUser: string
  readonly sessionUser: string
}

/**
 * One observation of identity AND transaction state.
 *
 * Together rather than separately, because a session can be read only when its
 * pid is checked and read write by the time the first content query runs. One
 * statement makes them one moment.
 */
export async function proveVerifySession(
  s: VerifySession, expected: HandoffIdentity, phase: VerifyPhase, reason: VerifyReason,
): Promise<VerifiedIdentity> {
  const fail = (): never => {
    throw new PostCommitVerificationFailed(phase, reason)
  }
  let rows: string[][]
  try {
    rows = await s.rows(VERIFY_IDENTITY_SQL)
  } catch {
    return fail()
  }
  if (rows.length !== 1 || rows[0].length !== VERIFY_IDENTITY_COLUMNS) fail()
  const [pid, systemIdentifier, database, currentUser, sessionUser, readOnly, isolation] = rows[0]
  if (!PID.test(pid) || pid !== s.pid) fail()
  if (!SYSID.test(systemIdentifier)) fail()
  if (readOnly !== 'on') fail()
  if (isolation !== 'repeatable read') fail()
  // THE CLUSTER ANCHOR FIRST: a matching database name on the wrong cluster is
  // exactly the mistake a name comparison alone lets through.
  if (systemIdentifier !== expected.systemIdentifier) fail()
  if (database !== expected.database) fail()
  if (currentUser !== expected.role) fail()
  if (sessionUser !== currentUser) fail()
  return Object.freeze({ pid, systemIdentifier, database, currentUser, sessionUser })
}

/** A contract's own statement of which migration ledger it recognised. */
export function recognitionOf(a: ContractArtifact): string {
  const m = (a.payload as unknown as { migrations?: { recognition?: unknown } }).migrations
  return typeof m?.recognition === 'string' ? m.recognition : ''
}

/** What a sequence would ISSUE NEXT, as a decimal string. */
export function issuesNext(rows: readonly (readonly string[])[], qname: string): string {
  return effectiveNext(parseSequenceState(rows, qname), qname).toString()
}

// ---------------------------------------------------------------------------
// THE VERIFICATION
// ---------------------------------------------------------------------------

export interface VerifierInput {
  /** Everything Stage 2 committed, checked before anything is opened. */
  readonly handoff: VerifierHandoff
  /** The Stage-1 manifest document the copy was authorised against. */
  readonly publishedDocument: Record<string, never>
  /** The caller's supervisor, still holding the fence. BORROWED, never ended. */
  readonly supervisor: FenceExecutor
  /** A different backend. BORROWED, never ended. */
  readonly prover: FenceExecutor
  /** A FRESH source session. Opened, used and closed by this module. */
  readonly openSource: () => Promise<VerifyCloseable>
  /** A FRESH target session. Opened, used and closed by this module. */
  readonly openTarget: () => Promise<VerifyCloseable>
  /** The committed expected-target artifact, for the compatibility rebuild. */
  readonly reviewedTarget: ContractArtifact
  /** An existing, owned, 0700 directory. Never created here. */
  readonly evidenceRoot: string
  readonly runId?: string
  readonly stamp?: string
  readonly ops?: EvidenceOps
}

/** A session this module opens, and therefore closes. */
export interface VerifyCloseable extends VerifySession {
  end(): Promise<void>
}

/** One table, measured twice, independently. */
export interface VerifiedTablePair {
  readonly qname: string
  readonly rows: number
  readonly bytes: number
  readonly sourceDigest: string
  readonly targetDigest: string
}

export interface VerificationResult {
  readonly outcome: 'PASS'
  readonly sourceRootDigest: string
  readonly targetRootDigest: string
  readonly tables: readonly VerifiedTablePair[]
  readonly sequences: readonly {
    qname: string; sourceEffectiveNext: string; targetEffectiveNext: string
  }[]
  readonly fenceBefore: FenceFacts
  readonly fenceAfter: FenceFacts
  readonly evidence: PublishedEvidence
}

const manifestTables = (doc: Record<string, never>): Array<{ qname: string; digest: string }> => {
  const content = (doc as unknown as { content?: { tables?: unknown } }).content
  return Array.isArray(content?.tables)
    ? content.tables as Array<{ qname: string; digest: string }>
    : []
}

const manifestRoot = (doc: Record<string, never>): string => {
  const content = (doc as unknown as { content?: { root_digest?: unknown } }).content
  return typeof content?.root_digest === 'string' ? content.root_digest : ''
}

const manifestContractDigest = (doc: Record<string, never>): string => {
  const c = (doc as unknown as { source_contract?: { digest?: unknown } }).source_contract
  return typeof c?.digest === 'string' ? c.digest : ''
}

/**
 * V6. THE SOURCE IS STILL THE ARTIFACT STAGE 1 CONFIRMED AND STAGE 2 COPIED.
 *
 * Three independent statements have to agree: what this module just re-derived,
 * what Stage 2 said it copied, and what the published Stage-1 bundle recorded.
 * Two of them agreeing would be satisfied by a source that drifted between
 * Stage 1 and Stage 2 and stayed drifted.
 */
export function assertSourceArtifact(
  contract: ContractArtifact, h: VerifierHandoff, publishedDocument: Record<string, never>,
): void {
  const fail = (at: string): never => {
    throw new PostCommitVerificationFailed(
      'V6-source-contract', 'the source is not the confirmed Stage-1 source', at)
  }
  if (contract.digest !== h.sourceContractDigest) fail('the Stage-2 source contract digest')
  if (contract.digest !== manifestContractDigest(publishedDocument)) {
    fail('the published manifest contract digest')
  }
  if (recognitionOf(contract) !== h.sourceRecognition) fail('the Stage-2 source recognition')
  if (recognitionOf(contract) !== SOURCE_V10_PROFILE.recognition) fail('the source recognition')
}

/**
 * V7. THE LIVE TARGET IS STILL THE REVIEWED TARGET.
 *
 * Anchored to the committed `REVIEWED_CONTRACT_DIGEST` and not only to what the
 * handoff claims: a handoff is an argument, and an argument that named its own
 * expected digest would make this check agree with whatever it was handed.
 */
export function assertTargetArtifact(contract: ContractArtifact, h: VerifierHandoff): void {
  const fail = (at: string): never => {
    throw new PostCommitVerificationFailed(
      'V7-target-contract', 'the live target is not the reviewed target', at)
  }
  if (contract.digest !== REVIEWED_CONTRACT_DIGEST) fail('the reviewed target digest')
  if (contract.digest !== h.targetContractDigest) fail('the Stage-2 target contract digest')
  if (recognitionOf(contract) !== h.targetRecognition) fail('the Stage-2 target recognition')
  if (recognitionOf(contract) !== TARGET_V19_PROFILE.recognition) fail('the target recognition')
}

/**
 * V8. THE TWO INDEPENDENTLY MEASURED CONTENTS, AND EVERY CLAIM ABOUT THEM.
 *
 * Row count, batch sequence and digest are compared SEPARATELY and named
 * separately, because "the table differs" sends a person to read 165,000 rows
 * while "batch 3's row count differs" sends them to 10,000 - and because a
 * digest comparison alone cannot say whether a table lost rows or changed them.
 *
 * Nothing measured is ever interpolated into a failure: `at` carries a reviewed
 * table name, a batch ordinal and a fixed word, and never a value from a row.
 */
export function assertContentMatches(
  source: VerifiedContent, target: VerifiedContent, h: VerifierHandoff,
  publishedDocument: Record<string, never>,
): void {
  const fail = (at: string): never => {
    throw new PostCommitVerificationFailed(
      'V8-content', 'the independently measured content does not match', at)
  }
  const published = manifestTables(publishedDocument)
  if (published.length !== COPY_TABLES.length) fail('the published table set')
  if (source.tables.length !== COPY_TABLES.length) fail('the source table set')
  if (target.tables.length !== COPY_TABLES.length) fail('the target table set')

  for (let n = 0; n < COPY_TABLES.length; n += 1) {
    const q = COPY_TABLES[n]
    const s = source.tables[n]
    const t = target.tables[n]
    if (s.qname !== q || t.qname !== q) fail(q)
    if (s.rows !== t.rows) fail(`${q} row count`)
    if (s.batches.length !== t.batches.length) fail(`${q} batch count`)
    for (let b = 0; b < s.batches.length; b += 1) {
      const sb = s.batches[b]
      const tb = t.batches[b]
      if (sb.batch !== b || tb.batch !== b) fail(`${q} batch ordinal`)
      if (sb.rows !== tb.rows) fail(`${q} batch ${b} row count`)
      if (sb.bytes !== tb.bytes) fail(`${q} batch ${b} byte count`)
      if (sb.digest !== tb.digest) fail(`${q} batch ${b} digest`)
    }
    if (s.digest !== t.digest) fail(`${q} digest`)
    // AND AGAINST WHAT STAGE 2 AND STAGE 1 EACH CLAIMED.
    if (s.digest !== h.tables[n].digest) fail(`${q} against the Stage-2 result`)
    if (s.rows !== h.tables[n].rows) fail(`${q} row count against the Stage-2 result`)
    if (published[n].qname !== q) fail(`${q} in the published manifest`)
    if (s.digest !== published[n].digest) fail(`${q} against the published manifest`)
  }

  // THE ROOTS.
  //
  // THE ORDER MATTERS, AND NOT FOR STYLE. Three values with three pairwise
  // equalities: any two of them imply the third, so whichever comparison runs
  // LAST can never be the only one to fire, and removing it would change
  // nothing. Each side is therefore checked against the Stage-2 root FIRST,
  // where each is the only thing that can catch its own case - a source that
  // moved, or a target that did - and the source-to-target comparison is
  // written last as the statement of what all this was for.
  if (source.rootDigest !== h.rootDigest) fail('the source root against the Stage-2 result')
  if (target.rootDigest !== h.rootDigest) fail('the target root against the Stage-2 result')
  if (source.rootDigest !== target.rootDigest) fail('the root digest')
  if (source.rootDigest !== manifestRoot(publishedDocument)) {
    fail('the root against the published manifest')
  }
}

/** One sequence, measured on both sides. */
export interface SequencePair {
  readonly qname: string
  readonly sourceEffectiveNext: string
  readonly targetEffectiveNext: string
}

/**
 * V9. ALL THREE SEQUENCES, BY EFFECTIVE NEXT.
 *
 * Not by raw representation: a target restarted to N is
 * `last_value = N, is_called = false` while a source that has issued N-1 is
 * `last_value = N-1, is_called = true`. Different rows, same meaning, and what
 * has to match is what each would ISSUE NEXT.
 */
export function assertSequencesMatch(
  pairs: readonly SequencePair[], h: VerifierHandoff,
): void {
  const fail = (at: string): never => {
    throw new PostCommitVerificationFailed(
      'V9-sequences', 'the sequence positions do not match', at)
  }
  if (pairs.length !== FENCE_SEQUENCES.length) fail('the sequence set')
  for (let n = 0; n < FENCE_SEQUENCES.length; n += 1) {
    const q = FENCE_SEQUENCES[n]
    const p = pairs[n]
    if (p.qname !== q) fail(q)
    if (p.sourceEffectiveNext !== p.targetEffectiveNext) fail(q)
    if (p.sourceEffectiveNext !== h.sequences[n].effectiveNext) {
      fail(`${q} against the Stage-2 result`)
    }
  }
}

/**
 * V10. THE COMPATIBILITY DOCUMENT, REBUILT AND COMPARED CANONICALLY.
 *
 * Compared as canonical JSON rather than field by field, so a field ADDED to
 * the document later is compared too instead of being silently ignored by a
 * comparison that only knows the fields that existed when it was written.
 */
export function assertCompatibilityMatches(rebuilt: Canonical, stated: Canonical): void {
  if (canonicalJson(rebuilt) !== canonicalJson(stated)) {
    throw new PostCommitVerificationFailed(
      'V10-compatibility', 'the compatibility document does not match')
  }
}

/**
 * VERIFY THE COMMITTED COPY, INDEPENDENTLY, WITH THE FENCE STILL HELD.
 *
 * The order is the guarantee, so it is written once, here:
 *
 *   V1  the handoff is in the reviewed form                (nothing opened yet)
 *   V2  the supervisor is the SAME LIVE BACKEND that holds the fence
 *   V3  the COMPLETE fence is proved from a different backend, zero queued
 *   V4  a FRESH source session; READ ONLY REPEATABLE READ is its first statement
 *   V5  a FRESH target session; the same, and its identity before any role change
 *   V6  the source contract is re-derived and is the confirmed Stage-1 artifact
 *   V7  the live target contract is re-derived and is the reviewed V19 artifact
 *   V8  both contents are measured INDEPENDENTLY and must agree with each other,
 *       with Stage 2's committed root and with the published Stage-1 manifest
 *   V9  all three sequences must agree by EFFECTIVE NEXT on both sides
 *   V10 the compatibility document is rebuilt from the re-derived source and
 *       must equal the one Stage 2 recorded
 *   V11 the COMPLETE fence is proved again, AFTER every read
 *   V12 evidence is published; only then has anything been verified
 *
 * THERE IS NO RETRY ANYWHERE IN THIS FUNCTION. No loop resumes after a failure
 * and no catch swallows one. The first failure publishes FAIL evidence and
 * raises, with the fence untouched.
 */
export async function runVerification(i: VerifierInput): Promise<VerificationResult> {
  const supervisor = borrowReadOnly(i.supervisor)
  const prover = borrowReadOnly(i.prover)

  const state: VerificationState = {
    outcome: 'FAIL',
    failure: null,
    handoffAccepted: false,
    fenceDisposition: 'unproved',
    fenceAfterProvedBy: null,
    proof: null,
    sourceContract: null,
    targetContract: null,
    source: null,
    target: null,
    content: null,
    sequences: [],
    fenceBefore: null,
    fenceAfter: null,
    compatibility: null,
  }

  let sourceSession: VerifyCloseable | null = null
  let targetSession: VerifyCloseable | null = null
  /** Where the run has reached. An unreviewed failure is reported HERE. */
  let phase: VerifyPhase = 'V1-handoff'
  let h: VerifierHandoff = i.handoff

  /**
   * ONE proof path, and it RECORDS what it established before deciding.
   *
   * The result is kept whether the proof succeeded or not, because what the
   * fence disposition is later derived from is this verdict - never the step
   * the run happened to be on when it was taken.
   */
  const takeProof = async (at: VerifyPhase): Promise<FenceFacts> => {
    const r = await attemptFenceProof(prover, h.fence.supervisorPid, h.fence.mechanism)
    state.proof = r
    if (r.outcome !== 'held') {
      throw new FenceProofFailed(
        at,
        at === 'V11-fence-after'
          ? 'the complete source fence was not held after verification'
          : 'the complete source fence was not held before verification',
        r)
    }
    return r.facts as FenceFacts
  }

  try {
    // V1. INSIDE THE RECORDED LIFECYCLE, and before any session exists.
    //
    // The Stage-2 target is already committed by the time this function is
    // called, so a malformed handoff is not an argument error a caller can fix
    // and re-run: it is a post-commit verification that did not happen, and it
    // has to leave the same durable record as any other. Nothing is opened and
    // nothing is sent to the supervisor or the prover to establish that.
    h = assertHandoff(i.handoff)
    state.handoffAccepted = true

    phase = 'V2-supervisor'
    // V2. THE SAME LIVE BACKEND. A supervisor that died and was replaced would
    // answer every later question from a session holding nothing - and a
    // supervisor that is simply GONE cannot answer at all, which is the same
    // conclusion by a different route and must not be reported as anything else.
    let pidRes: { rows: string[][]; error: 'statement-refused' | null }
    try {
      pidRes = await supervisor.send(SUPERVISOR_PID_SQL)
    } catch {
      throw new PostCommitVerificationFailed(
        'V2-supervisor', 'the supervisor is not the backend that held the fence')
    }
    if (pidRes.error !== null || (pidRes.rows[0]?.[0] ?? '') !== h.fence.supervisorPid) {
      throw new PostCommitVerificationFailed(
        'V2-supervisor', 'the supervisor is not the backend that held the fence')
    }

    // V3.
    phase = 'V3-fence-before'
    state.fenceBefore = await takeProof('V3-fence-before')

    phase = 'V4-source-session'
    // V4. A FRESH session, and BEGIN is its first statement.
    try {
      sourceSession = await i.openSource()
      await sourceSession.rows(VERIFY_BEGIN_SQL)
    } catch (e) {
      throw e instanceof PostCommitVerificationFailed ? e : new PostCommitVerificationFailed(
        'V4-source-session', 'the source verification session could not be prepared')
    }
    state.source = await proveVerifySession(
      sourceSession, h.source, 'V4-source-session',
      'the source verification session could not be prepared')

    phase = 'V5-target-session'
    // V5. The same for the target, and its identity is taken BEFORE the role
    // change: after `SET LOCAL ROLE` the session no longer reports the role it
    // authenticated as, which is the thing worth proving.
    try {
      targetSession = await i.openTarget()
      await targetSession.rows(VERIFY_BEGIN_SQL)
    } catch (e) {
      throw e instanceof PostCommitVerificationFailed ? e : new PostCommitVerificationFailed(
        'V5-target-session', 'the target verification session could not be prepared')
    }
    state.target = await proveVerifySession(
      targetSession, h.target, 'V5-target-session',
      'the target verification session could not be prepared')
    try {
      // The login role is a MEMBER of the owner and holds no USAGE on the
      // application schemas itself; without this the column queries fail.
      await targetSession.rows(SET_LOCAL_ROLE_SQL)
    } catch {
      throw new PostCommitVerificationFailed(
        'V5-target-session', 'the target verification session could not be prepared')
    }

    phase = 'V6-source-contract'
    // V6. THE SOURCE IS STILL THE CONFIRMED STAGE-1 SOURCE.
    let sourceContract: ContractArtifact
    try {
      sourceContract = await extractContractFromSession(
        sourceSession, sourceSession.pid, SOURCE_V10_PROFILE)
    } catch {
      throw new PostCommitVerificationFailed(
        'V6-source-contract', 'the source is not the confirmed Stage-1 source')
    }
    state.sourceContract = sourceContract
    assertSourceArtifact(sourceContract, h, i.publishedDocument)

    phase = 'V7-target-contract'
    // V7. THE LIVE TARGET IS STILL THE REVIEWED TARGET.
    let targetContract: ContractArtifact
    try {
      targetContract = await extractContractFromSession(
        targetSession, targetSession.pid, TARGET_V19_PROFILE)
    } catch {
      throw new PostCommitVerificationFailed(
        'V7-target-contract', 'the live target is not the reviewed target')
    }
    state.targetContract = targetContract
    assertTargetArtifact(targetContract, h)

    phase = 'V8-content'
    // V8. BOTH SIDES MEASURED INDEPENDENTLY.
    //
    // Both against the SOURCE contract's digest and the SOURCE contract's
    // column list: the table digest folds the schema digest, so a target hashed
    // against its own V19 contract could never equal the source no matter how
    // identical every row was.
    const vector: VerifyVector = verifyVectorFrom(sourceContract)
    let measuredSource: VerifiedContent
    let measuredTarget: VerifiedContent
    try {
      measuredSource = await verifyAllTables(sourceSession, sourceContract, vector)
    } catch {
      throw new PostCommitVerificationFailed(
        'V8-content', 'the independently measured content does not match', 'source')
    }
    try {
      measuredTarget = await verifyAllTables(targetSession, sourceContract, vector)
    } catch {
      throw new PostCommitVerificationFailed(
        'V8-content', 'the independently measured content does not match', 'target')
    }
    state.content = { source: measuredSource, target: measuredTarget }
    assertContentMatches(measuredSource, measuredTarget, h, i.publishedDocument)

    phase = 'V9-sequences'
    // V9. Read from the FENCED supervisor on one side and the verification
    // session on the other, then compared by what each would ISSUE NEXT.
    for (const q of FENCE_SEQUENCES) {
      const fail = (): never => {
        throw new PostCommitVerificationFailed(
          'V9-sequences', 'the sequence positions do not match', q)
      }
      const sRes = await supervisor.send(SEQUENCE_STATE_SQL(q))
      if (sRes.error !== null) fail()
      let sourceEffectiveNext: string
      let targetEffectiveNext: string
      try {
        sourceEffectiveNext = issuesNext(sRes.rows, q)
        targetEffectiveNext = issuesNext(await targetSession.rows(SEQUENCE_STATE_SQL(q)), q)
      } catch { return fail() }
      state.sequences.push({ qname: q, sourceEffectiveNext, targetEffectiveNext })
    }
    assertSequencesMatch(state.sequences, h)

    phase = 'V10-compatibility'
    // V10. The same reviewed comparator, run against a source contract this
    // module re-derived from a session of its own. What is independent here is
    // the INPUT, which is what a substituted or drifted source would change.
    let rebuilt: Canonical
    try {
      rebuilt = compatibilityDocument(
        assertCopyCompatible(sourceContract, i.reviewedTarget).report)
    } catch {
      throw new PostCommitVerificationFailed(
        'V10-compatibility', 'the compatibility document does not match',
        'the comparator refused the re-derived source')
    }
    state.compatibility = rebuilt
    assertCompatibilityMatches(rebuilt, h.compatibility)

    phase = 'V11-fence-after'
    // V11. THE FENCE AGAIN, AFTER EVERY READ. Everything above describes a
    // source that was held for the whole of it, or it describes nothing.
    state.fenceAfter = await takeProof('V11-fence-after')

    state.outcome = 'PASS'
  } catch (e) {
    state.outcome = 'FAIL'
    state.failure = e instanceof PostCommitVerificationFailed
      ? { phase: e.phase, reason: e.reason, at: e.at }
      // Anything else is still a post-commit failure; nothing it carries is
      // recorded, because nothing it carries has been reviewed.
      : { phase, reason: PHASE_REASON[phase], at: null }
  } finally {
    // ONLY THIS MODULE'S OWN SESSIONS. The supervisor and the prover are the
    // caller's, hold the fence, and are not touched here in any way.
    for (const s of [targetSession, sourceSession]) {
      if (s === null) continue
      try { await s.rows(VERIFY_ROLLBACK_SQL) } catch { /* bounded */ }
      try { await s.end() } catch { /* bounded */ }
    }
  }

  // WHAT IS ACTUALLY KNOWN ABOUT THE FENCE, decided before anything is written
  // or raised, and never by assumption. See `FenceDisposition`.
  state.fenceDisposition = await settleFenceDisposition(prover, h, state)

  // EVIDENCE IS PUBLISHED FOR BOTH OUTCOMES, and says which one it was. A
  // failed verification publishes a complete FAIL record; it can never publish
  // PASS, because the outcome written here is the one the run actually reached.
  const evidence = publishOutcome(i, h, state)

  if (state.outcome !== 'PASS' || state.failure !== null) {
    const f = state.failure
    throw new PostCommitVerificationFailed(
      f?.phase ?? phase, f?.reason ?? PHASE_REASON[phase], f?.at ?? null,
      state.fenceDisposition)
  }

  return Object.freeze({
    outcome: 'PASS',
    sourceRootDigest: state.content!.source.rootDigest,
    targetRootDigest: state.content!.target.rootDigest,
    tables: Object.freeze(state.content!.source.tables.map((s, n) => Object.freeze({
      qname: s.qname, rows: s.rows, bytes: s.bytes,
      sourceDigest: s.digest, targetDigest: state.content!.target.tables[n].digest,
    }))),
    sequences: Object.freeze(state.sequences.map(s => Object.freeze({ ...s }))),
    fenceBefore: state.fenceBefore!,
    fenceAfter: state.fenceAfter!,
    evidence,
  })
}

/**
 * Decide what may honestly be said about the fence, FROM WHAT THE PROOFS FOUND.
 *
 * NOT FROM THE PHASE. An earlier version read the disposition off the step the
 * run stopped on: every failure at V3 or V11 became `not-held`. That is right
 * only when a census actually ran and refused, and wrong in every other way a
 * proof can fail - a prover whose connection dropped, a refused statement, a
 * result that could not be parsed, a proof that would not have been
 * independent. All of those establish NOTHING, and reporting them as a lost
 * fence is asserting an operational conclusion on the strength of no evidence.
 *
 * So `attemptFenceProof` returns a verdict and this reads it. Four cases:
 * a clean run is `held` on V11's own proof; a run where no proof was ever taken
 * is `unproved` and asks for none; a failed proof keeps its own verdict; and a
 * failure after a proof that SUCCEEDED earns one bounded reproof, whose verdict
 * is likewise taken as it comes.
 */
export async function settleFenceDisposition(
  prover: FenceExecutor, h: VerifierHandoff, state: VerificationState,
): Promise<FenceDisposition> {
  if (state.outcome === 'PASS') {
    state.fenceAfterProvedBy = 'verification'
    return 'held'
  }
  // NO PROOF WAS EVER TAKEN - V1 refused the handoff, or V2 found the
  // supervisor gone. Nothing has been sent to the prover and nothing will be:
  // a lock census says nothing about a fence whose holder is unaccounted for.
  if (state.proof === null) return 'unproved'
  // A PROOF FAILED. Its own verdict stands, whatever step it was taken on.
  if (state.proof.outcome !== 'held') return dispositionOf(state.proof.outcome)
  // The fence was proved when this started and the failure was about something
  // else, so it is worth asking once more. BOUNDED and BEST-EFFORT: this
  // returns a verdict, never throws, and never touches `state.failure`.
  if (!state.handoffAccepted) return 'unproved'
  const again = await attemptFenceProof(prover, h.fence.supervisorPid, h.fence.mechanism)
  state.proof = again
  if (again.outcome === 'held') {
    state.fenceAfter = again.facts
    state.fenceAfterProvedBy = 'failure-path'
  }
  return dispositionOf(again.outcome)
}

/** Everything the run has established so far. Exported so the document builder is testable. */
export interface VerificationState {
  outcome: VerificationOutcome
  failure: { phase: VerifyPhase; reason: VerifyReason; at: string | null } | null
  /** Whether V1 accepted the handoff. While false, NO handoff field is recorded. */
  handoffAccepted: boolean
  fenceDisposition: FenceDisposition
  /** Which proof produced `fenceAfter`: the verification itself, or the failure path. */
  fenceAfterProvedBy: 'verification' | 'failure-path' | null
  /** The LAST fence proof attempted, whatever it established. Null if none was. */
  proof: FenceProofResult | null
  sourceContract: ContractArtifact | null
  targetContract: ContractArtifact | null
  source: VerifiedIdentity | null
  target: VerifiedIdentity | null
  content: { source: VerifiedContent; target: VerifiedContent } | null
  sequences: Array<{ qname: string; sourceEffectiveNext: string; targetEffectiveNext: string }>
  fenceBefore: FenceFacts | null
  fenceAfter: FenceFacts | null
  compatibility: Canonical | null
}

// ---------------------------------------------------------------------------
// EVIDENCE
// ---------------------------------------------------------------------------

const identityDocument = (
  measured: VerifiedIdentity | null, stated: HandoffIdentity | null,
): Canonical => (stated === null && measured === null ? {
  // THE HANDOFF WAS REFUSED, so not one of its fields is reproduced - not even
  // to say what it claimed. An unvalidated value copied into evidence is an
  // unvalidated value that now looks like a finding.
  system_identifier: null, database: null, role: null, measured: false,
} : {
  // NOT A CONNECTION STRING. A system identifier, a database name and a role
  // name are the three facts that say WHICH database this was, and none of
  // them is a credential or a route to one. No host, port, socket directory,
  // password or passfile path appears anywhere in this document.
  system_identifier: measured?.systemIdentifier ?? stated?.systemIdentifier ?? null,
  database: measured?.database ?? stated?.database ?? null,
  role: measured?.currentUser ?? stated?.role ?? null,
  measured: measured !== null,
})

/** The detail artifact: every batch of every table, on both sides. */
export function verificationContentDocument(
  state: { content: { source: VerifiedContent; target: VerifiedContent } | null },
): Canonical {
  const c = state.content
  if (c === null) return { tables: [] }
  return {
    tables: c.source.tables.map((s, n) => {
      const t = c.target.tables[n]
      const batches = (b: typeof s.batches): Canonical =>
        b.map(x => ({ batch: x.batch, rows: x.rows, bytes: x.bytes, digest: x.digest }))
      return {
        qname: s.qname,
        columns: [...s.columns],
        pk_columns: [...s.pkColumns],
        source: { rows: s.rows, bytes: s.bytes, digest: s.digest, batches: batches(s.batches) },
        target: { rows: t.rows, bytes: t.bytes, digest: t.digest, batches: batches(t.batches) },
      }
    }),
  }
}

const fenceDocument = (f: FenceFacts | null): Canonical =>
  f === null ? null : {
    supervisor_pid: f.supervisorPid,
    proving_pid: f.provingPid,
    relations: f.relations,
    ungranted: f.ungranted,
  }

/**
 * What the record says about the fence, and where that came from.
 *
 * `disposition` is the claim; `after` is the evidence for it when there is any;
 * `after_proved_by` says whether that proof was the verification's own final
 * step or the bounded one taken on the failure path. A reader can therefore
 * tell a fence proved still held at the end of a clean run from one proved
 * still held after something else went wrong - and both from a fence nobody
 * managed to ask about.
 */
const fenceSection = (state: VerificationState): Canonical => ({
  disposition: state.fenceDisposition,
  sentence: FENCE_DISPOSITION_SENTENCE[state.fenceDisposition],
  before: fenceDocument(state.fenceBefore),
  after: fenceDocument(state.fenceAfter),
  after_proved_by: state.fenceAfterProvedBy,
  // WHAT THE LAST PROOF ESTABLISHED, and why. A record that carried only the
  // disposition could not distinguish a fence observed to be gone from one
  // nobody could ask about, which is the distinction the disposition exists
  // to preserve.
  last_proof: state.proof === null
    ? null
    : { outcome: state.proof.outcome, cause: state.proof.cause },
})

/**
 * The verification manifest.
 *
 * `complete: true` is the publisher's own marker and is written unconditionally,
 * because it describes THIS DOCUMENT and not the verification: a failed
 * verification still produces a complete record of how it failed. What the
 * verification concluded is `outcome`, and it is whatever the run reached.
 */
export function verificationDocument(
  h: VerifierHandoff, state: VerificationState, runId: string, stamp: string,
): Canonical {
  return {
    verification_version: VERIFICATION_DOCUMENT_VERSION,
    complete: true,
    outcome: state.outcome,
    run: { id: runId, stamp },
    bundle: { name: state.handoffAccepted ? h.bundleName : null },
    failure: state.failure === null ? null : {
      phase: state.failure.phase,
      reason: state.failure.reason,
      at: state.failure.at,
    },
    source: {
      ...(identityDocument(
        state.source, state.handoffAccepted ? h.source : null) as Record<string, Canonical>),
      contract_digest: state.sourceContract?.digest ?? null,
      recognition: state.sourceContract === null ? null : recognitionOf(state.sourceContract),
      root_digest: state.content?.source.rootDigest ?? null,
    },
    target: {
      ...(identityDocument(
        state.target, state.handoffAccepted ? h.target : null) as Record<string, Canonical>),
      contract_digest: state.targetContract?.digest ?? null,
      recognition: state.targetContract === null ? null : recognitionOf(state.targetContract),
      root_digest: state.content?.target.rootDigest ?? null,
    },
    stage2: state.handoffAccepted ? {
      root_digest: h.rootDigest,
      source_contract_digest: h.sourceContractDigest,
      target_contract_digest: h.targetContractDigest,
    } : { root_digest: null, source_contract_digest: null, target_contract_digest: null },
    tables: (state.content?.source.tables ?? []).map((s, n) => ({
      qname: s.qname,
      rows: s.rows,
      bytes: s.bytes,
      source_digest: s.digest,
      target_digest: state.content!.target.tables[n].digest,
      matched: s.digest === state.content!.target.tables[n].digest,
    })),
    sequences: state.sequences.map(s => ({
      qname: s.qname,
      source_effective_next: s.sourceEffectiveNext,
      target_effective_next: s.targetEffectiveNext,
      matched: s.sourceEffectiveNext === s.targetEffectiveNext,
    })),
    compatibility: state.compatibility ?? (state.handoffAccepted ? h.compatibility : null),
    fence: fenceSection(state),
  }
}

/**
 * WHAT LOOKING AT A PATH ESTABLISHED. Three states, because there are three.
 *
 * `pathIsPresent` is already fail-closed - only ENOENT means absent, and every
 * other failure raises rather than answering. That guarantee is worth nothing
 * if the caller catches the raise and writes down "absent", which is what an
 * earlier version of the recovery path did: a root whose permissions had
 * changed produced "no bundle was created", and a person was sent to look for
 * nothing when a complete bundle might have been sitting there.
 */
export type PathState = 'present' | 'absent' | 'unproved'

export function observePath(path: string, ops: EvidenceOps): PathState {
  try {
    return pathIsPresent(path, ops) ? 'present' : 'absent'
  } catch {
    // COULD NOT LOOK. Not the same as looked and found nothing.
    return 'unproved'
  }
}

/**
 * The publisher phases at which NOTHING has been created yet.
 *
 * Load-bearing, and derived from the reviewed publication order rather than
 * guessed: the root check, the name derivation and the collision check all run
 * before the temporary directory is made. Anything present at those phases was
 * therefore put there by somebody else, and calling it a bundle this run
 * produced would be false.
 */
export const PHASES_BEFORE_CREATION: readonly EvidencePhase[] =
  Object.freeze(['root', 'name', 'collision'])

/**
 * Publish the record, whatever it says, and report EXACTLY where it stopped.
 *
 * NOT ONE CATCH. The publisher already distinguishes a refusal from a bundle
 * that was published and then failed its own verification, and from a rename
 * that did not report - and those three call for opposite actions. Collapsing
 * them into "a temporary directory was retained" names a path that a collision
 * or a bad root never created, sends a person to look at nothing, and says
 * "nothing was published" about a bundle that is sitting there.
 *
 * So each is preserved, and the filesystem is ASKED rather than assumed: the
 * temporary path is probed with the reviewed `pathIsPresent`, which is
 * fail-closed and treats only ENOENT as absent.
 *
 * Nothing here retries, cleans up, overwrites, repairs or reuses a name, and
 * nothing releases the fence on the way out.
 */
function publishOutcome(
  i: VerifierInput, h: VerifierHandoff, state: VerificationState,
): PublishedEvidence {
  const runId = i.runId ?? newRunId()
  const stamp = i.stamp ?? evidenceStamp(new Date())
  const ops = i.ops ?? REAL_EVIDENCE_OPS
  try {
    return publishEvidence({
      root: i.evidenceRoot,
      prefix: VERIFICATION_PREFIX,
      stamp,
      runId,
      artifacts: [{
        path: VERIFICATION_CONTENT_FILE,
        bytes: Buffer.from(
          `${canonicalJson(verificationContentDocument(state))}\n`, 'utf-8'),
      }],
      manifest: {
        path: VERIFICATION_FILE,
        bytes: Buffer.from(
          `${canonicalJson(verificationDocument(h, state, runId, stamp))}\n`, 'utf-8'),
      },
    }, ops)
  } catch (e) {
    const primary: PrimaryFailure | null = state.failure
    const fence = state.fenceDisposition

    // The two reviewed names. Derived independently of the publisher, because
    // the publisher may have refused before it computed them at all.
    let finalPath = i.evidenceRoot
    let temporaryPath: string | null = null
    try {
      const names = evidenceNames(VERIFICATION_PREFIX, stamp, runId)
      finalPath = join(i.evidenceRoot, names.finalName)
      temporaryPath = join(i.evidenceRoot, names.temporaryName)
    } catch { /* the names themselves were refused; the root is all there is */ }

    // PAST THE RENAME. The bundle exists under its final name; the temporary
    // one does not. Nothing may claim otherwise and nothing may remove it.
    if (e instanceof EvidencePublishedButUnverified) {
      throw new VerificationEvidencePublishedButUnverified(
        state.outcome, e.phase, finalPath, primary, fence)
    }

    // THE RENAME DID NOT REPORT and looking could not settle it.
    if (e instanceof EvidencePublicationUnknown) {
      throw new VerificationEvidenceOutcomeUnknown(
        state.outcome, finalPath, temporaryPath ?? i.evidenceRoot, primary, fence)
    }

    // BEFORE THE RENAME. What is on disk is a question about the filesystem,
    // so BOTH names are examined there - and each answer is one of three, so
    // "I could not look" never turns into "nothing is there".
    const phase: EvidencePhase = e instanceof EvidenceRefused ? e.phase : 'publish'
    const reason: EvidenceReason | null = e instanceof EvidenceRefused ? e.reason : null
    const relative: string | null =
      e instanceof EvidenceRefused ? e.relativePath : null
    throw new VerificationEvidenceRefused(
      state.outcome, phase, reason, relative,
      finalPath, observePath(finalPath, ops),
      temporaryPath ?? i.evidenceRoot,
      temporaryPath === null ? 'unproved' : observePath(temporaryPath, ops),
      primary, fence)
  }
}

export { DIGEST_FILE }
