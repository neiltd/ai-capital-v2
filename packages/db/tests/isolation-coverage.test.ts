import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// Meta-test: every package that can run tests must load the DB isolation setup.
//
// WHY. The 2026-08-25 contamination happened in packages whose tests were
// individually fine. What was missing was a workspace-level guarantee. Warden's
// adversarial pass found that nothing catches a NEW app added tomorrow, or a
// typo'd `setupFiles` path — the coverage claim rested on someone having
// grepped correctly once.
//
// This test makes coverage a property the suite enforces rather than a fact
// someone checked. It reads the configs off disk; it does not run them.
//
// Note it deliberately does NOT grep test output for the "[test-isolation]"
// warning: vitest 4 intercepts setup-file console output, so that marker is
// invisible in some packages and would give a false negative.

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..', '..', '..')
const SETUP_BASENAME = 'vitest-db-isolation'

function packagesWithTestScript(): string[] {
  const out: string[] = []
  for (const group of ['apps', 'packages']) {
    const dir = join(REPO, group)
    if (!existsSync(dir)) continue
    for (const name of readdirSync(dir)) {
      const pkgJson = join(dir, name, 'package.json')
      if (!existsSync(pkgJson)) continue
      let scripts: Record<string, string> = {}
      try { scripts = JSON.parse(readFileSync(pkgJson, 'utf-8')).scripts ?? {} } catch { continue }
      // `test` and `test:watch` are both real entry points to the database.
      if (scripts.test || scripts['test:watch']) out.push(join(group, name))
    }
  }
  return out.sort()
}

const PACKAGES = packagesWithTestScript()

describe('DB isolation coverage across the workspace', () => {
  it('finds the packages that can run tests', () => {
    // Guards against the glob silently matching nothing and the suite below
    // passing vacuously — the exact silent-hole shape this repo keeps hitting.
    expect(PACKAGES.length).toBeGreaterThanOrEqual(10)
  })

  it.each(PACKAGES)('%s has a vitest config', pkg => {
    expect(existsSync(join(REPO, pkg, 'vitest.config.ts'))).toBe(true)
  })

  it.each(PACKAGES)('%s loads the shared isolation setup', pkg => {
    const cfg = readFileSync(join(REPO, pkg, 'vitest.config.ts'), 'utf-8')
    expect(cfg).toContain('setupFiles')
    expect(cfg).toContain(SETUP_BASENAME)
  })

  it.each(PACKAGES)('%s resolves the setup path portably, not absolutely', pkg => {
    const cfg = readFileSync(join(REPO, pkg, 'vitest.config.ts'), 'utf-8')
    // A hardcoded path breaks on any clone at a different location — and this
    // repo has a pending relocation out of ~/Desktop.
    expect(cfg).not.toMatch(/setupFiles:\s*\[\s*['"]\//)
    expect(cfg).toContain('import.meta.url')
  })

  it.each(PACKAGES)('%s points at a setup file that actually exists', pkg => {
    const cfg = readFileSync(join(REPO, pkg, 'vitest.config.ts'), 'utf-8')
    const m = cfg.match(/new URL\(\s*['"]([^'"]+)['"]\s*,\s*import\.meta\.url\s*\)/)
    expect(m, `${pkg}: could not extract the setup path`).toBeTruthy()
    // A typo'd path is the failure mode with no other detector.
    expect(existsSync(resolve(REPO, pkg, m![1])), `${pkg}: setup file missing at ${m![1]}`).toBe(true)
  })
})

describe('nothing else opens a Postgres connection', () => {
  it('only packages/db imports the pg driver', () => {
    // Every route to production must pass through getPool(), which carries the
    // guard. A package constructing its own Pool would bypass it entirely.
    const offenders: string[] = []
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'dist') continue
        const p = join(dir, entry.name)
        if (entry.isDirectory()) { walk(p); continue }
        if (!/\.ts$/.test(entry.name)) continue
        const src = readFileSync(p, 'utf-8')
        if (/from ['"]pg['"]|require\(['"]pg['"]\)/.test(src)) {
          offenders.push(p.replace(`${REPO}/`, ''))
        }
      }
    }
    for (const group of ['apps', 'packages']) {
      const dir = join(REPO, group)
      if (existsSync(dir)) walk(dir)
    }
    const outside = offenders.filter(f => !f.startsWith('packages/db/'))
    expect(outside, `these import pg directly and bypass getPool(): ${outside.join(', ')}`).toEqual([])
  })
})
