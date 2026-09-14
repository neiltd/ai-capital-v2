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
  //
  // Array.from, not [...new Set(...)]: apps/unified-platform compiles this file
  // through transpilePackages with an ES5 target, where spreading a Set is a
  // hard type error. The spread form silently broke the dashboard BUILD for
  // three rounds of gates, because every gate counted tests and privileges and
  // never ran `build` or `typecheck`.
  return Array.from(new Set([...ALWAYS_LIVE, ...extra]))
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

    // NO extra decoding. parseConnectionString has already decoded the path
    // exactly once, exactly as the driver does. The previous multi-decode loop
    // decoded up to four MORE times, which made the record disagree with the
    // driver in the opposite direction from R3-7's encoder bug:
    //     PGDATABASE="ai%5Fcapital"  ->  pg sees "ai%5Fcapital", record said "ai_capital"
    // The `%5F` bypass this loop was added for stays closed regardless, because
    // the driver's own decodeURI already resolves %5F. Matching the driver
    // means decoding the same number of times it does — not more.
    const canonical = raw.replace(/^\/+/, '').replace(/\/+$/, '').trim()
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
  // pg's ACTUAL order, from connection-parameters.js:
  //   val('database', config)  →  and if still undefined, `this.database = this.user`
  // where val() falls back through config → PG* env → defaults, using ||.
  // Expanded, and this is what we must match exactly:
  //   config.database → PGDATABASE → user-from-connection-string → PGUSER → $USER
  //
  // TWO defects lived in the previous version, both found by Warden:
  //
  // R3-2: the USER PARSED FROM THE CONNECTION STRING was missing from the
  // chain. `postgres://ai_capital@localhost:5432` routes to the database
  // `ai_capital` — the real book — while the guard resolved `$USER` and
  // reported "not protected". An exported gate that FAILS OPEN on a string the
  // driver sends to production.
  //
  // R3-5: `??` where pg uses `||`. PGDATABASE="" (blanked, not unset) stopped
  // the chain at the empty string. That is W-1's exact bug, one function away.
  let csUser: string | undefined
  if (connectionString) {
    const fromUrl = databaseNameOfRaw(connectionString)
    if (fromUrl) return fromUrl
    // No database in the string, but the string's USER is next in pg's order.
    try { csUser = parseConnectionString(connectionString).user || undefined } catch { /* unparseable */ }
  }
  const effective = (
    cfg?.database
    || process.env.PGDATABASE
    || csUser
    || cfg?.user
    || process.env.PGUSER
    || process.env.USER
    || ''
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
    // encodeURI, NOT encodeURIComponent. pg-connection-string reads the path
    // with `decodeURI`, which by definition does not decode reserved
    // characters — so encodeURIComponent's escaping of '/', '?' and '#'
    // survived into the database name and CHANGED the destination:
    //     PGDATABASE="my/db"  ->  pinned /my%2Fdb  ->  pg connects to "my%2Fdb"
    // A literal '/' is safe here because pg takes everything after the first
    // slash as the database name.
    u.pathname = `/${encodeURI(name)}`
    const pinned = u.toString()
    // VERIFY THE ROUND TRIP. Pinning rewrites a connection string, and a
    // rewrite that changes the destination is worse than no rewrite at all —
    // it would silently point a legitimate caller at a different database.
    // Some names cannot survive a URL round trip at all (a '?' or '#' must be
    // escaped by the pathname setter or it would terminate the path), so
    // rather than quietly altering the target, refuse.
    const roundTripped = databaseNameOfRaw(pinned)
    if (roundTripped !== name) {
      throw new Error(
        `@common/db: cannot pin the destination "${name}" into a connection string without ` +
        `changing it (round-trips to "${roundTripped}"). Name the database explicitly in the ` +
        'connection string instead of relying on PGDATABASE.')
    }
    return pinned
  } catch (e) {
    if (e instanceof Error && e.message.startsWith('@common/db:')) throw e
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
// A WeakMap, NOT a symbol on the object.
//
// I claimed a module-private Symbol() made the marker "a capability rather than
// a convention". That was wrong, and Warden demonstrated it in three lines:
// own symbols are readable with Object.getOwnPropertySymbols, so any holder of
// a pool can extract the key and forge a marker on an object whose .query()
// still reaches production.
//
//   const KEY = Object.getOwnPropertySymbols(anyPool).find(s => s.description === '...')
//   assertPoolWriteAuthorized({ [KEY]: 'harmless', query: prodPool.query.bind(prodPool) }, ...)
//
// A WeakMap has no such door: an outside module cannot read, enumerate, or
// insert into a map it has no reference to. This is what "private" actually
// requires. It also keeps the pool object unmodified, so nothing about the
// marker can be frozen, deleted, or shadowed via the prototype chain.
const DESTINATIONS = new WeakMap<object, string | null>()

/** Record a pool's destination. Module-internal: the factories are the only callers. */
function rememberDestination(pool: object, name: string | null): void {
  DESTINATIONS.set(pool, name)
}

export function destinationOf(pool: unknown): string | null {
  if (!pool || (typeof pool !== 'object' && typeof pool !== 'function')) return null
  return DESTINATIONS.get(pool as object) ?? null
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
  rememberDestination(pool, databaseNameOf(pinned))
  // R3-4: pg-pool builds each client from `this.options` AT CHECKOUT, and
  // options is plain and writable — so the record and the driver could be made
  // to disagree permanently by mutating it after construction. Freeze it, and
  // additionally assert on every real connection that the client landed where
  // the record says. "Agree by construction" has to keep being true after
  // construction.
  Object.freeze(pool.options)
  pool.on('connect', client => {
    const actual = (client as unknown as { database?: string }).database
    const recorded = destinationOf(pool)
    if (actual && recorded && actual.toLowerCase() !== recorded) {
      throw new Error(
        `@common/db: connection destination drifted after construction — recorded "${recorded}", ` +
        `connected to "${actual}". Refusing to use this pool.`)
    }
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

// ─────────────────────────────────────────────────────────────────────────────
// THE DASHBOARD READ POOL — slice S4A.
//
// WHY A SECOND POOL EXISTS AT ALL, WHICH IS NOT A STYLE CHOICE.
// `apps/unified-platform` runs Prisma with `provider = "sqlite"` and
// `url = env("DATABASE_URL")` (prisma/schema.prisma:11-12), so inside the Next
// server process DATABASE_URL is a `file:` URL. Its one PostgreSQL route,
// src/app/api/trade-graph/route.ts, used to call getPool() — which reads that
// same DATABASE_URL and would hand `pg` a `file:` string. Which value actually
// won depended on whether the server was started from a shell that had already
// exported a Postgres URL, because process env outranks .env.local in Next. One
// variable cannot hold two mutually exclusive values; the route gets its own.
//
// getPool() and closePool() are deliberately UNCHANGED. Twenty-odd callers
// invoke closePool() in `.finally()` blocks, and widening its meaning would
// change behaviour for every one of them. There is no closeAllPools(): no caller
// needs one, and speculative API surface is not justified.
// ─────────────────────────────────────────────────────────────────────────────

let _dashboardPool: pg.Pool | null = null

/** Schemes an explicit PostgreSQL credential may carry. Everything else is refused. */
const POSTGRES_URL_SCHEMES = ['postgres:', 'postgresql:']

/** The `scheme://` forms those schemes must actually be written in. */
const POSTGRES_URL_SCHEME_RE = /^postgres(ql)?:\/\//i

/**
 * Validate one explicit PostgreSQL credential — BEFORE any pool or client exists.
 *
 * SHARED, AND DELIBERATELY SO. This began as the dashboard's validator in slice
 * S4A and is now used by the claim writer as well (S4C). The logic encodes four
 * facts that were each measured rather than reasoned, and that a second copy
 * would eventually get wrong: the WHATWG parser is wrong in both directions for
 * this job; pg-connection-string reports a missing user/host as `''` and a
 * missing database as `null`; surrounding whitespace must be refused rather than
 * trimmed; and the original string must reach the driver byte-for-byte.
 *
 * Validation is a separate step and completes BEFORE construction, so an invalid
 * credential produces zero pg.Pool objects and zero connection attempts rather
 * than a pool that fails on first use.
 *
 * THERE IS NO FALLBACK, for any caller. Not DATABASE_URL, not TEST_DATABASE_URL,
 * not PGDATABASE, PGHOST, PGPORT, PGUSER or USER. A guarded fallback is still a
 * fallback, and the values it would reach for are exactly the ones that make an
 * incomplete URL resolve somewhere unintended.
 *
 * Errors name the VARIABLE and the failure, never the value: an operator needs
 * to know which credential is wrong, and a log needs not to contain it. No
 * message here interpolates the credential, its user, its host or its database.
 *
 * @param varName the environment variable being validated, for the message only
 * @param raw     its value, exactly as read
 */
export function requireExplicitPostgresUrl(varName: string, raw: string | undefined): string {
  if (raw === undefined) {
    throw new Error(
      `@common/db: ${varName} is not set. This credential has no fallback — it ` +
      'must never borrow DATABASE_URL, TEST_DATABASE_URL or any PG* variable.',
    )
  }
  // Empty and whitespace-only, in one check. `VAR=` is the ordinary way an
  // operator disables a credential in .env, and it must fail like `VAR` unset
  // rather than sliding into some other path.
  if (raw.trim() === '') {
    throw new Error(`@common/db: ${varName} is empty or whitespace-only.`)
  }
  // Surrounding whitespace is REJECTED, not trimmed. The WHATWG URL parser
  // silently strips leading and trailing spaces, so validating a trimmed copy and
  // then connecting with the untrimmed original would check one string and use
  // another. Refusing is honest; trimming would be a silent rewrite of a
  // credential.
  if (raw !== raw.trim()) {
    throw new Error(
      `@common/db: ${varName} has leading or trailing whitespace. It is refused ` +
      'rather than trimmed, so the value validated is the value used.',
    )
  }

  // Scheme allowlist, not a denylist. `file:` is the specific hazard this whole
  // seam exists for, but `http:`, `redis:` and anything else are refused by the
  // same rule rather than by enumeration.
  //
  // WHY A PREFIX TEST AND NOT `new URL()`. The WHATWG parser is wrong for this
  // job in BOTH directions, measured rather than assumed:
  //
  //   * it THROWS on a valid Unix-socket URL, because the authority is empty —
  //     `postgresql://dashboard@/db?host=%2Fvar%2Frun%2Fpostgresql` is a
  //     perfectly good target that `new URL()` calls malformed;
  //   * it ACCEPTS `postgres:foo` and `postgres:/db`, reporting protocol
  //     "postgres:", when neither names a server at all.
  //
  // Requiring the `scheme://` form admits every real PostgreSQL URI (TCP and
  // socket alike) and rejects the scheme-relative shapes outright, which leaves
  // pg-connection-string as the single parser of record below.
  if (!POSTGRES_URL_SCHEME_RE.test(raw)) {
    throw new Error(
      `@common/db: ${varName} must be a PostgreSQL URL beginning ` +
      `${POSTGRES_URL_SCHEMES.map(sc => `${sc}//`).join(' or ')}.`,
    )
  }

  // ── EXPLICIT COMPONENTS, OR NOTHING ──────────────────────────────────────
  //
  // Scheme validation alone is NOT enough, and the gap is not theoretical.
  // createPool() -> pinDestination() deliberately resolves a MISSING database
  // through PGDATABASE, then the connection-string user, then PGUSER, then USER,
  // because for the ordinary pool that is correct libpq behaviour. For this pool
  // it is a fallback by another name: the "no fallback" guarantee above would be
  // satisfied to the letter while the ambient environment silently supplied the
  // destination.
  //
  // Measured, not assumed, with PGDATABASE=ambient_dashboard_db set:
  //
  //   postgres://host.example        -> user '', host 'host.example', database null
  //   postgres://user@host.example   -> user 'user', host 'host.example', database null
  //   postgres:foo                   -> user '', host '', database 'oo'
  //
  // The first two then inherit `ambient_dashboard_db`; the third connects to a
  // database named by a typo. So the SUPPLIED VALUE must carry all three fields
  // itself. pg-connection-string is used here purely as a reader — it consults
  // no environment variable, which is exactly why it can answer "what did this
  // string actually say?" — and its answer is discarded afterwards.
  let fields: { user?: string | null; host?: string | null; database?: string | null }
  try {
    fields = parseConnectionString(raw)
  } catch {
    throw new Error(`@common/db: ${varName} could not be parsed as a connection string.`)
  }
  // Missing components come back as '' (user, host) or null (database), so
  // emptiness is the single test for all three.
  const missing = (['user', 'host', 'database'] as const)
    .filter(k => {
      const v = fields[k]
      return v === undefined || v === null || String(v).trim() === ''
    })
  if (missing.length > 0) {
    throw new Error(
      `@common/db: ${varName} must state its ${missing.join(', ')} explicitly. ` +
      'This credential never inherits connection fields from PGDATABASE, PGHOST, ' +
      'PGPORT, PGUSER or USER; an incomplete URL would be completed from the ambient ' +
      'environment, which is a fallback by another name. A Unix-socket target must ' +
      'supply the socket directory as an explicit ?host= parameter. A password is NOT ' +
      'required — passwordless authentication and .pgpass remain operator choices.',
    )
  }

  // The ORIGINAL string, byte for byte. Not parsed.href, not a normalised form,
  // and nothing reassembled from the fields above: URL round-tripping can alter
  // percent-encoding, and a rewritten database name is exactly the class of
  // mutation assertNotLiveDatabase() exists to catch.
  return raw
}

/**
 * The dashboard read pool. Its own singleton, independent of getPool()'s.
 *
 * Construction goes through createPool(), so the destination pin, the
 * live-database refusal and the immutability guard all still apply — validation
 * precedes those guards, it does not replace them.
 */
export function getDashboardPool(): pg.Pool {
  if (_dashboardPool) return _dashboardPool

  // Same validator the claim writer uses; see requireExplicitPostgresUrl.
  const url = requireExplicitPostgresUrl('DASHBOARD_DATABASE_URL',
                                         process.env.DASHBOARD_DATABASE_URL)
  _dashboardPool = createPool(url)

  _dashboardPool.on('error', err => {
    console.error('[@common/db] unexpected dashboard pool error:', err.message)
  })

  return _dashboardPool
}

/**
 * Close the dashboard pool, and only the dashboard pool.
 *
 * The singleton is cleared ONLY after end() resolves. Round 8 of the harness
 * work established why: clearing first, or clearing in a `finally`, makes a
 * rejected end() orphan a pool that is still open and no longer addressable, so
 * cleanup cannot be retried and the leak is invisible. On rejection the
 * singleton is deliberately retained and the error propagates.
 */
export async function closeDashboardPool(): Promise<void> {
  if (_dashboardPool) {
    await _dashboardPool.end()
    _dashboardPool = null
  }
}

/** True if DATABASE_URL is set — callers use this to pick Postgres vs SQLite. */
export function usePostgres(): boolean {
  // Mirrors getPool's precedence so a store's backend choice can never disagree
  // with what getPool would actually connect to.
  if (inTestRuntime()) return !!(process.env.TEST_DATABASE_URL || process.env.DATABASE_URL)
  return !!process.env.DATABASE_URL
}
