// WHAT THE TARGET MUST BE, PROVED BEFORE A SINGLE ROW MOVES.
//
// Stage 2 writes into a database it did not build, named on a command line, at
// the end of a chain of assumptions any one of which could be wrong. The
// assumptions are therefore not assumed: each is a statement the target itself
// has to answer, and the answers are checked before the first COPY.
//
// THE FOUR QUESTIONS, AND WHY EACH IS ASKED SEPARATELY.
//
//   AM I ON THE RIGHT CLUSTER? The `system_identifier` from pg_control, exactly
//   as Stage 1 asks it of the source. A host, a port and a database name can
//   all be repointed without changing a character of the command line. (What it
//   identifies is LINEAGE, not a running server - a copy or a restore of a
//   PGDATA carries its origin's - which is why it is one of four questions and
//   not the only one.)
//
//   AM I THE RIGHT PRINCIPAL? Both `CURRENT_USER` and `SESSION_USER`, because
//   they differ after `SET ROLE` and a session that authenticated as something
//   else is not the authority this copy claims to run under.
//
//   IS THE SCHEMA THE ONE THAT WAS REVIEWED? The migration ledger must say
//   CURRENT_V19 over exactly 19 entries. This is deliberately NOT the whole of
//   C2 - C2 compares the entire extracted contract with the committed artifact
//   - but a ledger that disagrees is worth refusing before the expensive check.
//
//   IS IT EMPTY? All 21 tables at zero rows and all three sequences never
//   called. A copy into a non-empty target is not a copy, it is a merge, and
//   nothing downstream - not the digests, not the sequence policy - means what
//   it says if rows were already there.
//
// EMPTINESS IS PROVED IN ONE STATEMENT. Twenty-one separate counts are
// twenty-one moments; inside one transaction that hardly matters, but a single
// UNION ALL also makes "all 21 were asked about" a property of the statement
// rather than of a loop that could be given a shorter list.

import {
  COPY_TABLES, EXPECTED_MIGRATION_COUNT, EXPECTED_MIGRATION_RECOGNITION,
  type Canonical, type ContractArtifact,
} from './schema-contract.js'
import {
  FENCE_SEQUENCES, SEQUENCE_STATE_SQL, assertQName, parseSequenceState, pgBool,
  type SequenceState,
} from './source-fence.js'

/** The role the copy runs as, assumed for the transaction and never beyond it. */
export const TARGET_OWNER_ROLE = 'ai_capital_owner'

/**
 * The target transaction, and the role it runs under.
 *
 * READ WRITE by necessity and DEFAULT isolation by choice: the target is empty
 * and this is the only writer, so a stricter level would buy nothing. `SET
 * LOCAL` rather than `SET`, so the assumed role ends with the transaction -
 * including when it ends by ROLLBACK.
 */
export const TARGET_BEGIN_SQL = 'BEGIN'
export const SET_LOCAL_ROLE_SQL = `SET LOCAL ROLE ${TARGET_OWNER_ROLE}`
export const TARGET_COMMIT_SQL = 'COMMIT'
export const TARGET_ROLLBACK_SQL = 'ROLLBACK'

/** The same six-plus-five facts Stage 1 asks of the source, asked of the target. */
export const TARGET_IDENTITY_SQL = `
SELECT pg_catalog.pg_backend_pid()::pg_catalog.text,
       (pg_catalog.pg_control_system()).system_identifier::pg_catalog.text,
       pg_catalog.current_setting('server_version_num'),
       pg_catalog.current_database(),
       pg_catalog.current_setting('port'),
       CURRENT_USER::pg_catalog.text,
       SESSION_USER::pg_catalog.text,
       COALESCE(pg_catalog.inet_server_addr()::pg_catalog.text, ''),
       (pg_catalog.inet_server_addr() IS NULL)::pg_catalog.text`

export const TARGET_IDENTITY_COLUMNS = 9

/** One statement, twenty-one counts, in the reviewed order. */
export const TARGET_EMPTY_SQL: string = COPY_TABLES
  .map(q => `SELECT '${assertQName(q)}'::pg_catalog.text, ` +
            `pg_catalog.count(*)::pg_catalog.text FROM ${q}`)
  .join('\nUNION ALL\n')

export type TargetPhase =
  | 'identity'
  | 'ledger'
  | 'contract'
  | 'emptiness'
  | 'sequences'

/** WHY the target was refused. A CLOSED union. */
export type TargetReason =
  | 'the target session did not report one row of identity facts'
  | 'the target session is not the backend it reported'
  | 'the target is not the expected target cluster'
  | 'the target did not report a usable system identifier'
  | 'the target is not the expected database'
  | 'the target is not on the expected port'
  | 'the target session is not authenticated as the expected role'
  | 'the target session assumed a role it did not authenticate as'
  | 'the target does not recognise the reviewed migration set'
  | 'the target schema is not the reviewed expected-target contract'
  | 'the target did not report one count for each reviewed table'
  | 'a reviewed target table is not empty'
  | 'a reviewed target sequence has already been called'
  | 'a reviewed target sequence is not at its start value'
  | 'the target sequence state could not be read'

export class TargetRefused extends Error {
  constructor(
    readonly phase: TargetPhase,
    readonly reason: TargetReason,
    readonly qname: string | null = null,
  ) {
    super(`${reason} (phase ${phase}${qname === null ? '' : ` for ${qname}`})`)
    this.name = 'TargetRefused'
  }
}

/** The minimum a target session must be able to do. */
export interface TargetSession {
  readonly pid: string
  rows(sql: string): Promise<string[][]>
}

