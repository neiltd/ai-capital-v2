import dns from 'node:dns/promises'
import { basename, dirname, join, resolve as pathResolve, sep } from 'node:path'
import { realpathSync, existsSync } from 'node:fs'

/**
 * ── Canonical destination resolution ───────────────────────────────────────
 *
 * Judge where a connection ACTUALLY GOES, never how the string is spelled.
 *
 * WHY. The first isolation guard was a string blocklist against three literals
 * and one regex. Warden defeated it fifteen ways in a single pass — every one
 * of these reached the real production Redis holding the 228 parked incident
 * jobs:
 *
 *   redis://localhost:6379?x=1     the (\/|$) anchor is defeated by a query string
 *   redis://@localhost:6379        empty userinfo
 *   redis://127.1:6379             short-form loopback
 *   redis://2130706433:6379        integer-form loopback
 *   redis://localhost.:6379        FQDN root dot
 *   redis://<machine>.local:6379   hostname alias
 *   rediss:// redis+tls://         scheme not checked
 *
 * This is the same lesson `packages/db/src/pool.ts` already learned about
 * Postgres: canonicalise first, then judge. A blocklist enumerates spellings an
 * attacker — or an ordinary developer with a slightly different habit — can
 * always extend. `dns.lookup` collapses all of the above to 127.0.0.1 / ::1,
 * because that is what the OS resolver will do when the client actually
 * connects.
 *
 * UNRESOLVABLE MEANS REFUSED. Cannot prove safe must never mean allowed.
 */

/** The port production BullMQ listens on. */
export const PRODUCTION_REDIS_PORT = 6379

/** Addresses that mean "this machine", where the production instance lives. */
const LOCAL_ADDRESSES = new Set(['127.0.0.1', '::1', '0.0.0.0', '::'])

/**
 * THE PROTECTED PRODUCTION ROOTS — FIXED LITERALS, BY DESIGN.
 *
 * Two roots are protected for the duration of the S4F relocation:
 *
 *   [0] /Users/thanapold/ai-capital-runtime      the canonical runtime root the
 *                                                relocation moves production to
 *   [1] /Users/thanapold/Desktop/Projects.nosync the legacy root, which stays
 *                                                authoritative and protected
 *                                                until a separately approved
 *                                                retirement change removes it
 *
 * WHY THESE ARE LITERALS AND NOT DERIVED FROM ANYTHING.
 *
 * The obvious-looking alternative — deriving the root from this module's own
 * location — is WRONG, and dangerously so. This file is imported by the test
 * suite, by disposable git worktrees under /private/tmp, and by any developer
 * clone. Under module-location derivation every one of those would declare
 * ITSELF production: isInsideProductionRepo() would answer `true` for a temp
 * worktree's paths and `false` for the real runtime root, inverting the guard it
 * exists to provide. "The checkout that loaded this module" is not a definition
 * of production; it is a description of whoever ran the code.
 *
 * For the same reason the roots are never read from cwd, PWD, HOME,
 * AI_CAPITAL_ROOT, any other environment variable, or Git metadata. There is no
 * input to point at a different directory, so no export, no test harness and no
 * stray `cd` can move the boundary. AI_CAPITAL_ROOT keeps the only meaning it
 * ever had — see isolation.ts, where being OUTSIDE these roots is one of three
 * dimensions that must ALL hold before an environment counts as isolated.
 *
 * Adding or removing a root is therefore a reviewed source change, which is the
 * point: the relocation adds one here, and only a later approved retirement
 * removes the legacy one.
 */
export const PRODUCTION_ROOTS: readonly string[] = Object.freeze([
  '/Users/thanapold/ai-capital-runtime',
  '/Users/thanapold/Desktop/Projects.nosync',
])

/**
 * The canonical production root — the one an unset default resolves to.
 *
 * Retained under its original name so every existing import keeps working, and
 * deliberately pointed at the NEW runtime root: when PIPELINE_RUNS_DB or
 * AI_CAPITAL_ROOT is unset, isolation.ts resolves against this, never against
 * cwd or HOME. The legacy root stays protected through PRODUCTION_ROOTS, but it
 * is no longer the default destination.
 */
export const PRODUCTION_REPO = PRODUCTION_ROOTS[0]

export class DestinationError extends Error {
  constructor(message: string) { super(message); this.name = 'DestinationError' }
}

export interface RedisEndpoint {
  /** Every address the host resolves to. */
  addresses: string[]
  port: number
  /** True when this endpoint reaches the production queue. */
  isProduction: boolean
  /** Unix socket path, when the URL names one instead of a host. */
  socketPath?: string
}

/**
 * Resolve a Redis URL to the endpoint it will really reach.
 *
 * Throws rather than guessing: an unparseable or unresolvable destination is
 * refused, because a test that cannot prove where it is pointing must not run.
 */
