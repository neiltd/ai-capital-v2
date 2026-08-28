// THE PROPERTY
//
//   Project-owned code that the dashboard build or a non-user request evaluates
//   must not acquire or reference LLM SDK authority, EXCEPT structurally inside
//   the body of an exported HTTP handler.
//
// WHY IT IS PHRASED AS PLACEMENT. Four designs died here, each a variant of
// "this spend is fine because of WHERE it sits": a named file list, a lexical
// POST-span analysis, a directory exclusion, and finally an `atModuleScope`
// predicate. The last one failed because it asked "is this node inside a
// function" and the analyzer used the answer as "does this run at module load".
// Those diverge the moment a function is invoked during module evaluation —
// `await boot()`, an async IIFE, a factory call — and answering that question
// properly means building a call graph.
//
// So this does not ask what executes. It asks WHERE authority is allowed to
// appear, and forbids it everywhere else. A helper, IIFE or factory in a route
// file fails not because we proved it runs at load, but because authority is not
// permitted there at all. That is an authority-placement policy; there is no
// data-flow, aliasing or reachability analysis anywhere in this file.
//
// WHAT IT DELIBERATELY DOES NOT COVER
//   - Subprocess/delegated authority (execFile/spawn of something that spends).
//     Tracked separately as W5; spending authority is a strictly larger set than
//     SDK reference, and conflating them turns this into "detect every side
//     effect".
//   - Third-party package internals. Traversal stops at the project boundary.
//   - Test/tooling execution (vitest configs and their imports). That belongs to
//     the test-egress/isolation boundary, not to the dashboard property.

import ts from 'typescript'
import { readFileSync, readdirSync, statSync, existsSync, realpathSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { builtinModules } from 'node:module'

const SDK = /^(?:@anthropic-ai\/(?:sdk|bedrock-sdk|vertex-sdk)|openai|@ai-sdk\/(?:anthropic|openai))(?:\/|$)/
const HOST = /api\.(?:anthropic|openai)\.com/

/** Next conventions that render without a user action. */
const RENDER_ROOT = /(?:^|[\\/])(page|layout|template|loading|error|global-error|not-found|default|sitemap|robots|manifest|opengraph-image|twitter-image|icon|apple-icon)\.(?:[mc]?[jt]sx?)$/
/** EVERY route file is a root; which methods it exports is never consulted. */
const ROUTE_FILE = /(?:^|[\\/])route\.(?:[mc]?[jt]sx?)$/
const SRC_FILE = /\.(?:[mc]?[jt]sx?)$/
/**
 * The ONLY exported bindings whose body may hold authority — methods a person
 * has to deliberately invoke.
 *
 * GET/HEAD/OPTIONS are excluded on purpose. Which methods a route exports is
 * never consulted when deciding whether the module is a root (every route file
 * is), but it decides which handler BODY is a permitted location: a GET is the
 * original incident shape, HEAD is crawler/prefetch traffic and OPTIONS is CORS
 * preflight, so authority inside those bodies bills on requests nobody chose to
 * send.
 */
const USER_METHOD = /^(?:POST|PUT|PATCH|DELETE)$/
/** Every method Next dispatches — used to discover what a body is served as. */
const ANY_METHOD = /^(?:GET|HEAD|OPTIONS|POST|PUT|PATCH|DELETE)$/

const parse = (file: string) =>
  ts.createSourceFile(file, readFileSync(file, 'utf-8'), ts.ScriptTarget.Latest, true,
    /\.[jt]sx$/.test(file) ? ts.ScriptKind.TSX : ts.ScriptKind.TS)

const each = (n: ts.Node, fn: (n: ts.Node) => void) => {
  const walk = (x: ts.Node) => { fn(x); ts.forEachChild(x, walk) }
  walk(n)
}

const isExported = (n: any) => n.modifiers?.some((m: any) => m.kind === ts.SyntaxKind.ExportKeyword)

const callSpec = (n: any): string | null => {
  const isImp = n.expression?.kind === ts.SyntaxKind.ImportKeyword
  const isReq = ts.isIdentifier(n.expression) && n.expression.text === 'require'
  const a = n.arguments?.[0]
  const lit = a && (ts.isStringLiteral(a) || ts.isNoSubstitutionTemplateLiteral(a))
  return (isImp || isReq) && lit ? a.text : null
}

/** Every specifier whose module is evaluated at runtime. Type-only is erased. */
export function specifiers(sf: ts.SourceFile): string[] {
  const out: string[] = []
  each(sf, (n: any) => {
    if (ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier)) {
      if (!n.importClause?.isTypeOnly) out.push(n.moduleSpecifier.text)
    } else if (ts.isExportDeclaration(n) && n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier)) {
      if (!n.isTypeOnly) out.push(n.moduleSpecifier.text)
    } else if (ts.isImportEqualsDeclaration(n) && ts.isExternalModuleReference(n.moduleReference) &&
               ts.isStringLiteral(n.moduleReference.expression)) {
      out.push(n.moduleReference.expression.text)
    } else if (ts.isCallExpression(n)) {
      const c = callSpec(n); if (c) out.push(c)
    }
  })
  return out
}

