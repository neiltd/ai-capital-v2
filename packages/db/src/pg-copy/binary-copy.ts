// Stream ONE reviewed table from a source backend to a target backend in
// PostgreSQL's binary COPY format.
//
// WHY BINARY AND NOT TEXT. Text COPY renders every value through an output
// function and parses it back through an input function. For `numeric` that
// round trip is lossy in a way that matters here: 1.10 and 1.1 are equal under
// `=` but carry different scales, and a text round trip can silently normalise
// one into the other. Binary COPY moves the value's own `*_send()` bytes, so
// what lands in the target is what left the source - which is also what the
// Slice-1 content digest hashes, so the copy and its proof agree by
// construction rather than by hope.
//
// WHY IT OWNS NO TRANSACTION AND NO CONNECTION. The source is read inside a
// fenced READ ONLY REPEATABLE READ snapshot that the supervisor set up, and the
// target transaction spans far more than one table. A primitive that opened its
// own connection would read outside the fence; one that committed would end the
// caller's transaction at the end of the FIRST table. So it is handed two
// already-connected sessions, and it sends no BEGIN, no COMMIT and no ROLLBACK.
//
// WHY IT STREAMS. A table has to fit through the process, not into it.
// `pipeline` connects the source's COPY TO output to the target's COPY FROM
// input and lets Node's backpressure decide the pace; nothing accumulates a
// whole table in memory, and nothing here ever sees a row value.

import { pipeline } from 'node:stream/promises'

import { from as copyFrom, to as copyTo } from 'pg-copy-streams'
// Type-only: this module never constructs a client, and the canonical
// connection module stays the only place that can.
import type { ClientBase } from 'pg'

import { COPY_TABLES, tableCopySpec, type ContractArtifact, type TableCopySpec } from './schema-contract.js'

export class BinaryCopyRefused extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BinaryCopyRefused'
  }
}

/** Why a copy stopped. Two values, and nothing derived from the failure itself. */
export type BinaryCopyPhase = 'stream-failed' | 'cancelled'

/**
 * A copy failure, deliberately uninformative.
 *
 * WHY THE ORIGINAL ERROR IS DISCARDED. PostgreSQL reports a COPY failure with
 * the offending ROW in `detail` - "Failing row contains (...)" - and the driver
 * hands that back with `message`, `detail`, `where`, `query` and more. Every one
 * of those is source data on its way into a log. Nothing about the failure needs
 * row values to be actionable: the table, whether it broke or was cancelled, and
 * the instruction to discard the session are the whole of what a caller can act
 * on. The original is not attached as `cause` either - `cause` is serialized by
 * `util.inspect` and by most log formatters, so attaching it would leak
 * everything this class exists to withhold.
 */
export class BinaryCopyFailed extends Error {
  constructor(readonly qname: string, readonly phase: BinaryCopyPhase) {
    super(
      `binary copy of ${qname} ${phase === 'cancelled' ? 'was cancelled' : 'failed'}. ` +
      'Discard the target transaction and both sessions. Nothing further is ' +
      'retained: a failure of this kind names the offending row.')
    this.name = 'BinaryCopyFailed'
  }
}

/** A bare, lower-case SQL identifier. Anything else is refused, never quoted. */
const IDENT = /^[a-z_][a-z0-9_]*$/

export function assertCopyIdentifier(kind: string, value: string): string {
  if (!IDENT.test(value)) {
    throw new BinaryCopyRefused(
      `${kind} "${value}" is not a bare identifier; this module never interpolates anything else.`)
  }
  return value
}

/**
 * The table must be one of the reviewed 21, by exact qualified name.
 *
 * Checked against the one copy-set authority rather than re-listed, so a table
 * added to the copy set cannot be missing here and a table removed from it
 * cannot still be streamable.
 */
export function assertReviewedTable(qname: string): { schema: string; table: string } {
  if (!COPY_TABLES.includes(qname)) {
    throw new BinaryCopyRefused(`${qname} is not in the reviewed copy set.`)
  }
  const [schema, table] = qname.split('.')
  assertCopyIdentifier('schema', schema)
  assertCopyIdentifier('table', table)
  return { schema, table }
}

/**
 * The ordered live columns, exactly as the schema contract records them.
 *
 * Binary COPY carries no column names - only a tuple of values in the order the
 * COPY statement named them. So the two statements must name the SAME columns in
 * the SAME order, and the order has to come from the contract rather than from
 * whatever `SELECT *` would have produced today.
 */
export function assertCopyColumns(qname: string, columns: readonly string[]): readonly string[] {
  if (columns.length === 0) {
    throw new BinaryCopyRefused(`${qname} was given no columns to copy.`)
  }
  const seen = new Set<string>()
  for (const c of columns) {
    assertCopyIdentifier('column', c)
    if (seen.has(c)) {
      throw new BinaryCopyRefused(`${qname} column "${c}" appears more than once.`)
    }
    seen.add(c)
  }
  return columns
}

const columnList = (columns: readonly string[]): string => columns.join(', ')

