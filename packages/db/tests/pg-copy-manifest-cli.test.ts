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

import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { inspect } from 'node:util'

import { afterEach, describe, expect, it } from 'vitest'

import {
  CliRefused, DEFAULT_PSQL, EXIT_FAILED, EXIT_OK, EXIT_PUBLICATION_UNKNOWN,
  EXIT_PUBLISHED_INCOMPLETE, EXIT_PUBLISHED_UNVERIFIED, EXIT_REFUSED,
  GIT, INGESTION_SUBMODULE, OPTIONS, REQUIRED, dispositionOf, isDirectEntrypoint, parseArgs,
  repositoryProvenance,
} from '../bin/pg-copy-manifest.js'
import {
  EvidencePublicationUnknown, EvidencePublishedButUnverified, EvidenceRefused,
} from '../src/pg-copy/evidence.js'
import {
  ManifestRefused, Stage1PublishedButIncomplete, type Stage1PublishedPhase,
} from '../src/pg-copy/source-manifest.js'
import { FORBIDDEN_PSQL_ARGS, sterileBatchEnv } from '../src/pg-copy/export-role.js'
import {
  FIELD_SEP, PsqlBackendRefused, closeAllPsqlBackends, openPsqlBackend,
  openPsqlBackendCount, psqlBackendArgs,
} from '../src/pg-copy/psql-backend.js'
import { sqlWithoutComments } from '../src/pg-copy/source-manifest.js'

const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const strip = (text: string): string => text
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').filter(l => !/^\s*(\/\/|\*)/.test(l)).join('\n')

const CLI = strip(readFileSync(join(PKG_ROOT, 'bin', 'pg-copy-manifest.ts'), 'utf-8'))

/** Every surface an error could carry a secret on. */
const surfaces = (e: unknown): string => {
  const err = e as Error & Record<string, unknown>
  let json = ''
  try { json = JSON.stringify(err, Object.getOwnPropertyNames(err)) } catch { json = '' }
  const syms = Object.getOwnPropertySymbols(err)
    .map(s => `${String(s)}=${String((err as unknown as Record<symbol, unknown>)[s])}`)
  return [String(err.message), String(err.stack ?? ''),
          Object.getOwnPropertyNames(err).join(','), json, syms.join(','),
          inspect(err, { depth: 8, showHidden: true })].join('\n')
}
const TRANSPORT = strip(readFileSync(join(PKG_ROOT, 'src', 'pg-copy', 'psql-backend.ts'), 'utf-8'))

