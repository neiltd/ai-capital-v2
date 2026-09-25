// STAGE 2 — move the bytes, and refuse unless every claim still holds.
//
// Stage 1 published a manifest: a statement about what the source held at one
// fenced instant. Stage 2's job is to put exactly those bytes into an empty
// target and to prove, at the last possible moment before COMMIT, that nothing
// on either side has moved since. Everything here is arranged around that one
// sentence.
//
// THE STEPS, AND WHAT EACH ONE BUYS.
//
//   A1  the published bundle verifies, DIGEST and all
//   A2  the complete source fence is taken on the supervisor
//   A3  a DIFFERENT backend proves it - a session can always see its own locks
//   A4  ONE read-only repeatable-read source transaction, identity proved
//   A5  the contract, 21 table digests and fenced sequence state are RE-DERIVED
//       and must equal the published manifest exactly; C1 compares the source
//       contract with the committed expected-target artifact
//       ---- inspect stops here, having constructed no target client ----
//   A6  the FIRST target client is constructed, and not one statement earlier
//   A7  target identity and the CURRENT_V19 ledger
//   A8  C2: the live target contract IS the committed expected-target artifact
//   A9  ONE target transaction, SET LOCAL ROLE
//   A10 all 21 target tables empty, all three sequences pristine
//   A11 all 21 tables binary-copied once each, in reviewed FK-parent order
//   A12 the transactional ALTER SEQUENCE ... RESTART WITH policy
//   A13 the FINAL GATES: the target's own manifest must equal the source's, and
//       then the source is re-proved - identity, full manifest equality, live
//       sequence equality, the complete fence and zero queued writers
//   A14 `began` is cleared
//   A15 COMMIT, and its command tag is inspected
//
// WHY THE SOURCE RE-PROOF IS LAST. Everything between A5 and COMMIT is a window
// in which the source could change; the shorter the gap between "the source is
// still what the manifest says" and COMMIT, the smaller that window. So the
// target's own verification happens first and the source re-proof is the last
// thing before the transaction ends.
//
// WHY ONE SOURCE CLIENT DOES EVERYTHING. The digests and the COPY have to come
// from one snapshot, or the bytes that were hashed are not provably the bytes
// that moved. See `driver-session.ts`.
//
// THE COMMIT BOUNDARY IS THE ONE PLACE THIS CODE CANNOT BE BOTH SAFE AND
// CERTAIN. Up to the instant COMMIT is submitted, every failure rolls back and
// the target is provably untouched. From that instant a failure means the
// transaction may or may not have committed, and there is no statement that can
// be issued to find out without possibly making it worse - a ROLLBACK on a
// committed transaction is meaningless, and on a live one it would destroy a
// successful copy. So `began` is cleared BEFORE the submission, and anything
// after it raises `CommitOutcomeUnknown`, which instructs inspection and
// forbids retry.

import { rootDigest, type BatchSummary } from './canonical.js'
import {
  DIGEST_FILE, verifyPublishedEvidence, type EvidenceOps,
} from './evidence.js'
import {
  assertConfirmationMatches, confirmationToken, copySetDigest,
  type ConfirmationBinding,
} from './confirmation.js'
import { copyTableBinary } from './binary-copy.js'
import type { DriverSession } from './driver-session.js'
import {
  COPY_TABLES, REVIEWED_CONTRACT_DIGEST, SOURCE_V10_PROFILE, TARGET_V19_PROFILE,
  canonicalJson, contractDigest, extractContractFromSession, parseArtifact,
  type Canonical, type ContractArtifact,
} from './schema-contract.js'
import {
  assertCopyCompatible, compatibilityDocument,
  type CompatibilityProof, type CompatibilityReport,
} from './copy-compatibility.js'
import { applySequencePolicy } from './sequence-policy.js'
import {
  MANIFEST_FILE, SOURCE_CONTRACT_FILE, hashAllTables, proveExportSession,
  proveFence, typeContractFrom, type ExportIdentity, type OperatorInput, type TableContent,
} from './source-manifest.js'
import {
  FENCE_SEQUENCES, SEQUENCE_STATE_SQL, acquireSourceFence, effectiveNext,
  parseSequenceState, readFencedSequenceState,
  type AcquiredFence, type FenceExecutor, type FencedSequenceState, type SequenceState,
} from './source-fence.js'