export async function resolveRedisEndpoint(url: string): Promise<RedisEndpoint> {
  const raw = (url ?? '').trim()
  if (!raw) throw new DestinationError('empty Redis URL — cannot determine the destination')

  // Unix sockets bypass host/port entirely and are local by definition.
  if (raw.startsWith('unix:') || raw.startsWith('/')) {
    const socketPath = raw.replace(/^unix:(\/\/)?/, '')
    return { addresses: [], port: 0, isProduction: true, socketPath }
  }

  let parsed: URL
  try {
    // Normalise the scheme so redis:, rediss:, redis+tls: all parse alike;
    // WHATWG URL treats unknown schemes as opaque and will not expose hostname.
    parsed = new URL(raw.replace(/^redis\+tls:/i, 'rediss:'))
  } catch {
    throw new DestinationError(`unparseable Redis URL (${url}) — refusing rather than guessing`)
  }

  if (!/^rediss?:$/i.test(parsed.protocol)) {
    throw new DestinationError(`unsupported Redis scheme "${parsed.protocol}" in ${url}`)
  }

  const host = parsed.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '')  // strip brackets and FQDN root dot
  if (!host) throw new DestinationError(`Redis URL has no host (${url})`)

  const port = parsed.port ? Number(parsed.port) : PRODUCTION_REDIS_PORT   // redis defaults to 6379

  let addresses: string[]
  try {
    const found = await dns.lookup(host, { all: true, verbatim: true })
    addresses = found.map(a => a.address)
  } catch {
    throw new DestinationError(
      `cannot resolve Redis host "${host}" (${url}). An unresolvable destination is refused: ` +
      'cannot prove safe must never mean allowed.')
  }
  if (addresses.length === 0) throw new DestinationError(`Redis host "${host}" resolved to nothing (${url})`)

  const isProduction = port === PRODUCTION_REDIS_PORT && addresses.some(a => LOCAL_ADDRESSES.has(a))
  return { addresses, port, isProduction }
}

/**
 * Canonicalise a filesystem path.
 *
 * `path.resolve` handles the relative case — a bare `data/pipeline-runs.db` IS
 * the production database when cwd is the repo, which the previous prefix check
 * accepted. `realpath` additionally collapses symlinks and `..`, so a path like
 * `<repo>/apps/../data/pipeline-runs.db` cannot slip through.
 */
export function canonicalPath(p: string): string {
  const abs = pathResolve(p)

  try {
    return realpathSync(abs)
  } catch (e) {
    // ENOENT is the ONLY recoverable case: the path names something that does
    // not exist yet, which is ordinary — a run database about to be created, a
    // destination about to be published. Everything else (EACCES, EPERM, ELOOP,
    // ENOTDIR, EIO) means we could not determine what this path really is, and
    // an undetermined path must FAIL CLOSED rather than be classified.
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
  }

  // ── THE DEEPEST EXISTING ANCESTOR, THEN THE MISSING SUFFIX ────────────────
  //
  // The previous implementation returned `abs` unresolved whenever realpath
  // failed, which was a FAIL-OPEN BYPASS of the production boundary. Measured:
  // a symlink in /tmp pointing at the protected legacy root, plus a child that
  // does not exist yet, kept the /tmp alias — so isInsideProductionRepo()
  // answered `false` for a path that resolves squarely inside production.
  //
  // Walking up one component at a time and re-attaching the preserved suffix
  // resolves every symlink that actually exists on the way down, so the alias
  // collapses and only the genuinely-missing tail stays symbolic.
  let current = abs
  let suffix = ''
  for (;;) {
    const parent = dirname(current)
    // dirname('/') === '/': the filesystem root always exists, so realpath above
    // would have succeeded. Reaching here without progress means something is
    // deeply wrong, and guessing is exactly what this function must not do.
    if (parent === current) {
      throw new DestinationError(`cannot canonicalize ${abs}: reached the filesystem root without resolving it`)
    }
    // join() only concatenates components — unlike resolve() it never consults
    // cwd, so the preserved suffix stays a pure relative tail.
    suffix = suffix === '' ? basename(current) : join(basename(current), suffix)
    current = parent
    try {
      // realpathSync is the single source of truth for existence — no separate
      // existsSync check, which would be a second answer that can disagree.
      return pathResolve(realpathSync(current), suffix)
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
    }
  }
}

/**
 * True when a path is one of the protected production roots, or lives inside one.
 *
 * Both roots are checked, so during the relocation neither the new runtime tree
 * nor the legacy tree can be mistaken for an isolated destination. The
 * comparison stays canonical (path.resolve + realpath, so symlinks and `..`
 * collapse) and separator-bound, so a sibling like `…/ai-capital-runtime-old`
 * is NOT swallowed by a bare prefix match.
 */
export function isInsideProductionRepo(p: string): boolean {
  const canon = canonicalPath(p)
  return PRODUCTION_ROOTS.some(root => {
    const repo = canonicalPath(root)
    return canon === repo || canon.startsWith(repo + sep)
  })
}

/** True when this SQLite path is (or would be) a production run database —
 *  in EITHER protected root. */
export function isProductionRunDb(p: string): boolean {
  return isInsideProductionRepo(p)
}

export function pathExists(p: string): boolean {
  return existsSync(canonicalPath(p))
}
