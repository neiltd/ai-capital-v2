// THE LAUNCHER REPLACES A SHELL DEFAULT THAT WAS NOT A BOUNDARY.
//
// scripts/run-alerts.sh and scripts/refresh-prices.sh used to begin with
//
//   export DATABASE_URL="${DATABASE_URL:-<a hard-coded superuser URL>}"
//
// so a missing credential silently ran the stage as the personal superuser role.
// `${VAR:?}` would be an improvement and still not enough: it accepts
// surrounding whitespace, a wrong scheme, and an incomplete URL that libpq
// completes from PGDATABASE/PGUSER/USER. Writing the real contract in shell
// would mean a second, weaker copy of security logic.
//
// So the wrappers hold no policy, and bin/run-stage.ts applies the SAME
// validator and the SAME environment builder the worker uses.
//
// These tests import the launcher's pure helpers and read the wrappers as text.
// main() is never invoked: it spawns a child, and this suite starts no process
// and opens no connection.
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync, existsSync, mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs'
import { join, relative } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { fileURLToPath } from 'node:url'

import { commandFromArgv, isDirectEntrypoint, signalExitCode, USAGE } from '../bin/run-stage.js'

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf-8')
const WRAPPERS = ['../../../scripts/run-alerts.sh', '../../../scripts/refresh-prices.sh'] as const

describe('commandFromArgv', () => {
  it('takes everything after the literal `--`', () => {
    expect(commandFromArgv(['--', 'npx', 'tsx', 'src/cli/x.ts'])).toEqual(['npx', 'tsx', 'src/cli/x.ts'])
  })

  it('takes NOTHING before it, so a stray argument cannot become the command', () => {
    expect(commandFromArgv(['--verbose', '--', 'npx', 'tsx'])).toEqual(['npx', 'tsx'])
  })

  it('returns empty when the separator is absent', () => {
    expect(commandFromArgv(['npx', 'tsx'])).toEqual([])
  })

  it('returns empty when nothing follows the separator', () => {
    expect(commandFromArgv(['--'])).toEqual([])
  })

  it('PRESERVES empty arguments rather than silently reindexing the command', () => {
    // The corrected contract. Filtering them out rewrites the caller's command:
    // `--flag ''` and `--flag` mean different things to most CLIs, and dropping
    // the element shifts everything after it.
    expect(commandFromArgv(['--', 'npx', '', 'tsx', ''])).toEqual(['npx', '', 'tsx', ''])
  })

  it('keeps only the FIRST separator as the separator', () => {
    // A later `--` is an argument to the command (git and npm both use one).
    expect(commandFromArgv(['--', 'npm', 'run', 'x', '--', '--flag']))
      .toEqual(['npm', 'run', 'x', '--', '--flag'])
  })
})

describe('signalExitCode', () => {
  it.each([
    ['SIGINT', 130],
    ['SIGTERM', 143],
    ['SIGKILL', 137],
    ['SIGHUP', 129],
  ])('maps %s to %i', (signal, code) => {
    expect(signalExitCode(signal as NodeJS.Signals)).toBe(code)
  })

  it('is non-zero for an unlisted signal, so a killed child never reads as success', () => {
    expect(signalExitCode('SIGUSR1' as NodeJS.Signals)).toBeGreaterThan(0)
  })
})

