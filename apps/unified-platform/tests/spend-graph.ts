// THE INVARIANT
//
//   Loading any route module, page/render module, middleware surface, or their
//   static transitive dependencies must not acquire or invoke external spending
//   authority. Explicit handler execution may acquire it inside the handler.
//
// WHY IT IS PHRASED AROUND *LOADING*. Six adversarial rounds were spent proving
// "a GET cannot reach the client", and every design failed because it reasoned
// about which HTTP method a route exports. That model was simply wrong:
//
//   route module evaluation  ≠  handler invocation
//
// Next constructs the route module from the ALREADY-EVALUATED userland module
// and only then resolves the method; the 405 for an unexported method is
// synthesized afterwards. So every method a route does *not* export is still a
// live edge into that module's entire static graph — and `next build` evaluates
// it twice besides. Four POST-only routes were therefore constructing Anthropic
// and OpenAI clients on any GET, while the checker reported green, because they
// sat inside an `app/api/**` exclusion justified as "reached only by POST".
//
// That exclusion was the third incarnation of the same carve-out: first a named
// file list, then a lexical POST-span analysis, then a directory. Each one was a
// way of saying "this spend is fine because of WHERE it sits". All three broke.
//
// So the question is no longer "can GET reach it". It is "does merely loading
// this module acquire authority". No method inspection, no escape analysis.

import ts from 'typescript'
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join, dirname, resolve, sep } from 'node:path'

const SDK = /^(?:@anthropic-ai\/(?:sdk|bedrock-sdk|vertex-sdk)|openai|@ai-sdk\/(?:anthropic|openai))(?:\/|$)/
const HOST = /api\.(?:anthropic|openai)\.com/

/** Next file conventions that produce a response without a user action. */
const RENDER_ROOT = /(?:^|[\\/])(page|layout|template|loading|error|global-error|not-found|default|sitemap|robots|manifest|opengraph-image|twitter-image|icon|apple-icon)\.(?:[mc]?[jt]sx?)$/
/** EVERY route file is a root. Which methods it exports is deliberately not consulted. */
const ROUTE_FILE = /(?:^|[\\/])route\.(?:[mc]?[jt]sx?)$/
const SRC_FILE = /\.(?:[mc]?[jt]sx?)$/

const parse = (file: string) =>
  ts.createSourceFile(file, readFileSync(file, 'utf-8'), ts.ScriptTarget.Latest, true,
    /\.[jt]sx$/.test(file) ? ts.ScriptKind.TSX : ts.ScriptKind.TS)

const each = (n: ts.Node, fn: (n: ts.Node) => void) => {
  const walk = (x: ts.Node) => { fn(x); ts.forEachChild(x, walk) }
  walk(n)
}

/**
 * Is this node evaluated when the module is LOADED, rather than when something
 * is later called? True iff no function-like ancestor encloses it.
 *
 * This is the one positional question in the file, and it is the invariant's own
 * distinction — module evaluation versus invocation — not a reconstruction of
 * escape analysis. It asks nothing about data flow, aliasing or reachability.
 */
function atModuleScope(n: ts.Node): boolean {
  for (let p = n.parent; p; p = p.parent) {
    if (ts.isFunctionDeclaration(p) || ts.isFunctionExpression(p) || ts.isArrowFunction(p) ||
        ts.isMethodDeclaration(p) || ts.isConstructorDeclaration(p) ||
        ts.isGetAccessorDeclaration(p) || ts.isSetAccessorDeclaration(p)) return false
  }
  return true
}

const callSpec = (n: any): string | null => {
  const isImp = n.expression?.kind === ts.SyntaxKind.ImportKeyword
  const isReq = ts.isIdentifier(n.expression) && n.expression.text === 'require'
  const a = n.arguments?.[0]
  const lit = a && (ts.isStringLiteral(a) || ts.isNoSubstitutionTemplateLiteral(a))
  return (isImp || isReq) && lit ? a.text : null
}

export interface Edge { spec: string; static: boolean; atLoad: boolean }

/** Every specifier whose module is evaluated at runtime, tagged by edge kind. */
export function edges(sf: ts.SourceFile): Edge[] {
  const out: Edge[] = []
  each(sf, (n: any) => {
    if (ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier)) {
      if (!n.importClause?.isTypeOnly) out.push({ spec: n.moduleSpecifier.text, static: true, atLoad: true })
    } else if (ts.isExportDeclaration(n) && n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier)) {
      if (!n.isTypeOnly) out.push({ spec: n.moduleSpecifier.text, static: true, atLoad: true })
    } else if (ts.isImportEqualsDeclaration(n) && ts.isExternalModuleReference(n.moduleReference) &&
               ts.isStringLiteral(n.moduleReference.expression)) {
      out.push({ spec: n.moduleReference.expression.text, static: true, atLoad: true })
    } else if (ts.isCallExpression(n)) {
      const c = callSpec(n)
      if (c) out.push({ spec: c, static: false, atLoad: atModuleScope(n) })
    }
  })
  return out
}

