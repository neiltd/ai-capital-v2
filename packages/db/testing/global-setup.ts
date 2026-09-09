// Vitest globalSetup for the @common/db INTEGRATION suite. Loaded only by
// vitest.integration.config.ts; the default database-free config registers no
// globalSetup at all.
//
// THE RULE, and it is the only one that matters here:
//   If a safe test database cannot be established, TESTS STOP.
//   They must never decide to use DATABASE_URL instead.
//
// All ordering, validation and privilege proof live in ./preflight.ts, where
// every side effect is injected — so the database-free suite drives the whole
// state machine with fakes and asserts the ORDER of events rather than the mere
// presence of a check. This file only supplies the real clients.
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import type pg from 'pg'
import { parse as parseConnectionString } from 'pg-connection-string'
import { runMigrations } from '../src/migrate.js'
import { createClient, createClientFromConfig, databaseNameOfRaw } from '../src/pool.js'
import {
  provision, preflight, assertDisposableName, PreflightError, type QueryClient,
} from './preflight.js'

/** Schema objects that must exist for the suite to be meaningfully migrated. */
const REQUIRED_SCHEMAS = ['portfolio', 'capital', 'briefing', 'desk'] as const

export function fail(message: string): never {
  throw new PreflightError(message)
}

/** Repository root, for locating ops/. */
function repoRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
}

/**
 * The bootstrap principal, pointed at the MAINTENANCE database.
 *
 * Built from PARSED COMPONENTS rather than by rewriting a URL pathname: for
 * `socket:/tmp?db=ai_capital_test`, setting `pathname` to `/postgres` left the
 * database as `ai_capital_test`, so CREATE DATABASE would have run on a
 * connection to the database being created.
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

/**
 * THE MIGRATION CREDENTIAL — derived from the ALREADY VALIDATED bootstrap
 * destination, with ONLY the principal changed.
 *
 * WHY THIS EXISTS (Round 6 gate, defect 2). This harness used to hand the
 * migration runner `BOOTSTRAP_DATABASE_URL`, so migrations executed through the
 * cluster-administrator login. `ops/README.md` documents step 3 as running as
 * `ai_capital_migrator`, and the difference is not cosmetic: the migrator holds
 * its owner membership `WITH INHERIT FALSE` and loses `CREATE` at lockdown, so
 * a chain that only ever ran as a superuser has never exercised the privileges
 * production actually uses.
 *
 * HOST, PORT AND DATABASE ARE CARRIED THROUGH UNCHANGED. They were already
 * proven by preflight() to name the approved disposable target, and rebuilding
 * them here would reopen exactly the destination question preflight closed. Only
 * `user` changes, and the password is dropped rather than reused: a
 * cluster-administrator password is not the migrator's, and carrying one over
 * would be a credential leak wearing a different name.
 *
 * There is NO fallback. If the bootstrap URL cannot be parsed into a complete
 * destination the run stops; it never reaches for DATABASE_URL.
 */
export const MIGRATION_LOGIN_ROLE = 'ai_capital_migrator'

// ─────────────────────────────────────────────────────────────────────────────
// TRANSPORT POLICY IS PART OF THE DESTINATION (Round 8, defect 2).
//
// Round 7 rebuilt host, port and database and dropped everything else. That is
// not "changing the principal" — it is SILENTLY WEAKENING the connection:
// `sslmode=verify-full` became libpq's default, a pinned `sslrootcert`
// vanished, `channel_binding=require` vanished, and a run that looked identical
// no longer verified the server it was migrating. A downgrade nobody chose is
// worse than a refusal, because it still succeeds.
//
// So parameters are CLASSIFIED, and anything unrecognised stops the run rather
// than being dropped on the floor. Three groups:
// ─────────────────────────────────────────────────────────────────────────────

/** Rebuilt verbatim from the parsed bootstrap destination; never copied twice. */
const DESTINATION_PARAMS = new Set(['host', 'port', 'db', 'dbname'])

/**
 * Non-secret connection policy. Carried through UNCHANGED.
 *
 * Every entry here describes HOW to reach the endpoint safely — TLS strength,
 * what to verify it against, timeouts, session selection, labelling. None of it
 * identifies a principal, so copying it grants nothing.
 */