import {
  SET_LOCAL_ROLE_SQL, TARGET_BEGIN_SQL, TARGET_COMMIT_SQL, TARGET_ROLLBACK_SQL,
  assertTargetContract, assertTargetLedger, proveTargetEmpty, proveTargetIdentity,
  proveTargetSequencesPristine, type TargetExpectation,
} from './target-authority.js'

/**
 * What a sequence would ISSUE NEXT, as a decimal string.
 *
 * A string because these are int8 positions and JSON numbers are doubles; a
 * comparison done on numbers would call 2^53 and 2^53+1 equal.
 */
export function effectiveNextOf(state: SequenceState, qname: string): string {
  return effectiveNext(state, qname).toString()
}

/** Where a Stage-2 refusal happened. The A-steps, named. */
export type Stage2Phase =
  | 'A1-bundle'
  | 'A2-fence'
  | 'A3-fence-proof'
  | 'A4-source-session'
  | 'A5-source-equality'
  | 'A5-compatibility'
  | 'A6-target-session'
  | 'A7-target-identity'
  | 'A8-target-contract'
  | 'A9-target-transaction'
  | 'A10-target-pristine'
  | 'A11-copy'
  | 'A12-sequence-policy'
  | 'A13-target-verification'
  | 'A13-source-reproof'
  | 'A15-commit'
  | 'confirmation'

/** WHY a Stage-2 refusal happened. A CLOSED union of reviewed sentences. */
export type Stage2Reason =
  | 'the published bundle does not verify'
  | 'the published bundle is not a complete Stage-1 manifest'
  | 'the source fence could not be taken'
  | 'the source fence could not be proved'
  | 'the source session could not be prepared'
  | 're-derivation does not match the published manifest'
  | 'the source is not compatible with the reviewed target'
  | 'the target C1 was run against is not the reviewed expected-target contract'
  | 'the live target is not the target C1 was run against'
  | 'the target session could not be opened'
  | 'the target transaction could not be started'
  | 'the copy of a reviewed table did not complete'
  | 'the target sequence policy did not complete'
  | 'the target does not hold what the source manifest describes'
  | 'the source changed while the copy was in progress'
  | 'the confirmation was refused'

export class Stage2Refused extends Error {
  constructor(
    readonly phase: Stage2Phase,
    readonly reason: Stage2Reason,
    readonly qname: string | null = null,
  ) {
    super(`${reason} (phase ${phase}${qname === null ? '' : ` for ${qname}`})`)
    this.name = 'Stage2Refused'
  }
}

/**
 * COMMIT WAS SUBMITTED AND ITS OUTCOME IS NOT KNOWN.
 *
 * Deliberately NOT a refusal, and deliberately not retryable. A refusal means
 * the target is untouched; this means nobody can say. The one thing that must
 * never happen here is a ROLLBACK: if the commit succeeded, the copy is done
 * and a rollback would be meaningless; if it did not, the transaction is
 * already gone. Either way the instruction is the same - look, do not act.
 */
export class CommitOutcomeUnknown extends Error {
  constructor(readonly targetDatabase: string) {
    super(
      'COMMIT OUTCOME UNKNOWN: the target transaction was submitted for commit and no ' +
      'usable acknowledgement was received. The target may or may not now hold the copy. ' +
      'It has NOT been rolled back and MUST NOT be retried, re-copied or cleaned up. ' +
      `Inspect ${targetDatabase} before any further action.`)
    this.name = 'CommitOutcomeUnknown'
  }
}

// ---------------------------------------------------------------------------
// A1 — the published bundle
// ---------------------------------------------------------------------------