/** Spend-capable nodes, with whether each is evaluated at module load. */
export function spendNodes(sf: ts.SourceFile): Array<{ atLoad: boolean }> {
  const hits: Array<{ atLoad: boolean }> = []
  const hit = (n: ts.Node) => hits.push({ atLoad: atModuleScope(n) })
  each(sf, (n: any) => {
    if ((ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) &&
        n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier)) {
      const typeOnly = ts.isImportDeclaration(n) ? n.importClause?.isTypeOnly : n.isTypeOnly
      if (!typeOnly && SDK.test(n.moduleSpecifier.text)) hit(n)
    } else if (ts.isImportEqualsDeclaration(n) && ts.isExternalModuleReference(n.moduleReference) &&
               ts.isStringLiteral(n.moduleReference.expression) && SDK.test(n.moduleReference.expression.text)) {
      hit(n)
    } else if (ts.isCallExpression(n)) {
      const c = callSpec(n)
      if (c && SDK.test(c)) hit(n)
      if (ts.isIdentifier(n.expression) && /^create(?:Anthropic|OpenAI)$/.test(n.expression.text)) hit(n)
    } else if (ts.isNewExpression(n) &&
               ((ts.isIdentifier(n.expression) && /^(?:Anthropic|OpenAI)$/.test(n.expression.text)) ||
                (ts.isPropertyAccessExpression(n.expression) && /^(?:Anthropic|OpenAI)$/.test(n.expression.name.text)))) {
      hit(n)
    } else if ((ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) && HOST.test(n.text)) {
      hit(n)
    } else if (ts.isTemplateExpression(n) && HOST.test(n.getText())) {
      hit(n)
    }
  })
  return hits
}

/**
 * Workspace packages listed in `transpilePackages` are compiled INTO the app, so
 * they are part of the executable graph and the authority graph must follow
 * them. Resolution is derived from each package's own `exports`/`main` — the
 * question is "can the real build resolve this?", never a hardcoded allowlist of
 * packages presumed safe.
 */
