import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * THE INVARIANT:
 *
 *   GET / render          -> no Anthropic request
 *   explicit user action  -> Anthropic request
 *
 * WHY. `/studio/chat` set `force-dynamic` and its loader called
 * `anthropic.messages.create()` directly, so every authenticated page load made
 * one blocking, billable model call. It was the only `messages.create` site in
 * the app without a rate limit, and the only one reachable from a GET — every
 * other caller is a rate-limited POST.
 *
 * This test asserts on the CLIENT being called, not on the absence of a string
 * in the source. A source grep would pass while a transitive helper spends, and
 * transitive-below-a-renderer is precisely the failure mode that hid the
 * reapOrphans write for weeks.
 */

const createSpy = vi.fn(async () => ({ content: [{ type: 'text', text: 'should never happen' }] }))

vi.mock('@/lib/studio/agent', () => ({
  anthropic: { messages: { create: createSpy } },
  buildSystemPrompt: () => 'system',
}))

beforeEach(() => { createSpy.mockClear() })

describe('rendering /studio/chat does not spend', () => {
  it('the loader makes no Anthropic call', async () => {
    const { loadStudioChat } = await import('@/app/(next)/studio/chat/data')
    await loadStudioChat()
    expect(createSpy, 'loadStudioChat called the model').not.toHaveBeenCalled()
  })

  it('repeated loads still make none', async () => {
    const { loadStudioChat } = await import('@/app/(next)/studio/chat/data')
    for (let i = 0; i < 10; i++) await loadStudioChat()
    expect(createSpy).toHaveBeenCalledTimes(0)
  })

  it('rendering the PAGE makes no Anthropic call', async () => {
    // The request path, not just the loader — the page is what a GET reaches.
    const page = (await import('@/app/(next)/studio/chat/page')).default
    try { await page() } catch { /* JSX may not render without a Next request context; the spend, if any, already happened */ }
    expect(createSpy, 'rendering StudioChatPage called the model').not.toHaveBeenCalled()
  })

  it('the loader returns an empty opening, so the thread starts unopened', async () => {
    const { loadStudioChat } = await import('@/app/(next)/studio/chat/data')
    const vm = await loadStudioChat()
    expect(vm.opening).toBe('')
  })

  it('the topic actually resolves — so the assertions above are not vacuous', async () => {
    // loadStudioChat returns {topic: null, opening: ''} on its catch path, and
    // opening === '' is true on BOTH branches. If the world-intel export ever
    // goes missing, every test in this file would pass while asserting nothing.
    const { loadStudioChat } = await import('@/app/(next)/studio/chat/data')
    const vm = await loadStudioChat()
    expect(vm.topic, 'topic is null — these tests are asserting on the early-return path').not.toBeNull()
  })

  it('NO render root transitively reaches an LLM client', async () => {
    // Walks the import graph from every render root, following VALUE imports
    // only, and asks whether any reached module can spend.
    //
    // Two earlier versions of this check were wrong in opposite directions.
    // The first matched `from '@/lib/studio/agent'` with single quotes, and so
    // missed `new Anthropic({...})` constructed inline — the DOMINANT style
    // here (api/ask and api/thesis-proposals both do it). The second matched
    // spend-shapes per FILE and produced two false positives: topic-engine.ts,
    // which contains the string 'openai' in a keyword list, and agent.ts, which
    // legitimately defines the shared client and is value-imported only by
    // rate-limited POST routes.
    //
    // Reachability is the actual invariant. `import type` is erased at build
    // time and cannot spend, which is why ChatThread importing ChatMessage from
    // agent.ts is fine.
    const { readdirSync, readFileSync, statSync, existsSync } = await import('node:fs')
    const { join, dirname, resolve, sep } = await import('node:path')

    const SRC = join(process.cwd(), 'src')
    // A bare quoted 'openai' is NOT enough: topic-engine.ts lists it as a
    // scoring keyword. Require import context for the package names.
    const SPEND = /(?:from|require\s*\(|import\s*\()\s*['"`](?:@anthropic-ai\/sdk|openai)['"`]|new\s+(?:Anthropic|OpenAI)\s*\(|api\.(?:anthropic|openai)\.com/

    // WARDEN 2026-08-28 — this walk had EIGHT false negatives, two of them live
    // in the tree. Every widening below is one of them. The shape of the bug was
    // always the same: the walk knew a module-reference form existed (SPEND
    // matches `require(` and `import(`) and still refused to TRAVERSE it.
    //   - `global-error` was not a root, and a leading `\/` excluded scan-root files
    //   - `.jsx`/`.js` pages were invisible
    //   - only `import ... from` was traversed: not `import 'x'`, not
    //     `export ... from`, not `export * from`, not `await import()`, not
    //     `dynamic(() => import())`, not `require()`
    //   - resolveSpec knew nothing of .js/.jsx/.mjs or index.js
    //   - the `import type` strip ran to END OF LINE, deleting a real spend
    //     placed on the same line
    // Live consequences: `(legacy)/world/map/page.tsx` reaches its whole client
    // subtree only through `dynamic(() => import(...))`, so 46 worldmap files
    // were never opened; two `export ... from` edges stopped the walk dead.
    const RENDER_ROOT = /(?:^|\/)(page|layout|template|loading|error|global-error|not-found|default)\.(?:tsx?|jsx?)$/
    const SRC_FILE    = /\.(?:tsx?|jsx?|mjs)$/

    const roots: string[] = []
    const collect = (d: string) => {
      for (const e of readdirSync(d)) {
        const p = join(d, e)
        if (statSync(p).isDirectory()) { collect(p); continue }
        // API routes are POST-gated and rate-limited; they may spend.
        if (RENDER_ROOT.test(p) && !p.includes(join('src', 'app', 'api'))) roots.push(p)
      }
    }
    collect(join(SRC, 'app'))
    expect(roots.length, 'found no render roots — this test would pass vacuously').toBeGreaterThan(20)

    const resolveSpec = (from: string, spec: string): string | null => {
      const base = spec.startsWith('@/') ? join(SRC, spec.slice(2))
                 : spec.startsWith('.')  ? resolve(dirname(from), spec)
                 : null
      if (!base) return null
      // A TS source may be imported by its EMITTED specifier ('./helper.js'),
      // so try swapping a .js/.jsx suffix for its source form as well.
      const swapped = base.replace(/\.(js|jsx|mjs)$/, '')
      for (const c of [
        base, `${base}.ts`, `${base}.tsx`, `${base}.js`, `${base}.jsx`, `${base}.mjs`,
        `${swapped}.ts`, `${swapped}.tsx`,
        join(base, 'index.ts'), join(base, 'index.tsx'),
        join(base, 'index.js'), join(base, 'index.jsx'),
      ]) {
        if (existsSync(c) && statSync(c).isFile()) return c
      }
      return null
    }

    // Every module-reference form that causes the target to be EVALUATED.
    // Type-only statements are stripped first, terminating at the specifier's
    // closing quote rather than at end of line.
    const specifiers = (code: string): string[] => {
      const runtime = code
        .replace(/\bimport\s+type\s+[\s\S]*?from\s*['"`][^'"`]*['"`]/g, '')
        .replace(/\bexport\s+type\s+[\s\S]*?from\s*['"`][^'"`]*['"`]/g, '')
      const out: string[] = []
      // import ... from 'x' / export ... from 'x' / export * as N from 'x'
      for (const m of runtime.matchAll(/(?:^|[\s;}])(?:import|export)\b[^;'"`]*?\bfrom\s*['"`]([^'"`]+)['"`]/g)) out.push(m[1])
      // side-effect import: import 'x'
      for (const m of runtime.matchAll(/(?:^|[\s;}])import\s*['"`]([^'"`]+)['"`]/g)) out.push(m[1])
      // await import('x'), dynamic(() => import('x')), require('x')
      for (const m of runtime.matchAll(/\b(?:import|require)\s*\(\s*['"`]([^'"`]+)['"`]\s*\)/g)) out.push(m[1])
      return out
    }

    const seen = new Set<string>()
    const offenders: string[] = []
    const visit = (file: string, chain: string[]) => {
      if (seen.has(file)) return
      seen.add(file)
      const src = readFileSync(file, 'utf-8')
      const code = src.split('\n')
        .filter(l => !l.trim().startsWith('//') && !l.trim().startsWith('*'))
        .join('\n')
      const runtimeOnly = code
        .replace(/\bimport\s+type\s+[\s\S]*?from\s*['"`][^'"`]*['"`]/g, '')
        .replace(/\bexport\s+type\s+[\s\S]*?from\s*['"`][^'"`]*['"`]/g, '')
      if (SPEND.test(runtimeOnly)) {
        offenders.push([...chain, file].map(f => f.replace(SRC + '/', '')).join(' -> '))
        return
      }
      for (const spec of specifiers(code)) {
        const next = resolveSpec(file, spec)
        if (next) visit(next, [...chain, file])
      }
    }
    for (const r of roots) visit(r, [])

    // ── COVERAGE — a walk that never opened a file proves nothing about it ──
    // WARDEN 2026-08-28: the previous version asserted only the ABSENCE of
    // offenders among the files it happened to reach. It reached 202 of 273;
    // the 46 unreached worldmap files made this check decorative for the entire
    // world-map subtree while it reported green.
    //
    // The invariant that actually matters: a file the walk never opened is only
    // safe if it CANNOT spend. agent.ts is the one legitimate exception — it
    // defines the shared client and is value-imported only by rate-limited POST
    // routes. If a SECOND file ever appears here, either traversal broke or a
    // new spender was added off-graph. Both must be looked at by a human.
    const allFiles: string[] = []
    const collectAll = (d: string) => {
      for (const e of readdirSync(d)) {
        const p = join(d, e)
        if (statSync(p).isDirectory()) { collectAll(p); continue }
        if (SRC_FILE.test(p)) allFiles.push(p)
      }
    }
    collectAll(SRC)
    const STRUCTURAL = (f: string) =>
      f.startsWith(`app${sep}api${sep}`) || f.startsWith(`generated${sep}`) ||
      f.endsWith('.d.ts') || f === 'middleware.ts'
    const unreachedSpenders = allFiles
      .filter(f => !seen.has(f))
      .map(f => f.slice(SRC.length + 1))
      .filter(f => !STRUCTURAL(f))
      .filter(f => SPEND.test(readFileSync(join(SRC, f), 'utf-8')))
      .sort()
    expect(unreachedSpenders,
      'a file the reachability walk never opened can spend — traversal broke, or a new off-graph spender was added',
    ).toEqual(['lib/studio/agent.ts'])

    // Direct regression guards for the two traversal edges that were LIVE holes.
    // These are named explicitly because a count-based floor would not say WHICH
    // edge broke, and these two are the ones that actually did.
    for (const [edge, mustReach] of [
      ['dynamic(() => import())', `app${sep}(legacy)${sep}world${sep}map${sep}WorldMapClient.tsx`],
      ['export ... from (barrel)', `worldmap${sep}store${sep}useMapStore.ts`],
    ]) {
      expect(seen.has(join(SRC, mustReach)),
        `${mustReach} was never reached — the ${edge} traversal edge regressed`).toBe(true)
    }

    expect(offenders, `render roots reach an LLM client:\n  ${offenders.join('\n  ')}`).toEqual([])
  })
})