/** Nodes that reference SDK authority, with their source positions. */
export function spendNodes(sf: ts.SourceFile): ts.Node[] {
  const hits: ts.Node[] = []
  each(sf, (n: any) => {
    if ((ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) &&
        n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier)) {
      const typeOnly = ts.isImportDeclaration(n) ? n.importClause?.isTypeOnly : n.isTypeOnly
      if (!typeOnly && SDK.test(n.moduleSpecifier.text)) hits.push(n)
    } else if (ts.isImportEqualsDeclaration(n) && ts.isExternalModuleReference(n.moduleReference) &&
               ts.isStringLiteral(n.moduleReference.expression) && SDK.test(n.moduleReference.expression.text)) {
      hits.push(n)
    } else if (ts.isCallExpression(n)) {
      const c = callSpec(n)
      if (c && SDK.test(c)) hits.push(n)
      if (ts.isIdentifier(n.expression) && /^create(?:Anthropic|OpenAI)$/.test(n.expression.text)) hits.push(n)
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
 * Spans of the BODIES of exported HTTP handlers — the only place a route file
 * may reference SDK authority.
 *
 * Body, not declaration: a spend in a default parameter value or a decorator
 * sits outside the body and is therefore an offence, with no special case.
 * A handler whose body cannot be located contributes no span, so anything in
 * that file is an offence — uncertainty fails closed.
 */
function handlerBodies(sf: ts.SourceFile): Array<[number, number]> {
  // Local name -> the function node it denotes. Needed to resolve aliases.
  const byName = new Map<string, ts.Node>()
  each(sf, (n: any) => {
    if (ts.isFunctionDeclaration(n) && n.name) byName.set(n.name.text, n)
    if (ts.isVariableStatement(n))
      for (const d of n.declarationList.declarations)
        if (ts.isIdentifier(d.name) && d.initializer &&
            (ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer)))
          byName.set(d.name.text, d.initializer)
  })

  // Function node -> EVERY HTTP-method name it is exported under.
  const exportedAs = new Map<ts.Node, Set<string>>()
  const mark = (node: ts.Node | undefined, name: string) => {
    if (!node) return
    const set = exportedAs.get(node) ?? new Set<string>()
    set.add(name); exportedAs.set(node, set)
  }
  each(sf, (n: any) => {
    // export async function POST() {}
    if (ts.isFunctionDeclaration(n) && n.name && ANY_METHOD.test(n.name.text) && isExported(n)) mark(n, n.name.text)
    if (ts.isVariableStatement(n) && isExported(n))
      for (const d of n.declarationList.declarations) {
        if (!ts.isIdentifier(d.name) || !ANY_METHOD.test(d.name.text)) continue
        // export const POST = async () => {}
        if (d.initializer && (ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer)))
          mark(d.initializer, d.name.text)
        // export const GET = POST  — an alias to a local binding. Untracked
        // before, so a GET binding was discarded before anything looked at what
        // it pointed to.
        else if (d.initializer && ts.isIdentifier(d.initializer))
          mark(byName.get(d.initializer.text), d.name.text)
      }
    // export { h as POST } / export { POST as GET } / export { POST }
    if (ts.isExportDeclaration(n) && !n.moduleSpecifier && n.exportClause && ts.isNamedExports(n.exportClause))
      for (const e of n.exportClause.elements)
        if (ANY_METHOD.test(e.name.text)) mark(byName.get((e.propertyName ?? e.name).text), e.name.text)
  })

  // A body may hold authority only if EVERY method name it is served under is a
  // user action. One function exported as both POST and GET is a GET handler;
  // Next serves GET from it and a crawler bills the call. Keying on the name
  // that happened to match let two tokens of aliasing restore the original
  // incident shape.
  const spans: Array<[number, number]> = []
  for (const [node, names] of exportedAs) {
    const body = (node as any).body
    if (!body) continue                                   // unlocatable -> no span
    if ([...names].every(m => USER_METHOD.test(m))) spans.push([body.pos, body.end])
  }
  return spans
}

const inside = (n: ts.Node, spans: Array<[number, number]>) =>
  spans.some(([a, b]) => n.pos >= a && n.end <= b)

/** Extensions that cannot hold authority, so failing to resolve them is inert. */
const INERT = /\.(?:css|scss|sass|less|json|svg|png|jpe?g|gif|webp|avif|woff2?|ttf|otf|eot|mp4|webm|txt|md)$/
/** Ask Node for its own builtin list rather than hand-enumerating it — the
 *  hand-written version was missing `node:async_hooks`, which surfaced as nine
 *  phantom "project-owned" edges. */
const BUILTIN = new Set(builtinModules)
const isBuiltin = (spec: string) => {
  const bare = spec.replace(/^node:/, '')
  return BUILTIN.has(bare) || BUILTIN.has(bare.split('/')[0])
}

export interface Analysis {
  roots: string[]
  seen: Set<string>
  offenders: string[]
  unreachedSpenders: string[]
  parseFailures: string[]
  /** Specifiers that look project-owned but did not resolve. Must stay empty. */
  unresolvedProjectEdges: string[]
}

/**
 * Module resolution is DELEGATED to the TypeScript compiler using the project's
 * own tsconfig, rather than approximated. A hand-rolled resolver had already
 * grown wrong in four ways (missing index fallback, `main`-less packages,
 * conditional exports, wildcard subpaths) and some of those only looked safe
 * because the backstop caught what traversal missed.
 */
function compilerOptions(projectRoot?: string): ts.CompilerOptions {
  if (projectRoot) {
    const cfg = ts.findConfigFile(projectRoot, ts.sys.fileExists, 'tsconfig.json')
    if (cfg) {
      const read = ts.readConfigFile(cfg, ts.sys.readFile)
      return ts.parseJsonConfigFileContent(read.config, ts.sys, projectRoot).options
    }
  }
  return { moduleResolution: ts.ModuleResolutionKind.Bundler, allowJs: true }
}

export function analyze(SRC_IN: string, projectRoot?: string, repoRoot?: string): Analysis {
  // Canonicalise before any prefix comparison. On macOS /tmp and /var are
  // symlinks, so a path from mkdtemp does not string-prefix its own realpath and
  // every ownership check silently answers "not ours".
  const canon = (p: string) => { try { return realpathSync(p) } catch { return p } }
  const SRC = canon(SRC_IN)
  const REPO = canon(repoRoot ?? resolve(SRC, '..', '..', '..'))
  projectRoot = projectRoot ? canon(projectRoot) : projectRoot
  const OPTS = compilerOptions(projectRoot)
  // A fixture tree has no tsconfig; give it the same `@/*` convention the app uses.
  if (!OPTS.paths) { OPTS.baseUrl = projectRoot ?? SRC; OPTS.paths = { '@/*': [`${SRC}/*`] } }

  // Defined before resolveSpec, which closes over it.
  const rel = (f: string) => f.startsWith(SRC + sep) ? f.slice(SRC.length + 1)
                           : f.startsWith(REPO + sep) ? f.slice(REPO.length + 1) : f
  const unresolvedProjectEdges: string[] = []
  // A workspace package name is project-owned even when the specifier fails to
  // resolve (a blocked `exports` subpath, a typo, a package with no entry).
  const wsNames = new Set<string>()
  for (const g of ['packages', 'apps']) {
    const d = join(REPO, g)
    if (!existsSync(d)) continue
    for (const nm of readdirSync(d)) {
      const pj = join(d, nm, 'package.json')
      if (!existsSync(pj)) continue
      try { const j = JSON.parse(readFileSync(pj, 'utf-8')); if (j.name) wsNames.add(j.name) } catch { /* not an edge */ }
    }
  }
  const declaredDeps = new Set<string>()
  if (projectRoot && existsSync(join(projectRoot, 'package.json'))) {
    try {
      const j = JSON.parse(readFileSync(join(projectRoot, 'package.json'), 'utf-8'))
      for (const k of Object.keys({ ...j.dependencies, ...j.devDependencies, ...j.peerDependencies })) declaredDeps.add(k)
    } catch { /* leave empty; unknown packages then read as project candidates */ }
  }
  const owned = (f: string): boolean => {
    let rp: string
    try { rp = realpathSync(f) } catch { return false }
    return rp.startsWith(REPO + sep) && !rp.includes(`${sep}node_modules${sep}`)
  }
  const resolveSpec = (from: string, spec: string): string | null => {
    const r = ts.resolveModuleName(spec, from, OPTS, ts.sys)
    const f = r.resolvedModule?.resolvedFileName
    if (!f) {
      // S1: a bare specifier that failed to resolve used to be dropped with no
      // record. Pointed at apps/*, traversal lost the edge AND the backstop
      // excluded the target — silent green. A resolution failure on anything
      // that could be project-owned is now a guard failure, not an ignored edge.
      if (INERT.test(spec)) return null
      if (spec.startsWith('.') || spec.startsWith('@/')) { unresolvedProjectEdges.push(`${rel(from)} -> ${spec}`); return null }
      const pkg = spec.match(/^(@[^/]+\/[^/]+|[^@][^/]*)/)?.[1] ?? spec
      if (wsNames.has(pkg)) { unresolvedProjectEdges.push(`${rel(from)} -> ${spec}`); return null }
      // A declared third-party dependency or node builtin is a legitimate leaf.
      if (isBuiltin(spec) || declaredDeps.has(pkg)) return null
      unresolvedProjectEdges.push(`${rel(from)} -> ${spec}`)
      return null
    }
    // Traversal stops at the project boundary. A workspace package is symlinked
    // into node_modules, so realpath decides ownership, not the literal path.
    return owned(f) ? realpathSync(f) : null
  }

  const roots: string[] = []
  const routeRoots = new Set<string>()
  const appDir = join(SRC, 'app')
  const collect = (d: string) => {
    for (const e of readdirSync(d)) {
      const p = join(d, e)
      if (statSync(p).isDirectory()) { collect(p); continue }
      if (RENDER_ROOT.test(p)) { roots.push(p); continue }
      if (ROUTE_FILE.test(p)) { roots.push(p); routeRoots.add(p) }
    }
  }
  if (existsSync(appDir)) collect(appDir)
  for (const base of [SRC, projectRoot].filter(Boolean) as string[])
    for (const conv of ['middleware', 'instrumentation'])
      for (const ext of ['ts', 'tsx', 'js', 'mjs'])
        { const p = join(base, `${conv}.${ext}`); if (existsSync(p)) roots.push(p) }
  // Build-time surfaces: evaluated by `next build` before any request exists.
  // Test/tooling configs are deliberately NOT here — that is the test-egress
  // boundary, and mislabelling it as a dashboard property would hide both.
  if (projectRoot)
    for (const c of ['next.config', 'tailwind.config', 'postcss.config'])
      for (const ext of ['ts', 'mts', 'cts', 'js', 'mjs', 'cjs'])
        { const p = join(projectRoot, `${c}.${ext}`); if (existsSync(p)) roots.push(p) }

  const seen = new Set<string>()
  const offenders: string[] = []
  const parseFailures: string[] = []

  const visit = (file: string, chain: string[], isRouteRoot: boolean) => {
    if (seen.has(file)) return
    seen.add(file)
    if (!SRC_FILE.test(file)) return                 // .css / .json import targets
    const sf = parse(file)
    if ((sf as any).parseDiagnostics?.length) parseFailures.push(rel(file))

    const hits = spendNodes(sf)
    // THE POSITIVE RULE. In a route root, authority is permitted only inside an
    // exported handler body. Everywhere else — including every module a route
    // reaches — it is not permitted at all, which is what stops authority being
    // parked in a shared module.
    const bad = isRouteRoot ? hits.filter(h => !inside(h, handlerBodies(sf))) : hits
    if (bad.length) offenders.push([...chain, file].map(rel).join(' -> '))

    for (const spec of specifiers(sf)) {
      const next = resolveSpec(file, spec)
      if (next) visit(next, [...chain, file], false)
    }
  }
  for (const r of roots) visit(r, [], routeRoots.has(r))

  // Default-deny backstop over project-owned executable source.
  //
  // SCOPE, deliberately: this app's `src`, plus every workspace PACKAGE source
  // tree (those are compiled into the app via transpilePackages). Other `apps/*`
  // are excluded on purpose — they are separate programs, several of which
  // legitimately hold spending authority (the pipeline calls LLMs by design), so
  // including them would force an allowlist and mislabel pipeline behaviour as a
  // dashboard finding. Generated and vendored material is excluded because it is
  // not project-authored.
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
  const SKIP = new Set(['node_modules', 'dist', '.next', 'generated', '.turbo', 'coverage'])
  const allFiles: string[] = []
  const collectAll = (d: string) => {
    for (const e of readdirSync(d)) {
      if (SKIP.has(e)) continue
      const p = join(d, e)
      if (statSync(p).isDirectory()) { collectAll(p); continue }
      if (SRC_FILE.test(p) && !p.endsWith('.d.ts')) allFiles.push(p)
    }
  }
  collectAll(SRC)
  // S2: the project ROOT directory was in neither traversal nor backstop, so any
  // framework convention living outside src/ (mdx-components, instrumentation-
  // client, sentry.*.config, whatever Next adds next) was invisible to both.
  // Backstopped by default rather than by enumerating filenames: the named root
  // list buys precision about what definitely executes, this stops an unknown
  // convention becoming silent. Vitest config is excluded — test egress is a
  // separate boundary and mislabelling it here would hide both.
  if (projectRoot) for (const e of readdirSync(projectRoot)) {
    const p = join(projectRoot, e)
    if (SKIP.has(e) || /^vitest\.config\./.test(e)) continue
    if (SRC_FILE.test(p) && !p.endsWith('.d.ts') && statSync(p).isFile()) allFiles.push(p)
  }
  const pkgDir = join(REPO, 'packages')
  if (existsSync(pkgDir)) for (const n of readdirSync(pkgDir)) {
    const p = join(pkgDir, n)
    if (statSync(p).isDirectory()) collectAll(p)     // src, bin, testing, migrations — all of it
  }
  const unreachedSpenders = allFiles
    .filter(f => !seen.has(f))
    .filter(f => reaches(f))
    .map(rel)
    .sort()

  return { roots, seen, offenders, unreachedSpenders, parseFailures,
           unresolvedProjectEdges: [...new Set(unresolvedProjectEdges)].sort() }
}
