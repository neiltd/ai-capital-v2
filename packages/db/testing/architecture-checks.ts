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

/**
 * Every top-level directory worth scanning — workspace globs are not enough,
 * because code that constructs a connection does not stop being dangerous by
 * living in a directory pnpm ignores.
 */
export function scanRoots(repo: string): string[] {
  return readdirSync(repo, { withFileTypes: true })
    .filter(e => e.isDirectory() && !SKIP.includes(e.name))
    .map(e => e.name)
    .sort()
}

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
  // Warden showed the first version only matched the literal spellings
  // `new pg.Pool(` / `new Pool(`. Every one of these got through, and none is
  // deliberate evasion — the first is what a developer writes by reflex after
  // copying pool.ts's own `export type { Pool as PgPool } from 'pg'`:
  //
  //   import { Pool as PgPool } from 'pg' ; new PgPool(...)
  //   import pgDriver from 'pg'           ; new pgDriver.Pool(...)
  //   const { Pool: PGPool } = pg         ; new PGPool(...)
  //   const Ctor = pg.Pool                ; new Ctor(...)
  //   new (require('pg').Pool)(...)
  //
  // So: find every identifier this file binds from a Postgres driver, then flag
  // `new <that identifier>` in any spelling — plus the inline-require form.
  const ALT_DRIVER = /^(?!.*\bimport\s+type\b).*(?:from|require\s*\(|import\s*\()\s*['"`](pg-pool|pg-native|pg-promise|pg\/[^'"`]+|postgres|knex|slonik|drizzle-orm\/node-postgres|@neondatabase\/serverless)['"`]/m
  const offenders: string[] = []
  // Scan the WHOLE repository, not just the workspace globs. Warden pointed out
  // that `_archive/`, `design-redesign-2026-07/` and any root-level file were
  // never looked at — and an unscanned directory is exactly where a copied-out
  // connection helper survives a refactor and gets imported back in later.
  for (const group of scanRoots(repo)) {
    const dir = join(repo, group)
    if (!existsSync(dir)) continue
    walk(dir, repo, (abs, rel) => {
      if (!CODE.test(abs)) return
      if (rel === CANONICAL_CONNECTION_MODULE || PATTERN_HOLDERS.includes(rel)) return
      const src = readFileSync(abs, 'utf-8')
      if (ALT_DRIVER.test(src) || constructsPostgres(src)) offenders.push(rel)
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

/**
 * Does this source actually CONSTRUCT a Postgres connection, under any name?
 *
 * Type-only imports are ignored — `import type pg from 'pg'` is legitimate, and
 * an earlier version flagged it, which is how a check earns a reputation for
 * crying wolf and gets disabled.
 */
export function constructsPostgres(src: string): boolean {
  // `new (require('pg').Pool)(...)` and friends — no binding to track.
  if (/new\s*\(\s*require\s*\(\s*['"`]pg['"`]\s*\)\s*\.\s*(Pool|Client)\s*\)/.test(src)) return true

  const names = new Set<string>()
  const valueImportsPg = [...src.matchAll(
    /^(?!.*\bimport\s+type\b)\s*import\s+([^;]+?)\s+from\s*['"`]pg['"`]/gm)]
  for (const m of valueImportsPg) {
    const clause = m[1]
    // default binding: `pg`, `pg, { Pool }`
    const def = /^\s*([A-Za-z_$][\w$]*)/.exec(clause)
    if (def && !clause.trimStart().startsWith('{')) names.add(def[1])
    // named bindings, with or without aliases: `{ Pool as PgPool, Client }`
    for (const n of clause.matchAll(/([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?/g)) {
      if (n[1] === 'Pool' || n[1] === 'Client') names.add(n[2] ?? n[1])
    }
  }
  // `const { Pool: PGPool } = pg` / `const Ctor = pg.Pool`
  for (const m of src.matchAll(/(?:const|let|var)\s*\{([^}]*)\}\s*=\s*[A-Za-z_$][\w$]*/g)) {
    for (const n of m[1].matchAll(/(Pool|Client)\s*(?::\s*([A-Za-z_$][\w$]*))?/g)) names.add(n[2] ?? n[1])
  }
  for (const m of src.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*[A-Za-z_$][\w$]*\.(Pool|Client)\b/g)) {
    names.add(m[1])
  }
  // Always-suspect literal spellings, even with no import in this file.
  names.add('Pool'); names.add('Client')

  for (const name of names) {
    if (new RegExp(`new\\s+${name}\\s*\\(`).test(src)) return true
    // `new pgDriver.Pool(...)` — any member expression ending in .Pool/.Client
    if (new RegExp(`new\\s+${name}\\s*\\.\\s*(Pool|Client)\\s*\\(`).test(src)) return true
  }
  return /new\s+[A-Za-z_$][\w$]*\s*\.\s*(Pool|Client)\s*\(/.test(src)
}