export interface PublishedManifest {
  readonly bundleName: string
  readonly digestFileDigest: string
  readonly document: Record<string, never>
  readonly contract: ContractArtifact
}

/**
 * Verify the bundle and read what it says.
 *
 * The DIGEST file is verified FIRST, through the reviewed verifier, so every
 * value read afterwards is a value that was covered by it.
 */
export function readPublishedBundle(
  bundleDir: string, readFile: (p: string) => string, sha: (t: string) => string,
  ops?: EvidenceOps,
): PublishedManifest {
  let files: readonly string[]
  try {
    files = verifyPublishedEvidence(bundleDir, ops)
  } catch {
    throw new Stage2Refused('A1-bundle', 'the published bundle does not verify')
  }
  if (!files.includes(MANIFEST_FILE) || !files.includes(SOURCE_CONTRACT_FILE) ||
      !files.includes(DIGEST_FILE)) {
    throw new Stage2Refused('A1-bundle', 'the published bundle does not verify')
  }
  let document: Record<string, never>
  let contract: ContractArtifact
  try {
    document = JSON.parse(readFile(`${bundleDir}/${MANIFEST_FILE}`)) as Record<string, never>
    contract = parseArtifact(readFile(`${bundleDir}/${SOURCE_CONTRACT_FILE}`))
  } catch {
    throw new Stage2Refused('A1-bundle', 'the published bundle is not a complete Stage-1 manifest')
  }
  if ((document as { complete?: unknown }).complete !== true) {
    throw new Stage2Refused('A1-bundle', 'the published bundle is not a complete Stage-1 manifest')
  }
  const bundleName = bundleDir.split('/').filter(s => s !== '').pop() ?? ''
  return Object.freeze({
    bundleName,
    digestFileDigest: sha(readFile(`${bundleDir}/${DIGEST_FILE}`)),
    document,
    contract,
  })
}

/**
 * Load the COMMITTED expected-target artifact, anchored to its reviewed digest.
 *
 * Read from disk and then checked against the compile-time anchor, so an
 * edited file cannot become its own authority - the same reasoning that put
 * `REVIEWED_CONTRACT_DIGEST` in the source rather than in the JSON.
 */
export function loadReviewedTarget(
  path: string, readFile: (p: string) => string,
): ContractArtifact {
  let artifact: ContractArtifact
  try {
    artifact = parseArtifact(readFile(path))
  } catch {
    throw new Stage2Refused(
      'A5-compatibility', 'the source is not compatible with the reviewed target')
  }
  if (artifact.digest !== REVIEWED_CONTRACT_DIGEST) {
    throw new Stage2Refused(
      'A5-compatibility', 'the source is not compatible with the reviewed target')
  }
  return artifact
}

// ---------------------------------------------------------------------------
// A5 — re-derivation must equal the published manifest, exactly
// ---------------------------------------------------------------------------

export interface SourceDerivation {
  readonly identity: ExportIdentity
  readonly contract: ContractArtifact
  readonly tables: readonly TableContent[]
  readonly rootDigest: string
  readonly sequences: Readonly<Record<string, FencedSequenceState>>
}

const manifestTables = (doc: Record<string, never>): Array<{ qname: string; digest: string }> =>
  ((doc.content as unknown as { tables: Array<{ qname: string; digest: string }> }).tables)

const manifestSequences = (doc: Record<string, never>): Array<Record<string, string>> =>
  (doc.sequences as unknown as Array<Record<string, string>>)

/**
 * Every published claim, re-checked against what was just measured.
 *
 * Compared value by value rather than by re-serialising the whole document:
 * the published manifest carries fields that MUST differ between runs - the run
 * id, the timestamp, the backend pid - and a whole-document comparison would
 * either fail on those or have to exclude them by name, which is a list that
 * rots. What must be equal is the CONTENT: the schema, every table digest, the
 * root, and every sequence position.
 */