function workspacePackages(repo: string): Map<string, string> {
  const map = new Map<string, string>()
  const wsFile = join(repo, 'pnpm-workspace.yaml')
  const groups = existsSync(wsFile)
    ? [...readFileSync(wsFile, 'utf-8').matchAll(/^\s*-\s*['"]?([^'"\n*]+)\/\*/gm)].map(m => m[1].trim())
    : ['apps', 'packages']
  for (const g of groups) {
    const dir = join(repo, g)
    if (!existsSync(dir)) continue
    for (const name of readdirSync(dir)) {
      const pj = join(dir, name, 'package.json')
      if (!existsSync(pj)) continue
      try {
        const j = JSON.parse(readFileSync(pj, 'utf-8'))
        if (j.name) map.set(j.name, join(dir, name))
      } catch { /* unparseable package.json is not a module edge */ }
    }
  }
  return map
}

function resolveWorkspace(pkgDir: string, subpath: string): string | null {
  let pj: any
  try { pj = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf-8')) } catch { return null }
  const key = subpath ? `./${subpath}` : '.'
  const pick = (v: any): string | null =>
    typeof v === 'string' ? v
    : v && typeof v === 'object' ? (pick(v.import) ?? pick(v.default) ?? pick(v.require) ?? pick(v.types))
    : null
  let target = pj.exports ? pick(pj.exports[key]) : null
  if (!target && !subpath) target = pj.main ?? null
  if (!target && subpath) target = `./${subpath}`
  if (!target) return null
  const base = resolve(pkgDir, target)
  for (const c of [base, ...['ts', 'tsx', 'js', 'jsx', 'mjs', 'mts', 'cjs', 'cts'].map(x => `${base}.${x}`)])
    if (existsSync(c) && statSync(c).isFile()) return c
  return null
}

export interface Analysis {
  roots: string[]
  seen: Set<string>
  offenders: string[]
  unreachedSpenders: string[]
  parseFailures: string[]
}

export function analyze(SRC: string, projectRoot?: string, repoRoot?: string): Analysis {
  const REPO = repoRoot ?? resolve(SRC, '..', '..', '..')
  const WS = workspacePackages(REPO)

  const resolveSpec = (from: string, spec: string): string | null => {
    if (spec.startsWith('@/') || spec.startsWith('.')) {
      const base = spec.startsWith('@/') ? join(SRC, spec.slice(2)) : resolve(dirname(from), spec)
      // next.config.mjs declares extensionAlias for '.js' only, so webpack
      // prefers the TS source for that specifier and the walk must agree.
      const aliased = /\.js$/.test(base) ? [base.replace(/\.js$/, '.ts'), base.replace(/\.js$/, '.tsx')] : []
      const exts = ['ts', 'tsx', 'js', 'jsx', 'mjs', 'mts', 'cjs', 'cts']
      for (const c of [...aliased, base, ...exts.map(x => `${base}.${x}`), ...exts.map(x => join(base, `index.${x}`))])
        if (existsSync(c) && statSync(c).isFile()) return c
      return null
    }
    // Bare specifier: a workspace package is part of the build graph, anything
    // else (react, next, the SDKs themselves) is a leaf.
    const m = spec.match(/^(@[^/]+\/[^/]+|[^@][^/]*)(?:\/(.*))?$/)
    if (!m) return null
    const dir = WS.get(m[1])
    return dir ? resolveWorkspace(dir, m[2] ?? '') : null
  }

  const roots: string[] = []
  const pageRoots = new Set<string>()
  const appDir = join(SRC, 'app')
  const collect = (d: string) => {
    for (const e of readdirSync(d)) {
      const p = join(d, e)
      if (statSync(p).isDirectory()) { collect(p); continue }
      if (RENDER_ROOT.test(p)) { roots.push(p); pageRoots.add(p); continue }
      if (ROUTE_FILE.test(p)) roots.push(p)   // unconditional — no method inspection
    }
  }
  if (existsSync(appDir)) collect(appDir)
  for (const base of [SRC, projectRoot].filter(Boolean) as string[])
    for (const conv of ['middleware', 'instrumentation'])
      for (const ext of ['ts', 'tsx', 'js', 'mjs'])
        { const p = join(base, `${conv}.${ext}`); if (existsSync(p)) { roots.push(p); pageRoots.add(p) } }

  const seen = new Set<string>()
  const offenders: string[] = []
  const parseFailures: string[] = []
  const rel = (f: string) => f.startsWith(SRC + sep) ? f.slice(SRC.length + 1) : f.slice(REPO.length + 1)

  /**
   * `mode` is the evaluation class of the ROOT this walk started from.
   *
   *  'render' — a page/layout/middleware. The whole module, render function
   *             included, runs on a request nobody chose to send, so EVERY spend
   *             counts and every edge is followed.
   *  'load'   — a route module. Only its module scope runs on a bare load, so in
   *             the ROOT FILE only load-time spends count and only load-time
   *             edges are followed. That is what permits the sanctioned pattern:
   *             `await import('@anthropic-ai/sdk')` inside a handler.
   *
   * Past the root, 'load' becomes 'render': we cannot know whether the root calls
   * an imported helper during module evaluation, so any spend in a statically
   * reached module counts. The practical consequence is deliberate — spending
   * authority may only be acquired inline in a handler, never parked in a shared
   * module. A shared pre-constructed client is ambient authority for every
   * importer, which is exactly how four routes ended up spending on GET.
   */
  const visit = (file: string, chain: string[], mode: 'render' | 'load') => {
    const key = `${mode}:${file}`
    if (seen.has(key)) return
    seen.add(key)
    seen.add(file)
    if (!SRC_FILE.test(file)) return          // .css / .json import targets
    const sf = parse(file)
    if ((sf as any).parseDiagnostics?.length) parseFailures.push(rel(file))

    const hits = spendNodes(sf)
    const live = mode === 'load' ? hits.filter(h => h.atLoad) : hits
    if (live.length) offenders.push([...chain, file].map(rel).join(' -> '))

    for (const e of edges(sf)) {
      if (mode === 'load' && !e.static && !e.atLoad) continue   // deferred to invocation
      const next = resolveSpec(file, e.spec)
      if (next) visit(next, [...chain, file], 'render')
    }
  }
  for (const r of roots) visit(r, [], pageRoots.has(r) ? 'render' : 'load')

  // Default-deny backstop: a file the walk never opened must not even be ABLE to
  // reach spending authority. Workspace package sources are included, because
  // transpilePackages puts them in the executable graph.
  const reachMemo = new Map<string, boolean>()
  const reaches = (file: string, stack = new Set<string>()): boolean => {
    if (reachMemo.get(file)) return true
    if (stack.has(file) || !SRC_FILE.test(file)) return false
    stack.add(file)
    const sf = parse(file)
    let r = spendNodes(sf).length > 0
    if (!r) for (const e of edges(sf)) {
      const next = resolveSpec(file, e.spec)
      if (next && reaches(next, stack)) { r = true; break }
    }
    stack.delete(file)
    if (r) reachMemo.set(file, true)
    return r
  }
  const allFiles: string[] = []
  const collectAll = (d: string) => {
    for (const e of readdirSync(d)) {
      const p = join(d, e)
      if (p.includes(`${sep}node_modules${sep}`) || p.endsWith(`${sep}node_modules`)) continue
      if (statSync(p).isDirectory()) { collectAll(p); continue }
      if (SRC_FILE.test(p)) allFiles.push(p)
    }
  }
  collectAll(SRC)
  for (const dir of new Set(WS.values())) {
    const s = join(dir, 'src')
    if (existsSync(s) && dir.startsWith(join(REPO, 'packages'))) collectAll(s)
  }
  const unreachedSpenders = allFiles
    .filter(f => !seen.has(f))
    .map(rel)
    .filter(f => !f.endsWith('.d.ts') && !f.startsWith(`generated${sep}`))
    .filter(f => reaches(f.startsWith('packages' + sep) ? join(REPO, f) : join(SRC, f)))
    .sort()

  return { roots, seen, offenders, unreachedSpenders, parseFailures }
}
