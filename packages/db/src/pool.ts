import pg from 'pg'
import { parse as parseConnectionString } from 'pg-connection-string'

const { Pool } = pg
export type { Pool as PgPool } from 'pg'

let _pool: pg.Pool | null = null


// ── Live-database guard ───────────────────────────────────────────────────
//
// WHY THIS EXISTS. On 2026-08-25 a full `pnpm -r test` run with DATABASE_URL
// exported wrote test fixtures into the REAL portfolio: a fabricated NVDA
// position (100 sh @ $68.50) landed in portfolio.positions, plus rows in
// capital.fetch_log and capital.pending_manual_input. Tonight's briefing would
// have reported a $9,200 holding that does not exist, on a real-money book.
//
// The root cause is environment precedence: `usePostgres()` is just
// `!!process.env.DATABASE_URL`, and six store factories branch on it — so a
// test handing `createPortfolioStore('/tmp/fixture.db')` an explicit fixture
// path silently got Postgres instead, because the developer's shell happened to
// have the variable set. CLAUDE.md actively encourages exporting it.
//
// The first line of defence is the shared vitest setup (testing/vitest-db-isolation.ts)
// which clears DATABASE_URL so every store takes its file path. THIS is the
// backstop for when that is bypassed — a test that sets the variable itself, a
// package whose config forgot the setup file, a future runner. It fails loudly
// rather than silently mutating the book.
//
// Tests that legitimately need Postgres set TEST_DATABASE_URL and point it at a
// throwaway database (ai_capital_test).

/**
 * Databases that must never be touched from a test process.
 *
 * THE single definition — the testing helpers import this rather than keeping
 * their own copies. Three divergent copies previously existed and disagreed
 * about the empty case, which meant `LIVE_DATABASE_NAMES=""` disabled some
 * layers but not others.
 *
 * A set-but-empty value is a CONFIGURATION ERROR, not "nothing is protected".
 * `LIVE_DATABASE_NAMES="   "` or `","` used to silently disable every guard at
 * once — an env var that turns off a real-money safety check when blank is the
 * same failure class as an empty-array fallback.
 */
/**
 * Databases that can never be removed from protection. The env var EXTENDS this
 * set; it cannot replace it.
 *
 * The previous version returned the configured list verbatim, so any non-empty
 * value that omitted `ai_capital` silently disabled every layer at once —
 * including `LIVE_DATABASE_NAMES=ai_capital_prod`, which is precisely the
 * mistake someone makes when adding a SECOND live database. Warden connected a
 * test-runtime pool to the live book through it. A floor makes that impossible
 * to express.
 */
const ALWAYS_LIVE = ['ai_capital'] as const

export function liveDatabaseNames(): string[] {
  const configured = process.env.LIVE_DATABASE_NAMES
  if (configured === undefined) return [...ALWAYS_LIVE]
  const extra = configured.split(',').map(n => n.trim().toLowerCase()).filter(Boolean)
  if (extra.length === 0) {
    throw new Error(
      '@common/db: LIVE_DATABASE_NAMES is set but empty after parsing ' +
      `(${JSON.stringify(configured)}). Refusing to run with NO protected databases. ` +
      'Unset it to use the default, or name at least one database.',
    )
  }
  // Union, never replacement.
  return [...new Set([...ALWAYS_LIVE, ...extra])]
}

/**
 * The database name a driver would actually connect to, canonicalised.
 *
 * `pg-connection-string` percent-DECODES the pathname; a naive
 * `URL().pathname` comparison does not. That gap was a proven bypass:
 * `postgres://…/ai%5Fcapital` sailed past the guard and connected straight to
 * `ai_capital`. Decode before comparing, and keep decoding while the string
 * still changes so a double-encoded form cannot hide either.
 *
 * Returns `null` only when the input is not a parseable URL — and callers must
 * treat that as UNSAFE, not as permission. See assertNotLiveDatabase.
 */
export function databaseNameOf(connectionString: string): string | null {
  const raw = databaseNameOfRaw(connectionString)
  return raw ? raw.toLowerCase() : null
}

