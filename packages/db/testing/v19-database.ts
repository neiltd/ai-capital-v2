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

import { execFile } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { PSQL, type DisposableCluster } from './disposable-cluster.js'
import { reviewedTargetSettings } from './reviewed-settings.js'

const run = promisify(execFile)

const PG_BIN = '/opt/homebrew/opt/postgresql@17/bin'
const CREATEDB = `${PG_BIN}/createdb`

export const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const REPO_ROOT = resolve(PKG_ROOT, '..', '..')
export const ROLES_SQL = join(REPO_ROOT, 'ops', 'roles', '000_cluster_roles.sql')
export const BOOTSTRAP_SQL = join(REPO_ROOT, 'ops', 'bootstrap', '010_database_bootstrap.sql')
export const TSX = join(PKG_ROOT, 'node_modules', '.bin', 'tsx')
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
