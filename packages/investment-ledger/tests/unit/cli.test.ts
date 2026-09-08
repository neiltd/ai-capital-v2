import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
import { parseArgs } from '../../bin/import-archive.js'
import { MASTER_ARCHIVE_SERIES, assertSeriesKey } from '../../src/series.js'

// F1: the changed-archive path must be exercised through the ACTUAL command
// boundary. The previous CLI enforced an internal snapshot expectation
// before the apply branch, so a changed archive could never reach
// publishArchive() at all — the linked batch and reconciliation case were
// unreachable claims. These tests drive bin/import-archive.ts as a process.
//
// PORTABLE BY CONSTRUCTION. Every case here runs against a committed SYNTHETIC
// fixture, never the real archive. The gates under test — argument parsing,
// digest matching, series identity, the database guard — are properties of the
// command, not of any particular data, so proving them needs no private file
// and no database. Assertions that are genuinely about the operator's real
// archive live in tests/archive/, a separate, explicitly-run suite.

const PKG = resolve(__dirname, '..', '..')
const CLI = join(PKG, 'bin', 'import-archive.ts')
const TSX = join(PKG, 'node_modules', '.bin', 'tsx')
const FIXTURE = join(PKG, 'tests', 'fixtures', 'synthetic-archive.csv')
const FIXTURE_SHA = createHash('sha256').update(readFileSync(FIXTURE)).digest('hex')
// A syntactically valid workspace. Nothing resolves it here: these cases stop
// at argument gates, before any database is consulted.
const TEST_WS = '11111111-2222-4333-8444-555555555555'

/**
 * Run the CLI with NO database selectable, so no apply can reach ANY database.
 *
 * Both variables must go: in a test runtime `usePostgres()` is
 * `!!(TEST_DATABASE_URL || DATABASE_URL)`, so clearing only DATABASE_URL let an
 * earlier version of this test publish a whole archive into the isolated test
 * database. These tests assert gate behaviour, not publication.
 */
function cli(args: string[]) {
  const env = { ...process.env }
  delete env.DATABASE_URL
  delete env.TEST_DATABASE_URL
  const r = spawnSync(TSX, [CLI, ...args], { encoding: 'utf-8', timeout: 120_000, env })
  return { code: r.status, out: `${r.stdout ?? ''}`, err: `${r.stderr ?? ''}` }
}

describe('CLI argument parsing fails closed', () => {
  it('--csv is mandatory and has no default', () => {
    expect(() => parseArgs([])).toThrow(/--csv <path> is required and has no default/)
    expect(() => parseArgs(['--apply'])).toThrow(/--csv <path> is required/)
  })

  it('--csv without a value never silently selects another argument', () => {
    expect(() => parseArgs(['--csv'])).toThrow(/--csv requires a path/)
    expect(() => parseArgs(['--csv', '--apply'])).toThrow(/got the flag '--apply'/)
  })

  it('rejects duplicates and unknown arguments', () => {
    expect(() => parseArgs(['--csv', 'a', '--csv', 'b'])).toThrow(/--csv given more than once/)
    expect(() => parseArgs(['--csv', 'a', '--apply', '--apply'])).toThrow(/--apply given more than once/)
    expect(() => parseArgs(['--csv', 'a', '--force'])).toThrow(/unknown argument '--force'/)
  })

  it('validates the expected digest shape', () => {
    expect(() => parseArgs(['--csv', 'a', '--expect-sha256'])).toThrow(/requires a 64-character hex digest/)
    expect(() => parseArgs(['--csv', 'a', '--expect-sha256', 'abc'])).toThrow(/64 lowercase hex/)
    expect(parseArgs(['--csv', 'a', '--expect-sha256', FIXTURE_SHA]).expectSha256).toBe(FIXTURE_SHA)
  })

  it('resolves the named path and defaults nothing else', () => {
    const o = parseArgs(['--csv', FIXTURE])
    expect(o.apply).toBe(false)
    expect(o.expectSha256).toBeNull()
    expect(o.series).toBeNull()
    expect(o.csv).toBe(resolve(FIXTURE))
  })

  it('infers no path from the environment', () => {
    // Even with the archive variable set, an omitted --csv is still a refusal:
    // the CLI never reads that variable, so nothing can select a file for the
    // operator.
    const prior = process.env.INVESTMENT_ARCHIVE_CSV
    process.env.INVESTMENT_ARCHIVE_CSV = FIXTURE
    try {
      expect(() => parseArgs([])).toThrow(/--csv <path> is required/)
    } finally {
      if (prior === undefined) delete process.env.INVESTMENT_ARCHIVE_CSV
      else process.env.INVESTMENT_ARCHIVE_CSV = prior
    }
  })

  it('parses and validates --series, and never invents one', () => {
    expect(parseArgs(['--csv', 'a', '--series', MASTER_ARCHIVE_SERIES]).series).toBe(MASTER_ARCHIVE_SERIES)
    expect(() => parseArgs(['--csv', 'a', '--series'])).toThrow(/--series requires a series key/)
    expect(() => parseArgs(['--csv', 'a', '--series', '--apply'])).toThrow(/got the flag '--apply'/)
    expect(() => parseArgs(['--csv', 'a', '--series', 'a:b', '--series', 'c:d'])).toThrow(/--series given more than once/)
    expect(() => parseArgs(['--csv', 'a', '--series', 'Not A Series'])).toThrow(/invalid series key/)
    expect(() => parseArgs(['--csv', 'a', '--series', 'nocolon'])).toThrow(/invalid series key/)
    expect(() => parseArgs(['--csv', 'a', '--series', 'legacy:unclassified'])).toThrow(/not a publish target/)
  })
})

