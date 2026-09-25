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
  DIGEST_FILE, REAL_EVIDENCE_OPS, evidenceNames, evidenceStamp, newRunId, publishEvidence,
  type EvidenceOps, type PublishedEvidence,
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
  FENCE_PROOF_SQL, FENCE_SEQUENCES, SEQUENCE_STATE_SQL, assertFenceProof, effectiveNext,
  fenceRelationArray, parseLockRows, parseSequenceState,
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

export class PostCommitVerificationFailed extends Error {
  constructor(
    readonly phase: VerifyPhase,
    readonly reason: VerifyReason,
    /** A reviewed table or property name, and never anything measured. */
    readonly at: string | null = null,
  ) {
    super(
      'POST-COMMIT VERIFICATION FAILED: the target has been committed and NOT verified. ' +
      'It has not been cleaned, truncated, migrated or rolled back, the source fence is ' +
      'still held, and nothing may be retried. ' +
      `${reason} (phase ${phase}${at === null ? '' : ` at ${at}`})`)
    this.name = 'PostCommitVerificationFailed'
  }
}

/**
 * The verification ran, and its evidence could not be published.
 *
 * A subclass, because a caller's answer to both is identical - hold everything,
 * change nothing, look - and because the distinction still matters: the
 * temporary directory named here is complete enough to diagnose from and is
 * deliberately left in place. Nothing removes it.
 */
export class VerificationEvidenceUnpublished extends PostCommitVerificationFailed {
  constructor(
    readonly outcome: VerificationOutcome,
    readonly temporaryPath: string,
  ) {
    super('V12-evidence', 'the verification evidence was not published')
    this.name = 'VerificationEvidenceUnpublished'
  }
}

export type VerificationOutcome = 'PASS' | 'FAIL'

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
 * The COMPLETE fence, proved from a DIFFERENT backend.
 *
 * `assertFenceProof` refuses a self-proof, a missing advisory lock, a missing
 * table or sequence lock, and - the case that matters most after a copy - any
 * request that is present but UNGRANTED, because a queued writer means someone
 * is waiting to change the source the moment the fence drops.
 */
export async function proveCompleteFence(
  prover: FenceExecutor, phase: VerifyPhase, supervisorPid: string, mechanism: SequenceFenceId,
): Promise<FenceFacts> {
  const fail = (): never => {
    throw new PostCommitVerificationFailed(
      phase,
      phase === 'V11-fence-after'
        ? 'the complete source fence was not held after verification'
        : 'the complete source fence was not held before verification')
  }
  const pidRes = await prover.send(SUPERVISOR_PID_SQL)
  if (pidRes.error !== null) fail()
  const provingPid = pidRes.rows[0]?.[0] ?? ''
  const proofRes = await prover.send(FENCE_PROOF_SQL.replace('$1', fenceRelationArray()))
  if (proofRes.error !== null) fail()
  const rows = parseLockRows(proofRes.rows)
  try {
    assertFenceProof(rows, { supervisorPid, provingPid, mechanism })
  } catch {
    // The assertion's own message lists locks and pids. It stops here.
    fail()
  }
  return Object.freeze({
    provingPid,
    supervisorPid,
    relations: rows.filter(r => r.kind === 'relation').length,
    ungranted: rows.filter(r => !r.granted).length,
  })
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
  // V1. Before a session exists.
  const h = assertHandoff(i.handoff)
  const supervisor = borrowReadOnly(i.supervisor)
  const prover = borrowReadOnly(i.prover)

  const state: VerificationState = {
    outcome: 'FAIL',
    failure: null,
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
  let phase: VerifyPhase = 'V2-supervisor'

  try {
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
    state.fenceBefore = await proveCompleteFence(
      prover, 'V3-fence-before', h.fence.supervisorPid, h.fence.mechanism)

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
    state.fenceAfter = await proveCompleteFence(
      prover, 'V11-fence-after', h.fence.supervisorPid, h.fence.mechanism)

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

  // EVIDENCE IS PUBLISHED FOR BOTH OUTCOMES, and says which one it was. A
  // failed verification publishes a complete FAIL record; it can never publish
  // PASS, because the outcome written here is the one the run actually reached.
  const evidence = publishOutcome(i, h, state)

  if (state.outcome !== 'PASS' || state.failure !== null) {
    const f = state.failure
    throw new PostCommitVerificationFailed(
      f?.phase ?? phase, f?.reason ?? PHASE_REASON[phase], f?.at ?? null)
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

/** Everything the run has established so far. Exported so the document builder is testable. */
export interface VerificationState {
  outcome: VerificationOutcome
  failure: { phase: VerifyPhase; reason: VerifyReason; at: string | null } | null
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
  measured: VerifiedIdentity | null, stated: HandoffIdentity,
): Canonical => ({
  // NOT A CONNECTION STRING. A system identifier, a database name and a role
  // name are the three facts that say WHICH database this was, and none of
  // them is a credential or a route to one. No host, port, socket directory,
  // password or passfile path appears anywhere in this document.
  system_identifier: measured?.systemIdentifier ?? stated.systemIdentifier,
  database: measured?.database ?? stated.database,
  role: measured?.currentUser ?? stated.role,
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
    bundle: { name: h.bundleName },
    failure: state.failure === null ? null : {
      phase: state.failure.phase,
      reason: state.failure.reason,
      at: state.failure.at,
    },
    source: {
      ...(identityDocument(state.source, h.source) as Record<string, Canonical>),
      contract_digest: state.sourceContract?.digest ?? null,
      recognition: state.sourceContract === null ? null : recognitionOf(state.sourceContract),
      root_digest: state.content?.source.rootDigest ?? null,
    },
    target: {
      ...(identityDocument(state.target, h.target) as Record<string, Canonical>),
      contract_digest: state.targetContract?.digest ?? null,
      recognition: state.targetContract === null ? null : recognitionOf(state.targetContract),
      root_digest: state.content?.target.rootDigest ?? null,
    },
    stage2: {
      root_digest: h.rootDigest,
      source_contract_digest: h.sourceContractDigest,
      target_contract_digest: h.targetContractDigest,
    },
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
    compatibility: state.compatibility ?? h.compatibility,
    fence: {
      before: fenceDocument(state.fenceBefore),
      after: fenceDocument(state.fenceAfter),
    },
  }
}

/**
 * Publish the record, whatever it says.
 *
 * A publication failure BEFORE the rename leaves the temporary directory
 * exactly as it is - complete enough to read the outcome out of - and this
 * reports its path so a person can. Nothing removes it, nothing retries it, and
 * the fence is not released on the way out.
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
  } catch {
    // The publisher's own errors name paths and phases; none of that is
    // repeated. What a person needs is where to look.
    let temporaryPath = i.evidenceRoot
    try {
      temporaryPath = join(
        i.evidenceRoot, evidenceNames(VERIFICATION_PREFIX, stamp, runId).temporaryName)
    } catch { /* the names themselves were refused; the root is what is left */ }
    throw new VerificationEvidenceUnpublished(state.outcome, temporaryPath)
  }
}

export { DIGEST_FILE }