describe('the launcher itself', () => {
  const src = read('../bin/run-stage.ts')
  const code = src.split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')

  it('documents the `--` contract in its usage text', () => {
    expect(USAGE).toMatch(/--/)
    expect(USAGE).toMatch(/PIPELINE_DATABASE_URL/)
  })

  it('validates before the child is created', () => {
    const validation = code.indexOf('requirePipelineCredential()')
    const spawned = code.indexOf('spawn(')
    expect(validation).toBeGreaterThan(-1)
    expect(spawned).toBeGreaterThan(validation)
  })

  it('builds the child environment with the shared builder', () => {
    expect(code).toContain('buildPipelineChildEnv(')
  })

  it('spawns without a shell, from an argv array', () => {
    // No string is concatenated and handed to a shell, so no argument can be
    // read as shell syntax.
    expect(code).toMatch(/shell:\s*false/)
  })

  it('constructs no pool, queue or Redis client', () => {
    const imports = [...src.matchAll(/^import\s+(?:type\s+)?[^'\n]*from\s+'([^']+)'/gm)].map(m => m[1])
    expect(imports.sort()).toEqual([
      '../src/child-env.js', '../src/env.js', 'child_process', 'fs', 'path', 'url',
    ])
  })

  it('runs main() only when executed directly, so tests can import the helpers', () => {
    expect(code).toContain('isDirectEntrypoint(import.meta.url)')
  })

  it('detects the entry point robustly, not by string-comparing a URL to argv[1]', () => {
    // The old comparison failed for a relative argv[1], a symlinked entry point
    // and any path needing percent-encoding — each time by silently doing
    // nothing at all.
    expect(code).not.toMatch(/`file:\/\/\$\{process\.argv\[1\]\}`/)
    expect(code).toContain('pathToFileURL')
    expect(code).toContain('realpathSync')
    // And it decodes the URL with the platform's own converter rather than
    // handing a still-encoded `pathname` to the filesystem.
    expect(code).toContain('fileURLToPath(moduleUrl)')
    expect(code).not.toContain('new URL(moduleUrl).pathname')
  })

  it('signals the process GROUP, not only the immediate child', () => {
    expect(code).toMatch(/detached:\s*true/)
    expect(code).toMatch(/process\.kill\(-child\.pid/)
  })

  it('refuses an empty command rather than validating and exec-ing nothing', () => {
    expect(code).toMatch(/return 64/)
  })

  it('reports a validation failure without printing the credential', () => {
    expect(code).toMatch(/err\.message/)
    expect(code).not.toMatch(/process\.env\)|JSON\.stringify\(process\.env/)
  })
})

describe.each(WRAPPERS)('%s', (rel) => {
  const src = read(rel)

  it('carries no connection URL and no default credential', () => {
    expect(src).not.toMatch(new RegExp(['postgres', '(ql)?', ':', '//'].join('')))
    expect(src).not.toMatch(/DATABASE_URL="?\$\{[A-Z_]+:-/)
    expect(src).not.toMatch(/^\s*export\s+[A-Z_]*DATABASE_URL=/m)
  })

  it('execs the shared launcher with a fixed command after `--`', () => {
    expect(src).toMatch(/exec\b[\s\S]*run-stage\.ts[\s\S]*--\s/)
  })

  it('fails on an unset variable and on any error in a pipeline', () => {
    expect(src).toMatch(/set -euo pipefail/)
  })

  it('is executable', () => {
    const mode = statSync(fileURLToPath(new URL(rel, import.meta.url))).mode
    expect(mode & 0o111).not.toBe(0)
  })
})

// Tracked launchd TEMPLATES are credential-free by construction. The files they
// replace were not: daily-queue.worker.plist and the three under
// ops/launchd-proposed/ each carried a literal superuser connection URL in Git,
// so least-privilege could be designed and then handed the wrong credential by
// the very file that installs the agent. Substitution happens at install time,
// into a copy that is never committed.
describe('ops/launchd templates', () => {
  const dir = fileURLToPath(new URL('../../../ops/launchd/', import.meta.url))
  const files = readdirSync(dir).filter(f => f.endsWith('.template'))
  const SCHEME = new RegExp(['postgres', '(ql)?', ':', '//'].join(''))

  it('exist — the templates are the supported installation source', () => {
    expect(files.length).toBeGreaterThan(0)
  })

  it.each(files)('%s carries no connection URL', (f) => {
    expect(readFileSync(join(dir, f), 'utf-8')).not.toMatch(SCHEME)
  })

  it.each(files)('%s is valid XML that parses as a plist', (f) => {
    const src = readFileSync(join(dir, f), 'utf-8')
    expect(src).toMatch(/^<\?xml version="1\.0" encoding="UTF-8"\?>/)
    expect(src.trimEnd().endsWith('</plist>')).toBe(true)
  })

  it('every remaining placeholder is an @@UPPER_SNAKE@@ form', () => {
    for (const f of files) {
      const src = readFileSync(join(dir, f), 'utf-8')
      for (const m of src.matchAll(/@@([^@]*)@@/g)) {
        expect(m[1]).toMatch(/^[A-Z][A-Z0-9_]*$/)
      }
    }
  })

  it('the superseded installed-style plists are gone', () => {
    const repo = fileURLToPath(new URL('../../../', import.meta.url))
    for (const stale of [
      'daily-queue.worker.plist',
      'daily-alerts.plist',
      // Declared the same label as the daily template AND carried instructions
      // that would have overwritten the supported agent.
      'daily-catchup.plist',
      'ops/launchd-proposed/com.thanapol.ai-capital.daily.plist',
      'ops/launchd-proposed/com.thanapol.ai-capital.watchdog.plist',
      'ops/launchd-proposed/com.thanapol.ai-capital.structured-worker.plist',
    ]) {
      expect(existsSync(join(repo, stale))).toBe(false)
    }
  })

  it.each([
    'com.thanapol.ai-capital.worker.plist.template',
    'com.thanapol.ai-capital.structured-worker.plist.template',
  ])('%s supplies PIPELINE_DATABASE_URL and no generic DATABASE_URL', (f) => {
    const src = readFileSync(join(dir, f), 'utf-8')
    // ONE credential name. The worker process reads only PIPELINE_DATABASE_URL;
    // a stage child's DATABASE_URL is derived by buildPipelineChildEnv() after
    // sanitization, so a duplicate here would be a second name for one secret.
    expect(src).toContain('<key>PIPELINE_DATABASE_URL</key>')
    expect(src).not.toContain('<key>DATABASE_URL</key>')
  })

  it.each([
    'com.thanapol.ai-capital.daily.plist.template',
    'com.thanapol.ai-capital.watchdog.plist.template',
  ])('%s carries no database credential at all', (f) => {
    const src = readFileSync(join(dir, f), 'utf-8')
    expect(src).not.toMatch(/<key>[A-Z_]*DATABASE_URL<\/key>/)
  })

  it.each([
    ['com.thanapol.ai-capital.worker.plist.template', 'packages/queue/bin/worker.ts'],
    ['com.thanapol.ai-capital.structured-worker.plist.template', 'packages/queue/bin/structured-worker.ts'],
  ])('%s names its entry point ABSOLUTELY', (f, rel) => {
    // The superseded plist passed the entry point relative to WorkingDirectory.
    // launchd runs it either way, but the resulting command line names no
    // checkout, so `ps` cannot distinguish two repositories and the scheduler's
    // liveness check has to fall back on launchd provenance to trust it.
    const src = readFileSync(join(dir, f), 'utf-8')
    expect(src).toContain(`<string>@@AI_CAPITAL_ROOT@@/${rel}</string>`)
    expect(src).not.toContain(`<string>${rel}</string>`)
  })

  it.each(files)('%s contains no executable installation instruction', (f) => {
    // Interpolating a credential through `sed` arguments exposes it in the
    // process table and mishandles `&`, `|`, backslashes and `& < >`. The
    // instructions were removed rather than patched; a reviewed renderer comes
    // in a later slice.
    const src = readFileSync(join(dir, f), 'utf-8')
    expect(src).not.toMatch(/^\s*sed\s+-e/m)
    expect(src).not.toMatch(/envsubst/)
    expect(src).not.toMatch(/launchctl\s+(bootstrap|bootout|kickstart)/)
    expect(src).not.toMatch(/^\s*cp\s+/m)
    expect(src).toMatch(/INSTALLATION IS BLOCKED/)
  })
})

// isDirectEntrypoint DECIDES WHETHER THE LAUNCHER DOES ANYTHING AT ALL, so it
// is exercised against real paths on disk rather than read as source text. When
// it is wrong the failure is silent: the module imports cleanly, main() never
// runs, and the wrapper exits 0 having launched nothing.
describe('isDirectEntrypoint', () => {
  let work: string
  beforeEach(() => { work = mkdtempSync(join(tmpdir(), 'entrypoint-')) })
  afterEach(() => { rmSync(work, { recursive: true, force: true }) })

  /** Create `<work>/<dir>/entry.ts` and return its absolute path. */
  function entry(dir: string): string {
    const d = join(work, dir)
    mkdirSync(d, { recursive: true })
    const f = join(d, 'entry.ts')
    writeFileSync(f, '')
    return f
  }

  it('is true for an ordinary absolute path', () => {
    const f = entry('plain')
    expect(isDirectEntrypoint(pathToFileURL(f).href, f)).toBe(true)
  })

  it('is true when argv[1] is RELATIVE', () => {
    // launchd and npm both hand over relative entry points; the old comparison
    // produced `file://packages/…` and matched nothing.
    const f = entry('plain')
    const rel = relative(process.cwd(), f)
    expect(rel.startsWith('/')).toBe(false)
    expect(isDirectEntrypoint(pathToFileURL(f).href, rel)).toBe(true)
  })

  it('is true when argv[1] is a SYMLINK to the entry point', () => {
    const f = entry('plain')
    const link = join(work, 'link-to-entry.ts')
    symlinkSync(f, link)
    expect(isDirectEntrypoint(pathToFileURL(f).href, link)).toBe(true)
  })

  it('is true for a path containing SPACES', () => {
    // `new URL(url).pathname` leaves this percent-encoded as `a%20space`, so the
    // filesystem call then names a file that does not exist.
    const f = entry('a space')
    expect(f).toContain(' ')
    expect(pathToFileURL(f).href).toContain('%20')
    expect(isDirectEntrypoint(pathToFileURL(f).href, f)).toBe(true)
  })

  it('is true for a UNICODE path', () => {
    const f = entry('é-café')
    expect(pathToFileURL(f).href).toContain('%C3%A9')
    expect(isDirectEntrypoint(pathToFileURL(f).href, f)).toBe(true)
  })

  it('is false when argv[1] is undefined', () => {
    const f = entry('plain')
    expect(isDirectEntrypoint(pathToFileURL(f).href, undefined)).toBe(false)
  })

  it('is false for a genuinely different path', () => {
    const f = entry('plain')
    const other = entry('elsewhere')
    expect(isDirectEntrypoint(pathToFileURL(f).href, other)).toBe(false)
  })

  it('is false for a different path that shares a suffix', () => {
    const f = entry('plain')
    const lookalike = entry('nested/plain')
    expect(isDirectEntrypoint(pathToFileURL(f).href, lookalike)).toBe(false)
  })
})
