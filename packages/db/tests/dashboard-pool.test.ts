// THE DASHBOARD READ POOL — VALIDATION AND LIFECYCLE.
//
// Database-free. Every assertion here is about what happens BEFORE a socket is
// opened, or about singleton bookkeeping. Nothing connects.
//
// WHY THE ZERO-CONSTRUCTION PROOF MATTERS. "Throws on a bad credential" is not
// the property being bought. A pool that is constructed and then fails on first
// use has already resolved a destination, attached handlers and entered the
// module's singleton, and the S3B work showed how a credential path that gets
// that far becomes the thing every later guard is written around. So the tests
// below assert that for every rejected input, `pg.Pool` and `pg.Client` are
// constructed ZERO times.

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest'

// CONSTRUCTION COUNTERS, VIA A MODULE MOCK RATHER THAN A SPY.
//
// The first version of this file spied on the driver's Pool property. It counted
// zero every time — including for credentials that DO construct a pool — because
// src/pool.ts destructures the constructor at module load and then instantiates
// that local binding, never reading the property again. Every "constructs no
// pool" assertion was therefore passing vacuously, which is the precise failure
// the assertions exist to prevent. Mocking the MODULE replaces the binding
// src/pool.ts actually captured.
//
// The wording here avoids the literal construction spellings on purpose:
// testing/architecture-checks.ts scans source text, comments included, and
// flags them wherever they appear.
const built = { pools: 0, clients: 0 }
const lastPoolConfig: { value: unknown } = { value: undefined }

vi.mock('pg', async () => {
  const actual = (await vi.importActual<typeof import('pg')>('pg')).default
  class CountingPool extends actual.Pool {
    constructor(cfg?: unknown) { built.pools++; lastPoolConfig.value = cfg; super(cfg as never) }
  }
  class CountingClient extends actual.Client {
    constructor(cfg?: unknown) { built.clients++; super(cfg as never) }
  }
  const mocked = { ...actual, Pool: CountingPool, Client: CountingClient }
  return { default: mocked, ...mocked }
})

// AND WHY THE MODULE IS IMPORTED DYNAMICALLY.
//
// testing/vitest-db-isolation.ts is a setupFile and it imports ../src/pool.js,
// so pool.ts is evaluated — and its `const { Pool } = pg` binding is fixed to
// the REAL driver — before this file's vi.mock('pg') can apply. A static import
// here would hand back that already-bound module and the counters would read
// zero forever. vi.resetModules() discards the cached evaluation, and the
// dynamic import re-evaluates pool.ts against the mocked 'pg'.
let getDashboardPool!:   typeof import('../src/pool.js')['getDashboardPool']
let closeDashboardPool!: typeof import('../src/pool.js')['closeDashboardPool']
let getPool!:            typeof import('../src/pool.js')['getPool']
let closePool!:          typeof import('../src/pool.js')['closePool']
let poolModule!:         typeof import('../src/pool.js')

beforeAll(async () => {
  vi.resetModules()
  poolModule = await import('../src/pool.js')
  ;({ getDashboardPool, closeDashboardPool, getPool, closePool } = poolModule)
})

const VAR = 'DASHBOARD_DATABASE_URL'
/** A syntactically valid, disposable target. Never connected to. */
const VALID = 'postgres://dash@localhost:5432/ai_capital_dashboard_test'

const saved: Record<string, string | undefined> = {}
const TOUCHED = [VAR, 'DATABASE_URL', 'TEST_DATABASE_URL',
                 'PGDATABASE', 'PGHOST', 'PGUSER', 'PGPORT', 'USER']

/**
 * Synthetic ambient connection fields, set for EVERY test in this file.
 *
 * createPool() -> pinDestination() resolves a missing database through
 * PGDATABASE, then the connection-string user, then PGUSER, then USER. That is
 * correct libpq behaviour for the ordinary pool and a silent fallback for this
 * one. Setting these here means every rejection below is proven to hold WHILE a
 * complete ambient environment is available to rescue it — a rejection tested
 * with the environment empty would prove much less.
 */
const AMBIENT = {
  PGDATABASE: 'ambient_dashboard_db',
  PGHOST:     'ambient.host.example',
  PGUSER:     'ambient_user',
  PGPORT:     '5999',
  USER:       'ambient_os_user',
}

