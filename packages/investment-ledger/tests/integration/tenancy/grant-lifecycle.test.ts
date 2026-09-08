import { it, expect, beforeAll, afterAll } from 'vitest'
import type { Client } from 'pg'
import {
  connectAs, ensurePrincipals, seedWorkspace, grantCapability, terminateGrant,
  beginAuthorized, commit, rollback, probeDetached,
  INSUFFICIENT_PRIVILEGE, EXCLUSION_VIOLATION,
  type Principals, type Workspace,
} from './fixture.js'
import { describeInPhase } from './phase.js'

// GRANT LIFECYCLE — future grants, cancellation, revocation, disabled
// principals, and connection reuse.
//
// INTEGRATION TEST — RUN ONLY BY THE ISOLATED POSTGRESQL TENANCY GATE.
//
// WHY THIS IS SEPARATE FROM THE MATRIX. The matrix asks "does this principal
// hold this capability". This file asks WHEN, and time is where authorization
// systems rot: a grant that has not started, one cancelled before it started,
// one revoked mid-session, a principal disabled after its connection was
// already open. A static matrix reports every one of those as simply "granted".
//
// THE CONNECTION-REUSE CASE IS THE SHARPEST. `pool.ts` hands out a
// process-wide singleton with `max: 5` and a 30-second idle timeout, so the
// connection that just served workspace A is the one that will serve workspace
// B. Context is published with `set_config(..., true)` — transaction-LOCAL,
// reverting on COMMIT *and* ROLLBACK — precisely so the next borrower inherits
// nothing. If that ever became a session-level SET, these are the tests that
// would notice.
//
// Grants are ended through `identity.terminate_service_grant` rather than by
// UPDATE, so the fixture cannot construct a grant state the application could
// not: `terminated_by` must name a principal, the cancel/revoke distinction is
// decided against `valid_from`, and the one-way trigger polices the result.

