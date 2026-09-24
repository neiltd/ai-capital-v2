// The TARGET side of the three reviewed sequences: set each one to hand out
// exactly the value the fenced source would issue next, inside the caller's
// transaction, and prove it before letting go.
//
// WHY ALTER SEQUENCE ... RESTART AND NEVER setval(). `setval()` is not
// transactional: its effect survives a ROLLBACK. A copy that fails after
// touching sequences would leave the target holding positions nobody chose,
// silently, with no failure to point at. `ALTER SEQUENCE ... RESTART WITH` is
// undone by the same ROLLBACK that undoes the rows, so the target is either
// wholly copied or wholly untouched.
//
// WHY THE STATE MUST BE FENCED. The value to restart to is the source's next
// value, and that number only means something if nothing could hand it out
// between reading it and using it. `FencedSequenceState` can only be produced by
// `readFencedSequenceState`, which will not return until an independent backend
// has proved the whole 21-table, 3-sequence fence. An ordinary `SequenceState`
// is a number somebody read at some moment, and the type system refuses it here.
//
// WHY THIS MODULE OWNS NO TRANSACTION. The target transaction spans the rows and
// the sequences together; committing here would end it after the sequences and
// before anything could check the rows. So the caller owns BEGIN, COMMIT and
// ROLLBACK, and this module proves a transaction exists rather than starting
// one - by issuing SAVEPOINT, which PostgreSQL refuses outside a transaction
// block. That refusal is the proof, and it costs nothing when it fires.

import {
  FENCE_SEQUENCES, SEQUENCE_STATE_SQL, effectiveNext, parseSequenceState,
  type FencedSequenceState, type SequenceState,
} from './source-fence.js'

/** Where a refusal or failure happened. Fixed values, never derived from an error. */
export type SequencePolicyPhase =
  | 'no-transaction' | 'source-state' | 'target-read' | 'preflight'
  | 'apply' | 'verify' | 'release'

const DISCARD =
  'Roll back the outer target transaction; it is not reusable. No detail is ' +
  'retained, because a driver error can carry statement text and row values.'

/** A refusal decided BEFORE anything was altered. */
export class SequencePolicyRefused extends Error {
  constructor(readonly phase: SequencePolicyPhase, readonly qname: string | null, why: string) {
    super(`sequence policy refused at ${phase}${qname === null ? '' : ` for ${qname}`}: ${why}`)
    this.name = 'SequencePolicyRefused'
  }
}

/**
 * A failure while talking to the target.
 *
 * Carries the phase and, where one applies, a reviewed qualified name - nothing
 * else. The original driver error is discarded rather than wrapped: it can carry
 * the failing statement and, for a sequence, the values around it.
 */
export class SequencePolicyFailed extends Error {
  constructor(readonly phase: SequencePolicyPhase, readonly qname: string | null) {
    super(
      `sequence policy failed at ${phase}${qname === null ? '' : ` for ${qname}`}. ${DISCARD}`)
    this.name = 'SequencePolicyFailed'
  }
}

/** One already-connected target session. No URL, no config, nothing to open. */
export interface TargetSessionExecutor {
  rows(sql: string): Promise<string[][]>
}

/** The reviewed order: ascending qualified name, from the one copy-set authority. */
export const POLICY_SEQUENCES: readonly string[] = FENCE_SEQUENCES

/** The savepoint whose acceptance proves an outer transaction is open. */
export const POLICY_SAVEPOINT = 'ai_capital_sequence_policy'
export const SAVEPOINT_SQL = `SAVEPOINT ${POLICY_SAVEPOINT}`
export const RELEASE_SQL = `RELEASE SAVEPOINT ${POLICY_SAVEPOINT}`

/** `ALTER SEQUENCE <qname> RESTART WITH <n>` - the only statement that mutates. */
export function restartSql(qname: string, next: bigint): string {
  if (!POLICY_SEQUENCES.includes(qname)) {
    throw new SequencePolicyRefused('preflight', qname, 'not a reviewed sequence')
  }
  // Decimal, from a bigint. Never a Number: 2^53 is well inside bigserial's
  // range, and a float would round a position into a different position.
  return `ALTER SEQUENCE ${qname} RESTART WITH ${next.toString()}`
}

export interface SequencePolicyResult {
  /** Reviewed order. */
  readonly qnames: readonly string[]
  /** Decimal strings, index-aligned with `qnames`. Never numbers. */
  readonly effectiveNext: readonly string[]
}