export interface TargetExpectation {
  readonly systemIdentifier: string
  readonly database: string
  readonly port: string
  readonly role: string
  /**
   * The host or socket directory this process ASKED for.
   *
   * Recorded and bound into the confirmation, never compared against something
   * the server reported: PostgreSQL does not report a socket directory, and
   * pretending otherwise is the mistake Stage 1 already corrected once.
   */
  readonly endpoint: string
}

export interface TargetIdentity {
  readonly pid: string
  readonly systemIdentifier: string
  readonly serverVersionNum: string
  readonly database: string
  readonly port: string
  readonly currentUser: string
  readonly sessionUser: string
  readonly serverAddress: string | null
  readonly unixTransport: boolean
}

const SYSTEM_IDENTIFIER = /^[1-9][0-9]{0,19}$/
const UINT64_LIMIT = 18446744073709551616n

export async function proveTargetIdentity(
  s: TargetSession, expected: TargetExpectation,
): Promise<TargetIdentity> {
  const rows = await s.rows(TARGET_IDENTITY_SQL)
  if (rows.length !== 1 || rows[0].length !== TARGET_IDENTITY_COLUMNS) {
    throw new TargetRefused(
      'identity', 'the target session did not report one row of identity facts')
  }
  const [pid, systemIdentifier, serverVersionNum, database, port,
         currentUser, sessionUser, address, unix] = rows[0]
  if (!/^\d+$/.test(pid) || pid !== s.pid) {
    throw new TargetRefused('identity', 'the target session is not the backend it reported')
  }
  if (!SYSTEM_IDENTIFIER.test(systemIdentifier) || BigInt(systemIdentifier) >= UINT64_LIMIT) {
    throw new TargetRefused('identity', 'the target did not report a usable system identifier')
  }
  // THE ANCHOR FIRST, for the same reason as on the source: a matching database
  // name on the wrong cluster is exactly the mistake this catches.
  if (systemIdentifier !== expected.systemIdentifier) {
    throw new TargetRefused('identity', 'the target is not the expected target cluster')
  }
  if (database !== expected.database) {
    throw new TargetRefused('identity', 'the target is not the expected database')
  }
  if (port !== expected.port) {
    throw new TargetRefused('identity', 'the target is not on the expected port')
  }
  if (currentUser !== expected.role) {
    throw new TargetRefused(
      'identity', 'the target session is not authenticated as the expected role')
  }
  if (sessionUser !== currentUser) {
    throw new TargetRefused(
      'identity', 'the target session assumed a role it did not authenticate as')
  }
  return Object.freeze({
    pid, systemIdentifier, serverVersionNum, database, port, currentUser, sessionUser,
    serverAddress: address === '' ? null : address,
    unixTransport: pgBool(unix, 'inet_server_addr() IS NULL'),
  })
}

/**
 * The migration ledger says CURRENT_V19 over exactly nineteen entries.
 *
 * Read out of the EXTRACTED contract rather than by a query of its own, so this
 * and C2 are looking at one extraction and cannot disagree about it.
 */
export function assertTargetLedger(artifact: ContractArtifact): void {
  const m = (artifact.payload as unknown as {
    migrations?: { recognition?: unknown; count?: unknown }
  }).migrations
  if (m?.recognition !== EXPECTED_MIGRATION_RECOGNITION ||
      m?.count !== EXPECTED_MIGRATION_COUNT) {
    throw new TargetRefused('ledger', 'the target does not recognise the reviewed migration set')
  }
}

/**
 * C2: the live target schema IS the committed expected-target artifact.
 *
 * Compared by DIGEST, and the digest is the one the extractor computed from the
 * live catalogue - so this is a comparison of two independently derived values,
 * not a file being checked against itself.
 */
export function assertTargetContract(
  live: ContractArtifact, committedDigest: string,
): void {
  if (live.digest !== committedDigest) {
    throw new TargetRefused(
      'contract', 'the target schema is not the reviewed expected-target contract')
  }
}

/** All 21 reviewed tables, all at zero rows, proved in one statement. */
export async function proveTargetEmpty(s: TargetSession): Promise<void> {
  const rows = await s.rows(TARGET_EMPTY_SQL)
  if (rows.length !== COPY_TABLES.length) {
    throw new TargetRefused(
      'emptiness', 'the target did not report one count for each reviewed table')
  }
  const seen = new Map(rows.map(r => [r[0], r[1]]))
  for (const q of COPY_TABLES) {
    const count = seen.get(q)
    if (count === undefined) {
      throw new TargetRefused(
        'emptiness', 'the target did not report one count for each reviewed table', q)
    }
    if (count !== '0') {
      // The COUNT is not reported: it is target content, and the only thing a
      // caller can act on is which table was not empty.
      throw new TargetRefused('emptiness', 'a reviewed target table is not empty', q)
    }
  }
}

/** All three reviewed sequences, never called, still at their start value. */
export async function proveTargetSequencesPristine(
  s: TargetSession,
): Promise<Record<string, SequenceState>> {
  const out: Record<string, SequenceState> = {}
  for (const q of FENCE_SEQUENCES) {
    let state: SequenceState
    try {
      state = parseSequenceState(await s.rows(SEQUENCE_STATE_SQL(q)), q)
    } catch {
      throw new TargetRefused('sequences', 'the target sequence state could not be read', q)
    }
    if (state.is_called) {
      throw new TargetRefused(
        'sequences', 'a reviewed target sequence has already been called', q)
    }
    if (state.last_value !== state.start_value) {
      throw new TargetRefused(
        'sequences', 'a reviewed target sequence is not at its start value', q)
    }
    out[q] = state
  }
  return out
}

/** Re-exported so an orchestrator never has to name the payload shape itself. */
export type { Canonical }
