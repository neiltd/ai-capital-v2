// THE PRODUCTION BOUNDARY MUST NOT MOVE WHEN THE CODE MOVES.
//
// S4F relocates the production runtime out of ~/Desktop, because macOS TCC
// refuses to let launchd execute scripts there — the daily, watchdog and alerts
// agents have been failing with "Operation not permitted" and the pipeline has
// not run since 2026-09-06. Relocation touches two things that must not be got
// wrong:
//
//   1. WHICH DIRECTORIES COUNT AS PRODUCTION. During the transition BOTH the new
//      runtime root and the legacy Desktop root are protected. An isolated test
//      destination must be outside both.
//
//   2. HOW A SCRIPT FINDS ITS OWN CHECKOUT. Four scripts hard-coded the Desktop
//      path; they now derive it from BASH_SOURCE[0], so a relocated copy works
//      and, equally important, does NOT reach back into the old tree.
//
// THE REJECTED ALTERNATIVE, AND WHY. Deriving the production root from this
// module's own location would make every checkout claim to be production —
// including the /private/tmp worktree this suite frequently runs from — so
// isInsideProductionRepo() would answer `true` for a temp worktree and `false`
// for the real runtime root, inverting the guard. The roots are fixed literals
// and are never read from cwd, PWD, HOME, AI_CAPITAL_ROOT or Git metadata.
//
// Nothing here contacts Redis, PostgreSQL, SQLite, launchd, an API or a model.
// Every filesystem fixture is a temporary directory.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  PRODUCTION_REPO, PRODUCTION_ROOTS, canonicalPath, isInsideProductionRepo, isProductionRunDb,
} from '../src/destinations.js'
import { decideIsolation, requireIsolation } from '../src/isolation.js'

const RUNTIME_ROOT = '/Users/thanapold/ai-capital-runtime'
const LEGACY_ROOT = '/Users/thanapold/Desktop/Projects.nosync'
const REPO = fileURLToPath(new URL('../../../', import.meta.url))

let work: string
beforeEach(() => { work = realpathSync(mkdtempSync(join(tmpdir(), 'rootport-'))) })
afterEach(() => { rmSync(work, { recursive: true, force: true }) })

describe('the protected roots are fixed literals', () => {
  it('protects exactly the two transition roots, in canonical order', () => {
    expect([...PRODUCTION_ROOTS]).toEqual([RUNTIME_ROOT, LEGACY_ROOT])
  })

  it('names the NEW runtime root as the canonical default', () => {
    expect(PRODUCTION_REPO).toBe(RUNTIME_ROOT)
  })

  it('is frozen, so nothing can extend or narrow it at runtime', () => {
    expect(Object.isFrozen(PRODUCTION_ROOTS)).toBe(true)
  })

  it.each([
    ['the runtime root itself', RUNTIME_ROOT],
    ['a path under the runtime root', `${RUNTIME_ROOT}/data/pipeline-runs.db`],
    ['a deep path under the runtime root', `${RUNTIME_ROOT}/apps/x/data/y.db`],
    ['the legacy root itself', LEGACY_ROOT],
    ['a path under the legacy root', `${LEGACY_ROOT}/data/pipeline-runs.db`],
  ])('protects %s', (_label, p) => {
    expect(isInsideProductionRepo(p)).toBe(true)
    expect(isProductionRunDb(p)).toBe(true)
  })

  it.each([
    ['a sibling sharing a prefix', '/Users/thanapold/ai-capital-runtime-old/data/pipeline-runs.db'],
    ['another sibling prefix', '/Users/thanapold/ai-capital-runtime.bak'],
    ['a legacy-root prefix sibling', '/Users/thanapold/Desktop/Projects.nosync-backup/data/x.db'],
    ['an unrelated path', '/tmp/iso/pipeline-runs.db'],
  ])('does NOT protect %s', (_label, p) => {
    expect(isInsideProductionRepo(p)).toBe(false)
  })
})

describe('a temporary worktree is not production merely because it ran the code', () => {
  it('the /private/tmp checkout this suite may run from is NOT production', () => {
    // The decisive case. Under module-location derivation this would be `true`.
    if (REPO.startsWith('/private/tmp/') || REPO.startsWith('/tmp/')) {
      expect(isInsideProductionRepo(REPO)).toBe(false)
      expect(isInsideProductionRepo(join(REPO, 'data/pipeline-runs.db'))).toBe(false)
    }
    // And an explicit temp worktree path is never production, wherever we run.
    expect(isInsideProductionRepo('/private/tmp/ai-capital-some-worktree')).toBe(false)
    expect(isInsideProductionRepo(join(work, 'data/pipeline-runs.db'))).toBe(false)
  })

  it('the module\'s own directory is not consulted', () => {
    const here = dirname(fileURLToPath(import.meta.url))
    expect(PRODUCTION_ROOTS).not.toContain(here)
    expect(PRODUCTION_ROOTS.some(r => here.startsWith(r))).toBe(
      here.startsWith(RUNTIME_ROOT) || here.startsWith(LEGACY_ROOT),
    )
  })
})

