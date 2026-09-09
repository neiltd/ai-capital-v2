// INTEGRATION PREFLIGHT AND PROVISIONING — the ordered, injectable core.
//
// WHY THIS FILE EXISTS. Round 1 put these rules in global-setup.ts and proved
// them with regexes over the source. That was not enough: a source regex sees
// that a check is PRESENT, not that it RUNS BEFORE the first mutation. The
// checks here take their clients as parameters, so a test can hand in a fake
// that records every call and assert the ORDER — including that nothing
// mutating happens until every credential, endpoint and privilege rule passed.
//
// Nothing in this file connects on its own. `provision()` receives its client
// factories, so the database-free suite exercises the whole state machine with
// no PostgreSQL anywhere.
import { parse as parseConnectionString } from 'pg-connection-string'
import { liveDatabaseNames, databaseNameOfRaw } from '../src/pool.js'

export class PreflightError extends Error {
  constructor(message: string) {
    super(
      `[test-db] ${message}\n` +
      '        Tests are stopping rather than continuing without a safe database. ' +
      'They will NOT fall back to DATABASE_URL.',
    )
    this.name = 'PreflightError'
  }
}
export function refuse(message: string): never { throw new PreflightError(message) }

/** The one role ordinary integration tests may authenticate as. */
export const RUNTIME_ROLE = 'ai_capital_test_runtime'

/** Roles ops/roles/000_cluster_roles.sql creates — a CLUSTER prerequisite. */
export const REQUIRED_CLUSTER_ROLES = [
  'ai_capital_owner', 'ai_capital_identity_authority', 'ai_capital_migrator',
  'ai_capital_app', 'ai_capital_importer', 'ai_capital_agent', 'ai_capital_operator',
] as const

/** Privileged roles the runtime principal must not be able to become. */
export const PRIVILEGED_ROLES = [
  'ai_capital_owner', 'ai_capital_identity_authority', 'ai_capital_migrator',
] as const

// ─────────────────────────────────────────────────────────────────────────────
// Disposable-target policy
// ─────────────────────────────────────────────────────────────────────────────

/** Maintenance databases: catastrophic to migrate, and easy to reach by accident. */
export const MAINTENANCE_DATABASES = ['postgres', 'template0', 'template1'] as const

/**
 * The EXACT set of databases this harness may create, migrate or test against.
 *
 * ROUND 10. This used to be a suffix rule — "any lower-case identifier ending
 * in `_test`" — described in the source as an allowlist. It was not one:
 * `customer_test`, `unrelated_test`, `scratch_test` and `x_test` all passed,
 * and any of them could name a real database belonging to someone else that
 * this harness would then DROP objects into and migrate. A suffix is a naming
 * convention; it is not authorization.
 *
 * THIS PACKAGE OWNS THIS ALLOWLIST. It is NOT stated once for the whole
 * repository: `packages/investment-ledger/tests/integration/support.ts` declares
 * its own `ALLOWED_TEST_DATABASES`, and two constants in two packages can drift.
 * They are held equal by an EXACT cross-package contract test in
 * `packages/db/tests/test-db-setup.test.ts`, which parses the ledger's array out
 * of its source text and compares the two sets both ways round — reporting extra
 * names, missing names and duplicates. A widening on either side fails that test
 * rather than passing unnoticed.
 *
 * ADDING A DATABASE IS A DELIBERATE SOURCE CHANGE, reviewed like any other.
 */
export const APPROVED_DISPOSABLE_DATABASES = [
  'ai_capital_test',
  'ai_capital_ledger_round4_test',
] as const

/**
 * A target must be one of the DELIBERATELY approved disposable databases.
 *
 * ORDER IS LOAD-BEARING. Protected/live and maintenance names are refused
 * FIRST and UNCONDITIONALLY, before the allowlist is consulted at all — so a
 * name cannot buy its way in by being added to the approved set while also
 * being declared live. `LIVE_DATABASE_NAMES` always wins.
 *
 * There is no fallback and no derivation from DATABASE_URL: a name is supplied
 * deliberately or the run stops.
 */
export function assertDisposableName(name: string | null): string {
  if (name === null) {
    refuse('the test database URL could not be canonicalised, so it cannot be shown to be non-live.')
  }

  // ── REFUSED FIRST, WHATEVER ELSE ANY LIST SAYS ─────────────────────────────
  // Compared case-insensitively on purpose: `AI_CAPITAL` is not a way to reach
  // a protected database, even though the case check below would also catch it.
  const folded = name.toLowerCase()
  if (liveDatabaseNames().includes(folded)) {
    refuse(`"${name}" is a protected/live database. Refusing to create, migrate or test against it.`)
  }
  if ((MAINTENANCE_DATABASES as readonly string[]).includes(folded)) {
    refuse(
      `"${name}" is a MAINTENANCE database. Creating, migrating or testing against ` +
      'postgres/template0/template1 is refused outright.',
    )
  }

  // CASE IS PART OF THE IDENTITY. PostgreSQL database names are case-sensitive:
  // `AI_CAPITAL_TEST` and `ai_capital_test` are two different databases, and an
  // unquoted `CREATE DATABASE AI_CAPITAL_TEST` folds to the lower-case one.
  // Round 2 ran every name through databaseNameOf(), which LOWERCASES — so a
  // mixed-case URL silently became a different database than the one the
  // operator wrote, and endpoint equality compared normalised strings rather
  // than the identities the driver would actually use.
  //
  // So the raw name is validated as-is and mixed case is REFUSED rather than
  // normalised. The operator fixes the URL; the harness never guesses.
  if (name !== folded) {
    refuse(
      `"${name}" is not lower-case. PostgreSQL database names are case-sensitive and ` +
      'this harness will not normalise one for you: a folded name is a DIFFERENT ' +
      'database from the one written. Supply the exact lower-case name.',
    )
  }
  if (!/^[a-z0-9_]+$/.test(name)) {
    refuse(`"${name}" is not a plain lower-case identifier, so it cannot be a disposable test database.`)
  }

  // ── THE ALLOWLIST. Exact membership, never a pattern. ──────────────────────
  if (!(APPROVED_DISPOSABLE_DATABASES as readonly string[]).includes(name)) {
    refuse(
      `"${name}" is not a disposable test database. Only these exact names are ` +
      `approved: ${APPROVED_DISPOSABLE_DATABASES.join(', ')}.\n` +
      '  A "_test" SUFFIX IS NOT AUTHORIZATION — "customer_test" and "unrelated_test"\n' +
      '  end in _test and could each be somebody else\'s real database. Adding a name\n' +
      '  here is a deliberate source change, reviewed like any other.',
    )
  }
  return name
}

// ─────────────────────────────────────────────────────────────────────────────
// Canonical endpoint comparison
// ─────────────────────────────────────────────────────────────────────────────

export interface Endpoint {
  /** TCP host lower-cased, or an absolute Unix-socket directory path. */
  host: string
  /** Always explicit; 5432 when unspecified, as libpq would default. */
  port: number
  database: string
  /** How the host was expressed — a TCP host and a socket path are never equal. */
  kind: 'tcp' | 'socket'
}

/**
 * The destination a URL really names.
 *
 * COMPARING DATABASE NAMES ALONE IS NOT ENOUGH. `ai_capital_test` on localhost
 * and `ai_capital_test` on a staging host are different databases with the same
 * name; bootstrapping one and testing the other would migrate a cluster nobody
 * looked at. So host/socket, port and name are all compared, and a TCP host
 * never equals a socket path even if the strings coincide.
 *
 * The USERNAME is deliberately excluded: bootstrap and runtime are two
 * different principals by design, and requiring them to match would defeat the
 * privilege separation this harness exists to enforce.
 */
