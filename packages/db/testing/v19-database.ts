// A V19 `ai_capital`-shaped database on a disposable cluster.
//
// WHY IT REUSES THE REPOSITORY'S OWN STEPS. The expected-target contract is only
// meaningful if the database it was taken from is the database migrations
// 001-019 actually produce. So this runs the same four steps
// ops/clusters/ai-capital-v3/provision.sh runs, in the same order, through the
// same files and the same migration runner:
//
//   1. ops/roles/000_cluster_roles.sql        cluster roles
//   2. createdb -O ai_capital_owner           the database, owned by the owner role
//   3. ops/bootstrap/010_database_bootstrap.sql   extensions, schemas, grants
//   4. bin/migrate.ts as ai_capital_migrator  migrations 001-019
//
// There is no second migration implementation here, and no hand-written DDL.
// `migrate.ts` is invoked as a CHILD PROCESS, exactly as provisioning does, so
// it reads DATABASE_URL from its own environment rather than a test runner's.
//
// 090 IS NOT APPLIED. The lockdown revokes the owner membership cluster-wide and
// is a separate, later decision; a contract taken after it would describe a
// database the copy can no longer be run against.

import { execFile, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { PSQL, type DisposableCluster } from './disposable-cluster.js'
import { reviewedTargetSettings } from './reviewed-settings.js'
import { CURRENT_V10_MANIFEST } from '../src/pg-copy/schema-contract.js'

const run = promisify(execFile)

const PG_BIN = '/opt/homebrew/opt/postgresql@17/bin'
const CREATEDB = `${PG_BIN}/createdb`

export const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const REPO_ROOT = resolve(PKG_ROOT, '..', '..')
export const ROLES_SQL = join(REPO_ROOT, 'ops', 'roles', '000_cluster_roles.sql')
export const BOOTSTRAP_SQL = join(REPO_ROOT, 'ops', 'bootstrap', '010_database_bootstrap.sql')
export const TSX = join(PKG_ROOT, 'node_modules', '.bin', 'tsx')

/**
 * The ONLY bootstrap a V10 source fixture gets.
 *
 * Byte-for-byte the ledger table `runMigrations` creates for itself, so the
 * fixture's ledger is the one the repository's own runner would have written.
 */
export const SOURCE_LEDGER_BOOTSTRAP_SQL = [
  // `vector` is installed by the SUPERUSER, because `CREATE EXTENSION` is not
  // something `ai_capital_owner` may do - migration 006 asks for it with
  // IF NOT EXISTS and finds it already there, exactly as it would on a real
  // source. `btree_gist` is deliberately NOT installed: no migration 001-010
  // needs it, and its absence is the whole point of this fixture.
  'CREATE EXTENSION IF NOT EXISTS vector;',
  'CREATE SCHEMA IF NOT EXISTS db;',
  'CREATE TABLE IF NOT EXISTS db.schema_migrations (',
  '  filename    TEXT PRIMARY KEY,',
  '  applied_at  TIMESTAMPTZ NOT NULL DEFAULT now(),',
  '  sha256      TEXT NOT NULL',
  ');',
].join('\n')
export const OWNER_ROLE = 'ai_capital_owner'
export const MIGRATOR_ROLE = 'ai_capital_migrator'

/** Build one V19 database on an already-running disposable cluster. */
export async function buildV19Database(c: DisposableCluster, database: string): Promise<string> {
  const psqlArgs = (db: string, extra: string[]): string[] => [
    '--no-psqlrc', '-v', 'ON_ERROR_STOP=1', '-X', '-q',
    '-h', c.socketDir, '-p', String(c.port), '-U', c.user, '-d', db, ...extra,
  ]

  // 1. cluster roles — idempotent across databases, so guard on re-entry.
  const exists = await c.rows(
    `SELECT pg_catalog.count(*)::pg_catalog.text FROM pg_catalog.pg_roles WHERE rolname = '${OWNER_ROLE}'`)
  if (exists[0][0] === '0') {
    await run(PSQL, psqlArgs('postgres', ['--single-transaction', '-f', ROLES_SQL]))
  }

  // 2. the database, owned by the owner role
  await run(CREATEDB, [
    '-h', c.socketDir, '-p', String(c.port), '-U', c.user,
    '-O', OWNER_ROLE, '-E', 'UTF8', '--locale=en_US.UTF-8', '-T', 'template0', database,
  ])

  // 2b. The reviewed target settings, established EXPLICITLY.
  //
  // `initdb` derives TimeZone from the host, so without this the generated
  // artifact records where it was generated rather than what the target is.
  // They are set on the DATABASE, so every later session sees them and the
  // extractor still READS them - it is not told them.
  //
  // The VALUES come from ops/clusters/ai-capital-v3/postgresql.conf.d/, parsed
  // and reconciled with the published constants, so this harness cannot build a
  // target the production configuration does not describe.
  for (const [k, v] of Object.entries(reviewedTargetSettings())) {
    await run(PSQL, psqlArgs('postgres', ['-c', `ALTER DATABASE ${database} SET ${k} = '${v}'`]))
  }

  // 3. bootstrap
  await run(PSQL, psqlArgs(database, ['--single-transaction', '-v', `dbname=${database}`, '-f', BOOTSTRAP_SQL]))

  // 4. migrations, through the repository's own runner
  const url = `postgresql://${MIGRATOR_ROLE}@/${database}` +
              `?host=${encodeURIComponent(c.socketDir)}&port=${c.port}`
  const env = { ...process.env, DATABASE_URL: url, MIGRATION_OWNER_ROLE: OWNER_ROLE }
  // A test runner sets VITEST, which would make getPool() prefer
  // TEST_DATABASE_URL. The child is not a test runtime and must not inherit the
  // marker, or it would ignore the URL we just built.
  delete (env as Record<string, string | undefined>).VITEST
  delete (env as Record<string, string | undefined>).VITEST_WORKER_ID
  delete (env as Record<string, string | undefined>).TEST_DATABASE_URL
  const { stdout } = await run(TSX, [join(PKG_ROOT, 'bin', 'migrate.ts')], { cwd: PKG_ROOT, env })
  if (!/19 applied/.test(stdout)) {
    throw new Error(`expected 19 migrations applied, got: ${stdout.split('\n')[0]}`)
  }
  return url
}

/**
 * A genuine CURRENT_V10 source on a disposable cluster.
 *
 * WHY IT DOES NOT USE `bin/migrate.ts`. The runner reads every `.sql` in the
 * migrations directory and applies all of them; it has no "stop at ten". So
 * this replays the runner's OWN per-file transaction shape - `BEGIN`,
 * `SET LOCAL ROLE`, `SET LOCAL search_path`, the body, the ledger INSERT,
 * `COMMIT` - for 001 through 010 only. The shape is copied deliberately: the
 * ledger this produces has to be the ledger production has, and production's
 * was written by that runner.
 *
 * THE LEDGER IS THE POINT. A V10 fixture that merely has the right TABLES
 * would pass a shape comparison and fail recognition, which is exactly
 * backwards - recognition is the thing under test.
 */
export async function buildV10Database(
  c: DisposableCluster, database: string,
): Promise<void> {
  const psqlArgs = (db: string, extra: string[]): string[] => [
    '--no-psqlrc', '-v', 'ON_ERROR_STOP=1', '-X', '-q',
    '-h', c.socketDir, '-p', String(c.port), '-U', c.user, '-d', db, ...extra,
  ]

  const exists = await c.rows(
    `SELECT pg_catalog.count(*)::pg_catalog.text FROM pg_catalog.pg_roles WHERE rolname = '${OWNER_ROLE}'`)
  if (exists[0][0] === '0') {
    await run(PSQL, psqlArgs('postgres', ['--single-transaction', '-f', ROLES_SQL]))
  }
  await run(CREATEDB, [
    '-h', c.socketDir, '-p', String(c.port), '-U', c.user,
    '-O', OWNER_ROLE, '-E', 'UTF8', '--locale=en_US.UTF-8', '-T', 'template0', database,
  ])
  // The SAME reviewed settings the target gets: `lc_collate`, `TimeZone` and
  // `default_text_search_config` are equality-required by C1, so a source that
  // differed on them would fail for a reason that is about this harness rather
  // than about the schema.
  for (const [k, v] of Object.entries(reviewedTargetSettings())) {
    await run(PSQL, psqlArgs('postgres', ['-c', `ALTER DATABASE ${database} SET ${k} = '${v}'`]))
  }
  // THE TARGET BOOTSTRAP IS DELIBERATELY NOT RUN.
  //
  // `ops/bootstrap/010_database_bootstrap.sql` is the reviewed TARGET's
  // provisioning: among other things it installs `btree_gist`, which no
  // migration 001-010 needs and which the real production source does not
  // have. Running it here would build a source that is not shaped like the
  // source, and the extension-policy check would then pass for the wrong
  // reason - the fixture would be carrying the very extension the policy is
  // supposed to stop requiring.
  //
  // So only what migrations 001-010 actually need is created: the ledger table
  // the runner itself bootstraps, and the `vector` extension that 006 installs.
  // Every schema is created by the migrations themselves.
  await run(PSQL, psqlArgs(database, ['-c', SOURCE_LEDGER_BOOTSTRAP_SQL]))

  for (const entry of CURRENT_V10_MANIFEST) {
    const sql = readFileSync(join(PKG_ROOT, 'migrations', entry.filename), 'utf-8')
    const hash = createHash('sha256').update(sql).digest('hex')
    if (hash !== entry.sha256) {
      throw new Error(
        `migration ${entry.filename} no longer matches the reviewed CURRENT_V10 hash.`)
    }
    const body = [
      'BEGIN;',
      `SET LOCAL ROLE ${OWNER_ROLE};`,
      'SET LOCAL search_path = pg_catalog, public;',
      sql,
      'RESET ROLE;',
      `INSERT INTO db.schema_migrations(filename, sha256) VALUES ('${entry.filename}', '${hash}');`,
      'COMMIT;',
    ].join('\n')
    // execFileSync, NOT the promisified execFile: only the sync form accepts
    // `input`, and the async one would silently run psql with an empty stdin -
    // producing a database with no migrations and a fixture that proves nothing.
    execFileSync(PSQL, psqlArgs(database, ['-f', '-']), { input: body, stdio: ['pipe', 'ignore', 'pipe'] })
  }
}
