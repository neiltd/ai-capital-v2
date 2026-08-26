import { describe, it, expect, afterEach } from 'vitest'
import { assertNotLiveDatabase, inTestRuntime, usePostgres, getPool } from '../src/pool.js'

// Regression protection for the 2026-08-25 incident: a `pnpm -r test` run with
// DATABASE_URL exported wrote fixture rows into the REAL portfolio — a
// fabricated NVDA position (100 sh @ $68.50 = $9,200) in portfolio.positions,
// plus rows in capital.fetch_log and capital.pending_manual_input.
//
// The invariant under test:
//   No test may read from or write to the live database merely because
//   DATABASE_URL is present in the shell environment.

const LIVE = 'postgres://thanapold@localhost:5432/ai_capital'

describe('the guard refuses a test process a live connection', () => {
  it('knows it is running inside vitest', () => {
    // Everything below depends on this being true, so assert it directly rather
    // than letting the guards silently no-op.
    expect(inTestRuntime()).toBe(true)
  })

  it('throws on the live database, by name', () => {
    expect(() => assertNotLiveDatabase(LIVE)).toThrow(/refusing to connect a TEST process to the live database "ai_capital"/)
  })

  it('is not fooled by host, port, user or query-string differences', () => {
    // Only the database name matters — the same book is reachable many ways.
    expect(() => assertNotLiveDatabase('postgres://other@127.0.0.1:5433/ai_capital?sslmode=require')).toThrow(/live database/)
    expect(() => assertNotLiveDatabase('postgresql://u:p@db.internal/ai_capital')).toThrow(/live database/)
  })

  it('is case-insensitive about the database name', () => {
    expect(() => assertNotLiveDatabase('postgres://localhost/AI_CAPITAL')).toThrow(/live database/)
  })

  it('refuses percent-encoded spellings of the live name — the proven bypass', () => {
    // pg-connection-string decodes the pathname; a naive URL().pathname compare
    // does not. `ai%5Fcapital` reached the real book past the first version of
    // this guard.
    expect(() => assertNotLiveDatabase('postgres://x@localhost:5432/ai%5Fcapital')).toThrow(/live database/)
    expect(() => assertNotLiveDatabase('postgres://x@localhost:5432/AI%5FCAPITAL')).toThrow(/live database/)
    expect(() => assertNotLiveDatabase('postgres://x@localhost:5432/%61i_capital')).toThrow(/live database/)   // 'a'
    expect(() => assertNotLiveDatabase('postgres://x@localhost:5432/ai%255Fcapital')).toThrow(/live database/) // double-encoded
  })

  it('refuses a trailing slash or padding that disguises the name', () => {
    expect(() => assertNotLiveDatabase('postgres://x@localhost:5432/ai_capital/')).toThrow(/live database/)
    expect(() => assertNotLiveDatabase('postgres://x@localhost:5432/ai_capital%20')).toThrow(/live database/)
  })

  it('refuses the libpq keyword/value form', () => {
    expect(() => assertNotLiveDatabase("host=localhost port=5432 dbname=ai_capital user=x")).toThrow(/keyword\/value/)
    expect(() => assertNotLiveDatabase("host=localhost dbname='ai_capital'")).toThrow(/keyword\/value/)
  })

  it('refuses control characters rather than letting the wire protocol be the only defence', () => {
    // %00 previously reached pg and was stopped only by "invalid startup packet".
    expect(() => assertNotLiveDatabase('postgres://x@localhost:5432/ai_capital%00')).toThrow(/unparseable connection string/)
    expect(() => assertNotLiveDatabase('postgres://x@localhost:5432/ai_capital%00zzz')).toThrow(/unparseable connection string/)
  })

  it('FAILS CLOSED when no database can be determined', () => {
    // "Cannot prove safe" must never mean "allowed" — the downside is a real book.
    expect(() => assertNotLiveDatabase('')).toThrow(/unparseable connection string/)
    expect(() => assertNotLiveDatabase('postgres://')).toThrow(/unparseable connection string/)
    expect(() => assertNotLiveDatabase('postgres://host:5432')).toThrow(/unparseable connection string/)
  })

  it('treats a bare word as a database name, because that is what the driver does', () => {
    // pg-connection-string parses 'scratchpad' as database='scratchpad', and pg
    // will genuinely attempt to connect to a database of that name. The guard
    // mirrors the driver rather than second-guessing it — so a bare word that
    // is NOT live is allowed, and one that IS live is refused.
    expect(() => assertNotLiveDatabase('scratchpad')).not.toThrow()
    expect(() => assertNotLiveDatabase('ai_capital')).toThrow(/live database/)
  })

  it('refuses the socket: form, where the driver reads ?db= and a pathname check does not', () => {
    // Warden's proven bypass: pg-connection-string's socket: branch takes the
    // database from ?db= while `new URL().pathname` says "tmp". A test process
    // was handed a pool on the LIVE book through this.
    expect(() => assertNotLiveDatabase('socket:/tmp?db=ai_capital')).toThrow(/live database/)
    expect(() => assertNotLiveDatabase('socket://x/tmp?db=ai_capital')).toThrow(/live database/)
    expect(() => assertNotLiveDatabase('socket:/tmp?db=ai%5Fcapital')).toThrow(/live database/)
    expect(() => assertNotLiveDatabase('socket:/tmp?db=AI_CAPITAL')).toThrow(/live database/)
  })

  it('still allows a socket: URL naming a throwaway database', () => {
    expect(() => assertNotLiveDatabase('socket:/tmp?db=ai_capital_test')).not.toThrow()
  })

  it('allows a throwaway test database', () => {
    expect(() => assertNotLiveDatabase('postgres://thanapold@localhost:5432/ai_capital_test')).not.toThrow()
  })

  it('allows an unrelated database', () => {
    expect(() => assertNotLiveDatabase('postgres://x@localhost:5432/some_other_app')).not.toThrow()
    expect(() => assertNotLiveDatabase('postgres://x@localhost:5432/ai_capital_scratch')).not.toThrow()
  })

  it('treats a set-but-empty LIVE_DATABASE_NAMES as a config error, not as "nothing is protected"', () => {
    // '   ' and ',' previously disabled EVERY layer at once, silently.
    const prev = process.env.LIVE_DATABASE_NAMES
    try {
      for (const hostile of ['', '   ', ',', ' , , ']) {
        process.env.LIVE_DATABASE_NAMES = hostile
        expect(() => assertNotLiveDatabase('postgres://x@localhost:5432/ai_capital'))
          .toThrow(/set but empty after parsing/)
      }
    } finally {
      if (prev === undefined) delete process.env.LIVE_DATABASE_NAMES
      else process.env.LIVE_DATABASE_NAMES = prev
    }
  })

  it('honours LIVE_DATABASE_NAMES when a second live database is added', () => {
    const prev = process.env.LIVE_DATABASE_NAMES
    process.env.LIVE_DATABASE_NAMES = 'ai_capital,ai_capital_prod'
    try {
      expect(() => assertNotLiveDatabase('postgres://localhost/ai_capital_prod')).toThrow(/live database/)
    } finally {
      if (prev === undefined) delete process.env.LIVE_DATABASE_NAMES
      else process.env.LIVE_DATABASE_NAMES = prev
    }
  })
})

describe('the setup file cleared the inherited environment', () => {
  it('DATABASE_URL does not point at the live book inside a test', () => {
    const url = process.env.DATABASE_URL
    if (!url) {
      expect(url).toBeUndefined()   // the normal case: cleared outright
      return
    }
    expect(new URL(url).pathname.replace(/^\//, '').toLowerCase()).not.toBe('ai_capital')
  })

  it('an explicitly configured test database wins in test context', () => {
    // This is the property that lets the claim-lifecycle tests use real
    // Postgres safely while everything else falls back to SQLite.
    expect(process.env.TEST_DATABASE_URL).toBeTruthy()
    expect(process.env.TEST_DATABASE_URL).toMatch(/_test$/)
    expect(usePostgres()).toBe(true)
  })

  it('getPool connects to the test database, never the live one', async () => {
    const { rows } = await getPool().query<{ db: string }>('SELECT current_database() AS db')
    expect(rows[0].db).toBe(new URL(process.env.TEST_DATABASE_URL!).pathname.replace(/^\//, ''))
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
