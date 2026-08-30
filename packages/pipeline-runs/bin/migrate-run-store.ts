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
import { existsSync, readFileSync, statSync } from 'fs'
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

// ── INSPECTION: never opens a connection to the source at all ─────────────
//
// This used to be `new Database(path)` — a WRITE-CAPABLE connection — opened
// before the `--apply` branch, while printing "INSPECT (no writes)". On the
// production store, which is in WAL mode, that was false twice over: the open
// rewrote the `-wal` sidecar AND the `-shm` sidecar. A read-only connection is
// not sufficient either; it still materialises `-shm`.
//
// So inspection does not connect to the source. It READS the main database
// file's bytes and opens a private in-memory copy of them. No lock is taken, no
// sidecar is created or touched, and nothing can be written back.
//
// THE COST, STATED HONESTLY: the WAL is not read, so this sees the database as
// of its last checkpoint. Rows and schema changes sitting in the WAL are
// invisible. Reading the WAL would require the shared-memory index — i.e. a
// write — which is exactly the guarantee being kept, so the count is reported
// as UNAVAILABLE rather than understated whenever a WAL is present.
interface Inspection {
  columns: string[]
  mainFileRows: number
  walBytes: number | null
}

function inspectWithoutTouching(dbPath: string): Inspection {
  const bytes = readFileSync(dbPath)                 // a pure read; no lock, no sidecar

  // Fail closed on anything that is not a SQLite database. Without this, a
  // truncated or wrong-typed file reached the deserializer and surfaced as an
  // unhandled native stack trace — which reads as a tool bug rather than as
  // "you pointed me at the wrong file".
  const MAGIC = 'SQLite format 3\0'
  if (bytes.length === 0 || bytes.subarray(0, MAGIC.length).toString('binary') !== MAGIC) {
    console.error(`[migrate-run-store] not a SQLite database: ${dbPath}`)
    console.error(`  ${bytes.length === 0 ? 'The file is empty.' : 'The file header is not "SQLite format 3".'}`)
    console.error('  Refusing to guess. Check the path before migrating anything.')
    process.exit(1)
  }

  // A database whose header says WAL cannot be deserialized into memory, so the
  // file-format version bytes are normalised ON THE COPY. The source file is
  // never written; this buffer only ever exists in this process.
  const copy = Buffer.from(bytes)
  if (copy.length > 19 && copy[18] === 2 && copy[19] === 2) {
    copy[18] = 1
    copy[19] = 1
  }

  const mem = new Database(copy)
  try {
    const columns = (mem.prepare(`SELECT name FROM pragma_table_info('pipeline_runs')`).all() as Array<{ name: string }>)
      .map(c => c.name)
    const mainFileRows = columns.length === 0
      ? 0
      : (mem.prepare('SELECT COUNT(*) AS n FROM pipeline_runs').get() as { n: number }).n
    if (columns.length === 0) {
      // A real store always has this table. Reporting "0 columns (legacy)" would
      // invite an --apply against a database that is not the run store.
      console.error(`[migrate-run-store] no pipeline_runs table in ${dbPath}`)
      console.error('  This is a SQLite database, but not a run store. Refusing to migrate it.')
      process.exit(1)
    }
    const walPath = `${dbPath}-wal`
    const walBytes = existsSync(walPath) ? statSync(walPath).size : null
    return { columns, mainFileRows, walBytes }
  } finally {
    mem.close()
  }
}

if (!APPLY) {
  const { columns, mainFileRows, walBytes } = inspectWithoutTouching(path)
  const migrated = columns.includes('logical_date') && columns.includes('superseded_at')
  const walResident = walBytes !== null && walBytes > 0

  console.log(`database : ${path}`)
  console.log(`mode     : INSPECT (no connection opened — the store is not touched; pass --apply to migrate)`)
  console.log(`source   : main database file only${walResident ? ' — the WAL was NOT read' : ''}`)
  console.log(`columns  : ${columns.length} (${migrated ? 'already migrated' : 'legacy — logical_date/superseded_at missing'})`)
  if (walResident) {
    // Never present the main-file figure as the database's row count when
    // committed rows may be sitting in the WAL.
    console.log(`rows     : UNAVAILABLE — ${mainFileRows} in the main file, but a ${walBytes}-byte WAL is present`)
    console.log('           and reading it would require writing the shared-memory index.')
    console.log('WARNING  : uncheckpointed schema changes would also be invisible here, so the')
    console.log('           column verdict above describes the last checkpoint, not necessarily now.')
    console.log('           `--apply` opens the store properly and sees the WAL.')
  } else {
    console.log(`rows     : ${mainFileRows}`)
  }
  console.log(migrated
    ? 'nothing to do.'
    : 'would add: logical_date, superseded_at, and the partial unique index idx_daily_scheduled_logical_date.')
  process.exit(0)
}

// ── APPLY: the only mode authorized to touch the source store ─────────────
const db = new Database(path)          // raw open: openDb() fails closed pre-migration
try {
  const before = (db.prepare(`SELECT name FROM pragma_table_info('pipeline_runs')`).all() as Array<{ name: string }>)
    .map(c => c.name)
  const rows = (db.prepare('SELECT COUNT(*) AS n FROM pipeline_runs').get() as { n: number }).n
  const migrated = hasScheduledIdentity(db)

  console.log(`database : ${path}`)
  console.log(`rows     : ${rows}`)
  console.log(`columns  : ${before.length} (${migrated ? 'already migrated' : 'legacy — logical_date/superseded_at missing'})`)
  console.log('mode     : APPLY')

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
