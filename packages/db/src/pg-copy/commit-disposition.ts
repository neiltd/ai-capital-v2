// WHAT THE TARGET ACTUALLY HOLDS, WHEN NOBODY KNOWS WHETHER COMMIT LANDED.
//
// `CommitOutcomeUnknown` means the COMMIT was submitted and no usable
// acknowledgement came back. The transaction may have committed; it may have
// been lost with the connection. Until that is settled by LOOKING, the target
// must not be called committed - and an earlier design flowed a COMMIT-unknown
// straight into rows that assumed it was, which is the one assumption the
// situation forbids.
//
// THE COMPARISON HAS TO BE AGAINST SOMETHING MINTED BEFORE THE DOUBT.
// Reconstructing "what the copy would have written" from operator input after
// the fact is not evidence; it is a second chance to describe the answer you
// hoped for. So the handoff is built while the copy still knows exactly what it
// was about to commit, registered by identity, and carried out through the
// error itself.
//
// THREE OUTCOMES AND NO FOURTH. Anything that is not exactly-matching and not
// provably pristine is INDETERMINATE, including every proof that could not be
// taken. A fourth outcome meaning "probably fine" is how a target with partial
// data gets retried on top of itself.

import {
  COPY_TABLES, REVIEWED_CONTRACT_DIGEST, SOURCE_V10_PROFILE, TARGET_V19_PROFILE,
  extractContractFromSession, type Canonical, type ContractArtifact,
} from './schema-contract.js'
import {
  FENCE_SEQUENCES, SEQUENCE_STATE_SQL, effectiveNext, parseSequenceState,
} from './source-fence.js'
import {
  SET_LOCAL_ROLE_SQL, TARGET_IDENTITY_COLUMNS, TARGET_IDENTITY_SQL,
} from './target-authority.js'
import {
  VERIFY_BEGIN_SQL, VERIFY_ROLLBACK_SQL,
  type VerifierHandoff, type VerifyCloseable,
} from './verify.js'
import {
  verifyAllTables, verifyVectorFrom, type VerifiedContent,
} from './verify-content.js'

/** The evidence prefix this module's record is published under. */
export const COMMIT_DISPOSITION_PREFIX = 'commit-disposition'

/** One table, as the copy was about to commit it. */
export interface HandoffTableState {
  readonly qname: string
  readonly digest: string
  readonly rows: number
}

/**
 * EVERYTHING NEEDED TO CLASSIFY A TARGET, minted before the COMMIT was sent.
 *
 * Non-forgeable by identity: an object with these fields is a claim anybody can
 * write, and the whole value of this structure is that it was fixed BEFORE the
 * outcome became uncertain.
 */
export interface CommitUnknownHandoff {
  readonly sourceContract: ContractArtifact
  readonly sourceContractDigest: string
  readonly targetContractDigest: string
  readonly rootDigest: string
  readonly tables: readonly HandoffTableState[]
  readonly sequences: readonly { qname: string; effectiveNext: string }[]
  readonly target: {
    readonly systemIdentifier: string
    readonly database: string
    readonly role: string
  }
  readonly bundleName: string
  /**
   * THE COMPLETE VERIFIER HANDOFF, fixed at the same instant.
   *
   * A target classified COMMITTED_EXACT continues into independent
   * verification and the normal release - which is what the run would have
   * done had the acknowledgement arrived - and the verifier needs the whole
   * handoff to do that. Assembling one afterwards would mean rebuilding, from
   * a target whose contents are in question, the description that target is
   * about to be checked against.
   */
  readonly verifierHandoff: VerifierHandoff
}

const MINTED_HANDOFFS = new WeakSet<object>()

export function isCommitUnknownHandoff(v: unknown): v is CommitUnknownHandoff {
  return typeof v === 'object' && v !== null && MINTED_HANDOFFS.has(v)
}

/** The ONE place a handoff is minted. Called before COMMIT is submitted. */
/**
 * Freeze an object and everything reachable from it.
 *
 * A SHALLOW FREEZE IS NOT ENOUGH HERE. The handoff is the only description of
 * what the copy was about to commit, and it is consulted AFTER the doubt
 * exists - which is exactly when somebody, or some later code path, has a
 * motive to adjust one table's expected digest so the target matches. A frozen
 * outer object whose `tables[3]` is still mutable protects nothing.
 */
function deepFreeze<T>(v: T): T {
  if (v === null || typeof v !== 'object') return v
  if (Object.isFrozen(v)) return v
  Object.freeze(v)
  for (const k of Reflect.ownKeys(v)) {
    deepFreeze((v as unknown as Record<string | symbol, unknown>)[k])
  }
  return v
}

export function mintCommitUnknownHandoff(h: CommitUnknownHandoff): CommitUnknownHandoff {
  // COPIED FIRST, THEN FROZEN. Freezing the caller's object would leave the
  // caller holding a reference to the very thing that was registered, and a
  // structuredClone would drop the contract artifact's prototype.
  const minted = deepFreeze({
    ...h,
    sourceContract: deepFreeze({ ...h.sourceContract }),
    tables: h.tables.map(t => ({ ...t })),
    sequences: h.sequences.map(x => ({ ...x })),
    target: { ...h.target },
    verifierHandoff: { ...h.verifierHandoff },
  }) as CommitUnknownHandoff
  MINTED_HANDOFFS.add(minted)
  return minted
}

