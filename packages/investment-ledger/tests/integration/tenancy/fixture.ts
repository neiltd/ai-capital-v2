// TENANCY INTEGRATION FIXTURE.
//
// INTEGRATION SUPPORT — USED ONLY BY THE ISOLATED POSTGRESQL TENANCY GATE.
//
// Every file in this directory needs a PostgreSQL cluster with all ten
// production roles from ops/roles/000_cluster_roles.sql and a disposable
// database migrated 001-019. Creating roles and running migrations is a
// separately authorized gate.
//
// ROLE TOPOLOGY. ops/roles/000_cluster_roles.sql defines ALL TEN production
// roles, and a database migrated through 019 needs every one of them to exist:
// Migration 018 grants the legacy runtime privileges to ai_capital_pipeline and
// ai_capital_claim_writer. Migration 019 separately grants ai_capital_dashboard
// its limited `trade` read privileges. A cluster missing any of those three
// roles cannot complete migrations 018-019. ai_capital_owner and
// ai_capital_identity_authority are NOLOGIN and are never connection identities
// at all.
//
// This suite directly authenticates SIX identities — migrator, operator,
// importer, agent, app and a cluster administrator — and it does NOT
// authenticate or exercise the pipeline, claim-writer or dashboard credentials.
// Those are reserved for the separately authorised runtime-role rehearsal and
// the S4B dashboard gate.
//
// WHAT MAKES THESE TESTS DIFFERENT FROM THE EXISTING SUITE. The existing
// integration tests connect as one privileged role and check business rules.
// These connect as SEVERAL DISTINCT LOGIN ROLES and check the boundary between
// them, so the thing under test is the database's own refusal. A negative case
// that passed because the application declined to issue the statement would be
// worthless, so every negative probe issues real SQL and asserts the SQLSTATE.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE SEEDING CONTRACT, WHICH THE FIRST VERSION OF THIS FILE GOT WRONG.
//
// The identity schema is strict, and a fixture that ignores its constraints
// does not fail loudly — it fails during setup, and every assertion afterwards
// reports something other than what it claims to test. The first draft:
//
//   * inserted `identity.principals DEFAULT VALUES`, though `kind` and
//     `display_name` are both NOT NULL with no default;
//   * generated `service_key` values like `matrix-archive-import-1a2b3c4d`,
//     which fail the CHECK `^[a-z][a-z0-9-]*:[a-z][a-z0-9-]*$`;
//   * created one principal per CAPABILITY and bound them all to
//     `ai_capital_importer`, though `service_principal_roles.db_role` is UNIQUE
//     — so every principal after the first collided, and the ones that "worked"
//     would have made `current_service_principal()` ambiguous by design;
//   * omitted `granted_by`, which is NOT NULL.
//
// The corrected rule is one sentence: **exactly one service principal per login
// role, resolved by that role, created once.** Capability differences are
// expressed by WORKSPACES, never by extra principals — which is also how
// production works, and is why the matrix now means something.
// ─────────────────────────────────────────────────────────────────────────────

import { randomUUID } from 'node:crypto'
import type { Client } from 'pg'
import { createClient, liveDatabaseNames } from '../../../../db/src/pool.js'
import { isDisposableTestDatabase } from '../support.js'

// ─────────────────────────────────────────────────────────────────────────────
// Connections
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One connection URL per role.
 *
 * Separate URLs rather than `SET ROLE`, and that is the whole point: the
 * authorization functions resolve the caller from `session_user`, which SET
 * ROLE does not change. A suite built on role switching would exercise a
 * different mechanism from the one production uses and would pass while
 * production failed.
 */
