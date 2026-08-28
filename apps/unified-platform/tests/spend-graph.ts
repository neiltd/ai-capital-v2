// Does any surface that renders WITHOUT an explicit user action reach an LLM
// client? That is the whole question. The answer is computed from the module
// graph, using the TypeScript parser rather than by matching source text.
//
// HOW THIS GOT SIMPLE. Six adversarial rounds killed three earlier designs, all
// of which failed the same way: each carried an EXEMPTION for route files whose
// spend "was only reachable from POST", and each exemption was broken by a shape
// nobody enumerated — a non-canonical `export { GET }` that produced an empty
// span and so exempted the whole file; a module-scope singleton the lexical
// check could not see; a client comma-joined onto `export const POST` that was
// exempt purely because of the punctuation.
//
// The carve-out was the wrong abstraction. It existed for exactly ONE file, and
// that file was changed instead: api/thesis-proposals no longer exports GET and
// acquires the SDK inside its POST body. With nothing left to exempt, the rule
// collapses to one sentence with no positional analysis at all:
//
//     A file reached from a non-user-action root may not contain a spend.
//
// There is no lexical escape analysis here, and adding any back would be a
// regression to the design that failed six times. If a route needs to spend, it
// must not export GET/HEAD/OPTIONS — that is the invariant, enforced by
// construction rather than by proving an exemption safe.

import ts from 'typescript'
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join, dirname, resolve, sep } from 'node:path'

/** Packages that constitute spending authority. */
const SDK = /^(?:@anthropic-ai\/(?:sdk|bedrock-sdk|vertex-sdk)|openai|@ai-sdk\/(?:anthropic|openai))(?:\/|$)/
const HOST = /api\.(?:anthropic|openai)\.com/

/**
 * Methods served WITHOUT an explicit user action, so a spend behind them bills
 * on traffic nobody chose to send: GET, HEAD (crawler/prefetch) and OPTIONS
 * (browser CORS preflight). A route exporting any of them is a render root.
 */
const ROOT_METHOD = /^(?:GET|HEAD|OPTIONS)$/

/** Next file conventions that produce a response on a plain GET. */
const RENDER_ROOT = /(?:^|[\\/])(page|layout|template|loading|error|global-error|not-found|default|sitemap|robots|manifest|opengraph-image|twitter-image|icon|apple-icon)\.(?:[mc]?[jt]sx?)$/
const ROUTE_FILE = /(?:^|[\\/])route\.(?:[mc]?[jt]sx?)$/
const SRC_FILE = /\.(?:[mc]?[jt]sx?)$/

const parse = (file: string) =>
  ts.createSourceFile(file, readFileSync(file, 'utf-8'), ts.ScriptTarget.Latest, true,
    /\.[jt]sx$/.test(file) ? ts.ScriptKind.TSX : ts.ScriptKind.TS)

const each = (sf: ts.Node, fn: (n: ts.Node) => void) => {
  const walk = (n: ts.Node) => { fn(n); ts.forEachChild(n, walk) }
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

/** Every specifier whose module is EVALUATED at runtime. Type-only is erased. */
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

/** Does this file hold spending authority in any form? */
export function spends(sf: ts.SourceFile): boolean {
  let found = false
  each(sf, (n: any) => {
    if (found) return
    if ((ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) &&
        n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier)) {
      const typeOnly = ts.isImportDeclaration(n) ? n.importClause?.isTypeOnly : n.isTypeOnly
      if (!typeOnly && SDK.test(n.moduleSpecifier.text)) found = true
    } else if (ts.isImportEqualsDeclaration(n) && ts.isExternalModuleReference(n.moduleReference) &&
               ts.isStringLiteral(n.moduleReference.expression) && SDK.test(n.moduleReference.expression.text)) {
      found = true
    } else if (ts.isCallExpression(n)) {
      const c = callSpec(n)
      if (c && SDK.test(c)) found = true
      if (ts.isIdentifier(n.expression) && /^create(?:Anthropic|OpenAI)$/.test(n.expression.text)) found = true
    } else if (ts.isNewExpression(n) &&
               ((ts.isIdentifier(n.expression) && /^(?:Anthropic|OpenAI)$/.test(n.expression.text)) ||
                (ts.isPropertyAccessExpression(n.expression) && /^(?:Anthropic|OpenAI)$/.test(n.expression.name.text)))) {
      found = true
    } else if ((ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) && HOST.test(n.text)) {
      found = true
    } else if (ts.isTemplateExpression(n) && HOST.test(n.getText())) {
      found = true
    }
  })
  return found
}

