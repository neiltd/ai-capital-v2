import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'

/**
 * Repository-level architectural invariants, in ONE implementation so the
 * vitest meta-test and the standalone verifier can never drift apart. A check
 * that exists twice is a check that disagrees with itself eventually.
 */

const SKIP = ['node_modules', '.git', 'dist', '.next', 'generated', 'coverage']
const CODE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/

/** The canonical connection module — the only place allowed to construct. */
export const CANONICAL_CONNECTION_MODULE = 'packages/db/src/pool.ts'

/** Files that legitimately contain these patterns as DATA, not as code. */
const PATTERN_HOLDERS = [
  'packages/db/testing/architecture-checks.ts',
  'packages/db/tests/isolation-coverage.test.ts',
]

export function workspaceGroups(repo: string): string[] {
  const f = join(repo, 'pnpm-workspace.yaml')
  if (!existsSync(f)) return ['apps', 'packages']
  const groups = [...readFileSync(f, 'utf-8').matchAll(/^\s*-\s*['"]?([^'"\n*]+)\/\*/gm)]
    .map(m => m[1].trim()).filter(g => g && !g.startsWith('!'))
  return groups.length ? [...new Set(groups)] : ['apps', 'packages']
}

function walk(dir: string, repo: string, visit: (abs: string, rel: string) => void): void {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.includes(e.name)) continue
    const p = join(dir, e.name)
    if (e.isDirectory()) { walk(p, repo, visit); continue }
    visit(p, p.replace(`${repo}/`, ''))
  }
}

/**
 * Every direct `new pg.Pool` / `new pg.Client` outside the canonical module,
 * plus any value-import of an ALTERNATE Postgres driver (which would route
 * around the factory entirely).
 *
 * Deliberately matches CONSTRUCTION, not imports: `import type pg from 'pg'`
 * is legitimate and an earlier version of this check flagged it, which is how
 * a real check acquires a reputation for crying wolf.
 */
export function findRawConstructions(repo: string): string[] {
  const CONSTRUCT = /new\s+(pg\.)?(Pool|Client)\s*\(/
  const ALT_DRIVER = /^(?!.*\bimport\s+type\b).*(?:from|require\s*\(|import\s*\()\s*['"`](pg-pool|pg\/[^'"`]+|postgres|knex|slonik|drizzle-orm\/node-postgres)['"`]/m
  const offenders: string[] = []
  for (const group of [...workspaceGroups(repo), 'scripts']) {
    const dir = join(repo, group)
    if (!existsSync(dir)) continue
    walk(dir, repo, (abs, rel) => {
      if (!CODE.test(abs)) return
      if (rel === CANONICAL_CONNECTION_MODULE || PATTERN_HOLDERS.includes(rel)) return
      const src = readFileSync(abs, 'utf-8')
      if (CONSTRUCT.test(src) || ALT_DRIVER.test(src)) offenders.push(rel)
    })
  }
  return offenders.sort()
}

/**
 * Test files whose relative imports do not resolve — i.e. tests that CANNOT
 * LOAD and therefore never run, while the runner still prints a passing count.
 *
 * Found on 2026-08-26: three files in dependency-graph-engine had imported a
 * module renamed on 2026-06-11. Fourteen tests had not executed in over two
 * months behind "Tests 15 passed". A test counted as coverage that does not
 * exist is worse than a missing test.
 */
export function findDeadTestFiles(repo: string): string[] {
  const IMPORT = /from\s+['"](\.[^'"]+)['"]/g
  const broken: string[] = []
  for (const group of workspaceGroups(repo)) {
    const dir = join(repo, group)
    if (!existsSync(dir)) continue
    walk(dir, repo, (abs, rel) => {
      if (!/\.(test|spec)\.(ts|tsx|mts|js)$/.test(abs)) return
      for (const m of readFileSync(abs, 'utf-8').matchAll(IMPORT)) {
        const base = resolve(dirname(abs), m[1])
        const cands = [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts')]
        if (base.endsWith('.js')) {
          const stem = base.slice(0, -3)
          cands.push(`${stem}.ts`, `${stem}.tsx`, `${stem}.mts`)
        }
        if (!cands.some(c => existsSync(c))) broken.push(`${rel} -> ${m[1]}`)
      }
    })
  }
  return broken.sort()
}
