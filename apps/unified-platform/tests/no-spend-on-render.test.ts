import { describe, it, expect, vi, beforeEach } from 'vitest'
import { join, dirname } from 'node:path'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { analyze } from './spend-graph.js'

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

  it('NO render root reaches an LLM client', async () => {
    const SRC = join(process.cwd(), 'src')
    const a = analyze(SRC, process.cwd())

    expect(a.parseFailures,
      `these reached files do not parse, so their edges vanish silently:\n  ${a.parseFailures.join('\n  ')}`,
    ).toEqual([])
    expect(a.roots.length, 'found no render roots — this would pass vacuously').toBeGreaterThan(20)
    expect(a.offenders, `render roots reach an LLM client:\n  ${a.offenders.join('\n  ')}`).toEqual([])

    // Default-deny backstop: an unreached file must not even be ABLE to reach
    // spending authority. agent.ts is the one module that legitimately holds it.
    expect(a.unreachedSpenders,
      'a file the walk never opened can reach an LLM client — traversal broke, or a new off-graph spender appeared',
    ).toEqual(['lib/studio/agent.ts'])

    // Traversal canary. WorldMapClient is reachable ONLY through
    // `dynamic(() => import(...))`; removing that edge loses it and 45 files
    // behind it. (A barrel canary is deliberately absent — measured, removing
    // the `export ... from` edge loses zero files, and a sentinel that cannot
    // wake reads as coverage.)
    expect(a.seen.has(join(SRC, 'app', '(legacy)', 'world', 'map', 'WorldMapClient.tsx')),
      'the dynamic-import traversal edge regressed').toBe(true)
  })

  // ── Adversarial corpus, by FAILURE CLASS ────────────────────────────────
  // Six rounds of attack produced dozens of syntax variants. Keeping one test
  // per variant would preserve a museum of fixed bugs; these are the semantic
  // classes instead. Each builds a miniature src tree and asserts the analyzer
  // reports an offender.
  describe('the walk catches each way spending authority reaches a non-user surface', () => {
    // Built by interpolation, never written literally: the repo-wide
    // findDeadTestFiles check scans test sources for import specifiers as TEXT,
    // so a literal relative specifier inside a fixture string reads to it as a
    // real unresolvable import. (Same text-matching-instead-of-parsing bug this
    // file spent six rounds removing, one level up — not mine to fix here. This
    // comment cannot spell the offending form either, for the same reason.)
    const imp = (what: string, spec: string) => `import ${what} from ` + `'${spec}'`
    const SPEND = `${imp('Anthropic', '@anthropic-ai/sdk')}\nexport const c = new Anthropic({ apiKey: 'x' })\nexport const use = () => c`
    const CASES: Array<[string, Record<string, string>]> = [
      ['module-scope client reachable by GET', {
        'app/api/x/route.ts': `${imp('Anthropic', '@anthropic-ai/sdk')}\nconst c = new Anthropic({apiKey:'x'})\nexport async function GET(){ return Response.json(!!c) }`,
      }],
      ['spending helper called by GET', {
        'app/api/x/route.ts': `${imp('{ use }', './h')}\nexport async function GET(){ return Response.json(!!use()) }`,
        'app/api/x/h.ts': SPEND,
      }],
      ['dynamic-import spending path from GET', {
        'app/api/x/route.ts': `export async function GET(){ const m = await import('./h'); return Response.json(!!m) }`,
        'app/api/x/h.ts': SPEND,
      }],
      ['HEAD-only spending route', {
        'app/api/x/route.ts': `${imp('Anthropic', '@anthropic-ai/sdk')}\nexport async function HEAD(){ return Response.json(!!new Anthropic({apiKey:'x'})) }`,
      }],
      ['OPTIONS-only spending route', {
        'app/api/x/route.ts': `${imp('Anthropic', '@anthropic-ai/sdk')}\nexport async function OPTIONS(){ return Response.json(!!new Anthropic({apiKey:'x'})) }`,
      }],
      ['page/render spending path', {
        'app/p/page.tsx': `${imp('{ use }', '../h')}\nexport default function P(){ return use() ? null : null }`,
        'app/h.ts': SPEND,
      }],
      ['the thesis-proposals spend moved back to module scope', {
        'app/api/thesis-proposals/route.ts': `${imp('Anthropic', '@anthropic-ai/sdk')}\nexport async function GET(){ return Response.json(405) }\nexport async function POST(){ return Response.json(!!new Anthropic({apiKey:'x'})) }`,
      }],
      ['a non-canonical GET export cannot hide it', {
        'app/api/x/route.ts': `${imp('Anthropic', '@anthropic-ai/sdk')}\nconst h = async () => Response.json(!!new Anthropic({apiKey:'x'}))\nexport { h as GET }`,
      }],
    ]

    it.each(CASES)('catches: %s', (_name, files) => {
      const dir = mkdtempSync(join(tmpdir(), 'spend-'))
      try {
        for (const [rel, src] of Object.entries(files)) {
          const p = join(dir, rel)
          mkdirSync(dirname(p), { recursive: true })
          writeFileSync(p, src, 'utf-8')
        }
        expect(analyze(dir).offenders.length, 'this should have been reported').toBeGreaterThan(0)
      } finally { rmSync(dir, { recursive: true, force: true }) }
    })

    // The mirror image, and the point of the whole simplification: a route that
    // does NOT expose a non-user method may hold spending authority. This is the
    // real api/thesis-proposals shape. If this ever goes red the analyzer has
    // become over-strict and every POST route in the app is unbuildable.
    it('does NOT flag a POST-only route that acquires the SDK inside POST', () => {
      const dir = mkdtempSync(join(tmpdir(), 'spend-'))
      try {
        const p = join(dir, 'app/api/x/route.ts')
        mkdirSync(dirname(p), { recursive: true })
        writeFileSync(p, `export async function POST(){ const { default: A } = await import('@anthropic-ai/sdk'); return Response.json(!!new A({apiKey:'x'})) }`, 'utf-8')
        expect(analyze(dir).offenders).toEqual([])
      } finally { rmSync(dir, { recursive: true, force: true }) }
    })
  })
})