/** As `databaseNameOf`, preserving case — Postgres database names are case-sensitive. */
export function databaseNameOfRaw(connectionString: string): string | null {
  try {
    // Use the DRIVER'S OWN parser, not a hand-rolled one. Two bypasses came
    // from reimplementing it: `%5F` (pg decodes the pathname, `new URL()` does
    // not) and `socket:/tmp?db=ai_capital` (pg's socket: branch takes the
    // database from ?db= while the pathname says "tmp"). Both were allowed by a
    // guard that looked correct. Deriving from `parse()` makes the guard
    // equivalent to the driver BY CONSTRUCTION rather than by a list of cases
    // someone remembered.
    const raw = parseConnectionString(connectionString).database
    if (!raw) return null

    let name = raw
    for (let i = 0; i < 4; i++) {
      const decoded = decodeURIComponent(name)
      if (decoded === name) break
      name = decoded
    }
    const canonical = name.replace(/^\/+/, '').replace(/\/+$/, '').trim()
    // A NUL or other control character must not smuggle a live name past the
    // comparison and leave the wire protocol as the only defence.
    if (/[\u0000-\u001f\u007f]/.test(canonical)) return null
    return canonical || null
  } catch {
    return null
  }
}

/** True when running inside vitest. Vitest sets this itself; we never do. */
export function inTestRuntime(): boolean {
  return process.env.VITEST === 'true' || process.env.VITEST === '1'
}

/**
 * Refuse to hand a test process a connection to a live database.
 * Exported so tests can assert the guard itself works.
 */
export function assertNotLiveDatabase(connectionString: string): void {
  if (!inTestRuntime()) return

  // libpq keyword/value form ("host=… dbname=ai_capital") is not a URL, so the
  // parser below cannot see it. Check it explicitly rather than falling through.
  const kv = /(?:^|\s)dbname\s*=\s*'?([^'\s]+)'?/i.exec(connectionString)
  if (kv && liveDatabaseNames().includes(kv[1].trim().toLowerCase())) {
    throw new Error(
      `@common/db: refusing to connect a TEST process to the live database "${kv[1]}" (keyword/value form).`,
    )
  }

  const db = databaseNameOf(connectionString)

  // FAIL CLOSED. If the connection string cannot be canonicalised we cannot
  // prove it is safe, and "cannot prove safe" must not mean "allowed" when the
  // downside is writing to a real-money book.
  if (db === null) {
    throw new Error(
      '@common/db: refusing to connect a TEST process to an unparseable connection string. ' +
      'Canonicalisation failed, so the target database cannot be shown to be non-live. ' +
      'Point TEST_DATABASE_URL at a throwaway database.',
    )
  }

  if (liveDatabaseNames().includes(db)) {
    throw new Error(
      `@common/db: refusing to connect a TEST process to the live database "${db}". ` +
      'This guard exists because a test run once wrote fixture rows into the real ' +
      'portfolio. Point TEST_DATABASE_URL at a throwaway database (e.g. ai_capital_test), ' +
      'or let the shared vitest setup clear DATABASE_URL so the SQLite path is used.',
    )
  }
}


// ── The one place a Postgres connection is constructed ─────────────────────
//
// WHY THIS EXISTS. On 2026-08-26 a NEW credential (CLAIM_WRITER_DATABASE_URL)
// with its OWN `new pg.Pool` wrote 16 test-fixture claims into the production
// book. Every guard built during the contamination incident was bypassed — not
// because any of them was wrong, but because they were all written against the
// *previous* connection path. The vitest setup clears DATABASE_URL, not that
// variable; getPool()'s refusal was never consulted; and the claim-writer role
// legitimately holds production INSERT, so PostgreSQL correctly allowed it.
//
// THE INVARIANT, stated so it survives credentials nobody has invented yet:
//
//   No connection constructor in this repository may reach a protected live
//   database from a test runtime, whatever credential asked for it.
//
// The protection keys on DESTINATION + RUNTIME, never on an environment
// variable name. Adding a credential therefore requires no new special case;
// forgetting to add one cannot re-open the hole.

export interface ConnectOptions {
  max?: number
  connectionTimeoutMillis?: number
  /**
   * Explicitly designate a protected-database connection from a test runtime.
   *
   * Deliberately awkward: it demands a written reason, it is greppable, and it
   * must be passed at the call site. Nothing in the repo uses it today. If you
   * are reaching for it, the question to answer first is why a *test* needs to
   * touch the real book at all.
   */
  allowProtectedInTests?: { reason: string }
}

function guard(connectionString: string, opts?: ConnectOptions): void {
  if (opts?.allowProtectedInTests) {
    if (inTestRuntime()) {
      console.warn(
        `[@common/db] DESIGNATED protected-database access from a test runtime: ${opts.allowProtectedInTests.reason}`)
    }
    return
  }
  assertNotLiveDatabase(connectionString)
}