export function assertSourceMatchesManifest(
  d: SourceDerivation, published: PublishedManifest,
): void {
  const doc = published.document
  const fail = (): never => {
    throw new Stage2Refused(
      'A5-source-equality', 're-derivation does not match the published manifest')
  }

  // THE SCHEMA, by digest and by the bundle's own copy of the artifact.
  const publishedContract =
    (doc.source_contract as unknown as { digest?: unknown }).digest
  if (d.contract.digest !== publishedContract) fail()
  if (d.contract.digest !== published.contract.digest) fail()

  // THE SOURCE ITSELF.
  const src = doc.source as unknown as Record<string, unknown>
  if (d.identity.systemIdentifier !== src.system_identifier) fail()
  if (d.identity.database !== src.database) fail()
  if (d.identity.currentUser !== src.current_user) fail()

  // EVERY TABLE, in the reviewed order, once each.
  const pub = manifestTables(doc)
  if (pub.length !== COPY_TABLES.length || d.tables.length !== COPY_TABLES.length) fail()
  for (let i = 0; i < COPY_TABLES.length; i += 1) {
    if (pub[i].qname !== COPY_TABLES[i]) fail()
    if (d.tables[i].qname !== COPY_TABLES[i]) fail()
    if (d.tables[i].digest !== pub[i].digest) fail()
  }

  // THE ROOT.
  if (d.rootDigest !== (doc.content as unknown as { root_digest: string }).root_digest) fail()

  // EVERY SEQUENCE, position for position.
  const seqs = manifestSequences(doc)
  if (seqs.length !== FENCE_SEQUENCES.length) fail()
  for (let i = 0; i < FENCE_SEQUENCES.length; i += 1) {
    const q = FENCE_SEQUENCES[i]
    const live = d.sequences[q]
    if (live === undefined || seqs[i].qname !== q) fail()
    if (live.last_value !== seqs[i].last_value) fail()
    if (String(live.is_called) !== String(seqs[i].is_called)) fail()
    if (live.increment_by !== seqs[i].increment_by) fail()
    if (effectiveNextOf(live, q) !== seqs[i].effective_next) fail()
  }
}

// ---------------------------------------------------------------------------
// A2-A5, shared by both modes
// ---------------------------------------------------------------------------

export interface SourceStageInput {
  readonly supervisor: FenceExecutor
  readonly prover: FenceExecutor
  readonly source: DriverSession
  readonly operator: OperatorInput
  readonly sourceBeginSql: string
  /**
   * The COMMITTED expected-target artifact, for C1.
   *
   * Inspect never contacts a target, so the thing the source is compared
   * against has to be the reviewed artifact on disk. C2 separately proves that
   * the LIVE target is that same artifact, which is what closes the loop.
   */
  readonly reviewedTarget: ContractArtifact
}

export interface SourceStageResult {
  readonly fence: AcquiredFence
  readonly derivation: SourceDerivation
  readonly compatibility: CompatibilityReport
  /**
   * The proof C1 just issued. Consumed by the copy, and by nothing else.
   *
   * Carried out of `runSourceStages` rather than re-derived later, so the
   * proof the copy uses is the one the check that ran immediately before it
   * produced - not a second, later verdict that could differ.
   */
  readonly proof: CompatibilityProof
}

/**
 * A2-A5. Run by BOTH modes, and by apply from scratch rather than from
 * whatever inspect happened to see.
 */