// ─────────────────────────────────────────────────────────────────────────────
// THE CANONICAL PRODUCTION ROLE MANIFEST
//
// ONE definition of the production role set, exported so that every assertion
// about "which roles exist" reads from here instead of restating a list.
//
// This exists because the 2026-09-13 isolated rehearsal found two tenancy tests
// hard-coding a five-name list that predated ai_capital_pipeline and
// ai_capital_claim_writer. Both asserted exact equality against
// `pg_roles LIKE 'ai_capital_%'`, so a correctly provisioned nine-role cluster
// failed them — the tests were stale, not the cluster. A duplicated literal
// cannot be updated in one place; a shared manifest can.
//
// THE SOURCE OF TRUTH IS ops/roles/000_cluster_roles.sql. This constant mirrors
// it, and packages/investment-ledger/tests/unit/bootstrap-contract.test.ts
// parses that file and pins its contents independently, so a drift between the
// two is caught without a database.
// ─────────────────────────────────────────────────────────────────────────────

/** The two NOLOGIN roles. Object owners and grantors, never login identities. */
export const NOLOGIN_ROLES = [
  'ai_capital_identity_authority',
  'ai_capital_owner',
] as const

/**
 * The eight LOGIN roles.
 *
 * Only five are authenticated by this suite (see ROLE_URL_ENV below);
 * ai_capital_pipeline and ai_capital_claim_writer are exercised by the
 * separately authorized runtime-role rehearsal, and ai_capital_dashboard by the
 * S4B gate. They still belong here: this manifest describes which roles the
 * CLUSTER has, not which ones this suite connects as, and a database migrated
 * through 019 cannot complete without all of them existing.
 */
export const LOGIN_ROLES = [
  'ai_capital_agent',
  'ai_capital_app',
  'ai_capital_claim_writer',
  'ai_capital_dashboard',
  'ai_capital_importer',
  'ai_capital_migrator',
  'ai_capital_operator',
  'ai_capital_pipeline',
] as const

/**
 * All ten production roles, sorted — the order `pg_roles ... ORDER BY rolname`
 * returns, so a query result can be compared to this directly.
 */
export const ALL_PRODUCTION_ROLES: readonly string[] =
  [...NOLOGIN_ROLES, ...LOGIN_ROLES].sort()

export const ROLE_URL_ENV = {
  migrator: 'TENANCY_MIGRATOR_DATABASE_URL',
  operator: 'TENANCY_OPERATOR_DATABASE_URL',
  importer: 'TENANCY_IMPORTER_DATABASE_URL',
  agent:    'TENANCY_AGENT_DATABASE_URL',
  app:      'TENANCY_APP_DATABASE_URL',
  /** Cluster administrator. Seeds identity rows and installs the deliberate
   *  non-vacuity controls; NEVER used to assert a boundary, because a superuser
   *  bypasses every boundary these tests exist to prove. */
  admin:    'TENANCY_ADMIN_DATABASE_URL',
} as const

export type RoleName = keyof typeof ROLE_URL_ENV

export function roleUrl(role: RoleName): string {
  const url = process.env[ROLE_URL_ENV[role]]
  if (!url) {
    throw new Error(
      `${ROLE_URL_ENV[role]} is required for the tenancy suite. Each role logs in ` +
      'separately because session_user is what the authorization functions read.',
    )
  }
  return url
}

/**
 * Connect as one role, refusing anything that is not a disposable database.
 *
 * The check is made from INSIDE the connection (`current_database()`) rather
 * than by parsing the URL, so a URL that resolves somewhere unexpected — a
 * service alias, a pooler, a `PGDATABASE` default — cannot slip past. The
 * `session_user` check is equally load-bearing: a suite whose five "different"
 * roles all authenticated as the same login would pass almost everything.
 */