/** The static shape both sides must agree on before anything is altered. */
const CONFIG_FIELDS = [
  'increment_by', 'min_value', 'max_value', 'start_value',
  'cache_size', 'data_type', 'owned_by',
] as const

function assertExactKeys(source: Readonly<Record<string, FencedSequenceState>>): void {
  const given = Object.keys(source).sort()
  const want = [...POLICY_SEQUENCES]
  const missing = want.filter(q => !given.includes(q))
  const extra = given.filter(q => !want.includes(q))
  if (missing.length > 0 || extra.length > 0) {
    throw new SequencePolicyRefused(
      'source-state', null,
      `expected exactly ${want.length} reviewed sequences; missing [${missing.join(', ')}], ` +
      `unexpected [${extra.join(', ')}]`)
  }
}

/**
 * Apply the reviewed sequence policy to the target, inside the caller's
 * transaction.
 *
 * ORDER IS THE SAFETY ARGUMENT: every effective-next is computed, then a
 * transaction is proved, then ALL THREE target states are read and validated,
 * and only then does the first ALTER run. Validating each sequence just before
 * altering it would let a bad third sequence leave the first two changed - and
 * since the caller is told to roll back, that would be recoverable but
 * indistinguishable from a clean refusal.
 */
export async function applySequencePolicy(
  target: TargetSessionExecutor,
  source: Readonly<Record<string, FencedSequenceState>>,
): Promise<SequencePolicyResult> {
  assertExactKeys(source)

  // 1. Everything computed before the target is touched at all.
  const wanted = new Map<string, bigint>()
  for (const q of POLICY_SEQUENCES) {
    const state: SequenceState = source[q]
    wanted.set(q, effectiveNext(state, q))
  }

  const ask = async (sql: string, phase: SequencePolicyPhase, qname: string | null):
    Promise<string[][]> => {
    try {
      return await target.rows(sql)
    } catch {
      throw new SequencePolicyFailed(phase, qname)
    }
  }

  // 2. Prove an outer transaction exists. PostgreSQL refuses SAVEPOINT outside
  //    a transaction block, so this both asks and answers the question - and it
  //    changes nothing if the answer is no.
  try {
    await target.rows(SAVEPOINT_SQL)
  } catch {
    throw new SequencePolicyRefused(
      'no-transaction', null,
      'SAVEPOINT was refused, so no outer transaction is open; nothing was altered')
  }

  // 3. Read ALL THREE target states before any of them is altered.
  const before = new Map<string, SequenceState>()
  for (const q of POLICY_SEQUENCES) {
    before.set(q, parseSequenceState(await ask(SEQUENCE_STATE_SQL(q), 'target-read', q), q))
  }

  // 4. Validate ALL THREE before the first ALTER.
  for (const q of POLICY_SEQUENCES) {
    const t = before.get(q) as SequenceState
    const s: SequenceState = source[q]
    if (t.is_called) {
      throw new SequencePolicyRefused(
        'preflight', q, 'the target sequence has already issued a value (is_called)')
    }
    if (t.last_value !== t.start_value) {
      throw new SequencePolicyRefused(
        'preflight', q, 'the target sequence is not at its start value')
    }
    for (const f of CONFIG_FIELDS) {
      if (t[f] !== s[f]) {
        throw new SequencePolicyRefused(
          'preflight', q, `target ${f} does not match the fenced source`)
      }
    }
    if (t.cycle !== s.cycle) {
      throw new SequencePolicyRefused('preflight', q, 'target cycle does not match the fenced source')
    }
  }

  // 5. Apply, in reviewed order.
  for (const q of POLICY_SEQUENCES) {
    await ask(restartSql(q, wanted.get(q) as bigint), 'apply', q)
  }

  // 6. Prove it, inside the same transaction.
  for (const q of POLICY_SEQUENCES) {
    const after = parseSequenceState(await ask(SEQUENCE_STATE_SQL(q), 'verify', q), q)
    if (effectiveNext(after, q) !== (wanted.get(q) as bigint)) {
      throw new SequencePolicyRefused(
        'verify', q, 'the target would not issue the value the fenced source would issue next')
    }
  }

  // 7. Only now.
  await ask(RELEASE_SQL, 'release', null)

  return {
    qnames: POLICY_SEQUENCES,
    effectiveNext: POLICY_SEQUENCES.map(q => (wanted.get(q) as bigint).toString()),
  }
}
