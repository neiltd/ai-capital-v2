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

    const ts = (await import('typescript')).default
    const SRC = join(process.cwd(), 'src')
    const ROOT_DIR = process.cwd()

    // WARDEN rounds 2-4. Three consecutive rounds found a NEW module-reference
    // form the regex enumeration missed: round 2 eight shapes, round 3 a tenth
    // (an unanchored type strip that ordinary JSDoc prose could terminate),
    // round 4 an eleventh (non-canonical `export { GET }`, Next file conventions)
    // and a twelfth (stripComments eating real code inside string/regex
    // literals, invisible to the self-check because BOTH sides of that
    // comparison were already past stripComments).
    //
    // The defect was never any individual pattern. It was that the check
    // ENUMERATED JavaScript module syntax with regexes, and the set of forms
    // that reach a module is larger than the set anyone enumerates — the same
    // lesson as the middleware default-deny inversion.
    //
    // So traversal and spend-detection now use the TypeScript compiler's own
    // parser. It knows every import/export/require/dynamic-import form by
    // construction, ignores comments and string literals by construction, and
    // knows type-only-ness exactly. That deletes these whole families:
    //   - "form X is not matched"        (AST, not regex)
    //   - "the type strip ate real code" (no strip exists)
    //   - "stripComments ate real code"  (comments are not tokens)
    //   - "a spend hid in a string"      (literals are typed nodes)
    const SDK = /^(?:@anthropic-ai\/(?:sdk|bedrock-sdk|vertex-sdk)|openai|@ai-sdk\/(?:anthropic|openai))(?:\/|$)/
    const HOST = /api\.(?:anthropic|openai)\.com/

    const parse = (file: string) =>
      ts.createSourceFile(file, readFileSync(file, 'utf-8'), ts.ScriptTarget.Latest, true,
        /\.[jt]sx$/.test(file) ? ts.ScriptKind.TSX : ts.ScriptKind.TS)

    const each = (sf: any, fn: (n: any) => void) => {
      const walk = (n: any) => { fn(n); ts.forEachChild(n, walk) }
      walk(sf)
    }
    const isExported = (n: any) =>
      n.modifiers?.some((m: any) => m.kind === ts.SyntaxKind.ExportKeyword)
    const callSpec = (n: any): string | null => {
      const isImp = n.expression?.kind === ts.SyntaxKind.ImportKeyword
      const isReq = ts.isIdentifier(n.expression) && n.expression.text === 'require'
      const a = n.arguments?.[0]
      const lit = a && (ts.isStringLiteral(a) || ts.isNoSubstitutionTemplateLiteral(a))
      return (isImp || isReq) && lit ? a.text : null
    }

    /** Every specifier whose module is EVALUATED at runtime. */
    const specifiers = (sf: any): string[] => {
      const out: string[] = []
      each(sf, n => {
        if (ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier)) {
          if (!n.importClause?.isTypeOnly) out.push(n.moduleSpecifier.text)
        } else if (ts.isExportDeclaration(n) && n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier)) {
          if (!n.isTypeOnly) out.push(n.moduleSpecifier.text)
        } else if (ts.isImportEqualsDeclaration(n) && ts.isExternalModuleReference(n.moduleReference) &&
                   ts.isStringLiteral(n.moduleReference.expression)) {
          // `import h = require('./x')`. The AST rewrite covered Import/Export
          // Declaration and CallExpression but not this — the enumeration had
          // merely moved from regexes to ts.isX guards.
          out.push(n.moduleReference.expression.text)
        } else if (ts.isCallExpression(n)) {
          const c = callSpec(n); if (c) out.push(c)
        }
      })
      return out
    }

    /** Spend-capable nodes, with their source positions. */
    const spendNodes = (sf: any): any[] => {
      const hits: any[] = []
      each(sf, n => {
        if ((ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) &&
            n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier)) {
          const typeOnly = ts.isImportDeclaration(n) ? n.importClause?.isTypeOnly : n.isTypeOnly
          if (!typeOnly && SDK.test(n.moduleSpecifier.text)) hits.push(n)
        } else if (ts.isCallExpression(n)) {
          const c = callSpec(n)
          if (c && SDK.test(c)) hits.push(n)
          if (ts.isIdentifier(n.expression) && /^create(?:Anthropic|OpenAI)$/.test(n.expression.text)) hits.push(n)
        } else if (ts.isImportEqualsDeclaration(n) && ts.isExternalModuleReference(n.moduleReference) &&
                   ts.isStringLiteral(n.moduleReference.expression) && SDK.test(n.moduleReference.expression.text)) {
          hits.push(n)
        } else if (ts.isNewExpression(n) &&
                   ((ts.isIdentifier(n.expression) && /^(?:Anthropic|OpenAI)$/.test(n.expression.text)) ||
                    (ts.isPropertyAccessExpression(n.expression) && /^(?:Anthropic|OpenAI)$/.test(n.expression.name.text)))) {
          hits.push(n)
        } else if ((ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) && HOST.test(n.text)) {
          hits.push(n)
        } else if (ts.isTemplateExpression(n) && HOST.test(n.getText())) {
          hits.push(n)
        }
      })
      return hits
    }

    /**
     * Methods that make a route file a RENDER ROOT: those served without an
     * explicit user action. GET is the obvious one; HEAD is crawler/prefetch
     * traffic and OPTIONS is browser CORS preflight, so a spend in either bills
     * on unauthenticated automated requests and must be walked.
     *
     * A route exporting ONLY HEAD used to be invisible twice over — not a root,
     * and excluded from coverage by app/api/** — which is the same double blind
     * found for page.tsx-under-api and for non-canonical GET exports.
     */
    const ROOT_METHOD = /^(?:GET|HEAD|OPTIONS)$/
    const exportsGET = (sf: any): boolean => {
      let found = false
      each(sf, n => {
        if (ts.isFunctionDeclaration(n) && n.name && ROOT_METHOD.test(n.name.text) && isExported(n)) found = true
        if (ts.isVariableStatement(n) && isExported(n)) {
          for (const d of n.declarationList.declarations) {
            if (ts.isIdentifier(d.name) && ROOT_METHOD.test(d.name.text)) found = true
            if (ts.isObjectBindingPattern(d.name))
              for (const e of d.name.elements) if (ts.isIdentifier(e.name) && ROOT_METHOD.test(e.name.text)) found = true
          }
        }
        if (ts.isExportDeclaration(n)) {
          if (n.exportClause && ts.isNamedExports(n.exportClause)) {
            for (const e of n.exportClause.elements) if (ROOT_METHOD.test(e.name.text)) found = true
          } else if (!n.exportClause) found = true   // `export * from` — cannot know; assume it does
        }
      })
      return found
    }

    /**
     * Spans of exported NON-GET handlers — the only place a spend is provably
     * unreachable on GET.
     *
     * WARDEN round 5: keying on GET spans was WORSE than the named exemption it
     * replaced. `exportsGET` was widened to accept `export { GET }` and friends
     * but the span finder was not, so for those forms it returned [] — and
     * `spans.some()` over an empty array is always false, granting the WHOLE
     * FILE immunity in the same pass that made it a root. The check was also
     * purely lexical, so a module-scope `const client = new Anthropic(...)` used
     * by GET was exempt: the singleton pattern, which is how agent.ts is written
     * and is the shape of the /studio/chat incident this test exists to prevent.
     * My RELOC decoy exercised the one arrangement where the lexical check
     * happens to work, which is why round 4 read as closed.
     *
     * Polarity now matches the rest of this file: uncertainty resolves as COUNT,
     * never as permit. A non-GET handler that cannot be located simply has no
     * span, so the spend counts.
     */
    // HEAD and OPTIONS are NOT user actions — OPTIONS is browser CORS preflight
    // and HEAD is crawler/prefetch traffic, so a spend in either bills on
    // unauthenticated automated requests. Only genuinely user-initiated methods
    // can justify an exemption.
    const NON_GET = /^(?:POST|PUT|PATCH|DELETE)$/
    const ASSIGN = (k: number) => k >= ts.SyntaxKind.FirstAssignment && k <= ts.SyntaxKind.LastAssignment

    const nonGetSpans = (sf: any): Array<[number, number]> => {
      const moduleScope = new Set<string>()
      for (const st of sf.statements) {
        if (ts.isVariableStatement(st))
          for (const d of st.declarationList.declarations)
            if (ts.isIdentifier(d.name)) moduleScope.add(d.name.text)
        if ((ts.isFunctionDeclaration(st) || ts.isClassDeclaration(st)) && st.name) moduleScope.add(st.name.text)
      }
      /**
       * Does anything in this handler let a value outlive the request, or run at
       * module load? Any of those and the span stops being an exemption.
       *
       * WARDEN round 6 listed five escapes the first version missed: it required
       * `ts.isIdentifier(m.left)` and `EqualsToken`, so `cache.client = …`,
       * `globalThis.x ??= …`, `pool.push(…)` and `;[c] = [ … ]` were all
       * invisible, as was an IIFE that runs at module load while sitting
       * lexically inside the handler.
       */
      const escapes = (node: any): boolean => {
        const local = new Set<string>()
        each(node, m => { if (ts.isVariableDeclaration(m) && ts.isIdentifier(m.name)) local.add(m.name.text) })
        let found = false
        each(node, m => {
          // Any assignment operator, to anything that is not a local binding.
          if (ts.isBinaryExpression(m) && ASSIGN(m.operatorToken.kind) &&
              !(ts.isIdentifier(m.left) && local.has(m.left.text))) found = true
          if (ts.isCallExpression(m)) {
            // A method call on module state can stash a value: pool.push(client)
            let root: any = ts.isPropertyAccessExpression(m.expression) ? m.expression.expression : null
            while (root && ts.isPropertyAccessExpression(root)) root = root.expression
            if (root && ts.isIdentifier(root) && moduleScope.has(root.text) && !local.has(root.text)) found = true
          }
        })
        return found
      }
      /**
       * `export const POST = (() => { ... })()` is evaluated at MODULE LOAD, so
       * a spend inside it runs on GET despite sitting lexically in a POST
       * declarator. Only an IIFE in the initializer itself qualifies — a nested
       * IIFE inside a handler BODY runs when the handler runs, which is why the
       * first version of this check wrongly flagged the real thesis-proposals
       * route for an ordinary local `(() => { try { ... } catch { ... } })()`.
       */
      const runsAtLoad = (d: any): boolean => {
        if (!d.initializer || !ts.isCallExpression(d.initializer)) return false
        const e = d.initializer.expression
        const callee = ts.isParenthesizedExpression(e) ? e.expression : e
        return ts.isFunctionExpression(callee) || ts.isArrowFunction(callee)
      }
      const spans: Array<[number, number]> = []
      const take = (n: any) => { if (!escapes(n)) spans.push([n.pos, n.end]) }
      each(sf, n => {
        if (ts.isFunctionDeclaration(n) && n.name && NON_GET.test(n.name.text) && isExported(n)) take(n)
        // WARDEN round 6: this used to hand `take` the whole VariableStatement
        // while testing the DECLARATOR, so one declarator named POST exempted
        // every SIBLING in the same const list. A module-scope client joined by
        // a COMMA instead of a semicolon was exempt and spent on every GET —
        // the design regressed to the defect it replaced, gated on punctuation.
        if (ts.isVariableStatement(n) && isExported(n))
          for (const d of n.declarationList.declarations)
            if (ts.isIdentifier(d.name) && NON_GET.test(d.name.text) && !runsAtLoad(d)) take(d)
      })
      return spans
    }

    const RENDER_ROOT = /(?:^|[\\/])(page|layout|template|loading|error|global-error|not-found|default|sitemap|robots|manifest|opengraph-image|twitter-image|icon|apple-icon)\.(?:[mc]?[jt]sx?)$/
    const ROUTE_FILE  = /(?:^|[\\/])route\.(?:[mc]?[jt]sx?)$/
    const SRC_FILE    = /\.(?:[mc]?[jt]sx?)$/

    const roots: string[] = []
    const collect = (d: string) => {
      for (const e of readdirSync(d)) {
        const p = join(d, e)
        if (statSync(p).isDirectory()) { collect(p); continue }
        if (RENDER_ROOT.test(p)) { roots.push(p); continue }
        // A route that exports GET renders on GET. Detected via the AST, so
        // `export { GET }`, `export { h as GET }`, `export { GET } from`,
        // `export const { GET } = ...` and `export * from` all count.
        if (ROUTE_FILE.test(p) && exportsGET(parse(p))) roots.push(p)
      }
    }
    collect(join(SRC, 'app'))
    // middleware and instrumentation run on requests and are accepted by Next
    // both under src/ and at the project root.
    for (const base of [SRC, ROOT_DIR])
      for (const conv of ['middleware', 'instrumentation'])
        for (const ext of ['ts', 'tsx', 'js', 'mjs'])
          { const p = join(base, `${conv}.${ext}`); if (existsSync(p)) roots.push(p) }
    expect(roots.length, 'found no render roots — this test would pass vacuously').toBeGreaterThan(20)

    const resolveSpec = (from: string, spec: string): string | null => {
      const base = spec.startsWith('@/') ? join(SRC, spec.slice(2))
                 : spec.startsWith('.')  ? resolve(dirname(from), spec)
                 : null
      if (!base) return null
      // next.config.mjs declares extensionAlias for '.js' ONLY, so the TS-first
      // swap must apply to '.js' only. Applying it to .mjs/.jsx would make the
      // walk read a different file than the build compiles — the same
      // divergence, inverted.
      const aliased = /\.js$/.test(base) ? [base.replace(/\.js$/, '.ts'), base.replace(/\.js$/, '.tsx')] : []
      const exts = ['ts', 'tsx', 'js', 'jsx', 'mjs', 'mts', 'cjs', 'cts']
      for (const c of [
        ...aliased, base,
        ...exts.map(x => `${base}.${x}`),
        ...exts.map(x => join(base, `index.${x}`)),
      ]) {
        if (existsSync(c) && statSync(c).isFile()) return c
      }
      return null
    }

    const seen = new Set<string>()
    const offenders: string[] = []
    const parseFailures: string[] = []
    const visit = (file: string, chain: string[], rootIsRoute: boolean) => {
      if (seen.has(file)) return
      seen.add(file)
      // `import './globals.css'` and JSON data imports resolve to real files
      // that are not JavaScript. Parsing them as TS produced diagnostics and
      // meaningless edges; they cannot spend.
      if (!SRC_FILE.test(file)) return
      const sf = parse(file)
      // A malformed file yields a PARTIAL tree that walks clean — traversal
      // edges silently vanish and the walk reports green. Make it loud.
      if ((sf as any).parseDiagnostics?.length) parseFailures.push(file.replace(SRC + '/', ''))
      const hits = spendNodes(sf)
      if (hits.length) {
        // A route legitimately imports the SDK for POST, so for a ROUTE ROOT a
        // hit is exempt only if provably POST-side: the bare module import,
        // which does not spend by itself, or a node lexically inside an exported
        // non-GET handler. Module scope and non-exported helpers both execute on
        // GET, so both COUNT.
        const onlySelf = chain.length === 0 && rootIsRoute
        const spans = onlySelf ? nonGetSpans(sf) : null
        const live = spans
          ? hits.filter(h => {
              // A BOUND import (`import Anthropic from …`) does not spend by
              // itself and is plausibly there for POST. A SIDE-EFFECT-ONLY
              // import (`import '@anthropic-ai/sdk/shims/node'`) exists solely
              // to execute code, and it executes on GET too.
              // NB: this callback returns TRUE to KEEP a hit as an offender.
              // A BOUND import (`import Anthropic from …`) does not spend by
              // itself and is plausibly there for POST -> exempt. A
              // SIDE-EFFECT-ONLY import (`import '@anthropic-ai/sdk/shims/node'`)
              // exists solely to execute code, and it executes on GET too.
              if (ts.isImportDeclaration(h)) return !h.importClause
              if (ts.isExportDeclaration(h) || ts.isImportEqualsDeclaration(h)) return false
              return !spans.some(([a, b]) => h.pos >= a && h.end <= b)
            })
          : hits
        if (live.length) {
          offenders.push([...chain, file].map(f => f.replace(SRC + '/', '')).join(' -> '))
          // Keep walking: an offender's subtree must not go unexamined.
        }
      }
      for (const spec of specifiers(sf)) {
        const next = resolveSpec(file, spec)
        if (next) visit(next, [...chain, file], rootIsRoute)
      }
    }
    for (const r of roots) visit(r, [], ROUTE_FILE.test(r))

    // ── COVERAGE — default-deny backstop ────────────────────────────────────
    // A walk that never opened a file proves nothing about it. The previous
    // version asked only whether an unreached file CONTAINED a spend literal,
    // which was blind to the dominant shape: a helper with no literal of its
    // own that imports the shared client. This asks whether it can REACH one.
    const allFiles: string[] = []
    const collectAll = (d: string) => {
      for (const e of readdirSync(d)) {
        const p = join(d, e)
        if (statSync(p).isDirectory()) { collectAll(p); continue }
        if (SRC_FILE.test(p)) allFiles.push(p)
      }
    }
    collectAll(SRC)
    // The depth cap memoised a `false` produced BY the cap, so a file first seen
    // at depth 12 stayed negative on every shorter path. No cap now; cycles are
    // broken by the in-progress stack and only POSITIVES are cached, which is
    // always sound.
    const reachMemo = new Map<string, boolean>()
    const reaches = (file: string, stack = new Set<string>()): boolean => {
      if (reachMemo.get(file)) return true
      if (stack.has(file) || !SRC_FILE.test(file)) return false
      stack.add(file)
      const sf = parse(file)
      let r = spendNodes(sf).length > 0
      if (!r) for (const spec of specifiers(sf)) {
        const next = resolveSpec(file, spec)
        if (next && reaches(next, stack)) { r = true; break }
      }
      stack.delete(file)
      if (r) reachMemo.set(file, true)
      return r
    }
    // Reached only by POST handlers, which may legitimately spend.
    const POST_ONLY = (f: string) => f.startsWith(`app${sep}api${sep}`)
    const unreachedSpenders = allFiles
      .filter(f => !seen.has(f))
      .map(f => f.slice(SRC.length + 1))
      .filter(f => !POST_ONLY(f) && !f.endsWith('.d.ts') && !f.startsWith(`generated${sep}`))
      .filter(f => reaches(join(SRC, f)))
      .sort()
    expect(unreachedSpenders,
      'a file the walk never opened can REACH an LLM client — traversal broke, or a new off-graph spender appeared',
    ).toEqual(['lib/studio/agent.ts'])

    expect(parseFailures,
      `these reached files do not parse, so their import edges silently vanish:\n  ${parseFailures.join('\n  ')}`,
    ).toEqual([])

    // Traversal canary. WARDEN found the previous pair of guards included one
    // that was VACUOUS and always had been: `worldmap/store/useMapStore.ts` is
    // reached by twelve ordinary imports, so deleting the `export ... from` edge
    // changed `seen` by zero files. Measured again here: removing that edge
    // loses 0 files, removing the dynamic-import edge loses 2. So only the
    // dynamic-import witness is asserted. A barrel guard is deliberately NOT
    // added — there is no barrel-only-reachable file in this tree today, and a
    // sentinel that cannot wake is worse than none because it reads as coverage.
    expect(seen.has(join(SRC, `app${sep}(legacy)${sep}world${sep}map${sep}WorldMapClient.tsx`)),
      'WorldMapClient is reachable ONLY through dynamic(() => import(...)) — that traversal edge regressed',
    ).toBe(true)

    expect(offenders, `render roots reach an LLM client:\n  ${offenders.join('\n  ')}`).toEqual([])
  })
})