describeInPhase('post-lockdown', 'grant lifecycle', () => {
  let admin: Client
  let importer: Client
  let operator: Client
  let principals: Principals
  let workspace: Workspace

  const hourFromNow = () => new Date(Date.now() + 3_600_000).toISOString()
  const hoursAgo = (n: number) => new Date(Date.now() - n * 3_600_000).toISOString()

  /** Each test uses a FRESH workspace: grants are append-only and the exclusion
   *  constraint spans terminated rows, so reusing one would make later tests
   *  depend on the exact history earlier ones left behind. */
  const freshWorkspace = (label: string) => seedWorkspace(admin, `lifecycle-${label}`)

  beforeAll(async () => {
    admin = await connectAs('admin')
    importer = await connectAs('importer')
    operator = await connectAs('operator')
    principals = await ensurePrincipals(admin)
    workspace = await freshWorkspace('base')
  })

  afterAll(async () => {
    await operator?.end()
    await importer?.end()
    await admin?.end()
  })

  it('the operator login is bound to a principal, or nothing below can terminate', async () => {
    expect(principals.operator.dbRole).toBe('ai_capital_operator')
    const { rows } = await operator.query<{ id: string | null }>(
      'SELECT identity.current_service_principal() AS id')
    expect(rows[0].id).toBe(principals.operator.id)
  })

  it('a grant that starts in the future does not authorize now', async () => {
    const ws = await freshWorkspace('future')
    await grantCapability(admin, ws, principals.importer, 'archive-import',
      principals.grantor, { validFrom: hourFromNow() })
    const result = await probeDetached(importer, () =>
      importer.query('SELECT identity.authorize_service_workspace($1, $2::identity.service_capability)',
        [ws.id, 'archive-import']))
    expect(result.code).toBe(INSUFFICIENT_PRIVILEGE)
  })

  it('a grant that has expired does not authorize either', async () => {
    const ws = await freshWorkspace('expired')
    await grantCapability(admin, ws, principals.importer, 'archive-import',
      principals.grantor, { validFrom: hoursAgo(2), validUntil: hoursAgo(1) })
    const result = await probeDetached(importer, () =>
      importer.query('SELECT identity.authorize_service_workspace($1, $2::identity.service_capability)',
        [ws.id, 'archive-import']))
    expect(result.code).toBe(INSUFFICIENT_PRIVILEGE)
  })

  it('overlapping grants of the same capability are impossible', async () => {
    // The EXCLUDE USING gist over the generated effective_range. Without it
    // "revoke the grant" would be ambiguous whenever two covered the same
    // instant, and revoking one would silently leave the other live.
    const ws = await freshWorkspace('overlap')
    await grantCapability(admin, ws, principals.importer, 'archive-import', principals.grantor)
    const result = await probeDetached(admin, () =>
      grantCapability(admin, ws, principals.importer, 'archive-import', principals.grantor))
    expect(result.code).toBe(EXCLUSION_VIOLATION)
  })

  it('DIFFERENT capabilities may overlap — the constraint is per capability', async () => {
    // The complement, and the reason the setup window in graph.ts works at all.
    const ws = await freshWorkspace('multi')
    await grantCapability(admin, ws, principals.importer, 'archive-import', principals.grantor)
    const result = await probeDetached(admin, () =>
      grantCapability(admin, ws, principals.importer, 'manual-entry', principals.grantor))
    expect(result.code).toBeNull()
  })

  it('a cancelled grant collapses to an EMPTY range and never authorized anything', async () => {
    // Cancellation is not revocation. A grant cancelled before it began must
    // read as though it never existed, so a later audit cannot mistake it for a
    // window during which something was permitted.
    const ws = await freshWorkspace('cancel')
    const id = await grantCapability(admin, ws, principals.importer, 'archive-import',
      principals.grantor, { validFrom: hourFromNow() })
    await terminateGrant(operator, id, 'cancel', 'lifecycle test')
    const { rows } = await admin.query<{ empty: boolean; cancelled: string | null; by: string }>(
      `SELECT isempty(effective_range) AS empty, cancelled_at::text AS cancelled,
              terminated_by::text AS by
         FROM identity.workspace_service_grants WHERE id = $1`, [id])
    expect(rows[0].empty).toBe(true)
    expect(rows[0].cancelled).not.toBeNull()
    expect(rows[0].by, 'the terminator must be recorded').toBe(principals.operator.id)
  })

  it('revocation TRUNCATES the range rather than erasing it', async () => {
    // The opposite of cancellation, and the distinction is why both exist: a
    // revoked grant DID authorize things, and the audit trail must keep the
    // window in which it did.
    const ws = await freshWorkspace('revoke')
    const id = await grantCapability(admin, ws, principals.importer, 'archive-import', principals.grantor)
    await terminateGrant(operator, id, 'revoke', 'lifecycle test')
    const { rows } = await admin.query<{ empty: boolean; upper: string | null }>(
      `SELECT isempty(effective_range) AS empty, upper(effective_range)::text AS upper
         FROM identity.workspace_service_grants WHERE id = $1`, [id])
    expect(rows[0].empty).toBe(false)
    expect(rows[0].upper).not.toBeNull()

    const result = await probeDetached(importer, () =>
      importer.query('SELECT identity.authorize_service_workspace($1, $2::identity.service_capability)',
        [ws.id, 'archive-import']))
    expect(result.code).toBe(INSUFFICIENT_PRIVILEGE)
  })

  it('cancelling an ACTIVE grant is refused — cancel means pre-activation', async () => {
    const ws = await freshWorkspace('cancel-active')
    const id = await grantCapability(admin, ws, principals.importer, 'archive-import', principals.grantor)
    const result = await probeDetached(operator, () =>
      terminateGrant(operator, id, 'cancel', 'should not be possible'))
    expect(result.code).not.toBeNull()
  })

  it('termination is one-way: a revoked grant cannot be un-revoked', async () => {
    const ws = await freshWorkspace('one-way')
    const id = await grantCapability(admin, ws, principals.importer, 'archive-import', principals.grantor)
    await terminateGrant(operator, id, 'revoke', 'lifecycle test')
    const result = await probeDetached(admin, () =>
      admin.query('UPDATE identity.workspace_service_grants SET revoked_at = NULL WHERE id = $1', [id]))
    expect(result.code, 'the one-way trigger must refuse this').not.toBeNull()
  })

  it('only the operator may terminate a grant', async () => {
    const ws = await freshWorkspace('operator-only')
    const id = await grantCapability(admin, ws, principals.importer, 'archive-import', principals.grantor)
    const result = await probeDetached(importer, () =>
      importer.query('SELECT identity.terminate_service_grant($1, $2, $3)',
        [id, 'revoke', 'the importer must not be able to do this']))
    expect(result.code).toBe(INSUFFICIENT_PRIVILEGE)
  })

  it('a disabled principal authorizes nothing, however live its grants', async () => {
    // The emergency stop. It must not require walking every grant, because the
    // point of an emergency stop is that it is one action.
    const ws = await freshWorkspace('disabled')
    await grantCapability(admin, ws, principals.importer, 'archive-import', principals.grantor)
    await admin.query('UPDATE identity.principals SET disabled_at = now() WHERE id = $1',
      [principals.importer.id])
    try {
      const result = await probeDetached(importer, () =>
        importer.query('SELECT identity.authorize_service_workspace($1, $2::identity.service_capability)',
          [ws.id, 'archive-import']))
      expect(result.code).toBe(INSUFFICIENT_PRIVILEGE)
      expect(result.message).toMatch(/not bound to an enabled service principal/)
    } finally {
      await admin.query('UPDATE identity.principals SET disabled_at = NULL WHERE id = $1',
        [principals.importer.id])
    }
  })

  it('...and re-enabling restores it, so the previous test proved DISABLING', async () => {
    const ws = await freshWorkspace('reenabled')
    await grantCapability(admin, ws, principals.importer, 'archive-import', principals.grantor)
    const result = await probeDetached(importer, () =>
      importer.query('SELECT identity.authorize_service_workspace($1, $2::identity.service_capability)',
        [ws.id, 'archive-import']))
    expect(result.code, 'the principal must work again once enabled').toBeNull()
  })

  it('a login whose principal holds no grant here authorizes nothing', async () => {
    // Every login in this suite IS bound to a principal — `db_role` is UNIQUE
    // and the fixture creates exactly one per role — so the unbound case is not
    // reachable from here without corrupting the binding. What is reachable,
    // and what actually happens in production, is a bound principal acting in a
    // workspace it was never granted.
    const app = await connectAs('app')
    try {
      const result = await probeDetached(app, () =>
        app.query('SELECT identity.authorize_service_workspace($1, $2::identity.service_capability)',
          [workspace.id, 'ledger-read']))
      expect(result.code).toBe(INSUFFICIENT_PRIVILEGE)
    } finally {
      await app.end()
    }
  })

  it('CONNECTION REUSE: context does not survive COMMIT', async () => {
    const ws = await freshWorkspace('reuse-commit')
    await grantCapability(admin, ws, principals.importer, 'archive-import', principals.grantor)
    await beginAuthorized(importer, ws.id, ['archive-import'])
    await commit(importer)
    const { rows } = await importer.query<{ ws: string | null; who: string | null }>(
      `SELECT nullif(current_setting('app.workspace_id', true),'') AS ws,
              nullif(current_setting('app.principal_id', true),'') AS who`)
    expect(rows[0].ws, 'a committed transaction must leave no context behind').toBeNull()
    expect(rows[0].who).toBeNull()
  })

  it('CONNECTION REUSE: context does not survive ROLLBACK either', async () => {
    // The half that is easy to get wrong. `SET LOCAL` reverts on rollback too;
    // a plain `SET` would not — and the failure would surface only on the NEXT
    // borrower of the connection, in a different test, on a different day.
    const ws = await freshWorkspace('reuse-rollback')
    await grantCapability(admin, ws, principals.importer, 'archive-import', principals.grantor)
    await beginAuthorized(importer, ws.id, ['archive-import'])
    await rollback(importer)
    const { rows } = await importer.query<{ ws: string | null; who: string | null }>(
      `SELECT nullif(current_setting('app.workspace_id', true),'') AS ws,
              nullif(current_setting('app.principal_id', true),'') AS who`)
    expect(rows[0].ws).toBeNull()
    expect(rows[0].who).toBeNull()
  })

  it('CONNECTION REUSE: a revocation takes effect on the very next transaction', async () => {
    // Authorization is re-evaluated per transaction, never cached at connect
    // time. A long-lived pooled connection must not outlive its own grant.
    const ws = await freshWorkspace('reuse-revoke')
    const id = await grantCapability(admin, ws, principals.importer, 'archive-import', principals.grantor)
    await beginAuthorized(importer, ws.id, ['archive-import'])
    await commit(importer)
    await terminateGrant(operator, id, 'revoke', 'mid-session revocation')
    const result = await probeDetached(importer, () =>
      importer.query('SELECT identity.authorize_service_workspace($1, $2::identity.service_capability)',
        [ws.id, 'archive-import']))
    expect(result.code).toBe(INSUFFICIENT_PRIVILEGE)
  })

  it('the operator can see grants it must be able to terminate, including future ones', async () => {
    // `workspace_service_grants` uses `USING (true)` for the authority read
    // policy on purpose: a future or already-terminated grant that could not be
    // SEEN could not be cancelled, and the operator would be locked out of
    // exactly the rows it exists to manage.
    const ws = await freshWorkspace('visibility')
    const id = await grantCapability(admin, ws, principals.importer, 'archive-import',
      principals.grantor, { validFrom: new Date(Date.now() + 86_400_000).toISOString() })
    const result = await probeDetached(operator, () =>
      terminateGrant(operator, id, 'cancel', 'visibility check'))
    expect(result.code, 'the operator could not reach a future grant').toBeNull()
  })

  it('no runtime role can write the grant table directly', async () => {
    // Everything above goes through terminate_service_grant or the admin. If
    // the importer could INSERT here it could grant itself anything.
    const result = await probeDetached(importer, () =>
      importer.query(
        `INSERT INTO identity.workspace_service_grants
           (workspace_id, principal_id, capability, valid_from, granted_by)
         VALUES ($1,$2,'reconciliation'::identity.service_capability, now(), $3)`,
        [workspace.id, principals.importer.id, principals.grantor.id]))
    expect(result.code).toBe(INSUFFICIENT_PRIVILEGE)
  })

  it('granted_by is NOT NULL, and the fixture supplies it rather than the schema waiving it', async () => {
    // Item 3 of the round-2 findings, asserted rather than assumed: the first
    // fixture omitted this column, and the honest fix is to seed a grantor —
    // not to relax a production constraint so a test can pass.
    const { rows } = await admin.query<{ attnotnull: boolean }>(
      `SELECT attnotnull FROM pg_attribute
        WHERE attrelid = 'identity.workspace_service_grants'::regclass
          AND attname = 'granted_by'`)
    expect(rows[0].attnotnull).toBe(true)

    const orphaned = await admin.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM identity.workspace_service_grants g
        LEFT JOIN identity.principals p ON p.id = g.granted_by
       WHERE p.id IS NULL`)
    expect(orphaned.rows[0].n).toBe(0)
  })
})
