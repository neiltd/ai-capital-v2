import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

// CONTAINMENT INVARIANT:
//
//   Importing any module must never execute analysis, make a model/API call,
//   write analytical state, or terminate the process.
//
// `cli-schedule.ts` imported a helper from `cli-run.ts`, which is an executable
// entrypoint whose body ends in a bare `run().catch(… process.exit(1))` with no
// main guard. ESM evaluates an imported module's body, so merely STARTING the
// scheduler daemon performed a full unscheduled analysis — a billable model
// call, `insertRegime`, and writes to analysis.json, analysis.db and the daily
// report — before cron was ever consulted; and any failure in it exited the
// daemon before it reached its own schedule.
//
// The helper now lives in a side-effect-free library. These tests hold that
// line, and the structural one generalises it so the next helper cannot be
// taken from an entrypoint either.

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC = resolve(HERE, '..')

describe('importing the module cli-schedule depends on is inert', () => {
  // Run in a CHILD PROCESS rather than with mocks. A mock proves the mock was
  // not called; a child process proves the real module does nothing — which is
  // the claim, and the one a stub could quietly launder.
  const APP = resolve(SRC, '..')
  const DATA = join(APP, 'data')

  const snapshot = () => {
    const out = new Map<string, number>()
    const walk = (d: string) => {
      let entries: string[]
      try { entries = readdirSync(d) } catch { return }
      for (const e of entries) {
        const p = join(d, e)
        const st = statSync(p)
        if (st.isDirectory()) walk(p)
        else out.set(p, st.mtimeMs)
      }
    }
    walk(DATA)
    return out
  }

  const importInChild = (spec: string) => {
    // `.then()` rather than top-level await: `tsx -e` compiles as CJS, where TLA
    // is unsupported, and the transform error would look like a passing import.
    const script = `import(${JSON.stringify(spec)}).then(() => console.log('IMPORT_OK'))`
    return spawnSync('npx', ['tsx', '-e', script], {
      cwd: APP, encoding: 'utf-8', timeout: 60_000,
      // NOTE: blanking these is NOT a safety guard. cli-run imports
      // `dotenv/config`, which repopulates them from .env — I proved that the
      // hard way while checking this very test was non-vacuous, and reached a
      // live model call. The real guard is the assertion below: the probed
      // module's import graph must contain no SDK at all.
      env: { ...process.env, ANTHROPIC_API_KEY: '', DATABASE_URL: '' },
    })
  }

  // The guard that actually holds: a module with no SDK anywhere in its static
  // graph cannot bill, whatever the environment says.
  it('the probed module cannot reach an LLM SDK at all', () => {
    const seen = new Set<string>()
    const reaches = (file: string): boolean => {
      if (seen.has(file)) return false
      seen.add(file)
      const src = readFileSync(file, 'utf-8')
      if (/@anthropic-ai\/|from 'openai'|dotenv\/config/.test(src)) return true
      for (const spec of staticImports(file)) {
        if (!spec.startsWith('.')) continue
        const base = resolve(dirname(file), spec).replace(/\.js$/, '')
        const t = [`${base}.ts`, join(base, 'index.ts')].find(c => {
          try { return statSync(c).isFile() } catch { return false }
        })
        if (t && reaches(t)) return true
      }
      return false
    }
    expect(reaches(join(SRC, 'analysis', 'load-coverage.ts')),
      'load-coverage reaches an SDK or dotenv — the child probe could bill').toBe(false)
  })

  it('importing load-coverage runs nothing, writes nothing and exits 0', () => {
    const before = snapshot()
    const r = importInChild(join(SRC, 'analysis', 'load-coverage.ts'))
    const after = snapshot()

    expect(r.stdout, `import failed: ${r.stderr?.slice(0, 400)}`).toContain('IMPORT_OK')
    expect(r.status, 'the import terminated the process').toBe(0)

    // zero model/API call, zero insertRegime, zero scheduler execution
    const noise = `${r.stdout}${r.stderr}`
    for (const marker of ['messages.create', 'anthropic', 'insertRegime', 'scheduler started', 'Running daily']) {
      expect(noise.toLowerCase(), `import triggered "${marker}"`).not.toContain(marker.toLowerCase())
    }

    // zero analysis.json / analysis.db / daily-report writes
    const changed = [...after].filter(([p, m]) => before.get(p) !== m).map(([p]) => p)
    expect(changed, `files under data/ changed during import: ${changed.join(', ')}`).toEqual([])
    expect([...after.keys()].length).toBe([...before.keys()].length)
  })

  it('calling loadCoverage only reads, never throws, and never claims completeness it lacks', async () => {
    const { loadCoverage } = await import('./load-coverage.js')
    const before = snapshot()
    const c = loadCoverage(join(SRC, '__no_such_root__'))
    expect(c.complete).toBe(false)                    // unknown is never "complete"
    expect(c.caveat).toBeTruthy()
    const after = snapshot()
    expect([...after].filter(([p, m]) => before.get(p) !== m)).toEqual([])
  })
})

