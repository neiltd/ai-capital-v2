// Vitest globalSetup: bring a throwaway test database into existence, migrate
// it, and verify it — or stop the run. Never fall back to production.
//
// WHY THIS EXISTS. `ai_capital_test` was created by hand during the 2026-08-25
// incident response. That made THIS machine safe and told us nothing about a
// fresh clone, which has no such database. A safety property that depends on
// undocumented local state is not a safety property.
//
// THE RULE, and it is the only one that matters here:
//   If a safe test database cannot be established, TESTS STOP.
//   They must never decide to use DATABASE_URL instead.
//
// Every failure path below throws. There is deliberately no branch that falls
// through to the live database, because the whole class of bug this incident
// came from was a fallback quietly choosing production.

import pg from 'pg'
import { runMigrations } from '../src/migrate.js'
import { parse as parseConnectionString } from 'pg-connection-string'
import { databaseNameOf, liveDatabaseNames } from '../src/pool.js'

const { Client } = pg

/** Schema objects that must exist for the suite to be meaningfully migrated. */
const REQUIRED_SCHEMAS = ['portfolio', 'capital', 'briefing', 'desk'] as const



export function fail(message: string): never {
  throw new Error(
    `[test-db] ${message}\n` +
    '        Tests are stopping rather than continuing without a safe database. ' +
    'They will NOT fall back to DATABASE_URL.',
  )
}

/**
 * The database the suite should use. Explicit TEST_DATABASE_URL wins; otherwise
 * derive one from DATABASE_URL by suffixing the name, so a developer who only
 * has the production URL still gets an isolated database rather than a
 * confusing failure.
 */