/** The only three things that may be said about an uncertain target. */
export type TargetDisposition =
  | 'COMMITTED_EXACT'
  | 'NOT_COMMITTED_PRISTINE'
  | 'INDETERMINATE'


/**
 * THE WHOLE DECISION, separated from the measuring so it can be stated.
 *
 * BOTH ANSWERS FIT WHEN THE COPY HAD NOTHING TO MOVE. A source with no rows at
 * all leaves a target that is simultaneously an exact copy and untouched, and
 * `COMMITTED_EXACT` there would assert something no measurement supports - the
 * COMMIT may have been applied or may have been lost, and the target looks
 * identical either way. That case is the reason this function exists as its own
 * named thing rather than as a chain of `if`s inside a session-holding
 * function nobody can call without two live clusters.
 */
export function decideDisposition(
  allMatched: boolean, allPristine: boolean,
): { disposition: TargetDisposition; cause: string } {
  if (allMatched && allPristine) {
    return {
      disposition: 'INDETERMINATE',
      cause: 'an empty copy is indistinguishable from an untouched target',
    }
  }
  if (allMatched) {
    return {
      disposition: 'COMMITTED_EXACT',
      cause: 'every table digest, row count and sequence position matches the handoff',
    }
  }
  if (allPristine) {
    return {
      disposition: 'NOT_COMMITTED_PRISTINE',
      cause: 'every reviewed table is empty and every reviewed sequence is pristine',
    }
  }
  return {
    disposition: 'INDETERMINATE',
    cause: 'the target is neither an exact copy nor pristine',
  }
}

export class CommitDispositionRefused extends Error {
  constructor(readonly reason: string) {
    super(reason)
    this.name = 'CommitDispositionRefused'
  }
}

export interface DispositionResult {
  readonly disposition: TargetDisposition
  /** A reviewed sentence, and never a measured value. */
  readonly cause: string
  readonly tables: readonly { qname: string; matched: boolean; empty: boolean }[]
  readonly sequences: readonly { qname: string; matched: boolean; pristine: boolean }[]
  readonly rootDigest: string | null
}

export interface DispositionInput {
  readonly handoff: CommitUnknownHandoff
  /** A FRESH read-only target session, opened and closed by this module. */
  readonly openTarget: () => Promise<VerifyCloseable>
  /** A FRESH read-only source session, for the contract the digests fold in. */
  readonly openSource: () => Promise<VerifyCloseable>
}

const indeterminate = (cause: string): DispositionResult => Object.freeze({
  disposition: 'INDETERMINATE', cause, tables: [], sequences: [], rootDigest: null,
})

/**
 * CLASSIFY THE TARGET, READ-ONLY, WITHOUT TOUCHING THE UNCERTAIN TRANSACTION.
 *
 * WHAT THIS SENDS. Its own `BEGIN TRANSACTION READ ONLY ISOLATION LEVEL
 * REPEATABLE READ`, catalogue and content reads, and a `ROLLBACK` that ends
 * ITS OWN snapshot. It never issues a rollback, truncate, delete or migration
 * against the copy's transaction - which is not its to end and is already gone
 * from its ownership.
 *
 * WHY THE SOURCE IS OPENED TOO. Every table digest folds the SOURCE contract's
 * digest, so a target measured against its own V19 contract could not match the
 * handoff no matter how identical the rows. The source contract is re-derived
 * rather than taken from the handoff object, so the comparison has two
 * independently obtained sides.
 */