beforeEach(() => {
  for (const k of TOUCHED) { saved[k] = process.env[k]; delete process.env[k] }
  Object.assign(process.env, AMBIENT)
})

afterEach(async () => {
  await closeDashboardPool().catch(() => {})
  await closePool().catch(() => {})
  for (const k of TOUCHED) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k] as string
  }
  vi.restoreAllMocks()
})

/** Run `fn` and report how many pg objects it caused to be constructed. */
function underConstructionSpies(fn: () => void): { pools: number; clients: number } {
  const before = { pools: built.pools, clients: built.clients }
  try { fn() } catch { /* the throw is the point; counts are what we assert */ }
  return { pools: built.pools - before.pools, clients: built.clients - before.clients }
}

// NON-VACUITY FOR THE COUNTER ITSELF. If the mock were not intercepting, every
// "constructs no pool" assertion below would pass while proving nothing — so
// prove first that a VALID credential does increment it.
describe('the construction counter actually counts', () => {
  it('a valid credential constructs exactly one pool', () => {
    process.env[VAR] = VALID
    const { pools } = underConstructionSpies(() => getDashboardPool())
    expect(pools, 'the pg module mock is not intercepting construction').toBe(1)
  })
})

describe('DASHBOARD_DATABASE_URL validation — rejection is total and early', () => {
  const REJECTED: Array<[string, string | undefined]> = [
    ['undefined (unset)',            undefined],
    ['empty string',                 ''],
    ['spaces only',                  '   '],
    ['tab and newline only',         '\t\n'],
    ['leading whitespace',           ` ${VALID}`],
    ['trailing whitespace',          `${VALID} `],
    ['not a URL at all',             'not-a-url'],
    ['bare word',                    'localhost'],
    ['a Prisma SQLite file: URL',    'file:./prisma/dev.db'],
    ['http',                         'http://example.test/db'],
    ['https',                        'https://example.test/db'],
    ['redis',                        'redis://localhost:6379'],
    ['mysql',                        'mysql://u@localhost/db'],
    ['postgres-ish but wrong scheme','postgress://u@localhost/db'],
    // ── INCOMPLETE POSTGRESQL URLS ────────────────────────────────────────
    // Each of these passes scheme validation and would be COMPLETED from the
    // AMBIENT values above by pinDestination(). Measured, not predicted:
    // `postgres:foo` parses to database "oo".
    ['scheme-relative garbage',      'postgres:foo'],
    ['scheme + path only',           'postgres:/db'],
    ['no host, no user',             'postgres:///db'],
    ['scheme and nothing else',      'postgres://'],
    ['host only',                    'postgres://host.example'],
    ['host with empty path',         'postgres://host.example/'],
    ['user and host, no database',   'postgres://user@host.example'],
    ['host and database, no user',   'postgres://host.example/database'],
    ['database only, no host/user',  'postgresql:///database'],
    ['socket host but no user',      'postgresql:///database?host=/var/run/postgresql'],
    ['user and database, no host',   'postgresql://dashboard@/database'],
  ]

  for (const [name, value] of REJECTED) {
    it(`refuses ${name}`, () => {
      if (value !== undefined) process.env[VAR] = value
      expect(() => getDashboardPool()).toThrow()
    })

    it(`constructs no pool and no client for ${name}`, () => {
      if (value !== undefined) process.env[VAR] = value
      const { pools, clients } = underConstructionSpies(() => getDashboardPool())
      expect(pools, 'a pg.Pool was constructed for an invalid credential').toBe(0)
      expect(clients, 'a pg.Client was constructed for an invalid credential').toBe(0)
    })
  }

  it('whitespace-only is rejected AS EMPTY, not incidentally by the trim check', () => {
    // MUTATION CONTROL. Narrowing the emptiness test to `raw === ''` leaves
    // '   ' to be caught further down by the leading/trailing-whitespace rule —
    // still rejected, but for the wrong reason and with the wrong message. That
    // mutant survived a test that only asserted "it throws", so the REASON is
    // pinned here: an operator who blanked a credential must be told it is
    // empty, not that it is badly formatted.
    for (const blank of ['   ', '\t', '\n', ' \t\n ']) {
      process.env[VAR] = blank
      expect(() => getDashboardPool(), `\`${JSON.stringify(blank)}\` must read as empty`)
        .toThrow(/is empty or whitespace-only/)
    }
  })

  it('no ambient variable rescues an incomplete URL', () => {
    // The property stated directly rather than as a side effect of the table:
    // with a COMPLETE ambient environment present, every incomplete URL is still
    // refused, and refused BEFORE construction.
    expect(process.env.PGDATABASE).toBe(AMBIENT.PGDATABASE)
    expect(process.env.PGUSER).toBe(AMBIENT.PGUSER)
    expect(process.env.PGHOST).toBe(AMBIENT.PGHOST)
    expect(process.env.USER).toBe(AMBIENT.USER)

    // TWO RULES CATCH THESE, and which one catches which is itself the contract.
    //
    // Scheme-relative shapes never reach the component check: they are not
    // written `scheme://` at all. `postgres:foo` matters because the WHATWG
    // parser calls it a valid postgres: URL and pg-connection-string reads its
    // database as "oo" — a typo would have connected somewhere real.
    const BAD_SCHEME_FORM = ['postgres:foo', 'postgres:/db']
    // Well-formed `scheme://` URLs that simply do not say enough. Each of these
    // would be completed from AMBIENT above by pinDestination().
    const MISSING_COMPONENTS = [
      'postgres:///db', 'postgres://',
      'postgres://host.example', 'postgres://host.example/',
      'postgres://user@host.example', 'postgres://host.example/database',
      'postgresql:///database',
    ]

    for (const [group, pattern] of [
      [BAD_SCHEME_FORM,    /must be a PostgreSQL URL beginning/],
      [MISSING_COMPONENTS, /must state its .*explicitly/],
    ] as const) {
      for (const incomplete of group) {
        process.env[VAR] = incomplete
        expect(() => getDashboardPool(), `${incomplete} was not refused`).toThrow(pattern)
        const { pools, clients } = underConstructionSpies(() => getDashboardPool())
        expect(pools, `${incomplete} constructed a pool`).toBe(0)
        expect(clients, `${incomplete} constructed a client`).toBe(0)
      }
    }
    // NON-VACUITY: both groups were actually exercised.
    expect(BAD_SCHEME_FORM.length + MISSING_COMPONENTS.length).toBe(9)
  })

  it('names which components were missing, without echoing the value', () => {
    process.env[VAR] = 'postgres://host.example'
    try {
      getDashboardPool()
      throw new Error('should have thrown')
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      expect(msg).toContain('user')
      expect(msg).toContain('database')
      expect(msg).not.toContain('host.example')
    }
  })

  it('the file: case is called out by name — it is the hazard this seam exists for', () => {
    // In the Unified Platform process DATABASE_URL *is* a Prisma SQLite file URL.
    // A fallback would hand `pg` a file path; this must never resolve.
    process.env[VAR] = 'file:./prisma/dev.db'
    expect(() => getDashboardPool()).toThrow(/PostgreSQL URL|scheme/i)
  })

  it('error messages never contain the rejected value', () => {
    const secretish = 'postgres://user:hunter2@db.internal:5432/ai_capital'
    process.env[VAR] = ` ${secretish}`            // rejected for whitespace
    try {
      getDashboardPool()
      throw new Error('should have thrown')
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      expect(msg).not.toContain('hunter2')
      expect(msg).not.toContain(secretish)
      expect(msg).toContain(VAR)                  // it does name the variable
    }
  })
})

