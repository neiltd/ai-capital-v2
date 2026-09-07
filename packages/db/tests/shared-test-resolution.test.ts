// Round-3 correction D: the shared test resolver must return a real filesystem
// path, including for a checkout whose directory contains a space or a
// percent-encodable character.
//
// THE BUG THIS CLOSES. The helper previously returned `new URL(url).pathname`.
// A URL pathname is percent-ENCODED, so a repository under `/Users/me/my repo/`
// resolved to `/Users/me/my%20repo/...` — a path that does not exist. Nobody
// had hit it because every path involved happened to be ASCII and space-free.
//
// This helper is test-only: it is imported by vitest configs and by nothing in
// any production bundle. The last test in this file asserts that.

import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve as resolvePath } from 'node:path'
import { pathToFileURL } from 'node:url'
import { execFileSync } from 'node:child_process'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { resolveDependencyFrom, sharedDbTestAliases } from '../testing/vitest-db-resolution.js'

let root: string

/** A throwaway package tree under a directory whose name needs encoding. */
function fixture(dirName: string, options: { useExportMap: boolean }): string {
  const anchorDir = join(root, dirName)
  const pkgDir = join(anchorDir, 'node_modules', 'space-fixture')
  mkdirSync(pkgDir, { recursive: true })
  writeFileSync(join(anchorDir, 'package.json'), JSON.stringify({ name: 'anchor', version: '1.0.0' }))
  // The export map deliberately points somewhere other than index.js, so a
  // resolver that guesses a filename instead of reading the map is caught.
  writeFileSync(join(pkgDir, 'package.json'), JSON.stringify(
    options.useExportMap
      ? { name: 'space-fixture', version: '1.0.0', main: './index.js', exports: { '.': { require: './lib/entry.js', default: './lib/entry.js' } } }
      : { name: 'space-fixture', version: '1.0.0', main: './index.js' }))
  mkdirSync(join(pkgDir, 'lib'), { recursive: true })
  writeFileSync(join(pkgDir, 'index.js'), 'module.exports = { from: "index" }\n')
  writeFileSync(join(pkgDir, 'lib', 'entry.js'), 'module.exports = { from: "export-map" }\n')
  return join(anchorDir, 'package.json')
}

beforeAll(() => { root = mkdtempSync(join(tmpdir(), 'db-resolution-')) })
afterAll(() => rmSync(root, { recursive: true, force: true }))

describe('resolveDependencyFrom returns a usable path, not a URL pathname', () => {
  it('handles an anchor directory containing a space', () => {
    const anchor = fixture('pkg with spaces', { useExportMap: false })
    const resolved = resolveDependencyFrom(pathToFileURL(anchor), 'space-fixture')

    expect(resolved, 'the space must survive as a space').toContain('pkg with spaces')
    expect(resolved, 'the path must not be percent-encoded').not.toContain('%20')
    expect(existsSync(resolved), `resolved path must exist on disk: ${resolved}`).toBe(true)
    expect(readFileSync(resolved, 'utf8')).toContain('module.exports')
  })

  it('handles other characters a URL would percent-encode', () => {
    const anchor = fixture('pkg#with[odd]chars and space', { useExportMap: false })
    const resolved = resolveDependencyFrom(pathToFileURL(anchor), 'space-fixture')
    expect(resolved).toContain('pkg#with[odd]chars and space')
    expect(resolved).not.toMatch(/%[0-9A-Fa-f]{2}/)
    expect(existsSync(resolved)).toBe(true)
  })

  it('goes through the package export map rather than guessing a filename', () => {
    const anchor = fixture('mapped pkg', { useExportMap: true })
    const resolved = resolveDependencyFrom(pathToFileURL(anchor), 'space-fixture')
    expect(resolved.endsWith(join('lib', 'entry.js')), `expected the export-map entry, got ${resolved}`).toBe(true)
    expect(resolved.endsWith('index.js')).toBe(false)
  })

  it('NON-VACUITY: the previous `new URL(url).pathname` form corrupts the same path', () => {
    const anchor = fixture('control pkg with spaces', { useExportMap: false })
    const correct = resolveDependencyFrom(pathToFileURL(anchor), 'space-fixture')
    // Exactly what the old code did with the same file URL.
    const old = new URL(pathToFileURL(correct).href).pathname
    expect(old, 'the old form percent-encodes the space').toContain('%20')
    expect(existsSync(old), 'and the path it produces does not exist').toBe(false)
    expect(existsSync(correct)).toBe(true)
  })

  it('fails clearly when the dependency genuinely cannot be resolved', () => {
    const anchor = fixture('missing dep', { useExportMap: false })
    let code: string | undefined
    try { resolveDependencyFrom(pathToFileURL(anchor), 'definitely-not-installed-xyz') }
    catch (error) { code = (error as NodeJS.ErrnoException).code }
    expect(code).toBe('MODULE_NOT_FOUND')
  })
})

describe('the alias the ledger package actually consumes', () => {
  it('resolves pg-connection-string to a real file through @common/db', () => {
    const alias = sharedDbTestAliases()
    const resolved = alias['pg-connection-string']
    expect(resolved).toBeTruthy()
    expect(resolved).not.toMatch(/%[0-9A-Fa-f]{2}/)
    expect(existsSync(resolved), `alias target must exist: ${resolved}`).toBe(true)
    expect(resolved).toContain('pg-connection-string')
  })

  it('is test-only: no production module imports the resolver', () => {
    const repo = resolvePath(__dirname, '..', '..', '..')
    const hits = execFileSync('git', ['grep', '-l', '--untracked', 'vitest-db-resolution', '--', 'packages', 'apps'],
      { cwd: repo, encoding: 'utf8' }).trim().split('\n').filter(Boolean)
    // The helper itself, and vitest configs. Nothing under src/, bin/ or app code.
    for (const file of hits) {
      expect(
        file.endsWith('testing/vitest-db-resolution.ts') || /vitest[^/]*\.config\.ts$/.test(file) || file.includes('/tests/'),
        `unexpected importer of the test-only resolver: ${file}`,
      ).toBe(true)
    }
    expect(hits.length).toBeGreaterThan(1)
  })
})
