// THE STAGE-1 CLI AND ITS TRANSPORT — offline.
//
// Two things are proved here that no live test can show as clearly: that
// importing the entry point does NOTHING, and that there is no path anywhere in
// the CLI or its psql transport by which a password, a URL or an inherited
// environment variable could reach a child process.
//
// Importing the module IS the test for inertness: if the entry-point guard were
// removed, `runCli` would run at import time with vitest's own argv and the
// suite would fail loudly rather than quietly proving nothing.

import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import {
  CliRefused, DEFAULT_PSQL, EXIT_FAILED, EXIT_OK, EXIT_REFUSED, GIT, INGESTION_SUBMODULE,
  OPTIONS, REQUIRED, isDirectEntrypoint, parseArgs, repositoryProvenance,
} from '../bin/pg-copy-manifest.js'
import { FORBIDDEN_PSQL_ARGS, sterileBatchEnv } from '../src/pg-copy/export-role.js'
import {
  FIELD_SEP, PsqlBackendRefused, openPsqlBackendCount, psqlBackendArgs,
} from '../src/pg-copy/psql-backend.js'
import { sqlWithoutComments } from '../src/pg-copy/source-manifest.js'

const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const strip = (text: string): string => text
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').filter(l => !/^\s*(\/\/|\*)/.test(l)).join('\n')

const CLI = strip(readFileSync(join(PKG_ROOT, 'bin', 'pg-copy-manifest.ts'), 'utf-8'))
const TRANSPORT = strip(readFileSync(join(PKG_ROOT, 'src', 'pg-copy', 'psql-backend.ts'), 'utf-8'))

const GOOD: readonly string[] = Object.freeze([
  '--evidence-root', '/tmp/ev',
  '--host', '/tmp/sock',
  '--port', '5432',
  '--database', 'ai_capital',
  '--export-passfile', '/tmp/secrets/export.pgpass',
  '--supervisor-user', 'thanapold',
  '--supervisor-passfile', '/tmp/secrets/admin.pgpass',
  '--expected-target', 'ai-capital-v3',
  '--source-system', 'ai-capital-v2',
  '--source-endpoint', '/tmp/sock',
  '--provenance-head', 'b'.repeat(40),
])

describe('the entry point is inert on import', () => {
  it('did not run: importing this module produced no side effect', () => {
    // If the guard were gone, `runCli` would already have executed against
    // vitest's argv by the time this line runs.
    expect(openPsqlBackendCount()).toBe(0)
  })

  it('only runs when argv[1] IS this module', () => {
    expect(isDirectEntrypoint(undefined, import.meta.url)).toBe(false)
    expect(isDirectEntrypoint('/somewhere/else.js', import.meta.url)).toBe(false)
    expect(isDirectEntrypoint(fileURLToPath(import.meta.url), import.meta.url)).toBe(true)
  })

  it('guards the entry point in source, not by convention', () => {
    expect(CLI).toContain('isDirectEntrypoint(process.argv[1], import.meta.url)')
  })

  it('exits 0, 1 and 2 for success, failure and refusal', () => {
    expect([EXIT_OK, EXIT_FAILED, EXIT_REFUSED]).toEqual([0, 1, 2])
  })
})