export async function runSourceStages(
  i: SourceStageInput, published: PublishedManifest,
): Promise<SourceStageResult> {
  // A2.
  let fence: AcquiredFence
  try {
    fence = await acquireSourceFence(i.supervisor)
  } catch {
    throw new Stage2Refused('A2-fence', 'the source fence could not be taken')
  }
  // A3. A DIFFERENT backend.
  try {
    await proveFence(i.prover, fence)
  } catch {
    throw new Stage2Refused('A3-fence-proof', 'the source fence could not be proved')
  }

  // A4. ONE transaction, and the identity of the session holding it.
  let identity: ExportIdentity
  try {
    await i.source.rows(i.sourceBeginSql)
    identity = await proveExportSession(i.source, i.operator)
  } catch {
    throw new Stage2Refused('A4-source-session', 'the source session could not be prepared')
  }

  // A5. Re-derived, on that same backend, inside that same snapshot.
  let contract: ContractArtifact
  let tables: readonly TableContent[]
  try {
    contract = await extractContractFromSession(i.source, identity.pid, SOURCE_V10_PROFILE)
    tables = await hashAllTables(i.source, contract, typeContractFrom(contract))
  } catch {
    throw new Stage2Refused(
      'A5-source-equality', 're-derivation does not match the published manifest')
  }
  const sequences = await readFencedSequenceState(i.supervisor, i.prover, fence)
  const root = rootDigest(
    tables.map(t => ({ schema: t.schema, table: t.table, digest: t.digest })))

  const derivation: SourceDerivation = Object.freeze({
    identity, contract, tables, rootDigest: root, sequences,
  })
  assertSourceMatchesManifest(derivation, published)

  // C1. NOT digest equality - a CURRENT_V10 source and a CURRENT_V19 target
  // can never share a digest, and equality would also refuse harmless target
  // supersets while saying nothing about WHICH property diverged. The
  // comparator answers property by property and names what it found.
  // THE TARGET C1 IS RUN AGAINST MUST BE THE REVIEWED ONE, PROVED HERE.
  //
  // `reviewedTarget` arrives through the public core API, so a caller could
  // hand over a self-consistent artifact of its own choosing and C1 would
  // dutifully compare the source against THAT. The comparison would be honest
  // and the conclusion worthless. Checked before the comparator runs and
  // therefore long before `openTarget` is called, so a substitute costs a
  // refusal and not a connection.
  if (contractDigest(i.reviewedTarget.payload) !== i.reviewedTarget.digest) {
    throw new Stage2Refused(
      'A5-compatibility',
      'the target C1 was run against is not the reviewed expected-target contract')
  }
  if (i.reviewedTarget.digest !== REVIEWED_CONTRACT_DIGEST) {
    throw new Stage2Refused(
      'A5-compatibility',
      'the target C1 was run against is not the reviewed expected-target contract')
  }

  let proof: CompatibilityProof
  try {
    proof = assertCopyCompatible(contract, i.reviewedTarget)
  } catch (e) {
    // The comparator's own message already names the category, the table and
    // the column, and carries nothing from the data.
    throw e instanceof Stage2Refused
      ? e
      : new Stage2Refused('A5-compatibility', 'the source is not compatible with the reviewed target')
  }

  return Object.freeze({ fence, derivation, compatibility: proof.report, proof })
}

/** The binding both modes compute, from the same inputs, independently. */
export function bindingFor(
  published: PublishedManifest, d: SourceDerivation, target: TargetExpectation,
  operator: OperatorInput,
): ConfirmationBinding {
  return {
    bundleName: published.bundleName,
    digestFileDigest: published.digestFileDigest,
    sourceDatabase: d.identity.database,
    sourceSystemIdentifier: d.identity.systemIdentifier,
    sourceRole: d.identity.currentUser,
    sourceContractDigest: d.contract.digest,
    contentRootDigest: d.rootDigest,
    copySetDigest: copySetDigest(COPY_TABLES),
    provenanceHead: operator.provenanceHead,
    ingestionGitlink: operator.ingestionGitlink,
    expectedTargetContractDigest: REVIEWED_CONTRACT_DIGEST,
    targetDatabase: target.database,
    targetSystemIdentifier: target.systemIdentifier,
    targetPort: target.port,
    targetEndpoint: target.endpoint,
    targetRole: target.role,
    implementationHead: operator.implementationHead,
  }
}

export interface InspectResult {
  readonly compatibility: CompatibilityReport
  /** The same report, canonical, for the future lifecycle owner to record. */
  readonly compatibilityDocument: Canonical
  readonly confirmation: string
  readonly rootDigest: string
  readonly contractDigest: string
  readonly bundleName: string
  readonly fence: AcquiredFence
  readonly derivation: SourceDerivation
}

