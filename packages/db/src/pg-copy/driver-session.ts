// A DRIVER-BACKED SESSION — the one transport Stage 2 can do all of its work on.
//
// WHY STAGE 2 CANNOT USE THE psql TRANSPORT FOR THE SOURCE. Stage 1 derives its
// manifest through psql, which is fine: it only ever reads. Stage 2 must derive
// the SAME digests and then binary-COPY the SAME bytes, and `copyTableBinary`
// needs a `pg` client because binary COPY is a protocol-level stream. If the
// derivation ran on psql and the COPY on a driver client, they would be two
// connections, two transactions and therefore TWO SNAPSHOTS - and the bytes
// that were digested would not be provably the bytes that were copied. The
// whole point of a content digest is lost the moment that stops being true.
//
// SO ONE CLIENT DOES BOTH. This module adapts a driver client to the
// `{ pid, rows(sql) }` shape the reviewed derivation primitives ask for, which
// lets one `READ ONLY REPEATABLE READ` transaction carry the contract
// extraction, the 21 table digests AND every `COPY ... TO STDOUT`.
//
// THE ADAPTER IS EXACT, AND THAT WAS MEASURED, NOT ASSUMED. Against a V19
// database the driver-backed executor produced byte-identical values to the
// psql-backed one: the same contract digest (which is also the committed
// `REVIEWED_CONTRACT_DIGEST`) and the same table digests. Two details make it
// exact rather than approximate:
//
//   NULL RENDERS AS THE EMPTY STRING, because that is what `psql -t -A` does
//   and what the reviewed parsers were written against - `orNull(v)` treats ''
//   as NULL. psql cannot distinguish a NULL from an empty string either, so
//   mapping the driver's `null` to '' reproduces its behaviour exactly rather
//   than improving on it. Improving on it here would change digests.
//
//   EVERY VALUE BECOMES A STRING. The contract SQL casts to `::pg_catalog.text`
//   almost everywhere, but not quite everywhere - `atttypmod` is an int4 and
//   arrives as a JS number. `String()` puts the driver back on psql's footing.
//
// NOTHING POSTGRESQL SAID CROSSES THIS BOUNDARY. A driver error carries
// `message`, `detail`, `where`, `query`, `table` and `column`; for a failed
// COPY, `detail` is literally "Failing row contains (...)". Every one of those
// is source data on its way into a log, so this module raises its own closed
// union and attaches nothing - no cause, no query, no tag.

import type { ClientBase, Client } from 'pg'

import { createClientFromConfig } from '../pool.js'

/** WHY a driver session refused. A CLOSED union of reviewed sentences. */
export type DriverReason =
  | 'the session could not be opened'
  | 'the session could not report its backend pid'
  | 'the session did not report a backend pid'
  | 'the session refused a statement'
  | 'the session could not be closed'

export class DriverSessionRefused extends Error {
  constructor(readonly reason: DriverReason) {
    super(reason)
    this.name = 'DriverSessionRefused'
  }
}

/**
 * How a statement ENDED, as PostgreSQL's own command tag.
 *
 * Needed for exactly one statement in this repository. `COMMIT` issued on an
 * ALREADY-ABORTED transaction does not raise: PostgreSQL rolls back and
 * replies with the tag `ROLLBACK`. A caller that only checked for the absence
 * of an exception would record a commit that never happened, so the tag is
 * returned and the caller is made to look at it.
 */
export interface CommandOutcome {
  readonly tag: string
  readonly rows: string[][]
}

export interface DriverSession {
  readonly pid: string
  /**
   * The raw client, for `copyTableBinary` and NOTHING else.
   *
   * Exposed because binary COPY is a protocol-level stream that cannot be
   * expressed through `rows()`. It is deliberately not used for statements
   * anywhere in Stage 2: those go through `rows` or `command`, which is what
   * keeps the error boundary in one place.
   */
  readonly client: ClientBase
  /** `ContractQueryExecutor` / `TargetSessionExecutor`: psql-shaped results. */
  rows(sql: string): Promise<string[][]>
  /** As `rows`, but also returning the command tag. */
  command(sql: string): Promise<CommandOutcome>
  end(): Promise<void>
  alive(): boolean
}

/**
 * Where to connect, and how the secret gets there.
 *
 * THE PASSWORD IS A FIELD, NEVER A URL AND NEVER THE ENVIRONMENT. node-postgres
 * has no `.pgpass` support, so the reviewed `PGPASSFILE` discipline that the
 * psql transport uses is simply not available here. What IS available is the
 * next best thing and is what this takes: the caller reads the secret out of
 * the reviewed 0600 credential file into process memory and hands it over as a
 * field. It never reaches argv, never reaches the child environment, and never
 * appears in a connection string that could be logged whole.
 */
export interface DriverTarget {
  readonly host: string
  readonly port: number
  readonly database: string
  readonly user: string
  readonly password?: string
}

/** psql's rendering of a result set, reproduced exactly. See the header. */
export function psqlShape(rows: readonly unknown[][]): string[][] {
  return rows.map(row => row.map(v => (v === null || v === undefined ? '' : String(v))))
}