export function canonicalEndpoint(url: string, label: string): Endpoint {
  let c: ReturnType<typeof parseConnectionString>
  try {
    c = parseConnectionString(url)
  } catch (err) {
    refuse(`${label} is not a parseable connection string: ${(err as Error).message}`)
  }
  // RAW: the driver-exact name, case preserved. Validation happens in
  // assertDisposableName; nothing here normalises it.
  const database = databaseNameOfRaw(url)
  if (!database) refuse(`${label} names no database.`)
  const rawHost = (c.host ?? '').trim()
  if (!rawHost) refuse(`${label} names no host or socket directory.`)
  const kind: 'tcp' | 'socket' = rawHost.startsWith('/') ? 'socket' : 'tcp'
  return {
    host: kind === 'socket' ? rawHost.replace(/\/+$/, '') : rawHost.toLowerCase(),
    port: c.port ? Number(c.port) : 5432,
    database,
    kind,
  }
}

export function sameEndpoint(a: Endpoint, b: Endpoint): boolean {
  return a.kind === b.kind && a.host === b.host && a.port === b.port && a.database === b.database
}

export function describeEndpoint(e: Endpoint): string {
  return `${e.kind}:${e.host}:${e.port}/${e.database}`
}

/** The username a URL authenticates as, or null. */
export function usernameOf(url: string): string | null {
  try {
    const u = parseConnectionString(url).user
    return u ? String(u) : null
  } catch { return null }
}

// ─────────────────────────────────────────────────────────────────────────────
// Preflight: both credentials, validated together, before anything is opened
// ─────────────────────────────────────────────────────────────────────────────

export interface Plan {
  bootstrapUrl: string
  runtimeUrl: string
  name: string
  endpoint: Endpoint
  runtimeUser: string
}

/**
 * Validate the whole configuration before a mutating-capable client can exist.
 *
 * Round 1 resolved the bootstrap URL up front but only discovered a missing or
 * mismatched TEST_RUNTIME_DATABASE_URL at the very END of setup — after the
 * database had been created, bootstrapped, migrated and locked down. A
 * misconfigured run therefore mutated a cluster and then refused. Everything
 * knowable from configuration alone is now decided here, first.
 */
export function preflight(env: NodeJS.ProcessEnv): Plan {
  const bootstrapUrl = env.BOOTSTRAP_DATABASE_URL
  const runtimeUrl = env.TEST_RUNTIME_DATABASE_URL
  const missing: string[] = []
  if (!bootstrapUrl) missing.push('BOOTSTRAP_DATABASE_URL')
  if (!runtimeUrl) missing.push('TEST_RUNTIME_DATABASE_URL')
  if (missing.length) {
    refuse(
      `${missing.join(' and ')} ${missing.length > 1 ? 'are' : 'is'} not set.\n` +
      '  The integration suite needs TWO credentials for the SAME disposable database,\n' +
      '  both supplied in the shell — never from .env:\n' +
      '    BOOTSTRAP_DATABASE_URL     privileged; creates the database and runs\n' +
      '                               ops/bootstrap/010, the migrations and 090\n' +
      `    TEST_RUNTIME_DATABASE_URL  restricted; must authenticate as ${RUNTIME_ROLE}\n` +
      '  Database-free tests need neither: use `pnpm --filter @common/db test`.',
    )
  }
  if (env.DATABASE_URL && env.DATABASE_URL === bootstrapUrl) {
    refuse(
      'BOOTSTRAP_DATABASE_URL is identical to DATABASE_URL. The production credential ' +
      'must never be used as bootstrap authority for a test database.',
    )
  }

  const bootEnd = canonicalEndpoint(bootstrapUrl!, 'BOOTSTRAP_DATABASE_URL')
  const runEnd = canonicalEndpoint(runtimeUrl!, 'TEST_RUNTIME_DATABASE_URL')
  const name = assertDisposableName(bootEnd.database)
  assertDisposableName(runEnd.database)

  if (!sameEndpoint(bootEnd, runEnd)) {
    refuse(
      'the two credentials do not name the same destination.\n' +
      `  BOOTSTRAP_DATABASE_URL    -> ${describeEndpoint(bootEnd)}\n` +
      `  TEST_RUNTIME_DATABASE_URL -> ${describeEndpoint(runEnd)}\n` +
      '  Host/socket, port and database name must all match. A same-named database on\n' +
      '  another host, port or socket is a different database, and bootstrapping one\n' +
      '  while testing the other would migrate a cluster nobody inspected.',
    )
  }

  const runtimeUser = usernameOf(runtimeUrl!)
  if (!runtimeUser) refuse('TEST_RUNTIME_DATABASE_URL does not name a user.')
  if (runtimeUser !== RUNTIME_ROLE) {
    refuse(
      `TEST_RUNTIME_DATABASE_URL authenticates as "${runtimeUser}", not "${RUNTIME_ROLE}". ` +
      'Ordinary tests must use the restricted test role; a privileged principal here ' +
      'would hand test code the authority this harness exists to withhold.',
    )
  }
  const bootUser = usernameOf(bootstrapUrl!)
  if (bootUser && bootUser === runtimeUser) {
    refuse('BOOTSTRAP_DATABASE_URL and TEST_RUNTIME_DATABASE_URL authenticate as the same user.')
  }
  return { bootstrapUrl: bootstrapUrl!, runtimeUrl: runtimeUrl!, name, endpoint: bootEnd, runtimeUser }
}

// ─────────────────────────────────────────────────────────────────────────────
// Catalogue-verified privilege proof
// ─────────────────────────────────────────────────────────────────────────────

/** The minimum a client must offer; real `pg.Client` satisfies it. */
export interface QueryClient { query(text: string, values?: unknown[]): Promise<{ rows: any[] }> }

/**
 * Prove from the CLUSTER CATALOGUE that the runtime principal is restricted.
 *
 * Round 1 logged `current_user` after connecting as the runtime role, which
 * proves only that the name is what the URL said. It cannot detect that the
 * role is a superuser, can create databases or roles, bypasses RLS, or inherits
 * ai_capital_owner. This reads pg_roles and pg_auth_members over the BOOTSTRAP
 * connection — before any mutation — and refuses on any of those.
 */
export async function assertRuntimePrincipalRestricted(
  admin: QueryClient, username: string,
): Promise<void> {
  const { rows } = await admin.query(
    `SELECT rolname, rolcanlogin, rolsuper, rolcreatedb, rolcreaterole,
            rolbypassrls, rolreplication
       FROM pg_roles WHERE rolname = $1`,
    [username],
  )
  if (rows.length === 0) {
    refuse(
      `the runtime role "${username}" does not exist in this cluster.\n` +
      '  It is a TEST-ONLY role and is deliberately NOT created by\n' +
      '  ops/roles/000_cluster_roles.sql, which provisions production roles.\n' +
      '  The disposable-cluster harness must create it before the suite runs.',
    )
  }
  const r = rows[0]
  const forbidden: string[] = []
  if (!r.rolcanlogin) forbidden.push('cannot log in')
  if (r.rolsuper) forbidden.push('is SUPERUSER')
  if (r.rolcreatedb) forbidden.push('has CREATEDB')
  if (r.rolcreaterole) forbidden.push('has CREATEROLE')
  if (r.rolbypassrls) forbidden.push('has BYPASSRLS')
  if (r.rolreplication) forbidden.push('has REPLICATION')
  if (forbidden.length) {
    refuse(
      `the runtime role "${username}" ${forbidden.join(', ')}. ` +
      'Ordinary test code must authenticate as a strictly restricted principal.',
    )
  }
  // TRANSITIVE AUTHORITY — and the RIGHT three predicates.
  //
  // Round 2 joined pg_auth_members once, seeing only DIRECT membership. Round 3
  // fixed the depth but asked pg_has_role for 'MEMBER' and labelled it SET ROLE
  // authority. On PostgreSQL 16+ those are three different questions:
  //
  //   MEMBER — is the role a member, directly or indirectly, REGARDLESS of what
  //            that membership confers. Since the WITH INHERIT/SET options were
  //            split out, a membership can confer neither privileges nor SET
  //            ROLE, so MEMBER alone does not describe any usable authority.
  //   USAGE  — are the privileges INHERITED right now (the INHERIT chain).
  //   SET    — is `SET ROLE <role>` actually PERMITTED (the SET option).
  //
  // Usable authority is USAGE or SET. MEMBER is recorded for the diagnostic
  // only: a `WITH INHERIT FALSE, SET FALSE` membership is a real edge in the
  // catalogue but confers nothing, and refusing it would be a false positive.
  const { rows: reach } = await admin.query(
    `SELECT p AS rolname,
            pg_has_role($1, p, 'USAGE')  AS via_usage,
            pg_has_role($1, p, 'SET')    AS via_set,
            pg_has_role($1, p, 'MEMBER') AS is_member
       FROM unnest($2::text[]) AS p
      WHERE EXISTS (SELECT 1 FROM pg_roles WHERE rolname = p)`,
    [username, PRIVILEGED_ROLES as unknown as string[]],
  )
  const reachable = reach.filter((r: any) => r.via_usage || r.via_set)
  if (reachable.length) {
    refuse(
      `the runtime role "${username}" holds usable authority over privileged role(s): ` +
      reachable.map((r: any) =>
        `${r.rolname}(${[r.via_usage && 'inherits', r.via_set && 'SET ROLE']
          .filter(Boolean).join('+')})`).join(', ') + '. ' +
      'PostgreSQL resolves role membership transitively, so an intermediate role is ' +
      'enough — test code must not be able to become owner, authority or migrator.',
    )
  }
}

