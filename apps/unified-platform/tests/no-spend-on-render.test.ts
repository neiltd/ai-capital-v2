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
    const SPEND = /(?:from|require\s*\(|import\s*\()\s*['"`](?:@anthropic-ai\/sdk|openai)['"`]|new\s+(?:Anthropic|OpenAI)\s*\(|api\.(?:anthropic|openai)\.com/

    // WARDEN round 3 — the TYPE STRIP was unanchored and ate runtime code.
    // `[\s\S]*?` ran from any `export type` to the next text matching `from` +
    // a quote, and a type ALIAS (`export type AssetClass = ...`, no from clause)
    // opened a gap closed only by some later import — or by ORDINARY PROSE. In
    // src/types.ts a single-line JSDoc containing "from `score`" terminated it:
    // 44% of that file was invisible to both SPEND and the specifier extractor.
    // 124 of 291 files had a nonzero deletion.
    //
    // The dangerous shape it hid is exactly the one this test exists for: a
    // spend routed through the shared client, where NO file on the path holds a
    // SPEND literal, so traversal is the only detector — and the strip deleted
    // the traversal edge.
    //
    // Fixed two ways: comments are removed properly (not by line prefix), and a
    // type import must now MATCH ITS OWN STATEMENT rather than being a gap
    // between two anchors. The self-check below asserts the strip only ever
    // removes type-import specifiers.
    const TYPE_IMPORT = /\b(?:import|export)\s+type\s+(?:\{[^}]*\}|\*\s+as\s+[\w$]+|[\w$]+(?:\s*,\s*\{[^}]*\})?)\s+from\s*['"`][^'"`]+['"`]/g
    const stripComments = (t: string) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
    const runtimeCode   = (t: string) => stripComments(t).replace(TYPE_IMPORT, '')

    const RENDER_ROOT = /(?:^|\/)(page|layout|template|loading|error|global-error|not-found|default)\.(?:tsx?|jsx?|mts|cts)$/
    const SRC_FILE    = /\.(?:tsx?|jsx?|mjs|mts|cts)$/
    const API_DIR     = join('src', 'app', 'api')

    const specifiers = (code: string): string[] => {
      const out: string[] = []
      for (const m of code.matchAll(/(?:^|[\s;}])(?:import|export)\b[^;'"`]*?\bfrom\s*['"`]([^'"`]+)['"`]/g)) out.push(m[1])
      for (const m of code.matchAll(/(?:^|[\s;}])import\s*['"`]([^'"`]+)['"`]/g)) out.push(m[1])
      // `\(\s*` alone misses `import(/* webpackChunkName: "x" */ './impl')`.
      for (const m of code.matchAll(/\b(?:import|require)\s*\(\s*(?:\/\*[\s\S]*?\*\/\s*)?['"`]([^'"`]+)['"`]\s*\)/g)) out.push(m[1])
      return out
    }

    const roots: string[] = []
    const collect = (d: string) => {
      for (const e of readdirSync(d)) {
        const p = join(d, e)
        if (statSync(p).isDirectory()) { collect(p); continue }
        // A page under app/api is still served as a page — it was previously
        // excluded from BOTH roots and coverage, i.e. invisible twice over.
        if (RENDER_ROOT.test(p)) { roots.push(p); continue }
        // WARDEN: "POST-gated and rate-limited" is not true of every API route.
        // A route that exports GET renders on GET, so it is a render root.
        if (/(?:^|\/)route\.(?:tsx?|jsx?)$/.test(p) &&
            /\bexport\s+(?:async\s+)?(?:function\s+GET\b|const\s+GET\b)/.test(readFileSync(p, 'utf-8'))) roots.push(p)
      }
    }
    collect(join(SRC, 'app'))
    // middleware runs on EVERY request matched by its matcher — the broadest GET
    // surface in the app, including 401s. It was in the exclusion list.
    for (const mw of ['middleware.ts', 'middleware.tsx']) {
      const p = join(SRC, mw)
      if (existsSync(p)) roots.push(p)
    }
    expect(roots.length, 'found no render roots — this test would pass vacuously').toBeGreaterThan(20)

    const resolveSpec = (from: string, spec: string): string | null => {
      const base = spec.startsWith('@/') ? join(SRC, spec.slice(2))
                 : spec.startsWith('.')  ? resolve(dirname(from), spec)
                 : null
      if (!base) return null
      // next.config.mjs sets resolve.extensionAlias = { '.js': ['.ts','.tsx','.js'] },
      // so webpack prefers the TS source. Trying `base` first made the walk read
      // a different file than the build compiles.
      const swapped = base.replace(/\.(js|jsx|mjs)$/, '')
      const aliased = swapped !== base ? [`${swapped}.ts`, `${swapped}.tsx`] : []
      for (const c of [
        ...aliased, base,
        `${base}.ts`, `${base}.tsx`, `${base}.js`, `${base}.jsx`, `${base}.mjs`, `${base}.mts`, `${base}.cts`,
        join(base, 'index.ts'), join(base, 'index.tsx'), join(base, 'index.js'), join(base, 'index.jsx'),
      ]) {
        if (existsSync(c) && statSync(c).isFile()) return c
      }
      return null
    }

    const seen = new Set<string>()
    const offenders: string[] = []
    const stripViolations: string[] = []
    const visit = (file: string, chain: string[]) => {
      if (seen.has(file)) return
      seen.add(file)
      const src = readFileSync(file, 'utf-8')
      const bare = stripComments(src)
      const code = runtimeCode(src)

      // SELF-CHECK: the strip may remove ONLY type-import specifiers. This is
      // the assertion that would have caught the unanchored-strip defect.
      const removed = specifiers(bare).filter(x => !specifiers(code).includes(x))
      const declaredType = (bare.match(TYPE_IMPORT) ?? []).join('\n')
      for (const r of removed) {
        if (!declaredType.includes(r)) stripViolations.push(`${file.replace(SRC + '/', '')}: lost '${r}'`)
      }

      if (SPEND.test(code)) {
        offenders.push([...chain, file].map(f => f.replace(SRC + '/', '')).join(' -> '))
        return
      }
      for (const spec of specifiers(code)) {
        const next = resolveSpec(file, spec)
        if (next) visit(next, [...chain, file])
      }
    }
    for (const r of roots) visit(r, [])

    expect(stripViolations,
      `the type-import strip removed a RUNTIME specifier — it is eating real code:\n  ${stripViolations.join('\n  ')}`,
    ).toEqual([])

    const allFiles: string[] = []
    const collectAll = (d: string) => {
      for (const e of readdirSync(d)) {
        const p = join(d, e)
        if (statSync(p).isDirectory()) { collectAll(p); continue }
        if (SRC_FILE.test(p)) allFiles.push(p)
      }
    }
    collectAll(SRC)
    // app/api helpers reached only by POST may legitimately spend; GET routes are
    // now ROOTS, so the GET surface is covered by traversal rather than excluded.
    const STRUCTURAL = (f: string) =>
      f.startsWith(`app${sep}api${sep}`) || f.startsWith(`generated${sep}`) || f.endsWith('.d.ts')
    const unreachedSpenders = allFiles
      .filter(f => !seen.has(f))
      .map(f => f.slice(SRC.length + 1))
      .filter(f => !STRUCTURAL(f))
      .filter(f => SPEND.test(readFileSync(join(SRC, f), 'utf-8')))
      .sort()
    expect(unreachedSpenders,
      'a file the reachability walk never opened can spend — traversal broke, or a new off-graph spender was added',
    ).toEqual(['lib/studio/agent.ts'])

    for (const [edge, mustReach] of [
      ['dynamic(() => import())', `app${sep}(legacy)${sep}world${sep}map${sep}WorldMapClient.tsx`],
      ['export ... from (barrel)', `worldmap${sep}store${sep}useMapStore.ts`],
    ]) {
      expect(seen.has(join(SRC, mustReach)),
        `${mustReach} was never reached — the ${edge} traversal edge regressed`).toBe(true)
    }

    // A GET-exporting route.ts is a root, but SPEND is FILE-granular and a route
    // may hold its spend inside POST. Rather than pretend a regex can split
    // handler bodies, each such file is reviewed once and named here. Only the
    // root file itself is exempt — anything it REACHES still fires.
    //   app/api/thesis-proposals/route.ts — GET returns 405 at :10 before any
    //   client exists; the `new Anthropic` at :44 is inside POST, which is
    //   rate-limited at :14. Reviewed 2026-08-28.
    const GET_ROUTE_REVIEWED = [`app${sep}api${sep}thesis-proposals${sep}route.ts`]
    const realOffenders = offenders.filter(o => !GET_ROUTE_REVIEWED.includes(o))

    expect(realOffenders, `render roots reach an LLM client:\n  ${realOffenders.join('\n  ')}`).toEqual([])
    // The exemption must stay non-vacuous: if the file stops spending, drop it.
    for (const r of GET_ROUTE_REVIEWED) {
      expect(offenders, `${r} no longer spends — remove it from GET_ROUTE_REVIEWED`).toContain(r)
    }
  })
})
