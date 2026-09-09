import { describe, it, expect, afterAll } from 'vitest'
import type pg from 'pg'
import { createClient } from '../../src/pool.js'

// Privilege-drift regression check for the Phase 1 role separation.
//
// WHY. Every application-level guard in this repo has now been bypassed at
// least once — %5F, socket:, LIVE_DATABASE_NAMES. The database authority model
// is the layer that makes such a miss non-destructive, so it needs its own
// regression coverage: a role quietly gaining SUPERUSER or production CONNECT
// would silently undo the whole boundary and nothing else would notice.
//
// Deliberately small. This is a focused drift check, not an IAM subsystem.
//
// It runs against whatever database the test runtime is connected to, and reads
// only cluster-wide catalogs (pg_roles, pg_auth_members) which are visible from
// any database. It never needs production access to verify production is safe.

const RESTRICTED = ['ai_capital_agent', 'ai_capital_test_runtime'] as const
const PRIVILEGED = 'thanapold'
const PRODUCTION = 'ai_capital'

function url(): string {
  const u = process.env.TEST_DATABASE_URL
  if (!u) throw new Error('TEST_DATABASE_URL not set — global setup should have provided it')
  return u
}

let client: pg.Client | null = null
async function db(): Promise<pg.Client> {
  if (!client) { client = createClient(url()); await client.connect() }
  return client
}
afterAll(async () => { await client?.end().catch(() => {}); client = null })

// ─────────────────────────────────────────────────────────────────────────────
// PRODUCTION ACL EVIDENCE IS NOT AVAILABLE IN A DISPOSABLE CLUSTER (Round 9).
//
// `has_database_privilege('role', 'ai_capital', 'CONNECT')` does not return
// false when `ai_capital` is absent — it RAISES `database "ai_capital" does not
// exist`. The 2026-09-08 disposable-cluster gate failed three tests on exactly
// that, and the tempting "fix" is the dangerous one: catching the error and
// asserting `false` would turn "production is not here to look at" into
// "production is safe", which is a fabricated pass on the single most
// consequential assertion in this file.
//
// So production ACL facts are gated on production actually existing, every call
// goes through `productionAcl()`, and absence is REPORTED as unavailable rather
// than converted into evidence. A disposable run therefore shows these as
// skipped with a reason, never as passing.
// ─────────────────────────────────────────────────────────────────────────────

/** Does the production database exist in THIS cluster? Asked, never assumed. */
async function productionExists(): Promise<boolean> {
  const { rows } = await (await db()).query(
    'SELECT 1 FROM pg_database WHERE datname = $1', [PRODUCTION])
  return rows.length > 0
}

/**
 * The ONLY place has_database_privilege may name the production database.
 *
 * Throws rather than returning a default when production is absent: a caller
 * that forgot to gate gets a loud failure, not a comfortable `false`.
 */
async function productionAcl(grantee: string): Promise<boolean> {
  if (!(await productionExists())) {
    throw new Error(
      `refusing to report a production ACL fact for "${grantee}": the database ` +
      `"${PRODUCTION}" does not exist in this cluster, so there is no evidence to ` +
      'report. Absence is not proof of safety.',
    )
  }
  const { rows } = await (await db()).query<{ can: boolean }>(
    'SELECT has_database_privilege($1, $2, $3) AS can', [grantee, PRODUCTION, 'CONNECT'])
  return rows[0].can
}

describe('the test process itself holds no privileged credential', () => {
  it('authenticates as the restricted runtime role, not a superuser', async () => {
    const { rows } = await (await db()).query<{ u: string; su: boolean }>(
      'SELECT current_user AS u, (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS su',
    )
    expect(rows[0].u).toBe('ai_capital_test_runtime')
    expect(rows[0].su).toBe(false)
  })

  it('is not connected to production', async () => {
    const { rows } = await (await db()).query<{ d: string }>('SELECT current_database() AS d')
    expect(rows[0].d).not.toBe(PRODUCTION)
  })

  it('cannot see the privileged credential in its environment', () => {
    // global-setup deletes DATABASE_URL after bootstrap so test code cannot
    // pick the superuser URL back up.
    expect(process.env.DATABASE_URL).toBeFalsy()
  })
})