/**
 * The runtime principal must not be able to CONNECT to any protected database.
 *
 * ROLE ATTRIBUTES DO NOT IMPLY THIS. NOSUPERUSER/NOCREATEDB/NOBYPASSRLS say
 * nothing about database-level CONNECT, which can arrive from an explicit GRANT
 * or — far more easily missed — from PUBLIC, since PostgreSQL grants CONNECT to
 * PUBLIC on every new database by default. has_database_privilege resolves both
 * paths, so this asks the question that actually matters instead of inferring
 * it from unrelated flags.
 *
 * Protected names that do not exist in this cluster are skipped, not failed:
 * a name that names nothing cannot be reached.
 */
export async function assertRuntimeCannotReachProtected(
  admin: QueryClient, username: string,
): Promise<void> {
  const protectedNames = liveDatabaseNames()
  if (!protectedNames.length) {
    refuse('no protected database names are configured, so no protection could be verified.')
  }
  const { rows } = await admin.query(
    `SELECT d.datname,
            has_database_privilege($1, d.datname, 'CONNECT') AS can_connect
       FROM pg_database d
      WHERE d.datname = ANY($2::text[])`,
    [username, protectedNames],
  )
  const reachable = rows.filter((r: any) => r.can_connect).map((r: any) => r.datname)
  if (reachable.length) {
    refuse(
      `the runtime role "${username}" can CONNECT to protected database(s): ` +
      `${reachable.join(', ')}.\n` +
      '  CONNECT may be explicit or inherited through PUBLIC, which PostgreSQL grants\n' +
      '  on every new database by default. Revoke it before running the suite:\n' +
      reachable.map(d => `    REVOKE CONNECT ON DATABASE ${d} FROM PUBLIC, ${username};`).join('\n'),
    )
  }
}