describe('DASHBOARD_DATABASE_URL has no fallback', () => {
  for (const other of ['DATABASE_URL', 'TEST_DATABASE_URL']) {
    it(`does not fall back to ${other}`, () => {
      process.env[other] = VALID                  // set the OTHER variable only
      expect(() => getDashboardPool()).toThrow(new RegExp(VAR))
      const { pools } = underConstructionSpies(() => getDashboardPool())
      expect(pools).toBe(0)
    })
  }

  it('does not fall back to PGDATABASE/PGHOST', () => {
    process.env.PGDATABASE = 'ai_capital'
    process.env.PGHOST = 'localhost'
    expect(() => getDashboardPool()).toThrow(new RegExp(VAR))
  })
})

describe('accepted credentials reach createPool unchanged', () => {
  for (const scheme of ['postgres', 'postgresql']) {
    it(`accepts a ${scheme}: URL`, () => {
      process.env[VAR] = `${scheme}://dash@localhost:5432/ai_capital_dashboard_test`
      expect(() => getDashboardPool()).not.toThrow()
    })
  }

  it('passes the ORIGINAL string through, byte for byte', () => {
    // Not parsed.href, not normalised. URL round-tripping can alter
    // percent-encoding, and a rewritten database name is exactly what
    // assertNotLiveDatabase() exists to catch.
    const url = 'postgresql://dash@localhost:5432/ai_capital_dashboard_test?application_name=dash'
    process.env[VAR] = url
    const before = built.pools
    getDashboardPool()
    expect(built.pools - before).toBe(1)
    const cfg = lastPoolConfig.value as { connectionString?: string }
    expect(cfg.connectionString).toBe(url)
  })

  it('accepts an explicit Unix-socket URL that supplies user, host and database', () => {
    process.env[VAR] =
      'postgresql://dashboard@/ai_capital_dashboard_test?host=%2Fvar%2Frun%2Fpostgresql'
    expect(() => getDashboardPool()).not.toThrow()
  })

  it('does NOT require a password — passwordless auth and .pgpass stay operator choices', () => {
    process.env[VAR] = 'postgres://dashboard@localhost:5432/ai_capital_dashboard_test'
    expect(() => getDashboardPool()).not.toThrow()
  })

  it('still refuses a live database, so createPool’s guards are not bypassed', () => {
    // Validation precedes the existing guards; it does not replace them.
    process.env[VAR] = 'postgres://dash@localhost:5432/ai_capital'
    expect(() => getDashboardPool()).toThrow(/live database/i)
  })
})