describe('the option surface admits no credential', () => {
  it('has no url, password, secret or connection-string option', () => {
    for (const o of OPTIONS) {
      expect(o, o).not.toMatch(/url|password|secret|passwd|conn/i)
    }
    // The only credential-shaped options are PASSFILE PATHS.
    expect(OPTIONS.filter(o => /pass/i.test(o)).sort())
      .toEqual(['--export-passfile', '--supervisor-passfile'])
  })

  it('requires every connection and provenance option, and nothing optional matters', () => {
    expect([...REQUIRED].every(r => OPTIONS.includes(r))).toBe(true)
    expect(OPTIONS.filter(o => !REQUIRED.includes(o)).sort()).toEqual(['--psql', '--run-id'])
  })

  it('reads no environment variable and names no fallback', () => {
    expect(CLI).not.toMatch(/process\.env/)
    expect(CLI).not.toMatch(/PGPASSWORD|PGUSER|PGHOST|PGDATABASE/)
    expect(CLI).not.toMatch(/DATABASE_URL/)
  })

  it('constructs no target connection and names no target session', () => {
    expect(CLI).not.toMatch(/targetSession|targetUrl|targetClient|targetPool/i)
    expect(CLI).not.toMatch(/from\s+'pg'/)
    expect(CLI).not.toMatch(/\bnew\s+(Pool|Client)\b/)
    // Three sessions, all on the SOURCE.
    expect(CLI.match(/openPsqlBackend\(\{/g)?.length).toBe(3)
  })

  it('names the reviewed git binary and submodule by absolute path', () => {
    expect(GIT).toBe('/usr/bin/git')
    expect(INGESTION_SUBMODULE).toBe('apps/capital-intelligence-ingestion')
    expect(DEFAULT_PSQL.startsWith('/')).toBe(true)
  })
})

describe('argument parsing refuses rather than ignores', () => {
  it('accepts the reviewed set', () => {
    const a = parseArgs(GOOD)
    expect(a['--database']).toBe('ai_capital')
    expect(a['--provenance-head']).toBe('b'.repeat(40))
  })

  it('refuses an unknown option rather than skipping it', () => {
    expect(() => parseArgs([...GOOD, '--target-url', 'postgresql://u:p@h/db']))
      .toThrow(/not a recognised option/)
    expect(() => parseArgs([...GOOD, '--evidenceroot', '/tmp/x']))
      .toThrow(/not a recognised option/)
  })

  it('refuses a missing value, a repeated option and a missing requirement', () => {
    expect(() => parseArgs(['--database'])).toThrow(/needs a value/)
    expect(() => parseArgs(['--database', '--host'])).toThrow(/needs a value/)
    expect(() => parseArgs([...GOOD, '--run-id', 'aaaa1111', '--run-id', 'bbbb2222']))
      .toThrow(/was given twice/)
    expect(() => parseArgs(GOOD.slice(0, 2))).toThrow(/is required/)
  })

  it('requires every path option to be absolute', () => {
    for (const p of ['--evidence-root', '--export-passfile', '--supervisor-passfile']) {
      const bad = [...GOOD]
      bad[bad.indexOf(p) + 1] = 'relative/path'
      expect(() => parseArgs(bad), p).toThrow(/must be an absolute path/)
    }
  })

  it('refusals are CliRefused, and carry no value the caller supplied', () => {
    const canary = 'postgresql://u:pw_canary@h/db'
    let thrown: unknown = null
    try { parseArgs([...GOOD, '--run-id', canary, '--run-id', canary]) } catch (e) { thrown = e }
    expect(thrown).toBeInstanceOf(CliRefused)
    expect(String((thrown as Error).message)).not.toContain('pw_canary')
  })
})

describe('the psql transport', () => {
  it('puts identity in argv and the secret nowhere but a PGPASSFILE path', () => {
    const args = psqlBackendArgs({
      psqlPath: '/opt/psql', host: '/tmp/sock', port: 5432,
      database: 'ai_capital', user: 'ai_capital_v3_export',
      passfile: '/tmp/secrets/export.pgpass',
    })
    expect(args).toContain('--no-psqlrc')
    expect(args).toContain('/tmp/sock')
    expect(args).toContain('ai_capital_v3_export')
    // Nothing in argv is or contains a secret or a path to one.
    expect(args.join(' ')).not.toContain('export.pgpass')
    expect(args.join(' ')).not.toMatch(/password|postgresql:\/\//i)

    const env = sterileBatchEnv('/tmp/secrets/export.pgpass')
    expect(env.PGPASSFILE).toBe('/tmp/secrets/export.pgpass')
    expect(env.PGPASSWORD).toBeUndefined()
    expect(Object.keys(env).sort()).toEqual(['LANG', 'LC_ALL', 'PATH', 'PGPASSFILE'])
  })

  it('refuses every argument that would put SQL or a secret in a process list', () => {
    for (const banned of FORBIDDEN_PSQL_ARGS) {
      expect(psqlBackendArgs({
        psqlPath: '/opt/psql', host: 'h', port: 1, database: 'd', user: 'u',
      }), banned).not.toContain(banned)
    }
    // Notably absent: `-f -`. psql reads stdin by default, so the ban is total.
    expect(psqlBackendArgs({
      psqlPath: '/opt/psql', host: 'h', port: 1, database: 'd', user: 'u',
    })).not.toContain('-f')
  })

  it('refuses a relative binary, a relative passfile and a nonsense port', () => {
    const base = { psqlPath: '/opt/psql', host: 'h', port: 5432, database: 'd', user: 'u' }
    expect(() => psqlBackendArgs({ ...base, psqlPath: 'psql' })).toThrow(PsqlBackendRefused)
    expect(() => psqlBackendArgs({ ...base, passfile: 'rel' })).toThrow(/absolute/)
    for (const port of [0, -1, 70_000, 1.5]) {
      expect(() => psqlBackendArgs({ ...base, port }), String(port)).toThrow(/port/)
    }
  })

  it('splits on the unit separator, never on the pipe a catalogue value contains', () => {
    expect(FIELD_SEP).toBe('\x1f')
    expect(psqlBackendArgs({
      psqlPath: '/opt/psql', host: 'h', port: 1, database: 'd', user: 'u',
    })).toContain(FIELD_SEP)
    // ONE authority: the test harness re-exports this constant rather than
    // defining a second one.
    expect(TRANSPORT).toContain("export const FIELD_SEP = '\\x1f'")
  })

  it('never inherits an environment and never names a password variable', () => {
    expect(TRANSPORT).not.toMatch(/process\.env/)
    expect(TRANSPORT).not.toMatch(/PGPASSWORD/)
    expect(TRANSPORT).toContain('sterileBatchEnv')
  })

  it('does not name a failing statement when it times out', () => {
    // A batch can carry a SCRAM verifier; the timeout message must not echo it.
    expect(TRANSPORT).toContain('the psql session timed out on a statement.')
    expect(TRANSPORT).not.toMatch(/timed out on: \$\{/)
  })
})

describe('the SQL comment stripper the guard depends on', () => {
  it('removes line and block comments but keeps the statement', () => {
    expect(sqlWithoutComments('SELECT 1 -- last_value\n, 2')).toBe('SELECT 1 \n, 2')
    expect(sqlWithoutComments('SELECT /* is_called */ 1')).toBe('SELECT  1')
    expect(sqlWithoutComments('SELECT 1')).toBe('SELECT 1')
  })

  it('does NOT strip a comment marker inside a string literal', () => {
    // If it did, the rest of a real statement would vanish and a genuine read
    // could hide behind a quoted '--'.
    expect(sqlWithoutComments("SELECT '--', last_value FROM s"))
      .toBe("SELECT '--', last_value FROM s")
    expect(sqlWithoutComments("SELECT 'it''s -- fine', is_called FROM s"))
      .toContain('is_called')
  })

  it('is not vacuous: it changes exactly the text a comment occupies', () => {
    const withComment = "SELECT a -- pg_sequences is not joined\nFROM t"
    expect(withComment).toContain('pg_sequences')
    expect(sqlWithoutComments(withComment)).not.toContain('pg_sequences')
    expect(sqlWithoutComments(withComment)).toContain('FROM t')
  })
})

describe('repository provenance', () => {
  it('reads two heads from a clean checkout, and REFUSES a dirty one', () => {
    // This repository IS the checkout under test, and during development it is
    // dirty. Both outcomes are asserted, because asserting only the clean one
    // would make the test pass or fail on where in a commit cycle it happened
    // to run - and a test that reports the working tree is not a test.
    let got: { implementationHead: string; ingestionGitlink: string } | null = null
    let thrown: unknown = null
    try { got = repositoryProvenance() } catch (e) { thrown = e }
    if (got !== null) {
      expect(got.implementationHead).toMatch(/^[0-9a-f]{40}$/)
      expect(got.ingestionGitlink).toMatch(/^[0-9a-f]{40}$/)
    } else {
      expect(thrown).toBeInstanceOf(CliRefused)
      expect(String((thrown as Error).message)).toMatch(/worktree is not clean/)
    }
  })

  it('refuses a dirty tree rather than recording an unretrievable head', () => {
    // The rule itself, asserted on the source, so it holds when the tree above
    // happens to be clean.
    expect(CLI).toContain("git(['status', '--porcelain', '--untracked-files=all'])")
    expect(CLI).toContain('the repository worktree is not clean')
    expect(CLI).toContain("/^160000 ([0-9a-f]{40}) /")
  })

  it('never carries git error text into a refusal', () => {
    expect(CLI).toContain('could not read repository provenance')
    expect(CLI).not.toMatch(/e instanceof Error \? e\.message : String\(e\)\s*\)\s*\n\s*\}\s*\n\}/)
  })
})