/** Cluster roles from 000_cluster_roles.sql, plus the test-only runtime role. */
export async function assertClusterRolesPresent(admin: QueryClient): Promise<void> {
  const { rows } = await admin.query(
    'SELECT rolname FROM pg_roles WHERE rolname = ANY($1::text[])',
    [[...REQUIRED_CLUSTER_ROLES, RUNTIME_ROLE]],
  )
  const present = new Set(rows.map((r: any) => r.rolname))
  const missingProd = REQUIRED_CLUSTER_ROLES.filter(r => !present.has(r))
  if (missingProd.length) {
    refuse(
      `this cluster is missing required role(s): ${missingProd.join(', ')}.\n` +
      '  ops/roles/000_cluster_roles.sql is a ONE-TIME CLUSTER PREREQUISITE and is\n' +
      '  deliberately not run by any test command — creating roles needs CREATEROLE,\n' +
      '  which a test suite must not hold. Run it once as a cluster administrator.',
    )
  }
  if (!present.has(RUNTIME_ROLE)) {
    refuse(
      `this cluster is missing the test-only role "${RUNTIME_ROLE}".\n` +
      '  It is NOT created by ops/roles/000_cluster_roles.sql, which provisions\n' +
      '  PRODUCTION roles only, and that file is deliberately unchanged here.\n' +
      '  The disposable-cluster harness must create it, e.g.\n' +
      `    CREATE ROLE ${RUNTIME_ROLE} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE\n` +
      '      NOBYPASSRLS NOINHERIT NOREPLICATION;\n' +
      '  The suite then grants it CONNECT on the disposable database itself.',
    )
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// The provisioning state machine, with every side effect injected
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// Effective-CONNECT quarantine
//
// DELAYING THE GRANT WAS NOT ENOUGH. Round 3 moved the explicit
// `GRANT CONNECT ... TO ai_capital_test_runtime` to the end and proved, by
// event log, that no second GRANT statement was emitted on a failed path. That
// proves nothing about whether the role could actually connect:
//
//   * PostgreSQL grants CONNECT to PUBLIC on every new database by default, and
//     neither this harness nor ops/bootstrap/010 revokes it. A brand-new target
//     is therefore reachable by every login role the moment it exists.
//   * An EXISTING target still carries the explicit grant from the last
//     successful run, so a re-run that fails at migration leaves the role able
//     to connect to a half-prepared database.
//
// So the target is QUARANTINED before anything is prepared, and the guarantee
// asserted as an effective privilege — `has_database_privilege(...)` — not as
// the absence of a statement.
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// TWO PROPERTIES, NOT ONE (Round 5)
//
// Round 4 modelled a single boolean it called "effective CONNECT". PostgreSQL
// has TWO independent gates and conflating them hid a real hole:
//
//   hasConnectPrivilege   has_database_privilege(role, db, 'CONNECT') — the ACL
//                         result alone. It does NOT consider datallowconn.
//   canOpenNewConnection  datallowconn AND the ACL. This is what decides whether
//                         a NEW connection is actually accepted.
//
// Deliberately NOT folded together: `has_database_privilege` really does return
// true for a database with ALLOW_CONNECTIONS false, and a harness that pretended
// otherwise would be modelling a PostgreSQL that does not exist. Containment is
// therefore expressed as a pair — which gate is closed, and which is not.
// ─────────────────────────────────────────────────────────────────────────────

/** The ACL result ALONE. False for a database that does not exist. */
export async function hasConnectPrivilege(
  admin: QueryClient, dbName: string, username: string,
): Promise<boolean> {
  const { rows } = await admin.query(
    `SELECT has_database_privilege($1, d.datname, 'CONNECT') AS can_connect
       FROM pg_database d WHERE d.datname = $2`,
    [username, dbName],
  )
  return rows.length > 0 && rows[0].can_connect === true
}

/** datallowconn. `null` means the database does not exist. */
export async function databaseAllowsConnections(
  admin: QueryClient, dbName: string,
): Promise<boolean | null> {
  const { rows } = await admin.query(
    'SELECT datallowconn FROM pg_database WHERE datname = $1', [dbName],
  )
  return rows.length === 0 ? null : rows[0].datallowconn === true
}

/** BOTH gates: would PostgreSQL accept a new connection from this role today? */
export async function canOpenNewConnection(
  admin: QueryClient, dbName: string, username: string,
): Promise<boolean> {
  const allows = await databaseAllowsConnections(admin, dbName)
  if (allows !== true) return false
  return hasConnectPrivilege(admin, dbName, username)
}

/** Open runtime sessions on the target. Reported, never terminated. */
export async function runtimeSessions(
  admin: QueryClient, dbName: string, username: string,
): Promise<Array<{ pid: number; state?: string }>> {
  const { rows } = await admin.query(
    `SELECT pid, state FROM pg_stat_activity WHERE datname = $1 AND usename = $2`,
    [dbName, username],
  )
  return rows as Array<{ pid: number; state?: string }>
}

/**
 * Refuse if the runtime role already holds a session on the target.
 *
 * DETECT, DO NOT TERMINATE. `pg_terminate_backend` would make the guarantee
 * true by force while hiding that something was already connected to a database
 * about to be rebuilt — which is exactly the kind of silent repair this harness
 * exists to avoid. The operator is told, and decides.
 */
export async function assertNoRuntimeSessions(
  admin: QueryClient, dbName: string, username: string,
): Promise<void> {
  const rows = await runtimeSessions(admin, dbName, username)
  if (rows.length) {
    refuse(
      `"${username}" already has ${rows.length} open session(s) on "${dbName}" ` +
      `(pid ${rows.map(r => r.pid).join(', ')}).\n` +
      '  Quarantining the database cannot make the no-connect guarantee true for a\n' +
      '  session that is already established. These are NOT terminated automatically:\n' +
      '  close them, or terminate them deliberately, and re-run.',
    )
  }
}

/**
 * The postcondition, stated as an ACL fact and reported with both gates.
 *
 * `when` names the boundary being checked so a failure says WHICH proof failed
 * — the one taken while a fresh database was still closed, or the one taken
 * after it was re-opened for the bootstrap principal's own work.
 */
export async function assertQuarantined(
  admin: QueryClient, dbName: string, username: string, when = 'after quarantine',
): Promise<void> {
  if (await hasConnectPrivilege(admin, dbName, username)) {
    const allows = await databaseAllowsConnections(admin, dbName)
    refuse(
      `"${username}" can still CONNECT to "${dbName}" ${when}.\n` +
      `  has_database_privilege = true, datallowconn = ${allows}; a new connection ` +
      `${allows === true ? 'WOULD be accepted right now' : 'is blocked only by ALLOW_CONNECTIONS'}.\n` +
      '  PUBLIC and the direct grant were both revoked, so CONNECT is arriving by\n' +
      '  another path — a role membership, or a grant to a group this role belongs\n' +
      '  to. That grant belongs to another role and is NOT revoked here. Refusing to\n' +
      '  prepare a database the test role can already reach.',
    )
  }
}

/** ALTER DATABASE ... ALLOW_CONNECTIONS false, and prove the gate closed. */
export async function disableConnections(admin: QueryClient, dbName: string): Promise<void> {
  await admin.query(`ALTER DATABASE ${dbName} WITH ALLOW_CONNECTIONS false`)
  if (await databaseAllowsConnections(admin, dbName) !== false) {
    refuse(`"${dbName}" still permits connections after ALLOW_CONNECTIONS false.`)
  }
}

/**
 * Revoke PUBLIC and the direct grant, then PROVE no CONNECT privilege remains.
 *
 * For a FRESH target this runs while the database is still ALLOW_CONNECTIONS
 * false, so a failure anywhere inside leaves the database closed. For an
 * EXISTING target the sessions check comes first: quarantine cannot retroactively
 * apply to a connection that is already open.
 *
 * Only PUBLIC's grant and this role's own direct grant are revoked. A grant that
 * reaches the role through a group is deliberately left alone — silently
 * revoking another role's privileges to make an assertion pass would be exactly
 * the sort of repair this harness refuses to perform.
 */
export async function quarantineTarget(
  admin: QueryClient, dbName: string, username: string, opts: { existed: boolean },
): Promise<void> {
  if (opts.existed) {
    await assertNoRuntimeSessions(admin, dbName, username)
  }
  await admin.query(`REVOKE CONNECT ON DATABASE ${dbName} FROM PUBLIC`)
  await admin.query(`REVOKE CONNECT ON DATABASE ${dbName} FROM ${username}`)
  await assertQuarantined(admin, dbName, username, 'after quarantine')
}

/**
 * Re-open a fresh target for the bootstrap principal, and RE-PROVE containment.
 *
 * This is the step Round 4 got wrong: it enabled connections and then checked,
 * so a failing check left an OPEN database behind. The enable is now the LAST
 * thing that happens in the quarantine sequence, it happens only after the ACL
 * proof has already succeeded, and its own postcondition is checked immediately
 * — with the caller restoring ALLOW_CONNECTIONS false if that postcondition or
 * anything after it fails.
 */
export async function openForPreparation(
  admin: QueryClient, dbName: string, username: string,
): Promise<void> {
  await admin.query(`ALTER DATABASE ${dbName} WITH ALLOW_CONNECTIONS true`)
  if (await databaseAllowsConnections(admin, dbName) !== true) {
    refuse(`"${dbName}" did not accept ALLOW_CONNECTIONS true; it cannot be prepared.`)
  }
  await assertQuarantined(admin, dbName, username, 'after connections were re-enabled')
}

/**
 * Undo the final grant after a late failure, and prove the undo worked.
 *
 * A cleanup that silently fails is worse than none: it leaves the operator
 * believing the role was locked out. Any failure here is surfaced with the
 * original error rather than replacing or swallowing it.
 */
export async function revokeRuntimeConnect(
  admin: QueryClient, dbName: string, username: string,
): Promise<void> {
  await admin.query(`REVOKE CONNECT ON DATABASE ${dbName} FROM ${username}`)
  await assertQuarantined(admin, dbName, username, 'after the cleanup revoke')
}

// ─────────────────────────────────────────────────────────────────────────────
// DISPOSABLE-TEST FIXTURE ACCESS (Round 9)
//
// After ops/bootstrap/090 the test runtime holds CONNECT and NOTHING else —
// `USAGE` is false on every application schema and it is the grantee of zero
// table privileges. That is the V3 design and it is correct. It is also why the
// three legacy @common/db integration tests could not run: they read and write
// `desk.*` and `portfolio.*` with the runtime credential, and the 2026-09-08
// gate failed 17 of them with SQLSTATE 42501.
//
// The answer is NOT to widen a production role. These grants are DISPOSABLE
// TEST INFRASTRUCTURE: they are issued by the test harness, on the exact
// validated disposable database, after lockdown has already proven the
// production shape, and they exist nowhere in migrations or ops/. A production
// database never receives them because nothing in production runs this file.
//
// The set is derived from the statements those two test files actually execute:
//
//   desk.agent_claims      SELECT  src/agent-claims.ts:347 (claimHistory)
//                          INSERT  src/agent-claims.ts:392 (recordClaims)
//                          UPDATE  src/agent-claims.ts:409,438,443 (applyEvent)
//                          DELETE  claim-governance.test.ts:62 (afterAll)
//   desk.agent_runs        INSERT  src/agent-claims.ts:464 (ingestAgentOutput)
//                          SELECT  claim-governance.test.ts:297
//                          DELETE  claim-governance.test.ts:64 (afterAll)
//   desk.non_emission      SELECT  claim-governance.test.ts:321 — a VIEW owned
//                          by ai_capital_owner, so its own rights cover the
//                          base tables and no extra grant is implied.
//   portfolio.positions    INSERT  db-isolation-live.test.ts:42
//                          SELECT  db-isolation-live.test.ts:48
//                          DELETE  db-isolation-live.test.ts:37 (afterEach)
//   two sequences          both id columns are BIGSERIAL, so INSERT needs USAGE
//                          on the owning sequence and nothing more.
//
// NOT granted, and asserted so below: any schema-wide ALL TABLES / ALL
// SEQUENCES / ALL FUNCTIONS form, and anything at all in identity,
// investment_ledger, cash_ledger, capital, graph, briefing, thesis or trade.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * ROUND 10. The Round 9 validator was NOT fail-closed, and the Round 9 report
 * claiming otherwise was wrong. It declared FIXTURE_ALLOWED_SCHEMAS and never
 * consulted it; its "no GRANT ALL" rule stripped `" ALL "` from the statement
 * and then tested the stripped string for `ALL`, which can never match. Codex
 * confirmed it accepted `GRANT ALL ON desk.agent_claims`,
 * `GRANT SELECT ON public.any_table` and `GRANT UPDATE ON desk.agent_runs`.
 *
 * The rules are now driven by ONE canonical structured manifest that both
 * GENERATES and VALIDATES the statements, so there is no second list to drift.
 * Validation is exact set-and-order equality against the rendered manifest —
 * which is what makes "no more, no fewer, no duplicates, no alternative
 * privilege form" true by construction rather than by enumerated prohibition.
 *
 * The manifest itself is then checked by CATEGORICAL rules (below) that are not
 * a copy of it: allowed schema, forbidden schema, no ALL, no structural verb,
 * no duplicate object. Those catch a widening edit to the manifest, which
 * equality alone could not.
 */

/** The ONLY schemas a fixture grant may name — now actually enforced. */
export const FIXTURE_ALLOWED_SCHEMAS = ['desk', 'portfolio'] as const

/**
 * Schemas the test runtime must never reach, fixtures or not.
 *
 * `public`, `pg_catalog` and `information_schema` are here alongside the V3
 * tenancy surfaces: Round 9 listed only the latter, so `public.any_table` was
 * accepted. Nothing the disposable tests do needs any of the three.
 */
export const FIXTURE_FORBIDDEN_SCHEMAS = [
  'identity', 'investment_ledger', 'cash_ledger', 'capital',
  'graph', 'briefing', 'thesis', 'trade', 'db',
  'public', 'pg_catalog', 'information_schema',
] as const

/** Privileges that confer structure rather than access. Never granted. */
const FIXTURE_FORBIDDEN_PRIVILEGES = [
  'ALL', 'ALL PRIVILEGES', 'CREATE', 'TRUNCATE', 'REFERENCES', 'TRIGGER',
] as const

export interface FixtureGrant {
  /** What is being granted on — decides the GRANT ... ON <kind> spelling. */
  readonly kind: 'schema' | 'table' | 'sequence'
  /** `desk`, or `desk.agent_claims`. Always schema-qualified for objects. */
  readonly object: string
  /** Exactly the verbs the two disposable test files issue. */
  readonly privileges: readonly string[]
  /** The statement that made each verb necessary. */
  readonly because: string
}

/**
 * THE CANONICAL MANIFEST. Eight entries, and what is absent is as much the
 * point as what is present: no UPDATE on agent_runs or positions (never
 * issued), no TRUNCATE, no schema-wide form, nothing outside desk/portfolio.
 */
export const FIXTURE_GRANT_MANIFEST: readonly FixtureGrant[] = [
  { kind: 'schema', object: 'desk', privileges: ['USAGE'],
    because: 'reach desk.* at all' },
  { kind: 'schema', object: 'portfolio', privileges: ['USAGE'],
    because: 'reach portfolio.* at all' },
  { kind: 'table', object: 'desk.agent_claims',
    privileges: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'],
    because: 'agent-claims.ts:347 claimHistory / :392 recordClaims / :409,438,443 applyEvent / claim-governance.test.ts:62 afterAll' },
  { kind: 'table', object: 'desk.agent_runs',
    privileges: ['SELECT', 'INSERT', 'DELETE'],
    because: 'agent-claims.ts:464 ingestAgentOutput / claim-governance.test.ts:297 / :64 afterAll' },
  { kind: 'table', object: 'desk.non_emission', privileges: ['SELECT'],
    because: 'claim-governance.test.ts:321 — a VIEW owned by ai_capital_owner' },
  { kind: 'table', object: 'portfolio.positions',
    privileges: ['SELECT', 'INSERT', 'DELETE'],
    because: 'db-isolation-live.test.ts:42 / :48 / :37 afterEach' },
  { kind: 'sequence', object: 'desk.agent_claims_id_seq', privileges: ['USAGE'],
    because: 'id is BIGSERIAL; INSERT needs the owning sequence' },
  { kind: 'sequence', object: 'desk.agent_runs_id_seq', privileges: ['USAGE'],
    because: 'id is BIGSERIAL; INSERT needs the owning sequence' },
] as const

/** The schema half of a manifest object (`desk.agent_claims` → `desk`). */
function schemaOf(g: FixtureGrant): string {
  return g.kind === 'schema' ? g.object : g.object.split('.')[0]
}

/**
 * CATEGORICAL rules over the manifest — not a copy of it.
 *
 * Equality with the rendered manifest cannot notice that the manifest ITSELF
 * grew a `public.any_table` entry. These rules can, and they are stated as
 * properties rather than as a second list of approved statements.
 */
export function assertFixtureManifestIsNarrow(
  manifest: readonly FixtureGrant[] = FIXTURE_GRANT_MANIFEST,
): void {
  const seen = new Set<string>()
  for (const g of manifest) {
    const where = `${g.kind} ${g.object}`
    if (seen.has(`${g.kind}:${g.object}`)) {
      refuse(`fixture manifest names ${where} twice; each object appears exactly once.`)
    }
    seen.add(`${g.kind}:${g.object}`)

    if (g.kind !== 'schema' && !g.object.includes('.')) {
      refuse(`fixture manifest entry ${where} is not schema-qualified.`)
    }
    const schema = schemaOf(g)
    if ((FIXTURE_FORBIDDEN_SCHEMAS as readonly string[]).includes(schema)) {
      refuse(
        `fixture manifest reaches protected schema "${schema}" (${where}).\n` +
        '  The V3 tenancy surfaces, and public/pg_catalog/information_schema, are\n' +
        '  exactly what the runtime role must NOT see.',
      )
    }
    if (!(FIXTURE_ALLOWED_SCHEMAS as readonly string[]).includes(schema)) {
      refuse(
        `fixture manifest names schema "${schema}" (${where}), which is not one of ` +
        `${FIXTURE_ALLOWED_SCHEMAS.join(', ')}. Disposable fixtures reach nothing else.`,
      )
    }
    if (!g.privileges.length) {
      refuse(`fixture manifest entry ${where} grants nothing; remove it instead.`)
    }
    for (const priv of g.privileges) {
      const p = priv.trim().toUpperCase()
      if (p !== priv || !/^[A-Z ]+$/.test(p)) {
        refuse(`fixture privilege "${priv}" on ${where} is not a bare upper-case keyword.`)
      }
      if ((FIXTURE_FORBIDDEN_PRIVILEGES as readonly string[]).includes(p)) {
        refuse(
          `fixture manifest confers "${p}" on ${where}. Object-level ALL and every ` +
          'structural privilege are refused: the disposable tests never use them, so a ' +
          'grant can only be adding authority nothing asked for.',
        )
      }
    }
  }
}

/** Render ONE manifest entry. The role is the only interpolation. */
export function renderFixtureGrant(g: FixtureGrant, role: string): string {
  const target =
    g.kind === 'schema'   ? `SCHEMA ${g.object}`
    : g.kind === 'sequence' ? `SEQUENCE ${g.object}`
    : g.object
  return `GRANT ${g.privileges.join(', ')} ON ${target} TO ${role}`
}

/** The eight statements, generated from the manifest. One source, never two. */
export function fixtureGrantStatements(role: string): string[] {
  assertFixtureManifestIsNarrow()
  return FIXTURE_GRANT_MANIFEST.map(g => renderFixtureGrant(g, role))
}

/**
 * FAIL-CLOSED VALIDATION: exactly the approved eight, in the manifest's order.
 *
 * Order is treated as SIGNIFICANT, deliberately. The only legitimate producer
 * is fixtureGrantStatements(), which emits manifest order; anything else has
 * been assembled by hand and is exactly what this exists to refuse. Equality
 * therefore covers extra, missing, duplicated, reordered and alternative-form
 * statements in one rule, rather than a list of prohibitions that can miss one
 * — which is precisely how Round 9's validator let `GRANT ALL` through.
 */
export function assertFixtureGrantsAreNarrow(statements: string[], role: string): void {
  if (role !== RUNTIME_ROLE) {
    refuse(
      `fixture grants may only be issued to "${RUNTIME_ROLE}", never to "${role}". ` +
      'These are disposable-test privileges and no other principal may receive them.',
    )
  }
  assertFixtureManifestIsNarrow()
  const approved = FIXTURE_GRANT_MANIFEST.map(g => renderFixtureGrant(g, RUNTIME_ROLE))

  const normalise = (sql: string) =>
    sql.replace(/\s+/g, ' ').trim().replace(/;+$/, '').trim()
  const got = statements.map(normalise)

  const duplicates = got.filter((sql, i) => got.indexOf(sql) !== i)
  if (duplicates.length) {
    refuse(`fixture grant issued more than once: ${[...new Set(duplicates)].join(' | ')}`)
  }
  const extra = got.filter(sql => !approved.includes(sql))
  if (extra.length) {
    refuse(
      `fixture grant is NOT one of the ${approved.length} approved statements:\n` +
      extra.map(e => `    ${e}`).join('\n') + '\n' +
      '  The approved set is generated from FIXTURE_GRANT_MANIFEST in\n' +
      '  packages/db/testing/preflight.ts. Widening it is a deliberate source change.',
    )
  }
  const missing = approved.filter(sql => !got.includes(sql))
  if (missing.length) {
    refuse(
      `fixture grant batch is missing ${missing.length} approved statement(s):\n` +
      missing.map(m => `    ${m}`).join('\n'),
    )
  }
  if (got.length !== approved.length) {
    refuse(`fixture grant batch has ${got.length} statements; exactly ${approved.length} are approved.`)
  }
  for (let i = 0; i < approved.length; i++) {
    if (got[i] !== approved[i]) {
      refuse(
        `fixture grant ${i + 1} is out of manifest order.\n` +
        `    expected: ${approved[i]}\n    received: ${got[i]}`,
      )
    }
  }
}

/**
 * Issue the fixture grants, fail-closed.
 *
 * Runs ONLY after 010, migrations, 090 and schema/identity verification have
 * succeeded, and BEFORE the runtime role is given CONNECT — so a failure here
 * leaves a database the test role cannot even reach.
 */
export async function grantTestFixtureAccess(
  target: QueryClient, role: string,
): Promise<string[]> {
  const statements = fixtureGrantStatements(role)
  assertFixtureGrantsAreNarrow(statements, role)
  for (const sql of statements) {
    await target.query(sql)
  }
  return statements
}

export interface ProvisionDeps {
  /** Connect to the cluster's maintenance database as the bootstrap principal. */
  connectAdmin(): Promise<QueryClient & { end(): Promise<void> }>
  /** Connect to the disposable database itself, as the bootstrap principal. */
  connectTarget(url: string): Promise<QueryClient & { end(): Promise<void> }>
  /** Connect as the RESTRICTED runtime principal. Used only for the final probe. */
  connectRuntime(url: string): Promise<QueryClient & { end(): Promise<void> }>
  /** Read an ops/*.sql file, `:"dbname"` already substituted. */
  readOpsScript(relPath: string, dbName: string): string
  /** Filenames currently present in packages/db/migrations. */
  migrationFilesOnDisk(): string[]
  /** The repository migration runner. */
  runMigrations(): Promise<{ applied: string[]; alreadyApplied: string[] }>
  /** Assert the migrated schema is what it should be. Injected so a failure here
   *  can be proven to prevent the CONNECT grant. */
  verifySchema(client: QueryClient, name: string): Promise<void>
  log(line: string): void
}

// ─────────────────────────────────────────────────────────────────────────────
// LIFECYCLE STATE, RECORDED BEFORE EACH MUTATING BOUNDARY (Round 5)
//
// Round 4 set a single `quarantined` boolean AFTER quarantineTarget() returned,
// and the failure handler only ran for work that came later. A quarantine that
// failed PART WAY THROUGH therefore escaped containment entirely: the database
// had already been re-opened, the postcondition threw, and nothing turned it
// back off. The phase below is advanced BEFORE the statement that could make it
// true, so containment always knows the worst case rather than the best one.
// ─────────────────────────────────────────────────────────────────────────────
export type LifecyclePhase =
  /** Nothing on the target has been mutated. Containment must do nothing. */
  | 'untouched'
  /** CREATE DATABASE was issued; the database may or may not exist. */
  | 'creating'
  /** A fresh database exists with ALLOW_CONNECTIONS false. */
  | 'created_disabled'
  /** A pre-existing database is about to be, or is being, quarantined. */
  | 'existing_unquarantined'
  /** The ACL proof passed. A fresh target is still ALLOW_CONNECTIONS false. */
  | 'quarantined_closed'
  /** Connections are open and containment was re-proven. Preparation may run. */
  | 'prepared_open'
  /** Disposable-test fixture grants are being issued on the target. */
  | 'granting_fixtures'
  /** GRANT CONNECT was issued; the runtime role may now hold it. */
  | 'granting'
  /** The grant succeeded and the runtime probe is running. */
  | 'granted'

export interface TargetLifecycle {
  phase: LifecyclePhase
  /** The target already existed before this run. Never created by us. */
  existed: boolean
  /** This run issued CREATE DATABASE. Containment may keep it closed. */
  createdByUs: boolean
}

/**
 * STATE-AWARE CONTAINMENT. Runs for every failure after the first mutation.
 *
 * What it does depends on how far the lifecycle got, because the right action
 * differs and a wrong one is worse than none:
 *
 *   untouched                  nothing. Never act on a database this run did
 *                              not create and did not confirm exists.
 *   creating                   AMBIGUOUS COMPLETION. CREATE errored but the
 *                              database may exist anyway. Ownership is UNKNOWN:
 *                              absent → nothing to contain, no mutation; closed
 *                              (datallowconn false) → verifiably closed, say so
 *                              and make no ACL claim; open → REFUSE with an
 *                              ambiguous-ownership report and mutate nothing.
 *   created_disabled           this run created it: keep it closed.
 *   quarantined_closed (fresh) keep or RESTORE ALLOW_CONNECTIONS false — this is
 *                              the Round 4 hole: the enable may already have run.
 *   existing_unquarantined     revoke the direct grant and PROVE no ACL path
 *                              remains. A pre-existing database is NOT disabled:
 *                              turning off connections to a database this run did
 *                              not create is a side effect nobody asked for.
 *   prepared_open              revoke the direct grant and prove.
 *   granting / granted         revoke, prove, AND re-check pg_stat_activity: a
 *                              session opened while the grant was live survives
 *                              the revoke, and is reported, never terminated.
 *
 * Nothing here is swallowed. A failed cleanup connection, revoke, ALTER or
 * assertion is collected and reported ALONGSIDE the original error — reporting
 * containment that did not happen is the failure mode this exists to prevent.
 */
async function contain(
  deps: ProvisionDeps, life: TargetLifecycle, name: string, username: string, cause: Error,
): Promise<void> {
  if (life.phase === 'untouched') return

  const problems: string[] = []
  let admin: (QueryClient & { end(): Promise<void> }) | null = null
  try {
    admin = await deps.connectAdmin()
  } catch (e) {
    problems.push(`could not open a cleanup connection: ${(e as Error).message}`)
  }

  if (admin) {
    try {
      // Never act on a database that is not confirmed to exist right now.
      const allows = await databaseAllowsConnections(admin, name)
      if (allows === null) {
        // Case 1: nothing exists. No mutation of any kind is issued.
        deps.log(
          life.phase === 'creating'
            ? `[test-db] containment: CREATE of "${name}" did not complete; nothing exists to contain`
            : `[test-db] containment: "${name}" does not exist; nothing to contain`,
        )
      } else if (life.phase === 'creating') {
        // AMBIGUOUS COMPLETION (Round 6). CREATE DATABASE reported an error and
        // the database nevertheless EXISTS. PostgreSQL may have committed it
        // before the client lost the answer, or the name may belong to someone
        // else entirely — this run cannot tell which, so `createdByUs` is still
        // false and NOTHING here claims ownership.
        if (allows === false) {
          // Case 2: verifiably closed. datallowconn = false blocks EVERY new
          // connection regardless of the ACL, so a CONNECT grant still held by
          // PUBLIC is not reachability and is deliberately not reported as such.
          deps.log(
            `[test-db] containment: "${name}" exists but is ALLOW_CONNECTIONS false — ` +
            'verifiably closed; no ACL claim is made and nothing was mutated',
          )
        } else {
          // Case 3: exists AND open. Disabling it could close a database this
          // harness does not own; adopting it could hand the suite a database it
          // never prepared. Neither is defensible without a human.
          problems.push(
            `AMBIGUOUS CREATE: "${name}" EXISTS and permits connections after ` +
            'CREATE DATABASE reported an error. Whether this run created it CANNOT be ' +
            'determined, so it was neither disabled nor adopted — disabling a database ' +
            'this harness may not own is a side effect nobody authorised. No containment ' +
            'is claimed. Inspect it and drop it, or close it, by hand.',
          )
        }
      } else if (
        life.createdByUs &&
        (life.phase === 'created_disabled' || life.phase === 'quarantined_closed')
      ) {
        // A fresh target whose containment was never proven WITH connections
        // open. It must end this run closed, whether or not the enable ran.
        if (allows) await disableConnections(admin, name)
        deps.log(`[test-db] containment: "${name}" left with ALLOW_CONNECTIONS false`)
      } else {
        // Containment was proven with connections open, or the target
        // pre-existed. Undo the direct grant and prove the ACL is closed.
        await admin.query(`REVOKE CONNECT ON DATABASE ${name} FROM ${username}`)
        if (await hasConnectPrivilege(admin, name, username)) {
          problems.push(
            `"${username}" STILL holds CONNECT on "${name}" after the direct grant was ` +
            'revoked. The remaining path is a grant to PUBLIC or to a group role, which ' +
            'belongs to another role and was deliberately not revoked. The database is ' +
            'NOT inaccessible.',
          )
        }
      }

      // A revoke closes the door for FUTURE connections only.
      if (life.phase === 'granting' || life.phase === 'granted') {
        const open = await runtimeSessions(admin, name, username)
        if (open.length) {
          problems.push(
            `${open.length} "${username}" session(s) remain open on "${name}" ` +
            `(pid ${open.map(s => s.pid).join(', ')}). Revoking CONNECT does not terminate ` +
            'an established session and none were terminated automatically. ' +
            'CONTAINMENT IS INCOMPLETE.',
          )
        }
      }
    } catch (e) {
      problems.push((e as Error).message)
    } finally {
      await admin.end().catch(() => {})
    }
  }

  if (problems.length) {
    refuse(
      'setup failed AND containment could not be completed.\n' +
      `  original failure: ${cause.message}\n` +
      problems.map(p => `  containment     : ${p}`).join('\n') + '\n' +
      `  "${username}" may still be able to reach "${name}". Fix by hand.`,
    )
  }
  deps.log(`[test-db] setup failed; containment verified for "${name}"`)
}

/**
 * ORDER IS THE CONTRACT, asserted behaviourally by an injected event log.
 *
 *   1 preflight()                     configuration only — NO CLIENT EXISTS YET
 *   2 connectAdmin()
 *   3 cluster roles present           incl. the test-only runtime role
 *   4 runtime attributes + TRANSITIVE privileged-role authority
 *   5 runtime cannot CONNECT to any protected database
 *   6 stale-ledger guard              only when the target already exists
 *   ── every step above is NON-MUTATING; none of the below runs if any failed ──
 *   ── and every step below is inside the containment handler ────────────────
 *   7 CREATE DATABASE ALLOW_CONNECTIONS false     FIRST MUTATION
 *   8 REVOKE CONNECT from PUBLIC, then from the runtime role
 *   9 PROVE no CONNECT privilege        fresh target is still closed here
 *  10 ALTER DATABASE ALLOW_CONNECTIONS true       fresh target only
 *  11 RE-PROVE containment              before a single byte is bootstrapped
 *  12 ops/bootstrap/010
 *  13 migrations, as ai_capital_owner
 *  14 ops/bootstrap/090
 *  15 verify schema AND target identity
 *  16 disposable-test FIXTURE grants   narrow, named objects, test runtime only
 *  17 GRANT CONNECT to the runtime role     ← LAST, and only if 12-16 succeeded
 *  18 connect as the runtime principal, assert current_user and current_database
 *  19 CLOSE the probe — a failed close fails the run, it is not swallowed
 *  20 prove the probe left no runtime-role session behind
 *  21 caller removes privileged credentials and starts workers
 *
 * WHY THE GRANT MOVED. Round 2 granted CONNECT immediately after creating the
 * database, so a database that failed to bootstrap, migrate, lock down or verify
 * was nonetheless left reachable by the test role — approved-looking without
 * being approved. Migration 016 needs the ROLE TO EXIST, which step 3 proves; it
 * does not need that role to hold CONNECT while migrating.
 *
 * WHY 9 AND 11 ARE BOTH THERE. Step 9 proves the ACL with the database still
 * closed, so a failure cannot leave anything reachable. Step 11 proves it again
 * once the database is open, because that is the state 12 onwards runs in.
 */
export async function provision(env: NodeJS.ProcessEnv, deps: ProvisionDeps): Promise<Plan> {
  // 1 ── configuration, before any client can be constructed
  const plan = preflight(env)
  const { name, bootstrapUrl, runtimeUrl, runtimeUser } = plan

  const life: TargetLifecycle = { phase: 'untouched', existed: false, createdByUs: false }

  // 2-6 ── catalogue checks. NOTHING here mutates, so nothing here needs
  //        containment; a failure leaves the cluster exactly as it was found.
  {
    const admin = await deps.connectAdmin()
    try {
      await assertClusterRolesPresent(admin)
      await assertRuntimePrincipalRestricted(admin, runtimeUser)
      await assertRuntimeCannotReachProtected(admin, runtimeUser)
      const { rows } = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [name])
      life.existed = rows.length > 0
    } finally {
      await admin.end().catch(() => {})
    }
  }

  if (life.existed) {
    const target = await deps.connectTarget(bootstrapUrl)
    try {
      await assertNoStaleLedger(target, name, deps.migrationFilesOnDisk())
    } finally {
      await target.end().catch(() => {})
    }
  }

  // ── EVERYTHING BELOW IS INSIDE THE CONTAINMENT HANDLER ─────────────────────
  try {
    const admin = await deps.connectAdmin()
    try {
      // 7 ── FIRST MUTATION. The identifier is the RAW approved name, unquoted
      //      only because it was proven to match ^[a-z0-9_]+$ and be lower-case.
      if (!life.existed) {
        if (!/^[a-z0-9_]+$/.test(name) || name !== name.toLowerCase()) {
          refuse(`refusing to CREATE DATABASE with an unexpected name "${name}".`)
        }
        // ALLOW_CONNECTIONS false closes the window in which PostgreSQL's default
        // PUBLIC CONNECT grant is live on a brand-new database.
        life.phase = 'creating'
        await admin.query(`CREATE DATABASE ${name} ALLOW_CONNECTIONS false`)
        life.createdByUs = true
        life.phase = 'created_disabled'
        deps.log(`[test-db] created "${name}" with connections disabled`)
      } else {
        life.phase = 'existing_unquarantined'
      }

      // 8, 9 ── revoke and PROVE. A fresh target is still closed throughout.
      await quarantineTarget(admin, name, runtimeUser, { existed: life.existed })
      life.phase = 'quarantined_closed'
      deps.log(`[test-db] quarantined "${name}": ${runtimeUser} holds no CONNECT privilege`)

      // 10, 11 ── open a fresh target, then RE-PROVE before preparing anything.
      if (life.createdByUs) {
        await openForPreparation(admin, name, runtimeUser)
      }
      life.phase = 'prepared_open'
    } finally {
      await admin.end().catch(() => {})
    }

    // 12 ── ops/bootstrap/010
    const prep = await deps.connectTarget(bootstrapUrl)
    try {
      await prep.query(deps.readOpsScript('ops/bootstrap/010_database_bootstrap.sql', name))
      deps.log('[test-db] bootstrap: ops/bootstrap/010 applied')
    } finally {
      await prep.end().catch(() => {})
    }

    // 13 ── migrations, owned by ai_capital_owner
    const result = await deps.runMigrations()
    deps.log(`[test-db] migrations: ${result.applied.length} applied, ${result.alreadyApplied.length} already applied`)

    // 14 ── ops/bootstrap/090. Deliberately NOT in a finally: a failed migration
    //       must never leave the database looking approved for test execution.
    const lock = await deps.connectTarget(bootstrapUrl)
    try {
      await lock.query(deps.readOpsScript('ops/bootstrap/090_post_migration_lockdown.sql', name))
      deps.log('[test-db] lockdown: ops/bootstrap/090 applied')
    } finally {
      await lock.end().catch(() => {})
    }

    // 15 ── verify the resulting schema and the target's own identity
    const verify = await deps.connectTarget(bootstrapUrl)
    try {
      await deps.verifySchema(verify, name)
      const { rows } = await verify.query('SELECT current_database() AS db')
      if (rows[0]?.db !== name) {
        refuse(`verification connected to "${rows[0]?.db}" but the approved target is "${name}".`)
      }
      deps.log(`[test-db] ready: ${name}`)
    } finally {
      await verify.end().catch(() => {})
    }

    // 16 ── DISPOSABLE-TEST FIXTURE ACCESS. After lockdown and after both
    //       verifications, so the production shape has already been proven; and
    //       BEFORE the CONNECT grant, so a failure here leaves a database the
    //       test role cannot reach at all. Not in a finally, and not swallowed.
    life.phase = 'granting_fixtures'
    const fixtures = await deps.connectTarget(bootstrapUrl)
    try {
      const issued = await grantTestFixtureAccess(fixtures, runtimeUser)
      deps.log(`[test-db] fixtures: ${issued.length} narrow grant(s) to ${runtimeUser}`)
    } finally {
      await fixtures.end().catch(() => {})
    }

    // 17 ── ONLY NOW may the restricted role reach the database. Everything above
    //       succeeded, so what it is being granted access to is actually approved.
    const grant = await deps.connectAdmin()
    try {
      life.phase = 'granting'
      await grant.query(`GRANT CONNECT ON DATABASE ${name} TO ${RUNTIME_ROLE}`)
      life.phase = 'granted'
      deps.log(`[test-db] granted CONNECT on "${name}" to ${RUNTIME_ROLE}`)
    } finally {
      await grant.end().catch(() => {})
    }

    // 18 ── prove the credential workers will receive actually works, and lands
    //       where it should. Asserted, not logged: a wrong password, wrong
    //       principal or wrong database stops the suite here rather than
    //       surfacing inside an unrelated test.
    //
    //       The probe connection is closed in step 19 BEFORE containment or the
    //       leftover-session sweep, so the harness never counts its own session.
    const probe = await deps.connectRuntime(runtimeUrl)
    let probeError: Error | null = null
    try {
      const { rows } = await probe.query('SELECT current_user AS usr, current_database() AS db')
      const actualUser = rows[0]?.usr
      const actualDb = rows[0]?.db
      if (actualUser !== RUNTIME_ROLE) {
        refuse(
          `TEST_RUNTIME_DATABASE_URL authenticated as "${actualUser}", not "${RUNTIME_ROLE}". ` +
          'Workers must run as the restricted principal.',
        )
      }
      if (actualDb !== name) {
        refuse(
          `TEST_RUNTIME_DATABASE_URL connected to "${actualDb}" but the approved target is "${name}". ` +
          'Workers would have tested a database that was never prepared.',
        )
      }
      deps.log(`[test-db] runtime probe: ${actualUser}@${actualDb} (non-privileged)`)
    } catch (e) {
      probeError = e as Error
    }

    // 19 ── CLOSING THE PROBE IS PART OF THE CONTRACT, not a best-effort
    //       afterthought. Round 5 wrote `probe.end().catch(() => {})`, so a
    //       failed close was invisible: provisioning returned SUCCESS with a
    //       runtime-role connection still attached to the database, the outer
    //       catch never ran, and containment never looked for it. The comment
    //       claiming the probe closes before containment was stronger than the
    //       code. The close now throws like anything else, and both failures
    //       are reported when both happen.
    let closeError: Error | null = null
    try {
      await probe.end()
    } catch (e) {
      closeError = e as Error
    }
    if (probeError && closeError) {
      refuse(
        'the runtime probe failed AND its connection could not be closed.\n' +
        `  probe failure: ${probeError.message}\n` +
        `  close failure: ${closeError.message}`,
      )
    }
    if (probeError) throw probeError
    if (closeError) {
      refuse(
        `the runtime probe connection to "${name}" could not be closed: ${closeError.message}\n` +
        `  A "${RUNTIME_ROLE}" connection opened by SETUP may still be attached to the\n` +
        '  database. Setup will not report success while its own session may be live.',
      )
    }

    // 20 ── and PROVE the probe left nothing behind. A close that reports
    //       success is not evidence that the backend is gone.
    const after = await deps.connectAdmin()
    try {
      const left = await runtimeSessions(after, name, runtimeUser)
      if (left.length) {
        refuse(
          `the setup probe left ${left.length} "${runtimeUser}" session(s) open on ` +
          `"${name}" (pid ${left.map(r => r.pid).join(', ')}) after reporting a clean close.\n` +
          '  These are NOT terminated automatically. Close them, or terminate them\n' +
          '  deliberately, and re-run.',
        )
      }
    } finally {
      await after.end().catch(() => {})
    }
  } catch (err) {
    await contain(deps, life, name, runtimeUser, err as Error)
    throw err
  }

  return plan
}

/**
 * A ledger naming files that no longer exist means this database was migrated
 * by a DIFFERENT generation of the repository. Migrating forward would layer
 * the current chain onto an incompatible schema, so this refuses rather than
 * attempting an upgrade — the database must be recreated.
 */
export async function assertNoStaleLedger(
  client: QueryClient, name: string, onDisk: string[],
): Promise<void> {
  const { rows: exists } = await client.query(
    "SELECT to_regclass('db.schema_migrations') IS NOT NULL AS present",
  )
  if (!exists[0]?.present) return
  const { rows } = await client.query('SELECT filename FROM db.schema_migrations ORDER BY filename')
  const have = new Set(onDisk)
  const stale = rows.map((r: any) => r.filename).filter((f: string) => !have.has(f))
  if (stale.length) {
    refuse(
      `"${name}" was migrated by a DIFFERENT generation of this repository.\n` +
      `  Its migration ledger records ${stale.length} file(s) that no longer exist:\n` +
      stale.map((f: string) => `    ${f}`).join('\n') + '\n' +
      '  Migrating forward would layer the current chain onto an incompatible schema.\n' +
      '  This is not repaired automatically: drop and recreate the database, then\n' +
      '  re-run so it receives 010 + migrations + 090 from scratch.',
    )
  }
}