export async function connectAs(role: RoleName): Promise<Client> {
  const client = createClient(roleUrl(role))
  await client.connect()
  const { rows } = await client.query<{ db: string; who: string }>(
    'SELECT current_database() AS db, session_user AS who')
  if (!isDisposableTestDatabase(rows[0].db) || liveDatabaseNames().includes(rows[0].db)) {
    await client.end()
    throw new Error(`refusing to run the tenancy suite against "${rows[0].db}"`)
  }
  if (role !== 'admin' && rows[0].who !== `ai_capital_${role}`) {
    await client.end()
    throw new Error(
      `${ROLE_URL_ENV[role]} authenticates as "${rows[0].who}", not "ai_capital_${role}". ` +
      'These tests are meaningless if the roles are not distinct.',
    )
  }
  return client
}

// ─────────────────────────────────────────────────────────────────────────────
// Transaction state
//
// WHY THE FIXTURE TRACKS THIS ITSELF. `sqlstateOf` brackets a probe with a
// SAVEPOINT, and `SAVEPOINT` outside a transaction block is itself an error
// (25P01). Called on a client with no open transaction, the helper would
// therefore return "25P01" — an error-shaped value that a test asserting
// "expected some failure" happily accepts. There is no reliable way to ask
// PostgreSQL "am I in a transaction block" from the client, so the fixture owns
// the state and REFUSES rather than returning something plausible.
//
// The refusal is a thrown Error and not a SQLSTATE precisely so it cannot be
// mistaken for a database answer. tests/unit/tenancy-fixture-contract.test.ts
// exercises this with a stub client and no database at all.
// ─────────────────────────────────────────────────────────────────────────────

const OPEN_TRANSACTIONS = new WeakSet<object>()

export function isTransactionOpen(client: Client): boolean {
  return OPEN_TRANSACTIONS.has(client as unknown as object)
}

export async function begin(client: Client): Promise<void> {
  if (isTransactionOpen(client)) {
    throw new Error('begin(): a transaction is already open on this client')
  }
  await client.query('BEGIN')
  OPEN_TRANSACTIONS.add(client as unknown as object)
}

export async function commit(client: Client): Promise<void> {
  if (!isTransactionOpen(client)) throw new Error('commit(): no transaction is open')
  await client.query('COMMIT')
  OPEN_TRANSACTIONS.delete(client as unknown as object)
}

export async function rollback(client: Client): Promise<void> {
  // Tolerant on purpose: this is the cleanup path, and a client whose
  // transaction already aborted must still end up marked closed.
  OPEN_TRANSACTIONS.delete(client as unknown as object)
  await client.query('ROLLBACK').catch(() => {})
}

// ─────────────────────────────────────────────────────────────────────────────
// Identity seeding
// ─────────────────────────────────────────────────────────────────────────────

export interface ServicePrincipal {
  id: string
  serviceKey: string
  /** The PostgreSQL LOGIN role this principal is bound to, or null for a
   *  principal that exists only to be named (the grantor). */
  dbRole: string | null
}

export interface Workspace {
  id: string
  slug: string
}

/**
 * The complete set of service principals this suite creates. ONE per login
 * role, plus one unbound principal to be the grantor of every capability grant.
 *
 * `service_key` must match `^[a-z][a-z0-9-]*:[a-z][a-z0-9-]*$` — namespace:name.
 * These are written out rather than generated, so a future edit that breaks the
 * format breaks visibly here instead of at INSERT time.
 */
export const SERVICE_PRINCIPALS = {
  'ai_capital_importer': { serviceKey: 'importer:tenancy-suite',  displayName: 'Tenancy suite importer' },
  'ai_capital_agent':    { serviceKey: 'agent:tenancy-suite',     displayName: 'Tenancy suite agent' },
  'ai_capital_operator': { serviceKey: 'operator:tenancy-suite',  displayName: 'Tenancy suite operator' },
  'ai_capital_app':      { serviceKey: 'app:tenancy-suite',       displayName: 'Tenancy suite app' },
} as const

export type BoundRole = keyof typeof SERVICE_PRINCIPALS

/** The grantor. A real principal, bound to NO login role: it is an attribution
 *  target for `granted_by`, not something that acts. */
