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
    const { join, dirname, resolve } = await import('node:path')

    const SRC = join(process.cwd(), 'src')
    // A bare quoted 'openai' is NOT enough: topic-engine.ts lists it as a
    // scoring keyword. Require import context for the package names.
    const SPEND = /(?:from|require\s*\(|import\s*\()\s*['"`](?:@anthropic-ai\/sdk|openai)['"`]|new\s+(?:Anthropic|OpenAI)\s*\(|api\.(?:anthropic|openai)\.com/
    const RENDER_ROOT = /\/(page|layout|template|loading|error|not-found|default)\.tsx?$/

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
      for (const c of [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts'), join(base, 'index.tsx')]) {
        if (existsSync(c) && statSync(c).isFile()) return c
      }
      return null
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
      if (SPEND.test(code.replace(/import\s+type\s+[^\n]*/g, ''))) {
        offenders.push([...chain, file].map(f => f.replace(SRC + '/', '')).join(' -> '))
        return
      }
      for (const m of code.matchAll(/import\s+(?!type\s)([\s\S]*?)from\s*['"`]([^'"`]+)['"`]/g)) {
        if (/^\s*type\s/.test(m[1])) continue      // `import { type X }` style
        const next = resolveSpec(file, m[2])
        if (next) visit(next, [...chain, file])
      }
    }
    for (const r of roots) visit(r, [])

    expect(offenders, `render roots reach an LLM client:\n  ${offenders.join('\n  ')}`).toEqual([])
  })
})