describe('the two pools are independent singletons', () => {
  it('getDashboardPool is idempotent while open', () => {
    process.env[VAR] = VALID
    expect(getDashboardPool()).toBe(getDashboardPool())
  })

  it('the dashboard pool and the ordinary pool are different objects', () => {
    process.env[VAR] = VALID
    process.env.DATABASE_URL = 'postgres://app@localhost:5432/ai_capital_ordinary_test'
    const dash = getDashboardPool()
    const ord  = getPool()
    expect(dash).not.toBe(ord)
  })

  it('closePool() closes ONLY the ordinary pool', async () => {
    process.env[VAR] = VALID
    process.env.DATABASE_URL = 'postgres://app@localhost:5432/ai_capital_ordinary_test'
    const dash = getDashboardPool()
    getPool()
    await closePool()
    // Still the same live object, still addressable — the leak is visible, not latent.
    expect(getDashboardPool()).toBe(dash)
  })

  it('closeDashboardPool() closes ONLY the dashboard pool', async () => {
    process.env[VAR] = VALID
    process.env.DATABASE_URL = 'postgres://app@localhost:5432/ai_capital_ordinary_test'
    const ord = getPool()
    getDashboardPool()
    await closeDashboardPool()
    expect(getPool()).toBe(ord)
  })

  it('there is no closeAllPools — the API surface stays minimal', () => {
    expect(Object.keys(poolModule)).not.toContain('closeAllPools')
  })
})

describe('closeDashboardPool clears the singleton only after end() resolves', () => {
  it('a successful close is followed by a FRESH pool', async () => {
    process.env[VAR] = VALID
    const first = getDashboardPool()
    vi.spyOn(first, 'end').mockResolvedValue(undefined)
    await closeDashboardPool()
    const second = getDashboardPool()
    expect(second).not.toBe(first)
  })

  it('a REJECTED end() keeps the pool addressable so cleanup can be retried', async () => {
    // Round 8's lesson, applied to the second pool. Clearing the singleton first
    // — or in a `finally` — would orphan a pool that is still open and no longer
    // reachable, making the leak invisible and the retry impossible.
    process.env[VAR] = VALID
    const pool = getDashboardPool()
    const end = vi.spyOn(pool, 'end').mockRejectedValueOnce(new Error('end failed'))
    await expect(closeDashboardPool()).rejects.toThrow('end failed')
    expect(getDashboardPool(), 'the pool was orphaned by a failed close').toBe(pool)
    // And the retry succeeds.
    end.mockResolvedValue(undefined)
    await expect(closeDashboardPool()).resolves.toBeUndefined()
    expect(getDashboardPool()).not.toBe(pool)
  })

  it('closing when nothing is open is a no-op, not an error', async () => {
    await expect(closeDashboardPool()).resolves.toBeUndefined()
  })
})