describe('aliases cannot escape classification', () => {
  it('a `..` traversal back into a protected root stays protected', () => {
    expect(isInsideProductionRepo(`${LEGACY_ROOT}/apps/../data/pipeline-runs.db`)).toBe(true)
    expect(isInsideProductionRepo(`${RUNTIME_ROOT}/apps/../data/pipeline-runs.db`)).toBe(true)
  })

  it('a `..` traversal OUT of a protected root is not protected', () => {
    expect(isInsideProductionRepo(`${RUNTIME_ROOT}/../somewhere-else/x.db`)).toBe(false)
  })

  // ── THE FAIL-OPEN BYPASS THAT WAS HERE BEFORE ─────────────────────────
  //
  // The test this block replaces linked one temporary directory to another, so
  // the expected answer was `false` either way — it could not distinguish a
  // working boundary from a broken one, and it passed against an implementation
  // that did `catch { return abs }`: an unresolved alias returned verbatim.
  //
  // The real case is a symlink OUTSIDE production pointing INTO a protected
  // root, with a final component that does not exist yet (a run database about
  // to be created is exactly that). realpath of the whole path throws ENOENT,
  // the old code handed back the outside-looking alias, and the destination was
  // classified ISOLATED while every write would land in production.
  //
  // These fixtures live entirely under `work`. The legacy root is only ever the
  // TARGET of a symlink — read, never written, never created, never removed.

  it('an outside alias into the protected legacy root, plus a nonexistent child, is PRODUCTION', () => {
    // The legacy root really exists, which is what makes this the live case.
    const alias = join(work, 'legacy-alias')
    symlinkSync(LEGACY_ROOT, alias)
    const child = join(alias, `data/nonexistent-${process.pid}-${Date.now()}.db`)
    expect(isInsideProductionRepo(child)).toBe(true)
    expect(isProductionRunDb(child)).toBe(true)
  })

  it('canonicalPath resolves that alias onto the protected root despite the missing child', () => {
    const alias = join(work, 'legacy-alias')
    symlinkSync(LEGACY_ROOT, alias)
    const missing = `nonexistent-${process.pid}-${Date.now()}.db`
    const canon = canonicalPath(join(alias, 'data', missing))
    // The alias is gone from the answer, the real root is in it…
    expect(canon).toBe(join(realpathSync(LEGACY_ROOT), 'data', missing))
    expect(canon.startsWith(work)).toBe(false)
    // …and the unresolved tail is preserved exactly, not invented or dropped.
    expect(canon.endsWith(`/data/${missing}`)).toBe(true)
  })

  it('an outside alias to an ISOLATED directory, plus a nonexistent child, stays isolated', () => {
    // Same shape, opposite target: resolution must not over-claim production.
    const target = join(work, 'target'); mkdirSync(target, { recursive: true })
    const alias = join(work, 'iso-alias'); symlinkSync(target, alias)
    const child = join(alias, 'data', 'not-created-yet.db')
    expect(isInsideProductionRepo(child)).toBe(false)
    // The answer names the REAL target, not the alias it was reached through.
    expect(canonicalPath(child)).toBe(join(target, 'data', 'not-created-yet.db'))
    expect(canonicalPath(child).includes('/iso-alias/')).toBe(false)
  })

  it('a symlink to something that EXISTS still resolves exactly as before', () => {
    const dir = join(work, 'real-dir'); mkdirSync(dir, { recursive: true })
    const file = join(dir, 'real-file'); writeFileSync(file, 'x')
    const dirLink = join(work, 'dir-link'); symlinkSync(dir, dirLink)
    const fileLink = join(work, 'file-link'); symlinkSync(file, fileLink)
    expect(canonicalPath(dirLink)).toBe(dir)
    expect(canonicalPath(fileLink)).toBe(file)
    // Reached THROUGH the directory link, an existing file resolves the same.
    expect(canonicalPath(join(dirLink, 'real-file'))).toBe(file)
    expect(isInsideProductionRepo(dirLink)).toBe(false)
  })

  it('a symlink LOOP fails closed — it throws instead of being called isolated', () => {
    // ELOOP is not "missing". We could not determine where this path goes, and
    // an undetermined path must never be handed back as a classification.
    const a = join(work, 'loop-a')
    const b = join(work, 'loop-b')
    symlinkSync(b, a)
    symlinkSync(a, b)
    expect(() => canonicalPath(a)).toThrow()
    expect(() => canonicalPath(join(a, 'child.db'))).toThrow()
    expect(() => isInsideProductionRepo(a)).toThrow()
    // Specifically the OS error, not a swallow-and-guess.
    try { canonicalPath(a); throw new Error('expected a throw') } catch (e) {
      expect((e as NodeJS.ErrnoException).code).toBe('ELOOP')
    }
  })

  it('a plain nonexistent path outside both roots stays isolated', () => {
    expect(isInsideProductionRepo(join(work, 'no/such/dir/x.db'))).toBe(false)
    expect(isInsideProductionRepo('/private/tmp/ai-capital-nope/data/pipeline-runs.db')).toBe(false)
  })

  it.each([
    ['legacy root (exists)', LEGACY_ROOT],
    ['runtime root (does not exist yet)', RUNTIME_ROOT],
  ])('a nonexistent descendant beneath the %s is still PRODUCTION', (_label, root) => {
    // The runtime root has not been created yet — the walk reaches /Users/thanapold
    // and re-attaches the whole missing tail, so the literal still protects it.
    const p = join(root, 'data', `nonexistent-${process.pid}.db`)
    expect(isInsideProductionRepo(p)).toBe(true)
    expect(isProductionRunDb(p)).toBe(true)
  })

  it('relative inputs and sibling-prefix rejection are unchanged', () => {
    const cwd = realpathSync(process.cwd())
    // The ONLY cwd consultation is path.resolve of an explicitly relative input.
    expect(canonicalPath('.')).toBe(cwd)
    expect(canonicalPath('no-such-entry-here')).toBe(join(cwd, 'no-such-entry-here'))
    // A sibling that merely shares the root's prefix is not inside it — the
    // comparison is separator-bound, and the ancestor walk does not soften it.
    expect(isInsideProductionRepo(`${RUNTIME_ROOT}-old/data/pipeline-runs.db`)).toBe(false)
    expect(isInsideProductionRepo(`${LEGACY_ROOT}-backup/data/pipeline-runs.db`)).toBe(false)
    expect(isInsideProductionRepo(`${LEGACY_ROOT}x`)).toBe(false)
  })
})