/** INSPECT. A1-A5 and a token. No target client is constructed anywhere here. */
export async function runInspect(
  i: SourceStageInput, published: PublishedManifest, target: TargetExpectation,
): Promise<InspectResult> {
  const { fence, derivation, compatibility } = await runSourceStages(i, published)
  const binding = bindingFor(published, derivation, target, i.operator)
  return Object.freeze({
    compatibility,
    compatibilityDocument: compatibilityDocument(compatibility),
    confirmation: confirmationToken(binding),
    rootDigest: derivation.rootDigest,
    contractDigest: derivation.contract.digest,
    bundleName: published.bundleName,
    fence,
    derivation,
  })
}

// ---------------------------------------------------------------------------
// APPLY — A6 onwards
// ---------------------------------------------------------------------------

export interface ApplyInput extends SourceStageInput {
  /** Constructed ONLY after A5 returns. Nothing calls this earlier. */
  readonly openTarget: () => Promise<DriverSession>
  readonly targetExpectation: TargetExpectation
  readonly confirmation: string
}

export interface ApplyResult {
  readonly committed: true
  readonly rootDigest: string
  readonly bundleName: string
  readonly tablesCopied: number
  readonly confirmation: string
  /**
   * The canonical compatibility document, for the future lifecycle owner.
   *
   * NOT published evidence. Nothing writes an immutable compatibility bundle
   * yet, and describing this as evidence would be a claim about durability
   * that no code here supports.
   */
  readonly compatibility: Canonical
}

/**
 * APPLY. Everything inspect does, then the target, then COMMIT.
 *
 * The caller owns every session and releases them in the reviewed order; this
 * function owns the target TRANSACTION and nothing else.
 */
