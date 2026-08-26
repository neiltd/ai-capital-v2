import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// Meta-test: every package that can run tests must load the DB isolation setup.
//
// WHY. The 2026-08-25 contamination happened in packages whose tests were each
// individually fine; what was missing was a workspace-level guarantee. Nothing
// caught a new app added tomorrow, or a typo'd `setupFiles` path.
//
// WHY IT IS WRITTEN THIS WAY. The first version read each config as TEXT and
// grepped it. Warden proved that passed vacuously against three realistic
// decoys — `setupFiles` commented out, mentioned only in a dead comment, or
// overridden to [] by a later key — all of which have NO isolation at all.
// Commenting out setupFiles while debugging is the single most likely way this
// guarantee evaporates, and the test written to catch it went green.
//
// So this now IMPORTS each config and asserts on the resolved value. It also
// deliberately does not grep run output for the "[test-isolation]" marker:
// vitest 4 intercepts setup-file console in creator-studio, making that marker
// invisible there — a false-negative trap for anyone auditing by grep.

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..', '..', '..')
const SETUP_BASENAME = 'vitest-db-isolation'

/** Workspace roots, read from pnpm-workspace.yaml rather than hardcoded. */
function workspaceGroups(): string[] {
  const f = join(REPO, 'pnpm-workspace.yaml')
  if (!existsSync(f)) return ['apps', 'packages']
  const groups = [...readFileSync(f, 'utf-8').matchAll(/^\s*-\s*['"]?([^'"\n*]+)\/\*/gm)]
    .map(m => m[1].trim())
    .filter(g => g && !g.startsWith('!'))
  return groups.length ? [...new Set(groups)] : ['apps', 'packages']
}

interface Pkg { rel: string; scripts: Record<string, string> }

function packagesWithTests(): Pkg[] {
  const out: Pkg[] = []
  for (const group of workspaceGroups()) {
    const dir = join(REPO, group)
    if (!existsSync(dir)) continue
    for (const name of readdirSync(dir)) {
      const pkgJson = join(dir, name, 'package.json')
      if (!existsSync(pkgJson)) continue
      let scripts: Record<string, string> = {}
      try { scripts = JSON.parse(readFileSync(pkgJson, 'utf-8')).scripts ?? {} } catch { continue }
      // `test` and `test:watch` are both real entry points to the database.
      if (scripts.test || scripts['test:watch']) out.push({ rel: join(group, name), scripts })
    }
  }
  return out.sort((a, b) => a.rel.localeCompare(b.rel))
}

const PACKAGES = packagesWithTests()
const NAMES = PACKAGES.map(p => p.rel)

/** Import a vitest config and resolve it to a plain object. */
async function loadConfig(rel: string): Promise<any> {
  const mod = await import(pathToFileURL(join(REPO, rel, 'vitest.config.ts')).href)
  const d = mod.default
  return typeof d === 'function' ? await d({ command: 'serve', mode: 'test' }) : d
}

describe('DB isolation coverage across the workspace', () => {
  it('finds the packages that can run tests', () => {
    // Guards against the glob matching nothing and everything below passing
    // vacuously — the silent-hole shape this repo keeps hitting.
    expect(NAMES.length).toBeGreaterThanOrEqual(10)
  })

  it.each(NAMES)('%s has a vitest config', rel => {
    expect(existsSync(join(REPO, rel, 'vitest.config.ts'))).toBe(true)
  })

  it.each(NAMES)('%s RESOLVES setupFiles to the shared isolation setup', async rel => {
    // The load-bearing assertion. Evaluates the config; a commented-out or
    // later-overridden setupFiles cannot pass this.
    const cfg = await loadConfig(rel)
    const setups: string[] = [cfg?.test?.setupFiles ?? []].flat().map(String)
    expect(setups.some(f => f.includes(SETUP_BASENAME)), `${rel}: resolved setupFiles = ${JSON.stringify(setups)}`).toBe(true)
  })

  it.each(NAMES)('%s points at a setup file that exists on disk', async rel => {
    const cfg = await loadConfig(rel)
    const setups: string[] = [cfg?.test?.setupFiles ?? []].flat().map(String)
    const setup = setups.find(f => f.includes(SETUP_BASENAME))!
    const path = setup.startsWith('file:') ? fileURLToPath(setup) : setup
    expect(existsSync(path), `${rel}: setup file missing at ${path}`).toBe(true)
  })

  it.each(NAMES)('%s resolves the setup path portably, not absolutely', rel => {
    // A hardcoded path breaks on any clone at a different location — and this
    // repo has a pending relocation out of ~/Desktop.
    const src = readFileSync(join(REPO, rel, 'vitest.config.ts'), 'utf-8')
    expect(src).toContain('import.meta.url')
    expect(src).not.toMatch(/setupFiles:\s*\[\s*['"]\//)
  })

  it.each(NAMES)('%s test script does not redirect to another config', rel => {
    // `vitest run --config alt.config.ts` would satisfy every assertion above
    // while running a config that has no setup file.
    const pkg = PACKAGES.find(p => p.rel === rel)!
    for (const [name, body] of Object.entries(pkg.scripts)) {
      if (name === 'test' || name === 'test:watch') {
        expect(body, `${rel}: ${name} redirects config`).not.toMatch(/--config|-c\s/)
        expect(body, `${rel}: ${name} disables setup`).not.toContain('--no-')
      }
    }
  })
})

describe('nothing outside packages/db can open a Postgres connection', () => {
  it('no direct driver import bypasses getPool()', () => {
    // Every route to production must pass through getPool(), which carries the
    // guard. Widened after Warden showed the first version missed
    // `await import('pg')`, 'pg-pool', 'pg/lib/client.js', and every extension
    // other than .ts.
    const DRIVER = /(?:from|import|require)\s*\(?\s*['"`](pg|pg-pool|pg\/[^'"`]+|postgres|knex|slonik|drizzle-orm\/node-postgres)['"`]/
    const CODE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/
    const offenders: string[] = []
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        // `generated` is gitignored Prisma output — scanning it makes the
        // result depend on whether `prisma generate` has been run.
        if (['node_modules', '.git', 'dist', '.next', 'generated', 'coverage'].includes(e.name)) continue
        const p = join(dir, e.name)
        if (e.isDirectory()) { walk(p); continue }
        if (!CODE.test(e.name)) continue
        if (DRIVER.test(readFileSync(p, 'utf-8'))) offenders.push(p.replace(`${REPO}/`, ''))
      }
    }
    for (const group of workspaceGroups()) {
      const dir = join(REPO, group)
      if (existsSync(dir)) walk(dir)
    }
    const outside = offenders.filter(f => !f.startsWith('packages/db/'))
    expect(outside, `these reach Postgres without getPool(): ${outside.join(', ')}`).toEqual([])
  })
})
