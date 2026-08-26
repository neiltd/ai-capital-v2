import { describe, it, expect, afterAll } from 'vitest'
import type pg from 'pg'
import { createClient } from '../src/pool.js'

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

  it('ai_capital_test_runtime cannot CONNECT to production', async () => {
    // The load-bearing assertion of Phase 1. Checked via catalog rather than by
    // attempting a connection, so it works from inside the test database.
    const { rows } = await (await db()).query<{ can: boolean }>(
      'SELECT has_database_privilege($1, $2, $3) AS can',
      ['ai_capital_test_runtime', PRODUCTION, 'CONNECT'])
    expect(rows[0].can, 'test runtime gained production CONNECT').toBe(false)
  })

  it('PUBLIC cannot CONNECT to production — no role inherits it for free', async () => {
    const { rows } = await (await db()).query<{ can: boolean }>(
      'SELECT has_database_privilege($1, $2, $3) AS can', ['public', PRODUCTION, 'CONNECT'])
    expect(rows[0].can, 'PUBLIC regained production CONNECT').toBe(false)
  })

  it('ai_capital_agent retains production CONNECT for analysis', async () => {
    // Only database-level privilege is checkable from here: has_table_privilege
    // resolves object names in the CURRENT database, so production table grants
    // cannot be verified from inside ai_capital_test. Those are covered by the
    // negative privilege tests run with the agent's own credential (see the
    // Phase 1 report) rather than asserted here on a same-named test table.
    const { rows } = await (await db()).query<{ can: boolean }>(
      'SELECT has_database_privilege($1, $2, $3) AS can', ['ai_capital_agent', PRODUCTION, 'CONNECT'])
    expect(rows[0].can, 'agent lost production read access').toBe(true)
  })

  it('only the expected role is a superuser', async () => {
    const { rows } = await (await db()).query<{ rolname: string }>(
      `SELECT rolname FROM pg_roles WHERE rolsuper AND rolname NOT LIKE 'pg\\_%' ORDER BY 1`)
    expect(rows.map(r => r.rolname)).toEqual([PRIVILEGED])
  })
})