export async function runApply(i: ApplyInput, published: PublishedManifest): Promise<ApplyResult> {
  // A2-A5, from scratch. Inspect-time state is not trusted, and is not even
  // available: this repeats the work rather than receiving its result.
  const { fence, derivation, compatibility, proof } = await runSourceStages(i, published)

  // THE CONFIRMATION IS CHECKED BEFORE THE TARGET IS TOUCHED. A mismatch must
  // cost nothing, and constructing a client is not nothing.
  const binding = bindingFor(published, derivation, i.targetExpectation, i.operator)
  try {
    assertConfirmationMatches(i.confirmation, binding)
  } catch {
    throw new Stage2Refused('confirmation', 'the confirmation was refused')
  }

  // A6. THE FIRST TARGET CLIENT, and not one statement earlier.
  let target: DriverSession
  try {
    target = await i.openTarget()
  } catch {
    throw new Stage2Refused('A6-target-session', 'the target session could not be opened')
  }

  let began = false
  let commitSubmitted = false
  try {
    // A7. Identity first, outside any transaction.
    await proveTargetIdentity(target, i.targetExpectation)

    // A8. C2, IN ITS OWN READ-ONLY SNAPSHOT.
    //
    // The reviewed extractor refuses a session that could write - that is the
    // whole point of it - and the copy transaction must be able to write. So
    // the contract is read inside a read-only repeatable-read transaction on
    // the SAME session, which is then rolled back before the write transaction
    // begins. Same backend, same role, one snapshot for the ten catalogue
    // queries; what it cannot be is the transaction that later writes.
    await target.rows(i.sourceBeginSql)
    let targetContract: ContractArtifact
    try {
      // UNDER THE COPY'S OWN AUTHORITY. The login role is a MEMBER of the owner
      // and holds no USAGE on the application schemas itself - measured: the
      // columns query fails with "permission denied for schema graph" without
      // this. Reading the contract as anything other than the role the copy
      // will run as would also be checking a different thing from the one that
      // matters.
      await target.rows(SET_LOCAL_ROLE_SQL)
      targetContract = await extractContractFromSession(target, target.pid, TARGET_V19_PROFILE)
      assertTargetLedger(targetContract)
      assertTargetContract(targetContract, REVIEWED_CONTRACT_DIGEST)
      // AND THE LIVE TARGET IS THE TARGET C1 WAS RUN AGAINST.
      //
      // The anchor above says the live target is the reviewed artifact; this
      // says the proof authorising the copy was issued against that same
      // value, derived independently from a live catalogue. Together they
      // close the chain the copy's authority actually rests on:
      //
      //   source artifact -> C1 proof vs the committed reviewed target
      //                   -> the same digest derived from the LIVE target
      //                   -> binary copy
      //
      // Without this the two ends could be about different targets and each
      // check would still pass on its own.
      if (targetContract.digest !== proof.targetDigest) {
        throw new Stage2Refused(
          'A8-target-contract', 'the live target is not the target C1 was run against')
      }
    } finally {
      await target.rows(TARGET_ROLLBACK_SQL)
    }

    // A9. ONE transaction, under the reviewed role.
    try {
      await target.rows(TARGET_BEGIN_SQL)
      began = true
      await target.rows(SET_LOCAL_ROLE_SQL)
    } catch {
      throw new Stage2Refused(
        'A9-target-transaction', 'the target transaction could not be started')
    }

    // A10.
    await proveTargetEmpty(target)
    await proveTargetSequencesPristine(target)

    // A11. Every reviewed table, ONCE, in the reviewed FK-parent order. The
    // loop is over the reviewed constant itself, so "21, once each, in this
    // order" is a property of that constant and not of a list built here.
    for (const qname of COPY_TABLES) {
      try {
        await copyTableBinary(i.source.client, target.client, {
          // THE SOURCE contract, with the proof C1 issued for it moments ago.
          // `copyTableBinary` re-derives the digest from the payload before it
          // reads a column name, so neither the artifact nor the proof can have
          // been swapped in between.
          artifact: derivation.contract, qname, proof,
        })
      } catch {
        throw new Stage2Refused(
          'A11-copy', 'the copy of a reviewed table did not complete', qname)
      }
    }

    // A12. Rollback-safe ALTER SEQUENCE ... RESTART WITH, never setval.
    try {
      await applySequencePolicy(target, derivation.sequences)
    } catch {
      throw new Stage2Refused(
        'A12-sequence-policy', 'the target sequence policy did not complete')
    }

    // A13a. THE TARGET'S OWN MANIFEST, derived inside this same transaction.
    await assertTargetHoldsSource(target, derivation)

    // A13b. THE SOURCE RE-PROOF, last, so the window between "unchanged" and
    // COMMIT is as small as it can be made.
    await reproveSource(i, fence, derivation, published)

    // A14. `began` is cleared BEFORE the submission, so nothing downstream can
    // conclude there is still a transaction to roll back.
    began = false
    // A15.
    commitSubmitted = true
    const outcome = await target.command(TARGET_COMMIT_SQL)
    if (outcome.tag !== 'COMMIT') {
      // A COMMIT on an already-aborted transaction replies with the tag
      // ROLLBACK and does not raise. Counting that as success is the one
      // mistake that would report a copy that never happened.
      throw new CommitOutcomeUnknown(i.targetExpectation.database)
    }
  } catch (e) {
    if (commitSubmitted) {
      // Past the point of certainty. NO ROLLBACK, NO RETRY, and nothing said
      // about what the target now holds.
      throw e instanceof CommitOutcomeUnknown
        ? e : new CommitOutcomeUnknown(i.targetExpectation.database)
    }
    // Before the submission: roll back, and ONLY while a transaction is open.
    if (began) {
      try { await target.rows(TARGET_ROLLBACK_SQL) } catch { /* bounded */ }
      began = false
    }
    throw e
  } finally {
    // The caller releases the source, the prover and the supervisor, in that
    // order, after this returns. The target session is this function's.
    try { await target.end() } catch { /* bounded */ }
  }

  return Object.freeze({
    committed: true,
    rootDigest: derivation.rootDigest,
    bundleName: published.bundleName,
    tablesCopied: COPY_TABLES.length,
    confirmation: i.confirmation,
    // HANDED ON, NOT DISCARDED. The lifecycle owner that will run the
    // independent verifier needs to know what C1 tolerated; nothing publishes
    // it yet, and this does not claim otherwise.
    compatibility: compatibilityDocument(compatibility),
  })
}

