import { describe, it, expect, afterEach } from 'vitest'
import { usePostgres, getPool, databaseNameOfRaw } from '../../src/pool.js'
import { assertDisposableName } from '../../testing/preflight.js'

// LIVE POSTGRES. Runs ONLY under vitest.integration.config.ts.
//
// These three assertions moved here verbatim from tests/db-isolation.test.ts
// when the database-free and integration suites were separated. They are the
// direct regression protection for the 2026-08-25 contamination — a fixture
// write must land in the test database and never in the live book — so they
// were preserved rather than weakened or dropped. What changed is only WHICH
// command runs them: `test:integration`, which states its database dependency
// in its name, instead of a default `test` that silently acquired credentials.

describe('the setup file cleared the inherited environment', () => {
  // The purely static half of this describe stays in tests/db-isolation.test.ts;
  // only the two assertions that need a populated TEST_DATABASE_URL live here.

  it('an explicitly configured test database wins in test context', () => {
    // This is the property that lets the claim-lifecycle tests use real
    // Postgres safely while everything else falls back to SQLite.
    //
    // ROUND 9. This used to assert `/_test$/` against the WHOLE URL. That is
    // not a database-name check: it is a check that the string ENDS in the
    // name, which is false for every URL this repository actually uses —
    // `postgresql://user@/ai_capital_ledger_round4_test?host=/tmp/s&port=5433`
    // ends in the port. The 2026-09-08 gate failed on exactly that. The name is
    // now extracted with the repository's own connection-string helper and run
    // through the repository's ONE disposable-name policy.
    expect(process.env.TEST_DATABASE_URL).toBeTruthy()
    const name = databaseNameOfRaw(process.env.TEST_DATABASE_URL!)
    expect(name, 'the runtime URL names no database').toBeTruthy()
    expect(assertDisposableName(name), 'not an authorized disposable database').toBe(name)
    expect(usePostgres()).toBe(true)
  })

  it('getPool connects to the test database, never the live one', async () => {
    // ROUND 9. `new URL()` cannot parse the socket form this repository uses:
    // the WHATWG parser has no notion of `?host=/var/run/postgresql`, and it
    // threw rather than returning a name. The driver's own parser is the only
    // thing that agrees with what the driver will connect to.
    const expected = databaseNameOfRaw(process.env.TEST_DATABASE_URL!)
    const { rows } = await getPool().query<{ db: string }>('SELECT current_database() AS db')
    expect(rows[0].db, 'the session landed in a different database than the URL names')
      .toBe(expected)
    expect(rows[0].db).not.toBe('ai_capital')
  })
})

describe('a fixture write lands in the test database, not the live book', () => {
  const FIXTURE = '__ISOLATION_PROBE__'

  afterEach(async () => {
    await getPool().query('DELETE FROM portfolio.positions WHERE ticker = $1', [FIXTURE])
  })

  it('writes are visible in the test database', async () => {
    // Deliberately mirrors the shape of the write that caused the incident.
    await getPool().query(
      `INSERT INTO portfolio.positions (ticker, company, shares, avg_cost, updated_at)
       VALUES ($1, 'isolation probe', 100, 68.50, now())
       ON CONFLICT (ticker) DO NOTHING`,
      [FIXTURE],
    )
    const { rows } = await getPool().query(
      'SELECT current_database() AS db, count(*)::int AS n FROM portfolio.positions WHERE ticker = $1 GROUP BY 1',
      [FIXTURE],
    )
    expect(rows[0].n).toBe(1)
    expect(rows[0].db).not.toBe('ai_capital')   // the whole point
  })
})