export const GRANTOR = {
  serviceKey: 'operator:tenancy-grantor',
  displayName: 'Tenancy suite grant administrator',
} as const

async function insertServicePrincipal(
  admin: Client, serviceKey: string, displayName: string,
): Promise<string> {
  // kind and display_name are both NOT NULL with no default; kind must be
  // 'service' for the composite (id, kind) key that service_principals uses.
  const principal = await admin.query<{ id: string }>(
    `INSERT INTO identity.principals (kind, display_name)
     VALUES ('service', $1) RETURNING id`,
    [displayName])
  const id = principal.rows[0].id
  await admin.query(
    'INSERT INTO identity.service_principals (principal_id, service_key) VALUES ($1,$2)',
    [id, serviceKey])
  return id
}

/**
 * The service principal for a login role, created at most once ever.
 *
 * RESOLVED BY `db_role`, not by service key or by insertion order. That column
 * is UNIQUE and `service_principal_roles` carries an append-only trigger, so a
 * second binding is not merely wasteful — it is impossible, and an attempt
 * would abort the fixture in a way that surfaces as an unrelated failure three
 * files later. Looking the binding up first makes the helper idempotent across
 * re-runs against a database that already has it.
 */
export async function ensureRolePrincipal(admin: Client, dbRole: BoundRole): Promise<ServicePrincipal> {
  const spec = SERVICE_PRINCIPALS[dbRole]
  const bound = await admin.query<{ principal_id: string; service_key: string }>(
    `SELECT r.principal_id, s.service_key
       FROM identity.service_principal_roles r
       JOIN identity.service_principals s ON s.principal_id = r.principal_id
      WHERE r.db_role = $1`,
    [dbRole])
  if (bound.rowCount) {
    return { id: bound.rows[0].principal_id, serviceKey: bound.rows[0].service_key, dbRole }
  }
  const id = await insertServicePrincipal(admin, spec.serviceKey, spec.displayName)
  await admin.query(
    'INSERT INTO identity.service_principal_roles (principal_id, db_role) VALUES ($1,$2)',
    [id, dbRole])
  return { id, serviceKey: spec.serviceKey, dbRole }
}

/** The unbound grantor principal, created at most once. */
export async function ensureGrantorPrincipal(admin: Client): Promise<ServicePrincipal> {
  const existing = await admin.query<{ principal_id: string }>(
    'SELECT principal_id FROM identity.service_principals WHERE service_key = $1',
    [GRANTOR.serviceKey])
  if (existing.rowCount) {
    return { id: existing.rows[0].principal_id, serviceKey: GRANTOR.serviceKey, dbRole: null }
  }
  const id = await insertServicePrincipal(admin, GRANTOR.serviceKey, GRANTOR.displayName)
  return { id, serviceKey: GRANTOR.serviceKey, dbRole: null }
}

/** Every principal this suite needs, resolved once. */
export interface Principals {
  importer: ServicePrincipal
  agent: ServicePrincipal
  operator: ServicePrincipal
  app: ServicePrincipal
  grantor: ServicePrincipal
}

export async function ensurePrincipals(admin: Client): Promise<Principals> {
  return {
    importer: await ensureRolePrincipal(admin, 'ai_capital_importer'),
    agent:    await ensureRolePrincipal(admin, 'ai_capital_agent'),
    operator: await ensureRolePrincipal(admin, 'ai_capital_operator'),
    app:      await ensureRolePrincipal(admin, 'ai_capital_app'),
    grantor:  await ensureGrantorPrincipal(admin),
  }
}

/** `workspaces.slug` must match `^[a-z0-9][a-z0-9-]{1,62}$`. */
export async function seedWorkspace(admin: Client, label: string): Promise<Workspace> {
  const slug = `${label.toLowerCase().replace(/[^a-z0-9-]+/g, '-')}-${randomUUID().slice(0, 8)}`
    .replace(/^-+/, 'w').slice(0, 63)
  const { rows } = await admin.query<{ id: string }>(
    'INSERT INTO identity.workspaces (slug, display_name) VALUES ($1,$2) RETURNING id',
    [slug, `tenancy suite: ${label}`])
  return { id: rows[0].id, slug }
}