/**
 * Resolve the database a connection WILL actually reach, the way pg does.
 *
 * A connection string alone is NOT enough: `postgres://user@host:5432` with no
 * path resolves through PGDATABASE, then the user, then PGUSER, then the OS
 * user. Warden broke the first production-write gate on exactly this — the gate
 * read only the connection string, saw `null`, concluded "not protected", and
 * let an unauthorised write through to a database pg was about to connect to.
 *
 * Returns null ONLY when the destination is genuinely undeterminable, and every
 * caller must treat null as "refuse", never as "allow".
 */
export function resolveDestination(connectionString?: string, cfg?: pg.ClientConfig): string | null {
  const raw = resolveDestinationRaw(connectionString, cfg)
  return raw ? raw.toLowerCase() : null
}

/**
 * As `resolveDestination`, but preserving case. PostgreSQL database names are
 * case-sensitive, so the value used to PIN a connection string must be the raw
 * one; only the value used for comparison against the protected set is folded.
 */
export function resolveDestinationRaw(connectionString?: string, cfg?: pg.ClientConfig): string | null {
  if (connectionString) {
    const fromUrl = databaseNameOfRaw(connectionString)
    if (fromUrl) return fromUrl
    // A parseable URL with no database part still resolves through the
    // environment; fall through rather than reporting "unknown".
  }
  const effective = (
    cfg?.database
    ?? process.env.PGDATABASE
    ?? cfg?.user
    ?? process.env.PGUSER
    ?? process.env.USER
    ?? ''
  ).trim()
  return effective || null
}

/**
 * Pin the resolved destination INTO the connection string.
 *
 * WHY THIS IS NECESSARY AND WHY THE OBVIOUS ALTERNATIVE DOES NOT WORK.
 * `pg.Pool` does not connect at construction — it builds a Client per checkout,
 * and ConnectionParameters reads PGDATABASE at CONNECT time. So recording the
 * destination when the pool is built produced a snapshot the driver could later
 * disagree with, and Warden drove exactly that divergence to a row landing in
 * desk.agent_runs on a protected database with no intent scope:
 *
 *   POOL_DESTINATION recorded  : thanapold      (env had no PGDATABASE yet)
 *   pg actually connected to   : ai_capital_test (PGDATABASE set afterwards)
 *
 * Passing `database` explicitly alongside `connectionString` does NOT fix it —
 * measured: pg ignores it and PGDATABASE still wins. Only the database embedded
 * in the connection string itself is authoritative.
 *
 * So resolve once, write the answer into the string, and let the driver read it
 * from there. The record and the destination then agree BY CONSTRUCTION rather
 * than by a second check that could itself be skipped.
 */
export function pinDestination(connectionString: string): string {
  if (databaseNameOfRaw(connectionString)) return connectionString   // already explicit
  const name = resolveDestinationRaw(connectionString)
  if (!name) {
    throw new Error(
      '@common/db: refusing to open a connection whose target database cannot be determined ' +
      'from the connection string, PGDATABASE, or the environment. Name it explicitly.')
  }
  if (/^socket:/i.test(connectionString)) {
    const sep = connectionString.includes('?') ? '&' : '?'
    return `${connectionString}${sep}db=${encodeURIComponent(name)}`
  }
  try {
    const u = new URL(connectionString)
    u.pathname = `/${encodeURIComponent(name)}`
    return u.toString()
  } catch {
    return connectionString
  }
}

/**
 * The destination a pool was built against, recorded AT CONSTRUCTION.
 *
 * Why not just re-read the environment when checking? Because `getPool()`
 * caches, and the environment can change after the pool is warm — Warden
 * demonstrated a TOCTOU where the gate inspected a harmless destination while
 * the cached pool still pointed at the protected one. `global-setup.ts` mutates
 * and restores DATABASE_URL, so this is a pattern the repo actually contains.
 * Binding the destination to the pool object makes the two impossible to
 * disagree.
 */
// A MODULE-PRIVATE symbol, deliberately not Symbol.for(). Warden showed that a
// registry symbol lets any module mint the same key and forge the marker — or
// shadow a real pool via Object.create() while .query() still delegates to the
// production pool through the prototype chain. A private symbol cannot be
// minted elsewhere, so the marker is a capability rather than a convention.
export const POOL_DESTINATION: unique symbol = Symbol('@common/db.destination')