/**
 * How a client is CONSTRUCTED. A seam, and the only one.
 *
 * Production always uses `reviewedClientFactory`, which goes through the
 * canonical factory. It is injectable for one reason: the claim "this session
 * issues no SQL before BEGIN" can only be checked at the query boundary of the
 * real client, and a recorder wrapped around an already-opened session is
 * attached too late to see the statement it is looking for. That is not a
 * hypothetical - the first version of this module ran a `pg_backend_pid()`
 * SELECT inside its own opener, and the integration recorder could not see it.
 */
export type ClientFactory = (t: DriverTarget) => Client

export const reviewedClientFactory: ClientFactory = (t: DriverTarget): Client =>
  // Through the canonical factory, which is the only place in this repository
  // allowed to construct one, and which refuses a protected destination.
  createClientFromConfig({
    host: t.host,
    port: t.port,
    database: t.database,
    user: t.user,
    ...(t.password === undefined ? {} : { password: t.password }),
  })

/**
 * WHERE THE BACKEND PID COMES FROM. The only thing the two openers disagree on.
 *
 *   `query`    ask the server: `SELECT pg_catalog.pg_backend_pid()`. One
 *              statement, before any transaction. What Stage 2 has always done.
 *
 *   `protocol` read BackendKeyData, which PostgreSQL sends during startup and
 *              the driver records. Costs NO statement.
 *
 * WHY THE SECOND ONE EXISTS. A pid SELECT is harmless for Stage 2: it runs
 * before the transaction, and the transaction that follows still sees one
 * snapshot. It is NOT harmless for the verifier, whose whole claim is that the
 * transaction it measures in began before it looked at anything - a SELECT
 * issued first runs in its own implicit transaction, in a snapshot nobody
 * afterwards can account for.
 *
 * NEITHER POLICY IS TRUSTED ON ITS OWN. Whatever this returns is a claim until
 * the caller's own identity statement asks the server, inside its transaction,
 * which backend it actually is - `extractContractFromSession` and the
 * verifier's `VERIFY_IDENTITY_SQL` both refuse when the two disagree. The
 * protocol policy moves that check to where it can be made without spending a
 * statement first; it does not weaken it.
 */
export type PidPolicy = 'query' | 'protocol'

export const BACKEND_PID_SQL = 'SELECT pg_catalog.pg_backend_pid()::pg_catalog.text'

/**
 * THE ONE BUILDER. Both public openers are this function with one argument
 * changed, so connection handling, reaping, the error boundary and the session
 * shape exist once and cannot drift between them.
 */
async function openSession(
  t: DriverTarget, make: ClientFactory, policy: PidPolicy,
): Promise<DriverSession> {
  const client: Client = make(t)

  let ended = false
  const reap = async (): Promise<void> => {
    if (ended) return
    ended = true
    try { await client.end() } catch { /* bounded: nothing to report */ }
  }

  const run = async (sql: string): Promise<CommandOutcome> => {
    if (ended) throw new DriverSessionRefused('the session refused a statement')
    try {
      const r = await client.query({ text: sql, rowMode: 'array' })
      return { tag: String(r.command ?? ''), rows: psqlShape(r.rows as unknown[][]) }
    } catch {
      throw new DriverSessionRefused('the session refused a statement')
    }
  }

  try {
    await client.connect()
  } catch {
    // A connection failure names the host, the user and sometimes the
    // authentication method. None of it travels.
    await reap()
    throw new DriverSessionRefused('the session could not be opened')
  }

  let pid = ''
  if (policy === 'query') {
    try {
      pid = (await run(BACKEND_PID_SQL)).rows[0]?.[0] ?? ''
    } catch {
      // EVERY failure between connect and a usable session reaps the client
      // first. An unreaped one is a live backend nobody holds a handle to.
      await reap()
      throw new DriverSessionRefused('the session could not report its backend pid')
    }
  } else {
    // `processID` is absent from the published typings, so it is read
    // defensively and validated rather than asserted into existence.
    const raw = (client as unknown as { processID?: unknown }).processID
    pid = typeof raw === 'number' || typeof raw === 'string' ? String(raw) : ''
  }
  if (!/^\d+$/.test(pid)) {
    await reap()
    throw new DriverSessionRefused('the session did not report a backend pid')
  }

  return Object.freeze({
    pid,
    client,
    rows: async (sql: string): Promise<string[][]> => (await run(sql)).rows,
    command: run,
    end: reap,
    alive: () => !ended,
  })
}

/** The Stage-2 session. Asks the server for its pid, before any transaction. */
export async function openDriverSession(t: DriverTarget): Promise<DriverSession> {
  return await openSession(t, reviewedClientFactory, 'query')
}

/**
 * The VERIFIER session: no SQL of any kind before the caller's first statement.
 *
 * `make` is injectable for one reason: the claim "this session issues nothing
 * before BEGIN" can only be checked at the query boundary of the real client,
 * and a recorder wrapped around an already-opened session is attached too late
 * to see the statement it is looking for.
 */
export async function openSilentDriverSession(
  t: DriverTarget, make: ClientFactory = reviewedClientFactory,
): Promise<DriverSession> {
  return await openSession(t, make, 'protocol')
}