describe('restricted roles have not drifted', () => {
  it.each(RESTRICTED)('%s holds no privileged role attribute', async role => {
    const { rows } = await (await db()).query(
      `SELECT rolsuper, rolcreatedb, rolcreaterole, rolbypassrls, rolreplication, rolcanlogin
         FROM pg_roles WHERE rolname = $1`, [role])
    expect(rows, `${role} does not exist`).toHaveLength(1)
    const r = rows[0]
    expect(r.rolsuper,       `${role} became SUPERUSER`).toBe(false)
    expect(r.rolcreatedb,    `${role} gained CREATEDB`).toBe(false)
    expect(r.rolcreaterole,  `${role} gained CREATEROLE`).toBe(false)
    expect(r.rolbypassrls,   `${role} gained BYPASSRLS`).toBe(false)
    expect(r.rolreplication, `${role} gained REPLICATION`).toBe(false)
    expect(r.rolcanlogin).toBe(true)
  })

  it.each(RESTRICTED)('%s belongs to no role — no SET ROLE escalation path', async role => {
    // Ownership is the escape hatch grants cannot close: thanapold owns every
    // production object, so membership in it would hand over everything.
    const { rows } = await (await db()).query(
      `SELECT g.rolname AS granted
         FROM pg_auth_members m
         JOIN pg_roles r ON r.oid = m.member
         JOIN pg_roles g ON g.oid = m.roleid
        WHERE r.rolname = $1`, [role])
    expect(rows.map(r => r.granted), `${role} gained role membership`).toEqual([])
  })

  it('only the expected role is a superuser', async () => {
    const { rows } = await (await db()).query<{ rolname: string }>(
      `SELECT rolname FROM pg_roles WHERE rolsuper AND rolname NOT LIKE 'pg\\_%' ORDER BY 1`)
    expect(rows.map(r => r.rolname)).toEqual([PRIVILEGED])
  })
})

// PRODUCTION-ONLY ACL FACTS. Available only in a cluster that actually contains
// `ai_capital`; reported as unavailable everywhere else. These never CONNECT to
// production — they read the catalogue from the current session.
describe('production ACL evidence', () => {
  it('states plainly whether production ACL evidence is available here', async () => {
    const present = await productionExists()
    if (!present) {
      // Not a pass for production safety — a statement that the evidence is
      // absent, asserted against the catalogue rather than assumed.
      const { rows } = await (await db()).query<{ n: string }>(
        'SELECT count(*)::text AS n FROM pg_database WHERE datname = $1', [PRODUCTION])
      expect(rows[0].n, 'production was expected to be absent').toBe('0')
      await expect(productionAcl('ai_capital_test_runtime'))
        .rejects.toThrow(/Absence is not proof of safety/)
      return
    }
    expect(present).toBe(true)
  })

  it('ai_capital_test_runtime cannot CONNECT to production', async ctx => {
    if (!(await productionExists())) {
      ctx.skip(`NOT APPLICABLE: "${PRODUCTION}" is absent from this cluster; ` +
        'production ACL evidence is UNAVAILABLE, not satisfied.')
      return
    }
    expect(await productionAcl('ai_capital_test_runtime'),
      'test runtime gained production CONNECT').toBe(false)
  })

  it('PUBLIC cannot CONNECT to production — no role inherits it for free', async ctx => {
    if (!(await productionExists())) {
      ctx.skip(`NOT APPLICABLE: "${PRODUCTION}" is absent; evidence UNAVAILABLE.`)
      return
    }
    expect(await productionAcl('public'), 'PUBLIC regained production CONNECT').toBe(false)
  })

  it('ai_capital_agent retains production CONNECT for analysis', async ctx => {
    // Only database-level privilege is checkable from here: has_table_privilege
    // resolves object names in the CURRENT database, so production table grants
    // cannot be verified from inside a disposable database.
    if (!(await productionExists())) {
      ctx.skip(`NOT APPLICABLE: "${PRODUCTION}" is absent; evidence UNAVAILABLE.`)
      return
    }
    expect(await productionAcl('ai_capital_agent'), 'agent lost production read access').toBe(true)
  })
})
