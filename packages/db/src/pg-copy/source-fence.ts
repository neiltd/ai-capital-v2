// The SOURCE FENCE: hold the reviewed 21-table copy set and its three sequences
// still, in one session, for the length of a copy - or refuse.
//
// WHAT A FENCE IS FOR. The copy reads 21 tables and three sequences and claims
// the result is one consistent picture. That claim is false if anything writes
// to the source while it is being read, and "nothing was writing at the time" is
// not something a reader can check after the fact. So the fence is taken FIRST,
// proved SECOND, and the copy runs third - and if any part of it cannot be
// proved, nothing is copied.
//
// WHY SHARE MODE. `SHARE` conflicts with `ROW EXCLUSIVE`, which every
// INSERT/UPDATE/DELETE takes, and with the `ACCESS EXCLUSIVE` that TRUNCATE
// takes. It does NOT conflict with `ACCESS SHARE`, so ordinary SELECT and
// `COPY ... TO` keep working. That asymmetry is the point: the fence stops
// writers without stopping the reader it exists to serve.
//
// WHY NO RETRIES, ANYWHERE. A retry converts "the source was busy" into "the
// source was busy for a while and then we got in", which is a different and
// much weaker statement - and in a deadlock it is the statement that hides the
// deadlock. Every lock is attempted exactly once, under a bounded
// `lock_timeout`, and the first failure ends the attempt.
//
// WHY THE PROOF RUNS ON ANOTHER BACKEND. A session asking `pg_locks` about its
// own locks will see them whether or not they mean anything to anyone else. The
// question the copier actually needs answered is "is some OTHER backend holding
// the source still for me", and only a different backend can ask it.

import { COPY_SEQUENCES, COPY_TABLES } from './schema-contract.js'

export class FenceRefused extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'FenceRefused'
  }
}

/**
 * The reviewed advisory key.
 *
 * Two int4s rather than one int8 so the pair is visible as `classid`/`objid` in
 * `pg_locks` without arithmetic - a human reading the lock table can match it by
 * eye. The value is arbitrary but FIXED: an advisory lock only excludes the
 * other holders of the same key, so a key that varied per run would exclude
 * nobody.
 */
export const FENCE_ADVISORY_CLASSID = 0x5334_4644 | 0
export const FENCE_ADVISORY_OBJID = 0x0000_0C01 | 0

/** Bounded. A fence that waits forever is a hang wearing a fence's clothes. */
export const FENCE_LOCK_TIMEOUT_MS = 5_000

/**
 * The 21 reviewed tables, ascending by qualified name.
 *
 * ORDER IS THE DEADLOCK ARGUMENT, not a formatting preference. Two sessions that
 * take the same locks in the same order queue behind each other; two that take
 * them in different orders can each hold what the other needs. Sorting here, from
 * the single copy-set authority, means the order cannot drift from the set.
 */
export const FENCE_TABLES: readonly string[] = Object.freeze(
  [...COPY_TABLES].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)))

/** The three reviewed sequences, ascending, from the same authority. */
export const FENCE_SEQUENCES: readonly string[] = Object.freeze(
  [...COPY_SEQUENCES].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)))

export const FENCE_TABLE_LOCK_MODE = 'ShareLock'
/** What `ALTER SEQUENCE` takes; it conflicts with nextval's RowExclusiveLock. */
export const FENCE_SEQUENCE_LOCK_MODE = 'ShareRowExclusiveLock'

if (FENCE_TABLES.length !== 21) {
  throw new FenceRefused(`the reviewed copy set holds ${FENCE_TABLES.length} tables, not 21.`)
}
if (FENCE_SEQUENCES.length !== 3) {
  throw new FenceRefused(`the reviewed copy set holds ${FENCE_SEQUENCES.length} sequences, not 3.`)
}

/**
 * A PostgreSQL boolean as TEXT, strictly.
 *
 * `boolean::text` yields `true`/`false`, while psql DISPLAYS an uncast boolean
 * as `t`/`f`. Both spellings reach this code depending on whether a column was
 * cast, and reading one as the other silently inverts a fence result - which is
 * exactly how a proof comes back saying every lock is ungranted. Anything that
 * is neither spelling is refused rather than coerced.
 */