export function resolveTestUrl(): string {
  // Bootstrap runs in the main vitest process and reads the shell environment,
  // where the privileged credential lives. Workers never see it.
  const explicit = process.env.BOOTSTRAP_DATABASE_URL || process.env.TEST_DATABASE_URL
  if (explicit) return explicit

  const live = process.env.DATABASE_URL
  if (!live) {
    fail(
      'neither TEST_DATABASE_URL nor DATABASE_URL is set, so no Postgres host is known. ' +
      'Set TEST_DATABASE_URL to a throwaway database (e.g. postgres://localhost:5432/ai_capital_test).',
    )
  }
  let u: URL
  try { u = new URL(live) } catch { fail(`DATABASE_URL is not a parseable URL, so a test database cannot be derived from it.`) }
  const name = u.pathname.replace(/^\//, '')
  if (!name) fail('DATABASE_URL has no database name, so a test database cannot be derived from it.')
  u.pathname = `/${name.endsWith('_test') ? name : `${name}_test`}`
  return u.toString()
}

/**
 * Throws unless the resolved target is provably safe to create/migrate/test
 * against. Exported so the fail-closed paths are covered by real tests rather
 * than by reading the code.
 */
export function assertSafeTestTarget(testUrl: string): string {
  const name = databaseNameOf(testUrl)
  if (name === null) {
    fail('the test database URL could not be canonicalised, so it cannot be shown to be non-live.')
  }
  if (liveDatabaseNames().includes(name)) {
    fail(
      `TEST_DATABASE_URL points at the LIVE database "${name}". ` +
      'Refusing to create, migrate or test against it.',
    )
  }
  return name
}

/**
 * Connection config for the maintenance database on the same server, used to
 * run CREATE DATABASE.
 *
 * Built from PARSED COMPONENTS rather than by rewriting a URL pathname. Warden
 * showed the old string-rewrite was the very pattern this file's guard exists
 * to prevent: for `socket:/tmp?db=ai_capital_test`, setting `pathname` to
 * `/postgres` left the database as `ai_capital_test`, so CREATE DATABASE would
 * have run on a connection to the database being created. It failed closed
 * because the target was already proven non-live upstream — but relying on a
 * downstream catch is how the socket bypass happened in the first place.
 */
function adminConfigFor(testUrl: string): pg.ClientConfig {
  const c = parseConnectionString(testUrl)
  return {
    host:     c.host ?? undefined,
    port:     c.port ? Number(c.port) : undefined,
    user:     c.user ?? undefined,
    password: typeof c.password === 'string' ? c.password : undefined,
    database: 'postgres',            // explicit, not derived from a rewritten path
    connectionTimeoutMillis: 10_000,
  }
}

export async function setup(): Promise<void> {
  const testUrl = resolveTestUrl()
  // Refuse to operate on a protected database, before doing anything.
  const name = assertSafeTestTarget(testUrl)

  // ── 1. Create if absent ────────────────────────────────────────────────
  let existed = true
  const admin = new Client(adminConfigFor(testUrl))
  try {
    await admin.connect()
  } catch (err) {
    fail(
      `cannot reach the Postgres server to check for "${name}": ${(err as Error).message}. ` +
      'Is Postgres running?',
    )
  }
  try {
    const { rows } = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [name])
    if (rows.length === 0) {
      existed = false
      // Identifier cannot be parameterised; `name` is canonicalised above and
      // has already been proven free of control characters by databaseNameOf.
      if (!/^[a-z0-9_]+$/.test(name)) {
        fail(`refusing to CREATE DATABASE with an unexpected name "${name}".`)
      }
      await admin.query(`CREATE DATABASE ${name}`)
      console.log(`[test-db] created "${name}"`)
    }
  } catch (err) {
    fail(`failed to create "${name}": ${(err as Error).message}`)
  } finally {
    await admin.end().catch(() => {})
  }

  // ── 2. Migrate ─────────────────────────────────────────────────────────
  // runMigrations reads DATABASE_URL via getPool(), so point it at the test
  // database for the duration and restore afterwards.
  const savedDb = process.env.DATABASE_URL
  const savedTest = process.env.TEST_DATABASE_URL
  process.env.TEST_DATABASE_URL = testUrl
  process.env.DATABASE_URL = testUrl
  try {
    const result = await runMigrations()
    if (!existed || result.applied.length) {
      console.log(`[test-db] migrations: ${result.applied.length} applied, ${result.alreadyApplied.length} already applied`)
    }
  } catch (err) {
    fail(`migrations failed against "${name}": ${(err as Error).message}`)
  } finally {
    const { closePool } = await import('../src/pool.js')
    await closePool().catch(() => {})
    if (savedDb === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = savedDb
    if (savedTest === undefined) delete process.env.TEST_DATABASE_URL; else process.env.TEST_DATABASE_URL = savedTest
  }

  // ── 3. Verify the resulting schema ─────────────────────────────────────
  // A migration runner that reports success but leaves the schema wrong is
  // exactly the silent-success shape this project has been bitten by.
  const verify = new Client({ connectionString: testUrl, connectionTimeoutMillis: 10_000 })
  try {
    await verify.connect()
    const { rows } = await verify.query<{ nspname: string }>(
      'SELECT nspname FROM pg_namespace WHERE nspname = ANY($1::text[])',
      [REQUIRED_SCHEMAS as unknown as string[]],
    )
    const present = new Set(rows.map(r => r.nspname))
    const missing = REQUIRED_SCHEMAS.filter(s => !present.has(s))
    if (missing.length) {
      fail(`"${name}" is missing expected schema(s) after migration: ${missing.join(', ')}.`)
    }
    const { rows: dbRows } = await verify.query<{ db: string }>('SELECT current_database() AS db')
    if (liveDatabaseNames().includes(dbRows[0].db.toLowerCase())) {
      fail(`verification connected to the LIVE database "${dbRows[0].db}".`)
    }
    console.log(`[test-db] ready: ${dbRows[0].db} (${REQUIRED_SCHEMAS.length} schemas verified)`)
  } catch (err) {
    if ((err as Error).message.startsWith('[test-db]')) throw err
    fail(`could not verify "${name}": ${(err as Error).message}`)
  } finally {
    await verify.end().catch(() => {})
  }

  // ── 4. Hand test processes the RESTRICTED credential, not this one ─────
  //
  // Phase 1 of least-privilege separation. Bootstrap above needs authority to
  // CREATE DATABASE and run migrations; ordinary test code must not keep it.
  // `ai_capital_test_runtime` has no CONNECT on the production database at all,
  // so even a completely broken TypeScript guard cannot reach the live book —
  // Postgres refuses at authentication.
  const runtimeUrl = process.env.TEST_RUNTIME_DATABASE_URL
  if (!runtimeUrl) {
    fail(
      'TEST_RUNTIME_DATABASE_URL is not set. Ordinary tests must authenticate as the ' +
      'restricted role (ai_capital_test_runtime), not as the privileged bootstrap ' +
      'credential. Set it to postgres://ai_capital_test_runtime:<password>@<host>/<test-db>.',
    )
  }
  // The restricted credential must point at the database we just prepared —
  // otherwise tests would silently run somewhere unmigrated.
  const runtimeName = assertSafeTestTarget(runtimeUrl)
  if (runtimeName !== name) {
    fail(
      `TEST_RUNTIME_DATABASE_URL points at "${runtimeName}" but the bootstrap prepared "${name}". ` +
      'They must be the same database.',
    )
  }
  // Prove the restricted credential actually works before handing it over, so a
  // wrong password fails here with a clear message rather than inside a test.
  const probe = new Client({ connectionString: runtimeUrl, connectionTimeoutMillis: 10_000 })
  try {
    await probe.connect()
    const { rows } = await probe.query<{ u: string }>('SELECT current_user AS u')
    console.log(`[test-db] test runtime authenticates as "${rows[0].u}" (non-privileged)`)
  } catch (err) {
    fail(`the restricted test credential could not connect: ${(err as Error).message}`)
  } finally {
    await probe.end().catch(() => {})
  }

  process.env.TEST_DATABASE_URL = runtimeUrl
  // Do not leave privileged credentials reachable by test code.
  delete process.env.DATABASE_URL
  delete process.env.BOOTSTRAP_DATABASE_URL
}