export interface GrantWindow {
  validFrom?: string
  validUntil?: string | null
}

/**
 * Grant a capability. `granted_by` is REQUIRED by the schema and is supplied
 * from the seeded grantor — the production constraint is not weakened to
 * accommodate the fixture.
 */
export async function grantCapability(
  admin: Client, workspace: Workspace, principal: ServicePrincipal,
  capability: Capability, grantor: ServicePrincipal, window: GrantWindow = {},
): Promise<string> {
  const { rows } = await admin.query<{ id: string }>(
    `INSERT INTO identity.workspace_service_grants
       (workspace_id, principal_id, capability, valid_from, valid_until, granted_by)
     VALUES ($1,$2,$3::identity.service_capability,
             coalesce($4::timestamptz, now()), $5::timestamptz, $6)
     RETURNING id`,
    [workspace.id, principal.id, capability,
     window.validFrom ?? null, window.validUntil ?? null, grantor.id])
  return rows[0].id
}

/**
 * End a grant through the production function, as the operator.
 *
 * Not an UPDATE from the admin: `terminated_by` must name a principal, the
 * cancel/revoke distinction is decided against `valid_from`, and the one-way
 * trigger polices the result. Using the real path means the fixture cannot
 * create a grant state the application could not.
 */
export async function terminateGrant(
  operator: Client, grantId: string, kind: 'cancel' | 'revoke', reason: string,
): Promise<void> {
  await operator.query('SELECT identity.terminate_service_grant($1, $2, $3)',
    [grantId, kind, reason])
}

// ─────────────────────────────────────────────────────────────────────────────
// Capabilities
// ─────────────────────────────────────────────────────────────────────────────

export const ALL_CAPABILITIES = [
  'archive-import', 'manual-entry', 'reconciliation', 'document-verification', 'ledger-read',
] as const
export type Capability = typeof ALL_CAPABILITIES[number]

/**
 * Open an authorized, context-bearing transaction, mirroring
 * `withAuthorizedServiceWorkspaceTransaction` exactly.
 *
 * The production helper is not reused because it takes its connection from the
 * shared pool, and these tests need a connection whose `session_user` they
 * chose. The ORDER is reproduced deliberately: authorize with the workspace as
 * an ARGUMENT first, publish the GUCs second. A version that set the GUC first
 * would pass against a design that could never work on a clean connection.
 */
export async function beginAuthorized(
  client: Client, workspaceId: string, capabilities: Capability[],
): Promise<string> {
  await begin(client)
  // FAILURE-ATOMIC. Everything after BEGIN can fail: the authorize call raises
  // 42501 for a missing capability, and either set_config can fail on a broken
  // connection. Without this the tracker stayed marked-open, and the NEXT test
  // died with `begin(): a transaction is already open on this client` — twelve
  // such cascades in the first database gate, every one masking the real
  // failure. `rollback()` clears the tracker BEFORE issuing ROLLBACK and
  // swallows the query error, so it is safe even when the rollback itself
  // fails.
  try {
    const { rows } = await client.query<{ principal_id: string }>(
      'SELECT identity.authorize_service_workspace_any($1, $2::identity.service_capability[])'
      + ' AS principal_id',
      [workspaceId, capabilities])
    const principalId = rows[0].principal_id
    await client.query("SELECT set_config('app.workspace_id', $1, true)", [workspaceId])
    await client.query("SELECT set_config('app.principal_id', $1, true)", [principalId])
    return principalId
  } catch (err) {
    await rollback(client)
    throw err
  }
}