describe('series identity fails closed', () => {
  it('has no default and rejects anything ambiguous', () => {
    expect(() => assertSeriesKey(null)).toThrow(/required and has no default/)
    expect(() => assertSeriesKey('')).toThrow(/required and has no default/)
    expect(() => assertSeriesKey('   ')).toThrow(/required and has no default/)
    expect(assertSeriesKey('  archive:master  ')).toBe('archive:master')
    expect(assertSeriesKey('broker:innovestx-2026q3')).toBe('broker:innovestx-2026q3')
  })
})

describe('CLI refuses to run without an explicit archive', () => {
  it('exits non-zero with no --csv, before reading anything', () => {
    const r = cli([])
    expect(r.code).toBe(1)
    expect(r.err).toMatch(/--csv <path> is required and has no default/)
    expect(r.out).toBe('')                       // nothing inspected, nothing printed
  })
})

describe('CLI inspect mode (no database connection)', () => {
  it('inspects the named file and opens no database', () => {
    const r = cli(['--csv', FIXTURE])
    expect(r.code, r.err).toBe(0)
    const body = JSON.parse(r.out.slice(r.out.indexOf('{'), r.out.lastIndexOf('}') + 1))
    expect(body.mode).toBe('inspect')
    expect(body.csv).toBe(resolve(FIXTURE))
    expect(body.sha256).toBe(FIXTURE_SHA)
    expect(body.rows).toBe(12)
    expect(r.out).toContain('No database connection was opened')
  })

  it('reports COMPUTED FACTS only, and no approved-snapshot verdict', () => {
    // The CLI has no built-in notion of "the approved archive" any more. It
    // reports what it computed about the file it was given; whether those bytes
    // are the right ones is the operator's assertion, made with --expect-sha256.
    const r = cli(['--csv', FIXTURE])
    const body = JSON.parse(r.out.slice(r.out.indexOf('{'), r.out.lastIndexOf('}') + 1))
    expect(body).not.toHaveProperty('matchesApprovedSnapshot')
    expect(body).not.toHaveProperty('approvedSnapshotMismatches')
    expect(r.out).not.toMatch(/approved snapshot/i)
    // The facts it does report are the ones computed from this file.
    expect(body.logicalSourceFiles).toBe(9)
    expect(body.switchGroups).toBe(3)
    expect(body.incompleteSwitchGroups).toEqual([])
    expect(body.negativePositionKeys).toHaveLength(4)
    expect(body.currencyRows).toEqual({ THB: 12 })
  })

  it('accepts a structurally valid CHANGED archive derived from the fixture', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ledger-cli-'))
    try {
      const changed = join(dir, 'changed.csv')
      const lines = readFileSync(FIXTURE, 'utf8').split('\n')
      writeFileSync(changed, lines.slice(0, lines.length - 2).join('\n') + '\n')  // drop one row
      const r = cli(['--csv', changed])
      expect(r.code, r.err).toBe(0)
      const body = JSON.parse(r.out.slice(r.out.indexOf('{'), r.out.lastIndexOf('}') + 1))
      expect(body.rows).toBe(11)
      expect(body.sha256).not.toBe(FIXTURE_SHA)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})

describe('CLI apply mode requires an explicit, matching digest', () => {
  it('refuses --apply with no --expect-sha256', () => {
    const r = cli(['--csv', FIXTURE, '--apply'])
    expect(r.code).toBe(1)
    expect(r.err).toMatch(/--apply requires --expect-sha256/)
  })

  it('refuses a digest that does not match the inspected bytes', () => {
    const wrong = createHash('sha256').update('not-the-archive').digest('hex')
    const r = cli(['--csv', FIXTURE, '--apply', '--expect-sha256', wrong])
    expect(r.code).toBe(1)
    expect(r.err).toMatch(/does not match the inspected archive/)
  })

  it('refuses --apply without --series, before any database is consulted', () => {
    const r = cli(['--csv', FIXTURE, '--apply', '--expect-sha256', FIXTURE_SHA])
    expect(r.code).toBe(1)
    expect(r.err).toMatch(/--apply requires --series/)
    expect(r.err).not.toMatch(/requires DATABASE_URL/)
  })

  it('stops at the database guard once every argument gate is satisfied', () => {
    const r = cli(['--csv', FIXTURE, '--apply', '--expect-sha256', FIXTURE_SHA,
                   '--series', 'test-fixture:synthetic', '--workspace', TEST_WS])
    expect(r.code).toBe(1)
    expect(r.err).toMatch(/--apply requires DATABASE_URL/)
  })

  it('any archive the operator vouches for reaches the apply path', () => {
    // NON-VACUITY. An earlier CLI died before any apply logic, on an internal
    // expectation that the bytes match a snapshot compiled into the package —
    // so a legitimately revised archive could never be published at all. Here a
    // changed file passes every gate that remains and stops only at the
    // DATABASE_URL guard, which is to say it reached publication.
    const dir = mkdtempSync(join(tmpdir(), 'ledger-cli-'))
    try {
      const changed = join(dir, 'changed.csv')
      const lines = readFileSync(FIXTURE, 'utf8').split('\n')
      writeFileSync(changed, lines.slice(0, lines.length - 2).join('\n') + '\n')
      const sha = createHash('sha256').update(readFileSync(changed)).digest('hex')
      const r = cli(['--csv', changed, '--apply', '--expect-sha256', sha,
                     '--series', 'test-changed:archive', '--workspace', TEST_WS])
      expect(r.code).toBe(1)
      expect(r.err).toMatch(/--apply requires DATABASE_URL/)
      expect(r.err).not.toMatch(/approved/i)
      expect(r.err).not.toMatch(/--expect-sha256 .* does not match/)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})

// ── Importing the CLI module must be INERT ─────────────────────────────────
//
// THE DEFECT THIS LOCKS DOWN. `bin/import-archive.ts` ended in a bare
// `main().catch(...).finally(() => closePool())`, so merely importing it — which
// this very file does, three lines up, to reach parseArgs — ran the whole
// command. With no --csv it printed the usage error to stderr, set
// process.exitCode = 1 and called closePool(). The suite still passed, because
// Vitest decides the worker's exit code itself and never surfaced the mutation.
// A green unit suite was therefore compatible with every import shouting at
// stderr and poisoning the exit status of whatever imported it.
//
// A mock cannot prove the fix: it proves the mock was not called. So this drives
// a REAL child process with every database credential removed, imports the real
// module, and inspects the process it leaves behind.

const PROBE_SENTINEL = 'IMPORT_INERT_SENTINEL'

/** `import(module)` in a fresh, database-disabled process; report what it did. */
function importInChild(modulePath: string) {
  const env = { ...process.env }
  for (const key of ['DATABASE_URL', 'TEST_DATABASE_URL', 'TEST_RUNTIME_DATABASE_URL',
                     'BOOTSTRAP_DATABASE_URL', 'AGENT_DATABASE_URL', 'INVESTMENT_ARCHIVE_CSV']) {
    delete env[key]
  }
  const script =
    `import(${JSON.stringify(modulePath)})` +
    `.then(() => console.log('${PROBE_SENTINEL} exitCode=' + String(process.exitCode)))`
  const r = spawnSync(TSX, ['-e', script], { cwd: PKG, encoding: 'utf-8', timeout: 120_000, env })
  return { code: r.status, out: `${r.stdout ?? ''}`, err: `${r.stderr ?? ''}` }
}

describe('importing the CLI module performs no work', () => {
  it('exits 0, writes nothing to stderr, and leaves process.exitCode unset', () => {
    const r = importInChild(CLI)
    expect(r.err, 'the import wrote to stderr').toBe('')
    expect(r.code, 'the import changed the child process exit status').toBe(0)
    expect(r.out).toContain(`${PROBE_SENTINEL} exitCode=undefined`)
    // The specific symptom, named: no argument validation ran.
    expect(r.out).not.toMatch(/--csv <path> is required/)
    expect(r.out.replace(new RegExp(`${PROBE_SENTINEL}.*\n?`), ''), 'the import wrote to stdout').toBe('')
  })

  it('NON-VACUOUS: the same probe catches an unguarded copy of this very file', () => {
    // Takes the REAL source, deletes only the entrypoint guard, and shows the
    // assertions above fail against it. Without this, a probe that could never
    // fail would look exactly like a passing one.
    //
    // The copy lives beside the original so its relative imports still resolve,
    // and is removed in `finally`.
    // The control lives in the OS temp directory, NOT inside bin/. Writing a
    // file into the package meant a crash between write and cleanup left an
    // untracked path that .gitignore did not cover — which the repository's
    // bounded-commit audits would then flag as an unexplained collision. The
    // three relative import specifiers are rewritten to absolute file:// URLs
    // as part of the same transformation, so the copy still resolves.
    const dir = mkdtempSync(join(tmpdir(), 'ledger-inertness-'))
    const control = join(dir, 'import-archive-unguarded.ts')
    try {
      const source = readFileSync(CLI, 'utf-8')
      expect(source, 'the guard must be present to be removable').toContain('if (isProcessEntrypoint()) {')
      let unguarded = source.replace(
        /if \(isProcessEntrypoint\(\)\) \{\n([\s\S]*?)\n\}\n?$/,
        (_full, body: string) => `${body.replace(/^ {2}/gm, '')}\n`)
      expect(unguarded, 'the guard removal must actually change the source').not.toBe(source)
      expect(unguarded).not.toContain('if (isProcessEntrypoint()) {')
      expect(unguarded, 'the invocation itself must survive removal').toContain('main().catch(')
      unguarded = unguarded.replace(
        /from '\.\.\/src\/([A-Za-z0-9_.-]+)'/g,
        (_m, f: string) => `from '${pathToFileURL(join(PKG, 'src', f)).href}'`)
      // `@common/db` is a workspace specifier and does not resolve from the OS
      // temp directory, so it is absolutised too. Without this the child fails
      // with ERR_PACKAGE_PATH_NOT_EXPORTED and the control would "pass" for
      // entirely the wrong reason.
      unguarded = unguarded.replace(
        /from '@common\/db'/g,
        `from '${pathToFileURL(join(PKG, '..', 'db', 'src', 'index.ts')).href}'`)
      expect(unguarded, 'relative src imports must be absolutised').not.toMatch(/from '\.\.\/src\//)
      expect(unguarded, 'workspace specifiers must be absolutised').not.toMatch(/from '@common\//)
      writeFileSync(control, unguarded)

      const r = importInChild(control)
      expect(r.err, 'the unguarded copy should have written the usage error').toMatch(/--csv <path> is required/)
      expect(r.out).toContain(`${PROBE_SENTINEL} exitCode=1`)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('executing the CLI directly still runs it', () => {
  it('rejects a missing --csv with a non-zero exit status', () => {
    // The other half of the contract: the guard must not make the command inert
    // when it IS the entrypoint. `cli()` spawns tsx with the file as argv[1].
    const r = cli([])
    expect(r.code).toBe(1)
    expect(r.err).toMatch(/--csv <path> is required and has no default/)
  })

  it('still inspects a named file, and opens no database doing it', () => {
    const r = cli(['--csv', FIXTURE])
    expect(r.code, r.err).toBe(0)
    const body = JSON.parse(r.out.slice(r.out.indexOf('{'), r.out.lastIndexOf('}') + 1))
    expect(body.mode).toBe('inspect')
    expect(body.rows).toBe(12)
    expect(r.out).toContain('No database connection was opened')
  })
})

describe('the workspace selector is an exact UUID', () => {
  const WS = TEST_WS

  it('parses --workspace and normalises its case', () => {
    expect(parseArgs(['--csv', 'a', '--workspace', WS.toUpperCase()]).workspace).toBe(WS)
  })

  it('rejects a slug, a partial UUID and a missing value', () => {
    expect(() => parseArgs(['--csv', 'a', '--workspace', 'my-workspace'])).toThrow(/exact UUID/)
    expect(() => parseArgs(['--csv', 'a', '--workspace', '1111'])).toThrow(/exact UUID/)
    expect(() => parseArgs(['--csv', 'a', '--workspace'])).toThrow(/requires a workspace UUID/)
    expect(() => parseArgs(['--csv', 'a', '--workspace', '--apply'])).toThrow(/got the flag/)
  })

  it('rejects a duplicate --workspace', () => {
    expect(() => parseArgs(['--csv', 'a', '--workspace', WS, '--workspace', WS]))
      .toThrow(/--workspace given more than once/)
  })

  it('defaults to null so inspect mode needs no workspace', () => {
    // Inspect opens no database and writes nothing, so it has no tenant to name.
    expect(parseArgs(['--csv', 'a']).workspace).toBeNull()
  })

  it('refuses --apply without --workspace, before any database is consulted', () => {
    const r = cli(['--csv', FIXTURE, '--apply', '--expect-sha256', FIXTURE_SHA,
                   '--series', 'test-fixture:synthetic'])
    expect(r.code).toBe(1)
    expect(r.err).toMatch(/--apply requires --workspace <uuid>/)
    expect(r.err, 'the workspace gate must precede the database gate')
      .not.toMatch(/requires DATABASE_URL/)
  })
})
