// Schema migration runner. Reads .sql files from packages/db/migrations/,
// tracks which have been applied in a `db.schema_migrations` table, and
// runs new ones in lexical order in a single transaction each.

import { readFileSync, readdirSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { createHash } from 'crypto'
import { escapeIdentifier } from 'pg'
import { getPool } from './pool.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const MIGRATIONS_DIR = join(__dirname, '..', 'migrations')

const BOOTSTRAP_SQL = `
CREATE SCHEMA IF NOT EXISTS db;
CREATE TABLE IF NOT EXISTS db.schema_migrations (
  filename    TEXT PRIMARY KEY,
  applied_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  sha256      TEXT NOT NULL
);
`

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex')
}

/**
 * The role every migration's objects should belong to.
 *
 * WHY THIS EXISTS. Object ownership is decided by the role that executes
 * CREATE, and an owner can ALTER, DROP and GRANT on its own objects no matter
 * what its ACLs say. Without this, a fresh database ends up with schemas 001-010
 * owned by whichever LOGIN role ran the migration — so "the deployment identity
 * controls nothing after lockdown" would be false, and revoking privileges
 * afterwards would not make it true.
 *
 * A `SET LOCAL ROLE` inside each migration FILE would fix 011 onward, but
 * 001-010 are published and immutable: they must not be edited. The runner is
 * the only place ownership can be set for them, which is why the switch lives
 * here rather than in SQL.
 *
 * Unset (the default) reproduces the previous behaviour exactly, so nothing
 * outside the tenancy work changes.
 */
const MIGRATION_OWNER_ROLE = process.env.MIGRATION_OWNER_ROLE?.trim() || null

/**
 * The search path every migration runs under, when an owner role is configured.
 *
 * WHY A FIXED PATH. `ops/bootstrap/010_database_bootstrap.sql` installs
 * `btree_gist` and `vector` into `public` and verifies they are there — but
 * placement is not visibility. Two published, IMMUTABLE migrations resolve
 * names that live in that schema without qualifying them:
 *
 *   006  `embedding vector(384)`                 — the TYPE
 *   006  `USING hnsw (embedding vector_cosine_ops)` — the OPERATOR CLASS
 *   011  `EXCLUDE USING gist (... WITH =)`       — btree_gist's operators
 *
 * Whether those resolve depends entirely on the SESSION's search path, and the
 * runner does not control where that comes from: `ALTER DATABASE ... SET`,
 * `ALTER ROLE ... SET`, a connection parameter and `PGOPTIONS` can each supply
 * one, and the server applies them before any client statement runs. A
 * deployment whose database or role carried `search_path = app` would fail on
 * migration 006 with `type "vector" does not exist` — a privilege-shaped error
 * with no privilege cause, on a chain that is byte-identical to one that works
 * elsewhere. The bootstrap cannot fix this: it controls the ADMINISTRATOR's
 * session, not the migrator's.
 *
 * WHAT IS AND IS NOT IN IT.
 *   pg_catalog  — explicit rather than implicit, so the order is stated.
 *   public      — where the extensions the published migrations need live.
 *   NOT `"$user"` — it resolves to a schema named after the current role, which
 *                   under SET LOCAL ROLE is `ai_capital_owner`. No such schema
 *                   exists, and if one were ever created it would silently take
 *                   precedence over `public` for every unqualified name.
 *   NOT any application schema — `identity`, `investment_ledger`, `portfolio`
 *                   and the rest are always written qualified (asserted by
 *                   tests/migration-session.test.ts), and putting them here
 *                   would make an unqualified name in a future migration
 *                   resolve silently instead of failing loudly.
 *
 * THIS GRANTS NOTHING. A search path only decides which schemas are searched
 * for an unqualified name; every ACL still applies, and `public` remains
 * revoked from PUBLIC with USAGE granted to the owner alone.
 */
const MIGRATION_SEARCH_PATH = 'pg_catalog, public'

export interface MigrationResult {
  applied: string[]
  alreadyApplied: string[]
  skipped: string[]
}

export async function runMigrations(): Promise<MigrationResult> {
  const pool = getPool()
  await pool.query(BOOTSTRAP_SQL)

  const filenames = readdirSync(MIGRATIONS_DIR)
    .filter(f => f.endsWith('.sql'))
    .sort()

  const result: MigrationResult = { applied: [], alreadyApplied: [], skipped: [] }

  const { rows: existing } = await pool.query<{ filename: string; sha256: string }>(
    'SELECT filename, sha256 FROM db.schema_migrations',
  )
  const known = new Map(existing.map(r => [r.filename, r.sha256]))

  for (const filename of filenames) {
    const sql  = readFileSync(join(MIGRATIONS_DIR, filename), 'utf-8')
    const hash = sha256(sql)
    const existingHash = known.get(filename)

    if (existingHash) {
      if (existingHash !== hash) {
        // The file changed after being applied. Refuse to silently re-run.
        throw new Error(
          `Migration ${filename} was already applied with a different hash. ` +
          `Rename it or create a new migration to evolve the schema.`,
        )
      }
      result.alreadyApplied.push(filename)
      continue
    }

    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      // SET LOCAL is scoped to this transaction and reverts at COMMIT, so the
      // migration body runs as the owner while the INSERT below stays with the
      // connecting role — which is the one holding INSERT on schema_migrations.
      // The role name is operator-supplied configuration, never request data,
      // and is quoted regardless.
      // ORDER: role first, then search path, then the migration body.
      //
      // The path is set AFTER `SET LOCAL ROLE` because `"$user"` — which this
      // path deliberately omits — is evaluated against whichever role is
      // current, so setting it first would describe the wrong session. It is
      // set BEFORE the migration SQL because that is the only statement whose
      // name resolution it exists to govern.
      //
      // `SET LOCAL`, like the role above: it reverts at COMMIT *and* at
      // ROLLBACK, so nothing leaks into the ledger INSERT below or onto the
      // next borrower of this pooled connection. The value is a compile-time
      // constant, never configuration and never request data, so there is
      // nothing here to escape.
      if (MIGRATION_OWNER_ROLE) {
        await client.query(`SET LOCAL ROLE ${escapeIdentifier(MIGRATION_OWNER_ROLE)}`)
        await client.query(`SET LOCAL search_path = ${MIGRATION_SEARCH_PATH}`)
      }
      await client.query(sql)
      if (MIGRATION_OWNER_ROLE) {
        await client.query('RESET ROLE')
      }
      await client.query(
        'INSERT INTO db.schema_migrations(filename, sha256) VALUES ($1, $2)',
        [filename, hash],
      )
      await client.query('COMMIT')
      result.applied.push(filename)
    } catch (err) {
      await client.query('ROLLBACK')
      throw new Error(`Migration ${filename} failed: ${(err as Error).message}`)
    } finally {
      client.release()
    }
  }

  return result
}