/** `COPY <table> (<columns>) TO STDOUT (FORMAT BINARY)` */
export function copyOutSql(qname: string, columns: readonly string[]): string {
  assertReviewedTable(qname)
  assertCopyColumns(qname, columns)
  return `COPY ${qname} (${columnList(columns)}) TO STDOUT (FORMAT BINARY)`
}

/** `COPY <table> (<columns>) FROM STDIN (FORMAT BINARY)` */
export function copyInSql(qname: string, columns: readonly string[]): string {
  assertReviewedTable(qname)
  assertCopyColumns(qname, columns)
  return `COPY ${qname} (${columnList(columns)}) FROM STDIN (FORMAT BINARY)`
}

export interface BinaryCopyRequest {
  /**
   * The VERIFIED contract this copy is bound to.
   *
   * Not a column list: a caller-supplied list is a second authority on the
   * table's shape, and binary COPY has no column names on the wire to catch it
   * drifting. The columns are derived from this artifact, whose digest is
   * recomputed before any name is read from it.
   */
  readonly artifact: ContractArtifact
  readonly qname: string
  readonly signal?: AbortSignal
}

/**
 * What the caller may know afterwards.
 *
 * Deliberately narrow: the table, the two statements, and byte/row counts the
 * drivers report. No row values, no connection strings, nothing that could carry
 * a credential into a log.
 */
export interface BinaryCopyResult {
  readonly qname: string
  readonly columns: readonly string[]
  readonly bytes: number
  readonly rowCount: number | null
  readonly sourceSql: string
  readonly targetSql: string
}

/**
 * Stream one reviewed table from `source` to `target`.
 *
 * Both sessions must already be inside the transactions the caller wants; this
 * function begins and ends neither. On any failure - source, target or
 * cancellation - the promise rejects and the target's COPY is failed rather than
 * completed, so the caller's transaction is left in the aborted state that makes
 * a later COMMIT impossible to mistake for success.
 */
export async function copyTableBinary(
  source: ClientBase, target: ClientBase, request: BinaryCopyRequest,
): Promise<BinaryCopyResult> {
  const { artifact, qname, signal } = request
  // DERIVED BEFORE EITHER SESSION IS TOUCHED. A refusal here must cost nothing:
  // no COPY has started, so there is no transaction to discard.
  const spec: TableCopySpec = tableCopySpec(artifact, qname)
  const columns = spec.columns
  assertReviewedTable(spec.qname)
  assertCopyColumns(spec.qname, columns)

  // ONE specification, both statements.
  const sourceSql = copyOutSql(spec.qname, columns)
  const targetSql = copyInSql(spec.qname, columns)

  // The SAME captured sessions throughout. There is no branch that opens
  // another one, and no connection parameter to open one with.
  const outStream = source.query(copyTo(sourceSql))
  const inStream = target.query(copyFrom(targetSql))

  // LATE-ERROR SINKS, attached before anything can fail.
  //
  // Destroying an in-flight COPY terminates its connection, and pg then pushes
  // "Connection terminated" into whatever query was active - which is one of
  // these streams, now detached from `pipeline` and carrying no listener of its
  // own. A stream that emits `error` with no listener throws, so without these
  // the caller gets a rejected promise AND, a moment later, an uncaught
  // exception that takes the process down. The failure has already been
  // reported; this second, asynchronous notice is absorbed. `pipeline` attaches
  // its own listeners regardless, so nothing is hidden from it.
  outStream.on('error', () => { /* reported through the pipeline */ })
  inStream.on('error', () => { /* reported through the pipeline */ })

  let bytes = 0
  outStream.on('data', (chunk: Buffer) => { bytes += chunk.length })

  try {
    // `pipeline` wires backpressure, forwards errors in BOTH directions and
    // destroys the other side when one fails - which is what turns a source
    // failure into a CopyFail on the target rather than a truncated but
    // "successful" COPY.
    await pipeline(outStream, inStream, signal === undefined ? {} : { signal })
  } catch {
    // Destroy both ends so neither COPY is left running in the background, then
    // raise a REDACTED failure. No COMMIT is issued here, or anywhere in this
    // module, and the original error is not re-raised, wrapped or attached.
    //
    // A CONSEQUENCE THE CALLER MUST KNOW. Destroying an in-flight COPY stream
    // terminates the connection it was running on - there is no protocol-level
    // way to abandon a COPY mid-flight and keep the session. So after this
    // throws, the affected client is finished: it will emit `error`
    // ("Connection terminated"), and a caller without a listener on it gets an
    // unhandled exception rather than a failed copy. The session is not reusable
    // and must be closed. The TARGET keeps its connection when the failure came
    // from the server, which is why its transaction can still be observed to be
    // aborted rather than committed.
    outStream.destroy()
    inStream.destroy()
    // The phase comes from the AbortSignal, not from the error text: deciding
    // "was this a cancellation" by matching on a message would mean reading the
    // very string this class refuses to keep.
    throw new BinaryCopyFailed(
      spec.qname, signal !== undefined && signal.aborted ? 'cancelled' : 'stream-failed')
  }

  const rowCount = typeof (inStream as { rowCount?: unknown }).rowCount === 'number'
    ? (inStream as unknown as { rowCount: number }).rowCount
    : null

  return { qname: spec.qname, columns, bytes, rowCount, sourceSql, targetSql }
}