const PRESERVED_PARAMS = new Set([
  // TLS strength and what the server is verified against
  'ssl', 'sslmode', 'sslrootcert', 'sslcrl', 'sslcrldir', 'sslsni',
  'sslnegotiation', 'sslcompression',
  'ssl_min_protocol_version', 'ssl_max_protocol_version',
  // authentication STRENGTH policy (not credentials)
  'channel_binding', 'require_auth', 'gssencmode', 'krbsrvname',
  // reachability and liveness
  'hostaddr', 'connect_timeout', 'keepalives', 'keepalives_idle',
  'keepalives_interval', 'keepalives_count', 'tcp_user_timeout',
  'target_session_attrs', 'load_balance_hosts',
  // session labelling and encoding
  'application_name', 'fallback_application_name', 'client_encoding', 'options',
])

/**
 * Identity-bearing material. NEVER copied, and never silently dropped either.
 *
 * A client certificate or key authenticates the BOOTSTRAP principal. Copying it
 * would make the "migrator" connection the administrator wearing a different
 * name — exactly the defect this whole round exists to close. Dropping it
 * silently is no better: if the server requires certificate authentication, the
 * migrator connection needs its OWN certificate, and quietly omitting one turns
 * a policy question into a confusing runtime failure.
 *
 * So it fails closed and says what to do. Supplying a separate migrator
 * credential is a configuration design decision, not something to invent here.
 */
const IDENTITY_PARAMS = new Set(['sslcert', 'sslkey', 'sslpassword', 'passfile'])

/** The identity being REPLACED. Dropping these is the point of the function. */
const REPLACED_IDENTITY_PARAMS = new Set(['user', 'password'])

/** Query parameters exactly as written, for every URL shape this repo uses. */
function queryParamsOf(url: string): URLSearchParams {
  const q = url.indexOf('?')
  return new URLSearchParams(q === -1 ? '' : url.slice(q + 1))
}

export function migratorUrlFrom(bootstrapUrl: string): string {
  // CLASSIFY FIRST, PARSE SECOND. pg-connection-string READS THE FILESYSTEM
  // while parsing — `sslcert`, `sslkey`, `sslrootcert` and `sslcrl` are opened
  // eagerly — so parsing before classifying would turn a policy question into
  // an ENOENT from deep inside the driver, and would touch a private key file
  // this harness has already decided it must not carry.
  const params = new URLSearchParams()
  const preserved: Array<[string, string]> = []
  const identity: string[] = []
  const unknown: string[] = []
  for (const [rawKey, value] of queryParamsOf(bootstrapUrl)) {
    const key = rawKey.toLowerCase()
    if (DESTINATION_PARAMS.has(key)) continue            // rebuilt from the parse
    if (REPLACED_IDENTITY_PARAMS.has(key)) continue      // the whole point
    if (IDENTITY_PARAMS.has(key)) { identity.push(rawKey); continue }
    if (PRESERVED_PARAMS.has(key)) { preserved.push([key, value]); continue }
    unknown.push(rawKey)
  }

  if (identity.length) {
    fail(
      `BOOTSTRAP_DATABASE_URL carries identity-bearing parameter(s): ${identity.join(', ')}.\n` +
      `  Those authenticate the BOOTSTRAP principal. Copying them into the\n` +
      `  ${MIGRATION_LOGIN_ROLE} URL would make the migration connection the\n` +
      '  administrator under another name, and dropping them silently would leave\n' +
      '  the migrator with no credential the server will accept.\n' +
      `  Supply a separate ${MIGRATION_LOGIN_ROLE} credential instead, or use a\n` +
      '  bootstrap URL that does not authenticate by certificate.',
    )
  }
  if (unknown.length) {
    fail(
      `BOOTSTRAP_DATABASE_URL carries connection parameter(s) this harness does not\n` +
      `  classify: ${unknown.join(', ')}.\n` +
      '  They are NOT dropped silently: an unrecognised parameter may be transport or\n' +
      '  security policy, and quietly losing it would weaken the migrator connection\n' +
      '  relative to the bootstrap one while still appearing to work.\n' +
      '  Classify it in PRESERVED_PARAMS or IDENTITY_PARAMS in testing/global-setup.ts,\n' +
      '  or remove it from the bootstrap URL.',
    )
  }

  // Only now, with nothing identity-bearing left to touch, resolve the
  // destination. Built from PARSED COMPONENTS, never by string surgery on the
  // original URL: a socket path, an IPv6 literal or a percent-encoded name each
  // break a regex-rewrite in a different way, and all three appear here.
  const c = parseConnectionString(bootstrapUrl)
  const host = (c.host ?? '').trim()
  const database = databaseNameOfRaw(bootstrapUrl)
  if (!host) fail('BOOTSTRAP_DATABASE_URL names no host or socket directory.')
  if (!database) fail('BOOTSTRAP_DATABASE_URL names no database.')
  params.set('host', host)                       // socket directory or TCP host
  if (c.port) params.set('port', String(c.port))
  for (const [key, value] of preserved) params.set(key, value)

  return `postgresql://${encodeURIComponent(MIGRATION_LOGIN_ROLE)}@/` +
    `${encodeURIComponent(database)}?${params.toString()}`
}