describe('no environment input can move the boundary', () => {
  const KEYS = ['AI_CAPITAL_ROOT', 'PWD', 'HOME', 'PIPELINE_RUNS_DB'] as const

  it('setting AI_CAPITAL_ROOT, PWD, HOME or cwd does not change the roots', () => {
    const saved: Record<string, string | undefined> = {}
    for (const k of KEYS) saved[k] = process.env[k]
    const prevCwd = process.cwd()
    try {
      for (const k of KEYS) process.env[k] = work
      process.chdir(work)
      expect([...PRODUCTION_ROOTS]).toEqual([RUNTIME_ROOT, LEGACY_ROOT])
      expect(PRODUCTION_REPO).toBe(RUNTIME_ROOT)
      expect(isInsideProductionRepo(`${LEGACY_ROOT}/data/x.db`)).toBe(true)
      expect(isInsideProductionRepo(join(work, 'data/x.db'))).toBe(false)
    } finally {
      process.chdir(prevCwd)
      for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k] as string }
    }
  })

  it('an environment variable set BEFORE the module loads still cannot move the roots', async () => {
    // The decisive form. PRODUCTION_ROOTS is evaluated at module-evaluation
    // time, so asserting after the import has already happened would miss a
    // constant that read process.env on the way in. Re-import with the decoys
    // already set.
    const saved = { root: process.env.AI_CAPITAL_ROOT, home: process.env.HOME, pwd: process.env.PWD }
    try {
      process.env.AI_CAPITAL_ROOT = work
      process.env.HOME = work
      process.env.PWD = work
      vi.resetModules()
      // resetModules() above discards the cached module record, so this plain
      // specifier re-evaluates the file with the decoys already in place.
      const fresh = await import('../src/destinations.js')
      expect([...(fresh.PRODUCTION_ROOTS as readonly string[])]).toEqual([RUNTIME_ROOT, LEGACY_ROOT])
      expect(fresh.PRODUCTION_REPO).toBe(RUNTIME_ROOT)
      expect(fresh.isInsideProductionRepo(join(work, 'data/x.db'))).toBe(false)
    } finally {
      if (saved.root === undefined) delete process.env.AI_CAPITAL_ROOT; else process.env.AI_CAPITAL_ROOT = saved.root
      if (saved.home === undefined) delete process.env.HOME; else process.env.HOME = saved.home
      if (saved.pwd === undefined) delete process.env.PWD; else process.env.PWD = saved.pwd
      vi.resetModules()
    }
  })

  it('destinations.ts reads no environment variable at all', () => {
    const src = readFileSync(join(REPO, 'packages/queue/src/destinations.ts'), 'utf-8')
      .split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')
    expect(src).not.toMatch(/process\.env/)
    // Non-vacuity: the comment-stripped text is still the module body.
    expect(src).toContain('export const PRODUCTION_ROOTS')
  })

  it('a RELATIVE path is judged by where it resolves, not by the string', () => {
    const prevCwd = process.cwd()
    try {
      process.chdir(work)
      expect(isInsideProductionRepo('data/pipeline-runs.db')).toBe(false)
    } finally { process.chdir(prevCwd) }
  })
})