/**
 * A13a. The TARGET derives its own manifest and must agree with the source.
 *
 * Derived from the target's own catalogue and its own rows, through the same
 * reviewed primitives, inside the target transaction - so this is two
 * independently computed values being compared, not one value being read twice.
 */
export async function assertTargetHoldsSource(
  target: DriverSession, d: SourceDerivation,
): Promise<void> {
  const fail = (qname: string | null = null): never => {
    throw new Stage2Refused(
      'A13-target-verification',
      'the target does not hold what the source manifest describes', qname)
  }
  let tables: readonly TableContent[]
  try {
    tables = await hashAllTables(target, d.contract, typeContractFrom(d.contract))
  } catch {
    fail()
    throw new Error('unreachable')
  }
  if (tables.length !== COPY_TABLES.length) fail()
  for (let n = 0; n < COPY_TABLES.length; n += 1) {
    if (tables[n].qname !== COPY_TABLES[n]) fail(COPY_TABLES[n])
    if (tables[n].digest !== d.tables[n].digest) fail(COPY_TABLES[n])
  }
  const root = rootDigest(
    tables.map(t => ({ schema: t.schema, table: t.table, digest: t.digest })))
  if (root !== d.rootDigest) fail()

  // THE SEQUENCES, BY EFFECTIVE NEXT. Not by raw representation: a target
  // restarted to N is `last_value = N, is_called = false` while a source that
  // has issued N-1 is `last_value = N-1, is_called = true`. Those are different
  // rows that mean the same thing, and what has to match is what the two would
  // ISSUE NEXT.
  const issued = await targetEffectiveNext(target)
  for (const q of FENCE_SEQUENCES) {
    if (issued[q] !== effectiveNextOf(d.sequences[q], q)) fail(q)
  }
}

/** The three target sequences' effective-next values, after the policy ran. */
async function targetEffectiveNext(
  target: DriverSession,
): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  for (const q of FENCE_SEQUENCES) {
    const state = parseSequenceState(await target.rows(SEQUENCE_STATE_SQL(q)), q)
    out[q] = effectiveNextOf(state, q)
  }
  return out
}

/**
 * A13b. Nothing about the source has moved since A5.
 *
 * Identity, the complete manifest equality again, the live sequence positions,
 * the whole fence and - through `proveFence`, which refuses any ungranted
 * request - zero queued writers.
 */
export async function reproveSource(
  i: SourceStageInput, fence: AcquiredFence, d: SourceDerivation,
  published: PublishedManifest,
): Promise<void> {
  const fail = (): never => {
    throw new Stage2Refused(
      'A13-source-reproof', 'the source changed while the copy was in progress')
  }
  try {
    const identity = await proveExportSession(i.source, i.operator)
    if (identity.pid !== d.identity.pid) fail()
    if (identity.systemIdentifier !== d.identity.systemIdentifier) fail()

    // The fence, from the PROVER, which also refuses anything queued.
    await proveFence(i.prover, fence)

    // The live sequence positions, from the SUPERVISOR, after that proof.
    const live = await readFencedSequenceState(i.supervisor, i.prover, fence)
    for (const q of FENCE_SEQUENCES) {
      if (effectiveNextOf(live[q], q) !== effectiveNextOf(d.sequences[q], q)) fail()
      if (live[q].last_value !== d.sequences[q].last_value) fail()
      if (live[q].is_called !== d.sequences[q].is_called) fail()
    }

    // And the whole manifest equality again, against the SAME published bundle.
    assertSourceMatchesManifest({ ...d, sequences: live }, published)
  } catch (e) {
    if (e instanceof Stage2Refused) throw e
    fail()
  }
}

/** Re-exported so a caller never has to name the canonicaliser itself. */
export { canonicalJson, compatibilityDocument }
export type { Canonical, BatchSummary }