/**
 * The database the suite should use — resolved from ONE explicit source.
 *
 * There is no precedence chain. `BOOTSTRAP_DATABASE_URL` from the shell, or the
 * run stops. Retained as a named export because the harness tests assert on it
 * directly; the real validation is `preflight()`, which also requires
 * TEST_RUNTIME_DATABASE_URL and checks both endpoints together.
 */
export function resolveTestUrl(): string {
  return preflight(process.env).bootstrapUrl
}

/**
 * Refuse anything that is not a deliberate disposable test database.
 * Delegates to preflight's policy so there is ONE rule, not two that drift.
 */
export function assertSafeTestTarget(testUrl: string): string {
  // RAW, not databaseNameOf(). Round 3 left this compatibility export calling
  // the LOWERCASING helper, so `.../AI_CAPITAL_TEST` returned `ai_capital_test`
  // — the exported guard normalised an identity the real provisioning path
  // refuses. One policy, one identity: this delegates to exactly the rule
  // preflight() uses, on exactly the name the driver would use.
  return assertDisposableName(databaseNameOfRaw(testUrl))
}

export async function setup(): Promise<void> {
  // THIN WRAPPER. All ordering, validation and privilege proof live in
  // testing/preflight.ts, where they take their clients as parameters — so the
  // database-free suite can drive the entire state machine with fakes and
  // assert the ORDER of events, not merely the presence of a check.
  const plan = await provision(process.env, {
    connectAdmin: async () => {
      const c = createClientFromConfig(adminConfigFor(process.env.BOOTSTRAP_DATABASE_URL!))
      try { await c.connect() } catch (err) {
        fail(`cannot reach the Postgres server: ${(err as Error).message}. Is Postgres running?`)
      }
      return c as unknown as QueryClient & { end(): Promise<void> }
    },
    connectTarget: async (url: string) => {
      const c = createClient(url)
      await c.connect()
      return c as unknown as QueryClient & { end(): Promise<void> }
    },
    readOpsScript: (relPath, dbName) => {
      const file = join(repoRoot(), relPath)
      if (!existsSync(file)) fail(`required ops script is missing: ${relPath}`)
      return readFileSync(file, 'utf-8').replaceAll(':"dbname"', `"${dbName}"`)
    },
    migrationFilesOnDisk: () =>
      readdirSync(join(repoRoot(), 'packages', 'db', 'migrations')).filter(f => f.endsWith('.sql')),
    runMigrations: async () => {
      // THE MIGRATION PRINCIPAL IS THE MIGRATOR, NOT THE BOOTSTRAP LOGIN.
      // Derived from the destination preflight already approved; host, port,
      // database and transport policy are carried through. Never logged.
      const migratorUrl = migratorUrlFrom(process.env.BOOTSTRAP_DATABASE_URL!)
      const { closePool } = await import('../src/pool.js')

      // ── PRE-WINDOW RESET. MANDATORY, AND ITS FAILURE IS NOT SWALLOWED.
      //
      // Round 8, defect 1. This was `closePool().catch(() => {})`, and
      // closePool() clears its singleton only AFTER pool.end() resolves — so a
      // rejecting end() left the OLD pool cached, and the very next getPool()
      // would hand the migration runner a connection built from whatever
      // credential preceded it. The run would then report that migrations ran
      // as ai_capital_migrator when they did not: a false claim about the
      // principal, which is the one thing this whole round exists to establish.
      //
      // Nothing is changed before this succeeds — no environment variable, no
      // migration attempt.
      try {
        await closePool()
      } catch (err) {
        fail(
          'the shared connection pool could not be closed BEFORE the migration ' +
          `window: ${(err as Error).message}\n` +
          '  closePool() clears its singleton only after pool.end() succeeds, so a\n' +
          '  surviving pool would still carry the previous credential and the runner\n' +
          `  would NOT have connected as ${MIGRATION_LOGIN_ROLE}.\n` +
          '  No environment variable was changed and no migration was attempted.',
        )
      }

      const savedDb = process.env.DATABASE_URL
      const savedTest = process.env.TEST_DATABASE_URL
      process.env.DATABASE_URL = migratorUrl
      process.env.TEST_DATABASE_URL = migratorUrl

      let migrationError: Error | null = null
      let result: Awaited<ReturnType<typeof runMigrations>> | undefined
      try {
        // EXPLICIT, not via process.env: the environment variable is read by
        // migrate.ts at CALL time now, but an option cannot lose a race with
        // module evaluation order at all — which is what the Round 6 gate hit.
        // Objects must be owned by ai_capital_owner, or 090's "the migrator
        // controls nothing afterwards" claim is false.
        result = await runMigrations({ ownerRole: 'ai_capital_owner' })
      } catch (err) {
        migrationError = err as Error
      }

      // ── POST-WINDOW RESET. ALSO MANDATORY. A pool that survives here is a
      //    MIGRATOR pool, and the environment is about to be restored — so it
      //    would sit in the singleton, holding migrator authority, available to
      //    every ordinary test that calls getPool() afterwards.
      let closeError: Error | null = null
      try {
        await closePool()
      } catch (err) {
        closeError = err as Error
      }

      // The environment is restored on EVERY path, before anything is thrown.
      if (savedDb === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = savedDb
      if (savedTest === undefined) delete process.env.TEST_DATABASE_URL; else process.env.TEST_DATABASE_URL = savedTest

      // BOTH failures are reported. A cleanup failure never REPLACES the cause.
      if (migrationError && closeError) {
        fail(
          'the migration failed AND the migrator pool could not be closed afterwards.\n' +
          `  migration failure: ${migrationError.message}\n` +
          `  pool close failure: ${closeError.message}\n` +
          `  A pool holding ${MIGRATION_LOGIN_ROLE} authority may still be cached in ` +
          'this process.',
        )
      }
      if (migrationError) throw migrationError
      if (closeError) {
        fail(
          'the migrator pool could not be closed after the migration window: ' +
          `${closeError.message}\n` +
          `  The cached pool still holds ${MIGRATION_LOGIN_ROLE} authority and would be\n` +
          '  returned to the next getPool() caller, after the environment has been\n' +
          '  restored. Setup stops rather than handing workers a database whose\n' +
          '  privileged pool is still live.',
        )
      }
      return result!
    },
    connectRuntime: async (url: string) => {
      const c = createClient(url)
      await c.connect()
      return c as unknown as QueryClient & { end(): Promise<void> }
    },
    verifySchema: async (client, name) => {
      // A runner that reports success but leaves the schema wrong is exactly the
      // silent-success shape this project has been bitten by. Injected, so a
      // behavioural test can prove a failure here prevents the CONNECT grant.
      const { rows } = await client.query(
        'SELECT nspname FROM pg_namespace WHERE nspname = ANY($1::text[])',
        [REQUIRED_SCHEMAS as unknown as string[]],
      )
      const present = new Set(rows.map((r: any) => r.nspname))
      const missing = REQUIRED_SCHEMAS.filter(x => !present.has(x))
      if (missing.length) {
        fail(`"${name}" is missing expected schema(s) after migration: ${missing.join(', ')}.`)
      }
    },
    log: line => console.log(line),
  })

  // ── Hand workers the RESTRICTED credential, and nothing else ───────────
  // preflight() already proved this URL names the same destination and
  // authenticates as ai_capital_test_runtime, and the catalogue check proved
  // that role is unprivileged. Nothing privileged survives into the workers.
  process.env.TEST_DATABASE_URL = plan.runtimeUrl
  delete process.env.DATABASE_URL
  delete process.env.BOOTSTRAP_DATABASE_URL
}