export function destinationOf(pool: unknown): string | null {
  return (pool as Record<symbol, string | null>)?.[POOL_DESTINATION] ?? null
}

/** Construct a guarded connection pool. Use this instead of `new pg.Pool`. */
export function createPool(connectionString: string, opts: ConnectOptions = {}): pg.Pool {
  // Pin FIRST: guard, record and driver must all see the same destination.
  const pinned = pinDestination(connectionString)
  guard(pinned, opts)
  const pool = new Pool({
    connectionString: pinned,
    max: opts.max ?? Number(process.env.PG_POOL_MAX ?? '5'),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: opts.connectionTimeoutMillis ?? 10_000,
  })
  // Bind the destination to the object, resolved NOW. See POOL_DESTINATION.
  Object.defineProperty(pool, POOL_DESTINATION, {
    value: databaseNameOf(pinned), enumerable: false, writable: false, configurable: false,
  })
  return pool
}

/** Construct a guarded single client. Use this instead of `new pg.Client`. */
export function createClient(connectionString: string, opts: ConnectOptions = {}): pg.Client {
  const pinned = pinDestination(connectionString)
  guard(pinned, opts)
  return new pg.Client({
    connectionString: pinned,
    connectionTimeoutMillis: opts.connectionTimeoutMillis ?? 10_000,
  })
}

/**
 * Construct a guarded client from discrete config.
 *
 * Warden proved TWO bypasses in the first version, both of which connected a
 * VITEST process to the live book:
 *   1. `{ connectionString }` — ClientConfig accepts one, and the guard only
 *      read `cfg.database`, which was undefined.
 *   2. `{ host, user }` with no `database` — `pg` falls back to PGDATABASE,
 *      then PGUSER, then the OS user. The guard saw '' and allowed it.
 *
 * Both are the same shape as the bug this factory exists to prevent: a route
 * that skips the destination check. So resolve the destination THE WAY pg
 * WOULD, and fail closed in a test runtime when it cannot be determined.
 */
export function createClientFromConfig(cfg: pg.ClientConfig, opts: ConnectOptions = {}): pg.Client {
  if (!opts.allowProtectedInTests && inTestRuntime()) {
    // A connection string in the config is a connection string: same guard.
    if (cfg.connectionString) assertNotLiveDatabase(cfg.connectionString)

    // ONE resolver, shared with the production-write gate. Two copies of a
    // resolution order is how the gate ended up seeing a different destination
    // than the driver.
    const effective = resolveDestination(undefined, cfg) ?? ''

    if (!cfg.connectionString && !effective) {
      // Cannot prove safe must never mean allowed.
      throw new Error(
        '@common/db: refusing a TEST-runtime connection whose target database cannot be ' +
        'determined from the config or the environment. Name it explicitly.')
    }
    if (liveDatabaseNames().includes(effective)) {
      throw new Error(
        `@common/db: refusing to connect a TEST process to the live database "${effective}" ` +
        '(resolved from discrete config / PGDATABASE / PGUSER).')
    }
  }
  return new pg.Client({ connectionTimeoutMillis: 10_000, ...cfg })
}

export function getPool(): pg.Pool {
  if (_pool) return _pool

  // In a test process, an explicitly-configured test database wins over
  // whatever the developer's shell happens to export.
  const url = (inTestRuntime() && process.env.TEST_DATABASE_URL) || process.env.DATABASE_URL
  if (!url) {
    throw new Error(
      '@common/db: DATABASE_URL is not set. ' +
      'When unset, callers should use the SQLite fallback path instead of calling getPool().',
    )
  }

  // Single construction site: createPool carries the destination+runtime guard.
  _pool = createPool(url)

  _pool.on('error', err => {
    console.error('[@common/db] unexpected pool error:', err.message)
  })

  return _pool
}

export async function closePool(): Promise<void> {
  if (_pool) {
    await _pool.end()
    _pool = null
  }
}

/** True if DATABASE_URL is set — callers use this to pick Postgres vs SQLite. */
export function usePostgres(): boolean {
  // Mirrors getPool's precedence so a store's backend choice can never disagree
  // with what getPool would actually connect to.
  if (inTestRuntime()) return !!(process.env.TEST_DATABASE_URL || process.env.DATABASE_URL)
  return !!process.env.DATABASE_URL
}