const GOOD: readonly string[] = Object.freeze([
  '--evidence-root', '/tmp/ev',
  '--host', '/tmp/sock',
  '--port', '5432',
  '--database', 'ai_capital',
  '--export-passfile', '/tmp/secrets/export.pgpass',
  '--supervisor-user', 'thanapold',
  '--supervisor-passfile', '/tmp/secrets/admin.pgpass',
  '--expected-target-label', 'ai-capital-v3',
  '--expected-system-identifier', '7689229024919775042',
  '--source-label', 'ai-capital-v2',
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

  it('exits 0-4 for success, failure, refusal, published-but-unverified and unknown', () => {
    expect([EXIT_OK, EXIT_FAILED, EXIT_REFUSED, EXIT_PUBLISHED_UNVERIFIED,
            EXIT_PUBLICATION_UNKNOWN]).toEqual([0, 1, 2, 3, 4])
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

  it('has EXACTLY ONE endpoint argument, so two claims cannot drift apart', () => {
    expect(OPTIONS.filter(o => /host|endpoint|socket|addr/i.test(o))).toEqual(['--host'])
    expect(OPTIONS).not.toContain('--source-endpoint')
    // And the manifest's requested endpoint IS that argument, verbatim.
    expect(CLI).toContain("requestedEndpoint: args['--host']")
  })

  it('takes an expected system IDENTIFIER, and a friendly name only as a label', () => {
    expect(OPTIONS).toContain('--expected-system-identifier')
    expect(OPTIONS).toContain('--source-label')
    expect(OPTIONS).toContain('--expected-target-label')
    expect(OPTIONS).not.toContain('--source-system')
    expect(OPTIONS).not.toContain('--expected-target')
    expect(CLI).toContain("expectedSystemIdentifier: args['--expected-system-identifier']")
    expect(CLI).toContain("sourceLabel: args['--source-label']")
  })

  it('reports a published-but-unverified bundle as such, and never as nothing', () => {
    expect(CLI).toContain('EvidencePublishedButUnverified')
    expect(CLI).toContain('Publication is INCOMPLETE or UNVERIFIED')
    expect(CLI).toContain('a bundle EXISTS under the final name')
    expect(CLI).toContain('Do not delete, reuse or repair it')
    expect(CLI).toContain('EXIT_PUBLISHED_UNVERIFIED')
    // The "nothing was published" line is reachable ONLY after that branch has
    // already returned, so it can never be printed about an existing bundle.
    expect(CLI.indexOf('EXIT_PUBLISHED_UNVERIFIED, lines'))
      .toBeLessThan(CLI.indexOf('No manifest was published under the final name'))
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

  it('carries only fixed reviewed reasons, never an interpolated one', () => {
    // A batch can carry a SCRAM verifier and psql echoes a failing statement;
    // every message this class can emit is a literal in a closed union.
    expect(TRANSPORT).toContain("'the psql session timed out on a statement'")
    expect(TRANSPORT).toContain("'the psql session refused a statement'")
    expect(TRANSPORT).not.toMatch(/new PsqlBackendRefused\(`/)
    expect(TRANSPORT).not.toMatch(/timed out on: \$\{/)
    expect(TRANSPORT).not.toMatch(/psql refused/)
  })
})

// ---------------------------------------------------------------------------
// E — a real psql that shouts secrets, and an error that repeats none of them
// ---------------------------------------------------------------------------

describe('the transport error boundary, against a psql that leaks everything', () => {
  const SQL_CANARY = 'SELECT pw FROM vault.secrets WHERE id = 1'
  const URL_CANARY = 'postgresql://ai_capital_v3_export:pw_LEAKCANARY@localhost/ai_capital'
  const PATH_CANARY = '/Users/someone/ai-capital-secrets/s4f-d4/export.pgpass'
  const roots: string[] = []

  afterEach(async () => {
    await closeAllPsqlBackends()
    for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true })
  })

  /**
   * A fake psql that NEVER answers and ignores stdin entirely.
   *
   * It must outlive a graceful close, or the test would prove nothing: the
   * point is that `abandon` escalates to SIGKILL and reaps.
   */
  function silentPsql(): string {
    const dir = mkdtempSync(join(tmpdir(), 'pgcopy-silentpsql-'))
    roots.push(dir)
    const bin = join(dir, 'psql')
    // The loop keeps the SHELL itself alive, so its command line - which is
    // what `ps` is searched for - stays this exact binary path.
    writeFileSync(bin, ['#!/bin/sh', 'trap "" TERM', 'while : ; do sleep 1; done'].join('\n'),
                  { mode: 0o700 })
    return bin
  }

  /** A fake psql that answers the pid query and shouts canaries at everything else. */
  function fakePsql(opts: { pid?: string } = {}): string {
    const dir = mkdtempSync(join(tmpdir(), 'pgcopy-fakepsql-'))
    roots.push(dir)
    const bin = join(dir, 'psql')
    writeFileSync(bin, [
      '#!/bin/sh',
      'while IFS= read -r line; do',
      '  case "$line" in',
      "    '\\echo '*) printf '%s\\n' \"${line#\\\\echo }\" ;;",
      "    '\\warn '*) printf '%s\\n' \"${line#\\\\warn }\" >&2 ;;",
      opts.pid === undefined
        ? '    *pg_backend_pid*) printf "not-a-pid\\n" ;;'
        : `    *pg_backend_pid*) printf "${opts.pid}\\n" ;;`,
      '    *)',
      `      printf 'ERROR:  syntax error at or near "%s"\\n' "$line" >&2`,
      `      printf 'LINE 1: %s\\n' "$line" >&2`,
      `      printf 'DETAIL: ${URL_CANARY} ${PATH_CANARY}\\n' >&2`,
      '      ;;',
      '  esac',
      'done',
    ].join('\n'), { mode: 0o700 })
    return bin
  }

  it('repeats no SQL, no stderr, no URL, no password and no absolute path', async () => {
    const s = await openPsqlBackend({
      psqlPath: fakePsql({ pid: '4242' }), host: '/tmp/sock', port: 5432,
      database: 'ai_capital', user: 'ai_capital_v3_export',
    })
    try {
      expect(s.pid).toBe('4242')

      // THE PUBLIC RESULT IS A TOKEN, NOT PROSE. The framing implementation
      // reads psql's stderr to decide that this statement failed; what leaves
      // the boundary is one fixed word, and there is nothing to read out of it.
      const raw = await s.send(SQL_CANARY)
      expect(raw.error).toBe('statement-refused')
      expect(raw.rows).toEqual([])
      const resultText = JSON.stringify(raw) + inspect(raw, { depth: 8, showHidden: true })
      for (const canary of [SQL_CANARY, URL_CANARY, PATH_CANARY, 'pw_LEAKCANARY',
                            'postgresql://', 'vault.secrets', '/Users/someone',
                            'syntax error', 'LINE 1', 'DETAIL', 'ERROR']) {
        expect(resultText, `send(): ${canary}`).not.toContain(canary)
      }

      // The REVIEWED boundary may not repeat any of it either.
      let thrown: unknown = null
      try { await s.must(SQL_CANARY) } catch (e) { thrown = e }
      expect(thrown).toBeInstanceOf(PsqlBackendRefused)
      expect((thrown as PsqlBackendRefused).reason).toBe('the psql session refused a statement')

      const seen = surfaces(thrown)
      for (const canary of [SQL_CANARY, URL_CANARY, PATH_CANARY, 'pw_LEAKCANARY',
                            'postgresql://', 'vault.secrets', '/Users/someone',
                            'syntax error', 'LINE 1', 'DETAIL']) {
        expect(seen, canary).not.toContain(canary)
      }
      expect((thrown as { cause?: unknown }).cause).toBeUndefined()
      expect(Object.getOwnPropertyNames(thrown as object).sort())
        .toEqual(['message', 'name', 'reason', 'stack'])
      expect(Object.getOwnPropertySymbols(thrown as object)).toEqual([])
    } finally {
      await s.close()
    }
  })

  it('reaps the child when opening fails before the session is registered', async () => {
    const before = openPsqlBackendCount()
    // The EXACT binary path, which is unique to this run: a prefix match would
    // also find this test file's own source in a wrapper's command line.
    const bin = fakePsql()
    let thrown: unknown = null
    try {
      await openPsqlBackend({
        psqlPath: bin, host: '/tmp/sock', port: 5432,
        database: 'ai_capital', user: 'ai_capital_v3_export',
      })
    } catch (e) { thrown = e }
    expect(thrown).toBeInstanceOf(PsqlBackendRefused)
    expect((thrown as PsqlBackendRefused).reason).toBe('the psql session did not report a backend pid')
    // Nothing was registered, and nothing was left running: until the session
    // reaches OPEN nothing else could ever close it, so a leaked child here
    // would be a backend - and possibly a held fence - with no handle to it.
    expect(openPsqlBackendCount()).toBe(before)
    const alive = execFileSync('/bin/ps', ['-Ao', 'command'],
                               { encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 })
    expect(alive).not.toContain(bin)
  })

  it('REAPS a child that stays alive while the opening statement times out', async () => {
    // The case the earlier revision leaked: `raw()` raises the timeout as a
    // PsqlBackendRefused, and the old catch rethrew that class directly -
    // skipping cleanup in exactly the situation where the child is still
    // running. A psql nobody holds a handle to is, for a supervisor, a backend
    // that may still be holding the fence.
    const before = openPsqlBackendCount()
    const bin = silentPsql()
    const started = Date.now()
    let thrown: unknown = null
    try {
      await openPsqlBackend({
        psqlPath: bin, host: '/tmp/sock', port: 5432,
        database: 'ai_capital', user: 'ai_capital_v3_export',
        __statementTimeoutMs: 400, __closeGraceMs: 400,
      })
    } catch (e) { thrown = e }

    expect(thrown).toBeInstanceOf(PsqlBackendRefused)
    expect((thrown as PsqlBackendRefused).reason)
      .toBe('the psql session timed out on a statement')
    // It really did time out rather than fail instantly for another reason.
    expect(Date.now() - started).toBeGreaterThanOrEqual(400)
    expect(openPsqlBackendCount()).toBe(before)

    // The child - which ignores stdin and would otherwise outlive us - is gone,
    // and so is every descendant it could have left.
    const alive = execFileSync('/bin/ps', ['-Ao', 'command'],
                               { encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 })
    expect(alive).not.toContain(bin)
    // No descendant either: nothing anywhere still names this run's directory.
    expect(alive).not.toContain(bin.slice(0, bin.lastIndexOf('/')))
    expect(surfaces(thrown)).not.toContain(bin)
  }, 60_000)

  it('refuses a statement on an exited session without naming it', async () => {
    const s = await openPsqlBackend({
      psqlPath: fakePsql({ pid: '77' }), host: '/tmp/sock', port: 5432,
      database: 'ai_capital', user: 'ai_capital_v3_export',
    })
    await s.close()
    let thrown: unknown = null
    try { await s.send(SQL_CANARY) } catch (e) { thrown = e }
    expect(thrown).toBeInstanceOf(PsqlBackendRefused)
    expect(surfaces(thrown)).not.toContain('vault.secrets')
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

// ---------------------------------------------------------------------------
// B — the CLI's disposition, exercised on real error instances
// ---------------------------------------------------------------------------

describe('the CLI tells the truth about what is on disk', () => {
  const published = (phase: 'freeze-final' | 'fsync-final' | 'fsync-parent' | 'verify') =>
    new EvidencePublishedButUnverified(
      phase, 'a filesystem operation did not complete',
      'source-manifest-20260924T101530Z-a1b2c3d4', '.tmp-a1b2c3d4')

  it('says the bundle EXISTS for every post-rename phase, and exits 3', () => {
    for (const phase of ['freeze-final', 'fsync-final', 'fsync-parent', 'verify'] as const) {
      const d = dispositionOf(published(phase))
      const text = d.lines.join('\n')
      expect(d.exitCode, phase).toBe(EXIT_PUBLISHED_UNVERIFIED)
      expect(text, phase).toContain('a bundle EXISTS under the final name')
      expect(text, phase).toContain('Publication is INCOMPLETE or UNVERIFIED')
      expect(text, phase).toContain('It has NOT been removed')
      expect(text, phase).toContain('Do not delete, reuse or repair it')
      expect(text, phase).toContain('source-manifest-20260924T101530Z-a1b2c3d4')
      expect(text, phase).toContain(phase)
      // THE LINE THAT MUST NEVER APPEAR HERE.
      expect(text, phase).not.toContain('No manifest was published')
    }
  })

  it('says the outcome is UNKNOWN, refuses to claim absence, and exits 4', () => {
    const d = dispositionOf(new EvidencePublicationUnknown(
      'source-manifest-20260924T101530Z-a1b2c3d4', '.tmp-a1b2c3d4'))
    const text = d.lines.join('\n')
    expect(d.exitCode).toBe(EXIT_PUBLICATION_UNKNOWN)
    expect(text).toContain('Publication state is UNKNOWN')
    expect(text).toContain('the final name may or may not exist')
    expect(text).toContain('a retry is NOT safe')
    expect(text).toContain('nothing has been removed or repaired')
    expect(text).toContain('source-manifest-20260924T101530Z-a1b2c3d4')
    // THE LINE THAT MUST NEVER APPEAR HERE.
    expect(text).not.toContain('No manifest was published')
  })

  it('the absence claim is unreachable for every outcome in which a bundle exists', () => {
    // Asserted on the source too, so the ordering that makes it unreachable
    // cannot be quietly rearranged. All THREE such branches return first.
    const absence = CLI.indexOf('No manifest was published under the final name')
    expect(absence).toBeGreaterThan(-1)
    for (const marker of ['EXIT_PUBLICATION_UNKNOWN, lines',
                          'EvidencePublishedButUnverified',
                          'Stage1PublishedButIncomplete']) {
      expect(CLI.indexOf(marker), marker).toBeGreaterThan(-1)
      expect(CLI.indexOf(marker), marker).toBeLessThan(absence)
    }
  })

  it('a published-but-INCOMPLETE Stage 1 keeps its own meaning, and exits 3', () => {
    const phases: Array<[Stage1PublishedPhase, string]> = [
      ['fence-proof-after-publication',
       'the fence could not be proved still held after publication'],
      ['export-rollback', 'the export transaction could not be rolled back'],
      ['fence-proof-after-rollback',
       'the fence could not be proved still held after the source rollback'],
    ]
    for (const [phase, reason] of phases) {
      const d = dispositionOf(new Stage1PublishedButIncomplete(
        phase, reason as never, 'source-manifest-20260924T101530Z-a1b2c3d4', '.tmp-a1b2c3d4'))
      const text = d.lines.join('\n')
      expect(d.exitCode, phase).toBe(EXIT_PUBLISHED_INCOMPLETE)
      expect(text, phase).toContain('PASSED evidence verification')
      expect(text, phase).toContain('Stage 1 did NOT complete')
      expect(text, phase).toContain('Nothing was removed or repaired')
      expect(text, phase).toContain('Do not retry, reuse, delete or repair it')
      expect(text, phase).toContain('source-manifest-20260924T101530Z-a1b2c3d4')
      expect(text, phase).toContain(phase)
      expect(text, phase).toContain(reason)
      expect(text, phase).not.toContain('No manifest was published')
      // It is NOT the evidence-verification failure, and must not read as one.
      expect(text, phase).not.toContain('INCOMPLETE or UNVERIFIED')
    }
  })

  it('the two published dispositions share a status but not a meaning', () => {
    const unverified = dispositionOf(new EvidencePublishedButUnverified(
      'verify', 'the published digest does not describe the published bytes',
      'source-manifest-20260924T101530Z-a1b2c3d4', '.tmp-a1b2c3d4'))
    const incomplete = dispositionOf(new Stage1PublishedButIncomplete(
      'export-rollback', 'the export transaction could not be rolled back',
      'source-manifest-20260924T101530Z-a1b2c3d4', '.tmp-a1b2c3d4'))
    expect(unverified.exitCode).toBe(EXIT_PUBLISHED_INCOMPLETE)
    expect(incomplete.exitCode).toBe(EXIT_PUBLISHED_INCOMPLETE)
    expect(EXIT_PUBLISHED_UNVERIFIED).toBe(EXIT_PUBLISHED_INCOMPLETE)
    // The EVIDENCE case says verification is in doubt; the STAGE case says it
    // passed. Neither sentence may appear in the other.
    expect(unverified.lines.join('\n')).not.toContain('PASSED evidence verification')
    expect(incomplete.lines.join('\n')).not.toContain('could not be completed or verified')
  })

  it('says NOTHING was published for a pre-rename refusal, and exits 2', () => {
    for (const e of [
      new EvidenceRefused('collision', 'a path is already present at the publication destination'),
      new EvidenceRefused('publish', 'this platform offers no atomic no-replace publication'),
      new EvidenceRefused('collision', 'a path could not be examined'),
      new ManifestRefused('export-identity', 'the export session is not on the expected source cluster'),
      new CliRefused('option "--host" is required.'),
    ]) {
      const d = dispositionOf(e)
      expect(d.exitCode, e.message).toBe(EXIT_REFUSED)
      expect(d.lines.join('\n'), e.message).toContain('No manifest was published under the final name')
      expect(d.lines.join('\n'), e.message).toContain((e as Error).message)
    }
  })

  it('reports an UNEXPECTED error by its class alone, and exits 1', () => {
    const d = dispositionOf(new Error(
      'ERROR: relation vault.secrets; postgresql://u:pw_CLICANARY@h/db; /Users/x/secret'))
    expect(d.exitCode).toBe(EXIT_FAILED)
    const text = d.lines.join('\n')
    expect(text).toContain('stage 1 failed (Error).')
    for (const canary of ['pw_CLICANARY', 'postgresql://', 'vault.secrets', '/Users/x/secret']) {
      expect(text, canary).not.toContain(canary)
    }
  })

  it('never leaks a thrown non-Error value either', () => {
    const d = dispositionOf({ password: 'pw_CLICANARY', url: 'postgresql://u:p@h/db' })
    expect(d.exitCode).toBe(EXIT_FAILED)
    expect(d.lines.join('\n')).not.toContain('pw_CLICANARY')
    expect(d.lines.join('\n')).not.toContain('postgresql://')
  })
})