// ── The general rule, so the next helper cannot be taken from an entrypoint ──

/** A module is an ENTRYPOINT if its top level calls something — `run()`, `main()`. */
function isEntrypoint(file: string): boolean {
  const sf = ts.createSourceFile(file, readFileSync(file, 'utf-8'), ts.ScriptTarget.Latest, true)
  return sf.statements.some(st =>
    ts.isExpressionStatement(st) &&
    (ts.isCallExpression(st.expression) ||
     (ts.isPropertyAccessExpression(st.expression) === false &&
      ts.isAwaitExpression(st.expression) && ts.isCallExpression(st.expression.expression)) ||
     // `run().catch(…)` — a call chain hanging off a call
     (ts.isCallExpression(st.expression as never) === false &&
      ts.isPropertyAccessExpression((st.expression as ts.CallExpression)?.expression ?? st.expression))))
}

function sources(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e)
    if (statSync(p).isDirectory()) { sources(p, out); continue }
    if (/\.ts$/.test(p) && !/\.test\.ts$/.test(p)) out.push(p)
  }
  return out
}

function staticImports(file: string): string[] {
  const sf = ts.createSourceFile(file, readFileSync(file, 'utf-8'), ts.ScriptTarget.Latest, true)
  const out: string[] = []
  const walk = (n: ts.Node) => {
    if ((ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) &&
        n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier)) {
      const typeOnly = ts.isImportDeclaration(n) ? n.importClause?.isTypeOnly : n.isTypeOnly
      if (!typeOnly) out.push(n.moduleSpecifier.text)
    }
    ts.forEachChild(n, walk)
  }
  walk(sf)
  return out
}

describe('no module imports an executable entrypoint', () => {
  it('every relative import resolves to a module with no top-level call', () => {
    const offenders: string[] = []
    for (const file of sources(SRC)) {
      for (const spec of staticImports(file)) {
        if (!spec.startsWith('.')) continue
        const base = resolve(dirname(file), spec).replace(/\.js$/, '')
        const target = [`${base}.ts`, join(base, 'index.ts')].find(c => {
          try { return statSync(c).isFile() } catch { return false }
        })
        if (!target) continue
        if (isEntrypoint(target)) {
          offenders.push(`${file.slice(SRC.length + 1)} -> ${target.slice(SRC.length + 1)}`)
        }
      }
    }
    expect(offenders,
      `these import a module that executes at import time:\n  ${offenders.join('\n  ')}`).toEqual([])
  })

  // Non-vacuous: cli-run.ts really is an entrypoint, so the check above has
  // something to catch. If this ever fails, the detector stopped working.
  it('cli-run.ts is still detected as an entrypoint', () => {
    expect(isEntrypoint(join(SRC, 'cli', 'cli-run.ts'))).toBe(true)
  })
})
