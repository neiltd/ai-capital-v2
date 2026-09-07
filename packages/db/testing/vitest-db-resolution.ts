// Vite/vitest resolution for packages that reuse the shared db test harness.
//
// THE PROBLEM. `packages/db/src/pool.ts` and `testing/global-setup.ts` import
// `pg-connection-string`, a properly declared dependency of @common/db that
// resolves correctly under Node from anywhere inside this package. Vite does
// not use Node's algorithm for bare specifiers: it resolves them against the
// configured `root`. When another workspace package sets its own root and pulls
// these files in, the specifier is looked up in THAT package, which has no such
// dependency, and both files fail to load with
// "Failed to load url pg-connection-string".
//
// THE FIRST FIX, AND WHY IT WAS REPLACED. packages/investment-ledger aliased the
// specifier to '../db/node_modules/pg-connection-string/index.js'. That worked
// only under pnpm's isolated node_modules layout — under a hoisted npm, yarn or
// `node-linker=hoisted` pnpm install the package sits at the workspace root and
// that path does not exist. It also named a FILE, bypassing the package's
// `exports` map, and it had to be copy-pasted into every future consumer.
//
// THIS FIX. The path is computed with Node's own resolver, anchored to
// @common/db, so it is correct under every layout; it goes through the package's
// export map rather than around it; and it lives HERE, next to the harness that
// needs it, so a consumer writes `resolve: { alias: sharedDbTestAliases() }` and
// nothing else. No production module is changed, so no application bundler sees
// a new construct.

import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

/**
 * Resolve `specifier` the way Node would from the package that owns
 * `anchorPackageJson`, and return a real filesystem path.
 *
 * `fileURLToPath` rather than `new URL(url).pathname`: a URL pathname is
 * percent-ENCODED, so a checkout under `/Users/me/my repo/` would yield
 * `/Users/me/my%20repo/...` — a path that does not exist. That was a live bug
 * waiting for the first directory with a space or a non-ASCII character in it.
 */
export function resolveDependencyFrom(anchorPackageJson: URL, specifier: string): string {
  return createRequire(anchorPackageJson).resolve(specifier)
}

/** The ESM condition of the export map, when the running loader offers it. */
function resolveViaImportMeta(specifier: string): string | null {
  try {
    const url = (import.meta as unknown as { resolve?: (s: string) => string }).resolve?.(specifier)
    return url?.startsWith('file:') ? fileURLToPath(url) : null
  } catch {
    return null
  }
}

/**
 * Vite `resolve.alias` entries a package needs in order to load
 * `testing/global-setup.ts`, `testing/vitest-db-isolation.ts` and
 * `src/pool.ts` from a root other than packages/db.
 *
 * `import.meta.resolve` is synchronous on Node >= 20.6 but is not offered by
 * every config-loading pipeline, so this falls back to the CommonJS condition —
 * still the package's export map, never a guessed filename.
 */
export function sharedDbTestAliases(): Record<string, string> {
  const specifier = 'pg-connection-string'
  const resolved = resolveViaImportMeta(specifier)
    ?? resolveDependencyFrom(new URL('../package.json', import.meta.url), specifier)
  return { [specifier]: resolved }
}