describe('isolation defaults and fail-closed semantics', () => {
  // An EMPTY environment is the honest way to read the defaults: decideIsolation
  // throws on partial isolation, so isolating Redis alone to "get a decision
  // back" would test the refusal, not the default.
  it('unset PIPELINE_RUNS_DB resolves against the canonical RUNTIME root', async () => {
    const d = await decideIsolation({} as NodeJS.ProcessEnv)
    expect(d.pipelineRunsDb.startsWith(canonicalPath(RUNTIME_ROOT))).toBe(true)
    expect(d.pipelineRunsDb).toContain('data/pipeline-runs.db')
    expect(d.pipelineRunsDb).not.toContain('Desktop/Projects.nosync')
  })

  it('unset AI_CAPITAL_ROOT resolves to the canonical RUNTIME root', async () => {
    const d = await decideIsolation({} as NodeJS.ProcessEnv)
    expect(d.root).toBe(canonicalPath(RUNTIME_ROOT))
  })

  it('an empty environment is PRODUCTION, never isolated', async () => {
    expect((await decideIsolation({} as NodeJS.ProcessEnv)).mode).toBe('production')
  })

  it.each([
    ['only the filesystem', { AI_CAPITAL_ROOT: '/private/tmp/iso' }],
    ['only the run database', { PIPELINE_RUNS_DB: '/private/tmp/iso/runs.db' }],
    ['filesystem + database, production Redis', { AI_CAPITAL_ROOT: '/private/tmp/iso', PIPELINE_RUNS_DB: '/private/tmp/iso/runs.db' }],
  ])('isolating %s still fails closed', async (_label, env) => {
    await expect(requireIsolation(env as NodeJS.ProcessEnv)).rejects.toThrow()
  })

  it('a path inside the LEGACY root does not count as isolation', async () => {
    // Both point INSIDE the legacy protected root, so neither counts as an
    // isolated dimension: zero of three → production, not a partial refusal.
    const d = await decideIsolation({
      AI_CAPITAL_ROOT: `${LEGACY_ROOT}/tmp-ish`,
      PIPELINE_RUNS_DB: `${LEGACY_ROOT}/data/pipeline-runs.db`,
    } as NodeJS.ProcessEnv)
    expect(d.mode).toBe('production')
  })
})