export function pgBool(value: string, what: string): boolean {
  if (value === 'true' || value === 't') return true
  if (value === 'false' || value === 'f') return false
  throw new FenceRefused(`${what} is "${value}", which is neither true nor false.`)
}

/** A qualified name is two dot-separated unquoted identifiers, or it is refused. */
const QNAME = /^[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*$/
export function assertQName(q: string): string {
  if (!QNAME.test(q)) {
    throw new FenceRefused(
      `"${q}" is not a bare qualified name; the fence never interpolates anything else.`)
  }
  return q
}

// ---------------------------------------------------------------------------
// Sequence-fence candidates. Which one is USED is decided by live PostgreSQL,
// not here: `SELECTED_SEQUENCE_FENCE` names the first candidate that passed
// every required property, and the integration suite re-derives that choice.
// ---------------------------------------------------------------------------

export type SequenceFenceId = 'S1' | 'S2' | 'S3' | 'S4'

export interface SequenceState {
  readonly last_value: string
  readonly is_called: boolean
  readonly increment_by: string
  readonly min_value: string
  readonly max_value: string
  readonly start_value: string
  readonly cache_size: string
  readonly cycle: boolean
  readonly data_type: string
  readonly owned_by: string
}

/**
 * The live state of one sequence, read WITHOUT `pg_sequence_last_value()`.
 *
 * THE MEASURED REASON. `pg_sequence_last_value()` - and therefore the
 * `pg_sequences` view that calls it - acquires the same `RowExclusiveLock` on
 * the sequence that `nextval()` does. Any fence strong enough to stop `nextval`
 * necessarily stops that function too, so "nextval must block" and
 * "pg_sequences must stay readable" cannot both hold on PostgreSQL 17. They are
 * the same lock.
 *
 * Nothing is lost by avoiding it. Reading the sequence relation directly takes
 * only `AccessShareLock` and returns `last_value`/`is_called`; every option
 * (`increment`, `min`, `max`, `start`, `cache`, `cycle`, type) lives in
 * `pg_catalog.pg_sequence`, and the owning column in `pg_depend`. Both are
 * ordinary catalogue reads. Measured under a held fence, all of them succeed and
 * all of them report the PRE-FENCE values.
 */
export const SEQUENCE_STATE_SQL = (q: string): string => {
  assertQName(q)
  return `
SELECT s.last_value::pg_catalog.text, s.is_called::pg_catalog.text,
       o.seqincrement::pg_catalog.text, o.seqmin::pg_catalog.text,
       o.seqmax::pg_catalog.text, o.seqstart::pg_catalog.text,
       o.seqcache::pg_catalog.text, o.seqcycle::pg_catalog.text,
       pg_catalog.format_type(o.seqtypid, NULL),
       -- COALESCE is a SQL special form, not a pg_catalog function: qualifying
       -- it does not resolve, exactly as with CURRENT_USER.
       COALESCE(
         (SELECT tn.nspname || '.' || tc.relname || '.' || a.attname
            FROM pg_catalog.pg_depend d
            JOIN pg_catalog.pg_class tc ON tc.oid = d.refobjid
            JOIN pg_catalog.pg_namespace tn ON tn.oid = tc.relnamespace
            JOIN pg_catalog.pg_attribute a
              ON a.attrelid = d.refobjid AND a.attnum = d.refobjsubid
           WHERE d.classid = 'pg_catalog.pg_class'::pg_catalog.regclass
             AND d.objid = '${q}'::pg_catalog.regclass
             AND d.refclassid = 'pg_catalog.pg_class'::pg_catalog.regclass
             AND d.deptype IN ('a', 'i')
           LIMIT 1), ''::pg_catalog.text)
  FROM ${q} s
  CROSS JOIN pg_catalog.pg_sequence o
 WHERE o.seqrelid = '${q}'::pg_catalog.regclass`
}

/**
 * The read that a fence MUST block, named once so a test can assert it does.
 *
 * It is here rather than in the test because it is a property of the design:
 * this is the lock `nextval()` takes, and the fence exists to hold it.
 */
export const SEQUENCE_LAST_VALUE_SQL = (q: string): string =>
  `SELECT pg_catalog.pg_sequence_last_value('${assertQName(q)}'::pg_catalog.regclass)`

export function parseSequenceState(rows: readonly (readonly string[])[], q: string): SequenceState {
  if (rows.length !== 1) {
    throw new FenceRefused(`expected exactly one state row for ${q}, got ${rows.length}.`)
  }
  const r = rows[0]
  return {
    last_value: r[0], is_called: pgBool(r[1], `${q}.is_called`), increment_by: r[2],
    min_value: r[3], max_value: r[4], start_value: r[5],
    cache_size: r[6], cycle: pgBool(r[7], `${q}.cycle`), data_type: r[8], owned_by: r[9],
  }
}

/**
 * The value `nextval()` would return NEXT, given the current state.
 *
 * `is_called` is the whole subtlety: a freshly created sequence has
 * `last_value = start` with `is_called = false`, meaning "start has not been
 * handed out yet", so the next value IS `last_value`. After one `nextval()` the
 * flag flips and the next value is `last_value + increment_by`.
 */
export function effectiveNext(s: SequenceState, q: string): bigint {
  const last = BigInt(s.last_value)
  const inc = BigInt(s.increment_by)
  const next = s.is_called ? last + inc : last
  const min = BigInt(s.min_value)
  const max = BigInt(s.max_value)
  if (next < min || next > max) {
    throw new FenceRefused(
      `${q} would next hand out ${next.toString()}, outside [${s.min_value}, ${s.max_value}]. ` +
      'A fence that cannot restate the current position must not guess at one.')
  }
  return next
}

/** The exact SQL each candidate uses, for one sequence. */
export function sequenceFenceSql(id: SequenceFenceId, q: string, state: SequenceState): string {
  assertQName(q)
  switch (id) {
    case 'S1':
      return `LOCK TABLE ${q} IN SHARE MODE`
    case 'S2':
      return `ALTER SEQUENCE ${q} RESTART WITH ${effectiveNext(state, q).toString()}`
    case 'S3':
      return `ALTER SEQUENCE ${q} INCREMENT BY ${BigInt(state.increment_by).toString()}`
    case 'S4':
      return `SELECT last_value FROM ${q} FOR UPDATE`
  }
}

/**
 * Does the candidate RESTATE the sequence's position?
 *
 * This is the property that decides acquisition safety, so it is written down
 * rather than inferred. A candidate that restates position must first READ the
 * position, and the read cannot be inside the lock it is about to take - so
 * there is an interval, however short, in which another backend can call
 * `nextval()` and have its value written back over.
 */
export const RESTATES_POSITION: Readonly<Record<SequenceFenceId, boolean>> = Object.freeze({
  S1: false, S2: true, S3: false, S4: false,
})

/** One candidate's score, as measured against a live server. */
export interface CandidateScore {
  readonly accepted: boolean
  readonly p1ByteIdentity: boolean
  readonly p2NextvalBlocked: boolean
  readonly p3ReadsTruthful: boolean
  readonly p4DeathReleases: boolean
  readonly p5HeldThroughCommit: boolean
  /** P6: safe against a `nextval()` interleaved BEFORE the locking statement. */
  readonly p6AcquisitionSafe: boolean
}

export const CANDIDATE_ORDER: readonly SequenceFenceId[] = Object.freeze(['S1', 'S2', 'S3', 'S4'])

export function candidateQualifies(sc: CandidateScore): boolean {
  return sc.accepted && sc.p1ByteIdentity && sc.p2NextvalBlocked && sc.p3ReadsTruthful &&
         sc.p4DeathReleases && sc.p5HeldThroughCommit && sc.p6AcquisitionSafe
}

/**
 * THE SELECTION RULE.
 *
 * It is no longer "first accepted candidate". Acceptance only says the server
 * will execute the statement; it says nothing about what the statement does to
 * a value another backend took a moment earlier. So:
 *
 *   1. reject anything the server rejects;
 *   2. reject anything that fails acquisition safety;
 *   3. among candidates that are fully safe, prefer the mechanism that does NOT
 *      restate position.
 *
 * Rule 3 is not a tie-break on taste. A mechanism that never writes a position
 * has no read-then-write interval to be unsafe in, so it cannot regress into
 * the same defect under a future edit.
 */
export function selectSequenceFence(
  scores: Readonly<Partial<Record<SequenceFenceId, CandidateScore>>>,
): SequenceFenceId | null {
  const safe = CANDIDATE_ORDER.filter(id => {
    const sc = scores[id]
    return sc !== undefined && candidateQualifies(sc)
  })
  if (safe.length === 0) return null
  const stable = safe.filter(id => !RESTATES_POSITION[id])
  return (stable.length > 0 ? stable : safe)[0]
}

/**
 * The mechanism this repository uses.
 *
 * SELECTED BY LIVE POSTGRESQL 17 UNDER THE RULE ABOVE, not by preference.
 *
 * S1 and S4 are rejected by the server outright ("cannot lock relation ... not
 * supported for sequences", "cannot lock rows in sequence"). S2 and S3 are both
 * accepted and both pass the five post-acquisition properties - but S2 is
 * defined as "RESTART WITH the current effective next", so the position must be
 * read BEFORE the statement that takes the lock exists. Measured adversarially,
 * a `nextval()` interleaved in that interval is written back over: the value has
 * been handed out, and the fenced state says it has not. S2 therefore FAILS
 * acquisition safety, and an earlier revision of this file was wrong to select
 * it while admitting the window.
 *
 * S3 writes no position at all. `INCREMENT BY <the increment it already has>` is
 * a no-op that exists solely to take the lock, so there is nothing for an
 * interleaved `nextval()` to be overwritten by. It is the selected mechanism.
 */
export const SELECTED_SEQUENCE_FENCE: SequenceFenceId = 'S3'

/**
 * Does the post-acquisition state account for a value already handed out?
 *
 * The question the acquisition-safety property asks, in one place so that a
 * mutation removing the comparison has something to remove. A sequence that has
 * issued `v` must report `is_called` and a position at or beyond `v`; if it
 * reports a position that would hand `v` out again, the fence captured a state
 * the source had already left.
 */
export function reflectsIssuedValue(state: SequenceState, issued: bigint, q: string): boolean {
  const inc = BigInt(state.increment_by)
  const last = BigInt(state.last_value)
  if (!state.is_called) return false
  void q
  return inc > 0n ? last >= issued : last <= issued
}

export function assertNoReissue(state: SequenceState, issued: bigint, q: string): void {
  if (!reflectsIssuedValue(state, issued, q)) {
    throw new FenceRefused(
      `${q} has already handed out ${issued.toString()}, but the fenced state reports ` +
      `last_value=${state.last_value} is_called=${String(state.is_called)}, which would hand it ` +
      'out again. The fence restated a position the source had already left.')
  }
}

// ---------------------------------------------------------------------------
// Acquisition
// ---------------------------------------------------------------------------

export const FENCE_BEGIN_SQL = 'BEGIN'
export const FENCE_LOCK_TIMEOUT_SQL = `SET LOCAL lock_timeout = '${FENCE_LOCK_TIMEOUT_MS}ms'`
export const FENCE_ADVISORY_SQL =
  `SELECT pg_catalog.pg_advisory_xact_lock(${FENCE_ADVISORY_CLASSID}, ${FENCE_ADVISORY_OBJID})`
export const tableFenceSql = (q: string): string => `LOCK TABLE ${assertQName(q)} IN SHARE MODE`

export interface FenceExecutor {
  send(sql: string): Promise<{ rows: string[][]; error: string | null }>
}

/**
 * A sequence state read BEFORE that sequence was fenced.
 *
 * A WRAPPER, NOT AN INTERSECTION. An earlier revision wrote this as
 * `SequenceState & { __unfenced: ... }` and called it a brand. An intersection
 * is a SUBTYPE of `SequenceState`, so `const s: SequenceState = input` compiled
 * cleanly and the barrier stopped nothing. Wrapping puts the state behind a
 * field, so reaching it is a deliberate `.state` a reviewer can see.
 *
 * These values are candidate INPUT - the numbers a mechanism needs in order to
 * build its locking statement - and nothing else. A manifest or a target
 * sequence policy built from them would describe the source as it was at some
 * unfenced moment, which is the thing this slice exists to stop.
 */
export interface UnfencedSequenceInput {
  readonly state: SequenceState
  readonly __unfenced: 'read before the lock; never source-of-truth'
}

export const asUnfencedInput = (state: SequenceState): UnfencedSequenceInput =>
  ({ state, __unfenced: 'read before the lock; never source-of-truth' })

/**
 * The POSITIVE brand: state read after the fence was proved.
 *
 * `unique symbol` is what makes this uncounterfeitable, and the key is
 * MODULE-PRIVATE: it is not exported, so no other module can import or even
 * name it. `FencedSequenceState` is therefore opaque outside this file - a
 * consumer can hold one and read its `SequenceState` fields, but cannot build
 * one structurally without writing an explicit unsafe assertion, which is
 * visible in review. Exporting the key would have handed every caller the
 * ingredient for a counterfeit.
 *
 * The only way to obtain one legitimately is to be handed it by
 * `readFencedSequenceState`, which does not return until an independent backend
 * has proved the whole fence. Later manifest and copier APIs must therefore
 * require THIS type rather than `SequenceState`; that requirement is what makes
 * the gate load-bearing instead of advisory.
 */
declare const FENCED_SEQUENCE_STATE: unique symbol

export type FencedSequenceState = SequenceState & {
  readonly [FENCED_SEQUENCE_STATE]: true
}

export interface AcquiredFence {
  readonly supervisorPid: string
  readonly mechanism: SequenceFenceId
  readonly tables: readonly string[]
  readonly sequences: readonly string[]
  /**
   * NOT fenced state. See `UnfencedSequenceInput`; read the real thing with
   * `readFencedSequenceState`, which will not run until the fence is proved.
   */
  readonly candidateInputs: Readonly<Record<string, UnfencedSequenceInput>>
  /** One entry per statement issued, in order. Never more than one per lock. */
  readonly statements: readonly string[]
}

/**
 * Take the whole fence, once, in the caller's session.
 *
 * There is no loop in this function and no catch that resumes. The first refusal
 * propagates with the statement that caused it, and the caller's transaction is
 * left for the caller to roll back - releasing a partial fence here would race
 * with a caller that wanted to inspect it.
 */
export async function acquireSourceFence(x: FenceExecutor): Promise<AcquiredFence> {
  const statements: string[] = []
  const one = async (sql: string): Promise<string[][]> => {
    statements.push(sql)
    const r = await x.send(sql)
    if (r.error !== null) {
      throw new FenceRefused(`fence statement refused: ${sql}\n${r.error}`)
    }
    return r.rows
  }

  const pidRows = await one('SELECT pg_catalog.pg_backend_pid()')
  const supervisorPid = pidRows[0]?.[0] ?? ''
  if (!/^\d+$/.test(supervisorPid)) {
    throw new FenceRefused(`could not read the supervisor backend pid, got "${supervisorPid}".`)
  }

  await one(FENCE_BEGIN_SQL)
  await one(FENCE_LOCK_TIMEOUT_SQL)
  await one(FENCE_ADVISORY_SQL)

  for (const q of FENCE_TABLES) await one(tableFenceSql(q))

  const candidateInputs: Record<string, UnfencedSequenceInput> = {}
  for (const q of FENCE_SEQUENCES) {
    const input = asUnfencedInput(parseSequenceState(await one(SEQUENCE_STATE_SQL(q)), q))
    candidateInputs[q] = input
    await one(sequenceFenceSql(SELECTED_SEQUENCE_FENCE, q, input.state))
  }

  return {
    supervisorPid,
    mechanism: SELECTED_SEQUENCE_FENCE,
    tables: FENCE_TABLES,
    sequences: FENCE_SEQUENCES,
    candidateInputs,
    statements,
  }
}

// ---------------------------------------------------------------------------
// Proof
// ---------------------------------------------------------------------------

/** Every lock, granted or not, on any reviewed relation or the reviewed key. */
export const FENCE_PROOF_SQL = `
SELECT 'relation', n.nspname || '.' || c.relname, l.mode,
       l.granted::pg_catalog.text, l.pid::pg_catalog.text
  FROM pg_catalog.pg_locks l
  JOIN pg_catalog.pg_class c ON c.oid = l.relation
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
 WHERE l.locktype = 'relation'
   AND n.nspname || '.' || c.relname = ANY ($1)
UNION ALL
SELECT 'advisory', 'advisory', l.mode,
       l.granted::pg_catalog.text, l.pid::pg_catalog.text
  FROM pg_catalog.pg_locks l
 WHERE l.locktype = 'advisory'
   AND l.classid = ${FENCE_ADVISORY_CLASSID} AND l.objid = ${FENCE_ADVISORY_OBJID}
 ORDER BY 1, 2, 5, 3`

/** The `$1` text[] literal: the 21 tables and the three sequences. */
export function fenceRelationArray(): string {
  const all = [...FENCE_TABLES, ...FENCE_SEQUENCES].map(assertQName)
  return `'{${all.map(v => `"${v}"`).join(',')}}'::pg_catalog.text[]`
}

export interface LockRow {
  readonly kind: string
  readonly qname: string
  readonly mode: string
  readonly granted: boolean
  readonly pid: string
}

export function parseLockRows(rows: readonly (readonly string[])[]): LockRow[] {
  return rows.map(r => ({
    kind: r[0], qname: r[1], mode: r[2],
    granted: pgBool(r[3], `${r[1]} ${r[2]} pid ${r[4]} granted`), pid: r[4],
  }))
}

export interface ProofInput {
  readonly supervisorPid: string
  readonly provingPid: string
  readonly mechanism?: SequenceFenceId
}

/**
 * Refuse unless ONE named backend holds the entire reviewed fence and nothing is
 * queued behind it.
 *
 * Fail-closed in both directions: a missing lock is a refusal, and so is a lock
 * that is present but ungranted - a queued writer means the fence was taken
 * after that writer arrived, so the source has been changing.
 */
export function assertFenceProof(rows: readonly LockRow[], input: ProofInput): void {
  const { supervisorPid, provingPid } = input
  const mechanism = input.mechanism ?? SELECTED_SEQUENCE_FENCE
  if (!/^\d+$/.test(supervisorPid)) {
    throw new FenceRefused(`the supervisor pid "${supervisorPid}" is not a backend pid.`)
  }
  if (!/^\d+$/.test(provingPid)) {
    throw new FenceRefused(`the proving pid "${provingPid}" is not a backend pid.`)
  }
  if (supervisorPid === provingPid) {
    throw new FenceRefused(
      `the proof is being taken on the supervisor's own backend (pid ${provingPid}). A session ` +
      'can always see its own locks; only a different backend can show the source is held ' +
      'against anyone else.')
  }
  if (mechanism !== SELECTED_SEQUENCE_FENCE) {
    throw new FenceRefused(
      `the proof names sequence mechanism ${mechanism}, not the selected ${SELECTED_SEQUENCE_FENCE}.`)
  }

  const ungranted = rows.filter(r => !r.granted)
  if (ungranted.length > 0) {
    throw new FenceRefused(
      `${ungranted.length} ungranted lock request(s) on reviewed objects: ` +
      `${ungranted.map(r => `${r.qname} ${r.mode} pid ${r.pid}`).join('; ')}. ` +
      'Something is queued for the source, so the source is not still.')
  }

  const held = (qname: string, mode: string): boolean =>
    rows.some(r => r.qname === qname && r.mode === mode && r.granted && r.pid === supervisorPid)

  if (!rows.some(r => r.kind === 'advisory' && r.granted && r.pid === supervisorPid)) {
    throw new FenceRefused(
      `pid ${supervisorPid} does not hold the reviewed advisory lock ` +
      `(${FENCE_ADVISORY_CLASSID}, ${FENCE_ADVISORY_OBJID}).`)
  }

  const missingTables = FENCE_TABLES.filter(q => !held(q, FENCE_TABLE_LOCK_MODE))
  if (missingTables.length > 0) {
    throw new FenceRefused(
      `pid ${supervisorPid} does not hold ${FENCE_TABLE_LOCK_MODE} on ` +
      `${missingTables.length} reviewed table(s): ${missingTables.join(', ')}.`)
  }

  const missingSequences = FENCE_SEQUENCES.filter(q => !held(q, FENCE_SEQUENCE_LOCK_MODE))
  if (missingSequences.length > 0) {
    throw new FenceRefused(
      `pid ${supervisorPid} does not hold ${FENCE_SEQUENCE_LOCK_MODE} (mechanism ` +
      `${SELECTED_SEQUENCE_FENCE}) on ${missingSequences.length} reviewed sequence(s): ` +
      `${missingSequences.join(', ')}.`)
  }
}

// ---------------------------------------------------------------------------
// The only sequence state later slices may use
// ---------------------------------------------------------------------------

/**
 * Read sequence state AFTER the whole fence is held and independently proved.
 *
 * ORDER IS THE GUARANTEE, so the order is enforced here rather than documented
 * and hoped for. This function takes the proving executor as an argument and
 * runs the proof itself; there is no way to reach the read without the proof
 * having just succeeded on a different backend, and it is the ONLY place a
 * `FencedSequenceState` is constructed.
 *
 * WHAT THIS DOES AND DOES NOT GUARANTEE, exactly. `SEQUENCE_STATE_SQL` is a
 * string and `parseSequenceState` returns an ordinary `SequenceState`; neither
 * is prevented, and neither is branded. The guarantee is on the CONSUMING side:
 * candidate inputs are wrapped and visibly unsafe, later manifest and copier
 * APIs must require `FencedSequenceState`, and only this function can produce
 * one.
 *
 * The fields come from the sequence relation (`last_value`, `is_called`),
 * `pg_catalog.pg_sequence` (every option) and `pg_depend` (ownership) - never
 * from `pg_sequences`, which calls `pg_sequence_last_value()` and so takes the
 * very lock the fence holds.
 */
export async function readFencedSequenceState(
  supervisor: FenceExecutor,
  prover: FenceExecutor,
  fence: AcquiredFence,
): Promise<Record<string, FencedSequenceState>> {
  const pidRes = await prover.send('SELECT pg_catalog.pg_backend_pid()')
  if (pidRes.error !== null) {
    throw new FenceRefused(`the proving backend could not report its pid: ${pidRes.error}`)
  }
  const provingPid = pidRes.rows[0]?.[0] ?? ''

  const proofRes = await prover.send(FENCE_PROOF_SQL.replace('$1', fenceRelationArray()))
  if (proofRes.error !== null) {
    throw new FenceRefused(`the fence proof could not be taken: ${proofRes.error}`)
  }
  assertFenceProof(parseLockRows(proofRes.rows), {
    supervisorPid: fence.supervisorPid,
    provingPid,
    mechanism: fence.mechanism,
  })

  const out: Record<string, FencedSequenceState> = {}
  for (const q of FENCE_SEQUENCES) {
    const res = await supervisor.send(SEQUENCE_STATE_SQL(q))
    if (res.error !== null) {
      throw new FenceRefused(`fenced state read refused for ${q}: ${res.error}`)
    }
    // The one place the brand is applied, immediately after the proof above.
    out[q] = parseSequenceState(res.rows, q) as FencedSequenceState
  }
  return out
}
