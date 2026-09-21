import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, symlinkSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { isDirectEntrypoint } from '../src/cli/update.js'

// WHAT THIS GUARDS.
//
// `src/cli/update.ts` ended in a bare `main().catch(...)` at module scope, so
// importing it — which `update-frequency.test.ts` and `update-skip.test.ts` do,
// for `hasNewDocs` — executed the whole CLI workflow. With ANTHROPIC_API_KEY
// unset it printed the diagnostic and called process.exit(1); Vitest recorded
// that as an unhandled rejection and failed the package while all 39 tests
// passed. These tests hold both halves of the contract at once: importing the
// module must do nothing, and running it as a program must still behave.
//
// SAFETY: every child runs from a fresh temp cwd with no .env, with
// ANTHROPIC_API_KEY removed or empty, so `main()` exits at its first check and
// no database, LanceDB index, network or API call is ever reached.

const CLI = resolve(__dirname, '..', 'src', 'cli', 'update.ts')
const TSX = resolve(__dirname, '..', '..', '..', 'node_modules', '.bin', 'tsx')
const SENTINEL = 'IMPORT-COMPLETED-WITHOUT-RUNNING-CLI'
const CHILD_TIMEOUT_MS = 60_000

const PKG = resolve(__dirname, '..')

let dir: string
// The import probe must live INSIDE the package tree. tsx resolves the
// workspace's `@common/db` subpath exports relative to the entry script, and a
// script under os.tmpdir() falls into a CJS resolution path that reports
// ERR_PACKAGE_PATH_NOT_EXPORTED. Same lesson as the WAL fixture: a child script
// outside the workspace cannot resolve workspace packages.
let pkgDir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'thesis-entrypoint-'))
  pkgDir = mkdtempSync(join(PKG, '.thesis-entrypoint-probe-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  rmSync(pkgDir, { recursive: true, force: true })
})

/** A child environment with no credentials and no inherited API key. */
function childEnv(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...overrides }
  for (const k of ['ANTHROPIC_API_KEY', 'DATABASE_URL', 'REDIS_URL', 'PGHOST', 'PGUSER', 'PGPASSWORD']) {
    if (!(k in overrides)) delete env[k]
  }
  return env
}

function report(label: string, r: ReturnType<typeof spawnSync>): string {
  return `${label}: status=${String(r.status)} signal=${String(r.signal)}\n--- stdout ---\n${r.stdout ?? ''}\n--- stderr ---\n${r.stderr ?? ''}`
}

describe('update.ts is inert on import and still runnable as a program', () => {
  it('importing the module runs no CLI work and exits cleanly', () => {
    // A child whose only job is to import the CLI and then prove it got past it.
    const probe = join(pkgDir, 'import-probe.ts')
    writeFileSync(probe, `
import ${JSON.stringify(pathToFileURL(CLI).href)}
console.log(${JSON.stringify(SENTINEL)})
`, 'utf-8')

    const r = spawnSync(TSX, [probe], {
      cwd: dir,                       // no .env here
      env: childEnv(),                // ANTHROPIC_API_KEY absent
      encoding: 'utf-8',
      timeout: CHILD_TIMEOUT_MS,
    })

    expect(r.status, report('import probe should exit 0', r)).toBe(0)
    expect(r.stdout, report('sentinel after import', r)).toContain(SENTINEL)
    expect(`${r.stdout}${r.stderr}`, report('CLI must not have run', r))
      .not.toContain('ANTHROPIC_API_KEY not set')
    // The workflow's own completion line must never appear on a bare import.
    expect(`${r.stdout}${r.stderr}`, report('workflow must not have run', r))
      .not.toContain('proposal(s) pending review')
  })

  it('executing the module directly still refuses without ANTHROPIC_API_KEY', () => {
    const r = spawnSync(TSX, [CLI], {
      cwd: dir,                       // no .env here either
      env: childEnv({ ANTHROPIC_API_KEY: '' }),
      encoding: 'utf-8',
      timeout: CHILD_TIMEOUT_MS,
    })

    expect(r.status, report('direct run should exit 1', r)).toBe(1)
    expect(`${r.stdout}${r.stderr}`, report('direct run diagnostic', r))
      .toContain('ANTHROPIC_API_KEY not set')
  })
})

describe('isDirectEntrypoint compares real paths, fail-closed', () => {
  const moduleUrl = pathToFileURL(CLI).href

  it('is true for the exact real path', () => {
    expect(isDirectEntrypoint(CLI, moduleUrl)).toBe(true)
  })

  it('is true for a symlink spelling of the same file', () => {
    const link = join(dir, 'update-link.ts')
    symlinkSync(CLI, link)
    expect(existsSync(link)).toBe(true)
    expect(isDirectEntrypoint(link, moduleUrl)).toBe(true)
  })

  it('is false for an unrelated path', () => {
    const other = resolve(__dirname, '..', 'src', 'cli', 'review.ts')
    expect(isDirectEntrypoint(other, moduleUrl)).toBe(false)
  })

  it('is false when argv1 is undefined', () => {
    expect(isDirectEntrypoint(undefined, moduleUrl)).toBe(false)
  })

  it('is false for a path that does not exist', () => {
    expect(isDirectEntrypoint(join(dir, 'no-such-file.ts'), moduleUrl)).toBe(false)
  })

  it('is false for a malformed module URL rather than throwing', () => {
    expect(isDirectEntrypoint(CLI, 'not-a-url')).toBe(false)
  })
})