/** Publish context WITHOUT authorizing — for tests that probe a forged GUC. */
export async function beginWithForgedContext(
  client: Client, workspaceId: string, principalId: string,
): Promise<void> {
  await begin(client)
  // Same failure atomicity as beginAuthorized. This helper deliberately skips
  // authorization, so the only failures are the two set_config calls — but a
  // helper that leaks transaction state on ANY post-BEGIN failure is the bug,
  // not a helper that leaks it on an interesting one.
  try {
    await client.query("SELECT set_config('app.workspace_id', $1, true)", [workspaceId])
    await client.query("SELECT set_config('app.principal_id', $1, true)", [principalId])
  } catch (err) {
    await rollback(client)
    throw err
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Probing
// ─────────────────────────────────────────────────────────────────────────────

export interface ProbeResult {
  /** SQLSTATE of the failure, or null when the statement SUCCEEDED. */
  code: string | null
  /** The server's message, so a test can prove WHICH layer refused. */
  message: string | null
}

/**
 * Run a probe inside a savepoint and ALWAYS roll it back.
 *
 * Rolling back on success too is not tidiness. A matrix walks the same tables
 * repeatedly, and a successful cell that stayed would satisfy the next cell's
 * unique constraints, change the next reconciliation transition's starting
 * state, and generally make later results depend on earlier ones. Every probe
 * therefore starts from the same committed state.
 *
 * Requires an open transaction; see the note on transaction state above.
 */
export async function probe(client: Client, fn: () => Promise<unknown>): Promise<ProbeResult> {
  if (!isTransactionOpen(client)) {
    throw new Error(
      'probe() requires an open transaction: SAVEPOINT outside a transaction block ' +
      'raises 25P01, which is an error-shaped value a test would happily accept. ' +
      'Use beginAuthorized()/begin() first, or probeDetached().',
    )
  }
  const savepoint = `sp_${randomUUID().replace(/-/g, '')}`
  await client.query(`SAVEPOINT ${savepoint}`)
  let result: ProbeResult
  try {
    await fn()
    result = { code: null, message: null }
  } catch (error) {
    const e = error as { code?: string; message?: string }
    result = { code: e.code ?? 'unknown', message: e.message ?? null }
  }
  await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`)
  return result
}

/** As `probe`, for a client that is NOT inside a transaction. */
export async function probeDetached(
  client: Client, fn: () => Promise<unknown>,
): Promise<ProbeResult> {
  await begin(client)
  try {
    return await probe(client, fn)
  } finally {
    await rollback(client)
  }
}

/** Convenience: just the SQLSTATE. */
export async function sqlstateOf(client: Client, fn: () => Promise<unknown>): Promise<string | null> {
  return (await probe(client, fn)).code
}

/** Convenience: just the SQLSTATE, for a client with no open transaction. */
export async function sqlstateOfDetached(
  client: Client, fn: () => Promise<unknown>,
): Promise<string | null> {
  return (await probeDetached(client, fn)).code
}

/** Insufficient privilege — the SQLSTATE every capability refusal must raise. */
export const INSUFFICIENT_PRIVILEGE = '42501'
/** Unique violation. */
export const UNIQUE_VIOLATION = '23505'
/** Foreign key violation — how a composite-FK cross-tenant write dies. */
export const FK_VIOLATION = '23503'
/** NOT NULL violation. */
export const NOT_NULL_VIOLATION = '23502'
/** CHECK violation. */
export const CHECK_VIOLATION = '23514'
/** Exclusion constraint violation — overlapping grants. */
export const EXCLUSION_VIOLATION = '23P01'
/** Raised by PL/pgSQL `RAISE EXCEPTION` with no ERRCODE: the append-only and
 *  state-machine triggers use it, which is how those refusals are told apart
 *  from capability refusals. */
export const RAISE_EXCEPTION = 'P0001'
/** SAVEPOINT outside a transaction block. Named so a test can assert it is
 *  NEVER what a probe returns. */
export const NO_ACTIVE_TRANSACTION = '25P01'