/** Does this module export GET, HEAD or OPTIONS — in ANY export form? */
function exportsRootMethod(sf: ts.SourceFile): boolean {
  let found = false
  each(sf, (n: any) => {
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
      } else if (!n.exportClause) found = true   // `export * from` — cannot know, so assume it does
    }
  })
  return found
}

export interface Analysis {
  roots: string[]
  seen: Set<string>
  offenders: string[]
  unreachedSpenders: string[]
  parseFailures: string[]
}

export function analyze(SRC: string, projectRoot?: string): Analysis {
  const resolveSpec = (from: string, spec: string): string | null => {
    const base = spec.startsWith('@/') ? join(SRC, spec.slice(2))
               : spec.startsWith('.')  ? resolve(dirname(from), spec)
               : null
    if (!base) return null
    // next.config.mjs declares extensionAlias for '.js' only, so webpack prefers
    // the TS source for that specifier and the walk must read the same file.
    const aliased = /\.js$/.test(base) ? [base.replace(/\.js$/, '.ts'), base.replace(/\.js$/, '.tsx')] : []
    const exts = ['ts', 'tsx', 'js', 'jsx', 'mjs', 'mts', 'cjs', 'cts']
    for (const c of [...aliased, base, ...exts.map(x => `${base}.${x}`), ...exts.map(x => join(base, `index.${x}`))])
      if (existsSync(c) && statSync(c).isFile()) return c
    return null
  }

  const roots: string[] = []
  const appDir = join(SRC, 'app')
  const collect = (d: string) => {
    for (const e of readdirSync(d)) {
      const p = join(d, e)
      if (statSync(p).isDirectory()) { collect(p); continue }
      if (RENDER_ROOT.test(p)) { roots.push(p); continue }
      if (ROUTE_FILE.test(p) && exportsRootMethod(parse(p))) roots.push(p)
    }
  }
  if (existsSync(appDir)) collect(appDir)
  for (const base of [SRC, projectRoot].filter(Boolean) as string[])
    for (const conv of ['middleware', 'instrumentation'])
      for (const ext of ['ts', 'tsx', 'js', 'mjs'])
        { const p = join(base, `${conv}.${ext}`); if (existsSync(p)) roots.push(p) }

  const seen = new Set<string>()
  const offenders: string[] = []
  const parseFailures: string[] = []
  const visit = (file: string, chain: string[]) => {
    if (seen.has(file)) return
    seen.add(file)
    // `import './globals.css'` and JSON data imports resolve to real files that
    // are not JavaScript; parsing them as TS yields diagnostics and no edges.
    if (!SRC_FILE.test(file)) return
    const sf = parse(file)
    // A malformed file yields a PARTIAL tree that walks clean, so its edges
    // vanish silently. Make that loud rather than green.
    if ((sf as any).parseDiagnostics?.length) parseFailures.push(file.replace(SRC + sep, ''))
    if (spends(sf)) {
      offenders.push([...chain, file].map(f => f.replace(SRC + sep, '')).join(' -> '))
      // Keep walking — an offender's subtree must not go unexamined.
    }
    for (const spec of specifiers(sf)) {
      const next = resolveSpec(file, spec)
      if (next) visit(next, [...chain, file])
    }
  }
  for (const r of roots) visit(r, [])

  // Default-deny backstop: a walk that never opened a file proves nothing about
  // it, so an unreached file must not even be ABLE to reach spending authority.
  // Only positives are memoised, which is sound regardless of traversal order.
  const reachMemo = new Map<string, boolean>()
  const reaches = (file: string, stack = new Set<string>()): boolean => {
    if (reachMemo.get(file)) return true
    if (stack.has(file) || !SRC_FILE.test(file)) return false
    stack.add(file)
    const sf = parse(file)
    let r = spends(sf)
    if (!r) for (const spec of specifiers(sf)) {
      const next = resolveSpec(file, spec)
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
      if (statSync(p).isDirectory()) { collectAll(p); continue }
      if (SRC_FILE.test(p)) allFiles.push(p)
    }
  }
  collectAll(SRC)
  const unreachedSpenders = allFiles
    .filter(f => !seen.has(f))
    .map(f => f.slice(SRC.length + 1))
    // Reached only by POST/PUT/PATCH/DELETE handlers, which may spend.
    .filter(f => !f.startsWith(`app${sep}api${sep}`) && !f.endsWith('.d.ts') && !f.startsWith(`generated${sep}`))
    .filter(f => reaches(join(SRC, f)))
    .sort()

  return { roots, seen, offenders, unreachedSpenders, parseFailures }
}
