#!/usr/bin/env tsx
/**
 * Explicit, additive migration of the run store to scheduled-run identity.
 *
 * DEFAULTS TO INSPECTION. `--apply` is required to change anything.
 *
 * This is deliberately a separate operator action rather than something
 * `openDb()` does on first write: the run store is authoritative history, and a
 * schema change to it must be a decision, not a side effect. `openDb()` now
 * fails closed with a pointer to this command when it meets an unmigrated
 * store.
 *
 * Never creates a database. A migration tool that conjures an empty store on a
 * typo'd path produces a decoy that reads as healthy — the same failure mode
 * openDbReadOnly() exists to prevent.
 */
import { existsSync } from 'fs'
import Database from 'better-sqlite3'
import { resolveDbPath, hasScheduledIdentity, migrateScheduledRunIdentity } from '../src/store.js'

// STRICT ARGUMENT PARSING, AND IT IS A SAFETY CONTROL.
//
// The previous parser did `argv[i+1] ? argv[i+1] : resolveDbPath()`. So
// `--apply --db` — a `--db` whose value the operator forgot, or that an empty
// shell variable erased — silently fell back to PIPELINE_RUNS_DB or the
// repository default and migrated THE PRODUCTION RUN STORE. A malformed command
// must never resolve to a more dangerous target than the one that was written.
// It now rejects before opening anything at all.
const USAGE = [
  'usage: migrate-run-store [--db <path>] [--apply]',
  '',
  '  --db <path>   the run store to inspect or migrate (default: PIPELINE_RUNS_DB',
  '                or the repository store)',
  '  --apply       perform the migration; without it nothing is written',
  '  --help, -h    show this message',
].join('\n')

function usageError(message: string): never {
  console.error(`[migrate-run-store] ${message}`)
  console.error(USAGE)
  process.exit(2)
}

let APPLY = false
let dbArg: string | undefined
const argv = process.argv.slice(2)

for (let i = 0; i < argv.length; i++) {
  const arg = argv[i]
  switch (arg) {
    case '--apply':
      APPLY = true
      break
    case '--help':
    case '-h':
      console.log(USAGE)
      process.exit(0)
      break
    case '--db': {
      if (dbArg !== undefined) usageError('--db given more than once')
      const value = argv[i + 1]
      // A missing value and a following flag are the same mistake, and both
      // used to end in a silent fallback to the production path.
      if (value === undefined) usageError('--db requires a path')
      if (value.startsWith('-')) usageError(`--db requires a path, got the flag '${value}'`)
      dbArg = value
      i++
      break
    }
    default:
      usageError(`unknown argument '${arg}'`)
  }
}

const path = dbArg ?? resolveDbPath()

if (!existsSync(path)) {
  console.error(`[migrate-run-store] refusing to migrate a database that does not exist: ${path}`)
  console.error('  Creating it here would produce an empty store that reads as healthy.')
  process.exit(1)
}

const db = new Database(path)          // raw open: openDb() fails closed pre-migration
try {
  const before = (db.prepare(`SELECT name FROM pragma_table_info('pipeline_runs')`).all() as Array<{ name: string }>)
    .map(c => c.name)
  const rows = (db.prepare('SELECT COUNT(*) AS n FROM pipeline_runs').get() as { n: number }).n
  const migrated = hasScheduledIdentity(db)

  console.log(`database : ${path}`)
  console.log(`rows     : ${rows}`)
  console.log(`columns  : ${before.length} (${migrated ? 'already migrated' : 'legacy — logical_date/superseded_at missing'})`)
  console.log(`mode     : ${APPLY ? 'APPLY' : 'INSPECT (no writes — pass --apply to migrate)'}`)

  if (!APPLY) {
    console.log(migrated
      ? 'nothing to do.'
      : 'would add: logical_date, superseded_at, and the partial unique index idx_daily_scheduled_logical_date.')
    process.exit(0)
  }

  const report = migrateScheduledRunIdentity(db)
  const after = (db.prepare(`SELECT COUNT(*) AS n FROM pipeline_runs`).get() as { n: number }).n

  console.log(report.alreadyMigrated
    ? 'already migrated — no columns added (idempotent no-op).'
    : `applied: added ${report.columnsAdded.join(', ') || 'no'} column(s); unique index ensured.`)
  console.log(`rows before/after: ${rows}/${after}${rows === after ? '  (preserved)' : '  ** ROW COUNT CHANGED **'}`)
  process.exit(0)
} finally {
  db.close()
}