export async function classifyTargetDisposition(
  i: DispositionInput,
): Promise<DispositionResult> {
  if (!isCommitUnknownHandoff(i.handoff)) {
    throw new CommitDispositionRefused(
      'the commit handoff was not minted before the commit was submitted')
  }
  const h = i.handoff

  let source: VerifyCloseable | null = null
  let target: VerifyCloseable | null = null
  try {
    try {
      target = await i.openTarget()
      await target.rows(VERIFY_BEGIN_SQL)
      await target.rows(SET_LOCAL_ROLE_SQL)
    } catch {
      return indeterminate('the target could not be inspected')
    }

    // THE LIVE TARGET IS THE ONE THE COPY WAS AIMED AT - by CLUSTER, DATABASE
    // and EFFECTIVE ROLE, measured here and compared with the handoff.
    //
    // WHY THE CONTRACT DIGEST IS NOT ENOUGH. Two databases restored from the
    // same schema have the same contract digest, and a reviewed target and its
    // staging twin are exactly that pair. Without the identity triple this
    // function would happily classify the twin and report that the copy did or
    // did not land - a sentence about the wrong database, delivered with the
    // same confidence as the right one. The effective role matters too: the
    // digests below are read under `SET LOCAL ROLE`, and a session that did not
    // actually reach that role is reading a different view of the same tables.
    try {
      const rows = await target.rows(TARGET_IDENTITY_SQL)
      const row = rows[0] ?? []
      if (row.length !== TARGET_IDENTITY_COLUMNS) {
        return indeterminate('the target identity could not be measured')
      }
      const [, systemIdentifier, , database, , currentUser] = row
      if (systemIdentifier !== h.target.systemIdentifier) {
        return indeterminate('the target is not the cluster the copy was aimed at')
      }
      if (database !== h.target.database) {
        return indeterminate('the target is not the database the copy was aimed at')
      }
      if (currentUser !== h.target.role) {
        return indeterminate('the target session is not in the role the copy wrote as')
      }
    } catch {
      return indeterminate('the target identity could not be measured')
    }

    // AND ONLY NOW THE SOURCE CONTRACT, re-derived under the still-held fence.
    //
    // AFTER THE TARGET IDENTITY, on purpose. "Am I looking at the right
    // database" is the cheapest and most decisive question there is, and
    // asking it second meant a wrong-database run reported a SOURCE problem -
    // sending whoever read the record to look at the one half that was fine.
    // THE SOURCE CONTRACT, re-derived under the still-held fence.
    let sourceContract: ContractArtifact
    try {
      source = await i.openSource()
      await source.rows(VERIFY_BEGIN_SQL)
      sourceContract = await extractContractFromSession(
        source, source.pid, SOURCE_V10_PROFILE)
    } catch {
      return indeterminate('the source contract could not be re-derived')
    }
    if (sourceContract.digest !== h.sourceContractDigest) {
      return indeterminate('the source is not the artifact the copy was about to commit')
    }

    try {
      const targetContract = await extractContractFromSession(
        target, target.pid, TARGET_V19_PROFILE)
      if (targetContract.digest !== REVIEWED_CONTRACT_DIGEST ||
          targetContract.digest !== h.targetContractDigest) {
        return indeterminate('the target is not the reviewed target')
      }
    } catch {
      return indeterminate('the target contract could not be re-derived')
    }

    let measured: VerifiedContent
    try {
      measured = await verifyAllTables(target, sourceContract, verifyVectorFrom(sourceContract))
    } catch {
      return indeterminate('the target content could not be measured')
    }

    const tables = COPY_TABLES.map((q, n) => ({
      qname: q,
      matched: measured.tables[n]?.qname === q &&
               measured.tables[n]?.digest === h.tables[n].digest &&
               measured.tables[n]?.rows === h.tables[n].rows,
      empty: measured.tables[n]?.qname === q && measured.tables[n]?.rows === 0,
    }))

    // SEQUENCES. `effective next` on both sides, plus a separate pristineness
    // reading, because "restarted to what the source would issue" and "never
    // touched" are different facts and each one settles a different outcome.
    const sequences: Array<{ qname: string; matched: boolean; pristine: boolean }> = []
    for (let n = 0; n < FENCE_SEQUENCES.length; n += 1) {
      const q = FENCE_SEQUENCES[n]
      try {
        const state = parseSequenceState(await target.rows(SEQUENCE_STATE_SQL(q)), q)
        sequences.push({
          qname: q,
          matched: effectiveNext(state, q).toString() === h.sequences[n].effectiveNext,
          pristine: !state.is_called && state.last_value === state.start_value,
        })
      } catch {
        return indeterminate('a target sequence could not be read')
      }
    }

    const allMatched = tables.every(t => t.matched) && sequences.every(s => s.matched) &&
                       measured.rootDigest === h.rootDigest
    const allPristine = tables.every(t => t.empty) && sequences.every(s => s.pristine)
    const decided = decideDisposition(allMatched, allPristine)
    return Object.freeze({
      disposition: decided.disposition,
      cause: decided.cause,
      tables: Object.freeze(tables), sequences: Object.freeze(sequences),
      rootDigest: measured.rootDigest,
    })
  } finally {
    // ONLY THIS MODULE'S OWN SESSIONS, and only its own transactions.
    for (const s of [target, source]) {
      if (s === null) continue
      try { await s.rows(VERIFY_ROLLBACK_SQL) } catch { /* bounded */ }
      try { await s.end() } catch { /* bounded */ }
    }
  }
}

/** The immutable record. Counts and digests only; never a row value. */
export function dispositionDocument(
  h: CommitUnknownHandoff, r: DispositionResult, runId: string, stamp: string,
): Canonical {
  return {
    commit_disposition_version: 1,
    complete: true,
    record: 'commit-disposition',
    run: { id: runId, stamp },
    bundle: { name: h.bundleName },
    disposition: r.disposition,
    cause: r.cause,
    expected: {
      root_digest: h.rootDigest,
      source_contract_digest: h.sourceContractDigest,
      target_contract_digest: h.targetContractDigest,
    },
    measured_root_digest: r.rootDigest,
    target: {
      system_identifier: h.target.systemIdentifier,
      database: h.target.database,
      role: h.target.role,
    },
    tables: r.tables.map(t => ({ qname: t.qname, matched: t.matched, empty: t.empty })),
    sequences: r.sequences.map(s => ({
      qname: s.qname, matched: s.matched, pristine: s.pristine,
    })),
  }
}
