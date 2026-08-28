import { describe, it, expect, vi, beforeEach } from 'vitest'
import { join, dirname } from 'node:path'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs'
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

  it('loading any root, or its static dependencies, acquires no spending authority', () => {
    const SRC = join(process.cwd(), 'src')
    const a = analyze(SRC, process.cwd())

    expect(a.parseFailures,
      `these reached files do not parse, so their edges vanish silently:\n  ${a.parseFailures.join('\n  ')}`,
    ).toEqual([])
    expect(a.roots.length, 'found no roots — this would pass vacuously').toBeGreaterThan(20)

    // A project-owned edge must never vanish because resolution failed. Dropped
    // silently, an unresolvable specifier into apps/* lost the traversal edge AND
    // fell outside the backstop, which reads as green.
    expect(a.unresolvedProjectEdges,
      `these look project-owned but did not resolve:\n  ${a.unresolvedProjectEdges.join('\n  ')}`,
    ).toEqual([])
    expect(a.offenders, `loading these acquires spending authority:\n  ${a.offenders.join('\n  ')}`).toEqual([])

    // Default-deny backstop, now covering workspace package sources too. This is
    // EMPTY rather than allowlisting lib/studio/agent.ts: that module used to
    // export a pre-constructed client, which was ambient authority for every
    // importer and is how four POST-only routes spent on GET. Nothing in the
    // app holds a client at module scope any more.
    expect(a.unreachedSpenders,
      'a file the walk never opened can reach an LLM client',
    ).toEqual([])
  })

  // ── Adversarial corpus, by EXECUTION CLASS ──────────────────────────────
  // Not one test per syntax spelling — that would rebuild the museum of fixed
  // bugs six rounds produced. One per way authority can be acquired before an
  // explicit handler runs.
  describe('acquiring authority before an explicit handler runs', () => {
    const imp = (what: string, spec: string) => `import ${what} from ` + `'${spec}'`
    const SDK = imp('Anthropic', '@anthropic-ai/sdk')
    const SPEND = `${SDK}\nexport const c = new Anthropic({ apiKey: 'x' })\nexport const use = () => c`

    // pnpm links workspace packages into node_modules; the fixture mirrors that
    // so the compiler resolves `@common/foo` exactly as the real build does.
    const link = (dir: string, name: string, target: string) => {
      const p = join(dir, 'node_modules', name)
      mkdirSync(dirname(p), { recursive: true })
      symlinkSync(join(dir, target), p, 'dir')
    }
    const build = (files: Record<string, string>) => {
      const dir = mkdtempSync(join(tmpdir(), 'spend-'))
      for (const [rel, src] of Object.entries(files)) {
        const p = join(dir, rel)
        mkdirSync(dirname(p), { recursive: true })
        writeFileSync(p, src, 'utf-8')
      }
      return dir
    }

    const CASES: Array<[string, Record<string, string>]> = [
      ['route module-load acquisition', {
        'src/app/api/x/route.ts': `${SDK}\nconst c = new Anthropic({apiKey:'x'})\nexport async function POST(){ return Response.json(!!c) }`,
      }],
      ['page/render acquisition', {
        'src/app/p/page.tsx': `${imp('{ use }', '../h')}\nexport default function P(){ return use() ? null : null }`,
        'src/app/h.ts': SPEND,
      }],
      ['middleware acquisition', {
        'src/middleware.ts': `${imp('{ use }', './h')}\nexport function middleware(){ return use() }`,
        'src/h.ts': SPEND,
      }],
      ['HEAD-only route acquisition', {
        'src/app/api/x/route.ts': `${SDK}\nconst c = new Anthropic({apiKey:'x'})\nexport async function HEAD(){ return Response.json(!!c) }`,
      }],
      ['OPTIONS-only route acquisition', {
        'src/app/api/x/route.ts': `${SDK}\nconst c = new Anthropic({apiKey:'x'})\nexport async function OPTIONS(){ return Response.json(!!c) }`,
      }],
      ['dynamic transitive path from a render root', {
        'src/app/p/page.tsx': `export default async function P(){ const m = await import('../h'); return m ? null : null }`,
        'src/app/h.ts': SPEND,
      }],
      ['module-scope singleton behind a static import', {
        'src/app/api/x/route.ts': `${imp('{ c }', './h')}\nexport async function POST(){ return Response.json(!!c) }`,
        'src/app/api/x/h.ts': SPEND,
      }],
      ['helper/factory invoked during module evaluation', {
        'src/app/api/x/route.ts': `${imp('{ make }', './h')}\nconst c = make()\nexport async function POST(){ return Response.json(!!c) }`,
        'src/app/api/x/h.ts': `${SDK}\nexport const make = () => new Anthropic({apiKey:'x'})`,
      }],
      // WARDEN round 7 defeated the previous `atModuleScope` model with these.
      // They fail now because authority is not PERMITTED outside a user-action
      // handler body — not because anything proved they run at load.
      ['same-file helper awaited at module scope', {
        'src/app/api/x/route.ts': `let c: any\nasync function boot(){ const { default: A } = await import('@anthropic-ai/sdk'); c = new A({apiKey:'x'}) }\nawait boot()\nexport async function POST(){ return Response.json(!!c) }`,
      }],
      ['module-scope async IIFE', {
        'src/app/api/x/route.ts': `const c = await (async () => { const { default: A } = await import('@anthropic-ai/sdk'); return new A({apiKey:'x'}) })()\nexport async function POST(){ return Response.json(!!c) }`,
      }],
      ['factory invoked at module scope', {
        'src/app/api/x/route.ts': `const make = () => import('@anthropic-ai/sdk')\nexport const client = make()\nexport async function POST(){ return Response.json(!!client) }`,
      }],
      // A GET/HEAD/OPTIONS body is a non-user surface, so it is not a permitted
      // location even though it is an exported handler.
      ['acquisition inside a GET handler body', {
        'src/app/api/x/route.ts': `export async function GET(){ const { default: A } = await import('@anthropic-ai/sdk'); return Response.json(!!new A({apiKey:'x'})) }`,
      }],
      ['acquisition in a default parameter value', {
        'src/app/api/x/route.ts': `export async function POST(x = await import('@anthropic-ai/sdk')){ return Response.json(!!x) }`,
      }],
      ['top-level await acquisition in a route', {
        'src/app/api/x/route.ts': `const { default: A } = await import('@anthropic-ai/sdk')\nexport async function POST(){ return Response.json(!!new A({apiKey:'x'})) }`,
      }],
    ]

    it.each(CASES)('catches: %s', (_n, files) => {
      const dir = build(files)
      try {
        expect(analyze(join(dir, 'src'), dir, dir).offenders.length,
          'this should have been reported').toBeGreaterThan(0)
      } finally { rmSync(dir, { recursive: true, force: true }) }
    })

    // transpilePackages compiles workspace packages INTO the app, so they are in
    // the executable graph and the authority graph must follow that edge. This
    // fixture is a real miniature workspace — resolution comes from the
    // package's own `exports`, never a list of packages presumed safe.
    it('catches: workspace-package transitive path', () => {
      const dir = build({
        'pnpm-workspace.yaml': `packages:\n  - 'packages/*'\n  - 'apps/*'\n`,
        'packages/foo/package.json': JSON.stringify({ name: '@common/foo', exports: { '.': { import: './src/index.ts' } } }),
        'packages/foo/src/index.ts': SPEND,
        'apps/w/src/app/p/page.tsx': `${imp('{ use }', '@common/foo')}\nexport default function P(){ return use() ? null : null }`,
      })
      link(dir, '@common/foo', 'packages/foo')
      try {
        const a = analyze(join(dir, 'apps/w/src'), join(dir, 'apps/w'), dir)
        expect(a.offenders.length, 'the workspace-package edge was not followed').toBeGreaterThan(0)
      } finally { rmSync(dir, { recursive: true, force: true }) }
    })

    // ── The three seams Warden broke in round 8 ────────────────────────────
    // Kept as semantic controls, not syntax variants: a body served under a
    // non-user method; a project-owned edge that vanished on resolution
    // failure; executable project-root code outside both traversal and backstop.
    describe('repaired seams', () => {
      const INL = `const { default: A } = await import('@anthropic-ai/sdk'); return Response.json(!!new A({apiKey:'x'}))`

      // A body is permitted only if EVERY method it is exported under is a user
      // action. Keying on the matching name let aliasing restore the incident.
      // Authority may not be permitted through direct, transitive, cyclic or
      // UNRESOLVED local aliasing. The last class is the structural one: twice
      // an unprovable alias was silently indistinguishable from "no such
      // export", so the name vanished and the body looked exclusively POST.
      it.each([
        ['direct: h as POST, h as GET', `const h = async () => { ${INL} }\nexport { h as POST, h as GET }`],
        ['direct: h as PUT, h as OPTIONS', `const h = async () => { ${INL} }\nexport { h as PUT, h as OPTIONS }`],
        ['one hop: export const GET = POST', `export async function POST(){ ${INL} }\nexport const GET = POST`],
        ['one hop: export { POST as GET }', `export async function POST(){ ${INL} }\nexport { POST as GET }`],
        ['two hops: h->g, h as POST, g as GET', `const h = async () => { ${INL} }\nconst g = h\nexport { h as POST }\nexport { g as GET }`],
        ['two hops: h->g, h as POST, GET = g', `async function h(){ ${INL} }\nconst g = h\nexport { h as POST }\nexport const GET = g`],
        ['three hops: h->g->k, h as POST, k as HEAD', `const h = async () => { ${INL} }\nconst g = h\nconst k = g\nexport { h as POST }\nexport { k as HEAD }`],
        ['cyclic alias behind an HTTP export', `const a = b\nconst b = a\nexport async function POST(){ ${INL} }\nexport { a as GET }`],
        ['unresolved HTTP-method alias', `export async function POST(){ ${INL} }\nexport const GET = someUnknown`],
        ['export * from a sibling', `export async function POST(){ ${INL} }\nexport * from ` + `'./h'`],
      ])('authority is not permitted when a body may be served as a non-user method: %s', (_n, src) => {
        const dir = build({ 'src/app/api/x/route.ts': src, 'src/app/api/x/h.ts': `export const GET = async () => Response.json(1)` })
        try { expect(analyze(join(dir, 'src'), dir, dir).offenders.length).toBeGreaterThan(0) }
        finally { rmSync(dir, { recursive: true, force: true }) }
      })

      // Asserted, not assumed: a handler body living in a sibling module cannot
      // be proven local, so the route file fails closed AND the sibling is
      // traversed as a non-route where any authority is an offence.
      it('a re-exported handler from a sibling module fails closed', () => {
        const dir = build({
          'src/app/api/x/route.ts': `export async function POST(){ ${INL} }\nexport { POST as GET } from ` + `'./h'`,
          'src/app/api/x/h.ts': SPEND,
        })
        try { expect(analyze(join(dir, 'src'), dir, dir).offenders.length).toBeGreaterThan(0) }
        finally { rmSync(dir, { recursive: true, force: true }) }
      })

      it.each([
        ['POST alone', `export async function POST(){ ${INL} }`],
        ['POST + PUT', `const h = async () => { ${INL} }\nexport { h as POST, h as PUT }`],
        ['POST + PATCH + DELETE', `const h = async () => { ${INL} }\nexport { h as POST, h as PATCH, h as DELETE }`],
      ])('a body served only under user methods stays allowed: %s', (_n, src) => {
        const dir = build({ 'src/app/api/x/route.ts': src })
        try { expect(analyze(join(dir, 'src'), dir, dir).offenders).toEqual([]) }
        finally { rmSync(dir, { recursive: true, force: true }) }
      })

      // dashboard -> apps/foo (name known, exports map blocks the subpath) -> SDK.
      // Traversal loses the edge and the backstop excludes apps/*, so without
      // this the result is silent green.
      it('a project-owned edge cannot vanish because resolution failed', () => {
        const dir = build({
          'pnpm-workspace.yaml': `packages:\n  - 'packages/*'\n  - 'apps/*'\n`,
          'apps/foo/package.json': JSON.stringify({ name: '@app/foo', exports: { '.': { import: './src/index.ts' } } }),
          'apps/foo/src/secret.ts': SPEND,
          'apps/w/package.json': JSON.stringify({ name: 'w', dependencies: {} }),
          'apps/w/src/app/p/page.tsx': `${imp('{ use }', '@app/foo/secret')}\nexport default function P(){ return use() ? null : null }`,
        })
        try {
          expect(analyze(join(dir, 'apps/w/src'), join(dir, 'apps/w'), dir).unresolvedProjectEdges.length,
            'the failed edge disappeared instead of failing the guard').toBeGreaterThan(0)
        } finally { rmSync(dir, { recursive: true, force: true }) }
      })

      // Not an enumeration of Next filenames — the point is that an UNKNOWN
      // future convention at the project root degrades to a backstop hit rather
      // than to silence.
      it.each(['mdx-components.tsx', 'instrumentation-client.ts', 'sentry.server.config.ts', 'some-future-convention.ts'])(
        'executable project-root code is backstopped: %s', file => {
          const dir = build({ [file]: SPEND, 'src/app/p/page.tsx': `export default function P(){ return null }` })
          try {
            const a = analyze(join(dir, 'src'), dir, dir)
            expect(a.unreachedSpenders.length + a.offenders.length,
              'project-root code fell outside both traversal and backstop').toBeGreaterThan(0)
          } finally { rmSync(dir, { recursive: true, force: true }) }
        })
    })

    // `next build` evaluates config before any request exists.
    it('catches: build-time config acquisition', () => {
      const dir = build({
        'next.config.mjs': `${imp('{ use }', './cfg-helper.mjs')}\nexport default { env: { x: String(!!use) } }`,
        'cfg-helper.mjs': SPEND,
        'src/app/p/page.tsx': `export default function P(){ return null }`,
      })
      try {
        expect(analyze(join(dir, 'src'), dir, dir).offenders.length,
          'build-time config is an execution surface').toBeGreaterThan(0)
      } finally { rmSync(dir, { recursive: true, force: true }) }
    })

    // THE INVERSE CONTROL, and the point of the whole architecture: a route may
    // acquire authority inside explicit handler execution. If this goes red the
    // analyzer has become over-strict and no spending route is buildable.
    it.each([
      ['export async function POST', `export async function POST(){ const { default: A } = await import('@anthropic-ai/sdk'); return Response.json(!!new A({apiKey:'x'})) }`],
      ['export async function PUT', `export async function PUT(){ const { default: A } = await import('@anthropic-ai/sdk'); return Response.json(!!new A({apiKey:'x'})) }`],
      ['export { h as POST }', `const h = async () => { const { default: A } = await import('@anthropic-ai/sdk'); return Response.json(!!new A({apiKey:'x'})) }\nexport { h as POST }`],
    ])('does NOT flag inline acquisition in %s', (_n, src) => {
      const dir = build({ 'src/app/api/x/route.ts': src })
      try {
        expect(analyze(join(dir, 'src'), dir, dir).offenders).toEqual([])
      } finally { rmSync(dir, { recursive: true, force: true }) }
    })
  })
})
