// Schema migration runner. Reads .sql files from packages/db/migrations/,
// tracks which have been applied in a `db.schema_migrations` table, and
// runs new ones in lexical order in a single transaction each.

import { readFileSync, readdirSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { createHash } from 'crypto'
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
      await client.query(sql)
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