// ── SHELL PORTABILITY ────────────────────────────────────────────────────────
//
// Driven by COPYING each script into a fake checkout and asking it what ROOT it
// derived. A source-text assertion alone would not catch a script that reads
// BASH_SOURCE and then throws the answer away.
describe('the four relocated scripts derive ROOT from their own location', () => {
  const SCRIPTS = ['run-alerts.sh', 'refresh-prices.sh', 'daily-catchup.sh', 'dep-graph-scan.sh'] as const

  /** Copy one script into <work>/fake-root/scripts/ and echo its derived ROOT. */
  function derivedRoot(script: string): { root: string; dataRoot: string } {
    const fakeRoot = join(work, 'fake-root')
    mkdirSync(join(fakeRoot, 'scripts'), { recursive: true })
    const dst = join(fakeRoot, 'scripts', script)
    copyFileSync(join(REPO, 'scripts', script), dst)
    chmodSync(dst, 0o755)
    // Source only the prologue — up to the first line that would DO something —
    // so nothing executes: no npx, no network, no pipeline.
    const body = readFileSync(dst, 'utf-8')
    const cut = body.split('\n').findIndex(l => /^(exec|cd |npm |npx |"\$ROOT)/.test(l.trim()))
    const prologue = body.split('\n').slice(0, cut > 0 ? cut : undefined).join('\n')
    // The probe MUST live where the real script lives: BASH_SOURCE[0] is the
    // executing file, so a probe written elsewhere would derive that other
    // directory — which is exactly the property under test.
    const probe = join(fakeRoot, 'scripts', `probe-${script}`)
    writeFileSync(probe,
      `${prologue}\nprintf '%s\\n%s\\n' "\${ROOT:-}" "\${DATA_ROOT:-}"\n`, { mode: 0o755 })
    const out = execFileSync('bash', [probe], { encoding: 'utf-8', timeout: 20_000 }).split('\n')
    return { root: out[0] ?? '', dataRoot: out[1] ?? '' }
  }

  it.each(SCRIPTS)('%s derives ROOT from its own location', (script) => {
    const { root } = derivedRoot(script)
    // `cd … && pwd` yields the PHYSICAL path; compare canonical forms.
    expect(realpathSync(root)).toBe(realpathSync(join(work, 'fake-root')))
    // …and specifically NOT the Desktop tree.
    expect(root).not.toContain('Desktop/Projects.nosync')
  })

  it('refresh-prices.sh derives DATA_ROOT FROM the derived ROOT', () => {
    const { root, dataRoot } = derivedRoot('refresh-prices.sh')
    expect(dataRoot).toBe(`${root}/apps`)
    expect(dataRoot).not.toContain('Desktop/Projects.nosync')
  })

  it.each(SCRIPTS)('%s retains no Desktop absolute root in its CODE', (script) => {
    const code = readFileSync(join(REPO, 'scripts', script), 'utf-8')
      .split('\n').filter(l => !/^\s*#/.test(l)).join('\n')
    expect(code).not.toContain('/Users/thanapold/Desktop')
    // Non-vacuity: the comment-stripped text is still the body of the script.
    expect(code).toContain('BASH_SOURCE[0]')
  })

  it.each(SCRIPTS)('%s uses BASH_SOURCE, not $0 or cwd, for the derivation', (script) => {
    const code = readFileSync(join(REPO, 'scripts', script), 'utf-8')
      .split('\n').filter(l => !/^\s*#/.test(l)).join('\n')
    expect(code).toMatch(/ROOT="\$\(cd "\$\(dirname "\$\{BASH_SOURCE\[0\]\}"\)\/\.\." && pwd\)"/)
    expect(code).not.toMatch(/ROOT="\$\(cd "\$\(dirname "\$0"\)/)
  })
})

describe('daily.sh suggests no competing scheduler', () => {
  const src = readFileSync(join(REPO, 'daily.sh'), 'utf-8')

  it('carries no cron schedule line, active or commented', () => {
    // A ready-to-paste cron entry beside a launchd-scheduled system is an
    // invitation to run the pipeline twice.
    expect(src).not.toMatch(/^\s*#?\s*\d+\s+\d+\s+[\d*]/m)
    expect(src).not.toContain('/Users/thanapold/Desktop/Projects/daily.sh')
  })

  it('names launchd as the scheduling authority', () => {
    expect(src).toMatch(/launchd/)
  })
})

describe('documentation states the transition honestly', () => {
  const docs = ['ops/README.md', 'CLAUDE.md'] as const

  it.each(docs)('%s names the proposed runtime root and says it does not exist yet', (rel) => {
    const text = readFileSync(join(REPO, rel), 'utf-8')
    expect(text).toContain('/Users/thanapold/ai-capital-runtime')
    expect(text).toMatch(/does \*\*not exist yet\*\*|does not exist yet/)
  })

  it.each(docs)('%s records that the legacy root stays protected and authoritative', (rel) => {
    const text = readFileSync(join(REPO, rel), 'utf-8')
    expect(text).toMatch(/legacy root/i)
    expect(text).toMatch(/authoritative/i)
  })

  it.each(docs)('%s defers legacy-root removal to a separately approved change', (rel) => {
    // Wrapped across lines in both documents, so whitespace is flexible.
    expect(readFileSync(join(REPO, rel), 'utf-8')).toMatch(/separately approved\s+retirement change/)
  })

  it.each(docs)('%s states that this slice performs no relocation or cutover', (rel) => {
    expect(readFileSync(join(REPO, rel), 'utf-8')).toMatch(/no relocation and no\s+cutover/)
  })
})
